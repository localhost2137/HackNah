import {
  type EngineDeps,
  type EvaluationInput,
  type EventKind,
  evaluateGuardrails,
} from '@acl/shared'
import type { AnalysisRun } from './run-types.ts'

export type Timing = { stage: EventKind; ms: number }
export type LatencyStats = {
  count: number
  mean: number
  p50: number
  p95: number
  p99: number
  max: number
}

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!
}

export function latencyStats(values: number[]): LatencyStats {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    mean: sorted.length ? sorted.reduce((sum, v) => sum + v, 0) / sorted.length : 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? 0,
  }
}

/** Browsers round their clock, so one evaluation is too short to time: repeat for this long. */
const SAMPLE_MS = 1
const MAX_REPEATS = 50

/**
 * Times how long the run's guardrails take to decide on each of its requests. It runs in the
 * browser because a Worker's clock stands still while it computes, so the gateway cannot time
 * its own CPU work.
 */
export async function benchmarkRun(
  run: Pick<AnalysisRun, 'guardrails' | 'results'>,
  deps: Pick<EngineDeps, 'signatures' | 'models'>,
  onProgress: (done: number) => void = () => {},
): Promise<Timing[]> {
  const decide = (input: EvaluationInput) => evaluateGuardrails(run.guardrails, input, deps)
  // Let the engine compile its patterns and the JIT warm up before anything is timed.
  for (const { input } of run.results.slice(0, 50)) await decide(input)
  const timings: Timing[] = []
  let lastPause = performance.now()
  for (const [i, { input }] of run.results.entries()) {
    const started = performance.now()
    let repeats = 0
    do {
      await decide(input)
      repeats++
    } while (performance.now() - started < SAMPLE_MS && repeats < MAX_REPEATS)
    timings.push({ stage: input.kind, ms: (performance.now() - started) / repeats })
    if (performance.now() - lastPause > 50) {
      onProgress(i + 1)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      lastPause = performance.now()
    }
  }
  return timings
}
