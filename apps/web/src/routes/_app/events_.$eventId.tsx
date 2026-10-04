import { type GuardrailRef, guardrailPath, kindLabels } from '@acl/shared'
import { Badge, Button, Card, cn, EmptyState } from '@acl/ui'
import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Background, Controls, ReactFlow } from '@xyflow/react'
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import {
  CheckList,
  CopyButton,
  DecisionBadge,
  KindLabel,
  TraceId,
} from '#/components/event-bits.tsx'
import { type FlowNode, flowEdge, nodeTypes } from '#/components/guardrail/graph-nodes.tsx'
import { dateTime, decisionMeta } from '#/lib/format.ts'
import { getEventPath } from '#/server/fns/traffic.ts'

const pathQuery = (id: string) =>
  queryOptions({
    queryKey: ['event-path', id],
    queryFn: () => getEventPath({ data: { id } }),
    // A live event can be opened before the queue consumer has written it.
    retry: 2,
  })

export const Route = createFileRoute('/_app/events_/$eventId')({
  validateSearch: z.object({ guardrail: z.string().optional() }),
  component: PathPage,
})

type PathData = NonNullable<Awaited<ReturnType<typeof getEventPath>>>

const dotTone = { ok: 'bg-ok', bad: 'bg-bad', warn: 'bg-warn', info: 'bg-info' } as const
const guardrailTone = { allow: 'ok', block: 'bad', pending: 'warn', skip: 'neutral' } as const
const guardrailLabel = { allow: 'allow', block: 'block', pending: 'approval', skip: 'skipped' }

/** The guardrail that decided the event, or the first one that did anything. */
function decidingGuardrail(guardrails: GuardrailRef[]): string | undefined {
  const by = (d: GuardrailRef['decision']) => guardrails.find((g) => g.decision === d)
  return (by('block') ?? by('pending') ?? guardrails.find((g) => g.decision !== 'skip'))?.id
}

function PathPage() {
  const { eventId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data, isLoading } = useQuery({ ...pathQuery(eventId), placeholderData: keepPreviousData })

  const trace = data?.trace ?? []
  const index = trace.findIndex((e) => e.id === data?.event.id)
  const previous = index > 0 ? trace[index - 1] : undefined
  const next = index >= 0 ? trace[index + 1] : undefined
  const open = useCallback(
    (id: string | undefined) => {
      if (id) void navigate({ to: '/events/$eventId', params: { eventId: id }, search: (s) => s })
    },
    [navigate],
  )
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select')) return
      if (e.key === 'ArrowLeft') open(previous?.id)
      if (e.key === 'ArrowRight') open(next?.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, previous?.id, next?.id])

  if (isLoading) return <div className="text-xs text-muted">Loading…</div>
  if (!data)
    return (
      <Card>
        <EmptyState
          title="Event not found"
          description="It may still be ingesting, or it is older than the logs kept."
          action={
            <Link to="/events" search={{ range: '24h' }} className="text-xs text-accent-strong">
              Back to Logs
            </Link>
          }
        />
      </Card>
    )

  const { event } = data
  const selectedId =
    event.guardrails.find((g) => g.id === search.guardrail)?.id ??
    decidingGuardrail(event.guardrails) ??
    event.guardrails[0]?.id
  const outside = event.checks.filter((c) => !c.guardrailId)

  return (
    <>
      <Link
        to="/events"
        search={event.traceId ? { trace: event.traceId, range: '30d' } : { range: '24h' }}
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-fg"
      >
        <ArrowLeft className="size-3.5" /> {event.traceId ? 'Trace in Logs' : 'Logs'}
      </Link>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-5">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          {kindLabels[event.kind]}
          <span className="font-mono text-sm font-normal text-muted">
            {event.toolName ?? event.model ?? ''}
          </span>
        </h1>
        <DecisionBadge decision={event.decision} />
        <span className="text-xs text-muted">
          {dateTime(event.createdAt)} · {event.userName ?? event.userEmail ?? event.userId}
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-muted">
          Event <span className="font-mono">{event.id.slice(0, 16)}</span>
          <CopyButton value={event.id} label="Copy event id" />
        </span>
        {event.traceId ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            Trace <TraceId traceId={event.traceId} />
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" disabled={!previous} onClick={() => open(previous?.id)}>
            <ChevronLeft /> Previous
          </Button>
          <span className="text-xs text-muted tabular-nums">
            {index + 1} of {trace.length}
          </span>
          <Button size="sm" disabled={!next} onClick={() => open(next?.id)}>
            Next <ChevronRight />
          </Button>
        </div>
      </div>

      <div className="flex items-start gap-4">
        <TraceRoad trace={trace} currentId={event.id} onOpen={open} />
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {event.guardrails.length === 0 ? (
            <Card>
              <EmptyState
                title="No guardrail ran on this event"
                description={
                  outside.length
                    ? 'It was decided before the guardrails, by the checks below.'
                    : 'No guardrail starts on this request, so it was allowed.'
                }
              />
            </Card>
          ) : (
            <>
              {event.guardrails.length > 1 ? (
                <div className="flex flex-wrap gap-2">
                  {event.guardrails.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() =>
                        navigate({ search: (s) => ({ ...s, guardrail: g.id }), replace: true })
                      }
                      className={cn(
                        'inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-xs',
                        g.id === selectedId
                          ? 'border-accent bg-accent-soft text-fg'
                          : 'border-line-strong bg-panel text-muted hover:text-fg',
                      )}
                    >
                      {g.name} <span className="text-subtle">v{g.version}</span>
                      {g.decision ? (
                        <Badge tone={guardrailTone[g.decision]}>{guardrailLabel[g.decision]}</Badge>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
              {selectedId ? <GuardrailPathCard data={data} guardrailId={selectedId} /> : null}
            </>
          )}
          {outside.length ? (
            <section>
              <h2 className="mb-2 text-xs font-semibold text-muted uppercase">
                Checks outside guardrails
              </h2>
              <CheckList checks={outside} />
            </section>
          ) : null}
        </div>
      </div>
    </>
  )
}

/** The events of the trace in the order they happened. */
function TraceRoad({
  trace,
  currentId,
  onOpen,
}: {
  trace: PathData['trace']
  currentId: string
  onOpen: (id: string) => void
}) {
  return (
    <Card className="w-60 shrink-0 overflow-hidden">
      <div className="border-b border-line px-3 py-2 text-xs font-medium text-muted">
        Trace · {trace.length} {trace.length === 1 ? 'event' : 'events'}
      </div>
      <ol className="max-h-[calc(100vh-240px)] overflow-y-auto py-1">
        {trace.map((e, i) => (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => onOpen(e.id)}
              aria-current={e.id === currentId ? 'step' : undefined}
              title={`${kindLabels[e.kind]} · ${decisionMeta[e.decision].label} · ${dateTime(e.createdAt)}`}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel-2',
                e.id === currentId && 'bg-accent-soft',
              )}
            >
              <span className="w-5 text-right font-mono text-[11px] text-subtle">{i + 1}</span>
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  dotTone[decisionMeta[e.decision].tone as keyof typeof dotTone] ?? 'bg-muted',
                )}
              />
              <span className="min-w-0 flex-1">
                <KindLabel kind={e.kind} model={e.model} toolName={e.toolName} />
              </span>
            </button>
          </li>
        ))}
      </ol>
    </Card>
  )
}

