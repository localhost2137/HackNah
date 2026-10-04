import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpClient } from '../gateway/mcp/client.ts'
import { mockToken, type Provider } from './catalog.ts'
import { buildMockRecords } from './seed-data.ts'
import { handleMockMcp, type MockStore } from './server.ts'

const anchor = Date.parse('2026-10-04T12:00:00Z')
function memoryStore(): MockStore {
  const records = new Map(
    buildMockRecords(anchor).map((r) => [`${r.provider}:${r.kind}:${r.id}`, r.body]),
  )
  return {
    async get(provider, kind, id) {
      return records.get(`${provider}:${kind}:${id}`) ?? null
    },
    async list(provider, kind) {
      return [...records]
        .filter(([key]) => key.startsWith(`${provider}:${kind}:`))
        .map(([, body]) => body)
    },
    async insert(provider, kind, id, body) {
      const key = `${provider}:${kind}:${id}`
      if (!records.has(key)) records.set(key, body)
      return records.get(key)!
    },
  }
}
function request(
  provider: Provider,
  method: string,
  params: unknown = {},
  headers: Record<string, string> = {},
) {
  return new Request(`http://localhost:3000/mock-mcp/${provider}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${mockToken(provider)}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}
async function call(
  store: MockStore,
  provider: Provider,
  name: string,
  args: Record<string, unknown> = {},
) {
  return (await (
    await handleMockMcp(request(provider, 'tools/call', { name, arguments: args }), store, true)
  ).json()) as {
    result?: {
      structuredContent: {
        items: Record<string, unknown>[]
        total: number
        next_cursor: string
        page: { status: string }
        issue: { key: string; comments: unknown[]; reporter: string }
      }
      isError?: boolean
      content: { text: string }[]
    }
    error?: { code: number }
  }
}
afterEach(() => vi.restoreAllMocks())

describe('mock MCP transport and real gateway client', () => {
  it('is unavailable outside development, even with a valid token', async () => {
    expect(
      (await handleMockMcp(request('datadog', 'tools/list'), memoryStore(), false)).status,
    ).toBe(404)
  })
  it('checks provider credentials, origin, and protocol version', async () => {
    const store = memoryStore()
    expect(
      (
        await handleMockMcp(
          request('jira', 'ping', {}, { authorization: `Bearer ${mockToken('datadog')}` }),
          store,
          true,
        )
      ).status,
    ).toBe(401)
    expect(
      (
        await handleMockMcp(
          request('jira', 'ping', {}, { origin: 'https://untrusted.example' }),
          store,
          true,
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await handleMockMcp(
          request('jira', 'ping', {}, { 'mcp-protocol-version': '1900' }),
          store,
          true,
        )
      ).status,
    ).toBe(400)
  })
  it('supports discovery and calls using the production McpClient unchanged', async () => {
    const store = memoryStore()
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) =>
        handleMockMcp(new Request(input, init), store, true),
      )
    const client = new McpClient(
      'http://localhost:3000/mock-mcp/datadog',
      mockToken('datadog'),
      'mock-test',
    )
    expect((await client.listTools()).map((t) => t.name)).toContain('get_trace')
    const result = (await client.callTool('get_trace', { trace_id: 'trace-settlement-009' })) as {
      structuredContent: { trace: { status: string } }
    }
    expect(result.structuredContent.trace.status).toBe('error')
    expect(
      fetch.mock.calls.some(([, init]) => String(init?.body).includes('notifications/initialized')),
    ).toBe(true)
  })
  it('accepts notifications without inventing a response id and refuses optional SSE', async () => {
    const store = memoryStore()
    const original = request('jira', 'notifications/initialized')
    const notification = new Request(original, {
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    const response = await handleMockMcp(notification, store, true)
    expect(response.status).toBe(202)
    expect(await response.text()).toBe('')
    expect(
      (await handleMockMcp(new Request(original.url, { headers: original.headers }), store, true))
        .status,
    ).toBe(405)
  })
  it('rejects malformed JSON, batches, missing fields and cross-provider tool names', async () => {
    const store = memoryStore()
    const original = request('jira', 'ping')
    expect((await handleMockMcp(new Request(original, { body: '{' }), store, true)).status).toBe(
      400,
    )
    expect((await handleMockMcp(new Request(original, { body: '[]' }), store, true)).status).toBe(
      400,
    )
    expect((await call(store, 'jira', 'create_issue', {})).error?.code).toBe(-32602)
    expect((await call(store, 'confluence', 'get_trace', { trace_id: 'x' })).error?.code).toBe(
      -32602,
    )
  })
  it('provides deterministic upstream failure controls', async () => {
    const store = memoryStore()
    for (const [fault, status] of [
      ['unauthorized', 401],
      ['rate-limit', 429],
      ['unavailable', 503],
    ] as const) {
      expect(
        (
          await handleMockMcp(
            request('datadog', 'ping', {}, { 'x-mock-fault': fault }),
            store,
            true,
          )
        ).status,
      ).toBe(status)
    }
    const response = await handleMockMcp(
      request(
        'datadog',
        'tools/call',
        { name: 'get_environment' },
        { 'x-mock-fault': 'tool-error' },
      ),
      store,
      true,
    )
    expect(((await response.json()) as { result: { isError: boolean } }).result.isError).toBe(true)
  })
})

describe('investigation data and mutations', () => {
  it('paginates filtered logs without duplicates and handles empty results', async () => {
    const store = memoryStore()
    const first = (
      await call(store, 'datadog', 'search_logs', {
        query: 'service:ledger-writer status:error env:prod',
        limit: 5,
      })
    ).result!.structuredContent
    const second = (
      await call(store, 'datadog', 'search_logs', {
        query: 'service:ledger-writer status:error env:prod',
        limit: 5,
        cursor: first.next_cursor,
      })
    ).result!.structuredContent
    expect(first.total).toBe(40)
    expect(new Set([...first.items, ...second.items].map((r) => r.id)).size).toBe(10)
    expect(
      (await call(store, 'datadog', 'search_logs', { query: 'no-such-instruction' })).result!
        .structuredContent.total,
    ).toBe(0)
    expect(
      (await call(store, 'datadog', 'search_logs', { query: 'unknown:value' })).result!.isError,
    ).toBe(true)
    expect(
      (
        await call(store, 'datadog', 'search_logs', {
          from: '2026-10-04T12:00:00Z',
          to: '2026-10-04T11:00:00Z',
        })
      ).result!.isError,
    ).toBe(true)
  })
  it('connects traces to logs, spans, deployment and incident evidence', async () => {
    const records = buildMockRecords(anchor)
    const find = (provider: string, kind: string, id: unknown) =>
      records.find((r) => r.provider === provider && r.kind === kind && r.id === id)
    for (const record of records) {
      const b = record.body as {
        log_ids: string[]
        spans: {
          start_offset_ms: number
          duration_ms: number
          parent_id: string | null
          span_id: string
        }[]
        duration_ms: number
        deployment_id: string
        related_issue?: string
        related_page_ids?: string[]
        page_ids?: string[]
        issue_keys?: string[]
        related_issue_keys?: string[]
        runbook_id?: string
      }
      if (record.kind === 'trace') {
        expect(find('datadog', 'deployment', b.deployment_id)).toBeDefined()
        for (const logId of b.log_ids)
          expect(find('datadog', 'log', logId)?.body.trace_id).toBe(record.id)
        for (const span of b.spans) {
          expect(span.start_offset_ms + span.duration_ms).toBeLessThanOrEqual(b.duration_ms)
          if (span.parent_id) expect(b.spans.some((s) => s.span_id === span.parent_id)).toBe(true)
        }
        if (b.related_issue) expect(find('jira', 'issue', b.related_issue)).toBeDefined()
      }
      for (const id of b.related_page_ids ?? b.page_ids ?? [])
        expect(find('confluence', 'page', id)).toBeDefined()
      for (const id of b.issue_keys ?? b.related_issue_keys ?? [])
        expect(find('jira', 'issue', id)).toBeDefined()
      if (b.runbook_id) expect(find('confluence', 'page', b.runbook_id)).toBeDefined()
    }
    expect(records.filter((r) => r.kind === 'log').length).toBeGreaterThan(300)
    expect(
      (await call(memoryStore(), 'confluence', 'get_page', { page_id: 'CONF-103' })).result!
        .structuredContent.page.status,
    ).toBe('superseded')
  })
  it('writes issues and comments durably through the store and makes retries idempotent', async () => {
    const store = memoryStore()
    const args = {
      project: 'PAY',
      summary: 'Add a replay canary gate',
      description: 'Follow up on PAY-1847: exercise timeout-after-commit before rollout.',
      related_issue: 'PAY-1847',
      idempotency_key: 'demo-create-001',
    }
    const [a, b] = await Promise.all([
      call(store, 'jira', 'create_issue', args),
      call(store, 'jira', 'create_issue', args),
    ])
    const key = a.result!.structuredContent.issue.key
    expect(b.result!.structuredContent.issue.key).toBe(key)
    expect(
      (await call(store, 'jira', 'create_issue', { ...args, summary: 'Conflicting retry' })).result!
        .isError,
    ).toBe(true)
    const comment = {
      issue_key: key,
      body: 'Evidence: trace-settlement-009 and CONF-102.',
      idempotency_key: 'demo-comment-001',
    }
    await call(store, 'jira', 'add_comment', comment)
    await call(store, 'jira', 'add_comment', comment)
    const saved = (await call(store, 'jira', 'get_issue', { issue_key: key })).result!
      .structuredContent.issue
    expect(saved.comments).toHaveLength(1)
    expect(saved.reporter).toBe('Aurelius MCP integration bot')
    expect(
      (await call(store, 'jira', 'get_issue', { issue_key: 'NONEXISTENT' })).result!.isError,
    ).toBe(true)
  })
})
