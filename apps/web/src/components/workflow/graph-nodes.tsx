import {
  type BlockId,
  type BlockOutput,
  blockId,
  blockOf,
  type GraphIssue,
  type PolicyNode,
  type Tone,
} from '@acl/shared'
import { cn } from '@acl/ui'
import { Handle, type Node, type NodeProps, Position } from '@xyflow/react'
import {
  Activity,
  Ban,
  Braces,
  CircleCheck,
  Fingerprint,
  Gavel,
  Globe,
  Hand,
  Keyboard,
  Laptop,
  LogIn,
  type LucideIcon,
  MessageCircleQuestion,
  Pin,
  Play,
  Plus,
  Route,
  ScanFace,
  ScanSearch,
  ShieldAlert,
  ShieldOff,
  Siren,
  Webhook,
} from 'lucide-react'
import { type PointerEvent, useEffect, useRef } from 'react'
import { createGlassOptics, GLASS_OVERSCAN, GLASS_RADIUS } from './glass-optics.ts'

export type FlowNodeData = {
  onAdd?: (handle: string, anchor: { x: number; y: number }) => void
  node: PolicyNode
  issues: GraphIssue[]
  /** Set while a dry run is shown: whether the request went through this node. */
  onPath: boolean | null
}
export type FlowNode = Node<FlowNodeData>

export const toneColor: Record<Tone, string> = {
  ok: '#2fd18b',
  bad: '#ff5c72',
  warn: '#f5b84a',
  neutral: '#8b91a5',
  accent: '#9a8dff',
}

export const blockIcons: Record<BlockId, LucideIcon> = {
  trigger: Play,
  route: Route,
  fingerprint: Fingerprint,
  posture: Activity,
  os_posture: Laptop,
  network: Globe,
  keywords: ScanSearch,
  judge: Gavel,
  signatures: Siren,
  redact: ShieldOff,
  arguments: Braces,
  tool_pinning: Pin,
  untrusted_content: ShieldAlert,
  hook: Webhook,
  idle: Keyboard,
  allow: CircleCheck,
  block: Ban,
  approve_admin: Hand,
  approve_confirm: MessageCircleQuestion,
  approve_touchid: ScanFace,
  approve_browser: LogIn,
}

function titleTone(node: PolicyNode): string {
  switch (node.type) {
    case 'trigger':
      return 'text-accent-strong'
    case 'match':
      return 'text-info'
    case 'check':
      return 'text-fg'
    case 'decision':
      return node.action === 'allow'
        ? 'text-ok'
        : node.action === 'block'
          ? 'text-bad'
          : 'text-warn'
  }
}

function PolicyNodeView({ data, selected }: NodeProps<FlowNode>) {
  const { node, issues, onPath } = data
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
      glass.className = 'workflow-canvas react-flow dark workflow-lens'
      glass.setAttribute('aria-hidden', 'true')
      glass.inert = true
      const optics = createGlassOptics(glass)
      const scene = document.createElement('div')
      scene.className = 'workflow-lens-scene'
      const copy = viewport.cloneNode(true) as HTMLElement
      // Decorative snapshot only: never duplicate accessible controls or document IDs.
      for (const element of copy.querySelectorAll('[id]')) element.removeAttribute('id')
      for (const icon of copy.querySelectorAll<SVGElement>('.workflow-output svg'))
        icon.style.opacity = '1'
      // A cloned element cannot inherit :hover. Preserve the active connector's
      // enlarged state explicitly so the lens magnifies the growing dot and +.
      const handleId = event.currentTarget.getAttribute('data-handleid')
      for (const handle of copy.querySelectorAll<HTMLElement>('.workflow-output')) {
        if (
          handle.getAttribute('data-handleid') === handleId &&
          handle.closest('.react-flow__node')?.getAttribute('data-id') === node.id
        )
          handle.classList.add('workflow-output-active')
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
    const scene = glass.querySelector<HTMLElement>('.workflow-lens-scene')!
    scene.style.width = `${box.width}px`
    scene.style.height = `${box.height}px`
    scene.style.transform = `translate(${GLASS_RADIUS + GLASS_OVERSCAN - (event.clientX - box.left) * 1.35}px, ${GLASS_RADIUS + GLASS_OVERSCAN - (event.clientY - box.top) * 1.35}px) scale(1.35)`
  }
  const block = blockOf(node)
  const Icon = blockIcons[blockId(node)]
  const title = (node.type === 'match' && node.label) || block.label
  const subtitle =
    node.type === 'check' && !node.enabled ? 'Disabled: follows pass' : block.summary(node)
  const tone = titleTone(node)
  const outputs: BlockOutput[] = block.outputs
  const hasError = issues.some((i) => i.level === 'error')
  const hasWarning = issues.some((i) => i.level === 'warning')
  return (
    <div
      className={cn(
        'w-60 rounded-xl border bg-panel text-left shadow-xl transition-opacity',
        selected ? 'border-accent' : hasError ? 'border-bad' : 'border-line-strong',
        onPath === false && 'opacity-35',
        onPath === true && 'ring-2 ring-accent/60',
        node.type === 'check' && !node.enabled && 'border-dashed',
      )}
      title={issues.map((i) => i.message).join('\n') || undefined}
    >
      {node.type !== 'trigger' ? (
        <Handle type="target" position={Position.Left} className="!bg-muted" />
      ) : null}
      <div className="flex items-start gap-3 px-4 py-4">
        <Icon className={cn('mt-0.5 size-5 shrink-0', tone)} />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold leading-snug">{title}</div>
          <div className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-muted">{subtitle}</div>
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
            <div key={h} className="relative px-4 py-1.5 text-right text-[12px] font-medium">
              <span style={{ color: toneColor[outputTone] }}>{label}</span>
              <Handle
                id={h}
                type="source"
                position={Position.Right}
                className={data.onAdd ? 'workflow-output' : undefined}
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
  match: PolicyNodeView,
  check: PolicyNodeView,
  decision: PolicyNodeView,
}
