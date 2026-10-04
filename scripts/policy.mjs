#!/usr/bin/env node
// Export or apply the Hack?Nah! policy file (workflows, limits, model catalog) against a
// running instance, through its /api/policy endpoint.
//
//   pnpm policy:export [file]                         write the current policy (stdout without a file)
//   pnpm policy:apply <file> [--merge] [--dry-run]    preview, then apply
//
// Connection, from the environment:
//   ACL_URL       instance URL (default http://localhost:3000)
//   ACL_EMAIL     admin email and ACL_PASSWORD, to sign in with a password (local: admin@demo.test)
//   ACL_COOKIE    or a session cookie copied from the browser, for admins who only use SSO
//
// Replace mode (the default) disables workflows, limits and models the file leaves out; --merge
// only adds and updates. Nothing is deleted either way.

import { readFileSync, writeFileSync } from 'node:fs'

const [command, ...rest] = process.argv.slice(2)
const flags = new Set(rest.filter((a) => a.startsWith('--')))
const [file] = rest.filter((a) => !a.startsWith('--'))
const base = (process.env.ACL_URL ?? 'http://localhost:3000').replace(/\/$/, '')

function fail(message) {
  console.error(`policy: ${message}`)
  process.exit(1)
}

async function sessionCookie() {
  if (process.env.ACL_COOKIE) return process.env.ACL_COOKIE
  const email = process.env.ACL_EMAIL
  const password = process.env.ACL_PASSWORD
  if (!email || !password)
    fail('set ACL_EMAIL and ACL_PASSWORD (an admin account), or ACL_COOKIE with a session cookie')
  const res = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email, password }),
  }).catch((err) => fail(`cannot reach ${base}: ${err.message}`))
  if (!res.ok) fail(`sign-in failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0])
  if (!cookies.length) fail('sign-in returned no session cookie')
  return cookies.join('; ')
}

async function call(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...init.headers, cookie: await sessionCookie(), origin: base },
  }).catch((err) => fail(`cannot reach ${base}: ${err.message}`))
  if (res.status === 403) fail('this account is not an admin of the instance')
  return res
}

const symbols = { create: '+', update: '~', disable: '-', unchanged: ' ' }

function printChanges(changes) {
  const pending = changes.filter((c) => c.action !== 'unchanged')
  for (const c of pending)
    console.log(
      `  ${symbols[c.action]} ${c.action.padEnd(7)} ${c.kind.padEnd(8)} ${c.name}${c.fields?.length ? `  (${c.fields.join(', ')})` : ''}`,
    )
  const unchanged = changes.length - pending.length
  console.log(
    pending.length
      ? `${pending.length} change(s), ${unchanged} unchanged`
      : `No changes: the instance already matches (${unchanged} unchanged)`,
  )
  return pending.length
}

if (command === 'export') {
  const res = await call('/api/policy')
  if (!res.ok) fail(`export failed (${res.status}): ${await res.text()}`)
  const yaml = await res.text()
  if (file) {
    writeFileSync(file, yaml)
    console.error(`policy: wrote ${file}`)
  } else process.stdout.write(yaml)
} else if (command === 'apply') {
  if (!file) fail('usage: pnpm policy:apply <file> [--merge] [--dry-run]')
  let yaml
  try {
    yaml = readFileSync(file, 'utf8')
  } catch (err) {
    fail(`cannot read ${file}: ${err.message}`)
  }
  const mode = flags.has('--merge') ? 'merge' : 'replace'
  const post = async (dryRun) => {
    const res = await call(`/api/policy?mode=${mode}&dryRun=${dryRun ? 1 : 0}`, {
      method: 'POST',
      headers: { 'content-type': 'application/yaml' },
      body: yaml,
    })
    const result = await res.json().catch(() => fail(`unexpected response (${res.status})`))
    if (!result.ok) {
      console.error(`policy: ${file} has errors, nothing was changed:`)
      for (const e of result.errors) console.error(`  ${e}`)
      process.exit(1)
    }
    return result
  }
  console.log(`${file} → ${base} (${mode})`)
  const preview = await post(true)
  const pending = printChanges(preview.changes)
  if (flags.has('--dry-run') || pending === 0) process.exit(0)
  await post(false)
  console.log('Applied. The gateway uses the new policy within about 10 seconds.')
} else {
  fail('usage: pnpm policy:export [file] | pnpm policy:apply <file> [--merge] [--dry-run]')
}
