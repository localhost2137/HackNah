/**
 * Reads public datasets from Hugging Face through its dataset viewer API, which needs no account.
 * Only ungated datasets with the viewer enabled can be read this way.
 */

const VIEWER = 'https://datasets-server.huggingface.co'
const HUB = 'https://huggingface.co'
const PAGE = 100

export type HfColumn = {
  name: string
  kind: 'text' | 'label' | 'other'
  /** Names of a class label column, by the integer stored in each row. */
  classNames?: string[]
}
export type HfSplit = { config: string; split: string; rows: number }
export type HfMapping = {
  textColumn: string
  /** Null when the dataset has no label: every row is then an attack, or every row is normal. */
  labelColumn: string | null
  attackValues: string[]
}
export type HfInspection = {
  dataset: string
  license: string
  splits: HfSplit[]
  columns: HfColumn[]
  /** A few rows of the first split, with class labels shown by name. */
  sample: Record<string, string>[]
  guess: HfMapping
}

/** `owner/name` from a dataset id or a huggingface.co/datasets/... link; null if it is neither. */
export function parseDatasetId(input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/, '')
  const fromUrl = /huggingface\.co\/datasets\/([^/?#\s]+\/[^/?#\s]+)/.exec(trimmed)?.[1]
  const id = fromUrl ?? trimmed
  return /^[\w.-]{1,96}\/[\w.-]{1,96}$/.test(id) ? id : null
}

type Feature = { name: string; type: { _type?: string; dtype?: string; names?: string[] } }

export function columnsOf(features: Feature[]): HfColumn[] {
  return features.map(({ name, type }) => {
    if (type._type === 'ClassLabel') return { name, kind: 'label', classNames: type.names ?? [] }
    if (type._type !== 'Value') return { name, kind: 'other' }
    if (type.dtype === 'string' || type.dtype === 'large_string') return { name, kind: 'text' }
    return {
      name,
      kind: type.dtype === 'bool' || type.dtype?.startsWith('int') ? 'label' : 'other',
    }
  })
}

/** A cell as text; class label integers become their names. */
export function cellText(value: unknown, column: HfColumn | undefined): string {
  if (column?.classNames && typeof value === 'number') return column.classNames[value] ?? `${value}`
  return typeof value === 'string' ? value : JSON.stringify(value ?? '')
}

const ATTACK_WORDS =
  /^(1|true|yes|attack|jailbreak|injection|prompt[_ -]?injection|malicious|unsafe|harmful|toxic|adversarial)$/i
const TEXT_NAMES = ['text', 'prompt', 'content', 'input', 'user_input', 'question', 'instruction']
const LABEL_NAMES = ['label', 'type', 'jailbreak', 'is_injection', 'injection', 'class', 'category']

/** A first guess at which column is the text, which is the label and which values mean attack. */
export function guessMapping(columns: HfColumn[], sample: Record<string, string>[]): HfMapping {
  const texts = columns.filter((c) => c.kind === 'text')
  const named = (names: string[], pool: HfColumn[]) =>
    names.map((n) => pool.find((c) => c.name.toLowerCase() === n)).find(Boolean)
  const textColumn = (named(TEXT_NAMES, texts) ?? texts[0] ?? columns[0])?.name ?? ''
  const candidates = columns.filter((c) => c.name !== textColumn && c.kind !== 'other')
  // A label has few distinct values; a second free-text column does not.
  const few = (c: HfColumn) => new Set(sample.map((r) => r[c.name])).size <= 6
  const label =
    named(LABEL_NAMES, candidates) ??
    candidates.find((c) => c.kind === 'label') ??
    candidates.find(few)
  const values = label ? [...new Set(sample.map((r) => r[label.name] ?? ''))] : []
  return {
    textColumn,
    labelColumn: label?.name ?? null,
    attackValues: values.filter((v) => ATTACK_WORDS.test(v)),
  }
}

export function isAttackValue(value: string, attackValues: string[]): boolean {
  return attackValues.some((v) => v.trim().toLowerCase() === value.trim().toLowerCase())
}

async function getJson(url: string, tries = 3): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    if (res.ok) return res.json()
    if (res.status === 429 && attempt < tries) {
      await new Promise((resolve) => setTimeout(resolve, 2500 * attempt))
      continue
    }
    if (res.status === 401 || res.status === 403 || res.status === 404)
      throw new Error(
        'Hugging Face has no public dataset with that name, or it is gated and needs an account.',
      )
    if (res.status === 429) throw new Error('Hugging Face is rate limiting; try again in a minute.')
    throw new Error(`Hugging Face answered ${res.status}. The dataset viewer may be off for it.`)
  }
}

const query = (params: Record<string, string | number>) =>
  Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')

export async function inspectDataset(dataset: string): Promise<HfInspection> {
  const size = (await getJson(`${VIEWER}/size?${query({ dataset })}`)) as {
    size?: { splits?: { config: string; split: string; num_rows: number }[] }
  }
  const splits = (size.size?.splits ?? []).map((s) => ({
    config: s.config,
    split: s.split,
    rows: s.num_rows,
  }))
  const first = splits[0]
  if (!first) throw new Error('That dataset has no readable splits.')
  const rows = (await getJson(
    `${VIEWER}/first-rows?${query({ dataset, config: first.config, split: first.split })}`,
  )) as { features: Feature[]; rows: { row: Record<string, unknown> }[] }
  const columns = columnsOf(rows.features)
  const sample = rows.rows
    .slice(0, 30)
    .map(({ row }) =>
      Object.fromEntries(columns.map((c) => [c.name, cellText(row[c.name], c).slice(0, 300)])),
    )
  const card = (await getJson(`${HUB}/api/datasets/${dataset}`).catch(() => ({}))) as {
    cardData?: { license?: string | string[] }
  }
  const license = [card.cardData?.license ?? []].flat().join(', ')
  return {
    dataset,
    license: license || 'see dataset card',
    splits,
    columns,
    sample,
    guess: guessMapping(columns, sample),
  }
}

/** Up to `limit` rows of a split. Larger splits are read from evenly spaced pages. */
export async function fetchRows(
  dataset: string,
  config: string,
  split: string,
  limit: number,
): Promise<{ columns: HfColumn[]; rows: Record<string, unknown>[] }> {
  const page = (offset: number) =>
    getJson(
      `${VIEWER}/rows?${query({ dataset, config, split, offset, length: PAGE })}`,
    ) as Promise<{
      features: Feature[]
      rows: { row: Record<string, unknown> }[]
      num_rows_total: number
    }>
  const first = await page(0)
  const rows = first.rows.map((r) => r.row)
  const pages = Math.ceil(first.num_rows_total / PAGE)
  const wanted = Math.min(pages, Math.ceil(limit / PAGE))
  for (let i = 1; i < wanted; i++) {
    const offset = Math.floor((i * pages) / wanted) * PAGE
    rows.push(...(await page(offset)).rows.map((r) => r.row))
  }
  return { columns: columnsOf(first.features), rows: rows.slice(0, limit) }
}
