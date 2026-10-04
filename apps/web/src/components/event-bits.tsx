import type { CheckResult, Decision, EventKind, WorkflowRef } from '@acl/shared'
import { approvalLabels, stepLabels } from '@acl/shared'
import { Badge, cn } from '@acl/ui'
import { Bot, Waypoints, Wrench } from 'lucide-react'
import { Fragment } from 'react'
import { decisionMeta, riskTone } from '#/lib/format.ts'

export function DecisionBadge({ decision }: { decision: Decision }) {
  const meta = decisionMeta[decision]
  return (
    <Badge tone={meta.tone} dot>
      {meta.label}
    </Badge>
  )
}

export function KindLabel({
  kind,
  model,
  toolName,
}: {
  kind: EventKind
  model: string | null
  toolName: string | null
}) {
  const Icon = kind === 'tool_call' ? Wrench : kind === 'agent_message' ? Waypoints : Bot
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Icon className="size-3.5 shrink-0 text-muted" />
      <span className="truncate font-mono text-xs">
        {kind === 'model_request' ? (model ?? 'model') : (toolName ?? 'agent message')}
      </span>
    </span>
  )
}

export function RiskMeter({ score }: { score: number }) {
  const tone = riskTone(score)
  const color = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad' }[tone]
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-line">
        <span
          className={cn('block h-full rounded-full', color)}
          style={{ width: `${Math.max(4, score * 100)}%` }}
        />
      </span>
      <span className="w-7 text-right font-mono text-[11px] text-muted tabular-nums">
        {Math.round(score * 100)}
      </span>
    </span>
  )
}

const outcomeTone = { pass: 'ok', fail: 'bad', error: 'warn', skipped: 'neutral' } as const

export function CheckList({
  checks,
  workflows = [],
}: {
  checks: CheckResult[]
  /** Labels each workflow's steps when more than one ran. */
  workflows?: WorkflowRef[]
}) {
  if (checks.length === 0) return <div className="text-xs text-muted">No checks ran.</div>
  const names = new Map(workflows.map((w) => [w.id, w.name]))
  return (
    <ol className="flex flex-col divide-y divide-line rounded-md border border-line">
      {checks.map((c, i) => (
        <Fragment key={`${c.workflowId}:${c.stepId}`}>
          {workflows.length > 1 && c.workflowId && c.workflowId !== checks[i - 1]?.workflowId ? (
            <li className="bg-panel-2 px-3 py-1.5 text-[11px] font-medium text-muted">
              {names.get(c.workflowId) ?? c.workflowId}
            </li>
          ) : null}
          <li className="flex items-start gap-3 px-3 py-2">
            <span className="mt-0.5 w-4 text-right font-mono text-[11px] text-subtle">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">{stepLabels[c.type] ?? c.type}</span>
                {c.type === 'match' ? (
                  <Badge tone={c.branch === 'match' ? 'accent' : 'neutral'}>{c.branch}</Badge>
                ) : c.type === 'decision' ? (
                  <Badge tone={c.action === 'block' ? 'bad' : c.action ? 'warn' : 'ok'}>
                    {c.action === 'require_approval' && c.method
                      ? approvalLabels[c.method]
                      : (c.action?.replace('_', ' ') ?? 'allow')}
                  </Badge>
                ) : (
                  <Badge tone={outcomeTone[c.outcome]}>
                    {c.branch && c.branch !== c.outcome ? c.branch : c.outcome}
                  </Badge>
                )}
                {c.score != null ? (
                  <span className="font-mono text-[11px] text-muted">
                    risk {c.score.toFixed(2)}
                  </span>
                ) : null}
              </div>
              {c.reason ? (
                <div className="mt-0.5 text-xs break-words text-muted">{c.reason}</div>
              ) : null}
            </div>
            <span className="font-mono text-[11px] text-subtle">{c.durationMs}ms</span>
          </li>
        </Fragment>
      ))}
    </ol>
  )
}

export function JsonBlock({ value }: { value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return (
    <pre className="max-h-96 overflow-auto rounded-md border border-line bg-bg p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-muted">
      {text}
    </pre>
  )
}
