// The datasets shipped in dataset/, the sets derived from them, and the starter models trained on
// them. Shared by the upload script and the seed, so both agree on slugs, rows and model ids.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

export const readJsonl = (file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))

const sourceOf = (c) => c.source?.dataset ?? c.source?.name

/** Channels a guardrail runs on; plain payloads only, so a miss is a real miss. */
const REPLAYABLE = new Set([
  'user_input',
  'tool_arguments',
  'tool_result',
  'model_output',
  'agent_message',
])

/**
 * Evenly spaced picks, so the same input always gives the same sample. Never more than a quarter
 * of the rows: the starter models train on what the derived sets leave, and a small source taken
 * whole would leave them nothing of its kind.
 */
const spread = (rows, max) => {
  const n = Math.min(max, Math.ceil(rows.length / 4))
  const step = rows.length / n
  return Array.from({ length: n }, (_, i) => rows[Math.floor(i * step)])
}
/** `n` rows taken in turn from each group, so no single source dominates. */
function roundRobin(groups, n) {
  const queues = groups.map((g) => [...g])
  const out = []
  while (out.length < n && queues.some((q) => q.length)) {
    for (const q of queues) {
      if (out.length >= n) break
      const next = q.shift()
      if (next) out.push(next)
    }
  }
  return out
}
const groupBy = (rows, key) => Object.values(Object.groupBy(rows, key))

/**
 * Every dataset as `{slug, name?, rows}`: the repository's own cases, the imported public
 * datasets, then the derived sets, which are built from the others and need no data of their own.
 */
export function loadDatasets() {
  const sets = [
    {
      slug: 'acl-control-cases',
      name: 'Hack?Nah! cases',
      rows: readJsonl(join(root, 'dataset/cases.jsonl')),
    },
  ]
  const imported = join(root, 'dataset/imported')
  if (existsSync(imported))
    for (const file of readdirSync(imported).filter((f) => f.endsWith('.jsonl')))
      sets.push({ slug: file.replace(/\.jsonl$/, ''), rows: readJsonl(join(imported, file)) })

  const everything = sets
    .flatMap((s) => s.rows)
    .filter((c) => REPLAYABLE.has(c.channel) && (c.obfuscation ?? 'none') === 'none')
    // Requests for harmful content are content moderation, not an attack on the agent.
    .filter(
      (c) => c.attack !== 'harmful_request' && c.expected !== 'redact' && c.expected !== 'pending',
    )
  const benignRows = everything.filter((c) => c.attack === 'benign')
  const attackRows = everything.filter((c) => c.attack !== 'benign')
  const derived = []

  // Normal traffic only: every row should pass, so anything blocked is a false positive.
  derived.push({
    slug: 'normal-requests',
    name: 'Normal requests',
    rows: roundRobin(
      groupBy(benignRows, sourceOf).map((g) => spread(g, 400)),
      1500,
    ),
  })
  // Half attacks of every kind, half normal requests: a quick check to rerun after a rule change.
  for (const size of [200, 500, 1000]) {
    const half = size / 2
    const attacks = roundRobin(
      groupBy(attackRows, (c) => c.attack).map((g) =>
        roundRobin(
          groupBy(g, sourceOf).map((d) => spread(d, half)),
          half,
        ),
      ),
      half,
    )
    const benign = roundRobin(
      groupBy(benignRows, sourceOf).map((g) => spread(g, half)),
      half,
    )
    derived.push({
      slug: `mixed-${size}`,
      name: `Mixed check · ${size}`,
      rows: [...attacks, ...benign],
    })
  }
  return { sets, derived }
}

/** The datasets each starter model learns from. The seeded guardrails use these two models. */
export const starterModels = {
  prompts: {
    name: 'Prompt injections and jailbreaks',
    slugs: [
      'deepset-prompt-injections',
      'jackhhao-jailbreak-classification',
      'lakera-gandalf-ignore-instructions',
      'meta-llama-purplellama-cyberseceval-prompt-injection',
      'rubend18-chatgpt-jailbreak-prompts',
      'trustairlab-in-the-wild-jailbreak-prompts',
      'xtram1-safe-guard-prompt-injection',
      'yanismiraoui-prompt-injections',
    ],
  },
  indirect: {
    name: 'Instructions hidden in tool results',
    slugs: ['lakera-gandalf-summarization', 'microsoft-bipia', 'uiuc-kang-lab-injecagent'],
  },
}

/**
 * The starter models as Trained model blocks refer to them, or null for one whose datasets are
 * missing. The id is the one the editor computes for the same selection, so it shows as trained.
 */
export function starterModelRefs(sets, selectionModelId) {
  return Object.fromEntries(
    Object.entries(starterModels).map(([key, { slugs }]) => {
      const selected = sets.filter((s) => slugs.includes(s.slug))
      return [
        key,
        selected.length === slugs.length
          ? {
              id: selectionModelId(selected.map((s) => ({ slug: s.slug, rows: s.rows.length }))),
              datasets: selected.map((s) => s.slug),
            }
          : null,
      ]
    }),
  )
}

/**
 * The rows a starter model trains on: its datasets plus benign rows from all the others, minus
 * every row a derived set uses. The mixed checks and Normal requests therefore measure the models
 * on requests they have never seen.
 */
export function trainingExamples({ sets, derived }, slugs) {
  const heldOut = new Set(derived.flatMap((d) => d.rows.map((r) => r.id)))
  const usable = (r) =>
    !heldOut.has(r.id) && r.attack !== 'harmful_request' && typeof r.input?.text === 'string'
  const own = sets.filter((s) => slugs.includes(s.slug)).flatMap((s) => s.rows)
  const others = sets
    .filter((s) => !slugs.includes(s.slug))
    .flatMap((s) => s.rows)
    .filter((r) => r.attack === 'benign')
  return [...own, ...others]
    .filter(usable)
    .map((r) => ({ text: r.input.text, attack: r.attack !== 'benign' }))
}
