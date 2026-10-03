import { Badge, Card, EmptyState, Mono, PageHeader, Table, TBody, TD, TH, THead, TR } from '@acl/ui'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { z } from 'zod'
import { Segmented } from '#/components/filters.tsx'
import { num, timeAgo } from '#/lib/format.ts'
import { listSessions } from '#/server/fns/traffic.ts'

const sessionsQuery = (active: boolean) =>
  queryOptions({
    queryKey: ['sessions', active],
    queryFn: () => listSessions({ data: { active } }),
    refetchInterval: 15_000,
  })

export const Route = createFileRoute('/_app/sessions')({
  validateSearch: z.object({ view: z.enum(['active', 'all']).default('active') }),
  loaderDeps: ({ search }) => ({ active: search.view === 'active' }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(sessionsQuery(deps.active)),
  component: SessionsPage,
})

function SessionsPage() {
  const { view } = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data = [] } = useQuery(sessionsQuery(view === 'active'))

  return (
    <>
      <PageHeader
        title="Sessions"
        description="Claude Code sessions seen by the gateway. A session is pinned to the user and device that started it."
        actions={
          <Segmented
            value={view}
            onChange={(v) => navigate({ search: { view: v } })}
            options={[
              { value: 'active', label: 'Active (1h)' },
              { value: 'all', label: 'All' },
            ]}
          />
        }
      />
      <Card>
        {data.length === 0 ? (
          <EmptyState
            title="No sessions"
            description="Sessions appear once Claude Code sends requests through the gateway."
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Session</TH>
                <TH>User</TH>
                <TH>Device</TH>
                <TH>Scope</TH>
                <TH className="text-right">Requests</TH>
                <TH className="text-right">Blocked</TH>
                <TH className="text-right">Tokens</TH>
                <TH>Started</TH>
                <TH>Last seen</TH>
              </tr>
            </THead>
            <TBody>
              {data.map(({ session: s, userName, userEmail, deviceLabel, deviceStatus }) => (
                <TR
                  key={s.id}
                  onClick={() =>
                    navigate({ to: '/events', search: { session: s.id, range: '30d' } })
                  }
                >
                  <TD>
                    <Mono>{s.id.slice(0, 13)}…</Mono>
                  </TD>
                  <TD className="text-xs">
                    <div>{userName}</div>
                    <div className="text-[11px] text-subtle">{userEmail}</div>
                  </TD>
                  <TD className="text-xs">
                    <span className="mr-2">{deviceLabel ?? '—'}</span>
                    {deviceStatus && deviceStatus !== 'trusted' ? (
                      <Badge tone={deviceStatus === 'revoked' ? 'bad' : 'warn'}>
                        {deviceStatus}
                      </Badge>
                    ) : null}
                  </TD>
                  <TD className="text-xs text-muted">
                    {s.resourceIds.length ? `${s.resourceIds.length} resources` : 'All granted'}
                  </TD>
                  <TD className="text-right font-mono text-xs">{num(s.requestCount)}</TD>
                  <TD className="text-right font-mono text-xs">
                    <span className={s.blockedCount ? 'text-bad' : 'text-muted'}>
                      {num(s.blockedCount)}
                    </span>
                  </TD>
                  <TD className="text-right font-mono text-xs text-muted">
                    {num(s.inputTokens + s.outputTokens)}
                  </TD>
                  <TD className="text-xs text-muted">{timeAgo(s.startedAt)}</TD>
                  <TD className="text-xs text-muted">{timeAgo(s.lastSeenAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <p className="mt-3 text-xs text-subtle">
        Click a session to see its events. Revoke a device on the{' '}
        <Link to="/devices" className="text-accent-strong hover:underline">
          Devices
        </Link>{' '}
        page to cut off all of its sessions.
      </p>
    </>
  )
}
