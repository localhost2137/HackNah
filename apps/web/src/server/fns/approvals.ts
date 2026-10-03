import { approval, device, user } from '@acl/db'
import { createServerFn } from '@tanstack/react-start'
import { aliasedTable, and, desc, eq, gt, ne } from 'drizzle-orm'
import { z } from 'zod'
import { decideApproval as decide } from '#/gateway/control.ts'
import { env } from '../env.ts'
import { adminMiddleware } from '../middleware.ts'

export const listApprovals = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ status: z.enum(['pending', 'history']) }))
  .handler(async ({ data, context: { db, orgId } }) => {
    const decider = aliasedTable(user, 'decider')
    return db
      .select({
        approval,
        userName: user.name,
        userEmail: user.email,
        deviceLabel: device.label,
        deviceIp: device.firstSeenIp,
        deviceCountry: device.firstSeenCountry,
        decidedByName: decider.name,
      })
      .from(approval)
      .leftJoin(user, eq(user.id, approval.userId))
      .leftJoin(device, eq(device.id, approval.deviceId))
      .leftJoin(decider, eq(decider.id, approval.decidedBy))
      .where(
        and(
          eq(approval.orgId, orgId),
          data.status === 'pending'
            ? and(eq(approval.status, 'pending'), gt(approval.expiresAt, new Date()))
            : ne(approval.status, 'pending'),
        ),
      )
      .orderBy(desc(approval.createdAt))
      .limit(100)
  })

export const decideApproval = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ id: z.string(), status: z.enum(['approved', 'declined']) }))
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    const res = await decide(env, db, {
      orgId,
      approvalId: data.id,
      status: data.status,
      decidedBy: me.id,
    })
    return { ok: true, ...res }
  })
