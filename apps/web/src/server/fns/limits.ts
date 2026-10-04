import { rateLimit } from '@acl/db'
import { limitCounterKey, limitRule, limitRuleIssue, randomId, usageMeasures } from '@acl/shared'
import { createServerFn } from '@tanstack/react-start'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { audit } from '../audit.ts'
import { env } from '../env.ts'
import { adminMiddleware } from '../middleware.ts'

export const listLimits = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(({ context: { db, orgId } }) =>
    db.query.rateLimit.findMany({
      where: eq(rateLimit.orgId, orgId),
      orderBy: asc(rateLimit.createdAt),
    }),
  )

const limitInput = limitRule
  .omit({ id: true })
  .extend({ id: z.string().optional(), enabled: z.boolean().default(true) })

export const saveLimit = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(limitInput)
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    const issue = limitRuleIssue(data)
    if (issue) throw new Error(issue)
    const values = {
      name: data.name,
      measure: data.measure,
      scope: data.scope,
      target: data.target,
      limit: data.limit,
      windowSec: data.windowSec,
      per: data.per,
      groupId: data.per === 'group_member' || data.per === 'group_total' ? data.groupId : null,
      action: data.action,
      warnAtPct: data.warnAtPct,
      enabled: data.enabled,
    }
    let id = data.id
    if (id) {
      const [row] = await db
        .update(rateLimit)
        .set(values)
        .where(and(eq(rateLimit.id, id), eq(rateLimit.orgId, orgId)))
        .returning({ id: rateLimit.id })
      if (!row) throw new Error('Limit not found')
    } else {
      id = randomId('lim')
      await db.insert(rateLimit).values({ id, orgId, ...values })
    }
    await audit(db, {
      orgId,
      actorId: me.id,
      action: data.id ? 'limit.update' : 'limit.create',
      target: id,
      data: values,
    })
    return { id }
  })

export const deleteLimit = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ id: z.string() }))
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    await db.delete(rateLimit).where(and(eq(rateLimit.id, data.id), eq(rateLimit.orgId, orgId)))
    await audit(db, { orgId, actorId: me.id, action: 'limit.delete', target: data.id })
    return { ok: true }
  })

/**
 * Current usage of budgets with one shared counter: a group in total or the whole org. Budgets
 * counted per user have a counter per person; the Overview shows who spends most.
 */
export const limitUsage = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async ({ context: { db, orgId } }) => {
    const rules = await db.query.rateLimit.findMany({
      where: and(eq(rateLimit.orgId, orgId), eq(rateLimit.enabled, true)),
    })
    const shared = rules.filter(
      (r) =>
        usageMeasures.includes(r.measure) &&
        (r.per === 'org' || r.per === 'group_total') &&
        (r.scope === 'model' || r.scope === 'guardrails'),
    )
    const readings = await Promise.all(
      shared.map(async (r) => {
        const key = limitCounterKey(
          { ...r, groupId: r.groupId ?? null },
          { scope: r.scope as 'model', model: r.target },
          { orgId, userId: '', groupIds: r.groupId ? [r.groupId] : [] },
        )
        const reading = await env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key)).peek(
          r.windowSec,
        )
        return [r.id, reading.used] as const
      }),
    )
    return Object.fromEntries(readings) as Record<string, number>
  })
