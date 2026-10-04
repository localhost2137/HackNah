#!/usr/bin/env node
// A stand-in for the externally managed system that feeds attack signatures to the gateway.
//
//   node scripts/signature-feeder.mjs              serve feeds/local.json on :9500
//   node scripts/signature-feeder.mjs --osv        also pull malicious packages from OSV first
//
// The gateway reads http://localhost:9500/feed.json (SIGNATURE_FEED_URL) every 30 seconds.
// Edit feeds/local.json while this runs: the next read serves the new signatures.
// Requires no dependencies. OSV data: https://osv.dev (malicious packages have MAL- ids,
// from the OpenSSF malicious-packages project, Apache-2.0).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'feeds')
const localPath = join(root, 'local.json')
const osvPath = join(root, 'osv.json')
const port = 9500

// Packages worth asking OSV about: AI and MCP tooling an agent is likely to be told to install.
const WATCHLIST = {
  PyPI: ['torchtriton', 'ultralytics', 'langchain', 'transformers', 'litellm', 'mcp', 'ollama'],
  npm: ['postmark-mcp', 'mcp-remote', '@modelcontextprotocol/sdk', 'nx', 'cline'],
}

const read = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null)

async function pullOsv() {
  const queries = Object.entries(WATCHLIST).flatMap(([ecosystem, names]) =>
    names.map((name) => ({ package: { ecosystem, name } })),
  )
  const res = await fetch('https://api.osv.dev/v1/querybatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ queries }),
  })
  if (!res.ok) throw new Error(`OSV answered ${res.status}`)
  const { results } = await res.json()
  const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const signatures = []
  for (const [i, result] of results.entries()) {
    const { ecosystem, name } = queries[i].package
    // MAL- records mean malicious code was published; other ids are ordinary vulnerabilities.
    const ids = (result.vulns ?? []).map((v) => v.id).filter((id) => id.startsWith('MAL-'))
    if (ids.length === 0) continue
    const records = await Promise.all(
      ids
        .slice(0, 20)
        .map((id) => fetch(`https://api.osv.dev/v1/vulns/${id}`).then((r) => r.json())),
    )
    const affected = records
      .flatMap((r) => r.affected ?? [])
      .filter((a) => a.package?.name === name)
    // A record without a version list covers the whole package (a typosquat or a backdoor
    // project); one with versions is a hijacked release of an otherwise legitimate package.
    const versions = [...new Set(affected.flatMap((a) => a.versions ?? []))].slice(0, 300)
    const whole = affected.some((a) => !a.versions?.length)
    signatures.push({
      id: `osv-${ecosystem.toLowerCase()}-${name}`,
      title:
        whole || versions.length === 0
          ? `Malicious ${ecosystem} package ${name}`
          : `Compromised ${ecosystem} release of ${name} (${versions.slice(0, 4).join(', ')}${versions.length > 4 ? ', …' : ''})`,
      ...(whole || versions.length === 0
        ? { type: 'package', pattern: name }
        : {
            type: 'regex',
            pattern: `(?<![\\w./-])${escapeRegExp(name)}(?:==|@)(?:${versions.map(escapeRegExp).join('|')})(?![\\w.])`,
          }),
      category: 'supply_chain',
      severity: 'critical',
      source: 'OSV / OpenSSF malicious-packages',
      reference: `https://osv.dev/vulnerability/${ids[0]}`,
    })
  }
  writeFileSync(
    osvPath,
    `${JSON.stringify({ version: new Date().toISOString(), signatures }, null, 2)}\n`,
  )
  return signatures.length
}

mkdirSync(root, { recursive: true })
if (!existsSync(localPath)) {
  writeFileSync(
    localPath,
    `${JSON.stringify(
      {
        version: '1',
        signatures: [
          {
            id: 'local-example-internal-registry-bypass',
            title: 'Install from outside the internal package registry',
            type: 'regex',
            pattern: '--(?:extra-)?index-url\\s+https?://(?!pypi\\.company\\.example)',
            category: 'supply_chain',
            severity: 'high',
            source: 'Security team',
            reference: '',
          },
        ],
      },
      null,
      2,
    )}\n`,
  )
}

if (process.argv.includes('--osv')) {
  try {
    console.log(`OSV: ${await pullOsv()} malicious packages on the watchlist`)
  } catch (err) {
    console.error(`OSV pull failed, serving what is on disk: ${err.message}`)
  }
}

createServer((req, res) => {
  if (req.url?.split('?')[0] !== '/feed.json') {
    res.writeHead(404).end()
    return
  }
  try {
    const feeds = [read(localPath), read(osvPath)].filter(Boolean)
    const body = {
      version: feeds.map((f) => f.version).join('+'),
      signatures: feeds.flatMap((f) => f.signatures ?? []),
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  } catch (err) {
    // A half-saved file must not take the feed down; the gateway keeps its last good copy.
    res
      .writeHead(500, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: err.message }))
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Signature feed on http://localhost:${port}/feed.json (edit feeds/local.json)`)
})