function GuardrailPathCard({ data, guardrailId }: { data: PathData; guardrailId: string }) {
  const ref = data.event.guardrails.find((g) => g.id === guardrailId)!
  const stored = data.graphs.find((g) => g.guardrailId === guardrailId)
  const graph = stored?.graph ?? null
  const checks = data.event.checks.filter((c) => c.guardrailId === guardrailId)
  const path = useMemo(
    () => (graph ? guardrailPath(graph, data.event.checks, guardrailId) : null),
    [graph, data.event.checks, guardrailId],
  )
  // React Flow measures the DOM, so it only renders in the browser.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const nodes: FlowNode[] = useMemo(
    () =>
      graph && path
        ? graph.nodes.map((n) => ({
            id: n.id,
            type: n.type,
            position: n.position,
            data: {
              node: n,
              issues: [],
              onPath: path.nodes.has(n.id),
              step: path.steps.get(n.id),
              end: path.endNodeId === n.id,
              fallback: path.endNodeId === n.id ? (path.fallback ?? undefined) : undefined,
            },
          }))
        : [],
    [graph, path],
  )
  const edges = useMemo(() => {
    if (!graph || !path) return []
    const byId = new Map(graph.nodes.map((n) => [n.id, n]))
    return graph.edges.map((e) => flowEdge(e, byId.get(e.source), path.edges.has(e.id)))
  }, [graph, path])

  return (
    <>
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 text-xs">
          <span className="font-medium text-fg">{ref.name}</span>
          <span className="text-muted">v{ref.version}, as it ran</span>
          {stored?.publishedVersion != null && stored.publishedVersion !== ref.version ? (
            <span className="text-subtle">· v{stored.publishedVersion} is published now</span>
          ) : null}
          {ref.durationMs != null ? (
            <span className="font-mono text-subtle">{ref.durationMs}ms</span>
          ) : null}
          {stored?.exists ? (
            <Link
              to="/guardrails/$guardrailId"
              params={{ guardrailId }}
              className="ml-auto text-accent-strong hover:underline"
            >
              Open guardrail
            </Link>
          ) : null}
        </div>
        {path?.fallback ? (
          <div className="border-b border-line bg-warn-soft px-4 py-2 text-xs text-warn">
            Ended in the guardrail fallback: {path.fallback.reason}
          </div>
        ) : null}
        {path && path.unmatched.length > 0 ? (
          <div className="border-b border-line px-4 py-2 text-xs text-muted">
            {path.unmatched.length} recorded {path.unmatched.length === 1 ? 'step is' : 'steps are'}{' '}
            not in this version's chart; see Steps below.
          </div>
        ) : null}
        {!graph ? (
          <EmptyState
            title={
              stored?.exists
                ? `Version ${ref.version} of this guardrail is no longer stored`
                : 'This guardrail was deleted'
            }
            description="The chart cannot be drawn. The steps the event recorded are listed below."
          />
        ) : mounted ? (
          <div className="guardrail-canvas h-[55vh] min-h-[420px]">
            <ReactFlow<FlowNode>
              // Keep the viewport while stepping through events of the same version.
              key={`${guardrailId}:${ref.version}`}
              colorMode="dark"
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              deleteKeyCode={null}
              fitView
              fitViewOptions={{ padding: 0.12 }}
              minZoom={0.25}
              maxZoom={1.8}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={24} size={1} color="#2a3950" />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
        ) : (
          <div className="h-[55vh] min-h-[420px]" />
        )}
      </Card>
      <section>
        <h2 className="mb-2 text-xs font-semibold text-muted uppercase">Steps</h2>
        <CheckList checks={checks} />
      </section>
    </>
  )
}
