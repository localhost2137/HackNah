import { type Db, rateLimit, workflowVersion } from '@acl/db'
import { defaultWorkflow, type PolicyGraph, policyGraph, type RateLimitRule } from '@acl/shared'
import { and, desc, eq } from 'drizzle-orm'
import { TtlCache } from './cache.ts'

export type ActiveWorkflow = { version: number | null; definition: PolicyGraph }

const workflowCache = new TtlCache<ActiveWorkflow>(10_000)
const rateLimitCache = new TtlCache<RateLimitRule[]>(10_000)

export function loadActiveWorkflow(db: Db, orgId: string): Promise<ActiveWorkflow> {
  return workflowCache.get(orgId, async () => {
    const row = await db.query.workflowVersion.findFirst({
      where: and(eq(workflowVersion.orgId, orgId), eq(workflowVersion.status, 'published')),
      orderBy: desc(workflowVersion.version),
    })
    if (!row) return { version: null, definition: defaultWorkflow }
    const parsed = policyGraph.safeParse(row.definition)
    return { version: row.version, definition: parsed.success ? parsed.data : defaultWorkflow }
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
