import {
  chunkRows,
  device,
  group,
  groupMember,
  mcpServer,
  member,
  resource,
  resourceGrant,
  user,
} from '@acl/db'
import { randomId } from '@acl/shared'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { audit } from '../audit.ts'
import { revokeUserDevices } from '../devices.ts'
import { adminMiddleware } from '../middleware.ts'

const subject = z.object({ type: z.enum(['user', 'group']), id: z.string() })
type Subject = z.infer<typeof subject>

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export const listResources = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async ({ context: { db, orgId } }) => {
    const rows = await db
      .select({ resource, serverName: mcpServer.name, serverSlug: mcpServer.slug })
      .from(resource)
      .leftJoin(mcpServer, eq(mcpServer.id, resource.mcpServerId))
      .where(eq(resource.orgId, orgId))
      .orderBy(asc(resource.name))
    const grants = await db
      .select({
        resourceId: resourceGrant.resourceId,
        subjectType: resourceGrant.subjectType,
        subjectId: resourceGrant.subjectId,
      })
      .from(resourceGrant)
      .innerJoin(resource, eq(resource.id, resourceGrant.resourceId))
      .where(eq(resource.orgId, orgId))
    return rows.map((r) => ({
      ...r.resource,
      serverName: r.serverName,
      serverSlug: r.serverSlug,
      grants: grants
        .filter((g) => g.resourceId === r.resource.id)
        .map((g) => ({ type: g.subjectType, id: g.subjectId })),
    }))
  })

export const saveResource = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(
    z.object({
      id: z.string().optional(),
      name: z.string().min(1).max(120),
      description: z.string().max(500).optional(),
      mcpServerId: z.string(),
      toolPatterns: z.array(z.string().min(1).max(200)).max(100),
    }),
  )
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    const server = await db.query.mcpServer.findFirst({
      where: and(eq(mcpServer.id, data.mcpServerId), eq(mcpServer.orgId, orgId)),
    })
    if (!server) throw new Error('Unknown MCP server')
    const values = {
      name: data.name,
      description: data.description ?? null,
      mcpServerId: data.mcpServerId,
      toolPatterns: data.toolPatterns,
    }
    let id = data.id
    if (id) {
      const [row] = await db
        .update(resource)
        .set(values)
        .where(and(eq(resource.id, id), eq(resource.orgId, orgId)))
        .returning({ id: resource.id })
      if (!row) throw new Error('Resource not found')
    } else {
      id = randomId('res')
      await db.insert(resource).values({ id, orgId, ...values })
    }
    await audit(db, {
      orgId,
      actorId: me.id,
      action: data.id ? 'resource.update' : 'resource.create',
      target: id,
      data: values,
    })
    return { id }
  })

export const deleteResource = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ id: z.string() }))
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    const [row] = await db
      .delete(resource)
      .where(and(eq(resource.id, data.id), eq(resource.orgId, orgId)))
      .returning()
    if (!row) throw new Error('Resource not found')
    await audit(db, {
      orgId,
      actorId: me.id,
      action: 'resource.delete',
      target: row.id,
      data: { name: row.name },
    })
    return { ok: true }
  })

