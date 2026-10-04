#!/usr/bin/env node
// Downloads public attack datasets into dataset/imported/ in the suite's case format. Each row
// keeps the dataset it came from, the label that dataset gave it, and the channel it arrives on.
//
//   node dataset/import.mjs            every source
//   node dataset/import.mjs injecagent only sources whose name contains the word
//
// The downloaded rows are third-party data, used here for testing the control layer only. Some
// of them (the jailbreak collections in particular) contain offensive text.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = join(dirname(fileURLToPath(import.meta.url)), 'imported')
const HF = 'https://datasets-server.huggingface.co/rows'
const MAX_ROWS = 2000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Hugging Face rate-limits bursts (HTTP 429), so failures back off and pages are paced. */
async function getJson(url, tries = 7) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
      if (res.status === 429) throw Object.assign(new Error('HTTP 429'), { wait: 20_000 * attempt })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      if (attempt >= tries) throw err
      await sleep(err.wait ?? 1500 * attempt)
    }
  }
}

/** Rows of one Hugging Face split, capped; larger splits are read from evenly spaced pages. */
async function hf(dataset, config, split, limit = MAX_ROWS) {
  const page = (offset) =>
    getJson(
      `${HF}?dataset=${encodeURIComponent(dataset)}&config=${config}&split=${split}&offset=${offset}&length=100`,
    )
  const first = await page(0)
  const total = first.num_rows_total
  const rows = first.rows.map((r) => r.row)
  const pages = Math.ceil(total / 100)
  const wanted = Math.min(pages, Math.ceil(limit / 100))
  for (let i = 1; i < wanted; i++) {
    const offset = Math.floor((i * pages) / wanted) * 100
    await sleep(400)
    rows.push(...(await page(offset)).rows.map((r) => r.row))
  }
  return rows.slice(0, limit)
}

const GITHUB = 'https://raw.githubusercontent.com'
const toolResult = (tool, content) => `Tool result (${tool}):\n${content}`

