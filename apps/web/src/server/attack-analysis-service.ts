import {
  analysisRevision,
  analysisRun,
  type Db,
  group,
  guardrail,
  guardrailVersion,
  mcpServer,
  resource,
} from '@acl/db'
import { type ActiveGuardrail, defaultGuardrail, policyGraph, randomId } from '@acl/shared'
import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { loadLearnedModels } from '#/gateway/lib/learned-models.ts'
import { loadSignatures } from '#/gateway/lib/signatures.ts'
import { catalogVersion } from '#/lib/attack-analysis/catalog.ts'
import { datasets } from '#/lib/attack-analysis/datasets.ts'
import {
  isLabelled,
  labelledInfo,
  labelledSlug,
  labelledTraffic,
} from '#/lib/attack-analysis/labelled.ts'
import { type Persona, replayTraffic } from '#/lib/attack-analysis/replay.ts'
import type { AnalysisRun, RunSummary } from '#/lib/attack-analysis/run-types.ts'
import { datasetTraffic, type TrafficEvent } from '#/lib/attack-analysis/traffic.ts'
import { readDatasetIndex, readRows } from './dataset-store.ts'

async function revisionOf(db: Db, orgId: string) {
  return (
    (await db.query.analysisRevision.findFirst({ where: eq(analysisRevision.orgId, orgId) }))
      ?.revision ?? 0
  )
}

const scope = (orgId: string, revision: number) =>
  and(
    eq(analysisRun.orgId, orgId),
    eq(analysisRun.revision, revision),
    eq(analysisRun.catalogVersion, catalogVersion),
  )
const changed = () =>
  new Error(
    'Guardrail rules changed during this run. Run the dataset again against the current rules.',
  )

export type PlatformContext = {
  db: Db
  orgId: string
  user: { id: string }
  env: Pick<Env, 'PAYLOADS'> & Partial<Pick<Env, 'SIGNATURE_FEED_URL'>>
}

export const getAnalysisRunInput = z.object({ id: z.string().min(1).max(100) })

export const runAnalysisInput = z.object({
  datasetId: z.string().max(80),
  groupIds: z.array(z.string().max(100)).max(100),
  mcpServerId: z.string().max(100).nullable(),
  resourceIds: z.array(z.string().max(100)).max(100),
  model: z.string().max(200),
})

export async function listAnalysisRunsService({
  context: { db, orgId },
}: {
  context: PlatformContext
}) {
  const revision = await revisionOf(db, orgId)
  const rows = await db
    .select()
    .from(analysisRun)
    .where(scope(orgId, revision))
    .orderBy(desc(analysisRun.createdAt), desc(analysisRun.id))
  if ((await revisionOf(db, orgId)) !== revision)
    return { revision: await revisionOf(db, orgId), runs: [] as RunSummary[] }
  const count = new Map<string, number>()
  const runs: RunSummary[] = rows
    .filter((row) => {
      const n = (count.get(row.datasetId) ?? 0) + 1
      count.set(row.datasetId, n)
      return n <= 10
    })
    .map((row) => ({
      id: row.id,
      datasetId: row.datasetId,
      revision,
      catalogVersion: row.catalogVersion,
      at: row.createdAt.toISOString(),
      total: row.total,
      correct: row.correct,
    }))
  return { revision, runs }
}

export async function getAnalysisRunService({
  data,
  context: { db, env, orgId },
}: {
  data: z.infer<typeof getAnalysisRunInput>
  context: PlatformContext
}): Promise<string | null> {
  const revision = await revisionOf(db, orgId)
  const row = await db.query.analysisRun.findFirst({
    where: and(scope(orgId, revision), eq(analysisRun.id, data.id)),
  })
  if (!row?.payloadKey.startsWith(`${orgId}/analysis/`)) return null
  const object = await env.PAYLOADS.get(row.payloadKey)
  if (!object)
    throw new Error('Saved run payload is unavailable. Please retry or run the dataset again.')
  const run = await object.text()
  if ((await revisionOf(db, orgId)) !== revision) return null
  return run
}

/** The events to replay: a built-in synthetic dataset, or the rows of a labelled one. */
async function trafficFor(
  env: Pick<Env, 'PAYLOADS'>,
  datasetId: string,
): Promise<TrafficEvent[] | null> {
  if (!isLabelled(datasetId))
    return datasets.some((d) => d.id === datasetId) ? datasetTraffic(datasetId) : null
  const slug = labelledSlug(datasetId)
  const summary = (await readDatasetIndex(env)).find((d) => d.slug === slug)
  if (!summary) return null
  return labelledTraffic(labelledInfo(summary), await readRows(env, slug))
}

