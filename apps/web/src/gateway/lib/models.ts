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

const cache = new TtlCache<ScoringModel | null>(30_000)

/** The models with these ids, decoded once each and re-read every 30 seconds. */
export async function loadModels(env: Env, ids: string[]): Promise<ScoringModel[]> {
  const models = await Promise.all(
    [...new Set(ids)].map((id) =>
      cache.get(id, async () => {
        const object = await env.PAYLOADS.get(modelKey(id))
        const parsed = object ? learnedModel.safeParse(await object.json()) : null
        if (!parsed?.success) return null
        try {
          return decodeModel(parsed.data)
        } catch {
          return null
        }
      }),
    ),
  )
  return models.filter((m): m is ScoringModel => m !== null)
}

export function forgetModel(id: string) {
  cache.delete(id)
}
