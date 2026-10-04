import { z } from 'zod'
import { DATASET_INDEX_KEY, datasetKey } from '#/gateway/lib/learned-models.ts'

/**
 * The labelled datasets in the payload bucket. The Attack analysis page lists them, the Trained model
 * step learns from them and Attack analysis replays them against the published workflows.
 */

export const datasetSummary = z.object({
  slug: z.string(),
  name: z.string(),
  url: z.string().default(''),
  license: z.string().default(''),
  rows: z.number().int(),
  attacks: z.number().int(),
  benign: z.number().int(),
  byAttack: z.record(z.string(), z.number()),
  byChannel: z.record(z.string(), z.number()),
  /** Uploaded in the dashboard rather than shipped with the repository. */
  custom: z.boolean().default(false),
})
export type DatasetSummary = z.infer<typeof datasetSummary>

export type DatasetRow = {
  text: string
  attack: string
  channel: string
  label: string
  toolName: string | null
}

const MAX_TEXT = 4000

type Bucket = Pick<Env, 'PAYLOADS'>

export async function readDatasetIndex(env: Bucket): Promise<DatasetSummary[]> {
  const object = await env.PAYLOADS.get(DATASET_INDEX_KEY)
  if (!object) return []
  const parsed = z.array(datasetSummary).safeParse(await object.json().catch(() => null))
  return parsed.success ? parsed.data : []
}

export async function readRows(env: Bucket, slug: string): Promise<DatasetRow[]> {
  const object = await env.PAYLOADS.get(datasetKey(slug))
  if (!object) return []
  const rows: DatasetRow[] = []
  for (const line of (await object.text()).split('\n')) {
    if (!line) continue
    try {
      const c = JSON.parse(line) as {
        attack?: string
        channel?: string
        label?: string
        input?: { text?: string; toolName?: string | null }
      }
      if (typeof c.input?.text !== 'string') continue
      rows.push({
        text: c.input.text.slice(0, MAX_TEXT),
        attack: c.attack ?? 'benign',
        channel: c.channel ?? 'user_input',
        label: c.label ?? '',
        toolName: c.input.toolName ?? null,
      })
    } catch {
      // A broken line is skipped; the rest of the dataset still loads.
    }
  }
  return rows
}
