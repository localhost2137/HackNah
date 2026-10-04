import { type Db, group, user, workflow, workflowVersion } from '@acl/db'
import { defaultWorkflow, policyGraph, randomId, starterWorkflow, validateGraph } from '@acl/shared'
import { and, asc, desc, eq, inArray, max } from 'drizzle-orm'
import { z } from 'zod'
import { audit } from './audit.ts'

/** Versions saved before the graph editor hold the old linear format; start those from the default. */
function parseOrDefault(definition: unknown) {
  const parsed = policyGraph.safeParse(definition)
  return parsed.success ? parsed.data : defaultWorkflow
}

export async function findWorkflow(db: Db, orgId: string, id: string) {
  const row = await db.query.workflow.findFirst({
    where: and(eq(workflow.id, id), eq(workflow.orgId, orgId)),
  })
  if (!row) throw new Error('Workflow not found')
  return row
}

/** Reject invalid scopes instead of accidentally widening a workflow to every group. */
async function ownGroups(db: Db, orgId: string, ids: string[]) {
  if (ids.length === 0) return []
  const rows = await db
    .select({ id: group.id })
    .from(group)
    .where(and(eq(group.orgId, orgId), inArray(group.id, ids)))
  const known = new Set(rows.map((r) => r.id))
  if (ids.some((id) => !known.has(id))) throw new Error('Group not found in this instance')
  return [...new Set(ids)]
}

const workflowId = z.object({ workflowId: z.string() })

export type PlatformContext = { db: Db; orgId: string; user: { id: string } }

export const createWorkflowInput = z.object({
  name: z.string().trim().min(1).max(80),
  copyOf: z.string().optional(),
})

export const updateWorkflowInput = workflowId.extend({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(500).nullable().optional(),
  enabled: z.boolean().optional(),
  groupIds: z.array(z.string()).max(100).optional(),
})

export const reorderWorkflowsInput = z.object({ ids: z.array(z.string()).max(200) })

export const deleteWorkflowInput = workflowId

export const getWorkflowInput = workflowId

export const saveDraftInput = workflowId.extend({ definition: policyGraph })

export const publishDraftInput = workflowId.extend({ note: z.string().max(500).optional() })

export const discardDraftInput = workflowId

export async function listWorkflowsService({
  context: { db, orgId },
}: {
  context: PlatformContext
}) {
  const [workflows, versions] = await Promise.all([
    db.query.workflow.findMany({
      where: eq(workflow.orgId, orgId),
      orderBy: [asc(workflow.position), asc(workflow.createdAt)],
    }),
    db
      .select({
        workflowId: workflowVersion.workflowId,
        version: workflowVersion.version,
        status: workflowVersion.status,
        definition: workflowVersion.definition,
        createdAt: workflowVersion.createdAt,
      })
      .from(workflowVersion)
      .where(eq(workflowVersion.orgId, orgId))
      .orderBy(desc(workflowVersion.version)),
  ])
  return workflows.map((w) => {
    const own = versions.filter((v) => v.workflowId === w.id)
    const published = own.find((v) => v.status === 'published') ?? null
    const draft = own[0]?.status === 'draft' ? own[0] : null
    return {
      ...w,
      published: published
        ? { version: published.version, definition: parseOrDefault(published.definition) }
        : null,
      draftVersion: draft?.version ?? null,
      /** What the trigger column describes: the live graph, else the draft. */
      definition: parseOrDefault(published?.definition ?? draft?.definition ?? starterWorkflow),
    }
  })
}

export async function createWorkflowService({
  data,
  context: { db, orgId, user: me },
}: {
  data: z.infer<typeof createWorkflowInput>
  context: PlatformContext
}) {
  let definition = starterWorkflow
  let groupIds: string[] = []
  if (data.copyOf) {
    const source = await findWorkflow(db, orgId, data.copyOf)
    const latest = await db.query.workflowVersion.findFirst({
      where: eq(workflowVersion.workflowId, source.id),
      orderBy: desc(workflowVersion.version),
    })
    definition = parseOrDefault(latest?.definition ?? starterWorkflow)
    groupIds = source.groupIds
  }
  const [last] = await db
    .select({ position: max(workflow.position) })
    .from(workflow)
    .where(eq(workflow.orgId, orgId))
  const id = randomId('wf')
  await db.insert(workflow).values({
    id,
    orgId,
    name: data.name,
    position: (last?.position ?? -1) + 1,
    groupIds,
  })
  await db.insert(workflowVersion).values({
    id: randomId('wfv'),
    orgId,
    workflowId: id,
    version: 1,
    definition,
    status: 'draft',
    createdBy: me.id,
  })
  await audit(db, { orgId, actorId: me.id, action: 'workflow.create', target: id, data })
  return { id }
}

