import type { CheckResult, Decision, EventKind, GuardrailRef } from '@acl/shared'
import { approvalLabels, kindLabels, shortTraceId, stepLabels } from '@acl/shared'
import { Badge, cn } from '@acl/ui'
import { Link } from '@tanstack/react-router'
import {
  ArrowDownToLine,
  Bot,
  Check,
  Copy,
  type LucideIcon,
  MessageSquareText,
  Users,
  Wrench,
} from 'lucide-react'
import { Fragment, useState } from 'react'
import { decisionMeta, riskTone } from '#/lib/format.ts'

export function DecisionBadge({ decision }: { decision: Decision }) {
  const meta = decisionMeta[decision]
  return (
    <Badge tone={meta.tone} dot>
      {meta.label}
    </Badge>
  )
}

export const kindIcons: Record<EventKind, LucideIcon> = {
  model_request: Bot,
  tool_call: Wrench,
  tool_result: ArrowDownToLine,
  model_output: MessageSquareText,
  agent_message: Users,
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
  const Icon = kindIcons[kind]
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={kindLabels[kind]}>
      <Icon className="size-3.5 shrink-0 text-muted" />
      <span className="truncate font-mono text-xs">{toolName ?? model ?? 'model'}</span>
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

/** How one step ended: the answer of a condition, the action of a decision, the output of a check. */
export function CheckBadge({ check: c }: { check: CheckResult }) {
  // `match` is the Route block of events recorded before condition blocks.
  if (c.type === 'condition' || c.type === 'match')
    return (
      <Badge tone={c.branch === 'yes' || c.branch === 'match' ? 'accent' : 'neutral'}>
        {c.branch}
      </Badge>
    )
  if (c.type === 'decision' && c.outcome === 'skipped') return <Badge tone="neutral">skip</Badge>
  if (c.type === 'decision')
    return (
      <Badge tone={c.action === 'block' ? 'bad' : c.action ? 'warn' : 'ok'}>
        {c.action === 'require_approval' && c.method
          ? approvalLabels[c.method]
          : (c.action?.replace('_', ' ') ?? 'allow')}
      </Badge>
    )
  return (
    <Badge tone={outcomeTone[c.outcome]}>
      {c.branch && c.branch !== c.outcome ? c.branch : c.outcome}
    </Badge>
  )
}

export function CheckList({
  checks,
  guardrails = [],
}: {
  checks: CheckResult[]
  /** Labels each guardrail's steps when more than one ran. */
  guardrails?: GuardrailRef[]
}) {
  if (checks.length === 0) return <div className="text-xs text-muted">No checks ran.</div>
  const names = new Map(guardrails.map((w) => [w.id, w.name]))
  return (
    <ol className="flex flex-col divide-y divide-line rounded-md border border-line">
      {checks.map((c, i) => (
        <Fragment key={`${c.guardrailId}:${c.stepId}`}>
          {guardrails.length > 1 &&
          c.guardrailId &&
          c.guardrailId !== checks[i - 1]?.guardrailId ? (
            <li className="bg-panel-2 px-3 py-1.5 text-[11px] font-medium text-muted">
              {names.get(c.guardrailId) ?? c.guardrailId}
            </li>
          ) : null}
          <li className="flex items-start gap-3 px-3 py-2">
            <span className="mt-0.5 w-4 text-right font-mono text-[11px] text-subtle">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">{stepLabels[c.type] ?? c.type}</span>
                <CheckBadge check={c} />
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

const guardrailTone = { allow: 'ok', block: 'bad', pending: 'warn', skip: 'neutral' } as const

/** Each guardrail that ran, with what it alone decided and how long it took. */
export function GuardrailRuns({ guardrails }: { guardrails: GuardrailRef[] }) {
  if (guardrails.length === 0) return <span className="text-xs text-muted">None matched</span>
  return (
    <ul className="flex flex-col gap-1">
      {guardrails.map((w) => (
        <li key={w.id} className="flex items-center gap-2 text-xs">
          <Link
            to="/events"
            search={{ guardrail: w.id, range: '24h' }}
            className="truncate hover:text-accent-strong"
          >
            {w.name} <span className="text-subtle">v{w.version}</span>
          </Link>
          {w.decision ? (
            <Badge tone={guardrailTone[w.decision]}>
              {w.decision === 'pending'
                ? 'approval'
                : w.decision === 'skip'
                  ? 'skipped'
                  : w.decision}
            </Badge>
          ) : null}
          {w.durationMs != null ? (
            <span className="ml-auto font-mono text-[11px] text-subtle">{w.durationMs}ms</span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const Icon = copied ? Check : Copy
  return (
    <button
      type="button"
      className="rounded p-0.5 text-subtle hover:text-fg"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        })
      }}
    >
      <Icon className="size-3" />
    </button>
  )
}

/** A trace id in short form: click to list the trace's events in Logs, or copy the full id. */
export function TraceId({ traceId }: { traceId: string | null | undefined }) {
  if (!traceId) return <span className="text-xs text-subtle">—</span>
  return (
    <span className="inline-flex items-center gap-1">
      <Link
        to="/events"
        search={{ trace: traceId, range: '30d' }}
        className="font-mono text-xs text-muted hover:text-accent-strong"
        title={`Show the events of trace ${traceId}`}
        onClick={(e) => e.stopPropagation()}
      >
        {shortTraceId(traceId)}
      </Link>
      <CopyButton value={traceId} label="Copy trace id" />
    </span>
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
