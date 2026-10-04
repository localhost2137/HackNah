#!/usr/bin/env node
// The executable control suite. Runs every case in dataset/cases.jsonl through the policy
// engine the gateway uses and reports, per control and per channel, what was allowed, blocked
// or redacted.
//
//   node scripts/controls.ts                     balanced preset, built-in signatures
//   node scripts/controls.ts --preset strict     permissive | balanced | strict
//   node scripts/controls.ts --feed feeds/local.json   add a signature feed (file or URL)
//   node scripts/controls.ts --verbose           list every miss, not only required ones
//
// Exit code 1 when a required case fails. A case is required when the gateway inspects its
// channel and the payload is not obfuscated; everything else is reported as coverage.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  baselineSignatures,
  type EvaluationInput,
  evaluateGraph,
  mergeSignatures,
  policyPreset,
  RedactionVault,
  type Signature,
  type Strictness,
  signatureFeed,
} from '../packages/shared/src/index.ts'

type Case = {
  id: string
  base: string
  attack: string
  channel: string
  obfuscation: string
  input: {
    kind: string
    text: string
    toolName: string | null
    toolArguments?: unknown
    deviceStatus?: EvaluationInput['deviceStatus']
  }
  expected: 'allow' | 'block' | 'redact' | 'pending'
  mustHide?: string
  control: string
  hard?: boolean
  source: { name: string; reference: string; dataset?: string; license?: string }
}

/**
 * Where the gateway runs the workflow today: prompts and tool results on their way to the
 * model, tool calls, and messages between agents posted to /v1/acl/inspect. Model responses
 * and tool descriptions pass through uninspected, and the report says so instead of counting
 * them as caught.
 */
const INSPECTED = new Set([
  'user_input',
  'tool_result',
  'tool_arguments',
  'agent_message',
  'identity',
])

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const preset = (arg('preset') ?? 'balanced') as Strictness
const verbose = process.argv.includes('--verbose')

async function readFeed(location: string): Promise<Signature[]> {
  const raw = /^https?:/.test(location)
    ? await (await fetch(location)).json()
    : JSON.parse(readFileSync(join(root, location), 'utf8'))
  return signatureFeed.parse(raw).signatures
}

const feed = arg('feed')
const signatures = mergeSignatures(baselineSignatures, feed ? await readFeed(feed) : [])
const graph = policyPreset(preset)
const readCases = (path: string): Case[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
const own = readCases(join(root, 'dataset/cases.jsonl'))
// Public datasets fetched by dataset/import.mjs. They measure the controls on prompts nobody on
// the team wrote; none of their rows is required to pass.
const importedDir = join(root, 'dataset/imported')
const imported = existsSync(importedDir)
  ? readdirSync(importedDir)
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => readCases(join(importedDir, f)))
  : []
const importedIds = new Set(imported.map((c) => c.id))
const cases = [...own, ...imported]

type Outcome = Case & {
  status: 'pass' | 'fail' | 'not_inspected'
  actual: string
  reason: string
  ms: number
  required: boolean
}

const outcomes: Outcome[] = []
for (const c of cases) {
  const required =
    c.obfuscation === 'none' && INSPECTED.has(c.channel) && !c.hard && !importedIds.has(c.id)
  if (!INSPECTED.has(c.channel)) {
    outcomes.push({ ...c, status: 'not_inspected', actual: '-', reason: '', ms: 0, required })
    continue
  }
  const started = performance.now()
  const result = await evaluateGraph(
    graph,
    {
      kind: c.input.kind as EvaluationInput['kind'],
      text: c.input.text,
      toolName: c.input.toolName,
      toolArguments: c.input.toolArguments,
      deviceStatus: c.input.deviceStatus ?? 'trusted',
    },
    { signatures },
  )
  const ms = performance.now() - started
  let actual: string = result.decision
  if (result.decision === 'allow' && result.redact && c.mustHide) {
    const redacted = new RedactionVault().redact(c.input.text, result.redact).text
    if (!redacted.includes(c.mustHide)) actual = 'redact'
  }
  outcomes.push({
    ...c,
    status: actual === c.expected ? 'pass' : 'fail',
    actual,
    reason: result.reasons.join('; '),
    ms,
    required,
  })
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '-')
const pad = (s: string, n: number) => s.padEnd(n)
const table = (rows: string[][]) => {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)))
  for (const r of rows) console.log(`  ${r.map((cell, i) => pad(cell, widths[i]!)).join('  ')}`)
}
const tally = (list: Outcome[]) => {
  const inspected = list.filter((o) => o.status !== 'not_inspected')
  if (list.length === 0) return ''
  if (inspected.length === 0) return 'not inspected'
  const passed = inspected.filter((o) => o.status === 'pass').length
  return `${passed}/${inspected.length}`
}

const corpus = outcomes.filter((o) => importedIds.has(o.id))
const ours = outcomes.filter((o) => !importedIds.has(o.id))
const attacksOnly = ours.filter((o) => o.attack !== 'benign')
const plain = attacksOnly.filter((o) => o.obfuscation === 'none')
const channels = [...new Set(attacksOnly.map((o) => o.channel))]
const kinds = [...new Set(attacksOnly.map((o) => o.attack))]

console.log(`\nAI Control Layer control suite`)
console.log(
  `  preset ${preset} · ${signatures.length} signatures${feed ? ` (feed ${feed})` : ''} · ${cases.length} cases\n`,
)

