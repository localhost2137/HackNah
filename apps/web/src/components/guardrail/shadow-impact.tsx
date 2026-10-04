import type { PolicyGraph, RecordedResult, ReplayOutcome } from '@acl/shared'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Select,
  Stat,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@acl/ui'
import { useNavigate } from '@tanstack/react-router'
import { History, Square } from 'lucide-react'
import { useRef, useState } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { FormError } from '#/components/auth-shell.tsx'
import { pct, timeAgo } from '#/lib/format.ts'
import {
  type AffectedRequest,
  type ImpactTimelinePoint,
  replayShadow,
} from '#/server/fns/shadow.ts'
import type { TimeRange } from '#/server/fns/traffic.ts'

type Judge = 'recorded' | 'pass' | 'fail'
type Transition = `${ReplayOutcome}>${ReplayOutcome}`
type Tally = {
  total: number
  scanned: number
  verdicts: Record<string, number>
  transitions: Record<string, number>
  timeline: Record<string, ImpactTimelinePoint>
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
  { key: 'block', label: 'Blocked by a guardrail' },
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

function sumTimeline(
  a: Record<string, ImpactTimelinePoint>,
  b: Record<string, ImpactTimelinePoint>,
) {
  const out = { ...a }
  for (const [bucket, point] of Object.entries(b)) {
    const previous = out[bucket] ?? { stricter: 0, looser: 0, unchanged: 0 }
    out[bucket] = {
      stricter: previous.stricter + point.stricter,
      looser: previous.looser + point.looser,
      unchanged: previous.unchanged + point.unchanged,
    }
  }
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

  const parts = [`Out of ${t.scanned.toLocaleString()} requests, this version would`]
  parts.push(stricter.length ? `${stricter.join(', ')}.` : 'not block anything new.')
  if (loosened) parts.push(`${loosened} blocked or held requests would get through more easily.`)
  if (alreadyFailed)
    parts.push(`It also blocks ${alreadyFailed} of the requests that already failed.`)
  return parts.join(' ')
}

/** Replays the graph against recorded traffic, including failed requests, without publishing it. */
export function ShadowImpact({ guardrailId, graph }: { guardrailId: string; graph: PolicyGraph }) {
  const [range, setRange] = useState<TimeRange>('7d')
  const [judge, setJudge] = useState<Judge>('recorded')
  const [tally, setTally] = useState<Tally | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const stop = useRef(false)

  const run = async () => {
    stop.current = false
    setRunning(true)
    setError(null)
    let acc: Tally = {
      total: 0,
      scanned: 0,
      verdicts: {},
      transitions: {},
      timeline: {},
      affected: [],
    }
    setTally(acc)
    let cursor: number | undefined
    try {
      do {
        const r = await replayShadow({
          data: { guardrailId, definition: graph, range, judge, cursor },
        })
        acc = {
          total: r.total ?? acc.total,
          scanned: acc.scanned + r.scanned,
          verdicts: sum(acc.verdicts, r.verdicts),
          transitions: sum(acc.transitions, r.transitions),
          timeline: sumTimeline(acc.timeline, r.timeline),
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
    <div className="flex flex-col gap-4">
      <Card className="flex flex-wrap items-end gap-3 px-4 py-3">
        <Field label="Traffic from" className="w-44">
          <Select value={range} onChange={(e) => setRange(e.target.value as TimeRange)}>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </Select>
        </Field>
        <Field label="Judge steps" className="w-44">
          <Select value={judge} onChange={(e) => setJudge(e.target.value as Judge)}>
            <option value="recorded">Score from the time</option>
            <option value="pass">Always pass</option>
            <option value="fail">Always fail</option>
          </Select>
        </Field>
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
          <span className="pb-2 text-xs text-muted tabular-nums">
            {tally.scanned.toLocaleString()} / {tally.total.toLocaleString()} requests
          </span>
        ) : null}
        {running && tally?.total ? (
          <div className="h-1 basis-full overflow-hidden rounded bg-panel-2">
            <div
              className="h-full bg-accent transition-[width]"
              style={{ width: `${(tally.scanned / tally.total) * 100}%` }}
            />
          </div>
        ) : null}
      </Card>
      <FormError message={error} />

      {tally && tally.scanned > 0 ? (
        <>
          <Card className="px-4 py-3 text-base leading-relaxed">{headline(tally)}</Card>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Replayed" value={tally.scanned.toLocaleString()} />
            <Stat
              label="Unchanged"
              value={(tally.scanned - stricterCount - looserCount).toLocaleString()}
            />
            <Stat label="Stricter" value={stricterCount.toLocaleString()} tone="bad" />
            <Stat label="Looser" value={looserCount.toLocaleString()} />
          </div>

          <Card>
            <CardHeader
              title="Impact over time"
              description="How this guardrail would affect requests by the time they were recorded"
            />
            <ImpactTimeline timeline={tally.timeline} range={range} />
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="What this rule decides on every request"
                description="Original result of each request, against what this version decides on its own"
              />
              <div className="p-4">
                <VerdictMatrix verdicts={tally.verdicts} />
              </div>
            </Card>
            <Card>
              <CardHeader
                title="What users would see"
                description="Requests whose outcome changes if this version goes live"
              />
              <div className="p-4">
                {stricterCount + looserCount > 0 ? (
                  <Transitions transitions={tally.transitions} scanned={tally.scanned} />
                ) : (
                  <p className="text-xs text-muted">No request would end differently.</p>
                )}
              </div>
            </Card>
          </div>

          {tally.affected.length > 0 ? (
            <Card>
              <CardHeader
                title="Requests this rule affects"
                description={`Newest first, up to ${MAX_SHOWN}. Click one to open it in Logs.`}
              />
              <AffectedTable rows={tally.affected} range={range} />
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function ImpactTimeline({
  timeline,
  range,
}: {
  timeline: Record<string, ImpactTimelinePoint>
  range: TimeRange
}) {
  const data = Object.entries(timeline)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([recordedAt, counts]) => ({ recordedAt, ...counts }))
  const formatTime = (iso: string) =>
    new Date(iso).toLocaleString(
      'en-GB',
      range === '24h' ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: 'short' },
    )

  return (
    <div className="h-72 px-3 pt-5 pb-3">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--color-line)" vertical={false} />
          <XAxis
            dataKey="recordedAt"
            tickFormatter={formatTime}
            stroke="var(--color-subtle)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            stroke="var(--color-subtle)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            width={42}
          />
          <Tooltip
            cursor={{ fill: 'var(--color-panel-2)', opacity: 0.35 }}
            contentStyle={{
              background: 'var(--color-panel)',
              border: '1px solid var(--color-line-strong)',
              borderRadius: 8,
              boxShadow: '0 8px 24px rgb(0 0 0 / 0.25)',
              fontSize: 12,
            }}
            labelFormatter={(value) => new Date(String(value)).toLocaleString()}
            formatter={(value) => Number(value).toLocaleString()}
          />
          <Legend
            iconType="circle"
            iconSize={7}
            wrapperStyle={{ color: 'var(--color-muted)', fontSize: 11 }}
          />
          <Line
            type="monotone"
            dataKey="unchanged"
            name="Unchanged"
            stroke="var(--color-subtle)"
            strokeWidth={1.5}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="stricter"
            name="Stricter"
            stroke="var(--color-bad)"
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="looser"
            name="Looser"
            stroke="var(--color-info)"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function Transitions({
  transitions,
  scanned,
}: {
  transitions: Record<string, number>
  scanned: number
}) {
  return (
    <ul className="flex flex-col gap-3">
      {changes.map((k) => {
        const v = transitions[k] ?? 0
        if (!v) return null
        const [from, to] = k.split('>') as [ReplayOutcome, ReplayOutcome]
        return (
          <li key={k}>
            <div className="flex items-center gap-1.5 text-xs">
              <Badge tone={outcomeTone[from]}>{outcomeLabel[from]}</Badge>
              <span className="text-subtle">→</span>
              <Badge tone={outcomeTone[to]}>{outcomeLabel[to]}</Badge>
              <span className="ml-auto tabular-nums">
                {v.toLocaleString()} · {pct(v, scanned)}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded bg-panel-2">
              <div
                className={looserChanges.includes(k) ? 'h-full bg-info' : 'h-full bg-bad'}
                style={{ width: `max(4px, ${(v / scanned) * 100}%)` }}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function VerdictMatrix({ verdicts }: { verdicts: Record<string, number> }) {
  const rows = recordedRows.filter((r) => shadowCols.some((c) => verdicts[`${r.key}>${c.key}`]))
  return (
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
  )
}

function AffectedTable({ rows, range }: { rows: AffectedRequest[]; range: TimeRange }) {
  const navigate = useNavigate()
  return (
    <Table>
      <THead>
        <tr>
          <TH>Time</TH>
          <TH>User</TH>
          <TH>Request</TH>
          <TH>Change</TH>
          <TH>Reason</TH>
        </tr>
      </THead>
      <TBody>
        {rows.map((r) => (
          <TR
            key={r.id}
            onClick={() => navigate({ to: '/events', search: { selected: r.id, range } })}
          >
            <TD className="text-xs text-muted">{timeAgo(r.createdAt)}</TD>
            <TD className="text-xs">{r.userName ?? '—'}</TD>
            <TD className="max-w-56 truncate font-mono text-xs">{r.target}</TD>
            <TD>
              {r.before !== r.after ? (
                <span className="flex items-center gap-1.5">
                  <Badge tone={outcomeTone[r.before]}>{outcomeLabel[r.before]}</Badge>
                  <span className="text-subtle">→</span>
                  <Badge tone={outcomeTone[r.after]}>{outcomeLabel[r.after]}</Badge>
                </span>
              ) : (
                <Badge>Already {recordedLabel[r.recorded]}</Badge>
              )}
            </TD>
            <TD className="max-w-80 truncate text-xs text-muted">{r.reason ?? ''}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  )
}
