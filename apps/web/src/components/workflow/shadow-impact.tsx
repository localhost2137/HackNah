import type { PolicyGraph, RecordedResult, ReplayOutcome } from '@acl/shared'
import { Badge, Button, Field, Select } from '@acl/ui'
import { Link } from '@tanstack/react-router'
import { History, Square } from 'lucide-react'
import { useRef, useState } from 'react'
import { FormError } from '#/components/auth-shell.tsx'
import { pct, timeAgo } from '#/lib/format.ts'
import { type AffectedRequest, replayShadow } from '#/server/fns/shadow.ts'
import type { TimeRange } from '#/server/fns/traffic.ts'

type Judge = 'recorded' | 'pass' | 'fail'
type Transition = `${ReplayOutcome}>${ReplayOutcome}`
type Tally = {
  total: number
  scanned: number
  verdicts: Record<string, number>
  transitions: Record<string, number>
  affected: AffectedRequest[]
}

const outcomeLabel: Record<ReplayOutcome, string> = {
  allow: 'Allowed',
  approval: 'Approval',
  block: 'Blocked',
}
const outcomeTone = { allow: 'ok', approval: 'warn', block: 'bad' } as const
const recordedLabel: Record<RecordedResult, string> = {
  allow: 'allowed',
  approval: 'held for approval',
  block: 'blocked',
  rate_limited: 'rate limited',
  denied: 'denied by access',
}
const changes: Transition[] = [
  'allow>block',
  'allow>approval',
  'approval>block',
  'block>approval',
  'block>allow',
  'approval>allow',
]
const stricterChanges: Transition[] = ['allow>block', 'allow>approval', 'approval>block']
const looserChanges: Transition[] = ['block>approval', 'block>allow', 'approval>allow']
const recordedRows: { key: RecordedResult; label: string }[] = [
  { key: 'allow', label: 'Allowed' },
  { key: 'approval', label: 'Needed approval' },
  { key: 'block', label: 'Blocked by a workflow' },
  { key: 'rate_limited', label: 'Rate limited' },
  { key: 'denied', label: 'Denied by access' },
]
const shadowCols = [
  { key: 'not_started', label: 'Not run', tone: 'text-subtle' },
  { key: 'allow', label: 'Allow', tone: 'text-ok' },
  { key: 'approval', label: 'Approval', tone: 'text-warn' },
  { key: 'block', label: 'Block', tone: 'text-bad' },
] as const
const MAX_SHOWN = 200

function sum(a: Record<string, number>, b: Record<string, number>) {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v
  return out
}

const countOf = (counts: Record<string, number>, keys: string[]) =>
  keys.reduce((n, k) => n + (counts[k] ?? 0), 0)

function headline(t: Tally): string {
  const n = (k: Transition) => t.transitions[k] ?? 0
  const stricter = [
    n('allow>block') &&
      `block ${n('allow>block')} that were allowed (${pct(n('allow>block'), t.scanned)})`,
    n('allow>approval') && `hold ${n('allow>approval')} allowed ones for approval`,
    n('approval>block') && `block ${n('approval>block')} that needed approval`,
  ].filter(Boolean)
  const loosened = countOf(t.transitions, looserChanges)
  const alreadyFailed = countOf(t.verdicts, ['block>block', 'rate_limited>block', 'denied>block'])

  const parts = [`Out of ${t.scanned.toLocaleString()} requests, this draft would`]
  parts.push(stricter.length ? `${stricter.join(', ')}.` : 'not block anything new.')
  if (loosened) parts.push(`${loosened} blocked or held requests would get through more easily.`)
  if (alreadyFailed)
    parts.push(`It also blocks ${alreadyFailed} of the requests that already failed.`)
  return parts.join(' ')
}

