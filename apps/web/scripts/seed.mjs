import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashPassword } from 'better-auth/crypto'
import { mockClient, mockIssuer, mockSsoDomain, seededSsoUsers, subjectFor } from './mock-sso.mjs'
import { seedMockMcp } from './seed-mcp.mjs'

// Development fixtures only. Always targets Wrangler's local D1 database.
const cwd = fileURLToPath(new URL('..', import.meta.url))
const password = 'LocalDemo123!'
const now = Date.now()
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
/** A SQL expression to insert as-is instead of a quoted value. */
const expr = (sql) => ({ sql })
const ssoProviderId = expr(`'sso-' || (SELECT slug FROM organization LIMIT 1)`)
const sql = []
function insert(table, row, where = '1') {
  sql.push(
    `INSERT INTO "${table}" (${Object.keys(row)
      .map((key) => `"${key}"`)
      .join(',')}) SELECT ${Object.values(row)
      .map(
        (value) =>
          value?.sql ??
          (value === 'seed-org' ? '(SELECT id FROM organization LIMIT 1)' : quote(value)),
      )
      .join(
        ',',
      )} WHERE ${where}${table === 'member' ? ` AND NOT EXISTS (SELECT 1 FROM member WHERE user_id = ${quote(row.user_id)} AND organization_id = (SELECT id FROM organization LIMIT 1))` : ''} ON CONFLICT ${table === 'mock_mcp_record' && process.argv.includes('--refresh-mocks') ? 'DO UPDATE SET body = excluded.body' : 'DO NOTHING'};`,
  )
}
const userExists = (id) => `EXISTS (SELECT 1 FROM user WHERE id = ${quote(id)})`

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

// The mock identity provider from `pnpm mock:idp`, registered the way Settings would after discovery.
insert('sso_provider', {
  id: 'seed-mock-sso',
  provider_id: ssoProviderId,
  issuer: mockIssuer,
  domain: mockSsoDomain,
  organization_id: 'seed-org',
  oidc_config: JSON.stringify({
    issuer: mockIssuer,
    clientId: mockClient.id,
    clientSecret: mockClient.secret,
    authorizationEndpoint: `${mockIssuer}/authorize`,
    tokenEndpoint: `${mockIssuer}/token`,
    tokenEndpointAuthentication: 'client_secret_basic',
    jwksEndpoint: `${mockIssuer}/jwks`,
    pkce: true,
    discoveryEndpoint: `${mockIssuer}/.well-known/openid-configuration`,
    scopes: ['openid', 'email', 'profile'],
    userInfoEndpoint: `${mockIssuer}/userinfo`,
    overrideUserInfo: false,
  }),
})

for (const { email, name, role } of seededSsoUsers) {
  const id = `seed-sso-${role}`
  insert('user', { id, name, email, email_verified: 1, created_at: now, updated_at: now })
  insert(
    'account',
    {
      id: `${id}-account`,
      account_id: subjectFor(email),
      provider_id: ssoProviderId,
      user_id: id,
      created_at: now,
      updated_at: now,
    },
    userExists(id),
  )
  insert(
    'member',
    { id: `${id}-membership`, organization_id: 'seed-org', user_id: id, role, created_at: now },
    userExists(id),
  )
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

const mockSummary = await seedMockMcp({ cwd, insert, expr, quote, now })

const temporary = mkdtempSync(join(tmpdir(), 'acl-seed-'))
try {
  const file = join(temporary, 'seed.sql')
  writeFileSync(file, sql.join('\n'))
  execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'acl', '--local', '--file', file], {
    cwd,
    stdio: 'inherit',
  })
  console.log(
    `Local demo accounts: admin@demo.test, member@demo.test\nPassword: ${password}\nMock SSO accounts (pnpm mock:idp): ${seededSsoUsers.map((u) => u.email).join(', ')}\nMock MCPs: Datadog, Confluence, Jira (${mockSummary.records} records, dataset clock ${mockSummary.asOf}).\nExisting fixtures are preserved on subsequent runs.`,
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
