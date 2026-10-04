import { globMatch, type ToolTier } from '@acl/shared'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Input,
  PageHeader,
  Stat,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@acl/ui'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { FormError } from '#/components/auth-shell.tsx'
import { DecisionBadge } from '#/components/event-bits.tsx'
import { num, timeAgo } from '#/lib/format.ts'
import { getMcpServerDetail, refreshMcpTools } from '#/server/fns/integrations.ts'

const detailQuery = (serverId: string) =>
  queryOptions({
    queryKey: ['mcp-servers', serverId],
    queryFn: () => getMcpServerDetail({ data: { serverId } }),
  })

export const Route = createFileRoute('/_app/integrations_/$serverId')({
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(detailQuery(params.serverId)),
  component: ServerPage,
})

const tierTone: Record<ToolTier, 'neutral' | 'warn' | 'bad'> = {
  read: 'neutral',
  write: 'warn',
  destructive: 'bad',
}

function ServerPage() {
  const { serverId } = Route.useParams()
  const navigate = Route.useNavigate()
  const qc = useQueryClient()
  const { data } = useQuery(detailQuery(serverId))
  const [filter, setFilter] = useState('')

  const invalidate = () => qc.invalidateQueries({ queryKey: ['mcp-servers'] })
  const refresh = useMutation({
    mutationFn: () => refreshMcpTools({ data: { serverId } }),
    onSuccess: invalidate,
  })

  if (!data) return null
  const { server, tools, groups, resources } = data
  const shown = tools.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()))
  const totalCalls = tools.reduce((n, t) => n + t.usage.calls, 0)
  const blocked = tools.reduce((n, t) => n + t.usage.blocked, 0)
  const resourcesUsing = resources.filter((r) => r.patterns.length || r.everyServer.length).length
  const coveringResources = (tool: string) =>
    resources.filter((r) => [...r.patterns, ...r.everyServer].some((p) => globMatch(p, tool)))
  const grantLabel = (grants: { type: string; id: string }[]) =>
    grants.length === 0
      ? 'Not granted to anyone'
      : `Granted to ${grants
          .map((s) =>
            s.type === 'group' ? (groups.find((g) => g.id === s.id)?.name ?? s.id) : 'a user',
          )
          .join(', ')}`

  return (
    <>
      <Link
        to="/integrations"
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-fg"
      >
        <ArrowLeft className="size-3.5" /> Integrations
      </Link>
      <PageHeader
        title={server.name}
        description={
          <>
            <span className="font-mono">{server.slug}__*</span> · {server.url}
            {server.enabled ? '' : ' · disabled'}
          </>
        }
        actions={
          <Button size="sm" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
            <RefreshCw className={refresh.isPending ? 'animate-spin' : ''} /> Refresh tools
          </Button>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Tools"
          value={tools.length}
          delta={
            server.toolsRefreshedAt
              ? `refreshed ${timeAgo(server.toolsRefreshedAt)}`
              : 'never refreshed'
          }
        />
        <Stat label={`Calls · ${data.statsDays}d`} value={num(totalCalls)} />
        <Stat
          label={`Blocked · ${data.statsDays}d`}
          value={num(blocked)}
          tone={blocked ? 'warn' : 'neutral'}
        />
        <Stat
          label="Resources using it"
          value={`${resourcesUsing} / ${resources.length}`}
          delta="Admins can call every tool"
        />
      </div>

      <Card className="mb-4">
        <CardHeader
          title="Tools"
          description="What this server offers, and the resources each tool is in. A tool in no resource can only be called by admins. Change that on the Resources page."
          actions={
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter tools"
              className="h-8 w-48"
            />
          }
        />
        {tools.length === 0 ? (
          <EmptyState
            title="No tools loaded"
            description="Refresh tools to load what this server offers."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <tr>
                  <TH>Tool</TH>
                  <TH className="text-right">Calls</TH>
                  <TH>In resources</TH>
                </tr>
              </THead>
              <TBody>
                {shown.map((t) => (
                  <TR key={t.name}>
                    <TD className="max-w-96">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{t.name}</span>
                        <Badge tone={tierTone[t.tier]}>{t.tier}</Badge>
                      </div>
                      {t.description ? (
                        <div className="truncate text-[11px] text-subtle" title={t.description}>
                          {t.description}
                        </div>
                      ) : null}
                    </TD>
                    <TD className="text-right text-xs whitespace-nowrap tabular-nums">
                      {t.usage.calls ? (
                        <span title={t.usage.last ? `last ${timeAgo(t.usage.last)}` : undefined}>
                          {num(t.usage.calls)}
                          {t.usage.blocked ? (
                            <span className="text-bad"> · {num(t.usage.blocked)} blocked</span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-subtle">—</span>
                      )}
                    </TD>
                    <TD>
                      <div className="flex max-w-96 flex-wrap gap-1">
                        {coveringResources(t.name).map((r) => (
                          <Link
                            key={r.id}
                            to="/access/resources/$resourceId"
                            params={{ resourceId: r.id }}
                            title={grantLabel(r.grants)}
                          >
                            <Badge tone="info">{r.name}</Badge>
                          </Link>
                        ))}
                        {coveringResources(t.name).length === 0 ? (
                          <span className="text-xs text-subtle">Admins only</span>
                        ) : null}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
        <div className="px-4 pb-3">
          <FormError message={refresh.error?.message ?? null} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Recent calls"
          description={
            data.unlistedCalls
              ? `Includes calls to ${data.unlistedCalls} tools the server no longer lists.`
              : 'Every call made to this server through the gateway.'
          }
        />
        {data.recent.length === 0 ? (
          <EmptyState title="No calls yet" />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>When</TH>
                <TH>User</TH>
                <TH>Tool</TH>
                <TH>Decision</TH>
                <TH className="text-right">Latency</TH>
              </tr>
            </THead>
            <TBody>
              {data.recent.map((e) => (
                <TR
                  key={e.id}
                  className="cursor-pointer"
                  onClick={() =>
                    navigate({ to: '/events', search: { selected: e.id, range: '30d' } })
                  }
                >
                  <TD className="text-xs whitespace-nowrap text-muted">{timeAgo(e.createdAt)}</TD>
                  <TD className="text-xs">{e.userName ?? e.userEmail ?? '—'}</TD>
                  <TD className="font-mono text-xs">{e.toolName}</TD>
                  <TD>
                    <DecisionBadge decision={e.decision} />
                  </TD>
                  <TD className="text-right text-xs text-muted tabular-nums">{e.latencyMs} ms</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  )
}