/** Replaces who may use a resource. */
export const setResourceGrants = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ resourceId: z.string(), grants: z.array(subject).max(500) }))
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    const res = await db.query.resource.findFirst({
      where: and(eq(resource.id, data.resourceId), eq(resource.orgId, orgId)),
    })
    if (!res) throw new Error('Resource not found')
    await assertSubjectsInOrg(db, orgId, data.grants)

    const existing = await db
      .select()
      .from(resourceGrant)
      .where(eq(resourceGrant.resourceId, res.id))
    const key = (s: Subject) => `${s.type}:${s.id}`
    const wanted = new Map(data.grants.map((g) => [key(g), g]))
    const current = new Map(
      existing.map((g) => [
        key({ type: g.subjectType, id: g.subjectId }),
        { type: g.subjectType, id: g.subjectId },
      ]),
    )
    const added = [...wanted].filter(([k]) => !current.has(k)).map(([, s]) => s)
    const removed = [...current].filter(([k]) => !wanted.has(k)).map(([, s]) => s)

    if (removed.length) {
      for (const s of removed) {
        await db
          .delete(resourceGrant)
          .where(
            and(
              eq(resourceGrant.resourceId, res.id),
              eq(resourceGrant.subjectType, s.type),
              eq(resourceGrant.subjectId, s.id),
            ),
          )
      }
    }
    const rows = added.map((s) => ({ resourceId: res.id, subjectType: s.type, subjectId: s.id }))
    for (const chunk of chunkRows(rows, 4)) {
      await db.insert(resourceGrant).values(chunk).onConflictDoNothing()
    }
    await audit(db, {
      orgId,
      actorId: me.id,
      action: 'resource.grants',
      target: res.id,
      data: { added, removed },
    })
    return { added: added.length, removed: removed.length }
  })

async function assertSubjectsInOrg(
  db: Parameters<typeof audit>[0],
  orgId: string,
  subjects: Subject[],
) {
  // Compared in memory: D1 allows at most 100 bound parameters, so no large `IN (...)` lists.
  const userIds = subjects.filter((s) => s.type === 'user').map((s) => s.id)
  const groupIds = subjects.filter((s) => s.type === 'group').map((s) => s.id)
  if (userIds.length) {
    const members = await db
      .select({ id: member.userId })
      .from(member)
      .where(eq(member.organizationId, orgId))
    const known = new Set(members.map((m) => m.id))
    if (userIds.some((id) => !known.has(id)))
      throw new Error('Some users are not members of this organization')
  }
  if (groupIds.length) {
    const groups = await db.select({ id: group.id }).from(group).where(eq(group.orgId, orgId))
    const known = new Set(groups.map((g) => g.id))
    if (groupIds.some((id) => !known.has(id))) throw new Error('Unknown group')
  }
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export const listGroups = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async ({ context: { db, orgId } }) => {
    const groups = await db.query.group.findMany({
      where: eq(group.orgId, orgId),
      orderBy: [desc(group.isDefault), asc(group.name)],
    })
    const members = await db
      .select({
        groupId: groupMember.groupId,
        userId: user.id,
        name: user.name,
        email: user.email,
      })
      .from(groupMember)
      .innerJoin(user, eq(user.id, groupMember.userId))
      .innerJoin(group, eq(group.id, groupMember.groupId))
      .where(eq(group.orgId, orgId))
    const everyone = groups.some((g) => g.isDefault)
      ? await db
          .select({ userId: user.id, name: user.name, email: user.email })
          .from(member)
          .innerJoin(user, eq(user.id, member.userId))
          .where(eq(member.organizationId, orgId))
          .orderBy(asc(user.name))
      : []
    const grants = await db
      .select({ groupId: resourceGrant.subjectId, resourceId: resourceGrant.resourceId })
      .from(resourceGrant)
      .innerJoin(resource, eq(resource.id, resourceGrant.resourceId))
      .where(and(eq(resource.orgId, orgId), eq(resourceGrant.subjectType, 'group')))
    return groups.map((g) => ({
      ...g,
      members: g.isDefault
        ? everyone.map((m) => ({ ...m, groupId: g.id }))
        : members.filter((m) => m.groupId === g.id),
      resourceIds: grants.filter((r) => r.groupId === g.id).map((r) => r.resourceId),
    }))
  })

export const saveGroup = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(
    z.object({
      id: z.string().optional(),
      name: z.string().min(1).max(80),
      description: z.string().max(300).optional(),
    }),
  )
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    let id = data.id
    if (id) {
      const [row] = await db
        .update(group)
        .set({ name: data.name, description: data.description ?? null })
        .where(and(eq(group.id, id), eq(group.orgId, orgId)))
        .returning({ id: group.id })
      if (!row) throw new Error('Group not found')
    } else {
      id = randomId('grp')
      await db
        .insert(group)
        .values({ id, orgId, name: data.name, description: data.description ?? null })
    }
    await audit(db, {
      orgId,
      actorId: me.id,
      action: data.id ? 'group.update' : 'group.create',
      target: id,
    })
    return { id }
  })

