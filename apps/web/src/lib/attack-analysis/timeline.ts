import { trafficWindow } from './datasets.ts'
import type { EventResult } from './replay.ts'
import type { TrafficEvent } from './traffic.ts'

export function seededRandom(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A reproducible workload model: uneven arrivals, variable sessions, pauses and retry bursts. */
export function trafficSchedule(count: number, seed: number) {
  const random = seededRandom(seed ^ 0x7f4a7c15)
  const start = Date.parse(trafficWindow.start)
  const duration = Date.parse(trafficWindow.end) - start
  const campaigns = Array.from({ length: 3 }, () => ({
    minute: 90 + random() * 1200,
    width: 6 + random() * 24,
  }))
  const campaignAt = (minute: number) =>
    Math.max(...campaigns.map((c) => Math.exp(-0.5 * ((minute - c.minute) / c.width) ** 2)))
  let load = 1
  const weights = Array.from({ length: 288 }, (_, i) => {
    const hour = i / 12
    // Business activity with a persistent, noisy load envelope; no fixed clock-time spikes.
    load = load * 0.65 + (0.15 + random() * 1.8) * 0.35
    const baseline = hour < 6 ? 0.12 : hour < 8 ? 0.4 : hour < 18 ? 1 : 0.3
    return baseline * load * (0.1 + -Math.log(Math.max(0.0001, random()))) + campaignAt(i * 5) * 1.8
  })
  let total = 0
  const cumulative = weights.map((weight) => {
    total += weight
    return total
  })
  const schedule: {
    session: number
    sequence: number
    timestamp: string
    attackProbability: number
  }[] = []
  let session = 0
  while (schedule.length < count) {
    const target = random() * total
    const bucket = cumulative.findIndex((weight) => weight >= target)
    let elapsed = (bucket * 5 + random() * 5) * 60_000
    const length = Math.min(26, 2 + Math.floor(-Math.log(Math.max(0.0001, random())) * 6))
    const riskySession = random() < 0.16
    for (let sequence = 0; sequence < length && schedule.length < count; sequence++) {
      if (sequence) {
        // Bursts of sub-second retries interspersed with seconds or minutes of think time.
        const retry = random() < 0.22
        elapsed += retry
          ? 150 + random() * 1800
          : 2000 + Math.min(95_000, -Math.log(Math.max(0.0001, random())) * 22_000)
      }
      if (elapsed >= duration) break
      schedule.push({
        session,
        sequence,
        timestamp: new Date(start + elapsed).toISOString(),
        attackProbability: Math.min(
          0.9,
          0.16 + campaignAt(elapsed / 60_000) * 0.58 + (riskySession ? 0.25 : 0),
        ),
      })
    }
    session++
  }
  return schedule
}

export type TrafficBucket = {
  timestamp: number
  total: number
  expected: number
  blocked: number
  missed: number
  overblocked: number
  unresolved: number
}

/** Aggregate the actual event timestamps. Empty intervals stay zero, never interpolated. */
export function bucketTraffic(
  traffic: TrafficEvent[],
  results: EventResult[] | undefined,
  minutes: number,
): TrafficBucket[] {
  const start = Date.parse(trafficWindow.start)
  const end = Date.parse(trafficWindow.end)
  const size = minutes * 60_000
  const buckets = Array.from({ length: Math.ceil((end - start) / size) }, (_, index) => ({
    timestamp: start + index * size,
    total: 0,
    expected: 0,
    blocked: 0,
    missed: 0,
    overblocked: 0,
    unresolved: 0,
  }))
  const byId = new Map(results?.map((r) => [r.eventId, r]) ?? [])
  for (const event of traffic) {
    const bucket = buckets[Math.floor((Date.parse(event.occurredAt) - start) / size)]
    if (!bucket) continue
    bucket.total++
    if (event.expected === 'block') bucket.expected++
    const result = byId.get(event.id)
    if (result?.actual === 'block') bucket.blocked++
    if (result?.outcome === 'missed') bucket.missed++
    if (result?.outcome === 'overblocked') bucket.overblocked++
    if (result?.outcome === 'review' || result?.outcome === 'inconclusive') bucket.unresolved++
  }
  return buckets
}
