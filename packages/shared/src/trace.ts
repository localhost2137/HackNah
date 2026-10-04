import type { MessagesRequest } from './anthropic.ts'
import { randomId, sha256Hex } from './crypto.ts'

/**
 * Claude Code's id for one user prompt, sent with every model request the prompt leads to
 * (subagents included). Only present from 2.1.283 on with `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`.
 */
export const HEADER_CC_PROMPT_ID = 'x-claude-code-prompt-id'

/** The trace the gateway filed a model request under, returned to the client. */
export const HEADER_TRACE_ID = 'x-acl-trace-id'

const PROMPT_ID = /^[\w.:-]{8,128}$/

/**
 * The prompt that started the turn a request belongs to: the newest user message that is not a
 * set of tool results. Follow-up requests of the turn carry the same message at the same index.
 */
export function turnPrompt(body: MessagesRequest): { index: number; text: string } | null {
  const messages = body.messages ?? []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'user') continue
    if (typeof message.content === 'string') return { index, text: message.content }
    if (message.content.some((b) => b.type === 'tool_result')) continue
    const text = message.content
      .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n')
    return { index, text }
  }
  return null
}

/**
 * The trace of a model request. One trace is one user turn: the prompt and everything it leads
 * to until the next prompt.
 *
 * Claude Code's prompt id decides when it is sent. Otherwise the trace is derived from the
 * session and the prompt that started the turn, so every request of the turn gets the same id
 * without the gateway keeping state, and parallel or retried requests cannot split a trace.
 * A request with neither a session nor a prompt gets a trace of its own.
 *
 * Ids are hashed together with the user, so one user cannot file requests under another's trace.
 */
export async function traceIdFor(request: {
  userId: string
  sessionId: string | null
  promptId?: string | null
  body: MessagesRequest
}): Promise<string> {
  const { userId, sessionId, promptId, body } = request
  if (promptId && PROMPT_ID.test(promptId))
    return hashed([userId, sessionId ?? '', 'prompt', promptId])
  const prompt = sessionId ? turnPrompt(body) : null
  if (!sessionId || !prompt) return randomId('trc')
  return hashed([userId, sessionId, 'turn', String(prompt.index), prompt.text])
}

async function hashed(parts: string[]): Promise<string> {
  return `trc_${(await sha256Hex(JSON.stringify(parts))).slice(0, 20)}`
}

/** Short form for tables; the full id is what gets copied and searched. */
export function shortTraceId(traceId: string): string {
  return traceId.replace(/^trc_/, '').slice(0, 8)
}
