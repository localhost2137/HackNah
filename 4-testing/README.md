# 4 · Testing

Four test layers. All of them passed on 2026-10-04, and the full output is in [`results/`](results).

| Suite | Command | Result |
|---|---|---|
| Gateway end to end: the real Worker, D1, Durable Objects and Queues, with a scripted model | `pnpm test:gateway` | **37 / 37 passed** ([log](results/gateway-e2e.txt)) |
| Control suite: 1,165 cases × channels × obfuscations through the policy engine | `pnpm test:controls` | **294 / 294 required passed** ([balanced](results/controls-balanced.txt), [strict](results/controls-strict.txt), [permissive](results/controls-permissive.txt)) |
| Attack analysis: labelled datasets replayed in the dashboard | UI or `hacknah_run_analysis` | see below |
| Unit tests | `pnpm test` | **327 / 327 passed** ([log](results/unit-tests.txt)) |

## Showcase scenarios

| # | Scenario | Expected | Shown by |
|---|---|---|---|
| 1 | Model calls `Bash` with `curl https://… \| sh` | Tool call replaced by a notice; the agent never runs it | e2e check 3, [screenshot](screenshots/event-bash-block.png) |
| 2 | A web page fetched by the agent contains hidden instructions | Tool result withheld before the model reads it | e2e check 13, [screenshot](screenshots/event-tool-result-injection.png) |
| 3 | Agent tries to email data to an outside address | Blocked by the argument rule `to` = `@company.com` | [screenshot](screenshots/event-exfil-email.png) |
| 4 | Model output contains an AWS secret key | Redacted mid-stream; the rest of the answer arrives | e2e checks 1, 7 |
| 5 | Model output contains a destructive command | Answer cut short with a notice | e2e checks 2, 8 |
| 6 | Stolen token used from another machine | Blocked: device mismatch | [screenshot](screenshots/event-device-block.png) |
| 7 | First request from a new laptop | Waits for admin approval in the dashboard | [screenshot](screenshots/event-approved.png) |
| 8 | User exceeds the USD budget | `max_tokens` capped first, then blocked | e2e check 17 |
| 9 | Runaway agent fires parallel requests | Concurrency limit refuses the second one | e2e check 18 |
| 10 | Local GPU model used past its GPU-seconds budget | Blocked | e2e check 19 |
| 11 | Model not in the catalog | Refused | e2e check 16 |
| 12 | Normal coding work (`ls -la`, clean answers) | Passes untouched (Anthropic and OpenAI upstreams) | e2e checks 0, 4, 6, 10 |
| 13 | Member tries admin `hacknah_*` platform tools | Not listed and cannot be invoked | e2e check 24 |

## Attack analysis results (recommended guardrails)

| Dataset | Events | Matched | Missed attacks | False positives | Needs approval |
|---|---|---|---|---|---|
| Mixed check · 500 (held out) | 500 | **92%** | 37 | 4 | 0 |
| Normal requests (benign only) | 1,270 | **99%** | – | 16 | 0 |
| Hack?Nah! control cases | 1,136 | **95%** | 50 | 2 | 0 |
| Synthetic: prompt injection | 2,400 | 88% | 164 | 0 | 131 |
| Synthetic: tool poisoning | 1,800 | 90% | 0 | 189 | 0 |
| Synthetic: argument exfiltration | 2,200 | 66% | 157 | 239 | 344 |

**Known gaps.** Argument exfiltration is the weakest set: 344 calls go to a person for approval
instead of getting a clear decision, and 239 benign calls are blocked. Tool poisoning catches every
attack but also blocks 189 benign requests. Both are tuning targets for the next iteration.

(The "e2e check" numbers are the row indexes in the [gateway log](results/gateway-e2e.txt).)

## Run it yourself

```sh
pnpm install && pnpm db:setup && pnpm dev      # http://localhost:3000, admin@demo.test / LocalDemo123!
pnpm test:gateway                              # isolated copy, no keys needed (~30 s)
pnpm test:controls                             # add --preset strict|permissive
```
