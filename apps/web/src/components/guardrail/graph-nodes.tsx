import {
  type BlockId,
  type BlockOutput,
  blockId,
  blockOf,
  blockOutput,
  type CheckResult,
  type GraphIssue,
  type PolicyEdge,
  type PolicyNode,
  type Tone,
} from '@acl/shared'
import { cn } from '@acl/ui'
import { type Edge, Handle, MarkerType, type Node, type NodeProps, Position } from '@xyflow/react'
import {
  Activity,
  Ban,
  Boxes,
  Braces,
  BrainCircuit,
  CircleCheck,
  Cpu,
  Fingerprint,
  Gauge,
  Gavel,
  Globe,
  Hand,
  Keyboard,
  KeyRound,
  Laptop,
  Layers,
  LogIn,
  type LucideIcon,
  MessageCircleQuestion,
  MonitorSmartphone,
  Pin,
  Play,
  Plug,
  Plus,
  ScanFace,
  ScanSearch,
  Server,
  ShieldAlert,
  ShieldOff,
  Siren,
  SkipForward,
  TriangleAlert,
  UsersRound,
  Webhook,
  Wrench,
} from 'lucide-react'
import { type PointerEvent, useEffect, useRef } from 'react'
import { CheckBadge } from '#/components/event-bits.tsx'
import { createGlassOptics, GLASS_OVERSCAN, GLASS_RADIUS } from './glass-optics.ts'

export type FlowNodeData = {
  onAdd?: (handle: string, anchor: { x: number; y: number }) => void
  node: PolicyNode
  issues: GraphIssue[]
  /** Set while a dry run or an event's path is shown: whether the request went through this node. */
  onPath: boolean | null
  /** Path view: what the event recorded at this node, and its position on the path. */
  step?: { check: CheckResult; order: number }
  /** Path view: the path ended here. */
  end?: boolean
  /** Path view: the path left this node for the guardrail's fallback. */
  fallback?: CheckResult
}
export type FlowNode = Node<FlowNodeData>

export const toneColor: Record<Tone, string> = {
  ok: 'var(--color-ok)',
  bad: 'var(--color-bad)',
  warn: 'var(--color-warn)',
  neutral: 'var(--color-muted)',
  accent: 'var(--color-accent-strong)',
}

/** An edge as the canvas draws it. `onPath` is null when no path is shown. */
export function flowEdge(
  edge: PolicyEdge,
  source: PolicyNode | undefined,
  onPath: boolean | null,
): Edge & { pathOptions: { borderRadius: number; offset: number } } {
  const tone = source ? blockOutput(source, edge.sourceHandle)?.tone : undefined
  const color = toneColor[tone ?? 'neutral']
  return {
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle,
    target: edge.target,
    animated: onPath === true,
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed, width: 20, height: 20, color },
    interactionWidth: 24,
    pathOptions: { borderRadius: 18, offset: 30 },
    style: {
      stroke: tone ? color : 'var(--color-line-strong)',
      strokeWidth: onPath ? 3.5 : 2.5,
      opacity: onPath === false ? 0.25 : 1,
    },
  }
}

export const blockIcons: Record<BlockId, LucideIcon> = {
  trigger: Play,
  if_kind: Layers,
  if_tool: Wrench,
  if_source: Plug,
  if_mcpServer: Server,
  if_tier: TriangleAlert,
  if_model: Cpu,
  if_group: UsersRound,
  if_resource: Boxes,
  if_deviceStatus: MonitorSmartphone,
  if_keyStorage: KeyRound,
  fingerprint: Fingerprint,
  posture: Activity,
  os_posture: Laptop,
  network: Globe,
  keywords: ScanSearch,
  judge: Gavel,
  signatures: Siren,
  learned: BrainCircuit,
  redact: ShieldOff,
  arguments: Braces,
  tool_pinning: Pin,
  untrusted_content: ShieldAlert,
  hook: Webhook,
  idle: Keyboard,
  limit: Gauge,
  allow: CircleCheck,
  block: Ban,
  approve_admin: Hand,
  approve_confirm: MessageCircleQuestion,
  approve_touchid: ScanFace,
  approve_browser: LogIn,
  skip: SkipForward,
}

