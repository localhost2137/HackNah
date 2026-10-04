import { type ActiveGuardrail, type PolicyGraph, recommendedGuardrails } from '@acl/shared'
import { describe, expect, it } from 'vitest'
import { actionHash, sha256B64Url } from './canonical.ts'
import { buildPolicy, healthySignals, type ListedTool, toolLevels } from './policy.ts'
import { travelKmh } from './store.ts'
import { pluginCall } from './tool-call.ts'

const guardrails: ActiveGuardrail[] = recommendedGuardrails({ prompts: null, indirect: null }).map(
  (g) => ({ id: g.id, name: g.name, version: 1, groupIds: [], definition: g.graph }),
)

const tool = (name: string, tier: ListedTool['tier'], pin: string | null = null): ListedTool => ({
  tool: { name, description: name, inputSchema: { type: 'object' } },
  serverId: 'srv',
  tier,
  resourceIds: [],
  pin,
})

const tools = [
  tool('crm__search', 'read'),
  tool('crm__export', 'write'),
  tool('repo__delete_branch', 'destructive'),
]

const levels = (presenceCapable: boolean, extra: ActiveGuardrail[] = []) =>
  toolLevels([...guardrails, ...extra], tools, {
    groupIds: [],
    deviceStatus: 'trusted',
    signals: healthySignals({ keyStorage: 'secure_enclave', presenceCapable }),
  })

const onTool = (
  id: string,
  pattern: string,
  action: 'block' | 'require_approval',
  method: 'admin' | 'confirm' | 'browser' = 'admin',
): ActiveGuardrail => {
  const at = { x: 0, y: 0 }
  const definition: PolicyGraph = {
    fallback: 'block',
    nodes: [
      { id: 'start', type: 'trigger', position: at, stages: ['tool_call'] },
      {
        id: 'is',
        type: 'condition',
        position: at,
        condition: { field: 'tool', values: [pattern] },
      },
      { id: 'hit', type: 'decision', position: at, action, method, timeoutSec: 120, reason: '' },
      {
        id: 'ok',
        type: 'decision',
        position: at,
        action: 'allow',
        method: 'admin',
        timeoutSec: 300,
        reason: '',
      },
    ],
    edges: [
      { id: 'a', source: 'start', sourceHandle: 'next', target: 'is' },
      { id: 'b', source: 'is', sourceHandle: 'yes', target: 'hit' },
      { id: 'c', source: 'is', sourceHandle: 'no', target: 'ok' },
    ],
  }
  return { id, name: id, version: 1, groupIds: [], definition }
}

describe('toolLevels', () => {
  it('forecasts the recommended guardrails for a device with Touch ID', async () => {
    expect(Object.fromEntries(await levels(true))).toEqual({
      crm__search: 'none',
      crm__export: 'none',
      repo__delete_branch: 'touchid',
    })
  })

  it('asks in the browser where the device has no Touch ID key', async () => {
    expect((await levels(false)).get('repo__delete_branch')).toBe('browser')
  })

  it('hides a tool the guardrails always block', async () => {
    const out = await levels(true, [onTool('g1', 'crm__export', 'block')])
    expect(out.get('crm__export')).toBe('hide')
    expect(out.get('crm__search')).toBe('none')
  })

  it('takes the device-side method a guardrail asks for', async () => {
    expect(
      (await levels(true, [onTool('g1', 'crm__export', 'require_approval', 'confirm')])).get(
        'crm__export',
      ),
    ).toBe('confirm')
    expect(
      (await levels(true, [onTool('g1', 'crm__*', 'require_approval', 'browser')])).get(
        'crm__search',
      ),
    ).toBe('browser')
  })

  it('leaves an admin approval to the dashboard queue', async () => {
    const out = await levels(true, [onTool('g1', 'crm__export', 'require_approval', 'admin')])
    expect(out.get('crm__export')).toBe('none')
  })

  it('never calls the judge or counts a limit', async () => {
    const judged = guardrails.map((g) => ({
      ...g,
      definition: {
        ...g.definition,
        nodes: g.definition.nodes.map((n) =>
          n.type === 'check' && n.check.type === 'keywords'
            ? {
                ...n,
                check: {
                  type: 'judge' as const,
                  endpoint: 'https://judge.invalid/v1',
                  model: 'm',
                  prompt: 'p',
                  threshold: 0.5,
                },
              }
            : n,
        ),
      } as PolicyGraph,
    }))
    const out = await toolLevels(judged, tools, {
      groupIds: [],
      deviceStatus: 'trusted',
      signals: healthySignals({ presenceCapable: true }),
    })
    expect(out.get('crm__search')).toBe('none')
  })
})

