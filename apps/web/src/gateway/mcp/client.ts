export const MCP_PROTOCOL_VERSION = '2025-06-18'

export type JsonRpcRequest = {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: unknown
}
export type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type McpTool = {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: unknown
}

export class McpUpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

const sessions = new Map<string, string>()

/**
 * Client for one upstream MCP server over Streamable HTTP. Sessions are cached per isolate
 * and re-established when the server forgets them.
 */
export class McpClient {
  private nextId = 1

  constructor(
    private readonly url: string,
    private readonly token: string | null,
    private readonly cacheKey: string,
  ) {}

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = []
    let cursor: string | undefined
    do {
      const result = (await this.request('tools/list', cursor ? { cursor } : {})) as {
        tools?: McpTool[]
        nextCursor?: string
      }
      tools.push(...(result.tools ?? []))
      cursor = result.nextCursor
    } while (cursor && tools.length < 2000)
    return tools
  }

  callTool(name: string, args: unknown): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args ?? {} })
  }

  async request(method: string, params: unknown, retried = false): Promise<unknown> {
    const sessionId = sessions.get(this.cacheKey) ?? (await this.initialize())
    const res = await this.post({ jsonrpc: '2.0', id: this.nextId++, method, params }, sessionId)
    if ((res.status === 404 || res.status === 400) && !retried && sessionId) {
      sessions.delete(this.cacheKey)
      return this.request(method, params, true)
    }
    const message = await this.readResponse(res)
    if (message.error) throw new McpUpstreamError(message.error.message)
    return message.result
  }

  private async initialize(): Promise<string> {
    const res = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'ai-control-layer', version: '0.1.0' },
      },
    })
    const message = await this.readResponse(res)
    if (message.error) throw new McpUpstreamError(`initialize failed: ${message.error.message}`)
    const sessionId = res.headers.get('mcp-session-id') ?? ''
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId)
    if (sessionId) sessions.set(this.cacheKey, sessionId)
    return sessionId
  }

  private post(message: JsonRpcRequest, sessionId?: string): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    }
    if (this.token) headers.authorization = `Bearer ${this.token}`
    if (sessionId) headers['mcp-session-id'] = sessionId
    return fetch(this.url, { method: 'POST', headers, body: JSON.stringify(message) })
  }

  private async readResponse(res: Response): Promise<JsonRpcResponse> {
    if (res.status === 401 || res.status === 403)
      throw new McpUpstreamError('Upstream MCP rejected the credential', res.status)
    if (!res.ok) throw new McpUpstreamError(`Upstream MCP returned ${res.status}`, res.status)
    const type = res.headers.get('content-type') ?? ''
    if (type.includes('text/event-stream')) return readSseResponse(res)
    return (await res.json()) as JsonRpcResponse
  }
}

/** Reads SSE until the first JSON-RPC response (server notifications are skipped). */
async function readSseResponse(res: Response): Promise<JsonRpcResponse> {
  if (!res.body) throw new McpUpstreamError('Empty SSE body')
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value
      let idx = buffer.indexOf('\n\n')
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const data = chunk
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n')
        if (data) {
          const msg = JSON.parse(data) as JsonRpcResponse
          if ('result' in msg || 'error' in msg) return msg
        }
        idx = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  throw new McpUpstreamError('SSE stream ended without a response')
}
