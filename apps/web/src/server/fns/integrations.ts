import {
  event,
  group,
  mcpCredential,
  mcpServer,
  rateLimit,
  resource,
  resourceGrant,
  user,
} from '@acl/db'
import {
  credentialAad,
  type Decision,
  encryptString,
  randomId,
  toolTierFromAnnotations,
} from '@acl/shared'
import { createServerFn } from '@tanstack/react-start'
import { and, asc, count, desc, eq, gte, isNull, max, or } from 'drizzle-orm'
import { z } from 'zod'
import { refreshServerTools } from '#/gateway/control.ts'
import { audit } from '../audit.ts'
import { env } from '../env.ts'
import { adminMiddleware } from '../middleware.ts'

export const listMcpServers = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async ({ context: { db, orgId, user: me } }) => {
    const servers = await db.query.mcpServer.findMany({
      where: eq(mcpServer.orgId, orgId),
      orderBy: asc(mcpServer.name),
    })
    const creds = await db
      .select({
        serverId: mcpCredential.mcpServerId,
        userId: mcpCredential.userId,
        accountLabel: mcpCredential.accountLabel,
        updatedAt: mcpCredential.updatedAt,
      })
      .from(mcpCredential)
      .where(
        and(
          eq(mcpCredential.orgId, orgId),
          or(isNull(mcpCredential.userId), eq(mcpCredential.userId, me.id)),
        ),
      )
    return servers.map(({ oauth, ...s }) => ({
      ...s,
      toolCount: s.tools.length,
      oauth: oauth
        ? {
            authorizeUrl: oauth.authorizeUrl,
            tokenUrl: oauth.tokenUrl,
            clientId: oauth.clientId,
            scopes: oauth.scopes,
            hasSecret: Boolean(oauth.clientSecretEnc),
          }
        : null,
      orgCredential: creds.find((c) => c.serverId === s.id && c.userId === null) ?? null,
      myCredential: creds.find((c) => c.serverId === s.id && c.userId === me.id) ?? null,
    }))
  })

const serverInput = z.object({
  id: z.string().optional(),
  preset: z.string().optional(),
  name: z.string().min(1).max(80),
  slug: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-z][a-z0-9-]*$/, 'Lowercase letters, digits and dashes'),
  url: z.url(),
  authType: z.enum(['none', 'bearer', 'oauth2']),
  credentialMode: z.enum(['org', 'user']),
  oauth: z
    .object({
      authorizeUrl: z.url(),
      tokenUrl: z.url(),
      clientId: z.string().min(1),
      /** Empty keeps the stored secret. */
      clientSecret: z.string().optional(),
      scopes: z.array(z.string()),
    })
    .optional(),
})

export const saveMcpServer = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(serverInput)
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    const id = data.id ?? randomId('mcp')
    const existing = data.id
      ? await db.query.mcpServer.findFirst({
          where: and(eq(mcpServer.id, data.id), eq(mcpServer.orgId, orgId)),
        })
      : null
    if (data.id && !existing) throw new Error('Server not found')
    if (data.authType === 'oauth2' && !data.oauth) throw new Error('OAuth settings are required')

    const oauth =
      data.authType === 'oauth2' && data.oauth
        ? {
            authorizeUrl: data.oauth.authorizeUrl,
            tokenUrl: data.oauth.tokenUrl,
            clientId: data.oauth.clientId,
            scopes: data.oauth.scopes,
            clientSecretEnc: data.oauth.clientSecret
              ? await encryptString(env.ENCRYPTION_KEY, data.oauth.clientSecret, `mcp-client:${id}`)
              : (existing?.oauth?.clientSecretEnc ?? null),
          }
        : null
    const values = {
      name: data.name,
      slug: data.slug,
      preset: data.preset ?? null,
      url: data.url,
      authType: data.authType,
      credentialMode: data.credentialMode,
      oauth,
    }
    try {
      if (existing) await db.update(mcpServer).set(values).where(eq(mcpServer.id, id))
      else await db.insert(mcpServer).values({ id, orgId, ...values })
    } catch (err) {
      if (String(err).includes('unique'))
        throw new Error(`The prefix "${data.slug}" is already used`)
      throw err
    }
    await audit(db, {
      orgId,
      actorId: me.id,
      action: existing ? 'mcp.update' : 'mcp.create',
      target: id,
      data: { name: data.name, url: data.url },
    })
    return { id }
  })

