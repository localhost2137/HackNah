# Hack?Nah!

Control plane for Claude Code. Gateway checks model requests, tool calls, and MCP calls against guardrails, limits, and access rules. Dashboard shows traffic, approvals, and policy. Single Cloudflare Worker backed by D1, R2, Queues, and Durable Objects.

## Layout

| Path | Contents |
| --- | --- |
| `apps/web` | Worker. `src/server.ts` sends `/v1`, `/mcp`, `/auth`, `/health` to the gateway (`src/gateway`, Hono) and all else to the dashboard (TanStack Start) |
| `packages/shared` | Guardrail schema and engine, redaction, crypto, judge client |
| `packages/db` | Drizzle schema and SQL migrations for D1 |
| `packages/ui` | Tailwind theme and UI primitives |
| `claude-plugin` | hy-guard plugin, mock platform, backend contract |

## Request flow

```
                     ┌──────────────── gateway (one Worker) ─────────────────────────────┐
Claude Code ──► /v1/messages ─► catalog route ─► limits ─► Model input ─► Tool result (each) ─┐
                     │                                                                     ▼
            ◄── output guard ◄─ Model output (text) + Tool call / Agent message (tool_use) ◄─ upstream
                     │            Anthropic API (OpenRouter, Anthropic)  or  OpenAI API (Ollama, vLLM, ...)
            ──► /mcp ─► access ─► limits ─► Tool call ─► MCP server ─► Tool result ─► agent
            ──► /v1/acl/hooks/pre-tool-use (Bash, Edit, ...) ─► cached verdict, else limits ─► Tool call
                     │
                     ├─ pending ──► ApprovalDO ──WebSocket──► dashboard Logs
                     └─ event (stage, decision, cost, timing) ──► Queue ──► D1 + R2 (payloads)
```

- **Stages.** You tick stages per guardrail: model input, tool call, tool result, model output, agent message. A start node with no tick runs on all stages. Blocks with no rule for a stage skip it. Each match runs and the strictest verdict wins.
- **Output guard.** Gateway holds streamed text behind a 200-character buffer, runs deterministic checks, redacts secrets, then releases text. Judge runs on complete blocks. You see a notice in place of a refused block. Gateway holds tool calls until arguments complete.
- **Tool results.** Gateway withholds a refused result from the model (`[Tool result withheld by Hack?Nah!: …]`) and lets the turn continue. You check MCP results at `/mcp` and built-in results on the next model request.
- **Limits.** You cap requests, concurrency, tokens, USD, GPU-seconds per model, server, tool, resource, judge call. You count per user, per group member, per group, per org. Past the cap you block, warn, or route to a Usage limit block for approval. Gateway charges spend after the call, cache reads and writes included, and trims `max_tokens` to budget left.
- **Auth and sessions.** You log in with OAuth device flow. You receive a 15-minute JWT bound to a machine fingerprint hash plus a rotating refresh token with reuse detection. A token with a changed fingerprint flags as `mismatch` for the fingerprint node. Gateway pins a Claude Code session id to first user and device (`SessionDO`) and stores resource scope and redaction vault there.
- **Guardrails.** You edit each guardrail as a versioned graph (draft, then publish) in React Flow. Condition blocks ask one question each (Tool is, Model is, MCP server is, User group is, Stage is) with Yes and No exits. You chain Yes for AND and No for OR. Check nodes (fingerprint, keywords, judge, redact) branch on result. Each path ends in allow, approval, block, or Skip. `evaluateGraph()` in `packages/shared` runs in gateway and editor dry run. Each event stores the path it took.
- **Traces.** One trace holds one user turn: prompt plus each model request, tool call, result, output, agent message. Model responses return `x-acl-trace-id`. Claude Code 2.1.283+ sends `x-claude-code-prompt-id` when you set `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`. Gateway falls back to session plus prompt. In Logs you click a trace id to list events and click Path to see the guardrail chart for that version.
- **Models and access.** You list allowed models in Models: id pattern, endpoint, price per million tokens (input, output, cache write, cache read) or per GPU-hour. Requests use first match. With an empty catalog all traffic goes to OpenRouter with `OPENROUTER_API_KEY`. You grant MCP tools through named resources (server id to tool globs) to users or groups. Groups hold models and built-in tools. Admins call all tools. Access checks cache for 10 seconds. You log in with email and password or OIDC SSO. You restrict the dashboard to admins. Members use Claude Code.
- **Credentials and redaction.** Gateway encrypts MCP credentials with AES-GCM bound to server and user and decrypts them in the Worker for upstream calls. Gateway swaps secrets and PII for `[REDACTED_EMAIL_1]` placeholders before the model reads them and restores them in MCP tool arguments.

