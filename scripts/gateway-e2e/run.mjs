#!/usr/bin/env node
// Gateway end-to-end suite: runs the real gateway (vite dev with local D1, Durable Objects and
// queues) against a scripted model server, and checks what Claude Code would see.
//
//   pnpm test:gateway           run, print the results, tear everything down
//   pnpm test:gateway --keep    leave the gateway and the mock running afterwards
//
// It works on a copy of the working tree in the system temp directory, so your own dev server,
// its database and .dev.vars are never touched.
import { execFile, spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { runChecks } from './checks.mjs'
import { DEVICE, FINGERPRINT, fixturesSql, ORG, USER } from './fixtures.mjs'

const run = promisify(execFile)
const keep = process.argv.includes('--keep')
const repo = fileURLToPath(new URL('../..', import.meta.url))
const here = fileURLToPath(new URL('.', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'acl-gateway-e2e-'))
const web = join(work, 'apps/web')
const children = []

/** Terminal colour codes, stripped before matching vite's output. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

const SKIP = new Set([
  'node_modules',
  '.git',
  '.wrangler',
  '.dev.vars',
  'dataset',
  '.turbo',
  'dist',
])

function step(label) {
  process.stdout.write(`• ${label}\n`)
}

function startProcess(cmd, args, opts) {
  const child = spawn(cmd, args, { ...opts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  return child
}

/** Resolves with the first match of `pattern` in the child's output (ANSI codes stripped). */
function waitFor(child, pattern, timeoutMs, log) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}`)), timeoutMs)
    const onLine = (line) => {
      log?.push(line)
      const match = line.replace(ANSI, '').match(pattern)
      if (match) {
        clearTimeout(timer)
        resolve(match)
      }
    }
    createInterface({ input: child.stdout }).on('line', onLine)
    createInterface({ input: child.stderr }).on('line', onLine)
    child.on('exit', (code) =>
      reject(new Error(`${basename(child.spawnfile)} exited with ${code}`)),
    )
  })
}

function teardown() {
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {}
  }
}

async function query(sql) {
  const { stdout } = await run(
    'pnpm',
    ['exec', 'wrangler', 'd1', 'execute', 'acl', '--local', '--json', '--command', sql],
    { cwd: web, maxBuffer: 32 * 1024 * 1024 },
  )
  return JSON.parse(stdout)[0].results
}

function gatewayToken() {
  const vars = Object.fromEntries(
    readFileSync(join(web, '.dev.vars'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  )
  const b64 = (s) => Buffer.from(s).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const claims = {
    sub: USER,
    org: ORG,
    dev: DEVICE,
    fph: createHash('sha256').update(FINGERPRINT).digest('hex'),
    iat: now,
    exp: now + 3600,
  }
  const head = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify(claims))}`
  return `${head}.${createHmac('sha256', vars.JWT_SECRET).update(head).digest('base64url')}`
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
    : null
}

async function main() {
  const started = performance.now()
  step(`copying the working tree to ${work}`)
  cpSync(repo, work, {
    recursive: true,
    filter: (src) => !SKIP.has(basename(src)) || relative(repo, src) === '',
  })

  step('installing dependencies (offline from the pnpm store)')
  await run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], { cwd: work })

  step('creating a local database: secrets, migrations, seed')
  await run('node', ['scripts/init-dev.mjs'], { cwd: web })
  await run('pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'acl', '--local'], {
    cwd: web,
  })
  await run('node', ['scripts/seed.mjs'], { cwd: web })

  step('starting the mock model server')
  const mock = startProcess('node', [join(here, 'mock-upstream.mjs')], { cwd: work })
  const [, mockPort] = await waitFor(mock, /"port":(\d+)/, 10_000)

  // The gateway caches configuration for 10 s, so fixtures go in before it starts.
  step('loading fixtures (models, limits, workflows, device)')
  const fixtures = join(work, 'e2e-fixtures.sql')
  writeFileSync(fixtures, fixturesSql(mockPort))
  await run('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'acl', '--local', '--file', fixtures], {
    cwd: web,
  })

  step('starting the gateway')
  // The dashboard checks the sign-in Origin against PUBLIC_URL, so pin the port up front.
  const port = await freePort()
  appendFileSync(join(web, '.dev.vars'), `\nPUBLIC_URL=http://localhost:${port}\n`)
  const viteLog = []
  const vite = startProcess(
    'pnpm',
    ['exec', 'vite', 'dev', '--port', String(port), '--strictPort'],
    { cwd: web },
  )
  const [, gateway] = await waitFor(vite, /Local:\s+(http:\/\/localhost:\d+)/, 120_000, viteLog)
  // Ready once the gateway answers an unauthenticated request (vite compiles on first hit).
  for (let i = 0; ; i++) {
    const status = await fetch(`${gateway}/v1/messages`, { method: 'POST' })
      .then((r) => r.status)
      .catch(() => 0)
    if (status === 401) break
    if (i > 120) throw new Error(`gateway not ready (last status ${status})`)
    await new Promise((r) => setTimeout(r, 500))
  }
  step(`gateway on ${gateway}, mock model server on http://127.0.0.1:${mockPort}`)

  const { results, events } = await runChecks({
    gateway,
    mock: `http://127.0.0.1:${mockPort}`,
    token: gatewayToken(),
    fingerprint: FINGERPRINT,
    query,
  })

  console.log('')
  console.table(
    results.map((r) => ({
      result: r.ok ? 'PASS' : 'FAIL',
      check: r.name,
      control: r.control,
      ms: r.ms,
    })),
  )
  for (const r of results.filter((x) => !x.ok)) console.log(`FAIL ${r.name}\n     ${r.detail}`)

  // Performance telemetry: time the control layer itself added, per stage.
  const byKind = new Map()
  for (const e of events) {
    if (e.overhead_ms == null) continue
    byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e.overhead_ms])
  }
  console.log('\nControl-layer overhead per stage (ms, from the audit log):')
  console.table(
    [...byKind].map(([kind, ms]) => ({
      stage: kind,
      events: ms.length,
      p50: percentile(ms, 50),
      p95: percentile(ms, 95),
      max: Math.max(...ms),
    })),
  )

  const failed = results.filter((r) => !r.ok).length
  console.log(
    `\n${results.length - failed}/${results.length} passed in ${Math.round((performance.now() - started) / 1000)} s`,
  )
  if (keep) {
    console.log(
      `\nKept running (Ctrl-C to stop):\n  gateway  ${gateway}\n  mock     http://127.0.0.1:${mockPort}\n  copy     ${work}`,
    )
    console.log(`  token    ${gatewayToken()}\n  device   x-acl-device: ${FINGERPRINT}`)
    await new Promise(() => {})
  }
  return failed
}

process.on('SIGINT', () => {
  teardown()
  process.exit(130)
})

main()
  .then((failed) => {
    teardown()
    if (!keep) rmSync(work, { recursive: true, force: true })
    process.exit(failed ? 1 : 0)
  })
  .catch((err) => {
    console.error(`\ngateway e2e failed to run: ${err.stack ?? err}`)
    teardown()
    process.exit(1)
  })

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}
