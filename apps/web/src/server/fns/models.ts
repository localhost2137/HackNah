import { model } from '@acl/db'
import { encryptString, modelEntry, modelKeyAad, randomId } from '@acl/shared'
import { createServerFn } from '@tanstack/react-start'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { audit } from '../audit.ts'
import { env } from '../env.ts'
import { adminMiddleware, orgMiddleware } from '../middleware.ts'

/** The model catalog without API keys; `hasApiKey` says whether one is stored. */
export const listModels = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .handler(async ({ context: { db, orgId } }) => {
    const rows = await db.query.model.findMany({
      where: eq(model.orgId, orgId),
      orderBy: [asc(model.position), asc(model.createdAt)],
    })
    return rows.map(({ apiKeyEnc, ...m }) => ({ ...m, hasApiKey: apiKeyEnc !== null }))
  })

const modelInput = modelEntry.omit({ id: true }).extend({
  id: z.string().optional(),
  /** A new key; empty keeps the stored one, null removes it. */
  apiKey: z.string().nullable().optional(),
})

export const saveModel = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(modelInput)
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    const { id: given, apiKey, ...values } = data
    if (values.baseUrl && !/^https?:\/\//.test(values.baseUrl))
      throw new Error('The base URL must start with http:// or https://')
    const id = given ?? randomId('mdl')
    const key =
      apiKey === null
        ? { apiKeyEnc: null }
        : apiKey
          ? { apiKeyEnc: await encryptString(env.ENCRYPTION_KEY, apiKey, modelKeyAad(id)) }
          : {}
    if (given) {
      const [row] = await db
        .update(model)
        .set({ ...values, ...key })
        .where(and(eq(model.id, given), eq(model.orgId, orgId)))
        .returning({ id: model.id })
      if (!row) throw new Error('Model not found')
    } else {
      const position = (await db.query.model.findMany({ where: eq(model.orgId, orgId) })).length
      await db.insert(model).values({ id, orgId, position, ...values, ...key })
    }
    await audit(db, {
      orgId,
      actorId: me.id,
      action: given ? 'model.update' : 'model.create',
      target: id,
      data: values,
    })
    return { id }
  })

export const deleteModel = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ id: z.string() }))
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    await db.delete(model).where(and(eq(model.id, data.id), eq(model.orgId, orgId)))
    await audit(db, { orgId, actorId: me.id, action: 'model.delete', target: data.id })
    return { ok: true }
  })

/** Saves the routing order: the first entry that matches a model id wins. */
export const reorderModels = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ ids: z.array(z.string()).max(200) }))
  .handler(async ({ data, context: { db, orgId } }) => {
    await Promise.all(
      data.ids.map((id, position) =>
        db
          .update(model)
          .set({ position })
          .where(and(eq(model.id, id), eq(model.orgId, orgId))),
      ),
    )
    return { ok: true }
  })
