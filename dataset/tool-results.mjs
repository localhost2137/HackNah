#!/usr/bin/env node
// Builds dataset/imported/hacknah-tool-results.jsonl: normal tool results, all benign. Public
// prompt-injection datasets have almost none, so a model trained on them learns that anything
// shaped like a tool result is an attack. These rows are what tools return on an ordinary day:
// records from the mock Datadog, Jira and Confluence servers, and files as the Read tool
// returns them.
//
//   node dataset/tool-results.mjs

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMockRecords } from '../apps/web/src/mock-mcp/seed-data.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const NAME = 'Hack?Nah! tool results'
const rows = []
const add = (base, toolName, text) =>
  rows.push({
    id: `hacknah-tool-results.${rows.length}`,
    base,
    attack: 'benign',
    channel: 'tool_result',
    obfuscation: 'none',
    input: { kind: 'tool_result', toolName, text },
    expected: 'allow',
    control: '',
    label: toolName,
    source: { name: NAME, reference: '', dataset: NAME, license: 'MIT' },
  })

// A fixed clock, so the file is the same on every build.
const records = buildMockRecords(Date.parse('2026-01-15T10:00:00Z'))
for (const record of records)
  add(
    `mock:${record.provider}:${record.kind}:${record.id}`,
    `mcp__${record.provider}__get_${record.kind}`,
    JSON.stringify(record.body, null, 2).slice(0, 3000),
  )
// List calls return several records at once.
const byKind = Object.groupBy(records, (r) => `${r.provider}:${r.kind}`)
for (const [key, group] of Object.entries(byKind))
  for (let i = 0; i + 3 <= group.length && i < 30; i += 3)
    add(
      `mock-list:${key}:${i}`,
      `mcp__${group[0].provider}__list_${group[0].kind}`,
      JSON.stringify({ results: group.slice(i, i + 3).map((r) => r.body) }).slice(0, 3000),
    )

// Source files and docs, in the numbered form the Read tool returns. Files that quote attacks on
// purpose (signatures, datasets, tests, fixtures) are left out: they are not normal content.
const QUOTES_ATTACKS =
  /signature|attack|dataset|\.test\.|catalog|redact|keyword|seed|mock|preset|recommended|README|feeds\//i
const files = execFileSync(
  'git',
  ['ls-files', 'apps/web/src', 'packages/ui/src', 'packages/db/src', 'packages/shared/src'],
  { cwd: root, encoding: 'utf8' },
)
  .split('\n')
  .filter((f) => /\.(ts|tsx|css|sql)$/.test(f) && !QUOTES_ATTACKS.test(f))
  .sort()
for (const file of files) {
  const lines = readFileSync(join(root, file), 'utf8').split('\n')
  for (const start of [0, 60]) {
    const chunk = lines.slice(start, start + 40)
    if (chunk.join('').trim().length < 200) continue
    add(
      `file:${file}:${start}`,
      'Read',
      chunk
        .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`)
        .join('\n')
        .slice(0, 3000),
    )
  }
}

writeFileSync(
  join(root, 'dataset/imported/hacknah-tool-results.jsonl'),
  `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
)
console.log(
  `${rows.length} normal tool results (${records.length} mock records, ${files.length} files)`,
)
