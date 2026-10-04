/**
 * Inspects a model's output block by block before it reaches the agent.
 *
 * Text streams through with a short hold-back: the text so far is checked every few hundred
 * characters, and only what passed (redacted if the workflow says so) is released. A secret that
 * starts inside the hold-back is caught before any of it leaves. When the text fails, the stream
 * ends there with a notice instead of an error, so the agent sees a normal, shorter answer.
 *
 * Tool calls are held whole, since their arguments are only complete at the end of the block, and
 * checked like any other tool call. A refused call is replaced by a text block saying so, and the
 * stop reason is corrected so the agent does not wait for a result that will never come.
 */

export type TextVerdict<D> = {
  action: 'allow' | 'block'
  reason?: string
  /** Applied to every piece of text before it is released. */
  redact?: (text: string) => string
  /** Kept with the report, e.g. the checks for the event. */
  detail?: D
}

export type ToolVerdict = { allow: boolean; reason?: string }

export type ToolUse = { id: string; name: string; input: unknown }

export type GuardHooks<D> = {
  /** Checks all text generated so far. `final` is set once the text is complete. */
  checkText: (text: string, final: boolean) => Promise<TextVerdict<D>>
  checkToolUse: (tool: ToolUse) => Promise<ToolVerdict>
}

export type GuardReport<D> = {
  /** Text as it was released. */
  text: string
  /** Why the text was cut short, if it was. */
  withheld: string | null
  /** The last text verdict's detail. */
  detail: D | null
  tools: (ToolUse & ToolVerdict)[]
  /** Time spent in checks, the part of the latency the guard adds. */
  checkMs: number
  /** Usage as the upstream reported it in the stream. */
  usage: Record<string, number> | null
}

/** Characters held back so a secret that is still being generated can't leak in pieces. */
export const HOLD_CHARS = 200
/** How much new text arrives between two checks. */
export const CHECK_EVERY = 512
const KEEPALIVE_MS = 15_000

export const withheldNotice = (reason: string) => `\n\n[Response withheld by Hack?Nah!: ${reason}]`
export const blockedToolNotice = (name: string, reason: string) =>
  `[Tool call ${name} blocked by Hack?Nah!: ${reason}]`

type SseEvent = { event: string; data: Record<string, unknown> }

