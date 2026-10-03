import { auditLog, user } from '@acl/db'
import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, lt } from 'drizzle-orm'
import { z } from 'zod'
import { env } from '../env.ts'
import { adminMiddleware } from '../middleware.ts'

export const getConnectInfo = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async () => ({
    gatewayUrl: env.PUBLIC_URL.replace(/\/$/, ''),
    dashboardUrl: env.PUBLIC_URL.replace(/\/$/, ''),
  }))

const PAGE = 50

export const listAuditLog = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ cursor: z.number().optional() }))
  .handler(async ({ data, context: { db, orgId } }) => {
    const rows = await db
      .select({
        seq: auditLog.seq,
        action: auditLog.action,
        target: auditLog.target,
        data: auditLog.data,
        createdAt: auditLog.createdAt,
        actorName: user.name,
        actorEmail: user.email,
      })
      .from(auditLog)
      .leftJoin(user, eq(user.id, auditLog.actorId))
      .where(
        and(eq(auditLog.orgId, orgId), data.cursor ? lt(auditLog.seq, data.cursor) : undefined),
      )
      .orderBy(desc(auditLog.seq))
      .limit(PAGE + 1)
    return {
      items: rows
        .slice(0, PAGE)
        .map((r) => ({ ...r, data: r.data ? JSON.stringify(r.data) : null })),
      nextCursor: rows.length > PAGE ? rows[PAGE - 1]!.seq : null,
    }
  })
