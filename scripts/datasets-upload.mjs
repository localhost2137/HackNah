#!/usr/bin/env node
// Puts the datasets in dataset/ into the gateway's payload bucket, where the dashboard's
// Attack analysis page lists them and the Trained model step learns from them.
//
//   node scripts/datasets-upload.mjs            local bucket (the one `pnpm dev` uses)
//   node scripts/datasets-upload.mjs --remote   the deployed bucket
//
// Run `node dataset/import.mjs` first if dataset/imported/ is empty.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const web = join(root, 'apps/web')
const target = process.argv.includes('--remote') ? '--remote' : '--local'
const BUCKET = 'acl-payloads'

const slugOf = (name) => name.replace(/\.jsonl$/, '')
const count = (rows, key) => {
  const totals = {}
  for (const row of rows) totals[row[key]] = (totals[row[key]] ?? 0) + 1
  return totals
}

function summarise(slug, file, fallbackName) {
  const rows = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const attacks = rows.filter((r) => r.attack !== 'benign')
  const source = rows[0]?.source ?? {}
  return {
    slug,
    name: fallbackName ?? source.dataset ?? source.name ?? slug,
    url: fallbackName ? '' : (source.reference ?? ''),
    license: fallbackName
      ? slug === 'acl-control-cases'
        ? 'MIT'
        : 'mixed, see sources'
      : (source.license ?? ''),
    rows: rows.length,
    attacks: attacks.length,
    benign: rows.length - attacks.length,
    byAttack: count(attacks, 'attack'),
    byChannel: count(rows, 'channel'),
    custom: false,
  }
}

const put = (key, file) =>
  execFileSync(
    'pnpm',
    ['exec', 'wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`, '--file', file, target],
    { cwd: web, stdio: ['ignore', 'ignore', 'inherit'] },
  )

const files = [
  {
    slug: 'acl-control-cases',
    file: join(root, 'dataset/cases.jsonl'),
    name: 'Hack?Nah! cases',
  },
]
const imported = join(root, 'dataset/imported')
if (existsSync(imported))
  for (const name of readdirSync(imported).filter((f) => f.endsWith('.jsonl')))
    files.push({ slug: slugOf(name), file: join(imported, name) })

// --- Derived datasets, built from the ones above so they need no data of their own.
const readJsonl = (file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
/** Channels a workflow runs on; plain payloads only, so a miss is a real miss. */
const REPLAYABLE = new Set([
  'user_input',
  'tool_arguments',
  'tool_result',
  'model_output',
  'agent_message',
])
const everything = files
  .filter((f) => existsSync(f.file))
  .flatMap((f) => readJsonl(f.file))
  .filter((c) => REPLAYABLE.has(c.channel) && (c.obfuscation ?? 'none') === 'none')
  // Requests for harmful content are content moderation, not an attack on the agent.
  .filter(
    (c) => c.attack !== 'harmful_request' && c.expected !== 'redact' && c.expected !== 'pending',
  )

/** Evenly spaced picks, so the same input always gives the same sample. */
const spread = (rows, n) => {
  if (rows.length <= n) return rows
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

const benignRows = everything.filter((c) => c.attack === 'benign')
const attackRows = everything.filter((c) => c.attack !== 'benign')
const tmpDerived = mkdtempSync(join(tmpdir(), 'acl-derived-'))
const derive = (slug, name, rows) => {
  const file = join(tmpDerived, `${slug}.jsonl`)
  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`)
  files.push({ slug, file, name })
}

// Normal traffic only: every row should pass, so anything blocked is a false positive.
derive(
  'normal-requests',
  'Normal requests',
  roundRobin(
    groupBy(benignRows, (c) => c.source?.dataset ?? c.source?.name).map((g) => spread(g, 400)),
    1500,
  ),
)

// Half attacks of every kind, half normal requests: a quick check to rerun after a rule change.
for (const size of [200, 500, 1000]) {
  const half = size / 2
  const attacks = roundRobin(
    groupBy(attackRows, (c) => c.attack).map((g) =>
      roundRobin(
        groupBy(g, (c) => c.source?.dataset ?? c.source?.name).map((d) => spread(d, half)),
        half,
      ),
    ),
    half,
  )
  const benign = roundRobin(
    groupBy(benignRows, (c) => c.source?.dataset ?? c.source?.name).map((g) => spread(g, half)),
    half,
  )
  derive(`mixed-${size}`, `Mixed check · ${size}`, [...attacks, ...benign])
}

const index = []
for (const { slug, file, name } of files) {
  if (!existsSync(file)) continue
  const summary = summarise(slug, file, name)
  put(`datasets/${slug}.jsonl`, file)
  index.push(summary)
  console.log(`${summary.name}: ${summary.rows} rows`)
}

const tmp = mkdtempSync(join(tmpdir(), 'acl-datasets-'))
try {
  const indexFile = join(tmp, 'index.json')
  writeFileSync(indexFile, JSON.stringify(index))
  put('datasets/index.json', indexFile)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
rmSync(tmpDerived, { recursive: true, force: true })
console.log(`${index.length} datasets uploaded (${target.slice(2)})`)