describe('buildPolicy', () => {
  it('writes one exact rule per tool and a stable ETag', async () => {
    const pinned = [...tools, tool('crm__pinned', 'read', 'hash-1')]
    const lv = await toolLevels(guardrails, pinned, {
      groupIds: [],
      deviceStatus: 'trusted',
      signals: healthySignals({ presenceCapable: false }),
    })
    lv.set('crm__export', 'hide')
    const a = await buildPolicy(guardrails, pinned, lv, sha256B64Url)
    const b = await buildPolicy(guardrails, pinned, lv, sha256B64Url)
    expect(a.etag).toBe(b.etag)
    expect(a.etag).toBe(`"${a.policy.version}"`)
    expect(a.policy.tools).toEqual([
      { match: 'crm__search', action: 'allow', tier: 'read', approval: 'none' },
      { match: 'crm__export', action: 'hide', tier: 'write' },
      { match: 'repo__delete_branch', action: 'allow', tier: 'destructive', approval: 'browser' },
      { match: 'crm__pinned', action: 'allow', tier: 'read', approval: 'none' },
    ])
    expect(a.policy.pinned).toEqual({ crm__pinned: 'hash-1' })
    expect(a.policy.untrusted_content).toEqual({
      builtin_sources: ['WebFetch', 'WebSearch'],
      window_minutes: 10,
    })
    // The bridge's own default would ask for Touch ID on every destructive tool.
    expect(a.policy.approval_defaults).toEqual({ read: 'none', write: 'none', destructive: 'none' })

    lv.set('crm__export', 'none')
    expect((await buildPolicy(guardrails, pinned, lv, sha256B64Url)).etag).not.toBe(a.etag)
  })
})

describe('pluginCall', () => {
  const now = 1_800_000_000_000
  const args = { to: 'anna@company.com', subject: 'Hi' }
  const hook = async (over: Record<string, unknown> = {}) => ({
    jti: 'j',
    htm: 'POST',
    htu: 'u',
    iat: now / 1000,
    hook: {
      sid: 'claude-session-42',
      eid: 'e',
      ah: await actionHash('email_send', args),
      ts: now / 1000 - 5,
      ...over,
    },
  })

  it('correlates a call with its recent hook record', async () => {
    expect(
      await pluginCall(await hook(), 'email_send', { subject: 'Hi', to: args.to }, now),
    ).toEqual({
      hash: await actionHash('email_send', args),
      hookCorrelated: true,
      claudeSessionId: 'claude-session-42',
    })
  })

  it('does not correlate other arguments, another tool, an old record or none', async () => {
    const no = { hookCorrelated: false, claudeSessionId: null }
    expect(
      await pluginCall(await hook(), 'email_send', { ...args, to: 'x@evil.example' }, now),
    ).toMatchObject(no)
    expect(await pluginCall(await hook(), 'email_delete', args, now)).toMatchObject(no)
    expect(
      await pluginCall(await hook({ ts: now / 1000 - 121 }), 'email_send', args, now),
    ).toMatchObject(no)
    expect(await pluginCall(await hook({ ts: 'now' }), 'email_send', args, now)).toMatchObject(no)
    const { hook: _, ...bare } = await hook()
    expect(await pluginCall(bare, 'email_send', args, now)).toMatchObject(no)
  })

  it('ignores a session id that is not one', async () => {
    expect(await pluginCall(await hook({ sid: '../x' }), 'email_send', args, now)).toMatchObject({
      hookCorrelated: true,
      claudeSessionId: null,
    })
  })
})

describe('travelKmh', () => {
  const krakow = { lat: 50.06, lon: 19.94 }
  const singapore = { lat: 1.35, lon: 103.82 }

  it('is the speed between two known places', () => {
    const speed = travelKmh({ coords: krakow, at: 0 }, { coords: singapore, at: 3_600_000 })
    expect(Math.round(speed!)).toBeGreaterThan(9000)
    expect(Math.round(speed!)).toBeLessThan(10000)
  })

  it('is unknown without both places', () => {
    expect(travelKmh(null, { coords: krakow, at: 1 })).toBeNull()
    expect(travelKmh({ coords: null, at: 0 }, { coords: krakow, at: 1 })).toBeNull()
    expect(travelKmh({ coords: krakow, at: 0 }, { coords: null, at: 1 })).toBeNull()
  })

  it('does not divide by a zero interval', () => {
    expect(
      Number.isFinite(travelKmh({ coords: krakow, at: 5 }, { coords: singapore, at: 5 })!),
    ).toBe(true)
  })
})
