#!/usr/bin/env node
// Puts the datasets in dataset/ into the gateway's payload bucket, where the dashboard's
// Attack analysis page lists them and the Trained model step learns from them. Also trains the
// two starter models the seeded guardrails use.
//
//   node scripts/datasets-upload.mjs            local bucket (the one `pnpm dev` uses)
//   node scripts/datasets-upload.mjs --remote   the deployed bucket
//
// Run `node dataset/import.mjs` first if dataset/imported/ is empty.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  encodeWeights,
  LEARNED_DIMS,
  selectionModelId,
  trainModel,
} from '../packages/shared/src/learned.ts'
import {
  loadDatasets,
  root,
  starterModelRefs,
  starterModels,
  trainingExamples,
} from './lib/dataset-files.mjs'

const web = join(root, 'apps/web')
const target = process.argv.includes('--remote') ? '--remote' : '--local'
const BUCKET = 'acl-payloads'

const count = (rows, key) => {
  const totals = {}
  for (const row of rows) totals[row[key]] = (totals[row[key]] ?? 0) + 1
  return totals
}

function summarise({ slug, name, rows }) {
  const attacks = rows.filter((r) => r.attack !== 'benign')
  const source = rows[0]?.source ?? {}
  return {
    slug,
    name: name ?? source.dataset ?? source.name ?? slug,
    url: name ? '' : (source.reference ?? ''),
    license: name
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

const tmp = mkdtempSync(join(tmpdir(), 'acl-datasets-'))
const wrangler = (args, stdio) =>
  execFileSync('pnpm', ['exec', 'wrangler', 'r2', 'object', ...args, target], { cwd: web, stdio })
function put(key, content) {
  const file = join(tmp, 'object')
  writeFileSync(file, content)
  wrangler(['put', `${BUCKET}/${key}`, '--file', file], ['ignore', 'ignore', 'inherit'])
}
/** The parsed object, or null when it does not exist yet. */
function get(key) {
  const file = join(tmp, 'existing')
  try {
    wrangler(['get', `${BUCKET}/${key}`, '--file', file], 'ignore')
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

try {
  const data = loadDatasets()
  const index = []
  for (const set of [...data.sets, ...data.derived]) {
    const summary = summarise(set)
    put(`datasets/${set.slug}.jsonl`, `${set.rows.map((r) => JSON.stringify(r)).join('\n')}\n`)
    index.push(summary)
    console.log(`${summary.name}: ${summary.rows} rows`)
  }
  // Datasets added in the dashboard (uploads, Hugging Face) stay listed.
  const custom = (get('datasets/index.json') ?? []).filter(
    (d) => d.custom && !index.some((i) => i.slug === d.slug),
  )
  put('datasets/index.json', JSON.stringify([...index, ...custom]))
  console.log(`${index.length} datasets uploaded (${target.slice(2)})`)

  const refs = starterModelRefs(data.sets, selectionModelId)
  const trained = []
  for (const [key, { name, slugs }] of Object.entries(starterModels)) {
    const ref = refs[key]
    if (!ref) {
      console.log(`${name}: skipped, its datasets are missing (run node dataset/import.mjs)`)
      continue
    }
    const result = await trainModel(trainingExamples(data, slugs))
    const summary = {
      id: ref.id,
      name,
      datasets: ref.datasets,
      trainedAt: new Date().toISOString(),
      attacks: result.attacks,
      benign: result.benign,
      metrics: result.metrics,
    }
    put(
      `models/${ref.id}.json`,
      JSON.stringify({
        ...summary,
        dims: LEARNED_DIMS,
        bias: result.bias,
        weights: encodeWeights(result.weights),
      }),
    )
    trained.push(summary)
    const pct = (share) => `${(share * 100).toFixed(1)}%`
    console.log(
      `${name}: catches ${pct(result.metrics.recall)} of held-out attacks, flags ${pct(result.metrics.falsePositiveRate)} of held-out normal requests`,
    )
  }
  const others = (get('models/index.json') ?? []).filter((m) => !trained.some((t) => t.id === m.id))
  put('models/index.json', JSON.stringify([...trained, ...others].slice(0, 200)))
  if (!existsSync(join(root, 'dataset/imported')))
    console.log('dataset/imported/ is missing: only the built-in cases were uploaded')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
