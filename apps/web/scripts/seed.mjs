import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashPassword } from 'better-auth/crypto'

// Development fixtures only. Always targets Wrangler's local D1 database.
const cwd = fileURLToPath(new URL('..', import.meta.url))
const password = 'LocalDemo123!'
const now = Date.now()
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
const sql = []
function insert(table, row) {
  sql.push(
    `INSERT INTO "${table}" (${Object.keys(row)
      .map((key) => `"${key}"`)
      .join(',')}) SELECT ${Object.values(row)
      .map((value) =>
        value === 'seed-org' ? '(SELECT id FROM organization LIMIT 1)' : quote(value),
      )
      .join(
        ',',
      )} WHERE ${table === 'member' ? `NOT EXISTS (SELECT 1 FROM member WHERE user_id = ${quote(row.user_id)} AND organization_id = (SELECT id FROM organization LIMIT 1))` : '1'} ON CONFLICT DO NOTHING;`,
  )
}

for (const role of ['admin', 'member']) {
  const id = `seed-${role}`
  insert('user', {
    id,
    name: `Demo ${role}`,
    email: `${role}@demo.test`,
    email_verified: 1,
    created_at: now,
    updated_at: now,
  })
  insert('account', {
    id: `${id}-account`,
    account_id: id,
    provider_id: 'credential',
    user_id: id,
    password: await hashPassword(password),
    created_at: now,
    updated_at: now,
  })
  insert('member', {
    id: `${id}-membership`,
    organization_id: 'seed-org',
    user_id: id,
    role,
    created_at: now,
  })
}

for (let i = 0; i < 48; i++) {
  const blocked = i % 7 === 0
  insert('event', {
    id: `seed-event-${i}`,
    org_id: 'seed-org',
    user_id: 'seed-member',
    kind: i % 2 ? 'tool_call' : 'model_request',
    ...(i % 2 ? { tool_name: 'Bash' } : { model: 'anthropic/claude-sonnet-4' }),
    resource_ids: '[]',
    decision: blocked ? 'block' : 'allow',
    checks: JSON.stringify([
      {
        stepId: 'keywords',
        type: 'keywords',
        outcome: blocked ? 'fail' : 'pass',
        ...(blocked ? { action: 'block', reason: 'Demo dangerous keyword match' } : {}),
        durationMs: 1,
      },
    ]),
    risk_score: blocked ? 0.9 : 0,
    latency_ms: blocked ? 15 : 450 + i * 20,
    ...(!blocked && i % 2 === 0 ? { input_tokens: 1000 + i * 10, output_tokens: 250 } : {}),
    created_at: now - i * 30 * 60 * 1000,
  })
}

const temporary = mkdtempSync(join(tmpdir(), 'acl-seed-'))
try {
  const file = join(temporary, 'seed.sql')
  writeFileSync(file, sql.join('\n'))
  execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'acl', '--local', '--file', file], {
    cwd,
    stdio: 'inherit',
  })
  console.log(
    `Local demo accounts: admin@demo.test, member@demo.test\nPassword: ${password}\nExisting fixtures are preserved on subsequent runs.`,
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
