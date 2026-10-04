import { describe, expect, it } from 'vitest'
import { combineResults, evaluateGraph } from './engine.ts'
import { defaultGuardrail, type PolicyGraph } from './guardrail.ts'
import { guardrailPath } from './path.ts'

const input = {
  kind: 'model_request' as const,
  text: 'hello',
  toolName: null,
  deviceStatus: 'trusted' as const,
}

const judged: PolicyGraph = {
  fallback: 'block',
  nodes: [
    { id: 'start', type: 'trigger', position: { x: 0, y: 0 }, stages: [] },
    {
      id: 'judge',
      type: 'check',
      position: { x: 0, y: 0 },
      enabled: true,
      check: {
        type: 'judge',
        endpoint: 'http://judge.test/v1/chat/completions',
        model: 'm',
        threshold: 0.7,
        timeoutMs: 1000,
        instructions: '',
      },
    },
    {
      id: 'allow',
      type: 'decision',
      position: { x: 0, y: 0 },
      action: 'allow',
      method: 'admin',
      timeoutSec: 300,
      reason: '',
    },
  ],
  edges: [
    { id: 'a', source: 'start', sourceHandle: 'next', target: 'judge' },
    { id: 'b', source: 'judge', sourceHandle: 'pass', target: 'allow' },
  ],
}

describe('guardrailPath', () => {
  it('follows an allowed request to its decision', async () => {
    const { checks } = await evaluateGraph(defaultGuardrail, input)
    const path = guardrailPath(defaultGuardrail, checks)
    expect([...path.nodes]).toEqual(['start', 'fingerprint', 'keywords', 'allow'])
    expect([...path.edges]).toEqual(['e1', 'e2', 'e5'])
    expect(path.endNodeId).toBe('allow')
    expect(path.fallback).toBeNull()
    expect(path.steps.get('keywords')).toMatchObject({ order: 2, check: { outcome: 'pass' } })
  })

  it('takes the failing output of a check to the block', async () => {
    const { checks } = await evaluateGraph(defaultGuardrail, { ...input, text: 'rm -rf / now' })
    const path = guardrailPath(defaultGuardrail, checks)
    expect([...path.edges]).toEqual(['e1', 'e2', 'e6'])
    expect(path.endNodeId).toBe('block')
    expect(path.nodes.has('allow')).toBe(false)
    expect(path.steps.get('keywords')?.check.reason).toContain('rm -rf /')
  })

  it('keeps a stage-skipped check on the path', async () => {
    const { checks } = await evaluateGraph(defaultGuardrail, { ...input, kind: 'tool_result' })
    const path = guardrailPath(defaultGuardrail, checks)
    expect(path.steps.get('fingerprint')?.check.outcome).toBe('skipped')
    expect(path.edges.has('e2')).toBe(true)
    expect(path.endNodeId).toBe('allow')
  })

  it('stops at a check that errored and reports the fallback', async () => {
    const { checks, decision } = await evaluateGraph(judged, input, {
      judge: async () => {
        throw new Error('timeout')
      },
    })
    expect(decision).toBe('block')
    const path = guardrailPath(judged, checks)
    expect([...path.nodes]).toEqual(['start', 'judge'])
    expect([...path.edges]).toEqual(['a'])
    expect(path.endNodeId).toBe('judge')
    expect(path.fallback?.reason).toContain('guardrail fallback: block')
  })

  it('stops at an output with nothing connected', async () => {
    const dangling = { ...judged, edges: judged.edges.slice(0, 1) }
    const { checks } = await evaluateGraph(dangling, input, {
      judge: async () => ({ score: 0.1, reason: 'fine' }),
    })
    const path = guardrailPath(dangling, checks)
    expect(path.endNodeId).toBe('judge')
    expect([...path.edges]).toEqual(['a'])
    expect(path.fallback?.reason).toContain('Nothing connected')
  })

  it("picks one guardrail's checks out of an event that ran several", async () => {
    const combined = combineResults([
      {
        guardrail: { id: 'g1', name: 'Default', version: 1 },
        result: await evaluateGraph(defaultGuardrail, { ...input, deviceStatus: 'mismatch' }),
      },
      {
        guardrail: { id: 'g2', name: 'Judge', version: 3 },
        result: await evaluateGraph(judged, input, {
          judge: async () => ({ score: 0.1, reason: 'fine' }),
        }),
      },
    ])
    const first = guardrailPath(defaultGuardrail, combined.checks, 'g1')
    expect([...first.edges]).toEqual(['e1', 'e4'])
    expect(first.endNodeId).toBe('block')
    const second = guardrailPath(judged, combined.checks, 'g2')
    expect([...second.nodes]).toEqual(['start', 'judge', 'allow'])
    expect(second.steps.get('judge')?.check.score).toBe(0.1)
  })

  it('lists steps that are not in the graph and marks nothing for no checks', async () => {
    const { checks } = await evaluateGraph(defaultGuardrail, input)
    const path = guardrailPath(judged, checks)
    expect(path.unmatched.map((c) => c.stepId)).toEqual(['fingerprint', 'keywords'])
    expect([...path.nodes]).toEqual(['start', 'allow'])
    const empty = guardrailPath(defaultGuardrail, [])
    expect(empty.nodes.size).toBe(0)
    expect(empty.endNodeId).toBeNull()
  })
})