/** Replays the graph against recorded traffic, including failed requests, without publishing it. */
export function ShadowImpact({ workflowId, graph }: { workflowId: string; graph: PolicyGraph }) {
  const [range, setRange] = useState<TimeRange>('7d')
  const [judge, setJudge] = useState<Judge>('recorded')
  const [tally, setTally] = useState<Tally | null>(null)
  const [ranOn, setRanOn] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const stop = useRef(false)

  const run = async () => {
    stop.current = false
    setRunning(true)
    setError(null)
    setRanOn(JSON.stringify(graph))
    let acc: Tally = { total: 0, scanned: 0, verdicts: {}, transitions: {}, affected: [] }
    setTally(acc)
    let cursor: number | undefined
    try {
      do {
        const r = await replayShadow({
          data: { workflowId, definition: graph, range, judge, cursor },
        })
        acc = {
          total: r.total ?? acc.total,
          scanned: acc.scanned + r.scanned,
          verdicts: sum(acc.verdicts, r.verdicts),
          transitions: sum(acc.transitions, r.transitions),
          affected: [...acc.affected, ...r.affected].slice(0, MAX_SHOWN),
        }
        setTally(acc)
        cursor = r.nextCursor
      } while (cursor && !stop.current)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  const stricterCount = tally ? countOf(tally.transitions, stricterChanges) : 0
  const looserCount = tally ? countOf(tally.transitions, looserChanges) : 0

  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-xs text-muted">
        Replays this graph on past requests, including failed ones, without publishing it. Other
        workflows keep the outcome they reached at the time.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Traffic from">
          <Select value={range} onChange={(e) => setRange(e.target.value as TimeRange)}>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </Select>
        </Field>
        <Field label="Judge steps">
          <Select value={judge} onChange={(e) => setJudge(e.target.value as Judge)}>
            <option value="recorded">Score from the time</option>
            <option value="pass">Always pass</option>
            <option value="fail">Always fail</option>
          </Select>
        </Field>
      </div>
      <div className="flex items-center gap-2">
        {running ? (
          <Button
            onClick={() => {
              stop.current = true
            }}
          >
            <Square className="size-3.5" /> Stop
          </Button>
        ) : (
          <Button variant="primary" onClick={run}>
            <History className="size-3.5" /> Replay past traffic
          </Button>
        )}
        {tally && tally.total > 0 ? (
          <span className="text-xs text-muted tabular-nums">
            {tally.scanned.toLocaleString()} / {tally.total.toLocaleString()}
          </span>
        ) : null}
      </div>
      {running && tally?.total ? (
        <div className="h-1 overflow-hidden rounded bg-panel-2">
          <div
            className="h-full bg-accent transition-[width]"
            style={{ width: `${(tally.scanned / tally.total) * 100}%` }}
          />
        </div>
      ) : null}
      <FormError message={error} />

      {tally && tally.scanned > 0 ? (
        <>
          {ranOn !== JSON.stringify(graph) ? (
            <p className="text-xs text-warn">The graph changed since this replay. Run it again.</p>
          ) : null}
          <p className="text-sm leading-relaxed">{headline(tally)}</p>

          <div className="grid grid-cols-2 gap-2">
            <Tile label="Replayed" value={tally.scanned} />
            <Tile label="Unchanged" value={tally.scanned - stricterCount - looserCount} />
            <Tile label="Stricter" value={stricterCount} tone="text-bad" />
            <Tile label="Looser" value={looserCount} tone="text-info" />
          </div>

          <VerdictMatrix verdicts={tally.verdicts} />

          {stricterCount + looserCount > 0 ? (
            <div className="flex flex-col">
              <div className="pb-1 text-[11px] font-medium text-subtle">What users would see</div>
              <ul className="flex flex-col gap-2.5">
                {changes.map((k) => {
                  const v = tally.transitions[k] ?? 0
                  if (!v) return null
                  const [from, to] = k.split('>') as [ReplayOutcome, ReplayOutcome]
                  return (
                    <li key={k}>
                      <div className="flex items-center gap-1.5 text-xs">
                        <Badge tone={outcomeTone[from]}>{outcomeLabel[from]}</Badge>
                        <span className="text-subtle">→</span>
                        <Badge tone={outcomeTone[to]}>{outcomeLabel[to]}</Badge>
                        <span className="ml-auto tabular-nums">
                          {v} · {pct(v, tally.scanned)}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded bg-panel-2">
                        <div
                          className={looserChanges.includes(k) ? 'h-full bg-info' : 'h-full bg-bad'}
                          style={{ width: `max(4px, ${(v / tally.scanned) * 100}%)` }}
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : null}

          {tally.affected.length > 0 ? (
            <div className="flex flex-col">
              <div className="pb-1 text-[11px] font-medium text-subtle">
                Requests this rule affects
              </div>
              <ul className="divide-y divide-line rounded-lg border border-line">
                {tally.affected.map((r) => (
                  <AffectedRow key={r.id} request={r} range={range} />
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function AffectedRow({ request: r, range }: { request: AffectedRequest; range: TimeRange }) {
  const changed = r.before !== r.after
  return (
    <li>
      <Link
        to="/events"
        search={{ selected: r.id, range }}
        className="flex flex-col gap-1 px-3 py-2 text-xs hover:bg-panel-2"
      >
        <div className="flex items-center gap-1.5">
          <span className="truncate font-mono">{r.target}</span>
          <span className="ml-auto shrink-0 text-subtle">{timeAgo(r.createdAt)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {changed ? (
            <>
              <Badge tone={outcomeTone[r.before]}>{outcomeLabel[r.before]}</Badge>
              <span className="text-subtle">→</span>
              <Badge tone={outcomeTone[r.after]}>{outcomeLabel[r.after]}</Badge>
            </>
          ) : (
            <Badge>Already {recordedLabel[r.recorded]}</Badge>
          )}
          {r.userName ? <span className="truncate text-muted">{r.userName}</span> : null}
        </div>
        {r.reason ? <div className="truncate text-muted">{r.reason}</div> : null}
      </Link>
    </li>
  )
}

function VerdictMatrix({ verdicts }: { verdicts: Record<string, number> }) {
  const rows = recordedRows.filter((r) => shadowCols.some((c) => verdicts[`${r.key}>${c.key}`]))
  return (
    <div className="flex flex-col">
      <div className="pb-1 text-[11px] font-medium text-subtle">
        What this rule decides on every request
      </div>
      <table className="w-full text-xs tabular-nums">
        <thead>
          <tr className="text-subtle">
            <th className="py-1 text-left font-normal">Originally</th>
            {shadowCols.map((c) => (
              <th key={c.key} className="py-1 text-right font-normal">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="py-1.5">{r.label}</td>
              {shadowCols.map((c) => {
                const v = verdicts[`${r.key}>${c.key}`] ?? 0
                return (
                  <td key={c.key} className={`py-1.5 text-right ${v ? c.tone : 'text-subtle'}`}>
                    {v ? v.toLocaleString() : '–'}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Tile({ label, value, tone = 'text-fg' }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg border border-line px-3 py-2">
      <div className="text-[11px] font-medium tracking-wide text-muted uppercase">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${tone}`}>
        {value.toLocaleString()}
      </div>
    </div>
  )
}
