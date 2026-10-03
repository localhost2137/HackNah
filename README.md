# AI Control Layer

A control plane for Claude Code: every model request, built-in tool call and MCP tool call goes through
a gateway that applies the organization's workflows (device fingerprint, dangerous keywords, judge model,
redaction), rate limits and access rules. Each workflow has start conditions (request kind, tool, MCP
server, model, ...) and the member groups it runs for; every matching workflow runs and the strictest
outcome wins, while a request that starts no workflow is allowed. A dashboard shows the traffic, handles
approvals and manages policy. Both live in one Cloudflare Worker, backed only by Cloudflare services (D1, R2, Queues and
Durable Objects).

## Layout

| Path | What it is |
| --- | --- |
| `apps/web` | The Worker. `src/server.ts` sends `/v1`, `/mcp`, `/auth` and `/health` to the gateway (`src/gateway`, Hono) and everything else to the dashboard (TanStack Start) |
| `packages/shared` | Workflow schema and engine, redaction, crypto, judge client |
| `packages/db` | Drizzle schema and generated SQL migrations for D1 |
| `packages/ui` | Tailwind theme and UI primitives |
| `claude-plugin` | hy-guard Claude Code plugin, mock platform, and backend integration contract |

## How a request flows

```
Claude Code ──► /v1/messages ──► workflow ──► openrouter.ai (Anthropic-compatible API)
            ──► /mcp          ──► access + rate limit + workflow ──► GitHub / Jira / ... MCP
            ──► /v1/acl/hooks/pre-tool-use (Bash, Edit, ...) ──► workflow
                         │
                         ├─ pending ──► ApprovalDO ──WebSocket──► dashboard Logs
                         └─ event ──► Queue ──► D1 (metadata) + R2 (payloads)
```

- **Auth.** The plugin logs in with the OAuth device flow. It gets a 15-minute JWT bound to a hash of the machine
  fingerprint, plus a rotating refresh token with reuse detection. The same token presented with a different
  fingerprint is flagged as `mismatch`. The workflow's fingerprint node routes it to a block or an approval.
- **Sessions.** Claude Code's session id is pinned to the first user and device that use it (`SessionDO`). The
  session also stores the resource scope picked with `/acl resources` and the redaction vault.
- **Workflow.** Each organization has one versioned policy graph (draft, then publish), edited with React Flow.
  Route nodes match on request kind, MCP server, tool, resource, group, device or model, so different tools can
  take stricter or looser paths. Check nodes (fingerprint, keywords, judge, redact) branch on their result, and
  every path ends in allow, approval or block. `evaluateGraph()` in `packages/shared` runs it in the gateway and
  in the editor's dry run, and each event stores the path it took.
- **Models.** The gateway forwards Anthropic Messages requests to OpenRouter with the organization's
  `OPENROUTER_API_KEY`. Claude Code is only guaranteed to work with Anthropic models there. The judge step can use
  OpenRouter too (`https://openrouter.ai/api/v1/chat/completions`), with the same key.
- **Dashboard login.** Email and password, or OIDC single sign-on (Settings → Single sign-on).
  People on the configured email domain must use SSO and join as members; admins keep password login as a
  fallback. Removing a member also revokes their Claude Code devices.
- **Access.** Admins group MCP tools into resources (tool glob patterns) and grant them to users or groups.
  Admins can use every resource. Checks are D1 queries, cached for 10 seconds.
- **MCP credentials** are AES-GCM encrypted with additional authenticated data (AAD) bound to the server and the
  user. They are only decrypted inside the Worker when calling the upstream MCP server.
- **Redaction** replaces secrets and PII with `[REDACTED_EMAIL_1]`-style placeholders before the model sees them,
  and restores them in MCP tool arguments, so the agent can work with data it never sees in clear text.

## Local development

Requirements: Node 22+ and pnpm 12. No Docker: D1, R2, Queues and Durable Objects all run locally inside the
Vite dev server.

```sh
pnpm install
cp apps/web/.dev.vars.example apps/web/.dev.vars   # fill OPENROUTER_API_KEY and generate the three secrets
pnpm db:migrate                                    # applies packages/db/drizzle to the local D1
pnpm dev                                           # http://localhost:3000 (dashboard and gateway) + mock SSO
```

This is a single-tenant installation. The first account becomes admin automatically; later accounts need access granted by an admin or SSO. Local data lives in
`apps/web/.wrangler/state`; delete that folder and run `pnpm db:migrate` again to start over.

For local test data, run `pnpm db:seed` after migrations. This adds 48 sample
traffic events to the existing instance, plus `admin@demo.test` and `member@demo.test` accounts with their
respective roles. Both use password `LocalDemo123!`. The seed always targets local D1 and preserves
existing fixtures when rerun. These credentials are for local development only.

Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

