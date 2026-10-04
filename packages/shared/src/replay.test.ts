import { describe, expect, it } from 'vitest'
import type { ActiveGuardrail } from './engine.ts'
import type { CheckResult } from './events.ts'
import { defaultGuardrail, type PolicyGraph } from './guardrail.ts'
import { recordedDeviceStatus, recordedResult, replayWithShadow } from './replay.ts'

const shadow: ActiveGuardrail = {
  id: 'wf-shadow',
  name: 'Shadow',
  version: 0,
  groupIds: [],
  definition: defaultGuardrail,
}
const clean = {
  kind: 'model_request' as const,
  text: 'hello',
  toolName: null,
  deviceStatus: 'trusted' as const,
}
const dangerous = { ...clean, text: 'please run rm -rf / now' }

const ranDecision = (guardrailId: string, action?: 'block' | 'require_approval'): CheckResult => ({
  guardrailId,
  stepId: 'end',
  type: 'decision',
  outcome: action ? 'fail' : 'pass',
  action,
  durationMs: 0,
})
const permissionDenied: CheckResult = {
  stepId: 'permissions',
  type: 'permissions',
  outcome: 'fail',
  action: 'block',
  durationMs: 0,
}

describe('recordedResult', () => {
  it('tells guardrail blocks apart from requests stopped before guardrails', () => {
    expect(recordedResult('block', [ranDecision('a', 'block')])).toBe('block')
    expect(recordedResult('block', [permissionDenied])).toBe('denied')
    expect(recordedResult('block', [])).toBe('denied')
    expect(recordedResult('rate_limited', [])).toBe('rate_limited')
    expect(recordedResult('declined', [ranDecision('a', 'require_approval')])).toBe('approval')
  })

  it('reads the device status from a recorded fingerprint step', () => {
    const fp = (branch: string): CheckResult => ({
      stepId: 'fp',
      type: 'fingerprint',
      outcome: 'fail',
      branch,
      durationMs: 0,
    })
    expect(recordedDeviceStatus([])).toBe('trusted')
    expect(recordedDeviceStatus([fp('new')])).toBe('new')
    expect(recordedDeviceStatus([fp('mismatch')])).toBe('mismatch')
  })
})

describe('replayWithShadow', () => {
  it('turns an allowed request into a blocked one', async () => {
    const v = await replayWithShadow(
      shadow,
      { decision: 'allow', checks: [ranDecision('other')] },
      dangerous,
    )
    expect(v).toMatchObject({ recorded: 'allow', shadow: 'block', before: 'allow', after: 'block' })
  })

  it('keeps the outcome when the rule does not start', async () => {
    const toolsOnly: PolicyGraph = {
      ...defaultGuardrail,
      nodes: defaultGuardrail.nodes.map((n) =>
        n.type === 'trigger' ? { ...n, stages: ['tool_call' as const] } : n,
      ),
    }
    const v = await replayWithShadow(
      { ...shadow, definition: toolsOnly },
      { decision: 'allow', checks: [] },
      dangerous,
    )
    expect(v).toMatchObject({ shadow: 'not_started', before: 'allow', after: 'allow' })
  })

  it('keeps the outcome when the rule ends in Skip', async () => {
    const skipsAll: PolicyGraph = {
      fallback: 'block',
      nodes: [
        { id: 'start', type: 'trigger', position: { x: 0, y: 0 }, stages: [] },
        {
          id: 'skip',
          type: 'decision',
          position: { x: 0, y: 0 },
          action: 'skip',
          method: 'admin',
          timeoutSec: 300,
          reason: '',
        },
      ],
      edges: [{ id: 'e', source: 'start', sourceHandle: 'next', target: 'skip' }],
    }
    const v = await replayWithShadow(
      { ...shadow, definition: skipsAll },
      { decision: 'block', checks: [ranDecision('other', 'block')] },
      dangerous,
    )
    expect(v).toMatchObject({ shadow: 'not_started', before: 'block', after: 'block' })
  })

  it('ignores recorded guardrails that skipped', async () => {
    const skipped: CheckResult = {
      guardrailId: 'other',
      stepId: 'skip',
      type: 'decision',
      outcome: 'skipped',
      durationMs: 0,
    }
    const v = await replayWithShadow(
      shadow,
      { decision: 'allow', checks: [skipped, ranDecision(shadow.id)] },
      clean,
    )
    expect(v).toMatchObject({ shadow: 'allow', before: 'allow', after: 'allow' })
  })

  it('loosens when the draft replaces a live version that blocked', async () => {
    const v = await replayWithShadow(
      shadow,
      { decision: 'block', checks: [ranDecision(shadow.id, 'block')] },
      clean,
    )
    expect(v).toMatchObject({ recorded: 'block', shadow: 'allow', before: 'block', after: 'allow' })
  })

  it('runs on failed requests but keeps them blocked', async () => {
    const limited = await replayWithShadow(
      shadow,
      { decision: 'rate_limited', checks: [] },
      dangerous,
    )
    expect(limited).toMatchObject({
      recorded: 'rate_limited',
      shadow: 'block',
      before: 'block',
      after: 'block',
    })
    const denied = await replayWithShadow(
      shadow,
      { decision: 'block', checks: [permissionDenied] },
      clean,
    )
    expect(denied).toMatchObject({ recorded: 'denied', shadow: 'allow', after: 'block' })
  })
})
