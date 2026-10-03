import { type Db, group, groupMember, member, resource, resourceGrant } from '@acl/db'
import {
  ALL_PERMISSIONS,
  builtinToolAllowed,
  type EventKind,
  type GroupPermissions,
  globMatch,
  isBuiltinTool,
  mergePermissions,
  modelAllowed,
  NO_PERMISSIONS,
} from '@acl/shared'
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm'
import type { Principal } from '../context.ts'
import { TtlCache } from './cache.ts'

export type ResourceRow = typeof resource.$inferSelect

const roleCache = new TtlCache<string | null>(10_000)

function memberRole(db: Db, p: Principal): Promise<string | null> {
  return roleCache.get(`${p.orgId}:${p.userId}`, async () => {
    const membership = await db.query.member.findFirst({
      where: and(eq(member.organizationId, p.orgId), eq(member.userId, p.userId)),
      columns: { role: true },
    })
    return membership?.role ?? null
  })
}

const accessCache = new TtlCache<ResourceRow[]>(10_000)

/**
 * Resources the user may use: everything for admins, otherwise whatever is granted
 * to the user directly or to one of their groups (including the default group).
 */
export function accessibleResources(db: Db, p: Principal): Promise<ResourceRow[]> {
  return accessCache.get(`${p.orgId}:${p.userId}`, async () => {
    const role = await memberRole(db, p)
    if (!role) return []
    if (role === 'admin') return db.query.resource.findMany({ where: eq(resource.orgId, p.orgId) })

    const myGroups = await userGroupIds(db, p)
    const rows = await db
      .selectDistinct({ resource })
      .from(resource)
      .innerJoin(resourceGrant, eq(resourceGrant.resourceId, resource.id))
      .where(
        and(
          eq(resource.orgId, p.orgId),
          or(
            and(eq(resourceGrant.subjectType, 'user'), eq(resourceGrant.subjectId, p.userId)),
            myGroups.length
              ? and(
                  eq(resourceGrant.subjectType, 'group'),
                  inArray(resourceGrant.subjectId, myGroups),
                )
              : undefined,
          ),
        ),
      )
    return rows.map((r) => r.resource)
  })
}

const groupCache = new TtlCache<{ id: string; permissions: GroupPermissions }[]>(10_000)

/** The user's explicit groups plus the default group every member belongs to. */
function userGroups(db: Db, p: Principal) {
  return groupCache.get(`${p.orgId}:${p.userId}`, async () => {
    if (!(await memberRole(db, p))) return []
    return db
      .select({ id: group.id, permissions: group.permissions })
      .from(group)
      .leftJoin(
        groupMember,
        and(eq(groupMember.groupId, group.id), eq(groupMember.userId, p.userId)),
      )
      .where(
        and(eq(group.orgId, p.orgId), or(eq(group.isDefault, true), isNotNull(groupMember.userId))),
      )
  })
}

export async function userGroupIds(db: Db, p: Principal): Promise<string[]> {
  return (await userGroups(db, p)).map((g) => g.id)
}

/** Models and built-in tools the user may use. Admins may use everything. */
export async function effectivePermissions(db: Db, p: Principal): Promise<GroupPermissions> {
  const role = await memberRole(db, p)
  if (!role) return NO_PERMISSIONS
  if (role === 'admin') return ALL_PERMISSIONS
  return mergePermissions((await userGroups(db, p)).map((g) => g.permissions))
}

/** Why the user's group permissions rule out this request, or null if they allow it. */
export function permissionDenial(
  p: GroupPermissions,
  input: {
    kind: EventKind
    model?: string | null
    toolName: string | null
    mcpServerId?: string | null
  },
): string | null {
  if (input.kind === 'model_request' && input.model && !modelAllowed(p, input.model))
    return `Your groups do not allow the model ${input.model}`
  if (
    input.kind === 'tool_call' &&
    input.toolName &&
    !input.mcpServerId &&
    isBuiltinTool(input.toolName) &&
    !builtinToolAllowed(p, input.toolName)
  )
    return `Your groups do not allow the ${input.toolName} tool`
  return null
}

/** Removes built-in tool definitions the user may not use, so the model is never offered them. */
export function filterToolDefinitions<T extends { name?: unknown }>(
  p: GroupPermissions,
  tools: T[],
): T[] {
  return tools.filter(
    (t) => typeof t.name !== 'string' || !isBuiltinTool(t.name) || builtinToolAllowed(p, t.name),
  )
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

export { globMatch }

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