export const deleteGroup = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ id: z.string() }))
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    const target = await db.query.group.findFirst({
      where: and(eq(group.id, data.id), eq(group.orgId, orgId)),
    })
    if (!target) throw new Error('Group not found')
    if (target.isDefault) throw new Error('The default group cannot be deleted')
    const [row] = await db
      .delete(group)
      .where(and(eq(group.id, data.id), eq(group.orgId, orgId)))
      .returning()
    if (!row) throw new Error('Group not found')
    await db
      .delete(resourceGrant)
      .where(and(eq(resourceGrant.subjectType, 'group'), eq(resourceGrant.subjectId, row.id)))
    await audit(db, {
      orgId,
      actorId: me.id,
      action: 'group.delete',
      target: row.id,
      data: { name: row.name },
    })
    return { ok: true }
  })

export const setGroupMembers = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ groupId: z.string(), userIds: z.array(z.string()).max(1000) }))
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    const g = await db.query.group.findFirst({
      where: and(eq(group.id, data.groupId), eq(group.orgId, orgId)),
    })
    if (!g) throw new Error('Group not found')
    if (g.isDefault) throw new Error('Every member belongs to the default group')
    await assertSubjectsInOrg(
      db,
      orgId,
      data.userIds.map((id) => ({ type: 'user', id })),
    )
    const existing = (await db.select().from(groupMember).where(eq(groupMember.groupId, g.id))).map(
      (m) => m.userId,
    )
    const added = data.userIds.filter((id) => !existing.includes(id))
    const removed = existing.filter((id) => !data.userIds.includes(id))
    for (const chunk of chunkRows(removed, 2)) {
      await db
        .delete(groupMember)
        .where(and(eq(groupMember.groupId, g.id), inArray(groupMember.userId, chunk)))
    }
    const rows = added.map((userId) => ({ groupId: g.id, userId }))
    for (const chunk of chunkRows(rows, 3)) {
      await db.insert(groupMember).values(chunk).onConflictDoNothing()
    }
    await audit(db, {
      orgId,
      actorId: me.id,
      action: 'group.members',
      target: g.id,
      data: { added, removed },
    })
    return { added: added.length, removed: removed.length }
  })

const patterns = z.array(z.string().trim().min(1).max(200)).max(100)

export const setGroupPermissions = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(
    z.object({
      groupId: z.string(),
      permissions: z.object({ models: patterns, builtinTools: patterns }),
    }),
  )
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    const [row] = await db
      .update(group)
      .set({ permissions: data.permissions })
      .where(and(eq(group.id, data.groupId), eq(group.orgId, orgId)))
      .returning({ id: group.id })
    if (!row) throw new Error('Group not found')
    await audit(db, {
      orgId,
      actorId: me.id,
      action: 'group.permissions',
      target: row.id,
      data: data.permissions,
    })
    return { ok: true }
  })