const required = outcomes.filter((o) => o.required)
const requiredFailed = required.filter((o) => o.status === 'fail')
console.log(
  `Required controls: ${required.length - requiredFailed.length}/${required.length} passed`,
)
const byControl = new Map<string, Outcome[]>()
for (const o of required.filter((x) => x.control))
  byControl.set(o.control, [...(byControl.get(o.control) ?? []), o])
table([
  ['control', 'blocked or redacted', 'allowed (benign twins)'],
  ...[...byControl].map(([control, list]) => [
    control,
    tally(list.filter((o) => o.expected !== 'allow')),
    tally(list.filter((o) => o.expected === 'allow')) || '-',
  ]),
])

console.log(`\nCoverage by attack and channel (plain payloads, caught/total)`)
table([
  ['', ...channels],
  ...kinds.map((kind) => [
    kind,
    ...channels.map(
      (ch) => tally(plain.filter((o) => o.attack === kind && o.channel === ch)) || '·',
    ),
  ]),
])

console.log(`\nResilience to obfuscation (inspected channels)`)
const obfuscations = [...new Set(attacksOnly.map((o) => o.obfuscation))]
table([
  ['obfuscation', 'caught', 'rate'],
  ...obfuscations.map((ob) => {
    const list = attacksOnly.filter((o) => o.obfuscation === ob && o.status !== 'not_inspected')
    const caught = list.filter((o) => o.status === 'pass').length
    return [ob, `${caught}/${list.length}`, pct(caught, list.length)]
  }),
])

const benign = ours.filter((o) => o.attack === 'benign')
const falsePositives = benign.filter((o) => o.status === 'fail')
const hard = benign.filter((o) => o.hard)
console.log(`\nBenign requests`)
table([
  ['set', 'allowed', 'false positive rate'],
  [
    'everyday',
    tally(benign.filter((o) => !o.hard)),
    pct(falsePositives.filter((o) => !o.hard).length, benign.length - hard.length),
  ],
  ['look like attacks', tally(hard), pct(falsePositives.filter((o) => o.hard).length, hard.length)],
])

if (corpus.length) {
  const rate = (list: Outcome[]) => {
    const attacks = list.filter((o) => o.attack !== 'benign')
    const clean = list.filter((o) => o.attack === 'benign')
    const caught = attacks.filter((o) => o.status === 'pass').length
    const blocked = clean.filter((o) => o.status === 'fail').length
    return [
      attacks.length ? `${caught}/${attacks.length}` : '-',
      attacks.length ? pct(caught, attacks.length) : '-',
      clean.length ? `${blocked}/${clean.length}` : '-',
      clean.length ? pct(blocked, clean.length) : '-',
    ]
  }
  const head = ['attacks caught', 'rate', 'benign blocked', 'false positive rate']
  console.log(`\nPublic datasets (not required; measures detection on prompts we did not write)`)
  const names = [...new Set(corpus.map((o) => o.source.dataset ?? o.source.name))]
  table([
    ['dataset', ...head],
    ...names.map((name) => [
      name,
      ...rate(corpus.filter((o) => (o.source.dataset ?? o.source.name) === name)),
    ]),
    ['all', ...rate(corpus)],
  ])
  console.log(`\nPublic datasets by attack type and channel`)
  const groups = [
    ...new Set(
      corpus.filter((o) => o.attack !== 'benign').map((o) => `${o.attack} · ${o.channel}`),
    ),
  ]
  table([
    ['attack · channel', 'caught', 'rate'],
    ...groups.map((group) => {
      const list = corpus.filter((o) => `${o.attack} · ${o.channel}` === group)
      const caught = list.filter((o) => o.status === 'pass').length
      return [group, `${caught}/${list.length}`, pct(caught, list.length)]
    }),
  ])
}

const timings = outcomes
  .filter((o) => o.status !== 'not_inspected')
  .map((o) => o.ms)
  .sort((a, b) => a - b)
const at = (q: number) => timings[Math.min(timings.length - 1, Math.floor(q * timings.length))]!
console.log(
  `\nPolicy evaluation latency: p50 ${at(0.5).toFixed(2)} ms · p95 ${at(0.95).toFixed(2)} ms · max ${at(1).toFixed(2)} ms`,
)

const listed = verbose ? outcomes.filter((o) => o.status === 'fail') : requiredFailed
if (listed.length) {
  console.log(`\n${verbose ? 'Misses' : 'Required cases that failed'}`)
  for (const o of listed)
    console.log(
      `  ${o.required ? 'FAIL' : 'miss'}  ${o.id}  expected ${o.expected}, got ${o.actual}${o.reason ? `  (${o.reason})` : ''}`,
    )
}

writeFileSync(
  join(root, 'dataset/results.json'),
  `${JSON.stringify(
    {
      preset,
      signatures: signatures.length,
      ranAt: new Date().toISOString(),
      required: { total: required.length, failed: requiredFailed.length },
      latencyMs: { p50: at(0.5), p95: at(0.95), max: at(1) },
      cases: outcomes.map(
        ({
          id,
          attack,
          channel,
          obfuscation,
          expected,
          actual,
          status,
          reason,
          ms,
          required: req,
          source,
        }) => ({
          id,
          attack,
          channel,
          obfuscation,
          expected,
          actual,
          status,
          required: req,
          reason,
          ms: Number(ms.toFixed(3)),
          source,
        }),
      ),
    },
    null,
    2,
  )}\n`,
)
console.log(`\nFull results: dataset/results.json`)
process.exit(requiredFailed.length ? 1 : 0)
