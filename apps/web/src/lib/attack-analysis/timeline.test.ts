import { describe, expect, it } from 'vitest'
import { bucketTraffic, trafficSchedule } from './timeline.ts'
import { datasetTraffic } from './traffic.ts'

describe('traffic timing and chart aggregation', () => {
  it('uses variable sessions, uneven request spacing and reproducible dataset-specific arrivals', () => {
    const schedule = trafficSchedule(2400, 7391)
    expect(schedule).toEqual(trafficSchedule(2400, 7391))
    expect(schedule.map((e) => e.timestamp)).not.toEqual(
      trafficSchedule(2400, 12497).map((e) => e.timestamp),
    )
    const lengths = new Map<number, number>()
    const gaps: number[] = []
    for (const [index, event] of schedule.entries()) {
      lengths.set(event.session, (lengths.get(event.session) ?? 0) + 1)
      const previous = schedule[index - 1]
      if (previous?.session === event.session)
        gaps.push(Date.parse(event.timestamp) - Date.parse(previous.timestamp))
    }
    expect(new Set(lengths.values()).size).toBeGreaterThan(10)
    expect(gaps.some((gap) => gap < 2000)).toBe(true)
    expect(gaps.some((gap) => gap > 60_000)).toBe(true)
  })

  it('preserves every event when changing resolution and includes quiet intervals', () => {
    const traffic = datasetTraffic('prompt-injection')
    const attacks = traffic.filter((event) => event.expected === 'block').length
    for (const minutes of [5, 15, 60]) {
      const buckets = bucketTraffic(traffic, undefined, minutes)
      expect(buckets).toHaveLength(1440 / minutes)
      expect(buckets.reduce((sum, b) => sum + b.total, 0)).toBe(traffic.length)
      expect(buckets.reduce((sum, b) => sum + b.expected, 0)).toBe(attacks)
      expect(buckets.reduce((sum, b) => sum + b.blocked, 0)).toBe(0)
    }
    expect(bucketTraffic(traffic, undefined, 5).some((bucket) => bucket.total === 0)).toBe(true)
  })
})