// Each source returns rows of { text, attack, channel?, label?, language? }.
// attack: prompt_injection | indirect_injection | jailbreak | harmful_request | benign
const SOURCES = [
  {
    name: 'deepset/prompt-injections',
    license: 'Apache-2.0',
    url: 'https://huggingface.co/datasets/deepset/prompt-injections',
    load: async () =>
      [
        ...(await hf('deepset/prompt-injections', 'default', 'train')),
        ...(await hf('deepset/prompt-injections', 'default', 'test')),
      ].map((r) => ({ text: r.text, attack: r.label === 1 ? 'prompt_injection' : 'benign' })),
  },
  {
    name: 'Lakera/gandalf_ignore_instructions',
    license: 'MIT',
    url: 'https://huggingface.co/datasets/Lakera/gandalf_ignore_instructions',
    load: async () =>
      (await hf('Lakera/gandalf_ignore_instructions', 'default', 'train', 1000)).map((r) => ({
        text: r.text,
        attack: 'prompt_injection',
        label: 'instruction override',
      })),
  },
  {
    name: 'Lakera/gandalf_summarization',
    license: 'MIT',
    url: 'https://huggingface.co/datasets/Lakera/gandalf_summarization',
    load: async () =>
      (await hf('Lakera/gandalf_summarization', 'default', 'train')).map((r) => ({
        text: toolResult('document to summarise', r.text),
        attack: 'indirect_injection',
        channel: 'tool_result',
        label: 'injection in a document',
      })),
  },
  {
    name: 'xTRam1/safe-guard-prompt-injection',
    license: 'see dataset card',
    url: 'https://huggingface.co/datasets/xTRam1/safe-guard-prompt-injection',
    load: async () =>
      (await hf('xTRam1/safe-guard-prompt-injection', 'default', 'test')).map((r) => ({
        text: r.text,
        attack: r.label === 1 ? 'prompt_injection' : 'benign',
      })),
  },
  {
    name: 'yanismiraoui/prompt_injections',
    license: 'see dataset card',
    url: 'https://huggingface.co/datasets/yanismiraoui/prompt_injections',
    load: async () =>
      (await hf('yanismiraoui/prompt_injections', 'default', 'train')).map((r) => ({
        text: r.prompt_injections,
        attack: 'prompt_injection',
        label: 'multilingual',
        language: 'multilingual',
      })),
  },
  {
    name: 'jackhhao/jailbreak-classification',
    license: 'see dataset card',
    url: 'https://huggingface.co/datasets/jackhhao/jailbreak-classification',
    load: async () =>
      [
        ...(await hf('jackhhao/jailbreak-classification', 'default', 'train')),
        ...(await hf('jackhhao/jailbreak-classification', 'default', 'test')),
      ].map((r) => ({ text: r.prompt, attack: r.type === 'jailbreak' ? 'jailbreak' : 'benign' })),
  },
  {
    name: 'TrustAIRLab/in-the-wild-jailbreak-prompts',
    license: 'see dataset card',
    url: 'https://huggingface.co/datasets/TrustAIRLab/in-the-wild-jailbreak-prompts',
    load: async () =>
      (await hf('TrustAIRLab/in-the-wild-jailbreak-prompts', 'jailbreak_2023_12_25', 'train')).map(
        (r) => ({ text: r.prompt, attack: 'jailbreak', label: `seen on ${r.platform}, ${r.date}` }),
      ),
  },
  {
    name: 'rubend18/ChatGPT-Jailbreak-Prompts',
    license: 'see dataset card',
    url: 'https://huggingface.co/datasets/rubend18/ChatGPT-Jailbreak-Prompts',
    load: async () =>
      (await hf('rubend18/ChatGPT-Jailbreak-Prompts', 'default', 'train')).map((r) => ({
        text: r.Prompt,
        attack: 'jailbreak',
        label: r.Name,
      })),
  },
  {
    name: 'JailbreakBench/JBB-Behaviors',
    license: 'MIT',
    url: 'https://huggingface.co/datasets/JailbreakBench/JBB-Behaviors',
    load: async () => [
      ...(await hf('JailbreakBench/JBB-Behaviors', 'behaviors', 'harmful')).map((r) => ({
        text: r.Goal,
        attack: 'harmful_request',
        label: r.Category,
      })),
      ...(await hf('JailbreakBench/JBB-Behaviors', 'behaviors', 'benign')).map((r) => ({
        text: r.Goal,
        attack: 'benign',
        label: `benign twin: ${r.Category}`,
      })),
    ],
  },
  {
    name: 'lmsys/toxic-chat',
    license: 'CC-BY-NC-4.0',
    url: 'https://huggingface.co/datasets/lmsys/toxic-chat',
    // Real user prompts to a chatbot, annotated by people. Most are benign.
    load: async () =>
      (await hf('lmsys/toxic-chat', 'toxicchat0124', 'test')).map((r) => ({
        text: r.user_input,
        attack:
          r.jailbreaking === 1 ? 'jailbreak' : r.toxicity === 1 ? 'harmful_request' : 'benign',
        label:
          r.jailbreaking === 1 ? 'jailbreaking' : r.toxicity === 1 ? 'toxic' : 'real user prompt',
      })),
  },
  {
    name: 'meta-llama/PurpleLlama CyberSecEval prompt injection',
    license: 'MIT',
    url: 'https://github.com/meta-llama/PurpleLlama/tree/main/CybersecurityBenchmarks',
    load: async () =>
      (
        await getJson(
          `${GITHUB}/meta-llama/PurpleLlama/main/CybersecurityBenchmarks/datasets/prompt_injection/prompt_injection.json`,
        )
      ).map((r) => ({
        text:
          r.injection_type === 'indirect'
            ? toolResult('fetched content', r.user_input)
            : r.user_input,
        attack: r.injection_type === 'indirect' ? 'indirect_injection' : 'prompt_injection',
        channel: r.injection_type === 'indirect' ? 'tool_result' : 'user_input',
        label: r.injection_variant,
        language: r.speaking_language,
      })),
  },
  {
    name: 'uiuc-kang-lab/InjecAgent',
    license: 'MIT',
    url: 'https://github.com/uiuc-kang-lab/InjecAgent',
    // Tool responses with an attacker instruction planted inside. The benign twins are the same
    // tool responses with an ordinary sentence where the instruction was.
    load: async () => {
      const files = ['test_cases_dh_base.json', 'test_cases_ds_base.json']
      const rows = (
        await Promise.all(
          files.map((f) => getJson(`${GITHUB}/uiuc-kang-lab/InjecAgent/main/data/${f}`)),
        )
      ).flat()
      const attacks = rows.map((r) => ({
        text: toolResult(r['User Tool'], r['Tool Response']),
        attack: 'indirect_injection',
        channel: 'tool_result',
        label: r['Attack Type'],
      }))
      const templates = new Map(rows.map((r) => [r['User Tool'], r['Tool Response Template']]))
      const twins = [...templates].map(([tool, template]) => ({
        text: toolResult(
          tool,
          template.replace('<Attacker Instruction>', 'Works as described, would recommend.'),
        ),
        attack: 'benign',
        channel: 'tool_result',
        label: 'tool response without the injection',
      }))
      return [...attacks, ...twins]
    },
  },
  {
    name: 'microsoft/BIPIA',
    license: 'MIT',
    url: 'https://github.com/microsoft/BIPIA',
    // Instructions planted in external content. Many read like ordinary requests: what makes them
    // attacks is where they arrive, which content checks cannot see and taint tracking can.
    load: async () => {
      const [text, code] = await Promise.all(
        ['text_attack_test.json', 'code_attack_test.json'].map((f) =>
          getJson(`${GITHUB}/microsoft/BIPIA/main/benchmark/${f}`),
        ),
      )
      return Object.entries({ ...text, ...code }).flatMap(([category, attacks]) =>
        attacks.map((attack) => ({
          text: toolResult(
            'email',
            `Hi, following up on yesterday's call. The notes are attached.\n\n${attack}\n\nBest, Marta`,
          ),
          attack: 'indirect_injection',
          channel: 'tool_result',
          label: category,
        })),
      )
    },
  },
]