export async function runAnalysisService({
  data,
  context: { db, env, orgId, user },
}: {
  data: z.infer<typeof runAnalysisInput>
  context: PlatformContext
}): Promise<string> {
  const traffic = await trafficFor(env, data.datasetId)
  if (!traffic) throw new Error('Dataset not found')
  const revision = await revisionOf(db, orgId)
  const [rules, versions, groups, servers, resources] = await Promise.all([
    db.query.guardrail.findMany({
      where: eq(guardrail.orgId, orgId),
      orderBy: [asc(guardrail.position), asc(guardrail.createdAt)],
    }),
    db.query.guardrailVersion.findMany({
      where: and(eq(guardrailVersion.orgId, orgId), eq(guardrailVersion.status, 'published')),
      orderBy: [desc(guardrailVersion.version)],
    }),
    db.query.group.findMany({ where: eq(group.orgId, orgId) }),
    db.select({ id: mcpServer.id }).from(mcpServer).where(eq(mcpServer.orgId, orgId)),
    db
      .select({ id: resource.id, tools: resource.tools })
      .from(resource)
      .where(eq(resource.orgId, orgId)),
  ])
  if (data.groupIds.some((id) => !groups.some((g) => g.id === id)))
    throw new Error('A selected group no longer exists. Refresh and try again.')
  if (data.mcpServerId && !servers.some((s) => s.id === data.mcpServerId))
    throw new Error('Server not found')
  if (
    data.resourceIds.some(
      (id) =>
        !resources.some(
          (r) =>
            r.id === id &&
            ('*' in r.tools || (data.mcpServerId !== null && data.mcpServerId in r.tools)),
        ),
    )
  )
    throw new Error('Resource does not include the selected server')
  const selectedGroups = groups.filter((g) => g.isDefault || data.groupIds.includes(g.id))
  const persona: Persona = {
    id: 'synthetic-analyst',
    groupIds: selectedGroups.map((g) => g.id),
    mcpServerId: data.mcpServerId,
    resourceIds: data.resourceIds,
    model: data.model,
  }
  const guardrails: ActiveGuardrail[] = rules.flatMap((w) => {
    const version = versions.find((v) => v.guardrailId === w.id)
    return w.enabled && version
      ? [
          {
            id: w.id,
            name: w.name,
            version: version.version,
            groupIds: w.groupIds,
            definition: policyGraph.safeParse(version.definition).data ?? defaultGuardrail,
          },
        ]
      : []
  })
  if ((await revisionOf(db, orgId)) !== revision) throw changed()
  // The same signatures and trained models the gateway would use on live traffic.
  const deps = {
    signatures: (await loadSignatures(env)).signatures,
    models: await loadLearnedModels(
      env,
      guardrails.flatMap((w) =>
        w.definition.nodes.flatMap((n) =>
          n.type === 'check' && n.enabled && n.check.type === 'learned' ? n.check.models : [],
        ),
      ),
    ),
  }
  const results = await replayTraffic(traffic, guardrails, persona, undefined, deps)
  if ((await revisionOf(db, orgId)) !== revision) throw changed()
  const id = randomId('arun')
  const at = new Date()
  const run: AnalysisRun = {
    id,
    datasetId: data.datasetId,
    revision,
    at: at.toISOString(),
    catalogVersion,
    persona,
    groupNames: selectedGroups.map((g) => g.name),
    guardrails,
    results,
  }
  const payloadKey = `${orgId}/analysis/${id}.json`
  await env.PAYLOADS.put(payloadKey, JSON.stringify(run), {
    httpMetadata: { contentType: 'application/json' },
  })
  try {
    if ((await revisionOf(db, orgId)) !== revision) throw changed()
    await db.insert(analysisRun).values({
      id,
      orgId,
      datasetId: data.datasetId,
      revision,
      catalogVersion,
      createdBy: user.id,
      createdAt: at,
      total: results.length,
      correct: results.filter((r) => r.outcome === 'correct').length,
      payloadKey,
    })
    if ((await revisionOf(db, orgId)) !== revision) throw changed()
  } catch (error) {
    await env.PAYLOADS.delete(payloadKey)
    await db.delete(analysisRun).where(and(eq(analysisRun.id, id), eq(analysisRun.orgId, orgId)))
    throw error
  }
  return JSON.stringify(run)
}
