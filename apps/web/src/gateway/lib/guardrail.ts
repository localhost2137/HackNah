import { type Db, guardrail, guardrailVersion, rateLimit } from '@acl/db'
import { type ActiveGuardrail, defaultGuardrail, type LimitRule, policyGraph } from '@acl/shared'
import { and, asc, desc, eq } from 'drizzle-orm'
import { TtlCache } from './cache.ts'

const guardrailCache = new TtlCache<ActiveGuardrail[]>(10_000)
const limitCache = new TtlCache<LimitRule[]>(10_000)

/** Every enabled guardrail with a published version, in display order. */
export function loadActiveGuardrails(db: Db, orgId: string): Promise<ActiveGuardrail[]> {
  return guardrailCache.get(orgId, async () => {
    const rows = await db
      .select({
        id: guardrail.id,
        name: guardrail.name,
        groupIds: guardrail.groupIds,
        version: guardrailVersion.version,
        definition: guardrailVersion.definition,
      })
      .from(guardrail)
      .innerJoin(
        guardrailVersion,
        and(
          eq(guardrailVersion.guardrailId, guardrail.id),
          eq(guardrailVersion.status, 'published'),
        ),
      )
      .where(and(eq(guardrail.orgId, orgId), eq(guardrail.enabled, true)))
      .orderBy(asc(guardrail.position), asc(guardrail.createdAt), desc(guardrailVersion.version))
    const active = new Map<string, ActiveGuardrail>()
    for (const row of rows) {
      if (active.has(row.id)) continue
      // Versions saved before the graph editor hold the old linear format.
      const parsed = policyGraph.safeParse(row.definition)
      active.set(row.id, { ...row, definition: parsed.success ? parsed.data : defaultGuardrail })
    }
    return [...active.values()]
  })
}

/** Enabled rules from the Limits page. */
export function loadLimits(db: Db, orgId: string): Promise<LimitRule[]> {
  return limitCache.get(orgId, async () => {
    const rows = await db.query.rateLimit.findMany({
      where: and(eq(rateLimit.orgId, orgId), eq(rateLimit.enabled, true)),
    })
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      measure: r.measure,
      scope: r.scope,
      target: r.target,
      limit: r.limit,
      windowSec: r.windowSec,
      per: r.per,
      groupId: r.groupId,
      action: r.action,
      warnAtPct: r.warnAtPct,
    }))
  })
}

/** Platform mutations should be visible immediately in this isolate. Other isolates expire in 10s. */
export function invalidatePolicyCaches(orgId: string) {
  guardrailCache.delete(orgId)
  limitCache.delete(orgId)
}
