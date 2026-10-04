import { describe, expect, it } from 'vitest'
import type { MessagesRequest } from './anthropic.ts'
import { shortTraceId, traceIdFor, turnPrompt } from './trace.ts'

const toolUse = {
  role: 'assistant' as const,
  content: [{ type: 'tool_use', id: 't1', name: 'Bash' }],
}
const toolResult = {
  role: 'user' as const,
  content: [
    { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
    { type: 'text', text: '<system-reminder>note</system-reminder>' },
  ],
}
const first: MessagesRequest = { messages: [{ role: 'user', content: 'fix the test' }] }
const followUp: MessagesRequest = { messages: [...first.messages!, toolUse, toolResult] }
const secondPrompt: MessagesRequest = {
  messages: [
    ...followUp.messages!,
    { role: 'assistant', content: 'Done.' },
    { role: 'user', content: [{ type: 'text', text: 'fix the test' }] },
  ],
}

const who = { userId: 'u1', sessionId: 'session-1' }

describe('turnPrompt', () => {
  it('finds the prompt behind tool results', () => {
    expect(turnPrompt(first)).toEqual({ index: 0, text: 'fix the test' })
    expect(turnPrompt(followUp)).toEqual({ index: 0, text: 'fix the test' })
    expect(turnPrompt(secondPrompt)).toEqual({ index: 4, text: 'fix the test' })
  })

  it('returns null without a prompt', () => {
    expect(turnPrompt({})).toBeNull()
    expect(turnPrompt({ messages: [toolUse, toolResult] })).toBeNull()
  })
})

describe('traceIdFor', () => {
  it('keeps one trace for a prompt and its tool-result follow-ups', async () => {
    const id = await traceIdFor({ ...who, body: first })
    expect(id).toMatch(/^trc_[0-9a-f]{20}$/)
    expect(await traceIdFor({ ...who, body: followUp })).toBe(id)
  })

  it('starts a new trace on the next prompt, even with the same text', async () => {
    const id = await traceIdFor({ ...who, body: first })
    expect(await traceIdFor({ ...who, body: secondPrompt })).not.toBe(id)
  })

  it('separates sessions and users', async () => {
    const id = await traceIdFor({ ...who, body: first })
    expect(await traceIdFor({ ...who, sessionId: 'session-2', body: first })).not.toBe(id)
    expect(await traceIdFor({ ...who, userId: 'u2', body: first })).not.toBe(id)
  })

  it("uses Claude Code's prompt id when it is sent", async () => {
    const promptId = '0b9f6c1e-6c1d-4d0a-9d55-2f3a1c0e7a11'
    const id = await traceIdFor({ ...who, promptId, body: first })
    // A subagent's request has other messages but the same prompt id.
    const subagent: MessagesRequest = { messages: [{ role: 'user', content: 'explore the repo' }] }
    expect(await traceIdFor({ ...who, promptId, body: subagent })).toBe(id)
    expect(await traceIdFor({ ...who, promptId, body: secondPrompt })).toBe(id)
    expect(id).not.toBe(await traceIdFor({ ...who, body: first }))
    expect(await traceIdFor({ ...who, userId: 'u2', promptId, body: first })).not.toBe(id)
  })

  it('ignores a malformed prompt id', async () => {
    const id = await traceIdFor({ ...who, body: first })
    expect(await traceIdFor({ ...who, promptId: 'a b\n', body: first })).toBe(id)
  })

  it('gives a request without a session its own trace', async () => {
    const a = await traceIdFor({ userId: 'u1', sessionId: null, body: first })
    const b = await traceIdFor({ userId: 'u1', sessionId: null, body: first })
    expect(a).toMatch(/^trc_/)
    expect(a).not.toBe(b)
  })
})

describe('shortTraceId', () => {
  it('drops the prefix and keeps eight characters', () => {
    expect(shortTraceId('trc_0123456789abcdef0123')).toBe('01234567')
  })
})