## Platform tools

You manage policy through the existing `/mcp` endpoint with `hacknah_*` tools. You present gateway bearer token and `x-acl-device` header. You need active admin membership and a trusted device on each call. Members see no tools.

| Tools | Actions |
| --- | --- |
| `hacknah_platform_context` | Inspect group, resource, integration IDs |
| `hacknah_list_guardrails`, `hacknah_get_guardrail`, `hacknah_guardrail_schema` | Inspect guardrails and graph format |
| `hacknah_create_guardrail`, `hacknah_update_guardrail`, `hacknah_save_guardrail_draft`, `hacknah_publish_guardrail` | Create, edit, publish with dashboard services |
| `hacknah_export_policy`, `hacknah_preview_policy`, `hacknah_apply_policy` | Read, preview, apply guardrails, limits, catalog |
| `hacknah_list_events`, `hacknah_get_event` | Inspect traffic and checks |
| `hacknah_list_datasets`, `hacknah_run_analysis`, `hacknah_list_analysis_runs`, `hacknah_get_analysis_run` | Replay traffic and fetch stored results |

You save drafts apart from publishing. Publishing, enabling, disabling, applying change production rules. You treat policy text as configuration. Gateway logs actor, attempt, outcome in Settings audit log and Logs. You keep existing `acl` paths, headers, scopes. Package and MCP IDs use `hack-nah`. Client IDs use `hy-guard`.

## Attack analysis

You open Attack analysis, pick a dataset, run it against published guardrails.

- **Mixed check** (200, 500, 1000 rows): half attacks, half normal. You rerun this one after guardrail edits.
- **Normal requests**: benign rows. You count blocks as false positives.
- **Synthetic**: prompt injection, tool poisoning, definition drift, argument exfiltration with varied device and session signals.
- **Labelled**: public sets plus project cases with sources in `dataset/`. `pnpm db:seed` loads them (`pnpm datasets:upload` loads sets alone).

Gateway stores results and policy snapshots in D1 and R2 and keeps ten valid runs per dataset. Synthetic runs use group context and send no production traffic. Apply migrations before you start or deploy.

## Local development

You need Node 22+ and pnpm 12. You need no Docker. You run D1, R2, Queues, Durable Objects inside the Vite dev server.

```sh
pnpm install
cp apps/web/.dev.vars.example apps/web/.dev.vars   # fill OPENROUTER_API_KEY and generate the three secrets
pnpm db:migrate
pnpm dev                                            # http://localhost:3000 + mock SSO
```

You claim admin with first signup. You grant access to later accounts. Local data lives in `apps/web/.wrangler/state`. You delete that folder and rerun `pnpm db:migrate` to reset.

For test data you run `pnpm db:seed` after migrations. Seed adds a month of traffic from seven people plus `admin@demo.test` and `member@demo.test` with password `LocalDemo123!`. Seed targets local D1 and preserves fixtures on rerun. Use these credentials for local work alone.

Seed publishes six guardrails (device trust, prompt screening, tool call safety, tool result screening, model output, agent messages), switches Default off, uploads datasets, trains two models. Each block runs with no network call. On Mixed 500 seed blocks 213 of 250 attacks and 4 of 250 normal rows at p50 0.03 ms and p99 0.6 ms. Use `pnpm db:seed --reset-guardrails` to publish current graphs as a new version and `--skip-datasets` to leave the bucket alone.

Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

After you change `packages/db/src/schema.ts` you run `pnpm db:generate` and commit the file in `packages/db/drizzle`. D1 caps bound parameters at 100 per statement. You split multi-row inserts with `chunkRows` from `@acl/db`.

## Dashboard and SSO

Logs holds request decisions, session and device context, approval records. Former Approvals, Sessions, Devices URLs redirect to Logs. In dev builds Fill admin credentials fills the login form with the seeded admin account.

`pnpm dev` starts a dev OIDC provider at `http://localhost:9400` (`pnpm mock:idp` runs it alone). You run `pnpm db:seed` to register it for `sso.test` with `admin@sso.test` (admin) and `member@sso.test` (member). You click Sign in with mock SSO and pick an account. Other addresses join as members and wait for promotion in Members. Use mock SSO for local work alone.

