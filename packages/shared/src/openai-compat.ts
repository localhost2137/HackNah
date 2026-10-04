import type { ContentBlock, MessagesRequest } from './anthropic.ts'

/**
 * Translation between the Anthropic Messages API, which Claude Code speaks, and OpenAI-compatible
 * chat completions, which OpenRouter, Ollama, vLLM, LM Studio, llama.cpp and LiteLLM all serve.
 * The gateway keeps the Anthropic shape on the client side and on its own checks; only the hop to
 * an `openai` upstream is translated. Thinking blocks and cache markers have no equivalent and are
 * dropped.
 */

type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OpenAIPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

type OpenAIPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

type OpenAIToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type AnthropicTool = { name?: string; description?: string; input_schema?: unknown }

function plainText(content: string | ContentBlock[] | undefined): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content
    .map((b) =>
      b.type === 'text'
        ? String((b as { text?: unknown }).text ?? '')
        : b.type === 'tool_result'
          ? plainText((b as { content?: string | ContentBlock[] }).content)
          : '',
    )
    .filter(Boolean)
    .join('\n')
}

function userPart(block: ContentBlock): OpenAIPart | null {
  if (block.type === 'text')
    return { type: 'text', text: String((block as { text?: unknown }).text ?? '') }
  if (block.type === 'image') {
    const source = (
      block as { source?: { type?: string; media_type?: string; data?: string; url?: string } }
    ).source
    if (source?.type === 'base64')
      return {
        type: 'image_url',
        image_url: { url: `data:${source.media_type};base64,${source.data}` },
      }
    if (source?.type === 'url' && source.url)
      return { type: 'image_url', image_url: { url: source.url } }
  }
  return null
}

function toolChoice(choice: unknown): unknown {
  const c = choice as { type?: string; name?: string } | undefined
  if (!c?.type) return undefined
  if (c.type === 'any') return 'required'
  if (c.type === 'tool' && c.name) return { type: 'function', function: { name: c.name } }
  if (c.type === 'none') return 'none'
  return 'auto'
}

export function toOpenAIRequest(body: MessagesRequest, model: string): Record<string, unknown> {
  const messages: OpenAIMessage[] = []
  const system = plainText(body.system)
  if (system) messages.push({ role: 'system', content: system })

  for (const m of body.messages ?? []) {
    if (typeof m.content === 'string') {
      messages.push(
        m.role === 'user'
          ? { role: 'user', content: m.content }
          : { role: 'assistant', content: m.content },
      )
      continue
    }
    if (m.role === 'assistant') {
      const text = m.content
        .filter((b) => b.type === 'text')
        .map((b) => String((b as { text?: unknown }).text ?? ''))
        .join('')
      const calls: OpenAIToolCall[] = m.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => {
          const t = b as { id?: string; name?: string; input?: unknown }
          return {
            id: String(t.id ?? ''),
            type: 'function',
            function: { name: String(t.name ?? ''), arguments: JSON.stringify(t.input ?? {}) },
          }
        })
      messages.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      })
      continue
    }
    // A user turn: tool results become tool messages, which must directly follow the call.
    for (const b of m.content)
      if (b.type === 'tool_result') {
        const r = b as {
          tool_use_id?: string
          content?: string | ContentBlock[]
          is_error?: boolean
        }
        const text = plainText(r.content)
        messages.push({
          role: 'tool',
          tool_call_id: String(r.tool_use_id ?? ''),
          content: r.is_error ? `Error: ${text}` : text,
        })
      }
    const parts = m.content.map(userPart).filter((p) => p !== null)
    if (parts.length)
      messages.push({
        role: 'user',
        content: parts.every((p) => p.type === 'text')
          ? parts.map((p) => p.text).join('\n')
          : parts,
      })
  }

  const tools = ((body.tools as AnthropicTool[] | undefined) ?? [])
    // Server tools (web search and the like) have no schema and no OpenAI counterpart.
    .filter((t) => t.name && t.input_schema)
    .map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description ?? '', parameters: t.input_schema },
    }))

  const out: Record<string, unknown> = { model, messages }
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens
  for (const key of ['temperature', 'top_p'] as const)
    if (typeof body[key] === 'number') out[key] = body[key]
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length)
    out.stop = body.stop_sequences
  if (tools.length) {
    out.tools = tools
    const choice = toolChoice(body.tool_choice)
    if (choice) out.tool_choice = choice
  }
  if (body.stream === true) {
    out.stream = true
    out.stream_options = { include_usage: true }
  }
  return out
}

type OpenAIUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

/** OpenAI counts cached prompt tokens inside `prompt_tokens`; Anthropic counts them apart. */
export function anthropicUsage(u: OpenAIUsage | undefined): Record<string, number> {
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0
  return {
    input_tokens: Math.max(0, (u?.prompt_tokens ?? 0) - cached),
    output_tokens: u?.completion_tokens ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  }
}

const stopReasons: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
}

