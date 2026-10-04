import { ccSession, device, event, user } from '@acl/db'
import { decision as decisionSchema, eventKind, eventPayload } from '@acl/shared'
import { createServerFn } from '@tanstack/react-start'
import { and, count, desc, eq, gte, inArray, like, lt, or, type SQL, sql, sum } from 'drizzle-orm'
import { z } from 'zod'
import { env } from '../env.ts'
import { adminMiddleware } from '../middleware.ts'

export const timeRange = z.enum(['1h', '24h', '7d', '30d'])
export type TimeRange = z.infer<typeof timeRange>

export const rangeMs: Record<TimeRange, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
}
const bucketMs: Record<TimeRange, number> = {
  '1h': 60_000,
  '24h': 3_600_000,
  '7d': 3_600_000,
  '30d': 86_400_000,
}

const BLOCKED_DECISIONS = ['block', 'declined', 'rate_limited'] as const

export const getOverview = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ range: timeRange }))
  .handler(async ({ data, context: { db, orgId } }) => {
    const since = new Date(Date.now() - rangeMs[data.range])
    const scope = and(eq(event.orgId, orgId), gte(event.createdAt, since))
    // Timestamps are stored as epoch milliseconds. The width is inlined, not bound, so the
    // GROUP BY expression is textually identical to the selected one.
    const width = sql.raw(String(bucketMs[data.range]))
    const bucket = sql<number>`(${event.createdAt} / ${width}) * ${width}`.mapWith(Number)

    const [totals, series, topUsers, topTools, riskiest, activeSessions] = await Promise.all([
      db
        .select({
          decision: event.decision,
          n: count(),
          input: sum(event.inputTokens),
          output: sum(event.outputTokens),
        })
        .from(event)
        .where(scope)
        .groupBy(event.decision),
      db
        .select({
          bucket,
          allowed:
            sql<number>`count(*) filter (where ${event.decision} in ('allow','approved'))`.mapWith(
              Number,
            ),
          blocked:
            sql<number>`count(*) filter (where ${event.decision} in ('block','declined','rate_limited'))`.mapWith(
              Number,
            ),
        })
        .from(event)
        .where(scope)
        .groupBy(bucket)
        .orderBy(bucket),
      db
        .select({
          userId: event.userId,
          name: user.name,
          email: user.email,
          n: count(),
          blocked:
            sql<number>`count(*) filter (where ${event.decision} in ('block','declined','rate_limited'))`.mapWith(
              Number,
            ),
        })
        .from(event)
        .leftJoin(user, eq(user.id, event.userId))
        .where(scope)
        .groupBy(event.userId, user.name, user.email)
        .orderBy(desc(count()))
        .limit(6),
      db
        .select({ toolName: event.toolName, n: count() })
        .from(event)
        .where(and(scope, eq(event.kind, 'tool_call')))
        .groupBy(event.toolName)
        .orderBy(desc(count()))
        .limit(6),
      db
        .select({
          id: event.id,
          kind: event.kind,
          toolName: event.toolName,
          model: event.model,
          decision: event.decision,
          riskScore: event.riskScore,
          createdAt: event.createdAt,
          userName: user.name,
          checks: event.checks,
        })
        .from(event)
        .leftJoin(user, eq(user.id, event.userId))
        .where(and(scope, inArray(event.decision, [...BLOCKED_DECISIONS, 'approved'])))
        .orderBy(desc(event.createdAt))
        .limit(8),
      db
        .select({ n: count() })
        .from(ccSession)
        .where(
          and(
            eq(ccSession.orgId, orgId),
            gte(ccSession.lastSeenAt, new Date(Date.now() - 3_600_000)),
          ),
        ),
    ])

    const byDecision = Object.fromEntries(totals.map((t) => [t.decision, t.n])) as Record<
      string,
      number
    >
    const total = totals.reduce((n, t) => n + t.n, 0)
    const blocked = BLOCKED_DECISIONS.reduce((n, d) => n + (byDecision[d] ?? 0), 0)
    return {
      total,
      blocked,
      approved: byDecision.approved ?? 0,
      tokens: totals.reduce((n, t) => n + Number(t.input ?? 0) + Number(t.output ?? 0), 0),
      activeSessions: activeSessions[0]?.n ?? 0,
      series: series.map((s) => ({ ...s, bucket: new Date(s.bucket).toISOString() })),
      topUsers,
      topTools,
      riskiest,
    }
  })

