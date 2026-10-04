import { describe, expect, it } from 'vitest'
import {
  anthropicErrorFromOpenAI,
  fromOpenAIResponse,
  openAIStreamToAnthropic,
  toOpenAIRequest,
} from './openai-compat.ts'

describe('toOpenAIRequest', () => {
  it('maps system, tool calls, tool results and tools', () => {
    const out = toOpenAIRequest(
      {
        model: 'claude-x',
        system: [{ type: 'text', text: 'You are Claude Code.' }],
        max_tokens: 1000,
        stream: true,
        tool_choice: { type: 'auto' },
        tools: [
          { name: 'Bash', description: 'Run a command', input_schema: { type: 'object' } },
          { type: 'web_search_20250305', name: 'web_search' },
        ],
        messages: [
          { role: 'user', content: 'list files' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: '…' },
              { type: 'text', text: 'Sure.' },
              { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_1',
                content: [{ type: 'text', text: 'a.txt' }],
              },
              { type: 'text', text: 'thanks' },
            ],
          },
        ],
      },
      'qwen3-coder:30b',
    )
    expect(out).toMatchObject({
      model: 'qwen3-coder:30b',
      max_tokens: 1000,
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: 'auto',
      messages: [
        { role: 'system', content: 'You are Claude Code.' },
        { role: 'user', content: 'list files' },
        {
          role: 'assistant',
          content: 'Sure.',
          tool_calls: [
            {
              id: 'tu_1',
              type: 'function',
              function: { name: 'Bash', arguments: '{"command":"ls"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'tu_1', content: 'a.txt' },
        { role: 'user', content: 'thanks' },
      ],
    })
    // Server tools have no schema and no OpenAI equivalent.
    expect(out.tools).toEqual([
      {
        type: 'function',
        function: { name: 'Bash', description: 'Run a command', parameters: { type: 'object' } },
      },
    ])
  })
})

describe('fromOpenAIResponse', () => {
  it('maps text, tool calls, stop reason and cached tokens', () => {
    const msg = fromOpenAIResponse(
      {
        id: 'chatcmpl-1',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: 'Running it.',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'Bash', arguments: '{"command":"ls"}' },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 40,
          prompt_tokens_details: { cached_tokens: 1000 },
        },
      },
      'm',
    )
    expect(msg).toMatchObject({
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Running it.' },
        { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } },
      ],
      usage: { input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 1000 },
    })
  })

  it('turns an OpenAI error into an Anthropic one', () => {
    expect(anthropicErrorFromOpenAI(429, '{"error":{"message":"slow down"}}')).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'slow down' },
    })
  })
})

describe('openAIStreamToAnthropic', () => {
  const stream = (chunks: unknown[]) => {
    const encoder = new TextEncoder()
    return new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(encoder.encode(`data: ${JSON.stringify(ch)}\n\n`))
        c.enqueue(encoder.encode('data: [DONE]\n\n'))
        c.close()
      },
    })
  }
  const events = async (s: ReadableStream<Uint8Array>) =>
    (await new Response(s).text())
      .split('\n\n')
      .filter(Boolean)
      .map((e) => JSON.parse(e.split('\n')[1]!.slice(5)))

  it('re-emits text and a streamed tool call as Anthropic events', async () => {
    const out = await events(
      openAIStreamToAnthropic(
        stream([
          { id: 'c1', choices: [{ delta: { content: 'Let me ' } }] },
          { id: 'c1', choices: [{ delta: { content: 'check.' } }] },
          {
            id: 'c1',
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_1', function: { name: 'Bash', arguments: '{"comm' } },
                  ],
                },
              },
            ],
          },
          {
            id: 'c1',
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } },
            ],
          },
          { id: 'c1', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          { id: 'c1', choices: [], usage: { prompt_tokens: 50, completion_tokens: 7 } },
        ]),
        'm',
      ),
    )
    expect(out.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(out[5].content_block).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'Bash' })
    const json = out
      .filter((e) => e.delta?.type === 'input_json_delta')
      .map((e) => e.delta.partial_json)
      .join('')
    expect(JSON.parse(json)).toEqual({ command: 'ls' })
    expect(out[9]).toMatchObject({
      delta: { stop_reason: 'tool_use' },
      usage: { input_tokens: 50, output_tokens: 7 },
    })
  })

  it('ends with an error event when the upstream reports one', async () => {
    const out = await events(
      openAIStreamToAnthropic(stream([{ error: { message: 'model not loaded' } }]), 'm'),
    )
    expect(out.at(-1)).toMatchObject({ type: 'error', error: { message: 'model not loaded' } })
  })
})
