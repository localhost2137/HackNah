import { ccSession, device, event, guardrail, guardrailVersion, user } from '@acl/db'
import { decision as decisionSchema, eventKind, eventPayload, policyGraph } from '@acl/shared'
import { createServerFn } from '@tanstack/react-start'
import { and, count, desc, eq, gte, inArray, like, lt, max, or, sql, sum } from 'drizzle-orm'
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

const PERFORMANCE_SAMPLE = 5000

/** Nearest-rank percentile of an ascending list; null when it is empty. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!
}

function latency(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95) }
}

/**
 * Spend and performance for the Overview. Spend sums the usage recorded on model requests;
 * performance looks at the newest events in the range (at most 5000), since the per-guardrail
 * timings live in a JSON column.
 */
export const getUsage = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ range: timeRange }))
  .handler(async ({ data, context: { db, orgId } }) => {
    const scope = and(
      eq(event.orgId, orgId),
      gte(event.createdAt, new Date(Date.now() - rangeMs[data.range])),
    )
    const cost = sql<number>`coalesce(sum(${event.costUsd}), 0)`.mapWith(Number)
    const tokens =
      sql<number>`coalesce(sum(coalesce(${event.inputTokens}, 0) + coalesce(${event.outputTokens}, 0) + coalesce(${event.cacheReadTokens}, 0) + coalesce(${event.cacheWriteTokens}, 0)), 0)`.mapWith(
        Number,
      )
    const gpuMs = sql<number>`coalesce(sum(${event.gpuMs}), 0)`.mapWith(Number)
    const requests = and(scope, eq(event.kind, 'model_request'))

    const [totals, byUser, byModel, sample] = await Promise.all([
      db
        .select({
          cost,
          input: sql<number>`coalesce(sum(${event.inputTokens}), 0)`.mapWith(Number),
          output: sql<number>`coalesce(sum(${event.outputTokens}), 0)`.mapWith(Number),
          cacheRead: sql<number>`coalesce(sum(${event.cacheReadTokens}), 0)`.mapWith(Number),
          cacheWrite: sql<number>`coalesce(sum(${event.cacheWriteTokens}), 0)`.mapWith(Number),
          gpuMs,
        })
        .from(event)
        .where(requests),
      db
        .select({ userId: event.userId, name: user.name, email: user.email, cost, tokens, gpuMs })
        .from(event)
        .leftJoin(user, eq(user.id, event.userId))
        .where(requests)
        .groupBy(event.userId, user.name, user.email)
        .orderBy(desc(cost), desc(tokens))
        .limit(6),
      db
        .select({ model: event.model, cost, tokens, gpuMs })
        .from(event)
        .where(requests)
        .groupBy(event.model)
        .orderBy(desc(cost), desc(tokens))
        .limit(6),
      db
        .select({
          kind: event.kind,
          decision: event.decision,
          overheadMs: event.overheadMs,
          guardrails: event.guardrails,
        })
        .from(event)
        .where(scope)
        .orderBy(desc(event.seq))
        .limit(PERFORMANCE_SAMPLE),
    ])

    const blockedDecisions = new Set<string>(BLOCKED_DECISIONS)
    const stages = new Map<string, { n: number; blocked: number; overhead: number[] }>()
    const guardrails = new Map<
      string,
      { name: string; n: number; blocked: number; durations: number[] }
    >()
    const overhead: number[] = []
    for (const e of sample) {
      const stage = stages.get(e.kind) ?? { n: 0, blocked: 0, overhead: [] }
      stage.n++
      if (blockedDecisions.has(e.decision)) stage.blocked++
      if (e.overheadMs != null) {
        stage.overhead.push(e.overheadMs)
        overhead.push(e.overheadMs)
      }
      stages.set(e.kind, stage)
      for (const w of e.guardrails) {
        // The sample is newest first, so the first name seen is the current one.
        const entry = guardrails.get(w.id) ?? { name: w.name, n: 0, blocked: 0, durations: [] }
        entry.n++
        if (w.decision === 'block') entry.blocked++
        if (w.durationMs != null) entry.durations.push(w.durationMs)
        guardrails.set(w.id, entry)
      }
    }

    const t = totals[0]
    return {
      spend: {
        cost: t?.cost ?? 0,
        tokens: {
          input: t?.input ?? 0,
          output: t?.output ?? 0,
          cacheRead: t?.cacheRead ?? 0,
          cacheWrite: t?.cacheWrite ?? 0,
        },
        gpuMs: t?.gpuMs ?? 0,
        byUser,
        byModel,
      },
      performance: {
        sampled: sample.length,
        overhead: latency(overhead),
        stages: [...stages].map(([kind, s]) => ({
          kind: kind as (typeof sample)[number]['kind'],
          n: s.n,
          blocked: s.blocked,
          ...latency(s.overhead),
        })),
        guardrails: [...guardrails]
          .map(([id, w]) => ({
            id,
            name: w.name,
            n: w.n,
            blocked: w.blocked,
            ...latency(w.durations),
          }))
          .sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0)),
      },
    }
  })

