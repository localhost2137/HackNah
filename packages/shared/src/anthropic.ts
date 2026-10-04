export type ContentBlock =
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

/** Claude Code tools that hand a task to a subagent; their calls and results are agent messages. */
export const AGENT_TOOLS = ['Task', 'Agent']

export type TurnToolResult = {
  toolUseId: string
  /** Name of the tool that produced it, from the matching `tool_use`; null if not found. */
  toolName: string | null
  text: string
}

/**
 * The newest user turn split by message type: what goes to the model as input (text blocks) and
 * each tool result on its own, named after the tool call it answers.
 */
export function splitTurn(body: MessagesRequest): { input: string; toolResults: TurnToolResult[] } {
  const messages = body.messages ?? []
  const last = messages.at(-1)
  if (last?.role !== 'user') return { input: '', toolResults: [] }
  if (typeof last.content === 'string') return { input: last.content, toolResults: [] }
  const names = new Map<string, string>()
  const previous = messages.at(-2)
  if (previous?.role === 'assistant' && Array.isArray(previous.content)) {
    for (const block of previous.content) {
      const b = block as { type: string; id?: unknown; name?: unknown }
      if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string')
        names.set(b.id, b.name)
    }
  }
  const input: string[] = []
  const toolResults: TurnToolResult[] = []
  for (const block of last.content) {
    if (block.type === 'tool_result') {
      const id = String((block as { tool_use_id?: unknown }).tool_use_id ?? '')
      toolResults.push({ toolUseId: id, toolName: names.get(id) ?? null, text: blockText(block) })
    } else {
      const text = blockText(block)
      if (text) input.push(text)
    }
  }
  return { input: input.join('\n'), toolResults }
}

/** Replaces the content of one tool result in the newest user turn. */
export function replaceToolResult(
  body: MessagesRequest,
  toolUseId: string,
  map: (block: ContentBlock) => ContentBlock,
): MessagesRequest {
  const messages = body.messages ?? []
  const last = messages.at(-1)
  if (!last || last.role !== 'user' || typeof last.content === 'string') return body
  const content = last.content.map((block) =>
    block.type === 'tool_result' && (block as { tool_use_id?: unknown }).tool_use_id === toolUseId
      ? map(block)
      : block,
  )
  return { ...body, messages: [...messages.slice(0, -1), { ...last, content }] }
}

/** Applies `fn` to the text of one content block (text, or a tool result's content). */
export function mapBlockText(block: ContentBlock, fn: (text: string) => string): ContentBlock {
  if (block.type === 'text' && typeof block.text === 'string')
    return { ...block, text: fn(block.text) }
  if (block.type === 'tool_result') {
    const content = (block as { content?: string | ContentBlock[] }).content
    if (typeof content === 'string') return { ...block, content: fn(content) }
    if (Array.isArray(content))
      return { ...block, content: content.map((b) => mapBlockText(b, fn)) }
  }
  return block
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

export type TokenUsage = {
  inputTokens: number | null
  outputTokens: number | null
  cacheWriteTokens: number | null
  cacheReadTokens: number | null
}

type RawUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: null, outputTokens: null, cacheWriteTokens: null, cacheReadTokens: null }
}

/** Folds a `usage` object into `into`; later events carry running totals, so values replace. */
export function mergeUsage(into: TokenUsage, raw: RawUsage | undefined): TokenUsage {
  if (!raw) return into
  return {
    inputTokens: raw.input_tokens ?? into.inputTokens,
    outputTokens: raw.output_tokens ?? into.outputTokens,
    cacheWriteTokens: raw.cache_creation_input_tokens ?? into.cacheWriteTokens,
    cacheReadTokens: raw.cache_read_input_tokens ?? into.cacheReadTokens,
  }
}

/** Parses token usage, cache reads and writes included, from an SSE or plain JSON response. */
export function parseUsage(raw: string, streamed: boolean): TokenUsage {
  let usage = emptyUsage()
  if (!streamed) {
    try {
      usage = mergeUsage(usage, (JSON.parse(raw) as { usage?: RawUsage }).usage)
    } catch {}
    return usage
  }
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    try {
      const data = JSON.parse(line.slice(5).trim()) as {
        type?: string
        message?: { usage?: RawUsage }
        usage?: RawUsage
      }
      if (data.type === 'message_start') usage = mergeUsage(usage, data.message?.usage)
      else if (data.type === 'message_delta') usage = mergeUsage(usage, data.usage)
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