export const setMcpEnabled = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ id: z.string(), enabled: z.boolean() }))
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    await db
      .update(mcpServer)
      .set({ enabled: data.enabled })
      .where(and(eq(mcpServer.id, data.id), eq(mcpServer.orgId, orgId)))
    await audit(db, {
      orgId,
      actorId: me.id,
      action: data.enabled ? 'mcp.enable' : 'mcp.disable',
      target: data.id,
    })
    return { ok: true }
  })

export const deleteMcpServer = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ id: z.string() }))
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    const [row] = await db
      .delete(mcpServer)
      .where(and(eq(mcpServer.id, data.id), eq(mcpServer.orgId, orgId)))
      .returning()
    if (!row) throw new Error('Server not found')
    await db
      .delete(rateLimit)
      .where(
        and(eq(rateLimit.orgId, orgId), eq(rateLimit.scope, 'mcp'), eq(rateLimit.target, row.id)),
      )
    await audit(db, {
      orgId,
      actorId: me.id,
      action: 'mcp.delete',
      target: row.id,
      data: { name: row.name },
    })
    return { ok: true }
  })

/** Stores a pasted token: the org-wide one (admins) or the caller's own. */
export const setBearerCredential = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(
    z.object({
      serverId: z.string(),
      token: z.string().min(8).max(4096),
      label: z.string().max(80).optional(),
    }),
  )
  .handler(async ({ data, context: { db, orgId, user: me, isAdmin } }) => {
    const server = await db.query.mcpServer.findFirst({
      where: and(eq(mcpServer.id, data.serverId), eq(mcpServer.orgId, orgId)),
    })
    if (!server) throw new Error('Server not found')
    if (server.authType === 'none') throw new Error('This server does not use credentials')
    const owner = server.credentialMode === 'org' ? null : me.id
    if (owner === null && !isAdmin) throw new Error('Only admins can set the shared credential')
    const accessTokenEnc = await encryptString(
      env.ENCRYPTION_KEY,
      data.token.trim(),
      credentialAad(server.id, owner),
    )
    await db
      .delete(mcpCredential)
      .where(
        and(
          eq(mcpCredential.mcpServerId, server.id),
          owner ? eq(mcpCredential.userId, owner) : isNull(mcpCredential.userId),
        ),
      )
    await db.insert(mcpCredential).values({
      id: randomId('cred'),
      orgId,
      mcpServerId: server.id,
      userId: owner,
      accessTokenEnc,
      accountLabel: data.label ?? null,
    })
    await audit(db, {
      orgId,
      actorId: me.id,
      action: 'mcp.credential.set',
      target: server.id,
      data: { shared: owner === null },
    })
    return { ok: true }
  })

export const disconnectCredential = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ serverId: z.string(), shared: z.boolean() }))
  .handler(async ({ data, context: { db, orgId, user: me, isAdmin } }) => {
    if (data.shared && !isAdmin) throw new Error('Only admins can remove the shared credential')
    await db
      .delete(mcpCredential)
      .where(
        and(
          eq(mcpCredential.orgId, orgId),
          eq(mcpCredential.mcpServerId, data.serverId),
          data.shared ? isNull(mcpCredential.userId) : eq(mcpCredential.userId, me.id),
        ),
      )
    await audit(db, {
      orgId,
      actorId: me.id,
      action: 'mcp.credential.remove',
      target: data.serverId,
      data: { shared: data.shared },
    })
    return { ok: true }
  })

export const refreshMcpTools = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ serverId: z.string() }))
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    const server = await db.query.mcpServer.findFirst({
      where: and(eq(mcpServer.id, data.serverId), eq(mcpServer.orgId, orgId)),
    })
    if (!server) throw new Error('Server not found')
    const tools = await refreshServerTools(env, db, server, me.id)
    return { count: tools.length }
  })