export const eventsSearch = z.object({
  decision: decisionSchema.optional(),
  kind: eventKind.optional(),
  user: z.string().optional(),
  session: z.string().optional(),
  q: z.string().optional(),
  range: timeRange.default('24h'),
  selected: z.string().optional(),
})
export type EventsSearch = z.infer<typeof eventsSearch>

export const listEvents = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(
    eventsSearch.extend({
      cursor: z.number().optional(),
      limit: z.number().min(1).max(200).default(50),
    }),
  )
  .handler(async ({ data, context: { db, orgId } }) => {
    const filters: (SQL | undefined)[] = [
      eq(event.orgId, orgId),
      gte(event.createdAt, new Date(Date.now() - rangeMs[data.range])),
      data.decision ? eq(event.decision, data.decision) : undefined,
      data.kind ? eq(event.kind, data.kind) : undefined,
      data.user ? eq(event.userId, data.user) : undefined,
      data.session ? eq(event.sessionId, data.session) : undefined,
      data.cursor ? lt(event.seq, data.cursor) : undefined,
      data.q
        ? or(
            like(event.toolName, `%${data.q}%`),
            like(event.model, `%${data.q}%`),
            eq(event.id, data.q),
          )
        : undefined,
    ]
    const rows = await db
      .select({
        seq: event.seq,
        id: event.id,
        kind: event.kind,
        model: event.model,
        toolName: event.toolName,
        decision: event.decision,
        riskScore: event.riskScore,
        latencyMs: event.latencyMs,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        sessionId: event.sessionId,
        country: event.country,
        createdAt: event.createdAt,
        userId: event.userId,
        userName: user.name,
        userEmail: user.email,
        checks: event.checks,
      })
      .from(event)
      .leftJoin(user, eq(user.id, event.userId))
      .where(and(...filters))
      .orderBy(desc(event.seq))
      .limit(data.limit + 1)
    const hasMore = rows.length > data.limit
    const page = rows.slice(0, data.limit)
    return { rows: page, nextCursor: hasMore ? page.at(-1)?.seq : undefined }
  })

export const getEvent = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ id: z.string() }))
  .handler(async ({ data, context: { db, orgId } }) => {
    const [row] = await db
      .select({ event, userName: user.name, userEmail: user.email, deviceLabel: device.label })
      .from(event)
      .leftJoin(user, eq(user.id, event.userId))
      .leftJoin(device, eq(device.id, event.deviceId))
      .where(and(eq(event.orgId, orgId), eq(event.id, data.id)))
      .limit(1)
    if (!row) return null
    let raw: z.infer<typeof eventPayload> | null = null
    if (row.event.payloadKey?.startsWith(`${orgId}/`)) {
      const obj = await env.PAYLOADS.get(row.event.payloadKey)
      if (obj) raw = eventPayload.safeParse(await obj.json()).data ?? null
    }
    const payload = raw
      ? {
          text: raw.input.text,
          toolArguments: toDisplay(raw.input.toolArguments),
          response: toDisplay(raw.response),
        }
      : null
    return {
      ...row.event,
      userName: row.userName,
      userEmail: row.userEmail,
      deviceLabel: row.deviceLabel,
      payload,
    }
  })

const MAX_DISPLAY_CHARS = 20_000

/** Responses are captured raw (SSE) and can be large; trim for the drawer. */
function toDisplay(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text.length > MAX_DISPLAY_CHARS
    ? `${text.slice(0, MAX_DISPLAY_CHARS)}\n… [truncated]`
    : text
}

export const listSessions = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ user: z.string().optional(), active: z.boolean().optional() }))
  .handler(async ({ data, context: { db, orgId } }) => {
    return db
      .select({
        session: ccSession,
        userName: user.name,
        userEmail: user.email,
        deviceLabel: device.label,
        deviceStatus: device.status,
      })
      .from(ccSession)
      .leftJoin(user, eq(user.id, ccSession.userId))
      .leftJoin(device, eq(device.id, ccSession.deviceId))
      .where(
        and(
          eq(ccSession.orgId, orgId),
          data.user ? eq(ccSession.userId, data.user) : undefined,
          data.active ? gte(ccSession.lastSeenAt, new Date(Date.now() - 3_600_000)) : undefined,
        ),
      )
      .orderBy(desc(ccSession.lastSeenAt))
      .limit(200)
  })
