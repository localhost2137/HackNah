import {
  LEARNED_DIMS,
  type LearnedModel,
  type LearnedModelSummary,
  learnedMetrics,
  randomId,
} from '@acl/shared'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import {
  DATASET_INDEX_KEY,
  datasetKey,
  forgetModel,
  MODEL_INDEX_KEY,
  modelKey,
  readModelIndex,
} from '#/gateway/lib/learned-models.ts'
import { audit } from '../audit.ts'
import {
  type DatasetRow,
  type DatasetSummary,
  readDatasetIndex,
  readRows,
} from '../dataset-store.ts'

export type { DatasetRow, DatasetSummary }

import { env } from '../env.ts'
import { adminMiddleware } from '../middleware.ts'

export const listDatasets = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async () => ({
    datasets: await readDatasetIndex(env),
    models: await readModelIndex(env),
  }))

export const getDatasetRows = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ slug: z.string().max(120) }))
  .handler(({ data }) => readRows(env, data.slug))

/**
 * Benign requests from the datasets that are not selected, evenly sampled. Attacks alone cannot
 * train a model; these are the "normal traffic" it is told apart from.
 */
export const getBenignPool = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(
    z.object({ exclude: z.array(z.string().max(120)).max(50), limit: z.number().int().max(8000) }),
  )
  .handler(async ({ data }) => {
    const sources = (await readDatasetIndex(env)).filter(
      // "Normal requests" is itself a mix of the other datasets' benign rows.
      (d) => !data.exclude.includes(d.slug) && d.benign > 0 && d.slug !== 'normal-requests',
    )
    const total = sources.reduce((sum, d) => sum + d.benign, 0)
    const texts: string[] = []
    for (const source of sources) {
      const benign = (await readRows(env, source.slug)).filter((r) => r.attack === 'benign')
      const share = Math.max(1, Math.round((source.benign / Math.max(total, 1)) * data.limit))
      const step = Math.max(1, Math.floor(benign.length / share))
      for (let i = 0; i < benign.length && texts.length < data.limit; i += step)
        texts.push(benign[i]!.text)
    }
    return texts
  })

const modelUpload = z.object({
  /** From `selectionModelId()`: training the same selection again replaces its model. */
  id: z.string().regex(/^mdl_[a-z0-9]{4,40}$/),
  name: z.string().min(1).max(120),
  datasets: z.array(z.string().max(120)).min(1).max(50),
  bias: z.number(),
  weights: z.string().max(1_200_000),
  attacks: z.number().int(),
  benign: z.number().int(),
  metrics: learnedMetrics,
})

export const saveModel = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(modelUpload)
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    const summary: LearnedModelSummary = {
      id: data.id,
      name: data.name,
      datasets: data.datasets,
      trainedAt: new Date().toISOString(),
      attacks: data.attacks,
      benign: data.benign,
      metrics: data.metrics,
    }
    const model: LearnedModel = {
      ...summary,
      dims: LEARNED_DIMS,
      bias: data.bias,
      weights: data.weights,
    }
    await env.PAYLOADS.put(modelKey(summary.id), JSON.stringify(model))
    const others = (await readModelIndex(env)).filter((m) => m.id !== summary.id)
    await env.PAYLOADS.put(MODEL_INDEX_KEY, JSON.stringify([summary, ...others].slice(0, 200)))
    forgetModel(summary.id)
    await audit(db, {
      orgId,
      actorId: me.id,
      action: 'model.train',
      target: summary.id,
      data: { datasets: summary.datasets, metrics: summary.metrics },
    })
    return summary
  })

const datasetUpload = z.object({
  name: z.string().min(1).max(120),
  rows: z
    .array(z.object({ text: z.string().min(1).max(20_000), attack: z.boolean() }))
    .min(1)
    .max(20_000),
})

/** A labelled dataset uploaded from the dashboard, stored in the same shape as the shipped ones. */
export const uploadDataset = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(datasetUpload)
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    const slug = `custom-${data.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60)}-${randomId('').slice(-6).toLowerCase()}`
    const lines = data.rows.map((row, i) =>
      JSON.stringify({
        id: `${slug}.${i}`,
        attack: row.attack ? 'custom' : 'benign',
        channel: 'user_input',
        input: { kind: 'model_request', toolName: null, text: row.text },
        expected: row.attack ? 'block' : 'allow',
        source: { name: data.name, dataset: data.name },
      }),
    )
    const attacks = data.rows.filter((r) => r.attack).length
    const summary: DatasetSummary = {
      slug,
      name: data.name,
      url: '',
      license: 'uploaded',
      rows: data.rows.length,
      attacks,
      benign: data.rows.length - attacks,
      byAttack: attacks ? { custom: attacks } : {},
      byChannel: { user_input: data.rows.length },
      custom: true,
    }
    await env.PAYLOADS.put(datasetKey(slug), `${lines.join('\n')}\n`)
    await env.PAYLOADS.put(
      DATASET_INDEX_KEY,
      JSON.stringify([...(await readDatasetIndex(env)), summary]),
    )
    await audit(db, {
      orgId,
      actorId: me.id,
      action: 'dataset.upload',
      target: slug,
      data: { rows: summary.rows, attacks },
    })
    return summary
  })
