#!/usr/bin/env node
// Benchmarks the non-deterministic path: the prompt-injection classifier (services/classifier,
// Llama Prompt Guard 2) that the Judge model block calls. The Attack analysis replay does not
// call judges, so this measures them on the same held-out rows instead.
//
//   node services/classifier/server.mjs --port 3401 &
//   node 2-architecture/benchmarks/judge-bench.mjs --url http://127.0.0.1:3401 --set mixed-500
//
// One request at a time, as the gateway sends them, so the latency is what a request waits for.

import { writeFileSync } from 'node:fs'
import { loadDatasets } from '../../scripts/lib/dataset-files.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const URL_ = arg('url', 'http://127.0.0.1:3333')
const SET = arg('set', 'mixed-500')
const OUT = arg('out')
const THRESHOLDS = [0.5, 0.7, 0.9]

const { derived } = loadDatasets()
const set = derived.find((d) => d.slug === SET)
if (!set) throw new Error(`no derived set ${SET}: ${derived.map((d) => d.slug).join(', ')}`)
const rows = set.rows.filter((r) => typeof r.input?.text === 'string')

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

const results = []
for (const row of rows) {
  const t0 = performance.now()
  const res = await fetch(`${URL_}/classify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: row.input.text }),
  })
  const json = await res.json()
  results.push({
    id: row.id,
    attack: row.attack,
    channel: row.channel,
    score: json.score,
    ms: performance.now() - t0,
    tokens: json.tokens,
  })
}

const ms = results.map((r) => r.ms)
const attacks = results.filter((r) => r.attack !== 'benign')
const benign = results.filter((r) => r.attack === 'benign')
const summary = {
  set: set.name,
  rows: results.length,
  attacks: attacks.length,
  benign: benign.length,
  latencyMs: {
    p50: +pct(ms, 50).toFixed(1),
    p95: +pct(ms, 95).toFixed(1),
    p99: +pct(ms, 99).toFixed(1),
    max: +Math.max(...ms).toFixed(1),
    mean: +(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(1),
  },
  thresholds: THRESHOLDS.map((t) => ({
    threshold: t,
    attacksCaught: attacks.filter((r) => r.score >= t).length,
    benignBlocked: benign.filter((r) => r.score >= t).length,
  })),
  byAttack: Object.fromEntries(
    [...new Set(attacks.map((r) => r.attack))].map((a) => {
      const g = attacks.filter((r) => r.attack === a)
      return [a, `${g.filter((r) => r.score >= 0.7).length}/${g.length}`]
    }),
  ),
}

console.log(JSON.stringify(summary, null, 2))
if (OUT) writeFileSync(OUT, JSON.stringify({ summary, results }, null, 2))
