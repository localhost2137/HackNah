import { type Db, rateLimit, workflow, workflowVersion } from '@acl/db'
import { type ActiveWorkflow, defaultWorkflow, type LimitRule, policyGraph } from '@acl/shared'
import { and, asc, desc, eq } from 'drizzle-orm'
import { TtlCache } from './cache.ts'

const workflowCache = new TtlCache<ActiveWorkflow[]>(10_000)
const limitCache = new TtlCache<LimitRule[]>(10_000)

/** Every enabled workflow with a published version, in display order. */
export function loadActiveWorkflows(db: Db, orgId: string): Promise<ActiveWorkflow[]> {
  return workflowCache.get(orgId, async () => {
    const rows = await db
      .select({
        id: workflow.id,
        name: workflow.name,
        groupIds: workflow.groupIds,
        version: workflowVersion.version,
        definition: workflowVersion.definition,
      })
      .from(workflow)
      .innerJoin(
        workflowVersion,
        and(eq(workflowVersion.workflowId, workflow.id), eq(workflowVersion.status, 'published')),
      )
      .where(and(eq(workflow.orgId, orgId), eq(workflow.enabled, true)))
      .orderBy(asc(workflow.position), asc(workflow.createdAt), desc(workflowVersion.version))
    const active = new Map<string, ActiveWorkflow>()
    for (const row of rows) {
      if (active.has(row.id)) continue
      // Versions saved before the graph editor hold the old linear format.
      const parsed = policyGraph.safeParse(row.definition)
      active.set(row.id, { ...row, definition: parsed.success ? parsed.data : defaultWorkflow })
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
  workflowCache.delete(orgId)
  limitCache.delete(orgId)
}