const STATS_DAYS = 7

/**
 * One MCP server with everything needed to control it tool by tool: its tools, which groups may
 * call each of them, the resources covering them, and the calls made through the gateway.
 */
export const getMcpServerDetail = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ serverId: z.string() }))
  .handler(async ({ data, context: { db, orgId } }) => {
    const server = await db.query.mcpServer.findFirst({
      where: and(eq(mcpServer.id, data.serverId), eq(mcpServer.orgId, orgId)),
    })
    if (!server) throw new Error('Server not found')
    const since = new Date(Date.now() - STATS_DAYS * 86_400_000)
    const calls = and(
      eq(event.orgId, orgId),
      eq(event.mcpServerId, server.id),
      eq(event.kind, 'tool_call'),
    )

    const [groups, resources, grants, stats, recent] = await Promise.all([
      db.query.group.findMany({
        where: eq(group.orgId, orgId),
        orderBy: [desc(group.isDefault), asc(group.name)],
      }),
      db.query.resource.findMany({
        where: eq(resource.orgId, orgId),
        orderBy: asc(resource.name),
      }),
      db
        .select({
          resourceId: resourceGrant.resourceId,
          type: resourceGrant.subjectType,
          id: resourceGrant.subjectId,
        })
        .from(resourceGrant)
        .innerJoin(resource, eq(resource.id, resourceGrant.resourceId))
        .where(eq(resource.orgId, orgId)),
      db
        .select({
          toolName: event.toolName,
          decision: event.decision,
          calls: count(),
          last: max(event.createdAt),
        })
        .from(event)
        .where(and(calls, gte(event.createdAt, since)))
        .groupBy(event.toolName, event.decision),
      db
        .select({
          id: event.id,
          toolName: event.toolName,
          decision: event.decision,
          latencyMs: event.latencyMs,
          createdAt: event.createdAt,
          userName: user.name,
          userEmail: user.email,
        })
        .from(event)
        .leftJoin(user, eq(user.id, event.userId))
        .where(calls)
        .orderBy(desc(event.seq))
        .limit(30),
    ])

    // Events store the name Claude Code saw, `<slug>__<tool>`.
    const bare = (name: string | null) => {
      const sep = name?.indexOf('__') ?? -1
      return name && sep > 0 ? name.slice(sep + 2) : (name ?? '')
    }
    const usage = new Map<string, { calls: number; blocked: number; last: Date | null }>()
    for (const row of stats) {
      const name = bare(row.toolName)
      const u = usage.get(name) ?? { calls: 0, blocked: 0, last: null }
      u.calls += row.calls
      if (!isAllowed(row.decision)) u.blocked += row.calls
      const last = row.last ? new Date(row.last) : null
      if (last && (!u.last || last > u.last)) u.last = last
      usage.set(name, u)
    }

    const tools = server.tools as { name: string; description?: string; annotations?: unknown }[]
    return {
      server: {
        id: server.id,
        name: server.name,
        slug: server.slug,
        url: server.url,
        enabled: server.enabled,
        toolsRefreshedAt: server.toolsRefreshedAt,
      },
      statsDays: STATS_DAYS,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        tier: toolTierFromAnnotations(t.annotations),
        usage: usage.get(t.name) ?? { calls: 0, blocked: 0, last: null },
      })),
      // Tools that were called but are no longer listed by the server.
      unlistedCalls: [...usage].filter(([name]) => !tools.some((t) => t.name === name)).length,
      groups: groups.map((g) => ({ id: g.id, name: g.name })),
      // Every resource is a column: ticking a tool adds this server to that bundle.
      resources: resources.map((r) => ({
        id: r.id,
        name: r.name,
        patterns: r.tools[server.id] ?? [],
        everyServer: r.tools['*'] ?? [],
        grants: grants.filter((g) => g.resourceId === r.id).map(({ type, id }) => ({ type, id })),
      })),
      recent: recent.map((r) => ({ ...r, toolName: bare(r.toolName) })),
    }
  })

function isAllowed(decision: Decision) {
  return decision === 'allow' || decision === 'approved'
}
