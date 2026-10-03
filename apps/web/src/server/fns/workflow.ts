import { user, workflowVersion } from '@acl/db'
import { defaultWorkflow, policyGraph, randomId, validateGraph } from '@acl/shared'
import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { audit } from '../audit.ts'
import { adminMiddleware, orgMiddleware } from '../middleware.ts'

/** Versions saved before the graph editor hold the old linear format; start those from the default. */
function parseOrDefault(definition: unknown) {
  const parsed = policyGraph.safeParse(definition)
  return parsed.success ? parsed.data : defaultWorkflow
}

export const getWorkflow = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .handler(async ({ context: { db, orgId } }) => {
    const versions = await db
      .select({
        id: workflowVersion.id,
        version: workflowVersion.version,
        status: workflowVersion.status,
        note: workflowVersion.note,
        definition: workflowVersion.definition,
        createdAt: workflowVersion.createdAt,
        createdBy: user.name,
      })
      .from(workflowVersion)
      .leftJoin(user, eq(user.id, workflowVersion.createdBy))
      .where(eq(workflowVersion.orgId, orgId))
      .orderBy(desc(workflowVersion.version))
      .limit(30)
    const published = versions.find((v) => v.status === 'published') ?? null
    const draft = versions[0]?.status === 'draft' ? versions[0] : null
    return {
      published,
      draft,
      versions,
      /** What the editor starts from. */
      working: parseOrDefault(draft?.definition ?? published?.definition),
    }
  })

export const saveDraft = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ definition: policyGraph }))
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    const latest = await db.query.workflowVersion.findFirst({
      where: eq(workflowVersion.orgId, orgId),
      orderBy: desc(workflowVersion.version),
    })
    if (latest?.status === 'draft') {
      await db
        .update(workflowVersion)
        .set({ definition: data.definition, createdBy: me.id, createdAt: new Date() })
        .where(eq(workflowVersion.id, latest.id))
      return { version: latest.version }
    }
    const version = (latest?.version ?? 0) + 1
    await db.insert(workflowVersion).values({
      id: randomId('wf'),
      orgId,
      version,
      definition: data.definition,
      status: 'draft',
      createdBy: me.id,
    })
    return { version }
  })

export const publishDraft = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ note: z.string().max(500).optional() }))
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    const draft = await db.query.workflowVersion.findFirst({
      where: and(eq(workflowVersion.orgId, orgId), eq(workflowVersion.status, 'draft')),
    })
    if (!draft) throw new Error('There is no draft to publish')
    const parsed = policyGraph.safeParse(draft.definition)
    if (!parsed.success) throw new Error('The draft is not a valid workflow')
    const error = validateGraph(parsed.data).find((i) => i.level === 'error')
    if (error) throw new Error(`Fix the workflow before publishing: ${error.message}`)
    const [row] = await db
      .update(workflowVersion)
      .set({ status: 'published', note: data.note ?? null, createdBy: me.id })
      .where(and(eq(workflowVersion.orgId, orgId), eq(workflowVersion.status, 'draft')))
      .returning()
    if (!row) throw new Error('There is no draft to publish')
    await audit(db, {
      orgId,
      actorId: me.id,
      action: 'workflow.publish',
      target: String(row.version),
      data: { note: data.note },
    })
    return { version: row.version }
  })

export const discardDraft = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .handler(async ({ context: { db, orgId } }) => {
    await db
      .delete(workflowVersion)
      .where(and(eq(workflowVersion.orgId, orgId), eq(workflowVersion.status, 'draft')))
    return { ok: true }
  })