## Claude Code plugin status

Target client `hy-guard` lives in [`claude-plugin`](claude-plugin/README.md) and runs against its own mock. It does not yet work with the gateway in `apps/web`. Read [backend guide](claude-plugin/docs/BACKEND_GUIDE.md) and [wire contract](claude-plugin/docs/BACKEND_CONTRACT.md) before you integrate. Open gaps:

- Discovery, request-bound proofs, shared nonce and replay state, signed responses.
- OAuth code plus PKCE and device-key-bound tokens (gateway uses device codes).
- Versioned `/v1/policy`, batched `/v1/events`, server-side tool-policy enforcement.
- Plugin confirmation, Touch ID presence proofs, fresh-sign-in browser challenges.
- Compatible `/llm/*` streaming gateway (model endpoint serves `/v1/messages`).

You keep device and session identity and revocation in the backend. You test with the isolated profile in `claude-plugin` docs. You leave the main Claude profile alone.

## Deploying

One-time setup per Cloudflare account:

```sh
cd apps/web
npx wrangler d1 create acl                      # put the database_id in wrangler.jsonc
npx wrangler r2 bucket create acl-payloads
npx wrangler queues create acl-events && npx wrangler queues create acl-events-dlq
npx wrangler secret put OPENROUTER_API_KEY      # plus JWT_SECRET, BETTER_AUTH_SECRET, ENCRYPTION_KEY, JUDGE_API_KEY (optional)
```

You set `PUBLIC_URL` in `apps/web/wrangler.jsonc` to the production URL, then:

```sh
pnpm db:migrate:remote
pnpm --filter @acl/web run deploy
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests, build on each PR and migrates plus deploys on `main`. CI needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Mock investigation data

You run `pnpm db:setup` once, then `pnpm dev`. Setup writes `.dev.vars` with dev secrets when missing, migrates, seeds. It preserves secrets, accounts, guardrails, connections, mock issues. You need no model key for fixtures. Seed needs Node 22.18+.

Integrations holds three mock connections on normal credential, discovery, permission, policy paths:

| Connection | Local endpoint | Tools |
| --- | --- | --- |
| Datadog (mock) | `/mock-mcp/datadog` | Environment, log search, trace detail, service health, monitors, deployments |
| Confluence (mock) | `/mock-mcp/confluence` | Environment, page search, full pages |
| Jira (mock) | `/mock-mcp/jira` | Environment, issue search and detail, create issue, add comment |

Endpoints serve stateless MCP Streamable HTTP with JSON from local D1. Shapes suit mocks. Production builds expose no mock data. Dataset Aurelius Securities is a fictional bank with synthetic identities, amounts, telemetry, URLs, incidents. Seed holds 415 records: 337 logs, 36 traces, 8 service profiles, 6 monitors, 5 deployments, 10 Confluence pages, 10 Jira issues, 3 environment manifests.

Main story PAY-1847 covers settlement timeouts after a retry change. RISK-932 covers a separate sanctions feed incident. You find evidence of delay and no evidence of lost funds or duplicate journals.

Try through the gateway:

- Investigate PAY-1847. Compare failing and healthy traces, find the deployment trigger, cite current runbook, rule on RISK-932 blame.
- Judge the old bulk-retry procedure. Compare CONF-103 with current runbook.
- Check the market-data warning. Name evidence for settlement link.
- As admin: create a follow-up Jira issue for missing replay canary coverage with a stable idempotency key.

`seed-member` and seeded SSO member sit in Demo investigators with read grants for the three mocks. You grant Jira write tickets resource to test write policies. Created tickets persist in D1 with bot attribution upstream and employee attribution in gateway logs.

For dataset clock you call `get_environment` before timestamp filters. `pnpm db:seed` preserves timeline. `pnpm --filter @acl/web db:seed --refresh-mocks` replays fixtures at current time and preserves user mock issues, credentials, grants, guardrail config.

For transport tests you use bearer `local-demo-<provider>-token`, `Content-Type: application/json`, `Accept: application/json, text/event-stream`, protocol `2025-06-18` with `MCP-Protocol-Version: 2025-06-18` on later requests. You send `x-mock-fault` with `unauthorized`, `rate-limit`, `unavailable`, `slow`, `tool-error` to trigger faults. GET and SSE return 405. Search uses AND text plus `service:`, `status:`, `env:`, `trace_id:` facets for Datadog. Jira uses project, status, priority filters. Lists use `limit` and `cursor`.
