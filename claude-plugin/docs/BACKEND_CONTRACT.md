# Backend contract

This is everything the real platform must implement so the plugin works without changes. `claude-plugin/mock-backend/` implements all of it and is the reference. TypeScript shapes are in [`contract/types.ts`](../contract/types.ts), exact expected outputs in [`TEST_VECTORS.md`](TEST_VECTORS.md), and the build plan in [`BACKEND_GUIDE.md`](BACKEND_GUIDE.md). Paths like `mock-backend/…` or `plugin/bridge/…` below are inside `claude-plugin/`.

Conventions:
- JSON bodies, UTF-8. Times are ISO 8601 strings unless a field is named `*_in` (seconds) or `exp` (epoch seconds).
- **Every** response carries a `DPoP-Nonce` header. Clients always use the latest nonce they've seen.
- Algorithms: ES256 (P-256) only.

## 1. Discovery

`GET /.well-known/hy-platform` (public)

```json
{
  "issuer": "https://platform.company.com",
  "authorization_endpoint": "https://platform.company.com/authorize",
  "token_endpoint": "https://platform.company.com/token",
  "gateway_url": "https://platform.company.com/mcp",
  "policy_endpoint": "https://platform.company.com/v1/policy",
  "events_endpoint": "https://platform.company.com/v1/events",
  "challenges_endpoint": "https://platform.company.com/v1/challenges",
  "llm_gateway_url": "https://platform.company.com/llm",
  "response_signing_jwk": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…", "alg": "ES256", "use": "sig", "kid": "…" },
  "llm_auto_mode_server": true,
  "dpop_signing_alg_values_supported": ["ES256"]
}
```

`llm_auto_mode_server`: whether the LLM gateway passes requests to Anthropic's API unchanged, so Claude Code's auto mode can run its safety checks server-side (`safeguards` request field → `safeguard_results` in the response). `false` makes the launchers set `CLAUDE_CODE_AUTO_MODE_SERVER=0`, and Claude Code then sends its own separate classifier requests. The checks are the same either way. This is a backend configuration choice.

The plugin is configured with the base URL only. Endpoints may live on different hosts; `gateway_url` can point to the PoP proxy in front of ToolHive.

## 2. Sign-in and device registration

