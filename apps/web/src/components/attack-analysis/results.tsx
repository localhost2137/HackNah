import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Actual, EventResult } from '#/lib/attack-analysis/replay.ts'

export function AnalysisResults({ results }: { results: EventResult[] }) {
  const decisions: { key: Actual; label: string }[] = [
    { key: 'block', label: 'Blocked' },
    { key: 'allow', label: 'Allowed' },
    { key: 'approval', label: 'Needs approval' },
    { key: 'inconclusive', label: 'Inconclusive' },
  ]
  const chart = decisions.map(({ key, label }) => ({
    decision: label,
    expected: results.filter((r) => r.expected === key).length,
    observed: results.filter((r) => r.actual === key).length,
  }))
  const matched = results.filter((r) => r.outcome === 'correct').length
  const missed = results.filter((r) => r.outcome === 'missed').length
  const overblocked = results.filter((r) => r.outcome === 'overblocked').length
  const unresolved = results.filter(
    (r) => r.outcome === 'review' || r.outcome === 'inconclusive',
  ).length
  const metrics = [
    {
      label: 'Matched expectation',
      value: `${Math.round((matched / results.length) * 100)}%`,
      sub: `${matched} of ${results.length} events`,
      color: 'text-fg',
    },
    {
      label: 'Missed attacks',
      value: missed,
      sub: 'Allowed instead of blocked',
      color: missed ? 'text-bad' : 'text-fg',
    },
    {
      label: 'False positives',
      value: overblocked,
      sub: 'Blocked legitimate requests',
      color: overblocked ? 'text-warn' : 'text-fg',
    },
    {
      label: 'Unresolved',
      value: unresolved,
      sub: 'Approval or incomplete checks',
      color: unresolved ? 'text-warn' : 'text-fg',
    },
  ]
  return (
    <>
      <div className="grid grid-cols-2 border-b border-line lg:grid-cols-4">
        {metrics.map((metric) => (
          <div key={metric.label} className="border-r border-line px-6 py-5 last:border-r-0">
            <div className="text-[11px] font-medium text-muted">{metric.label}</div>
            <div
              className={`mt-2 text-[32px] font-medium leading-none tracking-tight tabular-nums ${metric.color}`}
            >
              {metric.value}
            </div>
            <div className="mt-2 text-[11px] text-subtle">{metric.sub}</div>
          </div>
        ))}
      </div>
      <div className="px-6 pt-6 pb-3">
        <h3 className="text-sm font-medium">Expected vs. observed decisions</h3>
        <p className="mt-1 text-xs text-subtle">
          The dataset’s expected decisions alongside the actual replay. Inspect individual events
          for mismatches.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-5 text-[11px] text-muted">
          <span className="flex items-center gap-2">
            <span className="h-2.5 w-3 rounded-sm border border-dashed border-muted bg-muted/10" />
            Expected
          </span>
          <span className="flex items-center gap-2">
            <span className="h-2.5 w-3 rounded-sm bg-[#42c8ad]" />
            Observed
          </span>
        </div>
        <div
          className="mt-4 h-52"
          role="img"
          aria-label={chart
            .map((c) => `${c.decision}: ${c.expected} expected, ${c.observed} observed`)
            .join('. ')}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chart}
              layout="vertical"
              margin={{ top: 0, right: 16, bottom: 0, left: 0 }}
              barGap={3}
              barCategoryGap="25%"
            >
              <CartesianGrid horizontal={false} stroke="var(--color-line)" strokeDasharray="3 4" />
              <XAxis
                type="number"
                allowDecimals={false}
                axisLine={false}
                tickLine={false}
                tick={{ fill: 'var(--color-subtle)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
              />
              <YAxis
                type="category"
                dataKey="decision"
                axisLine={false}
                tickLine={false}
                width={100}
                tick={{ fill: 'var(--color-muted)', fontSize: 11 }}
              />
              <Tooltip
                cursor={{ fill: 'var(--color-panel-2)', opacity: 0.6 }}
                contentStyle={{
                  background: 'var(--color-panel)',
                  border: '1px solid var(--color-line-strong)',
                  borderRadius: 8,
                  fontSize: 12,
                  boxShadow: '0 8px 32px #0006',
                }}
                labelStyle={{ color: 'var(--color-fg)', marginBottom: 8 }}
              />
              <Bar
                dataKey="expected"
                name="Expected"
                fill="#68748c"
                fillOpacity={0.45}
                isAnimationActive={false}
                maxBarSize={10}
              />
              <Bar
                dataKey="observed"
                name="Observed"
                fill="#42c8ad"
                fillOpacity={0.85}
                isAnimationActive={false}
                maxBarSize={10}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </>
  )
}
