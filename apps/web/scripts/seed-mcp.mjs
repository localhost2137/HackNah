import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listMockTools, mockToken, providers } from '../src/mock-mcp/catalog.ts'
import { buildMockRecords } from '../src/mock-mcp/seed-data.ts'

/** SQL for local D1 only. Credentials use exactly the gateway's AES-GCM envelope and AAD. */
export async function seedMockMcp({ cwd, insert, expr, quote, now }) {
  const vars = existsSync(join(cwd, '.dev.vars'))
    ? readFileSync(join(cwd, '.dev.vars'), 'utf8')
    : ''
  const configured =
    process.env.ENCRYPTION_KEY ??
    vars.match(/^\s*ENCRYPTION_KEY\s*=\s*(.+?)\s*$/m)?.[1]?.replace(/^['"]|['"]$/g, '')
  if (!configured || Buffer.from(configured, 'base64url').length !== 32)
    throw new Error(
      'Set a valid ENCRYPTION_KEY in apps/web/.dev.vars before seeding mock MCP credentials',
    )
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.from(configured, 'base64url'),
    'AES-GCM',
    false,
    ['encrypt'],
  )
  const query =
    "SELECT body FROM mock_mcp_record WHERE provider='datadog' AND kind='meta' AND id='environment'"
  const prior = JSON.parse(
    execFileSync(
      'pnpm',
      ['exec', 'wrangler', 'd1', 'execute', 'acl', '--local', '--command', query, '--json'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    ),
  )
  const anchor = prior[0]?.results?.[0]?.body
  const seedTime =
    anchor && !process.argv.includes('--refresh-mocks')
      ? Date.parse(JSON.parse(anchor).dataset_as_of)
      : Math.floor(now / 60_000) * 60_000
  const origin = process.env.MOCK_MCP_ORIGIN ?? 'http://localhost:3000'
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname))
    throw new Error('MOCK_MCP_ORIGIN must be local')
  const mcpPermissions = {}
  for (const provider of providers) {
    const id = `seed-mcp-${provider}`
    const exists = `EXISTS (SELECT 1 FROM mcp_server WHERE id = ${quote(id)})`
    insert('mcp_server', {
      id,
      org_id: 'seed-org',
      slug: provider,
      name: `${provider === 'datadog' ? 'Datadog' : provider === 'jira' ? 'Jira' : 'Confluence'} (mock)`,
      preset: `mock-${provider}`,
      url: `${origin}/mock-mcp/${provider}`,
      auth_type: 'bearer',
      credential_mode: 'org',
      tools: JSON.stringify(listMockTools(provider)),
      tools_refreshed_at: now,
      enabled: 1,
      created_at: now,
    })
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`mcp:${id}:org`) },
      key,
      new TextEncoder().encode(mockToken(provider)),
    )
    insert(
      'mcp_credential',
      {
        id: `${id}-credential`,
        org_id: 'seed-org',
        mcp_server_id: id,
        user_id: expr('NULL'),
        access_token_enc: `v1.${Buffer.from(iv).toString('base64url')}.${Buffer.from(encrypted).toString('base64url')}`,
        account_label: 'Local synthetic service account',
        created_at: now,
        updated_at: now,
      },
      exists,
    )
    const readTools = listMockTools(provider)
      .filter((t) => t.annotations.readOnlyHint)
      .map((t) => t.name)
    insert(
      'resource',
      {
        id: `${id}-read`,
        org_id: 'seed-org',
        name: `${provider} · investigate (mock)`,
        description: 'Synthetic Aurelius Securities data; read-only investigation tools.',
        mcp_server_id: id,
        tool_patterns: JSON.stringify(readTools),
        created_at: now,
      },
      exists,
    )
    mcpPermissions[id] = readTools
    if (provider === 'jira')
      insert(
        'resource',
        {
          id: `${id}-write`,
          org_id: 'seed-org',
          name: 'Jira · write tickets (mock)',
          description:
            'Create local mock issues and comments. Admin-only until explicitly granted.',
          mcp_server_id: id,
          tool_patterns: JSON.stringify(['create_issue', 'add_comment']),
          created_at: now,
        },
        exists,
      )
  }
  insert('group', {
    id: 'seed-mock-investigators',
    org_id: 'seed-org',
    name: 'Demo investigators',
    description: 'Read-only access to the three local mock integrations.',
    is_default: 0,
    permissions: JSON.stringify({ models: [], builtinTools: [], mcp: mcpPermissions }),
    created_at: now,
  })
  for (const userId of ['seed-member', 'seed-sso-member'])
    insert(
      'group_member',
      { group_id: 'seed-mock-investigators', user_id: userId, created_at: now },
      `EXISTS (SELECT 1 FROM user WHERE id=${quote(userId)})`,
    )
  const records = buildMockRecords(seedTime)
  for (const { provider, kind, id, body } of records)
    insert('mock_mcp_record', { provider, kind, id, body: JSON.stringify(body) })
  return { records: records.length, asOf: new Date(seedTime).toISOString() }
}