function titleTone(node: PolicyNode): string {
  switch (node.type) {
    case 'trigger':
      return 'text-accent-strong'
    case 'condition':
      return 'text-info'
    case 'check':
      return 'text-fg'
    case 'decision':
      return node.action === 'allow'
        ? 'text-ok'
        : node.action === 'block'
          ? 'text-bad'
          : node.action === 'skip'
            ? 'text-muted'
            : 'text-warn'
  }
}

/** The node a path ended on stands out in the colour of what it decided. */
function endRing(node: PolicyNode, fallback: CheckResult | undefined): string {
  if (fallback || node.type !== 'decision') return 'ring-4 ring-warn/70'
  if (node.action === 'allow') return 'ring-4 ring-ok/70'
  if (node.action === 'block') return 'ring-4 ring-bad/70'
  return node.action === 'skip' ? 'ring-4 ring-muted/60' : 'ring-4 ring-warn/70'
}

function PolicyNodeView({ data, selected }: NodeProps<FlowNode>) {
  const { node, issues, onPath, step, end, fallback } = data
  const pointerStart = useRef({ x: 0, y: 0 })
  const lens = useRef<HTMLDivElement | null>(null)
  const clearLens = () => {
    lens.current?.remove()
    lens.current = null
  }
  useEffect(
    () => () => {
      lens.current?.remove()
    },
    [],
  )
  const moveLens = (event: PointerEvent<HTMLDivElement>) => {
    if (!data.onAdd || event.pointerType === 'touch' || event.buttons) {
      clearLens()
      return
    }
    const canvas = event.currentTarget.closest('.react-flow')
    const viewport = canvas?.querySelector('.react-flow__viewport')
    if (!canvas || !viewport) return
    if (!lens.current) {
      const glass = document.createElement('div')
      glass.className = 'guardrail-canvas react-flow dark guardrail-lens'
      glass.setAttribute('aria-hidden', 'true')
      glass.inert = true
      const optics = createGlassOptics(glass)
      const scene = document.createElement('div')
      scene.className = 'guardrail-lens-scene'
      const copy = viewport.cloneNode(true) as HTMLElement
      // Decorative snapshot only: never duplicate accessible controls or document IDs.
      for (const element of copy.querySelectorAll('[id]')) element.removeAttribute('id')
      for (const icon of copy.querySelectorAll<SVGElement>('.guardrail-output svg'))
        icon.style.opacity = '1'
      // A cloned element cannot inherit :hover. Preserve the active connector's
      // enlarged state explicitly so the lens magnifies the growing dot and +.
      const handleId = event.currentTarget.getAttribute('data-handleid')
      for (const handle of copy.querySelectorAll<HTMLElement>('.guardrail-output')) {
        if (
          handle.getAttribute('data-handleid') === handleId &&
          handle.closest('.react-flow__node')?.getAttribute('data-id') === node.id
        )
          handle.classList.add('guardrail-output-active')
      }
      scene.appendChild(copy)
      optics.appendChild(scene)
      glass.appendChild(optics)
      document.body.appendChild(glass)
      lens.current = glass
    }
    const box = canvas.getBoundingClientRect()
    const glass = lens.current
    glass.style.left = `${event.clientX - GLASS_RADIUS}px`
    glass.style.top = `${event.clientY - GLASS_RADIUS}px`
    const scene = glass.querySelector<HTMLElement>('.guardrail-lens-scene')!
    scene.style.width = `${box.width}px`
    scene.style.height = `${box.height}px`
    scene.style.transform = `translate(${GLASS_RADIUS + GLASS_OVERSCAN - (event.clientX - box.left) * 1.35}px, ${GLASS_RADIUS + GLASS_OVERSCAN - (event.clientY - box.top) * 1.35}px) scale(1.35)`
  }
  const block = blockOf(node)
  const Icon = blockIcons[blockId(node)]
  const title = block.label
  const subtitle =
    node.type === 'check' && !node.enabled ? 'Disabled: follows pass' : block.summary(node)
  const tone = titleTone(node)
  const outputs: BlockOutput[] = block.outputs
  const hasError = issues.some((i) => i.level === 'error')
  const hasWarning = issues.some((i) => i.level === 'warning')
  return (
    <div
      className={cn(
        'relative w-60 rounded-xl border bg-panel text-left shadow-xl transition-opacity',
        selected ? 'border-accent' : hasError ? 'border-bad' : 'border-line-strong',
        onPath === false && 'opacity-35',
        onPath === true && !end && 'ring-2 ring-accent/60',
        end && endRing(node, fallback),
        node.type === 'check' && !node.enabled && 'border-dashed',
      )}
      title={issues.map((i) => i.message).join('\n') || undefined}
    >
      {node.type !== 'trigger' ? (
        <Handle type="target" position={Position.Left} className="!bg-muted" />
      ) : null}
      {step || fallback ? (
        // Sits on the top border, so a path does not change the node's size or the layout.
        <div className="absolute -top-3 right-3 flex items-center gap-1.5 rounded-md border border-line-strong bg-panel px-1.5 py-0.5 text-[11px] shadow-md">
          {step ? (
            <>
              <span className="font-mono text-subtle">{step.order}</span>
              <CheckBadge check={step.check} />
              {step.check.score != null ? (
                <span className="font-mono text-muted">risk {step.check.score.toFixed(2)}</span>
              ) : null}
              <span className="font-mono text-subtle">{step.check.durationMs}ms</span>
            </>
          ) : null}
          {fallback ? (
            <span className="text-warn">
              fallback: {fallback.action === 'block' ? 'block' : 'allow'}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="flex items-start gap-3 px-4 py-4">
        <Icon className={cn('mt-0.5 size-5 shrink-0', tone)} />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold leading-snug">{title}</div>
          <div
            className={cn(
              'mt-1 line-clamp-2 text-[12px] leading-relaxed',
              step?.check.reason ? 'text-fg' : 'text-muted',
            )}
            title={step?.check.reason}
          >
            {/* On a path, what the step found replaces its description. */}
            {step?.check.reason ?? subtitle}
          </div>
          {node.type === 'check' ? (
            <div className="mt-1 truncate text-[11px] text-subtle">From: {block.source}</div>
          ) : null}
        </div>
        {hasError || hasWarning ? (
          <span
            className={cn('mt-1 size-1.5 shrink-0 rounded-full', hasError ? 'bg-bad' : 'bg-warn')}
          />
        ) : null}
      </div>
      {outputs.length > 0 ? (
        <div className="border-t border-line bg-panel-2/60 py-2 rounded-b-xl">
          {outputs.map(({ id: h, label, tone: outputTone }) => (
            <div
              key={h}
              className={cn(
                'relative px-4 py-1.5 text-right text-[12px] font-medium',
                // On a path, the outputs the request did not leave through fade.
                step && step.check.branch !== h && 'opacity-40',
              )}
            >
              <span style={{ color: toneColor[outputTone] }}>{label}</span>
              <Handle
                id={h}
                type="source"
                position={Position.Right}
                className={data.onAdd ? 'guardrail-output' : undefined}
                role={data.onAdd ? 'button' : undefined}
                tabIndex={data.onAdd ? 0 : undefined}
                aria-label={`Add step after ${title}: ${label}`}
                onPointerEnter={moveLens}
                onPointerMove={moveLens}
                onPointerLeave={clearLens}
                onPointerCancel={clearLens}
                onBlur={clearLens}
                onPointerDown={(e) => {
                  clearLens()
                  pointerStart.current = { x: e.clientX, y: e.clientY }
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  if (
                    Math.hypot(
                      e.clientX - pointerStart.current.x,
                      e.clientY - pointerStart.current.y,
                    ) > 5
                  )
                    return
                  const box = e.currentTarget.getBoundingClientRect()
                  data.onAdd?.(h, { x: box.right, y: box.top + box.height / 2 })
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  e.stopPropagation()
                  const box = e.currentTarget.getBoundingClientRect()
                  data.onAdd?.(h, { x: box.right, y: box.top + box.height / 2 })
                }}
                style={{ background: toneColor[outputTone] }}
              >
                {data.onAdd ? <Plus className="pointer-events-none size-3.5 opacity-0" /> : null}
              </Handle>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export const nodeTypes = {
  trigger: PolicyNodeView,
  condition: PolicyNodeView,
  check: PolicyNodeView,
  decision: PolicyNodeView,
}
