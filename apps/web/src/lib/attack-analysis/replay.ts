import {
  type ActiveWorkflow,
  type CombinedResult,
  type EvaluationInput,
  evaluateWorkflows,
  skipLeavesGap,
} from '@acl/shared'
import type { TrafficTemplate } from './catalog.ts'

export type Actual = 'block' | 'allow' | 'approval' | 'inconclusive'
export type Outcome = 'correct' | 'missed' | 'overblocked' | 'review' | 'inconclusive'
export type EventResult = {
  eventId: string
  expected: TrafficTemplate['expected']
  actual: Actual
  outcome: Outcome
  input: EvaluationInput
  result: CombinedResult
}
export type Persona = {
  id: 'synthetic-analyst'
  groupIds: string[]
  mcpServerId: string | null
  resourceIds: string[]
  model: string
}

export function classify(expected: TrafficTemplate['expected'], actual: Actual): Outcome {
  if (actual === 'inconclusive') return 'inconclusive'
  if (actual === 'approval') return 'review'
  if (actual === expected) return 'correct'
  return expected === 'block' ? 'missed' : 'overblocked'
}

export async function replayTraffic(
  events: TrafficTemplate[],
  workflows: ActiveWorkflow[],
  persona: Persona,
  onProgress?: (completed: number) => void,
): Promise<EventResult[]> {
  const results: EventResult[] = []
  for (let offset = 0; offset < events.length; offset += 100) {
    const batch = await Promise.all(
      events.slice(offset, offset + 100).map(async (entry): Promise<EventResult> => {
        const input: EvaluationInput = {
          ...entry.input,
          groupIds: persona.groupIds,
          mcpServerId: persona.mcpServerId,
          resourceIds: persona.resourceIds,
          model: persona.model || entry.input.model,
        }
        // No judge stub: an unavailable judge must never be reported as a measured detection.
        const result = await evaluateWorkflows(workflows, input)
        // A check skipped because it does not apply to the stage is not a missing measurement.
        const incomplete = result.checks.some(
          (check) => check.outcome === 'error' || skipLeavesGap(check),
        )
        const actual: Actual = incomplete
          ? 'inconclusive'
          : result.decision === 'pending'
            ? 'approval'
            : result.decision
        return {
          eventId: entry.id,
          expected: entry.expected,
          actual,
          outcome: classify(entry.expected, actual),
          input,
          result,
        }
      }),
    )
    results.push(...batch)
    onProgress?.(results.length)
    // Yield between batches so progress, scrolling and navigation stay responsive.
    if (offset + 100 < events.length) await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  return results
}

export function decisionMatrix(results: EventResult[]) {
  return (['block', 'allow'] as const).map((expected) => ({
    expected,
    ...(Object.fromEntries(
      (['block', 'allow', 'approval', 'inconclusive'] as const).map((actual) => [
        actual,
        results.filter((r) => r.expected === expected && r.actual === actual).length,
      ]),
    ) as Record<Actual, number>),
  }))
}
