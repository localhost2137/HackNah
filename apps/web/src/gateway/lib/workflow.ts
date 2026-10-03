import { type Db, rateLimit, workflow, workflowVersion } from '@acl/db'
import { type ActiveWorkflow, defaultWorkflow, policyGraph, type RateLimitRule } from '@acl/shared'
import { and, asc, desc, eq } from 'drizzle-orm'
import { TtlCache } from './cache.ts'

const workflowCache = new TtlCache<ActiveWorkflow[]>(10_000)
const rateLimitCache = new TtlCache<RateLimitRule[]>(10_000)

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

export function loadRateLimits(db: Db, orgId: string): Promise<RateLimitRule[]> {
  return rateLimitCache.get(orgId, async () => {
    const rows = await db.query.rateLimit.findMany({
      where: and(eq(rateLimit.orgId, orgId), eq(rateLimit.enabled, true)),
    })
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      target: r.target,
      limit: r.limit,
      windowSec: r.windowSec,
      per: r.per,
    }))
  })
}
