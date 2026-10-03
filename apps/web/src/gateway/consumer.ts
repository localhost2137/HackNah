import { ccSession, chunkRows, createDb, event } from '@acl/db'
import type { GatewayEvent } from '@acl/shared'
import { getTableColumns, sql } from 'drizzle-orm'

const BLOCKED = new Set(['block', 'declined', 'rate_limited'])
const EVENT_COLUMNS = Object.keys(getTableColumns(event)).length

/** Writes queued gateway events to D1 in batches and keeps per-session counters. */
export async function consumeEvents(batch: MessageBatch<GatewayEvent>, env: Env): Promise<void> {
  const db = createDb(env.DB)
  const events = batch.messages.map((m) => m.body)

  try {
    const rows = events.map((e) => ({ ...e, createdAt: new Date(e.createdAt) }))
    for (const chunk of chunkRows(rows, EVENT_COLUMNS)) {
      await db.insert(event).values(chunk).onConflictDoNothing({ target: event.id })
    }

    const bySession = new Map<string, GatewayEvent[]>()
    for (const e of events) {
      if (!e.sessionId) continue
      const key = `${e.orgId}:${e.sessionId}`
      bySession.set(key, [...(bySession.get(key) ?? []), e])
    }
    for (const list of bySession.values()) {
      const first = list[0]!
      const last = list.reduce((a, b) => (a.createdAt > b.createdAt ? a : b))
      const blocked = list.filter((e) => BLOCKED.has(e.decision)).length
      const input = list.reduce((n, e) => n + (e.inputTokens ?? 0), 0)
      const output = list.reduce((n, e) => n + (e.outputTokens ?? 0), 0)
      const lastSeen = new Date(last.createdAt)
      await db
        .insert(ccSession)
        .values({
          id: first.sessionId!,
          orgId: first.orgId,
          userId: first.userId,
          deviceId: first.deviceId,
          resourceIds: last.resourceIds,
          requestCount: list.length,
          blockedCount: blocked,
          inputTokens: input,
          outputTokens: output,
          startedAt: new Date(first.createdAt),
          lastSeenAt: lastSeen,
        })
        .onConflictDoUpdate({
          target: ccSession.id,
          set: {
            requestCount: sql`${ccSession.requestCount} + ${list.length}`,
            blockedCount: sql`${ccSession.blockedCount} + ${blocked}`,
            inputTokens: sql`${ccSession.inputTokens} + ${input}`,
            outputTokens: sql`${ccSession.outputTokens} + ${output}`,
            resourceIds: last.resourceIds,
            lastSeenAt: sql`max(${ccSession.lastSeenAt}, ${lastSeen.getTime()})`,
          },
        })
    }
    batch.ackAll()
  } catch (err) {
    console.error('event ingest failed', err)
    batch.retryAll({ delaySeconds: 10 })
  }
}
