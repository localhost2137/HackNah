import {
  analysisRevision,
  analysisRun,
  type Db,
  group,
  mcpServer,
  resource,
  workflow,
  workflowVersion,
} from '@acl/db'
import { type ActiveWorkflow, defaultWorkflow, policyGraph, randomId } from '@acl/shared'
import { createServerFn } from '@tanstack/react-start'
import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { catalogVersion } from '#/lib/attack-analysis/catalog.ts'
import { datasets } from '#/lib/attack-analysis/datasets.ts'
import { type Persona, replayTraffic } from '#/lib/attack-analysis/replay.ts'
import type { AnalysisRun, RunSummary } from '#/lib/attack-analysis/run-types.ts'
import { datasetTraffic } from '#/lib/attack-analysis/traffic.ts'
import { env } from '../env.ts'
import { adminMiddleware } from '../middleware.ts'

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

export const listAnalysisRuns = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async ({ context: { db, orgId } }) => {
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
  })

export const getAnalysisRun = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ id: z.string().min(1).max(100) }))
  .handler(async ({ data, context: { db, orgId } }): Promise<string | null> => {
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
  })

export const runAnalysis = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(
    z.object({
      datasetId: z.string().max(80),
      groupIds: z.array(z.string().max(100)).max(100),
      mcpServerId: z.string().max(100).nullable(),
      resourceIds: z.array(z.string().max(100)).max(100),
      model: z.string().max(200),
    }),
  )
  .handler(async ({ data, context: { db, orgId, user } }): Promise<string> => {
    if (!datasets.some((dataset) => dataset.id === data.datasetId))
      throw new Error('Dataset not found')
    const revision = await revisionOf(db, orgId)
    const [rules, versions, groups, servers, resources] = await Promise.all([
      db.query.workflow.findMany({
        where: eq(workflow.orgId, orgId),
        orderBy: [asc(workflow.position), asc(workflow.createdAt)],
      }),
      db.query.workflowVersion.findMany({
        where: and(eq(workflowVersion.orgId, orgId), eq(workflowVersion.status, 'published')),
        orderBy: [desc(workflowVersion.version)],
      }),
      db.query.group.findMany({ where: eq(group.orgId, orgId) }),
      db.select({ id: mcpServer.id }).from(mcpServer).where(eq(mcpServer.orgId, orgId)),
      db
        .select({ id: resource.id, mcpServerId: resource.mcpServerId })
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
            (r) => r.id === id && (!r.mcpServerId || r.mcpServerId === data.mcpServerId),
          ),
      )
    )
      throw new Error('Resource does not belong to the selected server')
    const selectedGroups = groups.filter((g) => g.isDefault || data.groupIds.includes(g.id))
    const persona: Persona = {
      id: 'synthetic-analyst',
      groupIds: selectedGroups.map((g) => g.id),
      mcpServerId: data.mcpServerId,
      resourceIds: data.resourceIds,
      model: data.model,
    }
    const workflows: ActiveWorkflow[] = rules.flatMap((w) => {
      const version = versions.find((v) => v.workflowId === w.id)
      return w.enabled && version
        ? [
            {
              id: w.id,
              name: w.name,
              version: version.version,
              groupIds: w.groupIds,
              definition: policyGraph.safeParse(version.definition).data ?? defaultWorkflow,
            },
          ]
        : []
    })
    if ((await revisionOf(db, orgId)) !== revision) throw changed()
    const results = await replayTraffic(datasetTraffic(data.datasetId), workflows, persona)
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
      workflows,
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
  })
