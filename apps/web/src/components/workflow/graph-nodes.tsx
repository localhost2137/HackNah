import {
  type Condition,
  checkLabels,
  type GraphIssue,
  nodeOutputs,
  outputLabels,
  type PolicyNode,
} from '@acl/shared'
import { cn } from '@acl/ui'
import { Handle, type Node, type NodeProps, Position } from '@xyflow/react'
import {
  Ban,
  CircleCheck,
  Fingerprint,
  Gavel,
  Hand,
  type LucideIcon,
  Play,
  Plus,
  Route,
  ScanSearch,
  ShieldOff,
} from 'lucide-react'
import { type PointerEvent, useEffect, useRef } from 'react'
import { createGlassOptics, GLASS_OVERSCAN, GLASS_RADIUS } from './glass-optics.ts'
import { checkSummary } from './step-form.tsx'

export type FlowNodeData = {
  onAdd?: (handle: string, anchor: { x: number; y: number }) => void
  node: PolicyNode
  issues: GraphIssue[]
  /** Set while a dry run is shown: whether the request went through this node. */
  onPath: boolean | null
}
export type FlowNode = Node<FlowNodeData>

export const handleColor: Record<string, string> = {
  next: '#9a8dff',
  match: '#9a8dff',
  else: '#8b91a5',
  pass: '#2fd18b',
  fail: '#ff5c72',
  mismatch: '#ff5c72',
  new: '#f5b84a',
  error: '#f5b84a',
}

export const checkIcons: Record<string, LucideIcon> = {
  fingerprint: Fingerprint,
  keywords: ScanSearch,
  judge: Gavel,
  redact: ShieldOff,
}

const fieldLabels: Record<Condition['field'], string> = {
  kind: 'Kind',
  mcpServer: 'MCP server',
  tool: 'Tool',
  resource: 'Resource',
  group: 'Group',
  deviceStatus: 'Device',
  model: 'Model',
}

export function conditionText(c: Condition, names: Record<string, string> = {}): string {
  const values = c.values.map((v) => names[v] ?? v)
  return `${fieldLabels[c.field]}: ${values.join(', ') || '—'}`
}

function describe(node: PolicyNode): {
  icon: LucideIcon
  title: string
  subtitle: string
  tone: string
} {
  switch (node.type) {
    case 'trigger':
      return {
        icon: Play,
        title: 'Request comes in',
        subtitle: 'Prompt, tool result or tool call',
        tone: 'text-accent-strong',
      }
    case 'match':
      return {
        icon: Route,
        title: node.label || 'Route',
        subtitle:
          node.conditions.length === 0
            ? 'No conditions'
            : node.conditions
                .map((c) => conditionText(c))
                .join(node.mode === 'all' ? ' and ' : ' or '),
        tone: 'text-info',
      }
    case 'check':
      return {
        icon: checkIcons[node.check.type] ?? ScanSearch,
        title: checkLabels[node.check.type],
        subtitle: node.enabled ? checkSummary(node.check) : 'Disabled: follows pass',
        tone: 'text-fg',
      }
    case 'decision':
      return node.action === 'allow'
        ? { icon: CircleCheck, title: 'Allow', subtitle: 'Forward the request', tone: 'text-ok' }
        : node.action === 'block'
          ? {
              icon: Ban,
              title: 'Block',
              subtitle: node.reason || 'Deny the request',
              tone: 'text-bad',
            }
          : {
              icon: Hand,
              title: 'Require approval',
              subtitle: `Wait up to ${node.timeoutSec}s for an admin`,
              tone: 'text-warn',
            }
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
  const { icon: Icon, title, subtitle, tone } = describe(node)
  const outputs = nodeOutputs(node)
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
          {outputs.map((h) => (
            <div key={h} className="relative px-4 py-1.5 text-right text-[12px] font-medium">
              <span style={{ color: handleColor[h] }}>
                {h === 'next'
                  ? 'Continue'
                  : h === 'pass'
                    ? 'Passed'
                    : h === 'fail'
                      ? 'Failed'
                      : h === 'new'
                        ? 'New device'
                        : h === 'mismatch'
                          ? 'Device mismatch'
                          : h === 'match'
                            ? 'Matches'
                            : h === 'else'
                              ? 'Otherwise'
                              : (outputLabels[h] ?? h)}
              </span>
              <Handle
                id={h}
                type="source"
                position={Position.Right}
                className={data.onAdd ? 'workflow-output' : undefined}
                role={data.onAdd ? 'button' : undefined}
                tabIndex={data.onAdd ? 0 : undefined}
                aria-label={`Add step after ${title}: ${outputLabels[h] ?? h}`}
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
                style={{ background: handleColor[h] }}
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
