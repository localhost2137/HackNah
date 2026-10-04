import { decodeModel, type EventKind, eventKind, kindLabels } from '@acl/shared'
import { Card, CardHeader, Table, TBody, TD, TH, THead, TR } from '@acl/ui'
import { useEffect, useState } from 'react'
import { benchmarkRun, latencyStats, type Timing } from '#/lib/attack-analysis/benchmark.ts'
import type { AnalysisRun } from '#/lib/attack-analysis/run-types.ts'
import { num } from '#/lib/format.ts'
import { getModels } from '#/server/fns/datasets.ts'

type State =
  | { phase: 'running'; done: number }
  | { phase: 'done'; timings: Timing[] }
  | { phase: 'error'; message: string }

const ms = (value: number) =>
  value >= 10
    ? `${value.toFixed(0)} ms`
    : value >= 1
      ? `${value.toFixed(1)} ms`
      : `${value.toFixed(3)} ms`

/** How long the run's guardrails take per request: p50, p95, p99 and requests per second. */
export function RunPerformance({ run }: { run: AnalysisRun }) {
  const [state, setState] = useState<State>({ phase: 'running', done: 0 })

  useEffect(() => {
    let cancelled = false
    setState({ phase: 'running', done: 0 })
    const ids = run.workflows.flatMap((w) =>
      w.definition.nodes.flatMap((n) =>
        n.type === 'check' && n.enabled && n.check.type === 'learned' ? n.check.models : [],
      ),
    )
    ;(async () => {
      const models = ids.length ? (await getModels({ data: { ids } })).map(decodeModel) : []
      const timings = await benchmarkRun(run, { models }, (done) => {
        if (!cancelled) setState({ phase: 'running', done })
      })
      if (!cancelled) setState({ phase: 'done', timings })
    })().catch((err) => {
      if (!cancelled)
        setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    })
    return () => {
      cancelled = true
    }
  }, [run])

  const timings = state.phase === 'done' ? state.timings : []
  const all = latencyStats(timings.map((t) => t.ms))
  const stages = eventKind.options
    .map((stage: EventKind) => ({
      stage,
      stats: latencyStats(timings.filter((t) => t.stage === stage).map((t) => t.ms)),
    }))
    .filter((s) => s.stats.count > 0)
  const headline = [
    { label: 'p50', value: ms(all.p50) },
    { label: 'p95', value: ms(all.p95) },
    { label: 'p99', value: ms(all.p99) },
    { label: 'Slowest', value: ms(all.max) },
    { label: 'Requests per second', value: all.mean ? num(Math.round(1000 / all.mean)) : '—' },
  ]

  return (
    <Card className="mt-6 overflow-hidden">
      <CardHeader
        title="Performance"
        description="Time the guardrails take to decide on one request, on one core. Measured in this browser by replaying the run; LLM judges are not called."
      />
      {state.phase === 'error' ? (
        <p className="p-5 text-xs text-bad">Could not measure: {state.message}</p>
      ) : state.phase === 'running' ? (
        <div className="p-5">
          <div className="h-1.5 overflow-hidden rounded-full bg-panel-2">
            <div
              className="h-full bg-accent transition-[width]"
              style={{ width: `${Math.round((state.done / run.results.length) * 100)}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-muted">
            Timing {num(state.done)} of {num(run.results.length)} requests…
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 border-b border-line sm:grid-cols-5">
            {headline.map((h) => (
              <div key={h.label} className="border-r border-line px-5 py-4 last:border-r-0">
                <div className="text-[11px] font-medium text-muted">{h.label}</div>
                <div className="mt-1.5 font-mono text-lg tabular-nums">{h.value}</div>
              </div>
            ))}
          </div>
          <Table>
            <THead>
              <tr>
                <TH>Stage</TH>
                <TH className="text-right">Requests</TH>
                <TH className="text-right">p50</TH>
                <TH className="text-right">p95</TH>
                <TH className="text-right">p99</TH>
                <TH className="text-right">Slowest</TH>
              </tr>
            </THead>
            <TBody>
              {stages.map(({ stage, stats }) => (
                <TR key={stage}>
                  <TD className="text-xs">{kindLabels[stage]}</TD>
                  <TD className="text-right font-mono text-xs">{num(stats.count)}</TD>
                  <TD className="text-right font-mono text-xs">{ms(stats.p50)}</TD>
                  <TD className="text-right font-mono text-xs">{ms(stats.p95)}</TD>
                  <TD className="text-right font-mono text-xs">{ms(stats.p99)}</TD>
                  <TD className="text-right font-mono text-xs">{ms(stats.max)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </>
      )}
    </Card>
  )
}
