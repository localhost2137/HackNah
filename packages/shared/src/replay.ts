import {
  type ActiveWorkflow,
  type DeviceStatus,
  type EngineDeps,
  type EvaluationInput,
  type EvaluationResult,
  evaluateGraph,
  selectWorkflows,
} from './engine.ts'
import type { CheckResult, Decision } from './events.ts'

/** What a request ended as, regardless of who approved it. */
export type ReplayOutcome = 'allow' | 'approval' | 'block'

/** How a request actually ended. `denied` was stopped by permissions or access before any workflow ran. */
export type RecordedResult = ReplayOutcome | 'rate_limited' | 'denied'

const rank: Record<ReplayOutcome, number> = { allow: 0, approval: 1, block: 2 }

export function stricter(a: ReplayOutcome, b: ReplayOutcome): ReplayOutcome {
  return rank[a] >= rank[b] ? a : b
}

export function recordedResult(decision: Decision, checks: CheckResult[]): RecordedResult {
  if (decision === 'rate_limited') return 'rate_limited'
  if (decision === 'block') return checks.some((c) => c.workflowId) ? 'block' : 'denied'
  if (decision === 'allow') return 'allow'
  return 'approval'
}

/** The outcome each workflow reached, read from the decision step of its recorded path. */
export function recordedWorkflowOutcomes(checks: CheckResult[]): Map<string, ReplayOutcome> {
  const outcomes = new Map<string, ReplayOutcome>()
  for (const c of checks) {
    if (c.type !== 'decision' || !c.workflowId) continue
    outcomes.set(
      c.workflowId,
      c.action === 'block' ? 'block' : c.action === 'require_approval' ? 'approval' : 'allow',
    )
  }
  return outcomes
}

/** Events don't store the device status; a fingerprint step that ran tells it, otherwise trusted. */
export function recordedDeviceStatus(checks: CheckResult[]): DeviceStatus {
  const fp = checks.find((c) => c.type === 'fingerprint' && c.outcome === 'fail')
  return !fp ? 'trusted' : fp.branch === 'new' ? 'new' : 'mismatch'
}

export type ShadowVerdict = {
  recorded: RecordedResult
  /** What the rule decides alone; `not_started` when its start conditions or groups don't match. */
  shadow: ReplayOutcome | 'not_started'
  /** What the user got, and would get with the rule live. */
  before: ReplayOutcome
  after: ReplayOutcome
  result: EvaluationResult | null
}

/**
 * Runs `shadow` on any recorded request, including failed ones. Other workflows keep the outcome
 * they reached at the time and `shadow` replaces any version of the same workflow. Requests the
 * gateway stopped before workflows ran stay blocked.
 */
export async function replayWithShadow(
  shadow: ActiveWorkflow,
  recorded: { decision: Decision; checks: CheckResult[] },
  input: EvaluationInput,
  deps: EngineDeps = {},
): Promise<ShadowVerdict> {
  const status = recordedResult(recorded.decision, recorded.checks)
  const early = status === 'rate_limited' || status === 'denied'
  const before: ReplayOutcome = early ? 'block' : status

  const others = recordedWorkflowOutcomes(recorded.checks)
  others.delete(shadow.id)
  const rest = [...others.values()].reduce<ReplayOutcome>(stricter, 'allow')

  if (selectWorkflows([shadow], input).length === 0) {
    return {
      recorded: status,
      shadow: 'not_started',
      before,
      after: early ? 'block' : rest,
      result: null,
    }
  }
  const result = await evaluateGraph(shadow.definition, input, deps)
  const own: ReplayOutcome =
    result.decision === 'block' ? 'block' : result.decision === 'pending' ? 'approval' : 'allow'
  return {
    recorded: status,
    shadow: own,
    before,
    after: early ? 'block' : stricter(rest, own),
    result,
  }
}
