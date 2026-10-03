type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; content?: string | ContentBlock[] }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: string; [key: string]: unknown }

export type MessagesRequest = {
  model?: string
  stream?: boolean
  system?: string | ContentBlock[]
  messages?: { role: 'user' | 'assistant'; content: string | ContentBlock[] }[]
  metadata?: { user_id?: string }
  [key: string]: unknown
}

function blockText(block: ContentBlock): string {
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  if (block.type === 'tool_result') {
    const content = (block as { content?: string | ContentBlock[] }).content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return content.map(blockText).join('\n')
  }
  return ''
}

/**
 * Text that is new in this turn: the last user message, including tool results.
 * Earlier turns were already checked when they were sent.
 */
export function extractTurnText(body: MessagesRequest): string {
  const last = body.messages?.at(-1)
  if (last?.role !== 'user') return ''
  if (typeof last.content === 'string') return last.content
  return last.content.map(blockText).filter(Boolean).join('\n')
}

/** Claude Code encodes the session in `metadata.user_id` as `..._session_<uuid>`. */
export function sessionFromMetadata(body: MessagesRequest): string | null {
  const userId = body.metadata?.user_id
  if (!userId) return null
  const match = /session_([0-9a-f-]{36})/i.exec(userId)
  return match?.[1] ?? null
}

/** Applies `fn` to every text-bearing string in the request. Used by redaction. */
export function mapRequestText(
  body: MessagesRequest,
  fn: (text: string) => string,
): MessagesRequest {
  const mapBlock = (block: ContentBlock): ContentBlock => {
    if (block.type === 'text' && typeof block.text === 'string')
      return { ...block, text: fn(block.text) }
    if (block.type === 'tool_result') {
      const content = (block as { content?: string | ContentBlock[] }).content
      if (typeof content === 'string') return { ...block, content: fn(content) }
      if (Array.isArray(content)) return { ...block, content: content.map(mapBlock) }
    }
    return block
  }
  return {
    ...body,
    messages: body.messages?.map((m) => ({
      ...m,
      content: typeof m.content === 'string' ? fn(m.content) : m.content.map(mapBlock),
    })),
  }
}

export type Usage = { inputTokens: number | null; outputTokens: number | null }

/** Parses token usage out of a streamed (SSE) or plain JSON Messages response. */
export function parseUsage(raw: string, streamed: boolean): Usage {
  const usage: Usage = { inputTokens: null, outputTokens: null }
  if (!streamed) {
    try {
      const json = JSON.parse(raw) as { usage?: { input_tokens?: number; output_tokens?: number } }
      usage.inputTokens = json.usage?.input_tokens ?? null
      usage.outputTokens = json.usage?.output_tokens ?? null
    } catch {}
    return usage
  }
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    try {
      const data = JSON.parse(line.slice(5).trim()) as {
        type?: string
        message?: { usage?: { input_tokens?: number; output_tokens?: number } }
        usage?: { output_tokens?: number }
      }
      if (data.type === 'message_start') {
        usage.inputTokens = data.message?.usage?.input_tokens ?? usage.inputTokens
        usage.outputTokens = data.message?.usage?.output_tokens ?? usage.outputTokens
      } else if (data.type === 'message_delta') {
        usage.outputTokens = data.usage?.output_tokens ?? usage.outputTokens
      }
    } catch {}
  }
  return usage
}

/** Error body in the shape Claude Code expects from the Messages API. */
export function anthropicError(
  type:
    | 'permission_error'
    | 'rate_limit_error'
    | 'authentication_error'
    | 'api_error'
    | 'invalid_request_error',
  message: string,
) {
  return { type: 'error', error: { type, message } }
}
