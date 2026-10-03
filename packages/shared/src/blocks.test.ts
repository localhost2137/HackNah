import { describe, expect, it } from 'vitest'
import { blockOf, blocks, palette } from './blocks.ts'
import { type EvaluationInput, evaluateGraph, type RequestSignals } from './engine.ts'
import type { ApprovalMethod } from './events.ts'
import {
  type CheckConfig,
  type Condition,
  nodeOutputs,
  type PolicyGraph,
  policyGraph,
  policyNode,
} from './workflow.ts'

const at = { x: 0, y: 0 }
const toolCall: EvaluationInput = {
  kind: 'tool_call',
  text: '{}',
  toolName: 'mail__email_send',
  deviceStatus: 'trusted',
}

/** Runs one check on its own and returns how the request left it. */
async function leave(check: CheckConfig, input: Partial<EvaluationInput> = {}) {
  const graph: PolicyGraph = {
    fallback: 'block',
    nodes: [
      { id: 'start', type: 'trigger', position: at },
      { id: 'check', type: 'check', position: at, enabled: true, check },
    ],
    edges: [{ id: 'e', source: 'start', sourceHandle: 'next', target: 'check' }],
  }
  const result = await evaluateGraph(graph, { ...toolCall, ...input })
  return result.checks[0]!
}

const withSignals = (signals: RequestSignals) => ({ signals })

async function approve(method: ApprovalMethod, signals?: RequestSignals) {
  const graph: PolicyGraph = {
    fallback: 'block',
    nodes: [
      { id: 'start', type: 'trigger', position: at },
      {
        id: 'approval',
        type: 'decision',
        position: at,
        action: 'require_approval',
        method,
        timeoutSec: 120,
        reason: '',
      },
    ],
    edges: [{ id: 'e', source: 'start', sourceHandle: 'next', target: 'approval' }],
  }
  return evaluateGraph(graph, { ...toolCall, signals })
}

describe('block registry', () => {
  it('creates a valid node for every block, with the outputs it declares', () => {
    for (const block of palette) {
      const node = policyNode.parse({ id: block.id, position: at, ...block.create() })
      expect(blockOf(node).id).toBe(block.id)
      expect(nodeOutputs(node)).toEqual(block.outputs.map((o) => o.id))
      if (block.through) expect(nodeOutputs(node)).toContain(block.through)
    }
  })

  it('reads workflows saved before approvals had a method as admin approvals', () => {
    const saved = {
      fallback: 'block',
      nodes: [
        {
          id: 'approve',
          type: 'decision',
          position: at,
          action: 'require_approval',
          timeoutSec: 300,
          reason: '',
        },
      ],
      edges: [],
    }
    const node = policyGraph.parse(saved).nodes[0]!
    expect(blockOf(node)).toBe(blocks.approve_admin)
  })
})

describe('approval methods', () => {
  it('holds an admin approval whatever the device proves', async () => {
    const r = await approve('admin', { presenceVerified: true, approvedChallenge: true })
    expect(r.decision).toBe('pending')
    expect(r.approvalMethod).toBe('admin')
  })

  it('asks for Touch ID and lets a request with a valid proof through', async () => {
    const asked = await approve('touchid', { presenceCapable: true })
    expect(asked.decision).toBe('pending')
    expect(asked.approvalMethod).toBe('touchid')
    expect(asked.reasons).toContain('Needs Touch ID on the device')
    const proven = await approve('touchid', { presenceVerified: true })
    expect(proven.decision).toBe('allow')
    expect(proven.approvalMethod).toBeNull()
    expect(proven.checks.at(-1)?.reason).toBe('Touch ID verified')
  })

  it('sends a device without Touch ID to the browser instead', async () => {
    const r = await approve('touchid', { presenceCapable: false })
    expect(r.decision).toBe('pending')
    expect(r.approvalMethod).toBe('browser')
  })

  it('accepts a browser approval of the action for every device-side method', async () => {
    for (const method of ['confirm', 'touchid', 'browser'] as const) {
      expect((await approve(method)).decision).toBe('pending')
      expect((await approve(method, { approvedChallenge: true })).decision).toBe('allow')
    }
  })

  it('does not take a Touch ID proof as a browser sign-in', async () => {
    expect((await approve('browser', { presenceVerified: true })).decision).toBe('pending')
  })

  it('accepts a confirmation only for the confirm method', async () => {
    expect((await approve('confirm', { confirmed: true })).decision).toBe('allow')
    expect((await approve('touchid', { confirmed: true })).decision).toBe('pending')
  })
})

