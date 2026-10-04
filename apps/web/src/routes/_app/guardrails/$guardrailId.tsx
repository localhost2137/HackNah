import {
  type BlockGroup,
  type BlockSpec,
  type EvaluationResult,
  formatAmount,
  type GraphIssue,
  nodeOutputs,
  type PolicyEdge,
  type PolicyGraph,
  type PolicyNode,
  policyGraph,
  validateGraph,
  windowLabel,
} from '@acl/shared'
import { Badge, Button, Card, Dialog, Field, Input, PageHeader, Select } from '@acl/ui'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  type Connection,
  Controls,
  type Edge,
  type EdgeChange,
  MiniMap,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import { ArrowLeft, History, Maximize2, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { FormError } from '#/components/auth-shell.tsx'
import { DryRun } from '#/components/guardrail/dry-run.tsx'
import {
  blockIcons,
  type FlowNode,
  flowEdge,
  nodeTypes,
} from '#/components/guardrail/graph-nodes.tsx'
import { Inspector, type PickerOptions } from '#/components/guardrail/inspector.tsx'
import { recommendSteps, type Suggestion } from '#/components/guardrail/recommendations.ts'
import { timeAgo } from '#/lib/format.ts'
import { listGroups, listResources } from '#/server/fns/access.ts'
import { discardDraft, getGuardrail, publishDraft, saveDraft } from '#/server/fns/guardrail.ts'
import { listMcpServers } from '#/server/fns/integrations.ts'
import { listLimits } from '#/server/fns/limits.ts'

const guardrailQuery = (guardrailId: string) =>
  queryOptions({
    queryKey: ['guardrail', guardrailId],
    queryFn: () => getGuardrail({ data: { guardrailId } }),
  })
const serversQuery = queryOptions({ queryKey: ['mcp-servers'], queryFn: () => listMcpServers() })
const resourcesQuery = queryOptions({ queryKey: ['resources'], queryFn: () => listResources() })
const groupsQuery = queryOptions({ queryKey: ['groups'], queryFn: () => listGroups() })
const limitsQuery = queryOptions({ queryKey: ['limits'], queryFn: () => listLimits() })

export const Route = createFileRoute('/_app/guardrails/$guardrailId')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(guardrailQuery(params.guardrailId)),
  // Editor state belongs to one guardrail; start over when switching to another.
  component: () => <GuardrailPage key={Route.useParams().guardrailId} />,
})

type InsertionPoint = { source: string; handle: string }

