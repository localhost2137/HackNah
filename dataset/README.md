# Control suite dataset

`cases.jsonl` holds the requests the control suite sends through the policy engine: attacks
that should be blocked or redacted, and benign requests that should pass. Run it with:

```sh
pnpm test:controls                              # rebuild the dataset, run the balanced preset
node scripts/controls.ts --preset strict        # permissive | balanced | strict
node scripts/controls.ts --feed feeds/local.json   # add a signature feed (file or URL)
node scripts/controls.ts --verbose              # list every miss
```

The run exits with code 1 when a required case fails and writes every result to
`dataset/results.json`.

## What a case looks like

One JSON object per line:

| Field | Meaning |
| --- | --- |
| `id` | `<base>.<channel>.<obfuscation>` |
| `base` | The hand-written payload the case was generated from |
| `attack` | `code_execution`, `deserialization`, `supply_chain`, `destructive_command`, `exfiltration`, `prompt_injection`, `tool_poisoning`, `agent_tampering`, `secret_leak`, `pii`, `identity`, or `benign` |
| `channel` | Where the content arrives: `user_input`, `tool_result`, `tool_arguments`, `agent_message`, `model_output`, `tool_description`, or `identity` for device cases |
| `obfuscation` | `none`, `base64`, `unicode` (zero-width characters), `split` (shell `${IFS}` or line breaks), `polish` |
| `input` | The request the gateway sees: `kind`, `text`, `toolName`, optional `toolArguments` and `deviceStatus` |
| `expected` | `allow`, `block`, `redact` or `pending` |
| `mustHide` | For `redact` cases, the value that must not reach the model |
| `control` | The workflow block expected to act |
| `hard` | Benign cases written to look like attacks |
| `source` | The incident or advisory the payload comes from, with a CVE or ATLAS id where one exists |
| `framework` | OWASP (LLM Top 10 or Agentic Top 10) and MITRE ATLAS ids |

## How it is built

`build.mjs` multiplies hand-written base payloads across channels and obfuscations. The base
payloads are taken from public incident reports and advisories; each names its source. Variants
of one payload are not independent attacks: they measure how well a control survives a disguise,
so the report counts them separately from plain payloads.

Payloads are inert. Hosts are `example.*` names and documentation IP ranges, credentials are fake
values in valid formats (the AWS key is the one from AWS's own documentation), and personal data
uses public test numbers.

## What "required" means

A case is required when its payload is not obfuscated, it is not a look-alike benign case, and
the gateway inspects its channel. Today that is prompts and tool results on their way to the
model (`user_input`, `tool_result`), tool calls (`tool_arguments`), messages between agents
(`agent_message`) and device identity.

Messages between agents count as inspected: an orchestrator posts them to
`POST /v1/acl/inspect` and they run through the same workflow.

Model responses and tool descriptions are **not inspected yet**. The cases exist so the report
shows those columns as uncovered, and so they start counting the day the gateway scans them:
add the channel to `INSPECTED` in `scripts/controls.ts`.

## Scope of the run

The suite calls the same `evaluateGraph()` the gateway calls, with the sample policy from
`packages/shared/src/presets.ts`. It does not start the gateway, so it does not cover
authentication, rate limits or the approval queue; those have their own unit tests.

## Public datasets

`node dataset/import.mjs` downloads public attack datasets into `dataset/imported/`, converted
to the same case format. Every row keeps its source, the label its dataset gave it (`label`),
and the channel it arrives on.

| Dataset | What it contains | Attack label | Channel | Rows |
| --- | --- | --- | --- | --- |
| [deepset/prompt-injections](https://huggingface.co/datasets/deepset/prompt-injections) | Injections and benign prompts, partly German | `prompt_injection` / benign | user input | 662 |
| [Lakera/gandalf_ignore_instructions](https://huggingface.co/datasets/Lakera/gandalf_ignore_instructions) | Instruction overrides from the Gandalf game | `prompt_injection` | user input | 777 |
| [Lakera/gandalf_summarization](https://huggingface.co/datasets/Lakera/gandalf_summarization) | Injections inside documents to summarise | `indirect_injection` | tool result | 114 |
| [xTRam1/safe-guard-prompt-injection](https://huggingface.co/datasets/xTRam1/safe-guard-prompt-injection) | Injections and benign prompts | `prompt_injection` / benign | user input | 2000 |
| [yanismiraoui/prompt_injections](https://huggingface.co/datasets/yanismiraoui/prompt_injections) | Injections in several languages | `prompt_injection` | user input | 1034 |
| [jackhhao/jailbreak-classification](https://huggingface.co/datasets/jackhhao/jailbreak-classification) | Jailbreak and benign role-play prompts | `jailbreak` / benign | user input | 1306 |
| [TrustAIRLab/in-the-wild-jailbreak-prompts](https://huggingface.co/datasets/TrustAIRLab/in-the-wild-jailbreak-prompts) | Jailbreaks collected from Discord and Reddit, with platform and date | `jailbreak` | user input | 1405 |
| [rubend18/ChatGPT-Jailbreak-Prompts](https://huggingface.co/datasets/rubend18/ChatGPT-Jailbreak-Prompts) | Named jailbreak prompts | `jailbreak` | user input | 79 |
| [JailbreakBench/JBB-Behaviors](https://huggingface.co/datasets/JailbreakBench/JBB-Behaviors) | Harmful requests with benign twins, by harm category | `harmful_request` / benign | user input | 200 |
| [lmsys/toxic-chat](https://huggingface.co/datasets/lmsys/toxic-chat) | Real user prompts annotated by people; mostly benign | `jailbreak`, `harmful_request` / benign | user input | 2000 |
| [PurpleLlama CyberSecEval](https://github.com/meta-llama/PurpleLlama/tree/main/CybersecurityBenchmarks) | Direct and indirect injections, labelled by technique and language | `prompt_injection`, `indirect_injection` | user input, tool result | 251 |
| [InjecAgent](https://github.com/uiuc-kang-lab/InjecAgent) | Tool responses with an attacker instruction planted inside, labelled by harm type, plus the same responses without it | `indirect_injection` / benign | tool result | 1071 |
| [BIPIA](https://github.com/microsoft/BIPIA) | Instructions planted in external content, by category | `indirect_injection` | tool result | 125 |

Larger datasets are capped at 2000 rows, read from evenly spaced pages.

These rows are third-party data, used here for testing the control layer only. They belong to
their authors; see each dataset's page for its terms. Some of them, the jailbreak collections in
particular, contain offensive text.

The suite reports the public datasets in their own tables and never requires them to pass. They
measure the controls on prompts nobody on the team wrote. Signature and keyword matching catches
few of them, by design: free-form injections and jailbreaks are a model's job, and the suite
does not call one.

Two things to keep in mind when reading the numbers:

- `harmful_request` rows ask for harmful content without attacking the agent. A control layer
  for coding agents is not a content moderator, so a low rate there is expected.
- Many BIPIA rows read like ordinary requests ("write a script that renames files"). They are
  attacks because of where they arrive, inside an email or a web page. Content checks cannot see
  that; the untrusted content guard is the control for it.

To add another dataset, add an entry to `SOURCES` in `import.mjs`.
