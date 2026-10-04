import { defaultGuardrail } from '@acl/shared'
import { describe, expect, it } from 'vitest'
import { datasets, trafficWindow } from './datasets.ts'
import { replayTraffic } from './replay.ts'
import { datasetTraffic } from './traffic.ts'

describe('synthetic traffic', () => {
  it('generates 8,000 distinct events with stable seeds, meaningful variation and coherent sessions', () => {
    const allIds = new Set<string>()
    let total = 0
    for (const dataset of datasets) {
      const events = datasetTraffic(dataset.id)
      expect(events).toEqual(datasetTraffic(dataset.id))
      expect(events).toHaveLength(dataset.eventCount)
      expect(new Set(events.map((e) => e.input.text)).size).toBeGreaterThan(events.length * 0.9)
      expect(new Set(events.map((e) => e.actor.id)).size).toBe(36)
      expect(new Set(events.map((e) => e.variant)).size).toBeGreaterThanOrEqual(10)
      expect(new Set(events.map((e) => e.input.model)).size).toBe(3)
      const attacks = events.filter((e) => e.expected === 'block').length
      expect(attacks).toBeGreaterThan(events.length * 0.2)
      expect(attacks).toBeLessThan(events.length * 0.5)
      const actorBySession = new Map<string, string>()
      for (const [index, event] of events.entries()) {
        expect(allIds.has(event.id)).toBe(false)
        allIds.add(event.id)
        expect(
          event.occurredAt >= trafficWindow.start && event.occurredAt < trafficWindow.end,
        ).toBe(true)
        if (index) expect(event.occurredAt >= events[index - 1]!.occurredAt).toBe(true)
        expect(actorBySession.get(event.sessionId) ?? event.actor.id).toBe(event.actor.id)
        actorBySession.set(event.sessionId, event.actor.id)
      }
      total += events.length
    }
    expect(total).toBe(8000)
  })

  it('replays an entire dataset in batches, retains event models and computes real decisions', async () => {
    const traffic = datasetTraffic('prompt-injection')
    const progress: number[] = []
    const results = await replayTraffic(
      traffic,
      [{ id: 'wf-test', name: 'Default', version: 1, groupIds: [], definition: defaultGuardrail }],
      { id: 'synthetic-analyst', groupIds: [], resourceIds: [], mcpServerId: null, model: '' },
      (n) => progress.push(n),
    )
    expect(results).toHaveLength(2400)
    expect(progress).toHaveLength(24)
    expect(progress.at(-1)).toBe(2400)
    expect(results.map((r) => r.eventId)).toEqual(traffic.map((e) => e.id))
    expect(results.map((r) => r.input.model)).toEqual(traffic.map((e) => e.input.model))
    expect(new Set(results.map((r) => r.actual))).toEqual(new Set(['block', 'allow']))
    expect(results.filter((r) => r.outcome === 'missed').length).toBeGreaterThan(0)
  })
})
