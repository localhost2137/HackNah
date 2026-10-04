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
import {
  cellText,
  fetchRows,
  inspectDataset,
  isAttackValue,
  parseDatasetId,
} from '../huggingface.ts'
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

type NewRow = { text: string; attack: boolean }

/** Stores labelled rows as a dataset, replacing one with the same slug. */
async function storeDataset(args: {
  slug: string
  name: string
  url: string
  license: string
  custom: boolean
  attackLabel: string
  rows: NewRow[]
}): Promise<DatasetSummary> {
  const lines = args.rows.map((row, i) =>
    JSON.stringify({
      id: `${args.slug}.${i}`,
      attack: row.attack ? args.attackLabel : 'benign',
      channel: 'user_input',
      input: { kind: 'model_request', toolName: null, text: row.text },
      expected: row.attack ? 'block' : 'allow',
      source: { name: args.name, dataset: args.name, reference: args.url, license: args.license },
    }),
  )
  const attacks = args.rows.filter((r) => r.attack).length
  const summary: DatasetSummary = {
    slug: args.slug,
    name: args.name,
    url: args.url,
    license: args.license,
    rows: args.rows.length,
    attacks,
    benign: args.rows.length - attacks,
    byAttack: attacks ? { [args.attackLabel]: attacks } : {},
    byChannel: { user_input: args.rows.length },
    custom: args.custom,
  }
  await env.PAYLOADS.put(datasetKey(args.slug), `${lines.join('\n')}\n`)
  const others = (await readDatasetIndex(env)).filter((d) => d.slug !== args.slug)
  await env.PAYLOADS.put(DATASET_INDEX_KEY, JSON.stringify([...others, summary]))
  return summary
}

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)

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
    const summary = await storeDataset({
      slug: `custom-${slugify(data.name).slice(0, 60)}-${randomId('').slice(-6).toLowerCase()}`,
      name: data.name,
      url: '',
      license: 'uploaded',
      custom: true,
      attackLabel: 'custom',
      rows: data.rows,
    })
    await audit(db, {
      orgId,
      actorId: me.id,
      action: 'dataset.upload',
      target: summary.slug,
      data: { rows: summary.rows, attacks: summary.attacks },
    })
    return summary
  })

/** Looks a public Hugging Face dataset up: its splits, columns, a few rows and a mapping guess. */
export const inspectHuggingFace = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ dataset: z.string().max(300) }))
  .handler(({ data }) => {
    const id = parseDatasetId(data.dataset)
    if (!id) throw new Error('Enter a dataset as owner/name, or paste its Hugging Face link.')
    return inspectDataset(id)
  })

/** Imports rows of one split as a labelled dataset. Importing the same split again replaces it. */
export const importHuggingFace = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(
    z.object({
      dataset: z.string().max(300),
      config: z.string().max(120),
      split: z.string().max(120),
      textColumn: z.string().min(1).max(120),
      labelColumn: z.string().max(120).nullable(),
      /** Label values that mean "attack". Ignored without a label column. */
      attackValues: z.array(z.string().max(120)).max(50),
      /** Without a label column: whether every row is an attack or every row is normal. */
      allAttacks: z.boolean(),
      attackLabel: z.enum(['prompt_injection', 'jailbreak', 'indirect_injection', 'custom']),
      limit: z.number().int().min(50).max(2000),
      license: z.string().max(200),
    }),
  )
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    const id = parseDatasetId(data.dataset)
    if (!id) throw new Error('Unknown dataset')
    const { columns, rows } = await fetchRows(id, data.config, data.split, data.limit)
    const text = columns.find((c) => c.name === data.textColumn)
    const label = columns.find((c) => c.name === data.labelColumn)
    if (!text) throw new Error(`The dataset has no column called ${data.textColumn}`)
    if (data.labelColumn && !label)
      throw new Error(`The dataset has no column called ${data.labelColumn}`)
    const labelled = rows.flatMap((row): NewRow[] => {
      const value = cellText(row[text.name], text).trim()
      if (!value) return []
      return [
        {
          text: value.slice(0, 20_000),
          attack: label
            ? isAttackValue(cellText(row[label.name], label), data.attackValues)
            : data.allAttacks,
        },
      ]
    })
    if (labelled.length === 0) throw new Error('No rows with text were found in that split.')
    const summary = await storeDataset({
      slug: `hf-${slugify(`${id}-${data.split}`)}`,
      name: `${id} · ${data.split}`,
      url: `https://huggingface.co/datasets/${id}`,
      license: data.license || 'see dataset card',
      custom: false,
      attackLabel: data.attackLabel,
      rows: labelled,
    })
    await audit(db, {
      orgId,
      actorId: me.id,
      action: 'dataset.import',
      target: summary.slug,
      data: { source: id, split: data.split, rows: summary.rows, attacks: summary.attacks },
    })
    return summary
  })
