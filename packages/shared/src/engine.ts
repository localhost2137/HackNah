import type { CheckResult, EventKind } from './events.ts'
import type { StepAction, WorkflowDefinition, WorkflowStep } from './workflow.ts'

export type DeviceStatus = 'trusted' | 'new' | 'mismatch' | 'revoked'

export type EvaluationInput = {
  kind: EventKind
  /** Flattened text of the prompt, tool results or tool arguments being checked. */
  text: string
  toolName: string | null
  deviceStatus: DeviceStatus
}

export type JudgeVerdict = { score: number; reason: string }

export type EngineDeps = {
  judge?: (
    step: Extract<WorkflowStep, { type: 'judge' }>,
    input: EvaluationInput,
  ) => Promise<JudgeVerdict>
  now?: () => number
}

export type EvaluationResult = {
  decision: 'allow' | 'block' | 'pending'
  checks: CheckResult[]
  riskScore: number
  reasons: string[]
}

type StepOutcome = Omit<CheckResult, 'stepId' | 'type' | 'durationMs'>

export async function evaluate(
  workflow: WorkflowDefinition,
  input: EvaluationInput,
  deps: EngineDeps = {},
): Promise<EvaluationResult> {
  const now = deps.now ?? (() => performance.now())
  const checks: CheckResult[] = []

  for (const step of workflow.steps) {
    const started = now()
    let outcome: StepOutcome
    if (!step.enabled) {
      outcome = { outcome: 'skipped', reason: 'disabled' }
    } else {
      try {
        outcome = await runStep(step, input, deps)
      } catch (err) {
        outcome = { outcome: 'error', reason: err instanceof Error ? err.message : String(err) }
      }
    }
    checks.push({
      stepId: step.id,
      type: step.type,
      durationMs: Math.round(now() - started),
      ...outcome,
    })
    if (outcome.outcome === 'fail' && outcome.action === 'block') break
  }

  return summarize(checks)
}

export function summarize(checks: CheckResult[]): EvaluationResult {
  const failed = checks.filter((c) => c.outcome === 'fail')
  const reasons = failed.map((c) => c.reason ?? c.type)
  const riskScore = Math.min(
    1,
    checks.reduce(
      (max, c) => Math.max(max, c.score ?? (c.outcome === 'fail' ? weight(c.action) : 0)),
      0,
    ),
  )
  let decision: EvaluationResult['decision'] = 'allow'
  if (failed.some((c) => c.action === 'block')) decision = 'block'
  else if (failed.some((c) => c.action === 'require_approval')) decision = 'pending'
  return { decision, checks, riskScore, reasons }
}

function weight(action: StepAction | undefined): number {
  if (action === 'block') return 1
  if (action === 'require_approval') return 0.7
  return 0.3
}

async function runStep(
  step: WorkflowStep,
  input: EvaluationInput,
  deps: EngineDeps,
): Promise<StepOutcome> {
  switch (step.type) {
    case 'fingerprint': {
      if (input.deviceStatus === 'mismatch')
        return {
          outcome: 'fail',
          action: step.onMismatch,
          reason: 'Token presented from a different device',
        }
      if (input.deviceStatus === 'revoked')
        return { outcome: 'fail', action: 'block', reason: 'Device has been revoked' }
      if (input.deviceStatus === 'new')
        return {
          outcome: 'fail',
          action: step.onNewDevice,
          reason: 'Request from an unrecognized device',
        }
      return { outcome: 'pass' }
    }
    case 'keywords': {
      if (!step.appliesTo.includes(input.kind))
        return { outcome: 'skipped', reason: 'not applicable' }
      const hit = matchKeywords(input.text, step.patterns, step.mode, step.caseSensitive)
      if (hit) return { outcome: 'fail', action: step.action, reason: `Matched keyword "${hit}"` }
      return { outcome: 'pass' }
    }
    case 'judge': {
      if (!step.appliesTo.includes(input.kind))
        return { outcome: 'skipped', reason: 'not applicable' }
      if (!deps.judge) return { outcome: 'skipped', reason: 'judge unavailable' }
      try {
        const verdict = await deps.judge(step, input)
        if (verdict.score >= step.threshold)
          return {
            outcome: 'fail',
            action: step.action,
            score: verdict.score,
            reason: verdict.reason,
          }
        return { outcome: 'pass', score: verdict.score, reason: verdict.reason }
      } catch (err) {
        const reason = `Judge failed: ${err instanceof Error ? err.message : String(err)}`
        if (step.failOpen) return { outcome: 'error', reason }
        return { outcome: 'fail', action: step.action, reason }
      }
    }
    case 'redact':
      // Redaction rewrites the request before forwarding; it never blocks.
      return { outcome: 'pass' }
  }
}

/** Returns the first matching pattern, or null. Substring patterns support `*` as a wildcard. */
export function matchKeywords(
  text: string,
  patterns: string[],
  mode: 'substring' | 'regex',
  caseSensitive: boolean,
): string | null {
  const flags = caseSensitive ? '' : 'i'
  for (const pattern of patterns) {
    let re: RegExp
    try {
      re =
        mode === 'regex'
          ? new RegExp(pattern, flags)
          : new RegExp(pattern.split('*').map(escapeRegExp).join('.*?'), flags)
    } catch {
      continue
    }
    if (re.test(text)) return pattern
  }
  return null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
