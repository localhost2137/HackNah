import { type Db, group, guardrail, guardrailVersion, model, rateLimit } from '@acl/db'
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
 * Export and import of the instance's policy file (guardrails, limits, model catalog). Used by the
 * Settings page and by `pnpm policy:export` / `pnpm policy:apply` through `/api/policy`.
 */

async function policyState(db: Db, orgId: string): Promise<PolicyState> {
  const [groups, guardrails, versions, limits, models] = await Promise.all([
    db.query.group.findMany({ where: eq(group.orgId, orgId) }),
    db.query.guardrail.findMany({
      where: eq(guardrail.orgId, orgId),
      orderBy: [asc(guardrail.position), asc(guardrail.createdAt)],
    }),
    db
      .select({
        guardrailId: guardrailVersion.guardrailId,
        status: guardrailVersion.status,
        definition: guardrailVersion.definition,
      })
      .from(guardrailVersion)
      .where(and(eq(guardrailVersion.orgId, orgId), eq(guardrailVersion.status, 'published')))
      .orderBy(desc(guardrailVersion.version)),
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
    guardrails: guardrails.map((w) => {
      const published = versions.find((v) => v.guardrailId === w.id)
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
 * any error. Limits go first so Usage limit blocks can point at their ids; a guardrail whose
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
          ...file.guardrails.flatMap((w, i) =>
            w.groups.includes(name) ? [`guardrails[${i}]`] : [],
          ),
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
  await applyGuardrails(db, orgId, actorId, file, groups.ids, limitIds, opts.mode)

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

async function applyGuardrails(
  db: Db,
  orgId: string,
  actorId: string,
  file: PolicyFile,
  groupIds: Map<string, string>,
  limitIds: Map<string, string>,
  mode: 'replace' | 'merge',
) {
  const rows = await db.query.guardrail.findMany({ where: eq(guardrail.orgId, orgId) })
  const byName = new Map(rows.map((r) => [r.name, r]))
  const note = 'Applied from a policy file'
  for (const [position, w] of file.guardrails.entries()) {
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
      await db.insert(guardrail).values({ id, orgId, ...meta })
      await db.insert(guardrailVersion).values({
        id: randomId('wfv'),
        orgId,
        guardrailId: id,
        version: 1,
        definition,
        status: 'published',
        note,
        createdBy: actorId,
      })
      continue
    }
    await db.update(guardrail).set(meta).where(eq(guardrail.id, existing.id))
    const [latest, published] = await Promise.all([
      db.query.guardrailVersion.findFirst({
        where: eq(guardrailVersion.guardrailId, existing.id),
        orderBy: desc(guardrailVersion.version),
      }),
      db.query.guardrailVersion.findFirst({
        where: and(
          eq(guardrailVersion.guardrailId, existing.id),
          eq(guardrailVersion.status, 'published'),
        ),
        orderBy: desc(guardrailVersion.version),
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
        .update(guardrailVersion)
        .set({ definition, status: 'published', note, createdBy: actorId, createdAt: new Date() })
        .where(eq(guardrailVersion.id, latest.id))
    } else {
      await db.insert(guardrailVersion).values({
        id: randomId('wfv'),
        orgId,
        guardrailId: existing.id,
        version: (latest?.version ?? 0) + 1,
        definition,
        status: 'published',
        note,
        createdBy: actorId,
      })
    }
  }
  // Guardrails the file leaves out come after the ones it lists.
  const listed = new Set(file.guardrails.map((w) => w.name))
  let position = file.guardrails.length
  for (const r of rows) {
    if (listed.has(r.name)) continue
    await db
      .update(guardrail)
      .set({ position: position++, ...(mode === 'replace' ? { enabled: false } : {}) })
      .where(eq(guardrail.id, r.id))
  }
}