function encodeEvent(e: SseEvent): string {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`
}

function parseEvent(raw: string): SseEvent | null {
  let event = ''
  const data: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  if (!data.length) return null
  try {
    const parsed = JSON.parse(data.join('\n')) as Record<string, unknown>
    return { event: event || String(parsed.type ?? 'message'), data: parsed }
  } catch {
    return null
  }
}

/** Where text can be cut without splitting a word: the last whitespace before `limit`. */
export function releasePoint(text: string, from: number, limit: number): number {
  if (limit <= from) return from
  for (let i = limit - 1; i >= from; i--) if (/\s/.test(text[i]!)) return i + 1
  return from
}

type Block =
  | { kind: 'text'; index: number; text: string; released: number }
  | { kind: 'tool'; index: number; start: Record<string, unknown>; json: string }
  | { kind: 'pass'; index: number }

class Guard<D> {
  readonly report: GuardReport<D> = {
    text: '',
    withheld: null,
    detail: null,
    tools: [],
    checkMs: 0,
    usage: null,
  }
  private blocks = new Map<number, Block>()
  private textBefore = ''
  private toolAllowed = false
  private toolBlocked = false
  done = false

  constructor(
    private hooks: GuardHooks<D>,
    private emit: (e: SseEvent) => void,
  ) {}

  private async timed<T>(fn: () => Promise<T>): Promise<T> {
    const started = Date.now()
    try {
      return await fn()
    } finally {
      this.report.checkMs += Date.now() - started
    }
  }

  private allText(block: { text: string }) {
    return this.textBefore + block.text
  }

  /** Checks the text and releases what passed. Returns false when the text was withheld. */
  private async release(block: Extract<Block, { kind: 'text' }>, final: boolean) {
    const verdict = await this.timed(() => this.hooks.checkText(this.allText(block), final))
    this.report.detail = verdict.detail ?? this.report.detail
    if (verdict.action === 'block') {
      const reason = verdict.reason || 'policy'
      this.report.withheld = reason
      this.textDelta(block.index, withheldNotice(reason))
      this.emit({
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: block.index },
      })
      this.finish('end_turn')
      return false
    }
    const end = final
      ? block.text.length
      : releasePoint(block.text, block.released, block.text.length - HOLD_CHARS)
    if (end > block.released) {
      const piece = block.text.slice(block.released, end)
      const out = verdict.redact ? verdict.redact(piece) : piece
      this.report.text += out
      this.textDelta(block.index, out)
      block.released = end
    }
    return true
  }

  private textDelta(index: number, text: string) {
    if (!text) return
    this.emit({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
    })
  }

  /** Ends the message early, as if the model had stopped there. */
  private finish(stopReason: string) {
    this.emit({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: this.report.usage?.output_tokens ?? 0 },
      },
    })
    this.emit({ event: 'message_stop', data: { type: 'message_stop' } })
    this.done = true
  }

  private async checkTool(block: Extract<Block, { kind: 'tool' }>) {
    let input: unknown = {}
    try {
      input = block.json.trim() ? JSON.parse(block.json) : (block.start.input ?? {})
    } catch {
      input = { _unparsed: block.json }
    }
    const tool = { id: String(block.start.id ?? ''), name: String(block.start.name ?? ''), input }
    // An approval can take minutes; pings keep the connection open meanwhile.
    const ping = setInterval(
      () => this.emit({ event: 'ping', data: { type: 'ping' } }),
      KEEPALIVE_MS,
    )
    let verdict: ToolVerdict
    try {
      verdict = await this.timed(() => this.hooks.checkToolUse(tool))
    } catch (err) {
      verdict = { allow: false, reason: err instanceof Error ? err.message : 'check failed' }
    } finally {
      clearInterval(ping)
    }
    this.report.tools.push({ ...tool, ...verdict })
    if (verdict.allow) {
      this.toolAllowed = true
      this.emit({
        event: 'content_block_start',
        data: { type: 'content_block_start', index: block.index, content_block: block.start },
      })
      if (block.json)
        this.emit({
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: block.index,
            delta: { type: 'input_json_delta', partial_json: block.json },
          },
        })
    } else {
      this.toolBlocked = true
      this.emit({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: block.index,
          content_block: { type: 'text', text: '' },
        },
      })
      this.textDelta(block.index, blockedToolNotice(tool.name, verdict.reason || 'policy'))
    }
    this.emit({
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: block.index },
    })
  }

  async handle(e: SseEvent) {
    if (this.done) return
    const d = e.data
    const index = typeof d.index === 'number' ? d.index : -1
    switch (d.type) {
      case 'message_start': {
        const usage = (d.message as { usage?: Record<string, number> } | undefined)?.usage
        if (usage) this.report.usage = { ...usage }
        this.emit(e)
        return
      }
      case 'content_block_start': {
        const block = (d.content_block ?? {}) as Record<string, unknown>
        if (block.type === 'text') {
          const text = typeof block.text === 'string' ? block.text : ''
          this.blocks.set(index, { kind: 'text', index, text, released: 0 })
          this.emit({ ...e, data: { ...d, content_block: { ...block, text: '' } } })
        } else if (block.type === 'tool_use') {
          this.blocks.set(index, { kind: 'tool', index, start: { ...block, input: {} }, json: '' })
        } else {
          this.blocks.set(index, { kind: 'pass', index })
          this.emit(e)
        }
        return
      }
      case 'content_block_delta': {
        const block = this.blocks.get(index)
        const delta = (d.delta ?? {}) as { type?: string; text?: string; partial_json?: string }
        if (block?.kind === 'text' && delta.type === 'text_delta') {
          block.text += delta.text ?? ''
          if (block.text.length - block.released >= CHECK_EVERY + HOLD_CHARS)
            await this.release(block, false)
        } else if (block?.kind === 'tool' && delta.type === 'input_json_delta') {
          block.json += delta.partial_json ?? ''
        } else {
          this.emit(e)
        }
        return
      }
      case 'content_block_stop': {
        const block = this.blocks.get(index)
        if (block?.kind === 'text') {
          if (!(await this.release(block, true))) return
          this.textBefore += `${block.text}\n`
          this.emit(e)
        } else if (block?.kind === 'tool') {
          await this.checkTool(block)
        } else {
          this.emit(e)
        }
        return
      }
      case 'message_delta': {
        const usage = d.usage as Record<string, number> | undefined
        if (usage) this.report.usage = { ...(this.report.usage ?? {}), ...usage }
        const delta = (d.delta ?? {}) as { stop_reason?: string }
        if (delta.stop_reason === 'tool_use' && this.toolBlocked && !this.toolAllowed) {
          this.emit({ ...e, data: { ...d, delta: { ...delta, stop_reason: 'end_turn' } } })
          return
        }
        this.emit(e)
        return
      }
      case 'message_stop':
        this.emit(e)
        this.done = true
        return
      default:
        this.emit(e)
    }
  }
}

/**
 * Wraps an upstream SSE body. `report` settles once the stream has ended, been cut short, or the
 * client went away.
 */
export function guardStream<D>(
  upstream: ReadableStream<Uint8Array>,
  hooks: GuardHooks<D>,
): { body: ReadableStream<Uint8Array>; report: Promise<GuardReport<D>> } {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const reader = upstream.getReader()
  let settle: (r: GuardReport<D>) => void = () => {}
  const report = new Promise<GuardReport<D>>((resolve) => {
    settle = resolve
  })
  let guard: Guard<D>

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true
      const emit = (e: SseEvent) => {
        if (open) controller.enqueue(encoder.encode(encodeEvent(e)))
      }
      guard = new Guard(hooks, emit)
      void (async () => {
        let buffer = ''
        try {
          while (!guard.done) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
            let cut = buffer.indexOf('\n\n')
            while (cut !== -1 && !guard.done) {
              const event = parseEvent(buffer.slice(0, cut))
              buffer = buffer.slice(cut + 2)
              if (event) await guard.handle(event)
              cut = buffer.indexOf('\n\n')
            }
          }
          if (guard.done) await reader.cancel().catch(() => {})
        } catch (err) {
          // Fail closed: an inspection error ends the stream instead of passing text unchecked.
          emit({
            event: 'error',
            data: {
              type: 'error',
              error: {
                type: 'api_error',
                message: `Hack?Nah! could not inspect the response: ${err instanceof Error ? err.message : String(err)}`,
              },
            },
          })
          await reader.cancel().catch(() => {})
        } finally {
          open = false
          try {
            controller.close()
          } catch {}
          settle(guard.report)
        }
      })()
    },
    cancel() {
      guard.done = true
      void reader.cancel().catch(() => {})
    },
  })
  return { body, report }
}

type JsonMessage = {
  content?: Record<string, unknown>[]
  stop_reason?: string
  usage?: Record<string, number>
  [key: string]: unknown
}

/** The same checks for a response that was not streamed. */
export async function guardMessage<D>(
  message: JsonMessage,
  hooks: GuardHooks<D>,
): Promise<{ message: JsonMessage; report: GuardReport<D> }> {
  const report: GuardReport<D> = {
    text: '',
    withheld: null,
    detail: null,
    tools: [],
    checkMs: 0,
    usage: message.usage ?? null,
  }
  const started = Date.now()
  const content: Record<string, unknown>[] = []
  const blocks = message.content ?? []
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('\n')
  const verdict = text ? await hooks.checkText(text, true) : null
  report.detail = verdict?.detail ?? null
  if (verdict?.action === 'block') report.withheld = verdict.reason || 'policy'

  let allowed = false
  let blocked = false
  if (report.withheld) {
    // Like a stream cut short: nothing after the refused text, tool calls included.
    report.checkMs = Date.now() - started
    const notice = { type: 'text', text: withheldNotice(report.withheld).trim() }
    return { message: { ...message, content: [notice], stop_reason: 'end_turn' }, report }
  }
  for (const block of blocks) {
    if (block.type === 'text') {
      const out = verdict?.redact ? verdict.redact(String(block.text ?? '')) : block.text
      report.text += String(out ?? '')
      content.push({ ...block, text: out })
    } else if (block.type === 'tool_use') {
      const tool = { id: String(block.id), name: String(block.name), input: block.input }
      const v = await hooks.checkToolUse(tool)
      report.tools.push({ ...tool, ...v })
      if (v.allow) {
        allowed = true
        content.push(block)
      } else {
        blocked = true
        content.push({ type: 'text', text: blockedToolNotice(tool.name, v.reason || 'policy') })
      }
    } else {
      content.push(block)
    }
  }
  report.checkMs = Date.now() - started
  const stopReason =
    message.stop_reason === 'tool_use' && blocked && !allowed ? 'end_turn' : message.stop_reason
  return { message: { ...message, content, stop_reason: stopReason }, report }
}
