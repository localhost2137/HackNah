import { describe, expect, it } from 'vitest'
import { callJudge, parseVerdict } from './judge.ts'

const step = {
  type: 'judge' as const,
  endpoint: 'http://judge.local/v1/chat/completions',
  model: 'llama-guard',
  threshold: 0.7,
  timeoutMs: 1000,
  instructions: '',
}

describe('judge', () => {
  it('parses and clamps verdicts wrapped in prose', () => {
    expect(parseVerdict('Sure: {"risk": 1.4, "reason": "exfil"}')).toEqual({
      score: 1,
      reason: 'exfil',
    })
    expect(() => parseVerdict('no json')).toThrow()
  })

  it('sends the API key and tool call to the endpoint', async () => {
    let seen: { auth: string | null; body: { messages: { content: string }[] } } | undefined
    const fetchImpl = (async (_: RequestInfo | URL, init?: RequestInit) => {
      seen = {
        auth: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body)),
      }
      return Response.json({ choices: [{ message: { content: '{"risk":0.2,"reason":"ok"}' } }] })
    }) as typeof fetch
    const verdict = await callJudge(
      step,
      { kind: 'tool_call', text: '{"cmd":"ls"}', toolName: 'Bash', deviceStatus: 'trusted' },
      { apiKey: 'secret', fetch: fetchImpl },
    )
    expect(verdict.score).toBe(0.2)
    expect(seen?.auth).toBe('Bearer secret')
    expect(seen?.body.messages[1]?.content).toContain('Tool call: Bash')
  })
})