After changing `packages/db/src/schema.ts`, run `pnpm db:generate` and commit the new file in `packages/db/drizzle`.
D1 allows at most 100 bound parameters per statement, so split multi-row inserts with `chunkRows` from `@acl/db`.

## Administrator dashboard

The dashboard is restricted to admins, including its server functions and live
stream. Members use Claude Code rather than the admin console. **Logs** is the central place for request
decisions, session/device context, and legacy approval records. The former Approvals, Sessions, and
Devices URLs redirect to Logs. Legacy `/device` sign-in remains a standalone authenticated page.
Migration `0002_admin_role.sql` converts existing owners and pending owner invitations to admin; apply
it before deploying this version. Migration `0003_single_tenant.sql` enforces one internal scope and
bootstraps the first admin. Existing scope IDs stay intact to preserve logs and policy links. Installations
with multiple existing scopes fail migration instead of silently merging data. Organization creation,
switching, and settings are removed.

In development, **Fill admin credentials** fills the login form with the seeded admin account.
It is excluded from production builds.

### Testing single sign-on locally

`pnpm dev` also starts a development-only OIDC identity provider at `http://localhost:9400`
(`pnpm mock:idp` runs it alone). It accepts any client ID and secret and signs in whoever you pick,
without a password. If the port is taken, it assumes another copy is running and stays idle.

1. Run `pnpm db:seed`. It registers the mock as the instance's provider for `sso.test` and creates
   `admin@sso.test` (admin) and `member@sso.test` (member), already linked to it.
2. Click **Sign in with mock SSO** on the login page and pick an account. Development builds trust
   `http://localhost:9400` automatically, so no `.dev.vars` entry is needed.

Other emails on the mock's page (`alice@sso.test`, `bob@sso.test`, or any you type) join as new members,
so they land on the admin-required page until promoted in Members. If Settings already has a provider,
the seed leaves it alone; turn it off and rerun the seed to use the mock. Restarting the mock rotates its
signing key, which is fine. Only development builds accept an `http://` issuer, and both the button and
the seeded provider are for local development only.

## Connecting Claude Code

The target client is **hy-guard**, now included in [`claude-plugin`](claude-plugin/README.md). It currently
runs against its own mock platform; it is **not yet compatible** with the gateway in `apps/web`.
The dashboard's Claude Code plugin page reflects this status instead of advertising the old `acl` CLI.

Read the [backend guide](claude-plugin/docs/BACKEND_GUIDE.md) and
[wire contract](claude-plugin/docs/BACKEND_CONTRACT.md) before integrating. The main gaps are:

- Discovery, request-bound DPoP proofs, shared nonce/replay state, and signed responses.
- OAuth authorization code + PKCE and device-key-bound tokens (the current gateway uses device codes).
- Versioned `/v1/policy` and batched `/v1/events`, plus server-side tool-policy enforcement.
- Plugin confirmation, Touch ID presence proofs, and fresh-sign-in browser challenges. These differ from
  the current workflow's administrator approval queue; that queue remains available in Logs until migrated.
- A compatible `/llm/*` streaming gateway; the existing model endpoint is `/v1/messages`.

Keep device/session identity and revocation in the backend: these are security inputs, even though there
are no standalone device or session dashboard screens. Do not copy the mock's auto-approval shortcuts.
Use the plugin's isolated test profile as documented there; do not change a user's main Claude profile.

## Deploying

One-time setup per Cloudflare account:

```sh
cd apps/web
npx wrangler d1 create acl                      # put the database_id in wrangler.jsonc
npx wrangler r2 bucket create acl-payloads
npx wrangler queues create acl-events && npx wrangler queues create acl-events-dlq
npx wrangler secret put OPENROUTER_API_KEY      # also JWT_SECRET, BETTER_AUTH_SECRET, ENCRYPTION_KEY, JUDGE_API_KEY (optional)
```

Set `PUBLIC_URL` in `apps/web/wrangler.jsonc` to the production URL, then:

```sh
pnpm db:migrate:remote
pnpm --filter @acl/web run deploy
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests and the build on every PR, and on `main` applies the
D1 migrations and deploys. It needs the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets.

## Not here yet

- Integration of the included hy-guard plugin with the real backend (see the contract above).
- Email invitations. Members are added by email once they have signed up.
- Proof-of-possession tokens (DPoP-style key binding) on top of the fingerprint binding.
- Device-bound dashboard sessions (DBSC, `@dbsc-toolkit/better-auth`).
- SSO domain verification (DNS TXT). Until then, the first organization to claim an email domain owns it.
