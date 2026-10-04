#!/usr/bin/env node
// Puts the datasets in dataset/ into the gateway's payload bucket, where the dashboard's
// Datasets page lists them and trains models on them.
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
    license: fallbackName ? 'MIT' : (source.license ?? ''),
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
console.log(`${index.length} datasets uploaded (${target.slice(2)})`)
