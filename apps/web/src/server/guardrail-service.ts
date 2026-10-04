import { type Db, group, guardrail, guardrailVersion, user } from '@acl/db'
import {
  defaultGuardrail,
  policyGraph,
  randomId,
  starterGuardrail,
  validateGraph,
} from '@acl/shared'
import { and, asc, desc, eq, inArray, max } from 'drizzle-orm'
import { z } from 'zod'
import { audit } from './audit.ts'

/** Versions saved before the graph editor hold the old linear format; start those from the default. */
function parseOrDefault(definition: unknown) {
  const parsed = policyGraph.safeParse(definition)
  return parsed.success ? parsed.data : defaultGuardrail
}

export async function findGuardrail(db: Db, orgId: string, id: string) {
  const row = await db.query.guardrail.findFirst({
    where: and(eq(guardrail.id, id), eq(guardrail.orgId, orgId)),
  })
  if (!row) throw new Error('Guardrail not found')
  return row
}

/** Reject invalid scopes instead of accidentally widening a guardrail to every group. */
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

const guardrailId = z.object({ guardrailId: z.string() })

export type PlatformContext = { db: Db; orgId: string; user: { id: string } }

export const createGuardrailInput = z.object({
  name: z.string().trim().min(1).max(80),
  copyOf: z.string().optional(),
})

export const updateGuardrailInput = guardrailId.extend({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(500).nullable().optional(),
  enabled: z.boolean().optional(),
  groupIds: z.array(z.string()).max(100).optional(),
})

export const reorderGuardrailsInput = z.object({ ids: z.array(z.string()).max(200) })

export const deleteGuardrailInput = guardrailId

export const getGuardrailInput = guardrailId

export const saveDraftInput = guardrailId.extend({ definition: policyGraph })

export const publishDraftInput = guardrailId.extend({ note: z.string().max(500).optional() })

export const discardDraftInput = guardrailId

export async function listGuardrailsService({
  context: { db, orgId },
}: {
  context: PlatformContext
}) {
  const [guardrails, versions] = await Promise.all([
    db.query.guardrail.findMany({
      where: eq(guardrail.orgId, orgId),
      orderBy: [asc(guardrail.position), asc(guardrail.createdAt)],
    }),
    db
      .select({
        guardrailId: guardrailVersion.guardrailId,
        version: guardrailVersion.version,
        status: guardrailVersion.status,
        definition: guardrailVersion.definition,
        createdAt: guardrailVersion.createdAt,
      })
      .from(guardrailVersion)
      .where(eq(guardrailVersion.orgId, orgId))
      .orderBy(desc(guardrailVersion.version)),
  ])
  return guardrails.map((w) => {
    const own = versions.filter((v) => v.guardrailId === w.id)
    const published = own.find((v) => v.status === 'published') ?? null
    const draft = own[0]?.status === 'draft' ? own[0] : null
    return {
      ...w,
      published: published
        ? { version: published.version, definition: parseOrDefault(published.definition) }
        : null,
      draftVersion: draft?.version ?? null,
      /** What the trigger column describes: the live graph, else the draft. */
      definition: parseOrDefault(published?.definition ?? draft?.definition ?? starterGuardrail),
    }
  })
}

export async function createGuardrailService({
  data,
  context: { db, orgId, user: me },
}: {
  data: z.infer<typeof createGuardrailInput>
  context: PlatformContext
}) {
  let definition = starterGuardrail
  let groupIds: string[] = []
  if (data.copyOf) {
    const source = await findGuardrail(db, orgId, data.copyOf)
    const latest = await db.query.guardrailVersion.findFirst({
      where: eq(guardrailVersion.guardrailId, source.id),
      orderBy: desc(guardrailVersion.version),
    })
    definition = parseOrDefault(latest?.definition ?? starterGuardrail)
    groupIds = source.groupIds
  }
  const [last] = await db
    .select({ position: max(guardrail.position) })
    .from(guardrail)
    .where(eq(guardrail.orgId, orgId))
  const id = randomId('wf')
  await db.insert(guardrail).values({
    id,
    orgId,
    name: data.name,
    position: (last?.position ?? -1) + 1,
    groupIds,
  })
  await db.insert(guardrailVersion).values({
    id: randomId('wfv'),
    orgId,
    guardrailId: id,
    version: 1,
    definition,
    status: 'draft',
    createdBy: me.id,
  })
  await audit(db, { orgId, actorId: me.id, action: 'guardrail.create', target: id, data })
  return { id }
}