OAuth 2.0 authorization code flow with PKCE ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)), a loopback redirect ([RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)), and DPoP binding through `dpop_jkt` ([RFC 9449 §10](https://www.rfc-editor.org/rfc/rfc9449#section-10)).

### `GET /authorize` (browser)

| Param | Value |
|---|---|
| `response_type` | `code` |
| `client_id` | `hy-cc-plugin` |
| `redirect_uri` | `http://127.0.0.1:<random port>/callback`. **Only accept loopback.** Any port is fine (RFC 8252 §7.3) |
| `state` | opaque, echoed back |
| `code_challenge`, `code_challenge_method` | PKCE, `S256` only |
| `dpop_jkt` | RFC 7638 thumbprint of the device's routine key |
| `device_name` | hostname, display only |
| `key_storage` | `secure_enclave` \| `software` \| (later) `tpm` |
| `platform` | `darwin` \| `linux` \| `win32` |

The page must:
1. Authenticate the user with the company IdP (SSO). Production can delegate to Okta, Entra or Google and continue afterwards.
2. Show the device name, key storage, and the **device code**: the first 60 bits of the decoded `dpop_jkt` as base32 (RFC 4648 alphabet `A–Z2–7`), 12 characters in groups of 4, e.g. `PTQF-7KVA-3M2Q` (reference: `shortCode()` in `plugin/bridge/util.mjs`). It's display-only; never accept it as authentication. The user compares it with the code in Claude Code.
3. On approve: redirect to `redirect_uri?code=<code>&state=<state>`. The code is single use and valid for 60 s, and it remembers `dpop_jkt`, the user, the PKCE challenge and the device fields.
4. On cancel: `redirect_uri?error=access_denied&state=<state>`.

Optional: apply policy here, e.g. refuse `key_storage=software` for some groups, or require an admin approval for new devices.

### `POST /token`

`Content-Type: application/x-www-form-urlencoded`, `DPoP: <proof>` (no `ath`, since there's no token yet).

**authorization_code grant**: `grant_type, code, code_verifier, redirect_uri, client_id`, plus optional `presence_jwk` (a JSON string with the public JWK of the Touch ID key).

Also `device_fingerprint`: JSON of the stable fingerprint (`machine_id_hash, hardware_model, cpu_model, cpu_count, memory_gb, os_family, arch`). Its canonical-JSON SHA-256 must equal the proof's `dfp`; store both. On refresh, a `dfp` different from the stored one → `invalid_grant` ("device fingerprint changed"), logged as theft. On sign-in, a key (`jkt`) that is already registered with a **different** fingerprint must be refused (`invalid_grant`, "registered to a different machine"), even with valid SSO. Otherwise someone with a copied key and the user's password could re-register it from their own machine and overwrite the fingerprint.

Checks:
- code valid, unused, unexpired; `client_id` and `redirect_uri` match;
- `SHA256(code_verifier)` base64url == `code_challenge`;
- DPoP proof valid (§3) and **its key thumbprint == the code's `dpop_jkt`**;
- `presence_jwk` is a public EC P-256 JWK (no `d`).

Then create or update the device (keyed by the thumbprint), store the presence key thumbprint, record the request IP as a known network, and issue tokens.

**refresh_token grant**: `grant_type, refresh_token, client_id`. The proof key thumbprint must equal the refresh token's bound `jkt`, and the device must not be revoked. The mock doesn't rotate refresh tokens. If you rotate them, the bridge handles it: it re-reads the shared token file before treating a failed refresh as a sign-out.

**Session unlock.** Each refresh token has an `unlocked_until`. A sign-in (authorization_code) sets it to now + unlock TTL (8 h default). A refresh inside the window is silent. After it, the refresh request must also carry a valid `HY-Presence-Proof` (Touch ID) over the same claims, which extends the window; without one, reply `400 {"error":"invalid_grant","error_description":"unlock_required"}` for devices with a presence key, or `"session expired, sign in again"` for devices without one. An admin "lock" sets `unlocked_until = 0` and deletes the device's access tokens.

Response:

```json
{
  "access_token": "…",
  "token_type": "DPoP",
  "expires_in": 300,
  "unlock_expires_in": 28800,
  "refresh_token": "…",
  "user": { "id": "u_123", "email": "dev@company.com", "name": "dev" },
  "device": { "id": "d_456", "short_code": "PTQF-7KVA-3M2Q", "key_storage": "secure_enclave" }
}
```

Errors use OAuth format with status 400: `{"error":"invalid_grant"|"invalid_dpop_proof"|"use_dpop_nonce"|"unsupported_grant_type","error_description":"…"}`. For `use_dpop_nonce`, also send the fresh `DPoP-Nonce` header; the client retries automatically.

**Token format.** The access token may be opaque (the mock uses opaque tokens) or a JWT. If ToolHive vMCP should validate it directly, use a JWT with `iss`, `aud` (the gateway), `sub` (user), `exp`, and `cnf: {"jkt": "<thumbprint>"}`, and publish JWKS. Suggested lifetimes: access 5–10 min, refresh 8–12 h, both bound to the key.

## 3. DPoP verification (every protected request)

Protected requests send:

```
Authorization: DPoP <access_token>
DPoP: <proof JWS>
HY-Presence-Proof: <JWS>     (approval level "touchid", and refresh after the unlock window)
```

Proof header: `{"typ":"dpop+jwt","alg":"ES256","jwk":{kty,crv,x,y}}`.
Proof claims: `jti, htm, htu, iat, nonce`, plus `ath` (base64url SHA-256 of the access token), `bh` (base64url SHA-256 of the raw request body, when there is one), `dfp` (device fingerprint hash), `ctxh` (client context hash), `idle` (seconds since last keyboard/mouse input; absent where unknown), `osp` (built-in OS posture, §7b; absent off macOS), `ztah` (§7b, only with a ZTA token) and, on tool calls Claude Code started, `hook`:

```json
"hook": { "sid": "<Claude Code session id>", "eid": "<hook record id>", "ah": "<action hash>", "ts": 1791040000 }
```

`ah` uses the same formula as the challenge action hash (§4): SHA-256 over canonical JSON `{"tool", "arguments"}`. The platform treats the call as **hook-correlated** when `ah` equals the hash of this `tools/call` and `ts` is within 120 s. Uncorrelated write/destructive calls are a risk signal ("not started by Claude Code").

Every request also carries `HY-Client-Context: <base64url JSON>` with `os_version, kernel, hostname, os_user, node, bridge, key_storage, client: {name, version}`.

When the device has an EDR posture token, it's sent as `HY-Posture-ZTA: <CrowdStrike ZTA JWT>` and bound by the proof claim `ztah` (base64url SHA-256 of the token). See §7b.

**Transport:** all platform endpoints must be HTTPS. The bridge refuses `http://` URLs, including ones in the discovery document, unless the host is loopback.

Checks, in order (reference: `mock-backend/dpop.mjs`):

1. JWS valid: `typ`, `alg=ES256`, public EC P-256 `jwk` without `d`, signature verifies.
2. `htm` == request method. `htu` == the **public** URL of the endpoint (scheme + host + path, no query). Behind a proxy, build it from your public base URL, not the internal host.
3. `|now - iat| ≤ 60 s`.
4. `nonce` is one of the current or previous server nonces (rotate every ~60 s). Missing or stale → 401 with `WWW-Authenticate: DPoP error="use_dpop_nonce"` and a fresh `DPoP-Nonce`.
5. `jti` not seen in the last 5 min; then store it (a Valkey/Redis `SET NX EX 300` is enough).
6. `ath` matches the access token.
7. `bh` matches the body (if there is a body).
8. Proof key thumbprint == token's bound `jkt`. Otherwise → 401 `invalid_token`.
9. Device not revoked. Otherwise → 401 `invalid_token`.
10. `HY-Client-Context`: base64url SHA-256 of the decoded JSON == `ctxh`, otherwise 401 `invalid_dpop_proof`. Store it as the device's latest context and log changes (`client_context_changed`).
11. `dfp` == the fingerprint hash stored at sign-in. Otherwise the key is being used from a different machine: 401 `invalid_token` ("same key used from a different machine"), logged as theft. The mock's `MOCK_FINGERPRINT=log` only records it.

**Theft signal.** Check 8 failing with a *valid, unexpired* token (or refresh token at `/token`) means someone holds the credential without the key, which is almost certainly token theft. Log it with the IP and the presented key's thumbprint, flag the owning device, and alert. The mock records these in `rejections` and flags `devices[].theft_suspected_at`. Whether to auto-revoke the victim's tokens is a policy choice; it also logs the real user out.

Failures: HTTP 401, `WWW-Authenticate: DPoP error="<invalid_token|invalid_dpop_proof|use_dpop_nonce>", error_description="…", algs="ES256"`. On `invalid_token` the bridge tries one refresh; if that fails, it signs the user out and brings back `hy_login`.

**Presence proof.** A JWS with `typ: "hy-presence+jwt"` over **exactly the same claims object** as the DPoP proof (verify at least `jti, htm, htu, iat, ath, bh, nonce` are equal), signed by the device's registered presence key (its thumbprint must equal the stored one). On macOS that key requires Touch ID for every signature, so a valid presence proof means a human confirmed this request.

## 3b. Signed responses

Every response to a request that carried a `DPoP` header (including errors, `/token`, policy, events, challenges, `/mcp`, and non-streamed `/llm`) must carry:

```
HY-Response-Signature: <compact JWS>
  header  { "alg": "ES256", "kid": "<thumbprint>", "typ": "hy-response+jwt" }
  payload { "jti": "<the request's DPoP proof jti>", "status": 200, "bh": "<b64url sha256(raw body)>", "iat": 1791040000 }
```

Publish the public key in discovery as `response_signing_jwk` (`{kty, crv, x, y, alg, use, kid}`). The bridge pins it on first contact and refuses a changed key, a missing signature, a signature for another request, or a changed status or body (±300 s on `iat`). Streamed responses (`text/event-stream`) are not signed. Keep the signing key in a KMS/HSM; rotating it requires clients to re-pin (or ship the new thumbprint via managed settings, `HY_PLATFORM_KEY_JKT`). Reference: `mock-backend/response-signing.mjs`.

## 4. MCP gateway: `POST {gateway_url}`

MCP Streamable HTTP. DPoP is required on every POST, including `initialize` and notifications.

- `initialize` → respond and set an `Mcp-Session-Id` header. Bind the session to the device; reject it from any other device with 404.
- Notifications (no `id`) → 202, empty body.
- `tools/list` → the tools the user is entitled to, **without** tools the policy hides. The bridge filters again for display, but **never rely on the client for enforcement**.
- `tools/call` → enforce org policy server-side, in this order: `hide`/`deny` refuse; **argument rules** refuse a violating argument (same globs/patterns as the client); **admin pins** (`policy.pinned[tool]` ≠ hash of the tool's current `{name, description, inputSchema}`) refuse a re-defined tool. Then compute signals and run the trust decision:
  - **allow**: forward to the MCP server (ToolHive vMCP) and return its result;
  - **deny**: JSON-RPC error `{"code": -32011, "message": "denied", "data": {"decision_id": "…", "reasons": ["…"]}}`;
  - **challenge**: JSON-RPC error
    ```json
    {"code": -32010, "message": "challenge_required",
     "data": {"decision_id": "…",
              "challenge": {"id": "…", "approve_url": "https://…/challenge/<id>",
                            "expires_in": 120, "reasons": ["…"]}}}
    ```
- Retry after approval: the same `tools/call` with header `HY-Challenge-Id: <id>`. Accept it only if the challenge is `approved`, unexpired, unused, belongs to the same device, and its **action hash** matches: SHA-256 over canonical JSON (sorted keys) of `{"tool": name, "arguments": args}`. Mark it used (single use).

Responses may be `application/json` or `text/event-stream`; the bridge reads both.

**ToolHive in production:** the PoP proxy terminates DPoP, runs the trust check, then forwards to vMCP. It either passes the access token along (if it's a JWT vMCP trusts) or exchanges it for a vMCP-audience token (RFC 8693). **The vMCP must only be reachable from the PoP proxy**, or a stolen token goes straight around the proof check.

## 4b. LLM gateway: `{llm_gateway_url}/*`

Model traffic from Claude Code: Claude Code → local proxy (`main.mjs llm-proxy` on `127.0.0.1`) → here. The local proxy appends Claude Code's path to `llm_gateway_url`, e.g. `POST {llm_gateway_url}/v1/messages?beta=true`, `POST …/v1/messages/count_tokens`, `GET …/v1/models`.

- **Auth:** exactly §3: `Authorization: DPoP <access token>` plus a `DPoP` proof with `ath` and `bh`, verified on every request. The `htu` is the gateway URL plus path, without the query.
- **Forward** to the provider (Anthropic API, or Bedrock/Vertex/Foundry through your own translation) with the **company credential**. Strip `Authorization`, `x-api-key`, `DPoP`, `HY-Presence-Proof` and hop-by-hop headers.
- **Must forward unchanged:** the `anthropic-version` and `anthropic-beta` request headers (verbatim, as open lists), the request body, and error bodies.
- **Must return:** streamed responses as `text/event-stream`, **unbuffered**, through `message_stop` (Claude Code aborts after 5 min without bytes, so keep pings). Pass back `retry-after`, `x-should-retry` and `anthropic-ratelimit-unified-*`.
- **Useful for the trust engine:** `x-claude-code-session-id`, `x-claude-code-agent-id`, `model`, body size, `stream`. The mock records an `llm_request` event with these. You can apply trust decisions here too (block a revoked or high-risk device, rate-limit, budget per user), returning Anthropic-format errors: `{"type":"error","error":{"type":"…","message":"…"}}`.
- Respond to `HEAD /api/hello` (connection warm-up). The local proxy already answers it, so the gateway rarely sees it.

Reference: the Claude Code [gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol), and `llmGateway()` in `mock-backend/server.mjs`.

## 5. Challenges

- `GET {challenges_endpoint}/{id}` (DPoP, same device) → `{"id","status":"pending|approved|denied|expired","expires_at","approved_by"}` (`approved_by`: the email that signed in to approve; the bridge shows it). The bridge polls every 1.5 s for up to 2 min.
- **Store on the challenge** what the approval page shows **before** the sign-in: tool and its human description, tier, arguments, device name, device code, key storage, Claude Code session id (from the `hook` claim), request IP and location, current posture score, created time, reasons.
- **Page behaviour:** the approve/deny forms may be sent by `fetch` with `Accept: application/json`; answer JSON (`{"status","approved_by"}`, or `403 {"error"}` for a wrong account) instead of a redirect, so the tab keeps one history entry and can close itself. Without JS, plain form posts and redirects still work.
- `GET /challenge/{id}` (browser page): shows the tool, arguments, reasons and device. Approving needs a **fresh sign-in as the device's owner**: production redirects to the IdP with `prompt=login` / `max_age=0` (ideally a passkey) and only approves when the signed-in user equals the challenge's user; the mock offers its account buttons and returns 403 for another account. Add CSRF protection.
- `POST /challenge/{id}/approve|deny`.

## 6. Policy and events

### `GET {policy_endpoint}` (DPoP)

Supports `ETag` / `If-None-Match` → 304. Polled every `refresh_seconds`; when `version` changes, the bridge refreshes the model's tool list.

```json
{
  "version": "2026-10-03.1",
  "refresh_seconds": 30,
  "default_action": "allow",
  "tools": [
    { "match": "prod_db_*", "action": "hide", "tier": "destructive" },
    { "match": "email_read_*", "action": "allow", "tier": "read", "untrusted_source": true },
    { "match": "crm_export_*", "action": "allow", "tier": "write", "approval": "confirm" },
    { "match": "repo_delete_*", "action": "allow", "tier": "destructive", "approval": "touchid" },
    { "match": "iam_*", "action": "allow", "tier": "destructive", "approval": "browser" }
  ],
  "approval_defaults": { "read": "none", "write": "none", "destructive": "touchid" },
  "untrusted_content": { "builtin_sources": ["WebFetch", "WebSearch"], "window_minutes": 10 },
  "argument_rules": [
    { "tool": "email_send", "argument": "to", "pattern": "@company\\.com$", "message": "…" }
  ],
  "pinning": "enforce",
  "pinned": { "crm_search_customers": "<definition hash>" },
  "telemetry": { "flush_seconds": 5 }
}
```

- `match` and `tool` are globs with `*`, matched against MCP tool names. The first matching rule wins.
- `action`: `allow | deny | hide` (`ask` = legacy alias for `approval: "confirm"`). `tier`: `read | write | destructive`.
- `approval`: `none | confirm | touchid | browser`. Default per tier from `approval_defaults` (`{"read":"none","write":"none","destructive":"touchid"}`). The server enforces `touchid`: deny without a valid `HY-Presence-Proof` when the device has a presence key; challenge in the browser when it has none. It also enforces `browser`: always challenge, and the approval page requires a fresh sign-in (`prompt=login`) as the device owner. `confirm` is asked by the bridge (MCP form elicitation) and can't be verified by the server. Without a tier, the bridge uses MCP annotations (`destructiveHint` → destructive, `readOnlyHint` → read, otherwise write).
- **Prompt-injection guard:** after the session reads untrusted content, write/destructive calls are challenged for `untrusted_content.window_minutes`.
  - **Built-in tools** in `builtin_sources` (Claude Code's own, e.g. WebFetch) are reported by the plugin's hook as `pre_tool_use` events with `untrusted_content: true` (plus the domain).
  - **Company tools** with `untrusted_source: true` (they return emails, tickets, pages…) are marked by the **gateway itself** when it runs them. That doesn't depend on the client.
  - Record *what* was read (`"example.com (WebFetch)"`, `"email_read_inbox"`) and name it in the reason; the approval page shows it.
- `pinning`: `enforce` (hide tools whose definition changed), `warn` (only report), `off`. `pinned` lets admins set the trusted hash per tool: base64url SHA-256 of canonical JSON `{"name","description","inputSchema"}`. Without org pins the bridge trusts the first definition it sees on that device (TOFU).
- Policy can be per user or group: the token identifies both.

### `POST {events_endpoint}` (DPoP)

Body `{"events": [Event, …]}`, at most 100 per batch, retried on failure. Respond 202. Events are at-least-once, so deduplicate by `event_id`.

```json
{
  "event_id": "uuid",
  "type": "tool_call",
  "ts": "2026-10-03T13:41:05.248Z",
  "source": "bridge",
  "context": { "instance_id": "uuid", "device_jkt": "…", "key_storage": "secure_enclave", "os": "darwin",
               "bridge_version": "0.1.0", "project": "/path", "client": { "name": "claude-code", "version": "2.1.288" } },
  "data": { "tool": "crm_search_customers", "tier": "read", "args": { "query": { "type": "string", "size": 6 } },
            "outcome": "ok", "ms": 7 }
}
```

Hook events have `"source": "hook"` and `context: { claude_session_id, cwd }`.

| type | source | data |
|---|---|---|
| `bridge_started` | bridge | `signed_in` |
| `signed_in` / `signed_out` | bridge | – |
| `tools_listed` | bridge | `upstream`, `visible`, `hidden[]` |
| `tool_call` | bridge | `tool, tier, approval, args (keys/types/sizes), outcome, hook_correlated, ms` |
| `tool_blocked_locally` | bridge | `tool, action, reason` |
| `tool_definition_changed` | bridge | `tool, hash` |
| `challenge_shown` | bridge | `tool, challenge_id, reasons` |
| `confirmation` | bridge | `tool, action` (accept/decline/cancel of the confirm dialog) |
| `response_tampered` | bridge | `tool` or `during`, `error` (a platform response failed signature verification) |
| `llm_request` | gateway (server-side) | `path, model, stream, bytes, session, tools, mcp_tools` |
| `posture_changed`, `client_context_changed`, `edr_alert`, `edr_alert_resolved`, `session_unlocked` | gateway (server-side) | before/after, reason, method |
| `session_start` | hook | `source` (startup/resume/…) |
| `pre_tool_use` | hook | `tool, untrusted_content, input: {keys, domain?}` |

**Signal the trust engine should derive:** `pre_tool_use` with `untrusted_content: true` (a `builtin_sources` tool) marks the device session as having read untrusted content, as does any call to an `untrusted_source` tool (marked server-side). A `write` or `destructive` call shortly after is the prompt-injection-to-exfiltration pattern. The bridge sends pending events **before** write/destructive calls, so the mark is always there in time.

## 7. Data the backend stores

| Table | Key fields | Notes |
|---|---|---|
| `users` | id, email, name, groups | from the IdP |
| `devices` | id, user_id, **jkt** (unique), jwk, **presence_jkt**, presence_jwk, **fingerprint {hash, details}**, context (latest), name, platform, key_storage, short_code, approved_at, revoked_at, fingerprint_mismatch_at, theft_suspected_at, zta_aid, posture (latest), edr_alert, untrusted_at, last_ip, last_seen | revoke = delete tokens + set `revoked_at` |
| `device_networks` | device_id, ip, asn, country, first_seen, last_seen | known networks, travel speed |
| `auth_codes` | code, client_id, redirect_uri, code_challenge, dpop_jkt, user_id, device fields, exp | 60 s, single use |
| `access_tokens` / `refresh_tokens` | token (store a hash), device_id, user_id, jkt, exp | or JWTs with `cnf.jkt` |
| `dpop_jti` | jti, exp | Valkey/Redis, 5 min TTL |
| `dpop_nonces` | current, previous | rotate every 60 s; shared across instances |
| `mcp_sessions` | session_id, device_id, created_at | |
| `challenges` | id, device_id, user_id, tool, description, tier, arguments, action_hash, reasons, device_code, claude_session_id, ip, geo, posture_score, status, approved_by, approved_at, expires_at, used_at, decision_id | |
| `decisions` | id, ts, device_id, user_id, tool, decision, reasons[], signals{} | the audit trail, show in the dashboard |
| `rejections` | ts, ip, path, reason, theft_suspected, victim_device_id, presented_jkt | refused credentials; theft alerts |
| `refresh_tokens.unlocked_until` | epoch seconds | session unlock window (Touch ID to extend) |
| `device_sessions` | device_id, claude_session_id, last_seen | Claude Code sessions seen (hooks, tool calls, model requests) |
| `events` | event_id (unique), device_id, type, ts, source, context, data | ClickHouse-sized |
| `policies` | version, scope (org/group/user), body, etag | |

## 7b. EDR posture (CrowdStrike ZTA)

On every protected request with `HY-Posture-ZTA`:
1. SHA-256 of the header value == proof claim `ztah`, otherwise 401 `invalid_dpop_proof`. A `ztah` claim without the header is the same error.
2. Parse the JWT. Verify the signature. CrowdStrike doesn't publicly document the key, so either get it via the partner program, or skip it and rely on step 5.
3. `cid` == your CrowdStrike tenant; not expired; `iat` fresh (mock: 24 h).
4. Pin `aid` on the device at first sight; a different `aid` later means the token is from another host.
5. Production: confirm the score server to server, `GET {falcon}/zero-trust-assessment/entities/assessments/v1?ids=<aid>` (OAuth2 client credentials at `POST /oauth2/token`, scope "Zero Trust Assessment: Read"). Response `resources[].assessment.overall`. Cache for about 60 s. Falcon unreachable means unknown, not healthy.
6. Feed `posture_status` (ok / stale / missing / invalid / unknown / compromised) and `posture_score` into the decision. Mock rules: < 50 denies write/destructive, < 20 or invalid denies everything (also the LLM gateway, 403 `permission_error`). Evaluate posture **before** challenge approvals.

Store `devices.zta_aid` and `devices.posture` (latest), and log `posture_changed` events.

**Host containment:** also read `GET /devices/entities/devices/v2?ids=<aid>` (scope "Hosts: Read"). `status` `contained` or `containment_pending` means the security team isolated the host: deny everything. **Combine scores conservatively:** use the lower of the device file and the cloud. A cloud lookup that fails, or a host unknown to CrowdStrike, means posture unknown: challenge write/destructive, never treat it as healthy.

**Pushed events:** `POST /v1/signals/caep` receives OpenID Shared Signals / CAEP events. Production expects signed SETs (RFC 8417) via push delivery (RFC 8935), verified with the transmitter's keys; the mock takes plain JSON with `Authorization: Bearer <CAEP_SECRET>`. Handle `https://schemas.openid.net/secevent/caep/event-type/device-compliance-change`, where `subject.id` is the CrowdStrike agent ID (or our device ID). `current_status: "not-compliant"` sets an alert on the device: deny everything, model included, from the next request. `"compliant"` clears it. Reply 202.

**Built-in OS posture:** proof claim `osp` = `{fv, sip, gk, fw}` (FileVault, System Integrity Protection, Gatekeeper, firewall; `true`/`false`/`null`). It's client-reported, so use it as a baseline only. Mock rules: `fv` or `sip` false denies write/destructive; `gk` false challenges them.

## 8. Trust decision input and output

The gateway builds the signals per `tools/call` (see `mock-backend/server.mjs` `gateway()` and `mock-backend/rules.mjs`); rules, ML and an AI analyst only have to return `{decision, reasons}`.

```json
{
  "tool": "repo_delete_branch", "tier": "destructive", "org_action": "allow", "approval": "touchid",
  "argument_violation": null, "definition_changed": false,
  "presence_verified": false, "presence_capable": true, "key_storage": "secure_enclave",
  "ip": "203.0.113.7", "ip_known": false, "geo": {"country": "SG", "city": "Singapore", "lat": 1.35, "lon": 103.82}, "travel_kmh": 9800,
  "untrusted_content_minutes_ago": 3, "untrusted_source": "email_read_inbox", "untrusted_window_minutes": 10, "approved_challenge": false,
  "hook_correlated": false, "claude_session_id": null, "session_known": false, "user_idle_minutes": 0,
  "posture_status": "ok", "posture_score": 35, "posture_reason": null,
  "os_posture": {"fv": true, "sip": true, "gk": true, "fw": false}
}
```

→ `{"decision": "allow" | "challenge" | "deny", "reasons": ["…"]}`

**Decision order** (mock `rules.mjs`; keep the structure, tune the thresholds):

1. **Deny, nothing overrides:** org `hide`/`deny`; argument rule violated; tool definition differs from the admin pin; posture `compromised` (EDR alert or host contained); posture `invalid`; posture score < 20; write/destructive with posture score < 50; write/destructive with FileVault or SIP off.
2. **Allow:** an approved, matching browser challenge (fresh sign-in).
3. **Approval levels:** `touchid` without a presence proof → deny if the device has a presence key (a missing proof is suspicious), else challenge (browser instead). `browser` → challenge.
4. **Risk signals → challenge** (write/destructive unless noted): untrusted content read within `untrusted_content.window_minutes` (reason names the source); first request from this network; not hook-correlated; user idle ≥ 30 min; posture stale or unknown; Gatekeeper off; impossible travel (> 900 km/h, any tier); `ZTA_REQUIRED` and no posture.
5. Otherwise **allow**.

AI and ML scores (e.g. `ai_session_risk`) join as more signals. Keep the rule that **AI can only raise risk, never allow on its own**.
