import { type Db, group, model, rateLimit, workflow, workflowVersion } from '@acl/db'
import {
  canonicalJson,
  diffPolicy,
  graphLogic,
  groupNameOf,
  limitKey,
  mapLimitRefs,
  type PolicyChange,
  type PolicyFile,
  type PolicyGraph,
  type PolicyState,
  parsePolicyYaml,
  policyGraph,
  policyToYaml,
  randomId,
  resolveGroups,
  toPolicyFile,
} from '@acl/shared'
import { and, asc, desc, eq } from 'drizzle-orm'
import { audit } from './audit.ts'

/**
 * Export and import of the instance's policy file (workflows, limits, model catalog). Used by the
 * Settings page and by `pnpm policy:export` / `pnpm policy:apply` through `/api/policy`.
 */

async function policyState(db: Db, orgId: string): Promise<PolicyState> {
  const [groups, workflows, versions, limits, models] = await Promise.all([
    db.query.group.findMany({ where: eq(group.orgId, orgId) }),
    db.query.workflow.findMany({
      where: eq(workflow.orgId, orgId),
      orderBy: [asc(workflow.position), asc(workflow.createdAt)],
    }),
    db
      .select({
        workflowId: workflowVersion.workflowId,
        status: workflowVersion.status,
        definition: workflowVersion.definition,
      })
      .from(workflowVersion)
      .where(and(eq(workflowVersion.orgId, orgId), eq(workflowVersion.status, 'published')))
      .orderBy(desc(workflowVersion.version)),
    db.query.rateLimit.findMany({
      where: eq(rateLimit.orgId, orgId),
      orderBy: asc(rateLimit.createdAt),
    }),
    db.query.model.findMany({
      where: eq(model.orgId, orgId),
      orderBy: [asc(model.position), asc(model.createdAt)],
    }),
  ])
  return {
    groups: groups.map((g) => ({ id: g.id, name: g.name, isDefault: g.isDefault })),
    workflows: workflows.map((w) => {
      const published = versions.find((v) => v.workflowId === w.id)
      const parsed = published ? policyGraph.safeParse(published.definition) : null
      return {
        name: w.name,
        description: w.description,
        enabled: w.enabled,
        groupIds: w.groupIds,
        definition: parsed?.success ? parsed.data : null,
      }
    }),
    limits: limits.map((l) => ({
      id: l.id,
      name: l.name,
      measure: l.measure,
      scope: l.scope,
      target: l.target,
      limit: l.limit,
      windowSec: l.windowSec,
      per: l.per,
      groupId: l.groupId,
      group: null,
      action: l.action,
      warnAtPct: l.warnAtPct,
      enabled: l.enabled,
    })),
    models: models.map((m) => ({
      pattern: m.pattern,
      label: m.label,
      kind: m.kind,
      apiFormat: m.apiFormat,
      baseUrl: m.baseUrl,
      upstreamModel: m.upstreamModel,
      inputUsdPerMTok: m.inputUsdPerMTok,
      outputUsdPerMTok: m.outputUsdPerMTok,
      cacheWriteUsdPerMTok: m.cacheWriteUsdPerMTok,
      cacheReadUsdPerMTok: m.cacheReadUsdPerMTok,
      gpuUsdPerHour: m.gpuUsdPerHour,
      enabled: m.enabled,
    })),
  }
}

export async function exportPolicyYaml(db: Db, orgId: string): Promise<string> {
  return policyToYaml(toPolicyFile(await policyState(db, orgId)))
}

export type ImportResult =
  | { ok: true; applied: boolean; changes: PolicyChange[] }
  | { ok: false; errors: string[] }

/**
 * Validates a policy file and, unless `dryRun`, applies it. Nothing is written when the file has
 * any error. Limits go first so Usage limit blocks can point at their ids; a workflow whose
 * graph changed gets a new published version (an unpublished draft is replaced by it).
 */
export async function importPolicyYaml(
  db: Db,
  orgId: string,
  actorId: string,
  yaml: string,
  opts: { mode: 'replace' | 'merge'; dryRun: boolean },
): Promise<ImportResult> {
  const parsed = parsePolicyYaml(yaml)
  if (!parsed.ok) return parsed
  const file = parsed.file
  const state = await policyState(db, orgId)
  const groups = resolveGroups(state.groups, file)
  if (groups.unknown.length)
    return {
      ok: false,
      errors: groups.unknown.map((name) => {
        const where = [
          ...file.workflows.flatMap((w, i) => (w.groups.includes(name) ? [`workflows[${i}]`] : [])),
          ...file.limits.flatMap((l, i) => (l.group === name ? [`limits[${i}]`] : [])),
        ]
        return `${where.join(', ')}: no group named "${name}". Create it on the Groups page or use "All members".`
      }),
    }
  const current = toPolicyFile(state)
  const changes = diffPolicy(current, file, opts.mode)
  if (opts.dryRun) return { ok: true, applied: false, changes }

  const limitIds = await applyLimits(db, orgId, file, state.groups, groups.ids, opts.mode)
  await applyModels(db, orgId, file, opts.mode)
  await applyWorkflows(db, orgId, actorId, file, groups.ids, limitIds, opts.mode)

  const count = (action: PolicyChange['action']) =>
    changes.filter((c) => c.action === action).length
  await audit(db, {
    orgId,
    actorId,
    action: 'policy.import',
    data: {
      mode: opts.mode,
      created: count('create'),
      updated: count('update'),
      disabled: count('disable'),
      changes: changes.filter((c) => c.action !== 'unchanged'),
    },
  })
  return { ok: true, applied: true, changes }
}