function parseArguments(raw: string | undefined): unknown {
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { _raw: raw }
  }
}

type OpenAIChoiceMessage = { content?: string | null; tool_calls?: OpenAIToolCall[] }

export function fromOpenAIResponse(
  json: {
    id?: string
    choices?: { message?: OpenAIChoiceMessage; finish_reason?: string }[]
    usage?: OpenAIUsage
  },
  model: string,
): Record<string, unknown> {
  const choice = json.choices?.[0]
  const content: Record<string, unknown>[] = []
  if (choice?.message?.content) content.push({ type: 'text', text: choice.message.content })
  for (const call of choice?.message?.tool_calls ?? [])
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseArguments(call.function.arguments),
    })
  const toolUse = content.some((c) => c.type === 'tool_use')
  return {
    id: json.id ?? 'msg_openai',
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: toolUse
      ? 'tool_use'
      : (stopReasons[choice?.finish_reason ?? 'stop'] ?? 'end_turn'),
    stop_sequence: null,
    usage: anthropicUsage(json.usage),
  }
}

/** An OpenAI error body, or any text, as an Anthropic error body. */
export function anthropicErrorFromOpenAI(status: number, raw: string) {
  let message = raw.slice(0, 500) || `Upstream returned ${status}`
  try {
    const json = JSON.parse(raw) as { error?: { message?: string } | string }
    message = typeof json.error === 'string' ? json.error : (json.error?.message ?? message)
  } catch {}
  const type =
    status === 429 ? 'rate_limit_error' : status === 401 ? 'authentication_error' : 'api_error'
  return { type: 'error', error: { type, message } }
}

type StreamChunk = {
  id?: string
  choices?: {
    delta?: {
      content?: string | null
      tool_calls?: {
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason?: string | null
  }[]
  usage?: OpenAIUsage
  error?: { message?: string }
}

/** Re-emits an OpenAI chat completions stream as Anthropic Messages SSE. */
export function openAIStreamToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const reader = upstream.getReader()

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (data: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`))
      let started = false
      let index = -1
      let open: 'text' | 'tool' | null = null
      /** OpenAI tool call index -> Anthropic content block index. */
      const toolBlocks = new Map<number, number>()
      let finish: string | null = null
      let usage: Record<string, number> = anthropicUsage(undefined)

      const begin = (id?: string) => {
        if (started) return
        started = true
        emit({
          type: 'message_start',
          message: {
            id: id ?? 'msg_openai',
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        })
      }
      const close = () => {
        if (open) emit({ type: 'content_block_stop', index })
        open = null
      }

      const handle = (chunk: StreamChunk) => {
        if (chunk.error) throw new Error(chunk.error.message ?? 'upstream error')
        begin(chunk.id)
        if (chunk.usage) usage = anthropicUsage(chunk.usage)
        const choice = chunk.choices?.[0]
        if (!choice) return
        const delta = choice.delta ?? {}
        if (delta.content) {
          if (open !== 'text') {
            close()
            index += 1
            open = 'text'
            emit({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
          }
          emit({
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: delta.content },
          })
        }
        for (const call of delta.tool_calls ?? []) {
          const key = call.index ?? 0
          if (!toolBlocks.has(key)) {
            close()
            index += 1
            open = 'tool'
            toolBlocks.set(key, index)
            emit({
              type: 'content_block_start',
              index,
              content_block: {
                type: 'tool_use',
                id: call.id ?? `toolu_${index}`,
                name: call.function?.name ?? '',
                input: {},
              },
            })
          }
          if (call.function?.arguments)
            emit({
              type: 'content_block_delta',
              index: toolBlocks.get(key),
              delta: { type: 'input_json_delta', partial_json: call.function.arguments },
            })
        }
        if (choice.finish_reason) finish = choice.finish_reason
      }

      try {
        let buffer = ''
        let done = false
        while (!done) {
          const read = await reader.read()
          if (read.done) break
          buffer += decoder.decode(read.value, { stream: true }).replace(/\r\n/g, '\n')
          let cut = buffer.indexOf('\n')
          while (cut !== -1) {
            const line = buffer.slice(0, cut).trim()
            buffer = buffer.slice(cut + 1)
            cut = buffer.indexOf('\n')
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (data === '[DONE]') {
              done = true
              break
            }
            try {
              handle(JSON.parse(data) as StreamChunk)
            } catch (err) {
              if (err instanceof SyntaxError) continue
              throw err
            }
          }
        }
        begin()
        close()
        const stop = toolBlocks.size ? 'tool_use' : (stopReasons[finish ?? 'stop'] ?? 'end_turn')
        emit({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage })
        emit({ type: 'message_stop' })
      } catch (err) {
        emit({
          type: 'error',
          error: { type: 'api_error', message: err instanceof Error ? err.message : String(err) },
        })
        await reader.cancel().catch(() => {})
      } finally {
        controller.close()
      }
    },
    cancel() {
      void reader.cancel().catch(() => {})
    },
  })
}
