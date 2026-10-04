import { Card } from '@acl/ui'
import { useMemo, useState } from 'react'
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { EventResult } from '#/lib/attack-analysis/replay.ts'
import { bucketTraffic, type TrafficBucket } from '#/lib/attack-analysis/timeline.ts'
import type { TrafficEvent } from '#/lib/attack-analysis/traffic.ts'

const time = (timestamp: number) => new Date(timestamp).toISOString().slice(11, 16)
const number = (value: number) => value.toLocaleString()
const axis = {
  axisLine: false,
  tickLine: false,
  tick: { fill: '#747b8e', fontSize: 10, fontFamily: 'var(--font-mono)' },
}

function BucketTooltip({
  bucket,
  minutes,
  evaluated,
}: {
  bucket?: TrafficBucket
  minutes: number
  evaluated: boolean
}) {
  if (!bucket) return null
  return (
    <div className="min-w-52 rounded-md border border-line-strong bg-panel px-3 py-2.5 text-xs shadow-xl">
      <div className="mb-3 border-b border-line pb-2 font-mono text-[10px] text-muted">
        {time(bucket.timestamp)}–{time(bucket.timestamp + minutes * 60_000)} UTC
      </div>
      <dl className="space-y-2">
        {[
          { label: 'Traffic', value: bucket.total, color: '#849be6' },
          { label: 'Expected blocks', value: bucket.expected, color: '#f0b965' },
          ...(evaluated
            ? [
                { label: 'Observed blocks', value: bucket.blocked, color: '#42c8ad' },
                { label: 'Missed attacks', value: bucket.missed, color: '#ec7689' },
                { label: 'False positives', value: bucket.overblocked, color: '#b8a0e6' },
                { label: 'Unresolved', value: bucket.unresolved, color: '#8b91a5' },
              ]
            : []),
        ].map((item) => (
          <div key={item.label} className="flex items-center justify-between gap-6">
            <dt className="flex items-center gap-2 text-muted">
              <span className="size-1.5 rounded-full" style={{ background: item.color }} />
              {item.label}
            </dt>
            <dd className="font-mono tabular-nums text-fg">{number(item.value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export function TrafficChart({
  traffic,
  results,
}: {
  traffic: TrafficEvent[]
  results?: EventResult[]
}) {
  const [minutes, setMinutes] = useState(5)
  const series = useMemo(
    () => bucketTraffic(traffic, results, minutes),
    [traffic, results, minutes],
  )
  const peak = Math.max(...series.map((bucket) => bucket.total))
  const ticks = series.filter((_, i) => i % (240 / minutes) === 0).map((b) => b.timestamp)
  const tooltip = (
    <Tooltip
      cursor={{ stroke: '#78829c', strokeDasharray: '3 3', fill: '#8992a0', fillOpacity: 0.08 }}
      content={({ active, payload }) =>
        active ? (
          <BucketTooltip
            bucket={payload?.[0]?.payload as TrafficBucket | undefined}
            minutes={minutes}
            evaluated={Boolean(results)}
          />
        ) : null
      }
    />
  )
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-info" />
          <h2 className="text-[13px] font-medium">Traffic</h2>
          <span className="ml-1 text-[10px] text-subtle">24 hours · UTC</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="font-mono text-[10px] text-muted">{number(traffic.length)} events</span>
          <div className="inline-flex rounded border border-line bg-bg p-0.5">
            {[5, 15, 60].map((interval) => (
              <button
                key={interval}
                type="button"
                aria-label={`${interval}-minute buckets`}
                aria-pressed={minutes === interval}
                onClick={() => setMinutes(interval)}
                className={`rounded-sm px-2 py-1 font-mono text-[10px] transition-colors ${minutes === interval ? 'bg-panel-2 text-fg' : 'text-subtle hover:text-fg'}`}
              >
                {interval === 60 ? '1h' : `${interval}m`}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="px-5 pt-4 pb-3">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-[10px] text-muted">
          <div className="flex flex-wrap items-center gap-4">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm bg-[#7189c4]/50" />
              Traffic
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 border-t border-dashed border-[#f0b965]" />
              Expected blocks
            </span>
            {results ? (
              <span className="flex items-center gap-1.5">
                <span className="w-3 border-t border-[#42c8ad]" />
                Observed blocks
              </span>
            ) : (
              <span className="text-subtle">Run to compare</span>
            )}
          </div>
          <span className="font-mono text-subtle">
            events / {minutes} min · peak {number(peak)}
          </span>
        </div>
        <div
          className="h-64"
          role="img"
          aria-label={`${series.length} ${minutes}-minute intervals containing ${traffic.length} synthetic events, with expected and ${results ? 'observed' : 'not yet evaluated'} block counts on the same scale. Peak ${peak} events per interval.`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={series}
              margin={{ top: 6, right: 6, bottom: 0, left: -12 }}
              barCategoryGap="14%"
            >
              <CartesianGrid vertical={false} stroke="#252934" strokeDasharray="2 4" />
              <XAxis {...axis} dataKey="timestamp" ticks={ticks} tickFormatter={time} height={24} />
              <YAxis {...axis} allowDecimals={false} width={40} tickCount={5} />
              {tooltip}
              <Bar
                dataKey="total"
                name="Traffic"
                fill="#7189c4"
                fillOpacity={0.3}
                isAnimationActive={false}
                maxBarSize={28}
              />
              <Line
                dataKey="expected"
                name="Expected blocks"
                type="linear"
                stroke="#f0b965"
                strokeWidth={1.5}
                strokeDasharray="3 2"
                dot={false}
                activeDot={{ r: 3 }}
                isAnimationActive={false}
              />
              {results ? (
                <Line
                  dataKey="blocked"
                  name="Observed blocks"
                  type="linear"
                  stroke="#42c8ad"
                  strokeWidth={1.75}
                  dot={false}
                  activeDot={{ r: 3 }}
                  isAnimationActive={false}
                />
              ) : null}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="border-t border-line px-5 py-2 font-mono text-[10px] text-subtle">
        {series.length} intervals · empty intervals included · synthetic source timestamps
      </div>
    </Card>
  )
}
