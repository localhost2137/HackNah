import { listMockTools, mockToken, type Provider, providers, toolDefinition } from './catalog.ts'

type Body = Record<string, unknown>
export interface MockStore {
  list(provider: Provider, kind: string): Promise<Body[]>
  get(provider: Provider, kind: string, id: string): Promise<Body | null>
  insert(provider: Provider, kind: string, id: string, body: Body): Promise<Body>
}
export function d1MockStore(db: D1Database): MockStore {
  return {
    async list(provider, kind) {
      const result = await db
        .prepare('SELECT body FROM mock_mcp_record WHERE provider = ? AND kind = ? ORDER BY id')
        .bind(provider, kind)
        .all<{ body: string }>()
      return result.results.map((r) => JSON.parse(r.body) as Body)
    },
    async get(provider, kind, id) {
      const row = await db
        .prepare('SELECT body FROM mock_mcp_record WHERE provider = ? AND kind = ? AND id = ?')
        .bind(provider, kind, id)
        .first<{ body: string }>()
      return row ? (JSON.parse(row.body) as Body) : null
    },
    async insert(provider, kind, id, body) {
      await db
        .prepare(
          'INSERT INTO mock_mcp_record (provider,kind,id,body) VALUES (?,?,?,?) ON CONFLICT DO NOTHING',
        )
        .bind(provider, kind, id, JSON.stringify(body))
        .run()
      return (await this.get(provider, kind, id))!
    },
  }
}
class ToolError extends Error {}
const result = (value: unknown, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  ...(!isError ? { structuredContent: value } : { isError: true }),
})
const rpc = (id: string | number | null, value: unknown) =>
  Response.json({ jsonrpc: '2.0', id, result: value })
const error = (id: string | number | null, code: number, message: string, status = 200) =>
  Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status })
const hash = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')