const only = process.argv[2]?.toLowerCase()
mkdirSync(out, { recursive: true })
for (const source of SOURCES) {
  if (only && !source.name.toLowerCase().includes(only)) continue
  const slug = source.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-$/, '')
  let rows
  try {
    rows = (await source.load()).filter((r) => typeof r.text === 'string' && r.text.trim())
  } catch (err) {
    console.error(`${source.name}: skipped (${err.message})`)
    continue
  }
  const cases = rows.map((row, i) => {
    const benign = row.attack === 'benign'
    return {
      id: `${slug}.${i}`,
      base: `${source.name}:${i}`,
      attack: row.attack,
      channel: row.channel ?? 'user_input',
      obfuscation: 'none',
      input: { kind: 'model_request', toolName: null, text: row.text },
      expected: benign ? 'allow' : 'block',
      control: '',
      label: row.label ?? '',
      language: row.language ?? '',
      source: {
        name: source.name,
        reference: source.url,
        dataset: source.name,
        license: source.license,
      },
      framework: benign
        ? { owasp: '', atlas: '' }
        : {
            owasp: row.attack === 'harmful_request' ? '' : 'LLM01',
            atlas: row.attack === 'jailbreak' ? 'AML.T0054' : 'AML.T0051',
          },
    }
  })
  writeFileSync(join(out, `${slug}.jsonl`), `${cases.map((c) => JSON.stringify(c)).join('\n')}\n`)
  const attacks = cases.filter((c) => c.attack !== 'benign').length
  console.log(
    `${source.name}: ${cases.length} rows (${attacks} attacks, ${cases.length - attacks} benign)`,
  )
}
