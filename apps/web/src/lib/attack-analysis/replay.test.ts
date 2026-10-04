import { type ActiveWorkflow, defaultWorkflow } from '@acl/shared'
import { describe, expect, it } from 'vitest'
import { trafficTemplates } from './catalog.ts'
import { classify, decisionMatrix, type Persona, replayTraffic } from './replay.ts'

const persona: Persona = {
  id: 'synthetic-analyst',
  groupIds: ['engineering'],
  mcpServerId: null,
  resourceIds: [],
  model: 'test-model',
}
const workflow: ActiveWorkflow = {
  id: 'wf-test',
  name: 'Test policy',
  version: 7,
  groupIds: [],
  definition: defaultWorkflow,
}

describe('attack analysis', () => {
  it('does not count approvals or unavailable evaluation as successful detection', () => {
    expect(classify('block', 'approval')).toBe('review')
    expect(classify('block', 'inconclusive')).toBe('inconclusive')
    expect(classify('block', 'allow')).toBe('missed')
    expect(classify('allow', 'block')).toBe('overblocked')
  })

  it('uses actual policy execution and conserves every event in the matrix', async () => {
    const events = [
      { ...trafficTemplates[0]!, input: { ...trafficTemplates[0]!.input, text: 'rm -rf /' } },
      trafficTemplates[1]!,
    ]
    const results = await replayTraffic(events, [workflow], persona)
    expect(results.map((r) => r.actual)).toEqual(['block', 'allow'])
    expect(results[0]!.result.workflows[0]!.version).toBe(7)
    expect(results[0]!.input.groupIds).toEqual(['engineering'])
    const matrix = decisionMatrix(results)
    expect(matrix[0]!.block).toBe(1)
    expect(matrix[1]!.allow).toBe(1)
    expect(matrix.reduce((n, r) => n + r.block + r.allow + r.approval + r.inconclusive, 0)).toBe(
      events.length,
    )
  })

  it('reports uncovered attacks as allowed and applies persona group scope', async () => {
    const results = await replayTraffic(
      [trafficTemplates[0]!],
      [{ ...workflow, groupIds: ['finance'] }],
      persona,
    )
    expect(results[0]!.actual).toBe('allow')
    expect(results[0]!.outcome).toBe('missed')
    expect(results[0]!.result.workflows).toEqual([])
  })

  it('keeps a missing judge inconclusive even when its error branch blocks', async () => {
    const definition = structuredClone(defaultWorkflow)
    const keywords = definition.nodes.find(
      (n) => n.type === 'check' && n.check.type === 'keywords',
    )!
    if (keywords.type !== 'check') throw new Error('Expected check')
    keywords.check = {
      type: 'judge',
      instructions: 'Assess risk',
      threshold: 0.5,
      model: 'test',
      endpoint: 'https://judge.example.invalid',
      timeoutMs: 1000,
    }
    const results = await replayTraffic(
      [trafficTemplates[0]!],
      [{ ...workflow, definition }],
      persona,
    )
    expect(results[0]!.result.checks.some((c) => c.outcome === 'error')).toBe(true)
    expect(results[0]!.actual).toBe('inconclusive')
    expect(results[0]!.outcome).toBe('inconclusive')
  })

  it('does not mutate fixture inputs or the policy snapshot', async () => {
    const before = JSON.stringify({ trafficTemplates, workflow, persona })
    await replayTraffic(trafficTemplates, [workflow], persona)
    expect(JSON.stringify({ trafficTemplates, workflow, persona })).toBe(before)
  })
})