function search(rows: Body[], query: string, facets = false) {
  const terms = query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []
  for (const term of terms) {
    const split = term.indexOf(':')
    if (facets && split > 0) {
      const field = term.slice(0, split)
      if (!['service', 'status', 'env', 'trace_id'].includes(field))
        throw new ToolError(
          `Unsupported facet ${field}. Use service:, status:, env:, trace_id: or plain text.`,
        )
      const value = term
        .slice(split + 1)
        .replaceAll('"', '')
        .toLowerCase()
      if (!value) throw new ToolError(`Missing value for ${field}`)
      rows = rows.filter((row) => String(row[field] ?? '').toLowerCase() === value)
    } else {
      const value = term.replaceAll('"', '').toLowerCase()
      rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(value))
    }
  }
  return rows
}
function paginate(rows: Body[], args: Body) {
  const offset = Number(args.cursor ?? 0)
  const limit = Number(args.limit ?? 20)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > rows.length)
    throw new ToolError('Invalid pagination cursor for this result set')
  return {
    items: rows.slice(offset, offset + limit),
    total: rows.length,
    next_cursor: offset + limit < rows.length ? String(offset + limit) : null,
  }
}
function matches(rows: Body[], args: Body, fields: string[]) {
  return rows.filter((row) =>
    fields.every((field) => args[field] === undefined || row[field] === args[field]),
  )
}
async function required(store: MockStore, provider: Provider, kind: string, id: string) {
  const record = await store.get(provider, kind, id)
  if (!record) throw new ToolError(`${kind} ${id} not found`)
  return record
}
async function issueWithComments(store: MockStore, key: string) {
  const issue = await required(store, 'jira', 'issue', key)
  const comments = (await store.list('jira', 'comment')).filter((c) => c.issue_key === key)
  return {
    ...issue,
    comments: [...(Array.isArray(issue.comments) ? issue.comments : []), ...comments].sort((a, b) =>
      String(a.timestamp).localeCompare(String(b.timestamp)),
    ),
  }
}
export async function executeMockTool(
  store: MockStore,
  provider: Provider,
  name: string,
  args: Body,
) {
  const environment = await store.get(provider, 'meta', 'environment')
  if (!environment)
    throw new ToolError('Mock dataset is not seeded. Run pnpm --filter @acl/web db:setup locally.')
  const context = { synthetic: true, provider, dataset_as_of: environment.dataset_as_of }
  switch (name) {
    case 'get_environment':
      return environment
    case 'get_trace':
      return { ...context, trace: await required(store, provider, 'trace', String(args.trace_id)) }
    case 'get_service_health':
      return {
        ...context,
        service: await required(store, provider, 'service', String(args.service)),
      }
    case 'get_page':
      return { ...context, page: await required(store, provider, 'page', String(args.page_id)) }
    case 'get_issue':
      return { ...context, issue: await issueWithComments(store, String(args.issue_key)) }
    case 'search_logs': {
      if (args.from && args.to && Date.parse(String(args.from)) > Date.parse(String(args.to)))
        throw new ToolError('from must be before to')
      let rows = matches(await store.list(provider, 'log'), args, ['service', 'status', 'env'])
      rows = search(rows, String(args.query ?? ''), true).filter(
        (row) =>
          (!args.from || Date.parse(String(row.timestamp)) >= Date.parse(String(args.from))) &&
          (!args.to || Date.parse(String(row.timestamp)) <= Date.parse(String(args.to))),
      )
      rows.sort(
        (a, b) =>
          String(b.timestamp).localeCompare(String(a.timestamp)) ||
          String(a.id).localeCompare(String(b.id)),
      )
      return { ...context, ...paginate(rows, args) }
    }
    case 'list_monitors':
      return {
        ...context,
        ...paginate(
          matches(await store.list(provider, 'monitor'), args, ['service', 'state']),
          args,
        ),
      }
    case 'list_deployments': {
      const rows = matches(await store.list(provider, 'deployment'), args, ['service']).sort(
        (a, b) => String(b.timestamp).localeCompare(String(a.timestamp)),
      )
      return { ...context, ...paginate(rows, args) }
    }
    case 'search_pages': {
      const rows = search(
        matches(await store.list(provider, 'page'), args, ['space']),
        String(args.query ?? ''),
      )
      rows.sort(
        (a, b) =>
          Number(a.status === 'superseded') - Number(b.status === 'superseded') ||
          String(a.id).localeCompare(String(b.id)),
      )
      return {
        ...context,
        ...paginate(
          rows.map(({ body, ...page }) => ({ ...page, excerpt: String(body).slice(0, 280) })),
          args,
        ),
      }
    }
    case 'search_issues': {
      const rows = search(
        matches(await store.list(provider, 'issue'), args, ['project', 'status', 'priority']),
        String(args.query ?? ''),
      )
      rows.sort(
        (a, b) =>
          String(b.updated_at).localeCompare(String(a.updated_at)) ||
          String(a.id).localeCompare(String(b.id)),
      )
      return {
        ...context,
        ...paginate(
          rows.map(({ description, comments: _, ...issue }) => ({
            ...issue,
            excerpt: String(description).slice(0, 280),
          })),
          args,
        ),
      }
    }
    case 'create_issue': {
      if (args.related_issue) await required(store, 'jira', 'issue', String(args.related_issue))
      const key = `MOCK-${(await hash(String(args.idempotency_key))).slice(0, 16).toUpperCase()}`
      const fingerprint = await hash(JSON.stringify(args))
      const time = new Date().toISOString()
      const issue = await store.insert('jira', 'issue', key, {
        id: key,
        key,
        project: args.project,
        summary: args.summary,
        description: args.description,
        priority: args.priority,
        status: 'Open',
        labels: args.labels,
        reporter: 'Aurelius MCP integration bot',
        assignee: null,
        comments: [],
        related_issue_keys: args.related_issue ? [args.related_issue] : [],
        created_at: time,
        updated_at: time,
        request_fingerprint: fingerprint,
      })
      if (issue.request_fingerprint !== fingerprint)
        throw new ToolError('Idempotency key was already used with different issue data')
      return { ...context, issue }
    }
    case 'add_comment': {
      await required(store, 'jira', 'issue', String(args.issue_key))
      const id = `comment-${await hash(String(args.idempotency_key))}`
      const fingerprint = await hash(JSON.stringify(args))
      const comment = await store.insert('jira', 'comment', id, {
        id,
        issue_key: args.issue_key,
        body: args.body,
        author: 'Aurelius MCP integration bot',
        timestamp: new Date().toISOString(),
        request_fingerprint: fingerprint,
      })
      if (comment.request_fingerprint !== fingerprint)
        throw new ToolError('Idempotency key was already used with different comment data')
      return { ...context, comment }
    }
    default:
      throw new ToolError('Unknown tool')
  }
}

