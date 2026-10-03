import { describe, expect, it } from 'vitest'
import { extractTurnText, mapRequestText, parseUsage, sessionFromMetadata } from './anthropic.ts'
import { parseVerdict } from './judge.ts'

describe('anthropic helpers', () => {
  const body = {
    model: 'claude',
    metadata: { user_id: 'user_abc_account__session_0f8b2a9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b' },
    messages: [
      { role: 'user' as const, content: 'old turn' },
      { role: 'assistant' as const, content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
      {
        role: 'user' as const,
        content: [
          { type: 'tool_result', content: [{ type: 'text', text: 'ls output' }] },
          { type: 'text', text: 'now delete it' },
        ],
      },
    ],
  }

  it('extracts only the latest user turn including tool results', () => {
    expect(extractTurnText(body)).toBe('ls output\nnow delete it')
  })

  it('reads the Claude Code session from metadata', () => {
    expect(sessionFromMetadata(body)).toBe('0f8b2a9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b')
  })

  it('maps every text block', () => {
    const mapped = mapRequestText(body, (t) => t.toUpperCase())
    expect(extractTurnText(mapped)).toBe('LS OUTPUT\nNOW DELETE IT')
    expect(mapped.messages?.[0]?.content).toBe('OLD TURN')
  })

  it('parses usage from SSE and JSON', () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":120,"output_tokens":1}}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"output_tokens":42}}',
    ].join('\n')
    expect(parseUsage(sse, true)).toEqual({ inputTokens: 120, outputTokens: 42 })
    expect(parseUsage('{"usage":{"input_tokens":5,"output_tokens":6}}', false)).toEqual({
      inputTokens: 5,
      outputTokens: 6,
    })
  })

  it('parses judge verdicts and clamps scores', () => {
    expect(parseVerdict('```json\n{"risk": 1.4, "reason": "x"}\n```')).toEqual({
      score: 1,
      reason: 'x',
    })
    expect(() => parseVerdict('nope')).toThrow()
  })
})
