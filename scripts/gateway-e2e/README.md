# Gateway end-to-end suite

```sh
pnpm test:gateway           # run every check, print the results, clean up (about 20 s)
pnpm test:gateway --keep    # leave the gateway and the mock model running for manual requests
```

The suite runs the real gateway (`vite dev`: Workers runtime, local D1, Durable Objects and queues)
against a scripted model server, sends requests the way Claude Code sends them, and checks what the
client receives, what reached the model, and what the audit log recorded. Each check covers a control
from the challenge: some show that allowed traffic passes untouched, others that unsafe traffic is
blocked, withheld, redacted or rate limited.

It works on a copy of the working tree in the system temp directory, with its own database and
secrets, so a dev server you have running and its data are never touched. No API keys or network
access are needed.

## What it checks

| Check | Control it demonstrates |
|---|---|
| Clean answer streams through unchanged (Anthropic and OpenAI upstream) | Guardrails, allowed case: no false positive |
| A secret (AWS key) in the model's output is redacted, streamed and not streamed | Output filtering: redact |
| A destructive command in the output cuts the answer short with a notice | Output filtering: block |
| A tool call to `curl … \| sh` is replaced by a notice and the stop reason corrected | Guardrails, blocked case: tool calls |
| An allowed tool call (`ls -la`) reaches the agent whole | Guardrails, allowed case: tool calls |
| The PreToolUse hook gets the cached verdict for the same call; no second event | One decision per tool call |
| A tool result containing an injection is withheld before the model sees it | Prompt injection, indirect |
| A local model goes out as OpenAI chat completions under its upstream name, without a key | Model routing, local models |
| A chain of condition blocks (model input AND a pilot model) blocks a matching request; any other request ends in Skip | Conditions (AND, Skip) |
| A model outside the catalog is refused | Allowed models |
| A workflow that ended in Skip is listed on the event but does not decide | Conditions (Skip) |
| A USD budget (cache reads and writes priced) blocks once spent; `max_tokens` is capped first | Budget, external API |
| A concurrency limit of 1 refuses the second parallel request, then frees the slot | Resource governance, runaway agents |
| A GPU-seconds budget on a local model blocks after use | Budget, local compute |
| The audit log has model output, tool result, tool call and rate-limit decisions | Security reporting |
| Cost and GPU time are recorded per request | Budget reporting |

After the checks it prints the control layer's own overhead per stage (p50, p95, max), read from
the audit log: the performance telemetry the evaluation asks for.

## How it is built

- `run.mjs`: copies the tree, installs dependencies offline, creates the database (secrets,
  migrations, seed), loads the fixtures, starts the mock and the gateway on free ports, runs the
  checks, and always stops both.
- `mock-upstream.mjs`: a model server for both the Anthropic Messages and the OpenAI chat
  completions APIs. It picks its answer from keywords in the prompt (`LEAK`, `DANGER`, `CURL`,
  `LISTFILES`, `SLOW`) and keeps every request for the checks at `GET /_requests`.
- `fixtures.mjs`: a trusted device, the model catalog, three limits and two stage workflows (Model
  output: redact and block `rm -rf /`; Tool results: block an injection phrase). The seeded Default
  workflow already blocks `curl * | sh`. Each check uses its own model id, so budgets don't leak
  between checks and the order doesn't matter.
- `checks.mjs`: the checks.

To add a check, give it a new model id (and a catalog or limit entry in `fixtures.mjs` if it
needs one), add a keyword to the mock if it needs a new answer, and call `check(name, control, fn)`
in `checks.mjs`. `fn` returns `true` or `{ ok, ...details }`.

The suite also exercises the built-in Hack?Nah! MCP: admin-only discovery without an integration,
fingerprint binding, input validation, workflow draft/publish, policy preview, saved analysis and
invalidation, audit attribution, and immediate role/device revocation. These mutations run only in
the disposable copy.
