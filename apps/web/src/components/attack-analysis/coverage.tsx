import { Card, CardHeader } from '@acl/ui'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import type { Outcome } from '#/lib/attack-analysis/replay.ts'
import type { AnalysisRun } from '#/lib/attack-analysis/runs.ts'

const outcomes: { key: Outcome; label: string; color: string }[] = [
  { key: 'correct', label: 'As expected', color: '#38cdb5' },
  { key: 'missed', label: 'Missed attacks', color: '#ff7185' },
  { key: 'overblocked', label: 'False positives', color: '#eab663' },
  { key: 'review', label: 'Needs approval', color: '#8e9ef1' },
  { key: 'inconclusive', label: 'Inconclusive', color: '#68748c' },
]

export function CoverageCharts({ run }: { run: AnalysisRun }) {
  const distribution = outcomes.map((o) => ({
    ...o,
    count: run.results.filter((r) => r.outcome === o.key).length,
  }))
  const covered = run.results.filter((r) => r.result.guardrails.length > 0).length
  const guardrailCounts = new Map<string, number>()
  for (const result of run.results)
    for (const guardrail of result.result.guardrails)
      guardrailCounts.set(guardrail.id, (guardrailCounts.get(guardrail.id) ?? 0) + 1)
  const guardrails = run.guardrails
    .map((w) => ({ ...w, count: guardrailCounts.get(w.id) ?? 0 }))
    .sort((a, b) => b.count - a.count)
  return (
    <div className="mt-4 grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader
          title="Outcome breakdown"
          description="Where the replay met expectations — and where it didn’t."
        />
        <div className="flex flex-wrap items-center justify-center gap-5 p-5">
          <div
            className="relative size-44 shrink-0"
            role="img"
            aria-label={distribution.map((o) => `${o.label}: ${o.count}`).join(', ')}
          >
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={distribution.filter((o) => o.count)}
                  dataKey="count"
                  nameKey="label"
                  innerRadius={60}
                  outerRadius={80}
                  stroke="var(--color-panel)"
                  strokeWidth={3}
                  paddingAngle={2}
                >
                  {distribution
                    .filter((o) => o.count)
                    .map((o) => (
                      <Cell key={o.key} fill={o.color} />
                    ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    background: 'var(--color-panel)',
                    border: '1px solid var(--color-line-strong)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  itemStyle={{ color: 'var(--color-fg)' }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-3xl font-medium tabular-nums">{run.results.length}</span>
              <span className="mt-1 text-[10px] uppercase tracking-wider text-subtle">events</span>
            </div>
          </div>
          <dl className="min-w-44 flex-1 space-y-3">
            {distribution.map((o) => (
              <div key={o.key} className="flex items-center justify-between gap-4 text-xs">
                <dt className="flex items-center gap-2 text-muted">
                  <span className="size-2 rounded-sm" style={{ background: o.color }} />
                  {o.label}
                </dt>
                <dd className="font-mono">
                  {o.count}
                  <span className="ml-3 inline-block w-9 text-right text-subtle">
                    {Math.round((o.count / run.results.length) * 100)}%
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </Card>
      <Card>
        <CardHeader
          title="Guardrail coverage"
          description="Which policies matched the dataset’s requests."
        />
        <div className="p-5">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-2xl font-medium tabular-nums">
              {Math.round((covered / run.results.length) * 100)}%{' '}
              <span className="text-xs font-normal text-muted">covered</span>
            </span>
            <span className="text-xs text-muted">
              {covered} / {run.results.length} events
            </span>
          </div>
          <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-line">
            <div
              className="h-full rounded-full bg-info"
              style={{ width: `${(covered / run.results.length) * 100}%` }}
            />
          </div>
          <p
            className={`mb-5 text-xs ${covered < run.results.length ? 'text-warn' : 'text-subtle'}`}
          >
            {run.results.length - covered} events matched no guardrail and were allowed without
            checks.
          </p>
          <div className="space-y-3">
            {guardrails.slice(0, 6).map((w) => (
              <div key={w.id}>
                <div className="mb-1.5 flex justify-between gap-3 text-xs">
                  <span className="truncate text-muted" title={w.name}>
                    {w.name} <span className="text-subtle">v{w.version}</span>
                  </span>
                  <span className="font-mono text-subtle">
                    {w.count} / {run.results.length}
                  </span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-line">
                  <div
                    className="h-full rounded-full bg-info/70"
                    style={{ width: `${(w.count / run.results.length) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[10px] text-subtle">
            {guardrails.length > 6 ? 'Top 6 guardrails shown. ' : ''}An event can match multiple
            guardrails. Coverage does not imply detection.
          </p>
        </div>
      </Card>
    </div>
  )
}
