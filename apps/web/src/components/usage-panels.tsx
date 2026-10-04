import { formatAmount, kindLabels } from '@acl/shared'
import { Card, CardHeader, EmptyState, Table, TBody, TD, TH, THead, TR } from '@acl/ui'
import { Link } from '@tanstack/react-router'
import { num } from '#/lib/format.ts'
import type { getUsage, TimeRange } from '#/server/fns/traffic.ts'

type Usage = Awaited<ReturnType<typeof getUsage>>
type Spender = { key: string; label: string; cost: number; tokens: number; gpuMs: number }

const usd = (n: number) => formatAmount('cost', n)
const ms = (n: number | null) => (n == null ? '—' : `${n}ms`)

function gpuTime(msTotal: number): string {
  return formatAmount('gpu_seconds', msTotal / 1000)
}

/**
 * Who and what spends. Bars are scaled by cost, or by tokens when nothing in the list has a
 * price (an empty model catalog, or only unpriced local models).
 */
function SpendList({ title, rows, empty }: { title: string; rows: Spender[]; empty: string }) {
  const byCost = rows.some((r) => r.cost > 0)
  const value = (r: Spender) => (byCost ? r.cost : r.tokens)
  const max = Math.max(0, ...rows.map(value))
  return (
    <div>
      <div className="px-4 pt-3 pb-1 text-[11px] font-medium text-subtle uppercase">{title}</div>
      <ul className="flex flex-col gap-2 px-4 pb-3">
        {rows.map((r) => (
          <li
            key={r.key}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-xs"
            title={`${r.label}: ${usd(r.cost)} · ${num(r.tokens)} tokens${r.gpuMs ? ` · ${gpuTime(r.gpuMs)}` : ''}`}
          >
            <span className="truncate">{r.label}</span>
            <span className="font-mono text-muted tabular-nums">
              {byCost ? usd(r.cost) : `${num(r.tokens)} tok`}
            </span>
            <span className="col-span-2 h-1.5 overflow-hidden rounded-full bg-line">
              <span
                className="block h-full rounded-full bg-accent"
                style={{ width: `${max ? Math.max(2, (value(r) / max) * 100) : 0}%` }}
              />
            </span>
          </li>
        ))}
        {rows.length === 0 ? <li className="text-xs text-muted">{empty}</li> : null}
      </ul>
    </div>
  )
}

function Figure({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="px-4 py-3">
      <div className="text-[11px] text-subtle">{label}</div>
      <div className="mt-0.5 font-mono text-lg tabular-nums">{value}</div>
      {sub ? <div className="text-[11px] text-muted">{sub}</div> : null}
    </div>
  )
}

export function SpendPanel({ spend }: { spend: Usage['spend'] }) {
  const { input, output, cacheRead, cacheWrite } = spend.tokens
  const total = input + output + cacheRead + cacheWrite
  const prompt = input + cacheRead + cacheWrite
  return (
    <Card>
      <CardHeader
        title="Spend"
        description="Model usage priced with the model catalog; local models by GPU time"
        actions={
          <Link to="/limits" className="text-xs text-accent-strong hover:underline">
            Limits
          </Link>
        }
      />
      <div className="grid grid-cols-3 divide-x divide-line border-b border-line">
        <Figure label="Cost" value={usd(spend.cost)} />
        <Figure
          label="Tokens"
          value={num(total)}
          sub={`${num(input)} in · ${num(output)} out · ${prompt ? Math.round((cacheRead / prompt) * 100) : 0}% of prompt from cache`}
        />
        <Figure label="GPU time" value={gpuTime(spend.gpuMs)} sub="local models" />
      </div>
      <div className="grid divide-line sm:grid-cols-2 sm:divide-x">
        <SpendList
          title="By user"
          empty="No model requests in this range"
          rows={spend.byUser.map((u) => ({
            key: u.userId,
            label: u.name ?? u.email ?? u.userId,
            cost: u.cost,
            tokens: u.tokens,
            gpuMs: u.gpuMs,
          }))}
        />
        <SpendList
          title="By model"
          empty="No model requests in this range"
          rows={spend.byModel.map((m) => ({
            key: m.model ?? 'unknown',
            label: m.model ?? 'unknown',
            cost: m.cost,
            tokens: m.tokens,
            gpuMs: m.gpuMs,
          }))}
        />
      </div>
    </Card>
  )
}

export function PerformancePanel({
  performance,
  range,
}: {
  performance: Usage['performance']
  range: TimeRange
}) {
  const { overhead, stages, workflows, sampled } = performance
  return (
    <Card>
      <CardHeader
        title="Performance"
        description={`Time spent in the control layer, without the upstream${sampled >= 5000 ? ' (newest 5000 requests)' : ''}`}
        actions={
          <span className="font-mono text-xs text-muted tabular-nums">
            p50 {ms(overhead.p50)} · p95 {ms(overhead.p95)}
          </span>
        }
      />
      {sampled === 0 ? (
        <EmptyState title="No traffic in this range" />
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <TH>Stage</TH>
                <TH className="text-right">Requests</TH>
                <TH className="text-right">Blocked</TH>
                <TH className="text-right">p50</TH>
                <TH className="text-right">p95</TH>
              </tr>
            </THead>
            <TBody>
              {stages.map((s) => (
                <TR key={s.kind}>
                  <TD className="text-xs">
                    <Link
                      to="/events"
                      search={{ kind: s.kind, range }}
                      className="hover:text-accent-strong"
                    >
                      {kindLabels[s.kind]}
                    </Link>
                  </TD>
                  <TD className="text-right font-mono text-xs tabular-nums">{num(s.n)}</TD>
                  <TD className="text-right font-mono text-xs tabular-nums">
                    {s.blocked ? <span className="text-bad">{num(s.blocked)}</span> : '0'}
                  </TD>
                  <TD className="text-right font-mono text-xs text-muted">{ms(s.p50)}</TD>
                  <TD className="text-right font-mono text-xs text-muted">{ms(s.p95)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Table>
            <THead>
              <tr>
                <TH>Workflow</TH>
                <TH className="text-right">Runs</TH>
                <TH className="text-right">Blocked</TH>
                <TH className="text-right">p50</TH>
                <TH className="text-right">p95</TH>
              </tr>
            </THead>
            <TBody>
              {workflows.map((w) => (
                <TR key={w.id}>
                  <TD className="text-xs">
                    <Link
                      to="/events"
                      search={{ workflow: w.id, range }}
                      className="hover:text-accent-strong"
                    >
                      {w.name}
                    </Link>
                  </TD>
                  <TD className="text-right font-mono text-xs tabular-nums">{num(w.n)}</TD>
                  <TD className="text-right font-mono text-xs tabular-nums">
                    {w.blocked ? <span className="text-bad">{num(w.blocked)}</span> : '0'}
                  </TD>
                  <TD className="text-right font-mono text-xs text-muted">{ms(w.p50)}</TD>
                  <TD className="text-right font-mono text-xs text-muted">{ms(w.p95)}</TD>
                </TR>
              ))}
              {workflows.length === 0 ? (
                <TR>
                  <TD className="text-xs text-muted">No workflow ran in this range</TD>
                </TR>
              ) : null}
            </TBody>
          </Table>
        </>
      )}
    </Card>
  )
}