/** Replaces which resources a group is granted. Grants to users are left alone. */
export const setGroupResources = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ groupId: z.string(), resourceIds: z.array(z.string()).max(500) }))
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    const g = await db.query.group.findFirst({
      where: and(eq(group.id, data.groupId), eq(group.orgId, orgId)),
    })
    if (!g) throw new Error('Group not found')
    const known = new Set(
      (await db.select({ id: resource.id }).from(resource).where(eq(resource.orgId, orgId))).map(
        (r) => r.id,
      ),
    )
    if (data.resourceIds.some((id) => !known.has(id))) throw new Error('Unknown resource')

    const existing = (
      await db
        .select({ resourceId: resourceGrant.resourceId })
        .from(resourceGrant)
        .where(and(eq(resourceGrant.subjectType, 'group'), eq(resourceGrant.subjectId, g.id)))
    ).map((r) => r.resourceId)
    const added = data.resourceIds.filter((id) => !existing.includes(id))
    const removed = existing.filter((id) => !data.resourceIds.includes(id))
    for (const chunk of chunkRows(removed, 2)) {
      await db
        .delete(resourceGrant)
        .where(
          and(
            eq(resourceGrant.subjectType, 'group'),
            eq(resourceGrant.subjectId, g.id),
            inArray(resourceGrant.resourceId, chunk),
          ),
        )
    }
    const rows = added.map((resourceId) => ({
      resourceId,
      subjectType: 'group' as const,
      subjectId: g.id,
    }))
    for (const chunk of chunkRows(rows, 4)) {
      await db.insert(resourceGrant).values(chunk).onConflictDoNothing()
    }
    await audit(db, {
      orgId,
      actorId: me.id,
      action: 'group.resources',
      target: g.id,
      data: { added, removed },
    })
    return { added: added.length, removed: removed.length }
  })

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export const listMembers = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async ({ context: { db, orgId } }) => {
    const rows = await db
      .select({
        memberId: member.id,
        userId: user.id,
        name: user.name,
        email: user.email,
        role: member.role,
        joinedAt: member.createdAt,
      })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, orgId))
      .orderBy(asc(user.name))
    const devices = await db
      .select({ userId: device.userId, n: count() })
      .from(device)
      .where(and(eq(device.orgId, orgId), eq(device.status, 'trusted')))
      .groupBy(device.userId)
    const groups = await db
      .select({ userId: groupMember.userId, groupId: group.id, name: group.name })
      .from(groupMember)
      .innerJoin(group, eq(group.id, groupMember.groupId))
      .where(eq(group.orgId, orgId))
    return rows.map((r) => ({
      ...r,
      devices: devices.find((d) => d.userId === r.userId)?.n ?? 0,
      groups: groups
        .filter((g) => g.userId === r.userId)
        .map((g) => ({ id: g.groupId, name: g.name })),
    }))
  })

export const addMember = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ email: z.email(), role: z.enum(['member', 'admin']) }))
  .handler(async ({ data, context: { db, auth, orgId, user: me } }) => {
    const target = await db.query.user.findFirst({
      where: eq(user.email, data.email.toLowerCase()),
    })
    if (!target)
      throw new Error(
        'No account with that email yet. Ask them to sign up first, then add them here.',
      )
    await auth.api.addMember({
      body: { userId: target.id, role: data.role, organizationId: orgId },
    })
    await audit(db, {
      orgId,
      actorId: me.id,
      action: 'member.add',
      target: target.id,
      data: { role: data.role },
    })
    return { ok: true }
  })

export const updateMemberRole = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ memberId: z.string(), role: z.enum(['member', 'admin']) }))
  .handler(async ({ data, context: { db, auth, orgId, user: me } }) => {
    await auth.api.updateMemberRole({
      headers: getRequest().headers,
      body: { memberId: data.memberId, role: data.role, organizationId: orgId },
    })
    await audit(db, {
      orgId,
      actorId: me.id,
      action: 'member.role',
      target: data.memberId,
      data: { role: data.role },
    })
    return { ok: true }
  })

export const removeMember = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ memberId: z.string() }))
  .handler(async ({ data, context: { db, auth, orgId, user: me } }) => {
    const removed = await db.query.member.findFirst({
      where: and(eq(member.id, data.memberId), eq(member.organizationId, orgId)),
      columns: { userId: true },
    })
    await auth.api.removeMember({
      headers: getRequest().headers,
      body: { memberIdOrEmail: data.memberId, organizationId: orgId },
    })
    // Their Claude Code machines lose access right away, not when the access token expires.
    if (removed) await revokeUserDevices(db, orgId, removed.userId)
    await audit(db, { orgId, actorId: me.id, action: 'member.remove', target: data.memberId })
    return { ok: true }
  })