export async function updateGuardrailService({
  data,
  context: { db, orgId, user: me },
}: {
  data: z.infer<typeof updateGuardrailInput>
  context: PlatformContext
}) {
  await findGuardrail(db, orgId, data.guardrailId)
  const { guardrailId: id, ...patch } = data
  if (patch.groupIds) patch.groupIds = await ownGroups(db, orgId, patch.groupIds)
  await db
    .update(guardrail)
    .set(patch)
    .where(and(eq(guardrail.id, id), eq(guardrail.orgId, orgId)))
  await audit(db, { orgId, actorId: me.id, action: 'guardrail.update', target: id, data: patch })
  return { ok: true }
}

export async function reorderGuardrailsService({
  data,
  context: { db, orgId, user: me },
}: {
  data: z.infer<typeof reorderGuardrailsInput>
  context: PlatformContext
}) {
  for (const [position, id] of data.ids.entries()) {
    await db
      .update(guardrail)
      .set({ position })
      .where(and(eq(guardrail.id, id), eq(guardrail.orgId, orgId)))
  }
  await audit(db, { orgId, actorId: me.id, action: 'guardrail.reorder', data })
  return { ok: true }
}

export async function deleteGuardrailService({
  data,
  context: { db, orgId, user: me },
}: {
  data: z.infer<typeof deleteGuardrailInput>
  context: PlatformContext
}) {
  await db
    .delete(guardrail)
    .where(and(eq(guardrail.id, data.guardrailId), eq(guardrail.orgId, orgId)))
  await audit(db, { orgId, actorId: me.id, action: 'guardrail.delete', target: data.guardrailId })
  return { ok: true }
}

export async function getGuardrailService({
  data,
  context: { db, orgId },
}: {
  data: z.infer<typeof getGuardrailInput>
  context: PlatformContext
}) {
  const meta = await findGuardrail(db, orgId, data.guardrailId)
  const versions = await db
    .select({
      id: guardrailVersion.id,
      version: guardrailVersion.version,
      status: guardrailVersion.status,
      note: guardrailVersion.note,
      definition: guardrailVersion.definition,
      createdAt: guardrailVersion.createdAt,
      createdBy: user.name,
    })
    .from(guardrailVersion)
    .leftJoin(user, eq(user.id, guardrailVersion.createdBy))
    .where(eq(guardrailVersion.guardrailId, meta.id))
    .orderBy(desc(guardrailVersion.version))
    .limit(30)
  const published = versions.find((v) => v.status === 'published') ?? null
  const draft = versions[0]?.status === 'draft' ? versions[0] : null
  return {
    guardrail: meta,
    published,
    draft,
    versions,
    /** What the editor starts from. */
    working: parseOrDefault(draft?.definition ?? published?.definition ?? starterGuardrail),
  }
}

export async function saveDraftService({
  data,
  context: { db, orgId, user: me },
}: {
  data: z.infer<typeof saveDraftInput>
  context: PlatformContext
}) {
  await findGuardrail(db, orgId, data.guardrailId)
  const latest = await db.query.guardrailVersion.findFirst({
    where: eq(guardrailVersion.guardrailId, data.guardrailId),
    orderBy: desc(guardrailVersion.version),
  })
  if (latest?.status === 'draft') {
    await db
      .update(guardrailVersion)
      .set({ definition: data.definition, createdBy: me.id, createdAt: new Date() })
      .where(eq(guardrailVersion.id, latest.id))
    return { version: latest.version }
  }
  const version = (latest?.version ?? 0) + 1
  await db.insert(guardrailVersion).values({
    id: randomId('wfv'),
    orgId,
    guardrailId: data.guardrailId,
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
  await findGuardrail(db, orgId, data.guardrailId)
  const isDraft = and(
    eq(guardrailVersion.guardrailId, data.guardrailId),
    eq(guardrailVersion.status, 'draft'),
  )
  const draft = await db.query.guardrailVersion.findFirst({ where: isDraft })
  if (!draft) throw new Error('There is no draft to publish')
  const parsed = policyGraph.safeParse(draft.definition)
  if (!parsed.success) throw new Error('The draft is not a valid guardrail')
  const error = validateGraph(parsed.data).find((i) => i.level === 'error')
  if (error) throw new Error(`Fix the guardrail before publishing: ${error.message}`)
  const [row] = await db
    .update(guardrailVersion)
    .set({ status: 'published', note: data.note ?? null, createdBy: me.id })
    .where(isDraft)
    .returning()
  if (!row) throw new Error('There is no draft to publish')
  await audit(db, {
    orgId,
    actorId: me.id,
    action: 'guardrail.publish',
    target: `${data.guardrailId}@${row.version}`,
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
    .delete(guardrailVersion)
    .where(
      and(
        eq(guardrailVersion.orgId, orgId),
        eq(guardrailVersion.guardrailId, data.guardrailId),
        eq(guardrailVersion.status, 'draft'),
      ),
    )
  return { ok: true }
}
