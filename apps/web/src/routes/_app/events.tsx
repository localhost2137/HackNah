import type { Decision, EventKind, GatewayEvent } from '@acl/shared'
import { eventKind, kindLabels } from '@acl/shared'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Mono,
  PageHeader,
  Select,
  Sheet,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@acl/ui'
import { keepPreviousData, queryOptions, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { Radio } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { ApprovalRecords } from '#/components/approval-records.tsx'
import {
  CheckList,
  DecisionBadge,
  JsonBlock,
  KindLabel,
  RiskMeter,
} from '#/components/event-bits.tsx'
import { FilterChip, Segmented } from '#/components/filters.tsx'
import { dateTime, decisionMeta, num, timeAgo } from '#/lib/format.ts'
import { useLive } from '#/lib/live.tsx'
import {
  type EventsSearch,
  eventsSearch,
  getEvent,
  listEvents,
  type TimeRange,
} from '#/server/fns/traffic.ts'

export const Route = createFileRoute('/_app/events')({
  validateSearch: eventsSearch,
  component: EventsPage,
})

type Row = Awaited<ReturnType<typeof listEvents>>['rows'][number]

function filterKey(s: EventsSearch) {
  const { selected: _selected, ...rest } = s
  return rest
}

function matchesLive(e: GatewayEvent, s: EventsSearch) {
  if (s.decision && e.decision !== s.decision) return false
  if (s.kind && e.kind !== s.kind) return false
  if (s.user && e.userId !== s.user) return false
  if (s.session && e.sessionId !== s.session) return false
  if (
    s.q &&
    !`${e.toolName ?? ''} ${e.model ?? ''} ${e.id}`.toLowerCase().includes(s.q.toLowerCase())
  )
    return false
  return true
}

function EventsPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const live = useLive()
  const [follow, setFollow] = useState(true)
  const [approvalsOpen, setApprovalsOpen] = useState(false)
  const filters = filterKey(search)

  const query = useInfiniteQuery({
    queryKey: ['events', filters],
    queryFn: ({ pageParam }) => listEvents({ data: { ...filters, cursor: pageParam } }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  })

  const rows = useMemo(() => {
    const loaded = query.data?.pages.flatMap((p) => p.rows) ?? []
    if (!follow) return loaded
    const known = new Set(loaded.map((r) => r.id))
    const newest = loaded[0]?.createdAt ? new Date(loaded[0].createdAt).getTime() : 0
    const fresh: Row[] = live.events
      .filter(
        (e) =>
          !known.has(e.id) && new Date(e.createdAt).getTime() >= newest && matchesLive(e, search),
      )
      .map((e) => ({
        seq: 0,
        id: e.id,
        kind: e.kind,
        model: e.model,
        toolName: e.toolName,
        decision: e.decision,
        riskScore: e.riskScore,
        latencyMs: e.latencyMs,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        sessionId: e.sessionId,
        country: e.country,
        createdAt: new Date(e.createdAt),
        userId: e.userId,
        userName: null,
        userEmail: null,
        checks: e.checks,
      }))
    return [...fresh, ...loaded]
  }, [query.data, live.events, follow, search])

  const setSearch = useCallback(
    (patch: Partial<EventsSearch>) =>
      navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true }),
    [navigate],
  )

  const columns = useMemo<ColumnDef<Row>[]>(
    () => [
      {
        header: 'Time',
        cell: ({ row }) => (
          <span className="text-xs text-muted" title={dateTime(row.original.createdAt)}>
            {timeAgo(row.original.createdAt)}
          </span>
        ),
      },
      { header: 'Decision', cell: ({ row }) => <DecisionBadge decision={row.original.decision} /> },
      {
        header: 'Request',
        cell: ({ row }) => (
          <div className="max-w-80">
            <KindLabel
              kind={row.original.kind}
              model={row.original.model}
              toolName={row.original.toolName}
            />
          </div>
        ),
      },
      {
        header: 'User',
        cell: ({ row }) => (
          <button
            type="button"
            className="max-w-48 truncate text-xs hover:text-accent-strong"
            onClick={(e) => {
              e.stopPropagation()
              setSearch({ user: row.original.userId })
            }}
          >
            {row.original.userName ?? row.original.userEmail ?? row.original.userId}
          </button>
        ),
      },
      { header: 'Risk', cell: ({ row }) => <RiskMeter score={row.original.riskScore} /> },
      {
        header: 'Signals',
        cell: ({ row }) => {
          const failed = row.original.checks.filter((c) => c.outcome === 'fail')
          return failed.length ? (
            <div className="flex max-w-64 gap-1 overflow-hidden">
              {failed.map((c) => (
                <Badge
                  key={`${c.workflowId}:${c.stepId}`}
                  tone={c.action === 'block' ? 'bad' : 'warn'}
                >
                  {c.type}
                </Badge>
              ))}
            </div>
          ) : (
            <span className="text-xs text-subtle">—</span>
          )
        },
      },
      {
        header: 'Tokens',
        cell: ({ row }) => (
          <Mono className="text-muted">
            {row.original.inputTokens != null
              ? `${num(row.original.inputTokens)} / ${num(row.original.outputTokens)}`
              : '—'}
          </Mono>
        ),
      },
      {
        header: 'Latency',
        cell: ({ row }) => <Mono className="text-muted">{row.original.latencyMs}ms</Mono>,
      },
    ],
    [setSearch],
  )

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (r) => r.id,
  })

  return (
    <>
      <PageHeader
        title="Logs"
        description="Every prompt and tool call that went through the gateway, with the checks that ran on it."
        actions={
          <Button
            variant={follow ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setFollow(!follow)}
          >
            <Radio /> {follow ? 'Live' : 'Paused'}
          </Button>
        }
      />
      <details
        className="mb-4 rounded-lg border border-line bg-panel"
        onToggle={(e) => setApprovalsOpen(e.currentTarget.open)}
      >
        <summary className="cursor-pointer px-4 py-3 text-sm text-muted">
          Approval records
          {live.pendingApprovals.length ? ` · ${live.pendingApprovals.length} pending` : ''}
        </summary>
        {approvalsOpen ? (
          <div className="border-t border-line p-4">
            <ApprovalRecords />
          </div>
        ) : null}
      </details>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented<TimeRange>
          value={search.range}
          onChange={(range) => setSearch({ range })}
          options={[
            { value: '1h', label: '1h' },
            { value: '24h', label: '24h' },
            { value: '7d', label: '7d' },
            { value: '30d', label: '30d' },
          ]}
        />
        <Select
          className="w-36"
          value={search.decision ?? ''}
          onChange={(e) =>
            setSearch({ decision: (e.target.value || undefined) as Decision | undefined })
          }
        >
          <option value="">All decisions</option>
          {Object.entries(decisionMeta).map(([value, meta]) => (
            <option key={value} value={value}>
              {meta.label}
            </option>
          ))}
        </Select>
        <Select
          className="w-36"
          value={search.kind ?? ''}
          onChange={(e) =>
            setSearch({ kind: (e.target.value || undefined) as EventKind | undefined })
          }
        >
          <option value="">All stages</option>
          {eventKind.options.map((k) => (
            <option key={k} value={k}>
              {kindLabels[k]}
            </option>
          ))}
        </Select>
        <Input
          className="w-64"
          placeholder="Tool, model or event id"
          defaultValue={search.q}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setSearch({ q: e.currentTarget.value || undefined })
          }}
        />
        {search.user ? (
          <FilterChip
            label={`User ${search.user.slice(0, 10)}`}
            onClear={() => setSearch({ user: undefined })}
          />
        ) : null}
        {search.session ? (
          <FilterChip
            label={`Session ${search.session.slice(0, 8)}`}
            onClear={() => setSearch({ session: undefined })}
          />
        ) : null}
      </div>

      <Card>
        {rows.length === 0 && !query.isLoading ? (
          <EmptyState
            title="No events yet"
            description={
              <>
                Point Claude Code at the gateway to start seeing traffic.{' '}
                <Link to="/settings/connect" className="text-accent-strong hover:underline">
                  Connect Claude Code
                </Link>
              </>
            }
          />
        ) : (
          <Table>
            <THead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => (
                    <TH key={h.id}>{flexRender(h.column.columnDef.header, h.getContext())}</TH>
                  ))}
                </tr>
              ))}
            </THead>
            <TBody>
              {table.getRowModel().rows.map((row) => (
                <TR
                  key={row.id}
                  onClick={() => setSearch({ selected: row.original.id })}
                  className={row.original.id === search.selected ? 'bg-panel-2' : undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TD key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TD>
                  ))}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {query.hasNextPage ? (
          <div className="flex justify-center border-t border-line p-3">
            <Button
              size="sm"
              onClick={() => query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        ) : null}
      </Card>

      <EventDrawer id={search.selected} onClose={() => setSearch({ selected: undefined })} />
    </>
  )
}

