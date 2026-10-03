import { type Db, groupMember, member, resource, resourceGrant } from '@acl/db'
import { and, eq, inArray, or } from 'drizzle-orm'
import type { Principal } from '../context.ts'
import { TtlCache } from './cache.ts'

export type ResourceRow = typeof resource.$inferSelect

const accessCache = new TtlCache<ResourceRow[]>(10_000)

/**
 * Resources the user may use: everything for owners and admins, otherwise whatever is granted
 * to the user directly or to one of their groups.
 */
export function accessibleResources(db: Db, p: Principal): Promise<ResourceRow[]> {
  return accessCache.get(`${p.orgId}:${p.userId}`, async () => {
    const membership = await db.query.member.findFirst({
      where: and(eq(member.organizationId, p.orgId), eq(member.userId, p.userId)),
    })
    if (!membership) return []
    if (membership.role === 'owner' || membership.role === 'admin')
      return db.query.resource.findMany({ where: eq(resource.orgId, p.orgId) })

    const myGroups = db
      .select({ id: groupMember.groupId })
      .from(groupMember)
      .where(eq(groupMember.userId, p.userId))
    const rows = await db
      .selectDistinct({ resource })
      .from(resource)
      .innerJoin(resourceGrant, eq(resourceGrant.resourceId, resource.id))
      .where(
        and(
          eq(resource.orgId, p.orgId),
          or(
            and(eq(resourceGrant.subjectType, 'user'), eq(resourceGrant.subjectId, p.userId)),
            and(eq(resourceGrant.subjectType, 'group'), inArray(resourceGrant.subjectId, myGroups)),
          ),
        ),
      )
    return rows.map((r) => r.resource)
  })
}

/** Narrows to the session's `/acl resources` selection, if one was made. */
export function applySessionScope(
  resources: ResourceRow[],
  scope: string[] | undefined,
): ResourceRow[] {
  if (!scope || scope.length === 0) return resources
  const wanted = new Set(scope)
  return resources.filter((r) => wanted.has(r.id))
}

export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  )
  return re.test(value)
}

/** Resource ids that grant `toolName` on `serverId`. Empty means the tool is not allowed. */
export function resourcesForTool(
  resources: ResourceRow[],
  serverId: string,
  toolName: string,
): string[] {
  return resources
    .filter(
      (r) =>
        r.mcpServerId === serverId &&
        (r.toolPatterns.length === 0 || r.toolPatterns.some((p) => globMatch(p, toolName))),
    )
    .map((r) => r.id)
}
