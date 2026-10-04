import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashPassword } from 'better-auth/crypto'
import {
  policyGraph,
  recommendedGuardrails,
  selectionModelId,
} from '../../../packages/shared/src/index.ts'
import { loadDatasets, root, starterModelRefs } from '../../../scripts/lib/dataset-files.mjs'
import { mockClient, mockIssuer, mockSsoDomain, seededSsoUsers, subjectFor } from './mock-sso.mjs'
import { seedMockMcp } from './seed-mcp.mjs'
import { seedTraffic } from './seed-traffic.mjs'

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

// The recommended guardrails, published. The Default one they replace is switched off the first
// time only; `--reset-guardrails` publishes the current graphs as a new version.
const skipGuardrails = process.argv.includes('--skip-guardrails')
const data = skipGuardrails ? null : loadDatasets()
const modelRefs = data ? starterModelRefs(data.sets, selectionModelId) : {}
const guardrails = data ? recommendedGuardrails(modelRefs) : []
const resetGuardrails = process.argv.includes('--reset-guardrails')
if (guardrails.length)
  sql.push(
    `UPDATE guardrail SET enabled = 0 WHERE id = 'wf_default' AND NOT EXISTS (SELECT 1 FROM guardrail WHERE id = ${quote(guardrails[0].id)});`,
  )
guardrails.forEach(({ id, name, description, graph }, i) => {
  const fresh = `NOT EXISTS (SELECT 1 FROM guardrail_version WHERE guardrail_id = ${quote(id)})`
  insert('guardrail', {
    id,
    org_id: 'seed-org',
    name,
    description,
    enabled: 1,
    position: i + 1,
    group_ids: '[]',
    created_at: now,
    updated_at: now,
  })
  insert(
    'guardrail_version',
    {
      id: resetGuardrails ? `${id}-${now}` : `${id}-v1`,
      org_id: 'seed-org',
      guardrail_id: id,
      version: expr(
        `(SELECT COALESCE(MAX(version), 0) + 1 FROM guardrail_version WHERE guardrail_id = ${quote(id)})`,
      ),
      definition: JSON.stringify(policyGraph.parse(graph)),
      status: 'published',
      note: 'Recommended guardrail',
      created_by: 'seed-admin',
      created_at: now,
    },
    resetGuardrails ? '1' : fresh,
  )
})

// A month of sessions, decided by the guardrails above.
const traffic = data
  ? await seedTraffic({ insert, sql, now, guardrails, modelRefs, data })
  : { events: 0, blocked: 0, sessions: 0 }

const mockSummary = await seedMockMcp({ cwd, insert, expr, quote, now })

const temporary = mkdtempSync(join(tmpdir(), 'acl-seed-'))
try {
  const file = join(temporary, 'seed.sql')
  writeFileSync(file, sql.join('\n'))
  execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'acl', '--local', '--file', file], {
    cwd,
    stdio: 'inherit',
  })
  // Datasets for Attack analysis and the two models the guardrails above use.
  if (!process.argv.includes('--skip-datasets'))
    execFileSync('node', ['scripts/datasets-upload.mjs'], { cwd: root, stdio: 'inherit' })
  console.log(
    `Local demo accounts: admin@demo.test, member@demo.test\nPassword: ${password}\nMock SSO accounts (pnpm mock:idp): ${seededSsoUsers.map((u) => u.email).join(', ')}\nMock MCPs: Datadog, Confluence, Jira (${mockSummary.records} records, dataset clock ${mockSummary.asOf}).${traffic.events ? `\nTraffic: ${traffic.events} events in ${traffic.sessions} sessions over the last 30 days, ${traffic.blocked} blocked.` : ''}${guardrails.length ? `\nGuardrails: ${guardrails.map((g) => g.name).join(', ')}.` : ''}\nExisting fixtures are preserved on subsequent runs.`,
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
