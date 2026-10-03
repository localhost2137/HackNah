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
  Route,
  ScanSearch,
  ShieldOff,
} from 'lucide-react'
import { checkSummary } from './step-form.tsx'

export type FlowNodeData = {
  node: PolicyNode
  issues: GraphIssue[]
  /** Set while a dry run is shown: whether the request went through this node. */
  onPath: boolean | null
}
export type FlowNode = Node<FlowNodeData>

export const handleColor: Record<string, string> = {
  next: 'var(--color-accent)',
  match: 'var(--color-accent)',
  else: 'var(--color-subtle)',
  pass: 'var(--color-ok)',
  fail: 'var(--color-bad)',
  mismatch: 'var(--color-bad)',
  new: 'var(--color-warn)',
  error: 'var(--color-warn)',
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
  const { icon: Icon, title, subtitle, tone } = describe(node)
  const outputs = nodeOutputs(node)
  const hasError = issues.some((i) => i.level === 'error')
  const hasWarning = issues.some((i) => i.level === 'warning')
  return (
    <div
      className={cn(
        'w-56 rounded-lg border bg-panel text-left shadow-lg transition-opacity',
        selected ? 'border-accent' : hasError ? 'border-bad' : 'border-line-strong',
        onPath === false && 'opacity-35',
        onPath === true && 'ring-2 ring-accent/60',
        node.type === 'check' && !node.enabled && 'border-dashed',
      )}
      title={issues.map((i) => i.message).join('\n') || undefined}
    >
      {node.type !== 'trigger' ? (
        <Handle
          type="target"
          position={Position.Left}
          className="!size-2.5 !border-2 !border-panel !bg-line-strong"
        />
      ) : null}
      <div className="flex items-start gap-2 px-3 py-2">
        <Icon className={cn('mt-0.5 size-3.5 shrink-0', tone)} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium">{title}</div>
          <div className="line-clamp-2 text-[11px] text-muted">{subtitle}</div>
        </div>
        {hasError || hasWarning ? (
          <span
            className={cn('mt-1 size-1.5 shrink-0 rounded-full', hasError ? 'bg-bad' : 'bg-warn')}
          />
        ) : null}
      </div>
      {outputs.length > 0 ? (
        <div className="border-t border-line py-1">
          {outputs.map((h) => (
            <div key={h} className="relative px-3 py-0.5 text-right text-[10px] text-muted">
              {outputLabels[h] ?? h}
              <Handle
                id={h}
                type="source"
                position={Position.Right}
                className="!size-2.5 !border-2 !border-panel"
                style={{ background: handleColor[h] }}
              />
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
