import {
  type CheckType,
  checkLabels,
  type EvaluationResult,
  type GraphIssue,
  type PolicyEdge,
  type PolicyGraph,
  type PolicyNode,
  policyGraph,
  validateGraph,
} from '@acl/shared'
import { Badge, Button, Card, cn, Dialog, Field, Input, PageHeader, Select } from '@acl/ui'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
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
import { Ban, CircleCheck, Hand, Route as RouteIcon } from 'lucide-react'
import { type DragEvent, useEffect, useMemo, useState } from 'react'
import { FormError } from '#/components/auth-shell.tsx'
import { DryRun } from '#/components/workflow/dry-run.tsx'
import {
  checkIcons,
  type FlowNode,
  handleColor,
  nodeTypes,
} from '#/components/workflow/graph-nodes.tsx'
import { Inspector, type PickerOptions } from '#/components/workflow/inspector.tsx'
import { newCheck } from '#/components/workflow/step-form.tsx'
import { timeAgo } from '#/lib/format.ts'
import { listGroups, listResources } from '#/server/fns/access.ts'
import { listMcpServers } from '#/server/fns/integrations.ts'
import { discardDraft, getWorkflow, publishDraft, saveDraft } from '#/server/fns/workflow.ts'

const workflowQuery = queryOptions({ queryKey: ['workflow'], queryFn: () => getWorkflow() })
const serversQuery = queryOptions({ queryKey: ['mcp-servers'], queryFn: () => listMcpServers() })
const resourcesQuery = queryOptions({ queryKey: ['resources'], queryFn: () => listResources() })
const groupsQuery = queryOptions({ queryKey: ['groups'], queryFn: () => listGroups() })

export const Route = createFileRoute('/_app/workflow')({
  loader: ({ context }) => context.queryClient.ensureQueryData(workflowQuery),
  component: WorkflowPage,
})

type PaletteItem =
  | { kind: 'match' }
  | { kind: 'check'; check: CheckType }
  | { kind: 'decision'; action: 'allow' | 'block' | 'require_approval' }

const palette: { label: string; item: PaletteItem }[] = [
  { label: 'Route', item: { kind: 'match' } },
  ...(Object.keys(checkLabels) as CheckType[]).map((check) => ({
    label: checkLabels[check],
    item: { kind: 'check' as const, check },
  })),
  { label: 'Allow', item: { kind: 'decision', action: 'allow' } },
  { label: 'Require approval', item: { kind: 'decision', action: 'require_approval' } },
  { label: 'Block', item: { kind: 'decision', action: 'block' } },
]

const DRAG_TYPE = 'application/x-acl-node'