export async function updateWorkflowService({
  data,
  context: { db, orgId, user: me },
}: {
  data: z.infer<typeof updateWorkflowInput>
  context: PlatformContext
}) {
  await findWorkflow(db, orgId, data.workflowId)
  const { workflowId: id, ...patch } = data
  if (patch.groupIds) patch.groupIds = await ownGroups(db, orgId, patch.groupIds)
  await db
    .update(workflow)
    .set(patch)
    .where(and(eq(workflow.id, id), eq(workflow.orgId, orgId)))
  await audit(db, { orgId, actorId: me.id, action: 'workflow.update', target: id, data: patch })
  return { ok: true }
}

export async function reorderWorkflowsService({
  data,
  context: { db, orgId, user: me },
}: {
  data: z.infer<typeof reorderWorkflowsInput>
  context: PlatformContext
}) {
  for (const [position, id] of data.ids.entries()) {
    await db
      .update(workflow)
      .set({ position })
      .where(and(eq(workflow.id, id), eq(workflow.orgId, orgId)))
  }
  await audit(db, { orgId, actorId: me.id, action: 'workflow.reorder', data })
  return { ok: true }
}

export async function deleteWorkflowService({
  data,
  context: { db, orgId, user: me },
}: {
  data: z.infer<typeof deleteWorkflowInput>
  context: PlatformContext
}) {
  await db.delete(workflow).where(and(eq(workflow.id, data.workflowId), eq(workflow.orgId, orgId)))
  await audit(db, { orgId, actorId: me.id, action: 'workflow.delete', target: data.workflowId })
  return { ok: true }
}

export async function getWorkflowService({
  data,
  context: { db, orgId },
}: {
  data: z.infer<typeof getWorkflowInput>
  context: PlatformContext
}) {
  const meta = await findWorkflow(db, orgId, data.workflowId)
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
    .where(eq(workflowVersion.workflowId, meta.id))
    .orderBy(desc(workflowVersion.version))
    .limit(30)
  const published = versions.find((v) => v.status === 'published') ?? null
  const draft = versions[0]?.status === 'draft' ? versions[0] : null
  return {
    workflow: meta,
    published,
    draft,
    versions,
    /** What the editor starts from. */
    working: parseOrDefault(draft?.definition ?? published?.definition ?? starterWorkflow),
  }
}

export async function saveDraftService({
  data,
  context: { db, orgId, user: me },
}: {
  data: z.infer<typeof saveDraftInput>
  context: PlatformContext
}) {
  await findWorkflow(db, orgId, data.workflowId)
  const latest = await db.query.workflowVersion.findFirst({
    where: eq(workflowVersion.workflowId, data.workflowId),
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
    id: randomId('wfv'),
    orgId,
    workflowId: data.workflowId,
    version,
    definition: data.definition,
    status: 'draft',
    createdBy: me.id,
  })
  return { version }
}

export async function publishDraftService({
  data,
  context: { db, orgId, user: me },
}: {
  data: z.infer<typeof publishDraftInput>
  context: PlatformContext
}) {
  await findWorkflow(db, orgId, data.workflowId)
  const isDraft = and(
    eq(workflowVersion.workflowId, data.workflowId),
    eq(workflowVersion.status, 'draft'),
  )
  const draft = await db.query.workflowVersion.findFirst({ where: isDraft })
  if (!draft) throw new Error('There is no draft to publish')
  const parsed = policyGraph.safeParse(draft.definition)
  if (!parsed.success) throw new Error('The draft is not a valid workflow')
  const error = validateGraph(parsed.data).find((i) => i.level === 'error')
  if (error) throw new Error(`Fix the guardrail before publishing: ${error.message}`)
  const [row] = await db
    .update(workflowVersion)
    .set({ status: 'published', note: data.note ?? null, createdBy: me.id })
    .where(isDraft)
    .returning()
  if (!row) throw new Error('There is no draft to publish')
  await audit(db, {
    orgId,
    actorId: me.id,
    action: 'workflow.publish',
    target: `${data.workflowId}@${row.version}`,
    data: { note: data.note },
  })
  return { version: row.version }
}

export async function discardDraftService({
  data,
  context: { db, orgId },
}: {
  data: z.infer<typeof discardDraftInput>
  context: PlatformContext
}) {
  await db
    .delete(workflowVersion)
    .where(
      and(
        eq(workflowVersion.orgId, orgId),
        eq(workflowVersion.workflowId, data.workflowId),
        eq(workflowVersion.status, 'draft'),
      ),
    )
  return { ok: true }
}
