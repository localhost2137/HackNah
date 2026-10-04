import { defaultGuardrail } from '@acl/shared'
import { describe, expect, it } from 'vitest'
import { benchmarkRun, latencyStats, percentile } from './benchmark.ts'
import { base } from './catalog.ts'

describe('latency statistics', () => {
  it('takes nearest-rank percentiles', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(sorted, 50)).toBe(50)
    expect(percentile(sorted, 99)).toBe(99)
    expect(percentile(sorted, 100)).toBe(100)
    expect(percentile([], 50)).toBe(0)
  })
  it('summarises unsorted values', () => {
    expect(latencyStats([3, 1, 2])).toEqual({ count: 3, mean: 2, p50: 2, p95: 3, p99: 3, max: 3 })
  })
  it('times every request of a run by stage', async () => {
    const results = (['model_request', 'tool_call'] as const).map((kind) => ({
      input: { ...base, kind, text: 'ls -la' },
    }))
    const timings = await benchmarkRun(
      {
        guardrails: [
          { id: 'w', name: 'W', version: 1, groupIds: [], definition: defaultGuardrail },
        ],
        results: results as never,
      },
      {},
    )
    expect(timings.map((t) => t.stage)).toEqual(['model_request', 'tool_call'])
    expect(timings.every((t) => t.ms > 0)).toBe(true)
  })
})