function shortId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 7)}`
}

function createNode(item: PaletteItem, position: { x: number; y: number }): PolicyNode {
  switch (item.kind) {
    case 'match':
      return {
        id: shortId('route'),
        type: 'match',
        position,
        label: '',
        mode: 'all',
        conditions: [],
      }
    case 'check':
      return {
        id: shortId(item.check),
        type: 'check',
        position,
        enabled: true,
        check: newCheck(item.check),
      }
    case 'decision':
      return {
        id: shortId(item.action === 'require_approval' ? 'approve' : item.action),
        type: 'decision',
        position,
        action: item.action,
        timeoutSec: 300,
        reason: '',
      }
  }
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

function WorkflowPage() {
  const { isAdmin } = Route.useRouteContext()
  const qc = useQueryClient()
  const { data } = useQuery(workflowQuery)
  const { data: servers } = useQuery(serversQuery)
  const { data: resources } = useQuery(resourcesQuery)
  const { data: groups } = useQuery(groupsQuery)
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
        label: r.serverName ? `${r.serverName} · ${r.name}` : r.name,
      })),
      groups: (groups ?? []).map((g) => ({ value: g.id, label: g.name })),
    }),
    [servers, resources, groups],
  )

  const refresh = () => qc.invalidateQueries({ queryKey: ['workflow'] })
  const save = useMutation({
    mutationFn: (g: PolicyGraph) => saveDraft({ data: { definition: g } }),
    onSuccess: refresh,
  })
  const publish = useMutation({
    mutationFn: async () => {
      if (dirty && graph) await saveDraft({ data: { definition: graph } })
      return publishDraft({ data: { note: note || undefined } })
    },
    onSuccess: async () => {
      setPublishOpen(false)
      setNote('')
      await refresh()
    },
  })
  const discard = useMutation({
    mutationFn: () => discardDraft(),
    onSuccess: async () => {
      setGraph(null)
      await refresh()
    },
  })

  if (!data || !graph) return null

  return (
    <>
      <PageHeader
        title="Workflow"
        description="Every prompt and tool call walks this graph from the start node. Routes send different tools, servers or groups down stricter or looser paths; each path ends in allow, approval or block."
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
            <Badge tone="neutral">built-in default</Badge>
          )}
        </span>
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
        title="Publish workflow"
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

type Version = Awaited<ReturnType<typeof getWorkflow>>['versions'][number]
type Tab = 'inspect' | 'test' | 'history'

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
  const [run, setRun] = useState<EvaluationResult | null>(null)

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
      issues: issuesByNode.get(n.id) ?? [],
      onPath: path ? path.nodes.has(n.id) : null,
    },
  }))

  const edges: Edge[] = graph.edges.map((e) => {
    const onPath = path?.edges.has(`${e.source}:${e.sourceHandle}`)
    return {
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      selected: selectedEdges.has(e.id),
      animated: onPath === true,
      style: {
        stroke: handleColor[e.sourceHandle] ?? 'var(--color-line-strong)',
        strokeWidth: onPath ? 2.5 : 1.5,
        opacity: path && !onPath ? 0.25 : 1,
      },
    }
  })

  const onNodesChange = (changes: NodeChange<FlowNode>[]) => {
    const next = applyNodeChanges(changes, nodes)
    if (changes.some((c) => c.type === 'dimensions')) {
      setMeasured(Object.fromEntries(next.map((n) => [n.id, n.measured])))
    }
    if (changes.some((c) => c.type === 'select')) {
      const sel = next.find((n) => n.selected)?.id ?? null
      setSelectedId(sel)
      if (sel) setTab('inspect')
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

  const addNode = (item: PaletteItem, position: { x: number; y: number }) => {
    const node = createNode(item, position)
    setGraph({ ...graph, nodes: [...graph.nodes, node] })
    setSelectedId(node.id)
    setTab('inspect')
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    const raw = e.dataTransfer.getData(DRAG_TYPE)
    if (!raw) return
    addNode(
      JSON.parse(raw) as PaletteItem,
      flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
    )
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

  return (
    <div className="grid h-[calc(100vh-230px)] min-h-[520px] grid-cols-[176px_minmax(0,1fr)_360px] gap-3">
      <Card className="flex flex-col gap-1 overflow-y-auto p-2">
        <div className="px-1 pb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">
          {isAdmin ? 'Drag onto the canvas' : 'Read only'}
        </div>
        {palette.map(({ label, item }) => (
          <PaletteButton
            key={label}
            label={label}
            item={item}
            disabled={!isAdmin}
            onAdd={() => {
              const box = document.querySelector('.react-flow')?.getBoundingClientRect()
              // Cascade click-added nodes so they don't stack on top of each other.
              const offset = (graph.nodes.length % 6) * 24
              const center = box
                ? { x: box.left + box.width / 2 + offset, y: box.top + box.height / 3 + offset }
                : { x: 0, y: 0 }
              addNode(item, flow.screenToFlowPosition(center))
            }}
          />
        ))}
      </Card>

      <Card className="overflow-hidden">
        <ReactFlow<FlowNode>
          colorMode="dark"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onDrop={onDrop}
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
          }}
          onPaneClick={() => setSelectedId(null)}
          nodesDraggable={isAdmin}
          nodesConnectable={isAdmin}
          deleteKeyCode={isAdmin ? ['Backspace', 'Delete'] : null}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable style={{ width: 160, height: 100 }} />
        </ReactFlow>
      </Card>

      <Card className="flex flex-col overflow-hidden">
        <div className="flex border-b border-line text-xs">
          {(['inspect', 'test', 'history'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                'flex-1 px-3 py-2 capitalize',
                tab === t ? 'border-b-2 border-accent text-fg' : 'text-muted hover:text-fg',
              )}
            >
              {t === 'test' ? 'Dry run' : t}
            </button>
          ))}
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
      </Card>
    </div>
  )
}

const paletteIcons = { match: RouteIcon, allow: CircleCheck, block: Ban, require_approval: Hand }

function PaletteButton({
  label,
  item,
  disabled,
  onAdd,
}: {
  label: string
  item: PaletteItem
  disabled: boolean
  onAdd: () => void
}) {
  const Icon =
    item.kind === 'match'
      ? paletteIcons.match
      : item.kind === 'decision'
        ? paletteIcons[item.action]
        : checkIcons[item.check]
  return (
    <button
      type="button"
      draggable={!disabled}
      disabled={disabled}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item))
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={onAdd}
      className="flex items-center gap-2 rounded-md border border-line bg-panel-2 px-2 py-1.5 text-left text-xs hover:border-line-strong disabled:cursor-default disabled:opacity-50"
    >
      {Icon ? <Icon className="size-3.5 shrink-0 text-muted" /> : null}
      <span className="leading-tight">{label}</span>
    </button>
  )
}

function GraphHelp({ issues }: { issues: GraphIssue[] }) {
  return (
    <div className="flex flex-col gap-3 p-4 text-xs text-muted">
      <p>
        Select a node to configure it. Drag from an output on the right of a node to another node to
        connect them; each output connects once. Select a node or edge and press Delete to remove
        it.
      </p>
      <p>
        <span className="text-fg">Routes</span> check who and what the request is (server, tool,
        resource, group, device, model) and leave through <span className="text-fg">match</span> or{' '}
        <span className="text-fg">else</span>. <span className="text-fg">Checks</span> inspect the
        content. Every path should end in a decision.
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
        Nothing published yet; the built-in default is active.
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
