import { Card, CardHeader, EmptyState, PageHeader, Stat, Table, TBody, TD, TR } from '@acl/ui'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { z } from 'zod'
import { DecisionBadge, KindLabel, RiskMeter } from '#/components/event-bits.tsx'
import { Segmented } from '#/components/filters.tsx'
import { num, pct, timeAgo } from '#/lib/format.ts'
import { useLive } from '#/lib/live.tsx'
import { getOverview, type TimeRange, timeRange } from '#/server/fns/traffic.ts'

const overviewQuery = (range: TimeRange) =>
  queryOptions({
    queryKey: ['overview', range],
    queryFn: () => getOverview({ data: { range } }),
    refetchInterval: 30_000,
  })

export const Route = createFileRoute('/_app/')({
  validateSearch: z.object({ range: timeRange.default('24h') }),
  loaderDeps: ({ search }) => ({ range: search.range }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(overviewQuery(deps.range)),
  component: Overview,
})

function Overview() {
  const { range } = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data } = useQuery(overviewQuery(range))
  const live = useLive()
  if (!data) return null

  const fmtTick = (iso: string) =>
    new Date(iso).toLocaleString(
      'en-GB',
      range === '30d' ? { day: '2-digit', month: 'short' } : { hour: '2-digit', minute: '2-digit' },
    )

  return (
    <>
      <PageHeader
        title="Overview"
        description="Traffic from your team's AI agents and what the gateway did about it."
        actions={
          <Segmented<TimeRange>
            value={range}
            onChange={(r) => navigate({ search: { range: r } })}
            options={[
              { value: '1h', label: '1h' },
              { value: '24h', label: '24h' },
              { value: '7d', label: '7d' },
              { value: '30d', label: '30d' },
            ]}
          />
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Requests" value={num(data.total)} />
        <Stat
          label="Blocked"
          value={num(data.blocked)}
          tone={data.blocked ? 'bad' : 'neutral'}
          delta={`${pct(data.blocked, data.total)} of traffic`}
        />
        <Stat label="Approved manually" value={num(data.approved)} />
        <Stat
          label="Pending approvals"
          value={live.pendingApprovals.length}
          tone={live.pendingApprovals.length ? 'warn' : 'neutral'}
          delta={
            live.pendingApprovals.length ? (
              <Link to="/approvals" className="text-accent-strong hover:underline">
                Review now
              </Link>
            ) : (
              'Queue is empty'
            )
          }
        />
        <Stat
          label="Active sessions"
          value={num(data.activeSessions)}
          delta={`${num(data.tokens)} tokens`}
        />
      </div>

      <Card className="mt-4">
        <CardHeader title="Traffic" description="Allowed vs. blocked requests" />
        <div className="h-64 px-2 py-3">
          {data.series.length === 0 ? (
            <EmptyState title="No traffic in this range" />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.series} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="allowed" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="#7c6cff" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#7c6cff" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="blocked" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="#ff5c72" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#ff5c72" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#232735" vertical={false} />
                <XAxis
                  dataKey="bucket"
                  tickFormatter={fmtTick}
                  stroke="#5d6377"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="#5d6377"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  width={36}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    background: '#11131a',
                    border: '1px solid #2f3445',
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  labelFormatter={(l) => new Date(String(l)).toLocaleString()}
                />
                <Area
                  type="monotone"
                  dataKey="allowed"
                  stroke="#7c6cff"
                  fill="url(#allowed)"
                  strokeWidth={1.5}
                />
                <Area
                  type="monotone"
                  dataKey="blocked"
                  stroke="#ff5c72"
                  fill="url(#blocked)"
                  strokeWidth={1.5}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Flagged requests"
            description="Recently blocked, declined or manually approved"
            actions={
              <Link
                to="/events"
                search={{ decision: 'block', range }}
                className="text-xs text-accent-strong hover:underline"
              >
                View all
              </Link>
            }
          />
          {data.riskiest.length === 0 ? (
            <EmptyState
              title="Nothing flagged"
              description="No request tripped a check in this range."
            />
          ) : (
            <Table>
              <TBody>
                {data.riskiest.map((e) => (
                  <TR
                    key={e.id}
                    onClick={() => navigate({ to: '/events', search: { selected: e.id, range } })}
                  >
                    <TD>
                      <DecisionBadge decision={e.decision} />
                    </TD>
                    <TD className="max-w-72">
                      <KindLabel kind={e.kind} model={e.model} toolName={e.toolName} />
                    </TD>
                    <TD className="max-w-60 truncate text-xs text-muted">
                      {e.checks.find((c) => c.outcome === 'fail')?.reason ?? '—'}
                    </TD>
                    <TD className="text-xs">{e.userName}</TD>
                    <TD>
                      <RiskMeter score={e.riskScore} />
                    </TD>
                    <TD className="text-right text-xs text-muted">{timeAgo(e.createdAt)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Top users" />
            <ul className="divide-y divide-line">
              {data.topUsers.map((u) => (
                <li key={u.userId} className="flex items-center justify-between px-4 py-2 text-xs">
                  <Link
                    to="/events"
                    search={{ user: u.userId, range }}
                    className="truncate hover:text-accent-strong"
                  >
                    {u.name ?? u.email ?? u.userId}
                  </Link>
                  <span className="font-mono text-muted tabular-nums">
                    {num(u.n)}
                    {u.blocked ? <span className="ml-2 text-bad">{u.blocked} blocked</span> : null}
                  </span>
                </li>
              ))}
              {data.topUsers.length === 0 ? (
                <li className="px-4 py-3 text-xs text-muted">No data</li>
              ) : null}
            </ul>
          </Card>
          <Card>
            <CardHeader title="Top tools" />
            <ul className="divide-y divide-line">
              {data.topTools.map((t) => (
                <li
                  key={t.toolName ?? 'unknown'}
                  className="flex items-center justify-between px-4 py-2 text-xs"
                >
                  <span className="truncate font-mono">{t.toolName}</span>
                  <span className="font-mono text-muted tabular-nums">{num(t.n)}</span>
                </li>
              ))}
              {data.topTools.length === 0 ? (
                <li className="px-4 py-3 text-xs text-muted">No tool calls yet</li>
              ) : null}
            </ul>
          </Card>
        </div>
      </div>
    </>
  )
}
