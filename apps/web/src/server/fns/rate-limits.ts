import { rateLimit } from '@acl/db'
import { randomId, rateLimitRule } from '@acl/shared'
import { createServerFn } from '@tanstack/react-start'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { audit } from '../audit.ts'
import { adminMiddleware, orgMiddleware } from '../middleware.ts'

export const listRateLimits = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .handler(({ context: { db, orgId } }) =>
    db.query.rateLimit.findMany({
      where: eq(rateLimit.orgId, orgId),
      orderBy: asc(rateLimit.createdAt),
    }),
  )

export const saveRateLimit = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(
    rateLimitRule.extend({ id: z.string().optional(), enabled: z.boolean().default(true) }),
  )
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    const values = {
      scope: data.scope,
      target: data.target,
      limit: data.limit,
      windowSec: data.windowSec,
      per: data.per,
      enabled: data.enabled,
    }
    let id = data.id
    if (id) {
      const [row] = await db
        .update(rateLimit)
        .set(values)
        .where(and(eq(rateLimit.id, id), eq(rateLimit.orgId, orgId)))
        .returning({ id: rateLimit.id })
      if (!row) throw new Error('Rule not found')
    } else {
      id = randomId('rl')
      await db.insert(rateLimit).values({ id, orgId, ...values })
    }
    await audit(db, {
      orgId,
      actorId: me.id,
      action: data.id ? 'ratelimit.update' : 'ratelimit.create',
      target: id,
      data: values,
    })
    return { id }
  })

export const deleteRateLimit = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ id: z.string() }))
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    await db.delete(rateLimit).where(and(eq(rateLimit.id, data.id), eq(rateLimit.orgId, orgId)))
    await audit(db, { orgId, actorId: me.id, action: 'ratelimit.delete', target: data.id })
    return { ok: true }
  })
