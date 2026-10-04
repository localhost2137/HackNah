import {
  decodeModel,
  type LearnedModelSummary,
  learnedModel,
  learnedModelSummary,
  type ScoringModel,
} from '@acl/shared'
import { z } from 'zod'
import { TtlCache } from './cache.ts'

/** Where datasets and the models trained on them live in the payload bucket. */
export const DATASET_INDEX_KEY = 'datasets/index.json'
export const datasetKey = (slug: string) => `datasets/${slug}.jsonl`
export const MODEL_INDEX_KEY = 'models/index.json'
export const modelKey = (id: string) => `models/${id}.json`

const index = z.array(learnedModelSummary)

export async function readModelIndex(env: Env): Promise<LearnedModelSummary[]> {
  const object = await env.PAYLOADS.get(MODEL_INDEX_KEY)
  if (!object) return []
  const parsed = index.safeParse(await object.json().catch(() => null))
  return parsed.success ? parsed.data : []
}

const cache = new TtlCache<ScoringModel[]>(30_000)
const decoded = new Map<string, ScoringModel>()

/** Every enabled model, decoded once and re-read every 30 seconds. */
export function loadModels(env: Env): Promise<ScoringModel[]> {
  return cache.get('models', async () => {
    const enabled = (await readModelIndex(env)).filter((m) => m.enabled)
    const models: ScoringModel[] = []
    for (const summary of enabled) {
      const version = `${summary.id}:${summary.trainedAt}`
      let model = decoded.get(version)
      if (!model) {
        const object = await env.PAYLOADS.get(modelKey(summary.id))
        const parsed = object ? learnedModel.safeParse(await object.json()) : null
        if (!parsed?.success) continue
        try {
          model = decodeModel(parsed.data)
        } catch {
          continue
        }
        decoded.set(version, model)
      }
      models.push(model)
    }
    return models
  })
}

export function forgetModels() {
  cache.delete('models')
}