export const eventsSearch = z.object({
  decision: decisionSchema.optional(),
  kind: eventKind.optional(),
  user: z.string().optional(),
  session: z.string().optional(),
  /** Events of one user turn. */
  trace: z.string().optional(),
  /** Events a guardrail took part in. */
  guardrail: z.string().optional(),
  q: z.string().optional(),
  range: timeRange.default('24h'),
  selected: z.string().optional(),
})
export type EventsSearch = z.infer<typeof eventsSearch>

/** The conditions behind the Logs filters, shared by the list and the export. */
export function eventFilters(orgId: string, data: Omit<EventsSearch, 'selected'> & { cursor?: number }) {
  return and(
    eq(event.orgId, orgId),
    gte(event.createdAt, new Date(Date.now() - rangeMs[data.range])),
    data.decision ? eq(event.decision, data.decision) : undefined,
    data.kind ? eq(event.kind, data.kind) : undefined,
    data.user ? eq(event.userId, data.user) : undefined,
    data.session ? eq(event.sessionId, data.session) : undefined,
    data.trace ? eq(event.traceId, data.trace) : undefined,
    data.guardrail
      ? sql`exists (select 1 from json_each(${event.guardrails}) where json_extract(value, '$.id') = ${data.guardrail})`
      : undefined,
    data.cursor ? lt(event.seq, data.cursor) : undefined,
    data.q
      ? or(
          like(event.toolName, `%${data.q}%`),
          like(event.model, `%${data.q}%`),
          eq(event.id, data.q),
          like(event.traceId, `%${data.q}%`),
        )
      : undefined,
  )
}

export const listEvents = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(
    eventsSearch.extend({
      cursor: z.number().optional(),
      limit: z.number().min(1).max(200).default(50),
    }),
  )
  .handler(async ({ data, context: { db, orgId } }) => {
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
        costUsd: event.costUsd,
        sessionId: event.sessionId,
        traceId: event.traceId,
        country: event.country,
        createdAt: event.createdAt,
        userId: event.userId,
        userName: user.name,
        userEmail: user.email,
        checks: event.checks,
      })
      .from(event)
      .leftJoin(user, eq(user.id, event.userId))
      .where(eventFilters(orgId, data))
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

const TRACE_EVENTS = 500

/**
 * What the path view draws for one event: the event with its checks, the graph of each guardrail
 * version that ran on it (null when that version is gone or no longer parses), and the events of
 * its trace in order.
 */
export const getEventPath = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ id: z.string() }))
  .handler(async ({ data, context: { db, orgId } }) => {
    const [row] = await db
      .select({
        id: event.id,
        kind: event.kind,
        model: event.model,
        toolName: event.toolName,
        decision: event.decision,
        riskScore: event.riskScore,
        checks: event.checks,
        guardrails: event.guardrails,
        sessionId: event.sessionId,
        traceId: event.traceId,
        latencyMs: event.latencyMs,
        createdAt: event.createdAt,
        userId: event.userId,
        userName: user.name,
        userEmail: user.email,
      })
      .from(event)
      .leftJoin(user, eq(user.id, event.userId))
      .where(and(eq(event.orgId, orgId), eq(event.id, data.id)))
      .limit(1)
    if (!row) return null

    const ids = [...new Set(row.guardrails.map((g) => g.id))]
    const [versions, published, existing, trace] = await Promise.all([
      ids.length
        ? db
            .select({
              guardrailId: guardrailVersion.guardrailId,
              version: guardrailVersion.version,
              definition: guardrailVersion.definition,
            })
            .from(guardrailVersion)
            .where(
              and(
                eq(guardrailVersion.orgId, orgId),
                or(
                  ...row.guardrails.map((g) =>
                    and(
                      eq(guardrailVersion.guardrailId, g.id),
                      eq(guardrailVersion.version, g.version),
                    ),
                  ),
                ),
              ),
            )
        : [],
      ids.length
        ? db
            .select({
              guardrailId: guardrailVersion.guardrailId,
              version: max(guardrailVersion.version),
            })
            .from(guardrailVersion)
            .where(
              and(
                eq(guardrailVersion.orgId, orgId),
                eq(guardrailVersion.status, 'published'),
                inArray(guardrailVersion.guardrailId, ids),
              ),
            )
            .groupBy(guardrailVersion.guardrailId)
        : [],
      ids.length
        ? db
            .select({ id: guardrail.id })
            .from(guardrail)
            .where(and(eq(guardrail.orgId, orgId), inArray(guardrail.id, ids)))
        : [],
      row.traceId
        ? db
            .select({
              id: event.id,
              kind: event.kind,
              model: event.model,
              toolName: event.toolName,
              decision: event.decision,
              createdAt: event.createdAt,
            })
            .from(event)
            .where(and(eq(event.orgId, orgId), eq(event.traceId, row.traceId)))
            .orderBy(event.createdAt, event.seq)
            .limit(TRACE_EVENTS)
        : [],
    ])

    return {
      event: row,
      graphs: row.guardrails.map((g) => {
        const stored = versions.find((v) => v.guardrailId === g.id && v.version === g.version)
        return {
          guardrailId: g.id,
          version: g.version,
          graph: stored ? (policyGraph.safeParse(stored.definition).data ?? null) : null,
          /** False once the guardrail itself was deleted. */
          exists: existing.some((e) => e.id === g.id),
          publishedVersion: published.find((p) => p.guardrailId === g.id)?.version ?? null,
        }
      }),
      trace: trace.length ? trace : [row],
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