async function applyLimits(
  db: Db,
  orgId: string,
  file: PolicyFile,
  groups: PolicyState['groups'],
  groupIds: Map<string, string>,
  mode: 'replace' | 'merge',
): Promise<Map<string, string>> {
  const rows = await db.query.rateLimit.findMany({ where: eq(rateLimit.orgId, orgId) })
  const names = new Map<string, string>(
    rows.map((r) => [limitKey({ ...r, group: groupNameOf(groups, r.groupId) }), r.id]),
  )
  const ids = new Map<string, string>()
  for (const l of file.limits) {
    const { group: groupName, ...rest } = l
    const values = { ...rest, groupId: groupName ? (groupIds.get(groupName) ?? null) : null }
    const key = limitKey(l)
    const existing = names.get(key)
    if (existing) {
      await db
        .update(rateLimit)
        .set(values)
        .where(and(eq(rateLimit.id, existing), eq(rateLimit.orgId, orgId)))
      ids.set(key, existing)
    } else {
      const id = randomId('lim')
      await db.insert(rateLimit).values({ id, orgId, ...values })
      ids.set(key, id)
    }
  }
  if (mode === 'replace') {
    const kept = new Set(ids.values())
    for (const r of rows)
      if (!kept.has(r.id) && r.enabled)
        await db.update(rateLimit).set({ enabled: false }).where(eq(rateLimit.id, r.id))
  }
  return ids
}

async function applyModels(db: Db, orgId: string, file: PolicyFile, mode: 'replace' | 'merge') {
  const rows = await db.query.model.findMany({ where: eq(model.orgId, orgId) })
  const byPattern = new Map(rows.map((r) => [r.pattern, r]))
  for (const [position, m] of file.models.entries()) {
    const existing = byPattern.get(m.pattern)
    if (existing)
      await db
        .update(model)
        .set({ ...m, position })
        .where(and(eq(model.id, existing.id), eq(model.orgId, orgId)))
    else await db.insert(model).values({ id: randomId('mdl'), orgId, position, ...m })
  }
  // Entries the file leaves out keep routing after the ones it lists.
  const listed = new Set(file.models.map((m) => m.pattern))
  let position = file.models.length
  for (const r of rows) {
    if (listed.has(r.pattern)) continue
    await db
      .update(model)
      .set({ position: position++, ...(mode === 'replace' ? { enabled: false } : {}) })
      .where(eq(model.id, r.id))
  }
}

async function applyWorkflows(
  db: Db,
  orgId: string,
  actorId: string,
  file: PolicyFile,
  groupIds: Map<string, string>,
  limitIds: Map<string, string>,
  mode: 'replace' | 'merge',
) {
  const rows = await db.query.workflow.findMany({ where: eq(workflow.orgId, orgId) })
  const byName = new Map(rows.map((r) => [r.name, r]))
  const note = 'Applied from a policy file'
  for (const [position, w] of file.workflows.entries()) {
    const definition: PolicyGraph = mapLimitRefs(w.definition, (ref) => limitIds.get(ref) ?? ref)
    const meta = {
      name: w.name,
      description: w.description,
      enabled: w.enabled,
      position,
      groupIds: w.groups.map((name) => groupIds.get(name)!),
    }
    const existing = byName.get(w.name)
    if (!existing) {
      const id = randomId('wf')
      await db.insert(workflow).values({ id, orgId, ...meta })
      await db.insert(workflowVersion).values({
        id: randomId('wfv'),
        orgId,
        workflowId: id,
        version: 1,
        definition,
        status: 'published',
        note,
        createdBy: actorId,
      })
      continue
    }
    await db.update(workflow).set(meta).where(eq(workflow.id, existing.id))
    const [latest, published] = await Promise.all([
      db.query.workflowVersion.findFirst({
        where: eq(workflowVersion.workflowId, existing.id),
        orderBy: desc(workflowVersion.version),
      }),
      db.query.workflowVersion.findFirst({
        where: and(
          eq(workflowVersion.workflowId, existing.id),
          eq(workflowVersion.status, 'published'),
        ),
        orderBy: desc(workflowVersion.version),
      }),
    ])
    const live = published ? policyGraph.safeParse(published.definition) : null
    if (
      live?.success &&
      canonicalJson(graphLogic(live.data)) === canonicalJson(graphLogic(definition))
    )
      continue
    if (latest?.status === 'draft') {
      await db
        .update(workflowVersion)
        .set({ definition, status: 'published', note, createdBy: actorId, createdAt: new Date() })
        .where(eq(workflowVersion.id, latest.id))
    } else {
      await db.insert(workflowVersion).values({
        id: randomId('wfv'),
        orgId,
        workflowId: existing.id,
        version: (latest?.version ?? 0) + 1,
        definition,
        status: 'published',
        note,
        createdBy: actorId,
      })
    }
  }
  // Workflows the file leaves out come after the ones it lists.
  const listed = new Set(file.workflows.map((w) => w.name))
  let position = file.workflows.length
  for (const r of rows) {
    if (listed.has(r.name)) continue
    await db
      .update(workflow)
      .set({ position: position++, ...(mode === 'replace' ? { enabled: false } : {}) })
      .where(eq(workflow.id, r.id))
  }
}