export const eventQuery = (id: string) =>
  queryOptions({ queryKey: ['event', id], queryFn: () => getEvent({ data: { id } }), retry: 2 })

function EventDrawer({ id, onClose }: { id: string | undefined; onClose: () => void }) {
  // Live rows can be clicked before the queue consumer has written them; retry briefly.
  const { data, isLoading } = useQuery({ ...eventQuery(id ?? ''), enabled: Boolean(id) })
  return (
    <Sheet
      open={Boolean(id)}
      onOpenChange={(open) => !open && onClose()}
      title={
        data ? <KindLabel kind={data.kind} model={data.model} toolName={data.toolName} /> : 'Event'
      }
      description={id}
      wide
    >
      {isLoading ? (
        <div className="text-xs text-muted">Loading…</div>
      ) : !data ? (
        <div className="text-xs text-muted">
          This event is still being ingested. Try again in a few seconds.
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-xs">
            <Meta label="Decision" value={<DecisionBadge decision={data.decision} />} />
            <Meta label="Risk" value={<RiskMeter score={data.riskScore} />} />
            <Meta label="User" value={data.userName ?? data.userId} sub={data.userEmail} />
            <Meta label="Device" value={data.deviceLabel ?? '—'} sub={data.country ?? undefined} />
            <Meta
              label="Session"
              value={
                data.sessionId ? (
                  <Link
                    to="/events"
                    search={{ session: data.sessionId, range: '30d' }}
                    className="font-mono hover:text-accent-strong"
                  >
                    {data.sessionId.slice(0, 13)}…
                  </Link>
                ) : (
                  '—'
                )
              }
            />
            <Meta label="Time" value={dateTime(data.createdAt)} sub={`${data.latencyMs}ms`} />
            <Meta
              label="Workflows"
              value={
                data.workflows.length
                  ? data.workflows.map((w) => `${w.name} v${w.version}`).join(', ')
                  : 'None matched'
              }
            />
            <Meta
              label="Tokens"
              value={
                data.inputTokens != null
                  ? `${num(data.inputTokens)} in / ${num(data.outputTokens)} out`
                  : '—'
              }
            />
          </dl>
          <section>
            <h4 className="mb-2 text-xs font-semibold text-muted uppercase">Checks</h4>
            <CheckList checks={data.checks} workflows={data.workflows} />
          </section>
          {data.payload ? (
            <>
              <section>
                <h4 className="mb-2 text-xs font-semibold text-muted uppercase">Input checked</h4>
                <JsonBlock value={data.payload.toolArguments ?? (data.payload.text || '(empty)')} />
              </section>
              {data.payload.response !== null ? (
                <section>
                  <h4 className="mb-2 text-xs font-semibold text-muted uppercase">Response</h4>
                  <JsonBlock value={data.payload.response} />
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </Sheet>
  )
}

function Meta({
  label,
  value,
  sub,
}: {
  label: string
  value: React.ReactNode
  sub?: string | null
}) {
  return (
    <div>
      <dt className="text-[11px] text-subtle">{label}</dt>
      <dd className="mt-0.5 text-fg">{value}</dd>
      {sub ? <dd className="text-[11px] text-muted">{sub}</dd> : null}
    </div>
  )
}
