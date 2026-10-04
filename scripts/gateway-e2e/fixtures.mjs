// Fixtures for the gateway end-to-end suite, on top of `pnpm db:seed`. Every check uses its own
// model id, so a budget spent by one check never blocks another and the order doesn't matter.
import { createHash } from 'node:crypto'

export const ORG = 'instance'
export const USER = 'seed-member'
export const DEVICE = 'dev_e2e'
export const FINGERPRINT = 'fp-e2e'

const at = { x: 0, y: 0 }
const decision = (id, action) => ({
  id,
  type: 'decision',
  position: at,
  action,
  method: 'admin',
  timeoutSec: 300,
  reason: '',
})
const check = (id, config) => ({ id, type: 'check', position: at, enabled: true, check: config })
const edge = (source, sourceHandle, target) => ({
  id: `${source}-${sourceHandle}`,
  source,
  sourceHandle,
  target,
})
const keywords = (patterns) => ({
  type: 'keywords',
  patterns,
  mode: 'substring',
  caseSensitive: false,
})

/** Model output: redact secrets and e-mails, block a destructive command. */
const outputWorkflow = {
  fallback: 'block',
  nodes: [
    {
      id: 'start',
      type: 'trigger',
      position: at,
      mode: 'all',
      conditions: [{ field: 'kind', values: ['model_output'] }],
    },
    check('redact', { type: 'redact', secrets: true, pii: ['email'] }),
    check('kw', keywords(['rm -rf /'])),
    decision('allow', 'allow'),
    decision('block', 'block'),
  ],
  edges: [
    edge('start', 'next', 'redact'),
    edge('redact', 'pass', 'kw'),
    edge('kw', 'pass', 'allow'),
    edge('kw', 'fail', 'block'),
  ],
}

/** Tool results: a classic injection phrase withholds the result from the model. */
const resultsWorkflow = {
  fallback: 'block',
  nodes: [
    {
      id: 'start',
      type: 'trigger',
      position: at,
      mode: 'all',
      conditions: [{ field: 'kind', values: ['tool_result'] }],
    },
    check('kw', keywords(['ignore previous instructions'])),
    decision('allow', 'allow'),
    decision('block', 'block'),
  ],
  edges: [edge('start', 'next', 'kw'), edge('kw', 'pass', 'allow'), edge('kw', 'fail', 'block')],
}

const q = (s) => (s === null ? 'NULL' : `'${String(s).replaceAll("'", "''")}'`)

export function fixturesSql(mockPort) {
  const now = Date.now()
  const mock = `http://127.0.0.1:${mockPort}`
  const fph = createHash('sha256').update(FINGERPRINT).digest('hex')
  const model = (id, pattern, kind, format, base, extra = {}) => {
    const row = {
      id,
      org_id: ORG,
      pattern,
      label: id,
      kind,
      api_format: format,
      base_url: base,
      position: Object.keys(models).length,
      created_at: now,
      ...extra,
    }
    models[id] = row
  }
  const models = {}
  // External, priced like Claude Sonnet: one mock call costs about $0.021.
  const sonnet = {
    input_usd_per_m_tok: 3,
    output_usd_per_m_tok: 15,
    cache_write_usd_per_m_tok: 3.75,
    cache_read_usd_per_m_tok: 0.3,
  }
  model('mdl_claude', 'mock-claude*', 'external', 'anthropic', mock, sonnet)
  model('mdl_slow', 'mock-slow*', 'external', 'anthropic', mock, sonnet)
  // Local, OpenAI-compatible like Ollama, renamed upstream; $36 per GPU-hour makes cost visible.
  model('mdl_local', 'mock-local*', 'local', 'openai', `${mock}/v1`, {
    upstream_model: 'qwen-local',
    gpu_usd_per_hour: 36,
  })

  const limit = (id, name, measure, target, value) => ({
    id,
    org_id: ORG,
    name,
    measure,
    scope: 'model',
    target,
    limit: value,
    window_sec: 86_400,
    per: 'user',
    action: 'block',
    warn_at_pct: 50,
    enabled: 1,
    created_at: now,
  })
  const limits = [
    limit('lim_cost', 'Daily spend', 'cost', 'mock-claude-budget*', 0.06),
    limit('lim_conc', 'One at a time', 'concurrent', 'mock-slow*', 1),
    limit('lim_gpu', 'Daily GPU', 'gpu_seconds', 'mock-local-gpu*', 0.05),
  ]

  const insert = (table, row) =>
    `INSERT INTO "${table}" (${Object.keys(row)
      .map((k) => `"${k}"`)
      .join(',')}) VALUES (${Object.values(row).map(q).join(',')});`

  return [
    `DELETE FROM device WHERE id=${q(DEVICE)};`,
    insert('device', {
      id: DEVICE,
      org_id: ORG,
      user_id: USER,
      fingerprint_hash: fph,
      label: 'gateway-e2e',
      status: 'trusted',
      created_at: now,
    }),
    `UPDATE "group" SET permissions='{"models":["*"],"builtinTools":["*"],"mcp":{"*":["*"]}}' WHERE is_default=1;`,
    'DELETE FROM model;',
    'DELETE FROM rate_limit;',
    ...Object.values(models).map((m) => insert('model', m)),
    ...limits.map((l) => insert('rate_limit', l)),
    `DELETE FROM workflow_version WHERE workflow_id IN ('wf_e2e_out','wf_e2e_res');`,
    `DELETE FROM workflow WHERE id IN ('wf_e2e_out','wf_e2e_res');`,
    insert('workflow', {
      id: 'wf_e2e_out',
      org_id: ORG,
      name: 'Model output',
      enabled: 1,
      position: 1,
      group_ids: '[]',
      created_at: now,
      updated_at: now,
    }),
    insert('workflow', {
      id: 'wf_e2e_res',
      org_id: ORG,
      name: 'Tool results',
      enabled: 1,
      position: 2,
      group_ids: '[]',
      created_at: now,
      updated_at: now,
    }),
    insert('workflow_version', {
      id: 'wfv_e2e_out',
      org_id: ORG,
      workflow_id: 'wf_e2e_out',
      version: 1,
      definition: JSON.stringify(outputWorkflow),
      status: 'published',
      created_at: now,
    }),
    insert('workflow_version', {
      id: 'wfv_e2e_res',
      org_id: ORG,
      workflow_id: 'wf_e2e_res',
      version: 1,
      definition: JSON.stringify(resultsWorkflow),
      status: 'published',
      created_at: now,
    }),
  ].join('\n')
}