/** Stateless Streamable HTTP: JSON responses, accepted notifications, no optional SSE channel. */
export async function handleMockMcp(
  request: Request,
  store: MockStore,
  enabled: boolean,
): Promise<Response> {
  if (!enabled) return new Response('Not found', { status: 404 })
  const url = new URL(request.url)
  const provider = url.pathname.split('/')[2] as Provider
  if (!providers.includes(provider) || url.pathname !== `/mock-mcp/${provider}`)
    return new Response('Not found', { status: 404 })
  const origin = request.headers.get('origin')
  if (origin && origin !== url.origin) return new Response('Forbidden origin', { status: 403 })
  if (request.headers.get('authorization') !== `Bearer ${mockToken(provider)}`)
    return new Response('Invalid mock credential', {
      status: 401,
      headers: { 'www-authenticate': 'Bearer realm="local-mock-mcp"' },
    })
  if (request.method !== 'POST')
    return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (!request.headers.get('content-type')?.includes('application/json'))
    return new Response('Expected application/json', { status: 415 })
  const accept = request.headers.get('accept') ?? ''
  if (!accept.includes('application/json') || !accept.includes('text/event-stream'))
    return new Response('Accept must include application/json and text/event-stream', {
      status: 406,
    })
  const version = request.headers.get('mcp-protocol-version')
  if (version && !['2025-06-18', '2025-03-26'].includes(version))
    return error(null, -32600, 'Unsupported protocol version', 400)
  const raw = await request.text()
  if (new TextEncoder().encode(raw).length > 32768)
    return new Response('Request too large', { status: 413 })
  let message: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
  try {
    message = JSON.parse(raw)
  } catch {
    return error(null, -32700, 'Parse error', 400)
  }
  if (
    !message ||
    Array.isArray(message) ||
    message.jsonrpc !== '2.0' ||
    typeof message.method !== 'string' ||
    (message.id !== undefined && typeof message.id !== 'string' && typeof message.id !== 'number')
  )
    return error(null, -32600, 'Invalid JSON-RPC request', 400)
  if (message.id === undefined) return new Response(null, { status: 202 })
  const id = message.id as string | number
  const fault = request.headers.get('x-mock-fault')
  if (fault === 'unauthorized') return new Response('Simulated credential expiry', { status: 401 })
  if (fault === 'unavailable') return new Response('Simulated upstream outage', { status: 503 })
  if (fault === 'rate-limit')
    return new Response('Simulated upstream rate limit', {
      status: 429,
      headers: { 'retry-after': '2' },
    })
  if (fault === 'slow') await new Promise((resolve) => setTimeout(resolve, 750))
  if (message.method === 'initialize')
    return rpc(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: `mock-${provider}`, title: `${provider} — local mock`, version: '1.0.0' },
      instructions:
        'Fictional Aurelius Securities data. Use get_environment for the fixed dataset clock. No real provider is contacted.',
    })
  if (message.method === 'ping') return rpc(id, {})
  if (message.method === 'tools/list') return rpc(id, { tools: listMockTools(provider) })
  if (message.method !== 'tools/call') return error(id, -32601, 'Method not found')
  const params = message.params as { name?: unknown; arguments?: unknown } | undefined
  if (!params || typeof params.name !== 'string') return error(id, -32602, 'Missing tool name')
  const tool = toolDefinition(provider, params.name)
  if (!tool) return error(id, -32602, 'Unknown tool for this provider')
  const parsed = tool.schema.safeParse(params.arguments ?? {})
  if (!parsed.success)
    return error(
      id,
      -32602,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    )
  if (fault === 'tool-error')
    return rpc(id, result({ error: 'Simulated provider tool failure' }, true))
  try {
    return rpc(id, result(await executeMockTool(store, provider, params.name, parsed.data as Body)))
  } catch (err) {
    if (err instanceof ToolError) return rpc(id, result({ error: err.message }, true))
    console.error('Mock MCP storage failure', err)
    return error(id, -32603, 'Mock storage unavailable; apply local migrations and seed')
  }
}