function shortId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 7)}`
}

function createNode(block: BlockSpec, position: { x: number; y: number }): PolicyNode {
  return { id: shortId(block.id.replace('_', '-')), position, ...block.create() } as PolicyNode
}

/** Key order differs between what the editor builds and what the server parsed. */
function canonical(graph: unknown): string {
  const parsed = policyGraph.safeParse(graph)
  return JSON.stringify(parsed.success ? parsed.data : graph)
}

/** Would an edge from `source` to `target` close a loop? */
function createsCycle(edges: PolicyEdge[], source: string, target: string): boolean {
  const stack = [target]
  const seen = new Set<string>()
  while (stack.length) {
    const id = stack.pop()!
    if (id === source) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const e of edges) if (e.source === id) stack.push(e.target)
  }
  return false
}

function GuardrailPage() {
  const { isAdmin } = Route.useRouteContext()
  const { guardrailId } = Route.useParams()
  const qc = useQueryClient()
  const { data } = useQuery(guardrailQuery(guardrailId))
  const { data: servers } = useQuery(serversQuery)
  const { data: resources } = useQuery(resourcesQuery)
  const { data: groups } = useQuery(groupsQuery)
  const { data: limits } = useQuery(limitsQuery)
  const [graph, setGraph] = useState<PolicyGraph | null>(null)
  const [publishOpen, setPublishOpen] = useState(false)
  const [note, setNote] = useState('')
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])
  useEffect(() => {
    if (data && !graph) setGraph(data.working)
  }, [data, graph])

  const baseline = data?.draft?.definition ?? data?.published?.definition ?? data?.working
  const dirty = useMemo(() => canonical(graph) !== canonical(baseline), [graph, baseline])
  const parsed = graph ? policyGraph.safeParse(graph) : null
  const issues = useMemo(() => (graph ? validateGraph(graph) : []), [graph])
  const errorCount = issues.filter((i) => i.level === 'error').length

  const options: PickerOptions = useMemo(
    () => ({
      servers: (servers ?? []).map((s) => ({ value: s.id, label: s.name })),
      resources: (resources ?? []).map((r) => ({
        value: r.id,
        label: r.name,
      })),
      groups: (groups ?? []).map((g) => ({ value: g.id, label: g.name })),
      limits: (limits ?? [])
        .filter((l) => l.action === 'guardrail')
        .map((l) => ({
          value: l.id,
          label: l.name || `${formatAmount(l.measure, l.limit)} per ${windowLabel(l.windowSec)}`,
        })),
    }),
    [servers, resources, groups, limits],
  )

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['guardrail', guardrailId] }),
      qc.invalidateQueries({ queryKey: ['guardrails'] }),
    ])
  const save = useMutation({
    mutationFn: (g: PolicyGraph) => saveDraft({ data: { guardrailId, definition: g } }),
    onSuccess: refresh,
  })
  const publish = useMutation({
    mutationFn: async () => {
      if (dirty && graph) await saveDraft({ data: { guardrailId, definition: graph } })
      return publishDraft({ data: { guardrailId, note: note || undefined } })
    },
    onSuccess: async () => {
      setPublishOpen(false)
      setNote('')
      await refresh()
    },
  })
  const discard = useMutation({
    mutationFn: () => discardDraft({ data: { guardrailId } }),
    onSuccess: async () => {
      setGraph(null)
      await refresh()
    },
  })
  const navigate = Route.useNavigate()
  const openImpact = async () => {
    const version =
      dirty && graph
        ? (await save.mutateAsync(graph)).version
        : (data?.draft?.version ?? data?.published?.version)
    await navigate({
      to: '/guardrails/$guardrailId/impact',
      params: { guardrailId },
      search: { version },
    })
  }

  if (!data || !graph) return null

  return (
    <>
      <Link
        to="/guardrails"
        className="mb-2 inline-flex items-center gap-1 text-xs text-muted hover:text-fg"
      >
        <ArrowLeft className="size-3.5" /> All guardrails
      </Link>
      <PageHeader
        title={data.guardrail.name}
        description="A request enters at Start and follows the outputs to a decision."
        actions={
          isAdmin ? (
            <>
              {data.draft ? (
                <Button
                  variant="ghost"
                  onClick={() => discard.mutate()}
                  disabled={discard.isPending}
                >
                  Discard draft
                </Button>
              ) : null}
              <Button onClick={openImpact} disabled={!parsed?.success || save.isPending}>
                <History className="size-4" /> Impact
              </Button>
              <Button
                onClick={() => save.mutate(graph)}
                disabled={!dirty || !parsed?.success || save.isPending}
              >
                Save draft
              </Button>
              <Button
                variant="primary"
                onClick={() => setPublishOpen(true)}
                disabled={!parsed?.success || errorCount > 0 || (!dirty && !data.draft)}
              >
                Publish
              </Button>
            </>
          ) : null
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-muted">
        <span>
          Live:{' '}
          {data.published ? (
            <Badge tone="ok">v{data.published.version}</Badge>
          ) : (
            <Badge tone="neutral">not published</Badge>
          )}
        </span>
        {data.guardrail.enabled ? null : <Badge tone="neutral">Disabled</Badge>}
        {data.draft ? <Badge tone="warn">Draft v{data.draft.version}</Badge> : null}
        {dirty ? <Badge tone="accent">Unsaved changes</Badge> : null}
        {errorCount > 0 ? (
          <span className="text-bad">
            {errorCount} {errorCount === 1 ? 'problem' : 'problems'} to fix before publishing
          </span>
        ) : null}
        {parsed && !parsed.success ? (
          <span className="text-bad">
            {parsed.error.issues[0]?.path.join('.')}: {parsed.error.issues[0]?.message}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          Unconnected outputs
          <Select
            className="h-7 w-28"
            value={graph.fallback}
            disabled={!isAdmin}
            onChange={(e) => setGraph({ ...graph, fallback: e.target.value as 'allow' | 'block' })}
          >
            <option value="block">block</option>
            <option value="allow">allow</option>
          </Select>
        </span>
      </div>

      {mounted ? (
        <ReactFlowProvider>
          <Editor
            graph={graph}
            setGraph={setGraph}
            issues={issues}
            options={options}
            isAdmin={isAdmin}
            versions={data.versions}
            publishedId={data.published?.id ?? null}
          />
        </ReactFlowProvider>
      ) : (
        <Card className="h-[calc(100vh-230px)] min-h-[520px]" />
      )}

      <Dialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        title="Publish guardrail"
        description="Gateways pick up the new version within about 10 seconds."
        footer={
          <>
            <Button variant="ghost" onClick={() => setPublishOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => publish.mutate()} disabled={publish.isPending}>
              Publish
            </Button>
          </>
        }
      >
        <Field label="What changed?">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Judge GitHub write tools"
          />
        </Field>
        <div className="mt-3">
          <FormError message={publish.error?.message ?? null} />
        </div>
      </Dialog>
    </>
  )
}

type Version = Awaited<ReturnType<typeof getGuardrail>>['versions'][number]
type Tab = 'inspect' | 'test' | 'history'

const tabLabels: Record<Tab, string> = {
  inspect: 'Details',
  test: 'Test request',
  history: 'History',
}
const tabTitles: Record<Tab, string> = {
  inspect: 'Step settings',
  test: 'Try an example request',
  history: 'Saved versions',
}

function Editor({
  graph,
  setGraph,
  issues,
  options,
  isAdmin,
  versions,
  publishedId,
}: {
  graph: PolicyGraph
  setGraph: (g: PolicyGraph) => void
  issues: GraphIssue[]
  options: PickerOptions
  isAdmin: boolean
  versions: Version[]
  publishedId: string | null
}) {
  const flow = useReactFlow()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set())
  const [measured, setMeasured] = useState<Record<string, FlowNode['measured']>>({})
  const [tab, setTab] = useState<Tab>('inspect')
  const [panelOpen, setPanelOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [pickerPosition, setPickerPosition] = useState({ left: 24, top: 24 })
  const [stepSearch, setStepSearch] = useState('')
  const [otherOpen, setOtherOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (paletteOpen) {
      setStepSearch('')
      setOtherOpen(false)
      searchRef.current?.focus()
    }
  }, [paletteOpen])
  const [insertion, setInsertion] = useState<InsertionPoint | null>(null)
  const [run, setRun] = useState<EvaluationResult | null>(null)

  const canvasRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => flow.fitView({ padding: 0.12, duration: 200 }))
    })
    observer.observe(canvas)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [flow])

  const trigger = graph.nodes.find((n) => n.type === 'trigger')
  const path = useMemo(() => {
    if (!run) return null
    const nodes = new Set([trigger?.id, ...run.checks.map((c) => c.stepId)])
    const edges = new Set([
      `${trigger?.id}:next`,
      ...run.checks.map((c) => `${c.stepId}:${c.branch}`),
    ])
    return { nodes, edges }
  }, [run, trigger?.id])

  const issuesByNode = useMemo(() => {
    const map = new Map<string, GraphIssue[]>()
    for (const i of issues) if (i.nodeId) map.set(i.nodeId, [...(map.get(i.nodeId) ?? []), i])
    return map
  }, [issues])

  const nodes: FlowNode[] = graph.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position,
    measured: measured[n.id],
    selected: n.id === selectedId,
    deletable: isAdmin && n.type !== 'trigger',
    data: {
      node: n,
      onAdd: isAdmin
        ? (handle: string, anchor: { x: number; y: number }) => {
            const box = canvasRef.current?.getBoundingClientRect()
            if (box) {
              const x = anchor.x - box.left
              const left = x + 300 < box.width ? x + 16 : x - 296
              setPickerPosition({
                left: Math.max(12, Math.min(left, box.width - 292)),
                top: Math.max(12, Math.min(anchor.y - box.top - 60, box.height - 252)),
              })
            }
            setStepSearch('')
            setOtherOpen(false)
            setInsertion({ source: n.id, handle })
            setPaletteOpen(true)
          }
        : undefined,
      issues: issuesByNode.get(n.id) ?? [],
      onPath: path ? path.nodes.has(n.id) : null,
    },
  }))

  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]))
  const edges: Edge[] = graph.edges.map((e) => ({
    ...flowEdge(
      e,
      nodesById.get(e.source),
      path ? path.edges.has(`${e.source}:${e.sourceHandle}`) : null,
    ),
    selected: selectedEdges.has(e.id),
  }))

  const onNodesChange = (changes: NodeChange<FlowNode>[]) => {
    const next = applyNodeChanges(changes, nodes)
    if (changes.some((c) => c.type === 'dimensions')) {
      setMeasured(Object.fromEntries(next.map((n) => [n.id, n.measured])))
    }
    if (changes.some((c) => c.type === 'select')) {
      const sel = next.find((n) => n.selected)?.id ?? null
      setSelectedId(sel)
      if (sel) {
        setTab('inspect')
        setPanelOpen(true)
      }
    }
    if (changes.some((c) => c.type === 'position' || c.type === 'remove')) {
      const byId = new Map(next.map((n) => [n.id, n]))
      setGraph({
        ...graph,
        nodes: graph.nodes.flatMap((n) => {
          const f = byId.get(n.id)
          if (!f) return []
          return f.position === n.position ? [n] : [{ ...n, position: f.position }]
        }),
        edges: graph.edges.filter((e) => byId.has(e.source) && byId.has(e.target)),
      })
    }
  }

  const onEdgesChange = (changes: EdgeChange[]) => {
    const next = applyEdgeChanges(changes, edges)
    if (changes.some((c) => c.type === 'select')) {
      setSelectedEdges(new Set(next.filter((e) => e.selected).map((e) => e.id)))
    }
    if (changes.some((c) => c.type === 'remove')) {
      const keep = new Set(next.map((e) => e.id))
      setGraph({ ...graph, edges: graph.edges.filter((e) => keep.has(e.id)) })
    }
  }

  const isValidConnection = (c: Connection | Edge) => {
    if (!c.sourceHandle || c.source === c.target) return false
    const target = graph.nodes.find((n) => n.id === c.target)
    if (!target || target.type === 'trigger') return false
    const others = graph.edges.filter(
      (e) => !(e.source === c.source && e.sourceHandle === c.sourceHandle),
    )
    return !createsCycle(others, c.source, c.target)
  }

  const onConnect = (c: Connection) => {
    if (!c.sourceHandle) return
    const others = graph.edges.filter(
      (e) => !(e.source === c.source && e.sourceHandle === c.sourceHandle),
    )
    setGraph({
      ...graph,
      edges: [
        ...others,
        { id: shortId('e'), source: c.source, sourceHandle: c.sourceHandle, target: c.target },
      ],
    })
  }

  const insertionSource = graph.nodes.find((n) => n.id === insertion?.source)
  const existingConnection = graph.edges.find(
    (e) => e.source === insertion?.source && e.sourceHandle === insertion?.handle,
  )
  const suggestions = useMemo(
    () => (insertion ? recommendSteps(graph, insertion.source, insertion.handle) : []),
    [graph, insertion],
  )
  const search = stepSearch.trim().toLowerCase()
  const matchesSearch = suggestions.filter(({ block }) =>
    `${block.label} ${block.group} ${block.id} ${block.description}`.toLowerCase().includes(search),
  )
  const renderChoice = (choice: Suggestion) => (
    <PaletteButton
      key={choice.block.id}
      block={choice.block}
      reason={choice.reason}
      disabled={!isAdmin || !insertionSource || choice.disabled}
      onAdd={() => addNode(choice.block)}
    />
  )
  const others = suggestions.filter((s) => !s.recommended)
  const otherGroups = [...new Set(others.map((s) => s.block.group))]
  const addNode = (block: BlockSpec) => {
    if (!insertion || !insertionSource) return
    const position = { x: insertionSource.position.x + 340, y: insertionSource.position.y }
    const node = createNode(block, position)
    const continuation = block.through
    if (existingConnection && !continuation) return
    const nextEdges = graph.edges.filter((e) => e.id !== existingConnection?.id)
    nextEdges.push({
      id: shortId('e'),
      source: insertion.source,
      sourceHandle: insertion.handle,
      target: node.id,
    })
    if (existingConnection && continuation)
      nextEdges.push({ ...existingConnection, source: node.id, sourceHandle: continuation })
    setGraph({
      ...graph,
      nodes: [
        ...graph.nodes.map((n) =>
          n.position.x >= position.x
            ? { ...n, position: { ...n.position, x: n.position.x + 340 } }
            : n,
        ),
        node,
      ],
      edges: nextEdges,
    })
    setSelectedId(node.id)
    setTab('inspect')
    setPanelOpen(true)
    setPaletteOpen(false)
    setRun(null)
    requestAnimationFrame(() => flow.fitView({ padding: 0.12, duration: 200 }))
  }

  const selected = graph.nodes.find((n) => n.id === selectedId) ?? null
  const updateNode = (node: PolicyNode) =>
    setGraph({ ...graph, nodes: graph.nodes.map((n) => (n.id === node.id ? node : n)) })
  const deleteNode = (id: string) => {
    setGraph({
      ...graph,
      nodes: graph.nodes.filter((n) => n.id !== id),
      edges: graph.edges.filter((e) => e.source !== id && e.target !== id),
    })
    setSelectedId(null)
  }

  const arrange = () => {
    // Longest-path columns keep every connection moving left to right.
    const depths = new Map(graph.nodes.map((n) => [n.id, 0]))
    for (let pass = 0; pass < graph.nodes.length; pass++) {
      let changed = false
      for (const edge of graph.edges) {
        const depth = (depths.get(edge.source) ?? 0) + 1
        if (depth > (depths.get(edge.target) ?? 0)) {
          depths.set(edge.target, depth)
          changed = true
        }
      }
      if (!changed) break
    }
    const rows = new Map<number, number>()
    const positions = new Map<string, { x: number; y: number }>()
    for (const node of [...graph.nodes].sort((a, b) => a.position.y - b.position.y)) {
      const depth = depths.get(node.id) ?? 0
      const y = rows.get(depth) ?? 0
      positions.set(node.id, { x: depth * 340, y })
      rows.set(depth, y + (measured[node.id]?.height ?? 200) + 80)
    }
    setGraph({
      ...graph,
      nodes: graph.nodes.map((n) => ({ ...n, position: positions.get(n.id)! })),
    })
    requestAnimationFrame(() => flow.fitView({ padding: 0.12, duration: 250 }))
  }

  return (
    <div className="flex min-h-[560px] h-[calc(100dvh-190px)] flex-col overflow-hidden rounded-xl border border-line-strong bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex items-center gap-3">
          {isAdmin ? (
            <Button
              variant={paletteOpen ? 'primary' : 'ghost'}
              onClick={() => {
                setPickerPosition({ left: 16, top: 16 })
                const source = selected && nodeOutputs(selected).length ? selected : trigger
                if (source) setInsertion({ source: source.id, handle: nodeOutputs(source)[0]! })
                setPaletteOpen(!paletteOpen)
              }}
            >
              <Plus className="size-4" /> Add step
            </Button>
          ) : (
            <Badge>Read only</Badge>
          )}
          <span className="hidden text-xs text-muted lg:inline">
            {graph.nodes.length} steps · {graph.edges.length} connections
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin ? (
            <Button variant="ghost" onClick={arrange}>
              Arrange steps
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => flow.fitView({ padding: 0.12, duration: 250 })}>
            <Maximize2 className="size-4" /> Fit chart
          </Button>
          {(['inspect', 'test', 'history'] as const).map((t) => (
            <Button
              key={t}
              variant={panelOpen && tab === t ? 'primary' : 'ghost'}
              onClick={() => {
                setTab(t)
                setPaletteOpen(false)
                setPanelOpen(!(panelOpen && tab === t))
              }}
            >
              {tabLabels[t]}
            </Button>
          ))}
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1">
        {paletteOpen ? (
          <aside
            role="dialog"
            aria-label="Choose next step"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setPaletteOpen(false)
                e.stopPropagation()
              }
            }}
            style={pickerPosition}
            className="absolute z-20 flex w-[280px] max-w-[calc(100%-24px)] max-h-[min(380px,calc(100%-24px))] flex-col overflow-hidden rounded-xl border border-line-strong bg-panel shadow-[0_16px_64px_#000a]"
          >
            <div className="flex items-center gap-2 border-b border-line p-2">
              <Input
                ref={searchRef}
                aria-label="Search steps"
                placeholder="Search…"
                value={stepSearch}
                onChange={(e) => setStepSearch(e.target.value)}
              />
              <button
                type="button"
                aria-label="Close step picker"
                onClick={() => setPaletteOpen(false)}
                className="rounded p-1 text-muted hover:bg-panel-2 hover:text-fg"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="min-h-0 overflow-y-auto p-1">
              {search ? (
                matchesSearch.length ? (
                  matchesSearch.map(renderChoice)
                ) : (
                  <p className="p-3 text-sm text-muted">No matching elements.</p>
                )
              ) : (
                <>
                  {suggestions.filter((s) => s.recommended).map(renderChoice)}
                  <button
                    type="button"
                    aria-expanded={otherOpen}
                    className="mt-1 flex w-full items-center justify-between rounded-lg border-t border-line px-3 py-2 text-sm text-muted hover:bg-panel-2 hover:text-fg"
                    onClick={() => setOtherOpen(!otherOpen)}
                  >
                    <span>Other elements</span>
                    <span aria-hidden="true">{otherOpen ? '−' : '+'}</span>
                  </button>
                  {otherOpen
                    ? otherGroups.map((group) => (
                        <PaletteGroup key={group} group={group}>
                          {others.filter((s) => s.block.group === group).map(renderChoice)}
                        </PaletteGroup>
                      ))
                    : null}
                </>
              )}
            </div>
          </aside>
        ) : null}
        <div ref={canvasRef} className="guardrail-canvas min-w-0 flex-1">
          <ReactFlow<FlowNode>
            colorMode="dark"
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onPaneClick={() => {
              setSelectedId(null)
              setPaletteOpen(false)
            }}
            nodesDraggable={isAdmin}
            nodesConnectable={isAdmin}
            connectOnClick={false}
            deleteKeyCode={isAdmin ? ['Backspace', 'Delete'] : null}
            fitView
            fitViewOptions={{ padding: 0.12 }}
            minZoom={0.25}
            maxZoom={1.8}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} size={1} color="#2a3950" />
            <Controls showInteractive={false} />
            {graph.nodes.length > 10 ? (
              <MiniMap
                pannable
                zoomable
                nodeColor="#667286"
                maskColor="rgba(8,17,31,0.65)"
                style={{ width: 140, height: 85 }}
              />
            ) : null}
          </ReactFlow>
        </div>

        {panelOpen && !paletteOpen ? (
          <aside className="absolute inset-y-0 right-0 z-10 flex w-[340px] max-w-full flex-col overflow-hidden border-l border-line-strong bg-panel shadow-2xl">
            <div className="flex items-center border-b border-line text-xs">
              <span className="flex-1 px-4 py-3 font-medium">{tabTitles[tab]}</span>
              <button
                type="button"
                aria-label="Close details"
                onClick={() => setPanelOpen(false)}
                className="p-3 text-muted hover:text-fg"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {tab === 'inspect' ? (
                selected ? (
                  <Inspector
                    key={selected.id}
                    node={selected}
                    issues={issuesByNode.get(selected.id) ?? []}
                    options={options}
                    readOnly={!isAdmin}
                    onChange={updateNode}
                    onDelete={() => deleteNode(selected.id)}
                  />
                ) : (
                  <GraphHelp issues={issues} />
                )
              ) : tab === 'test' ? (
                <DryRun graph={graph} options={options} onResult={setRun} />
              ) : (
                <VersionList
                  versions={versions}
                  publishedId={publishedId}
                  canLoad={isAdmin}
                  onLoad={(g) => {
                    setGraph(g)
                    setSelectedId(null)
                    setRun(null)
                    window.requestAnimationFrame(() => flow.fitView({ padding: 0.2 }))
                  }}
                />
              )}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  )
}

function PaletteGroup({ group, children }: { group: BlockGroup; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-subtle">{group}</div>
      {children}
    </div>
  )
}

function PaletteButton({
  reason,
  block,
  disabled,
  onAdd,
}: {
  reason: string
  block: BlockSpec
  disabled: boolean
  onAdd: () => void
}) {
  const Icon = blockIcons[block.id]
  return (
    <button
      type="button"
      disabled={disabled}
      title={reason || block.description}
      onClick={onAdd}
      className="flex w-full items-center gap-2 rounded-lg border border-transparent bg-transparent px-3 py-2 text-left text-sm hover:border-line-strong hover:bg-panel-2 disabled:cursor-default disabled:opacity-50"
    >
      <Icon className="size-3.5 shrink-0 text-muted" />
      <span className="leading-tight">
        <span className="block font-medium">{block.label}</span>
      </span>
    </button>
  )
}

function GraphHelp({ issues }: { issues: GraphIssue[] }) {
  return (
    <div className="flex flex-col gap-3 p-4 text-xs text-muted">
      <p>
        Click a step to configure it. Click + beside a branch to add the next step; it connects
        automatically. Select a step or connection and press Delete to remove it.
      </p>
      <p>
        The start step picks the stages the guardrail runs on.{' '}
        <span className="text-fg">Conditions</span> ask one thing about the request (tool, model,
        server, tier, group, resource, device) and leave through{' '}
        <span className="text-fg">Yes</span> or <span className="text-fg">No</span>: link Yes to the
        next condition for AND, No for OR. <span className="text-fg">Checks</span> inspect the
        content, the device and the session. Every path should end in an outcome: allow, block, an
        approval by an admin, Touch ID, a browser sign-in or a confirmation, or Skip when the
        guardrail does not apply.
      </p>
      {issues.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {issues.map((i) => (
            <li
              key={`${i.nodeId}:${i.message}`}
              className={i.level === 'error' ? 'text-bad' : 'text-warn'}
            >
              {i.nodeId ? <span className="font-mono">{i.nodeId}: </span> : null}
              {i.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ok">No problems found.</p>
      )}
    </div>
  )
}

function VersionList({
  versions,
  publishedId,
  canLoad,
  onLoad,
}: {
  versions: Version[]
  publishedId: string | null
  canLoad: boolean
  onLoad: (g: PolicyGraph) => void
}) {
  if (versions.length === 0) {
    return (
      <p className="p-4 text-xs text-muted">
        Nothing saved yet. This guardrail doesn't run until a version is published.
      </p>
    )
  }
  return (
    <ul className="divide-y divide-line">
      {versions.map((v) => {
        const parsed = policyGraph.safeParse(v.definition)
        return (
          <li key={v.id} className="flex flex-col gap-1 px-4 py-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-mono">v{v.version}</span>
              <Badge
                tone={v.status === 'published' ? (v.id === publishedId ? 'ok' : 'neutral') : 'warn'}
              >
                {v.id === publishedId ? 'live' : v.status}
              </Badge>
              <span className="ml-auto text-subtle">{timeAgo(v.createdAt)}</span>
              {canLoad ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!parsed.success}
                  title={parsed.success ? undefined : 'Saved in the old linear format'}
                  onClick={() => parsed.success && onLoad(parsed.data)}
                >
                  Load
                </Button>
              ) : null}
            </div>
            <div className="truncate text-muted">
              {v.note ?? ''} {v.createdBy ? `· ${v.createdBy}` : ''}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