describe('plugin checks', () => {
  it('flags write calls shortly after the session read untrusted content', async () => {
    const check: CheckConfig = { type: 'untrusted_content', windowMinutes: 10 }
    const recent = await leave(
      check,
      withSignals({ untrustedContentMinutesAgo: 3, untrustedSource: 'email_read_inbox' }),
    )
    expect(recent.branch).toBe('tainted')
    expect(recent.reason).toContain('email_read_inbox')
    expect((await leave(check, withSignals({ untrustedContentMinutesAgo: 30 }))).branch).toBe(
      'pass',
    )
    expect((await leave(check, withSignals({ untrustedContentMinutesAgo: null }))).outcome).toBe(
      'pass',
    )
    expect((await leave(check)).outcome).toBe('skipped')
  })

  it('never treats missing or unconfirmed posture as healthy', async () => {
    const check: CheckConfig = { type: 'posture', minScore: 50 }
    expect((await leave(check)).branch).toBe('unknown')
    expect((await leave(check, withSignals({ postureStatus: 'ok' }))).branch).toBe('unknown')
    expect(
      (await leave(check, withSignals({ postureStatus: 'stale', postureScore: 90 }))).branch,
    ).toBe('unknown')
    expect(
      (await leave(check, withSignals({ postureStatus: 'ok', postureScore: 35 }))).branch,
    ).toBe('low')
    expect(
      (await leave(check, withSignals({ postureStatus: 'compromised', postureScore: 90 }))).branch,
    ).toBe('compromised')
    expect(
      (await leave(check, withSignals({ postureStatus: 'ok', postureScore: 85 }))).branch,
    ).toBe('pass')
  })

  it('fails when a required OS protection is off', async () => {
    const check: CheckConfig = { type: 'os_posture', require: ['fv', 'sip'] }
    const off = await leave(check, withSignals({ osPosture: { fv: false, sip: true, gk: false } }))
    expect(off.branch).toBe('fail')
    expect(off.reason).toBe('FileVault off')
    expect(
      (await leave(check, withSignals({ osPosture: { fv: true, sip: null, gk: false } }))).branch,
    ).toBe('pass')
    expect((await leave(check)).outcome).toBe('skipped')
  })

  it('separates a new network from impossible travel', async () => {
    const check: CheckConfig = { type: 'network', maxTravelKmh: 900 }
    expect((await leave(check, withSignals({ ipKnown: false }))).branch).toBe('new_network')
    expect((await leave(check, withSignals({ ipKnown: false, travelKmh: 9800 }))).branch).toBe(
      'travel',
    )
    expect((await leave(check, withSignals({ ipKnown: true, travelKmh: 40 }))).branch).toBe('pass')
  })

  it('checks the hook record, idle time and tool pin', async () => {
    expect((await leave({ type: 'hook' }, withSignals({ hookCorrelated: false }))).branch).toBe(
      'fail',
    )
    expect((await leave({ type: 'hook' }, withSignals({ hookCorrelated: true }))).outcome).toBe(
      'pass',
    )
    const prompt = { kind: 'model_request' as const, toolName: null }
    expect(
      (await leave({ type: 'hook' }, { ...prompt, ...withSignals({ hookCorrelated: false }) }))
        .outcome,
    ).toBe('skipped')
    const idle: CheckConfig = { type: 'idle', maxMinutes: 30 }
    expect((await leave(idle, withSignals({ userIdleMinutes: 45 }))).branch).toBe('idle')
    expect((await leave(idle, withSignals({ userIdleMinutes: 2 }))).branch).toBe('pass')
    expect(
      (await leave({ type: 'tool_pinning' }, withSignals({ definitionChanged: true }))).branch,
    ).toBe('changed')
    expect(
      (await leave({ type: 'tool_pinning' }, withSignals({ definitionChanged: false }))).outcome,
    ).toBe('pass')
  })

  it('refuses arguments that do not match their rule', async () => {
    const check: CheckConfig = {
      type: 'arguments',
      rules: [
        {
          tool: 'email_send',
          argument: 'to',
          pattern: '@company\\.com$',
          message: 'email_send may only send to @company.com addresses',
        },
      ],
    }
    const outside = await leave(check, { toolArguments: { to: 'someone@evil.example' } })
    expect(outside.branch).toBe('fail')
    expect(outside.reason).toBe('email_send may only send to @company.com addresses')
    expect((await leave(check, { toolArguments: { to: 'dev@company.com' } })).branch).toBe('pass')
    const mixed = await leave(check, {
      toolArguments: { to: ['dev@company.com', 'x@evil.example'] },
    })
    expect(mixed.branch).toBe('fail')
    expect(
      (await leave(check, { toolName: 'crm__export', toolArguments: { to: 'x@evil.example' } }))
        .branch,
    ).toBe('pass')
  })

  it('fails closed on an invalid argument pattern', async () => {
    const check: CheckConfig = {
      type: 'arguments',
      rules: [{ tool: '*', argument: 'to', pattern: '(', message: '' }],
    }
    const r = await leave(check, { toolArguments: { to: 'dev@company.com' } })
    expect(r.outcome).toBe('error')
    expect(r.branch).toBe('fail')
  })
})

describe('routing on plugin signals', () => {
  const route = (conditions: Condition[]): PolicyGraph => ({
    fallback: 'block',
    nodes: [
      { id: 'start', type: 'trigger', position: at },
      { id: 'route', type: 'match', position: at, label: '', mode: 'all', conditions },
    ],
    edges: [{ id: 'e', source: 'start', sourceHandle: 'next', target: 'route' }],
  })
  const branch = async (conditions: Condition[], input: Partial<EvaluationInput>) =>
    (await evaluateGraph(route(conditions), { ...toolCall, ...input })).checks[0]!.branch

  it('routes by tool tier', async () => {
    const destructive: Condition[] = [{ field: 'tier', values: ['destructive'] }]
    expect(await branch(destructive, { toolTier: 'destructive' })).toBe('match')
    expect(await branch(destructive, { toolTier: 'read' })).toBe('else')
    expect(await branch(destructive, {})).toBe('else')
  })

  it('routes by where the device keeps its key', async () => {
    const software: Condition[] = [{ field: 'keyStorage', values: ['software'] }]
    expect(await branch(software, withSignals({ keyStorage: 'software' }))).toBe('match')
    expect(await branch(software, withSignals({ keyStorage: 'secure_enclave' }))).toBe('else')
  })
})
