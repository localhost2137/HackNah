import { z } from 'zod'

/**
 * Learned rules: a small logistic regression over hashed character and word n-grams, trained on
 * a labelled dataset. It answers "does this request look like the attacks in that dataset" in
 * well under a millisecond. It learns what a dataset looks like, not what an attack is, so it
 * matches similar requests and should not be trusted on traffic unlike its training data: every
 * model records how it did on held-out attacks and on held-out benign requests.
 *
 * Training and scoring are plain TypeScript, so a model can be trained in the browser or in
 * Node and scored in the gateway.
 */

/** Feature space size. A power of two, so hashing can mask instead of dividing. */
export const LEARNED_DIMS = 2 ** 17
const MAX_CHARS = 1500

export const learnedMetrics = z.object({
  /** Share of held-out attacks from the dataset the model flags. */
  recall: z.number(),
  /** Share of held-out benign requests the model flags. */
  falsePositiveRate: z.number(),
  heldOutAttacks: z.number().int(),
  heldOutBenign: z.number().int(),
})
export type LearnedMetrics = z.infer<typeof learnedMetrics>

/** What the dashboard lists; the weights live in a separate object. */
export const learnedModelSummary = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  /** Slugs of the datasets the model was trained on. */
  datasets: z.array(z.string().max(120)).max(50),
  trainedAt: z.string(),
  attacks: z.number().int(),
  benign: z.number().int(),
  metrics: learnedMetrics,
})
export type LearnedModelSummary = z.infer<typeof learnedModelSummary>

export const learnedModel = learnedModelSummary.extend({
  dims: z.number().int(),
  bias: z.number(),
  /** Base64 of a little-endian Float32Array with `dims` entries. */
  weights: z.string(),
})
export type LearnedModel = z.infer<typeof learnedModel>

/** A model with its weights decoded, ready to score. */
export type ScoringModel = { id: string; name: string; bias: number; weights: Float32Array }

export type LabelledText = { text: string; attack: boolean }

/**
 * The id of the model for a selection of datasets. The same datasets at the same sizes always
 * give the same id, so a selection that was trained before reuses its model instead of training
 * again; adding rows to a dataset gives a new id.
 */
export function selectionModelId(datasets: { slug: string; rows: number }[]): string {
  const key = datasets
    .map((d) => `${d.slug}:${d.rows}`)
    .sort()
    .join('|')
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < key.length; i++) {
    a = Math.imul(a ^ key.charCodeAt(i), 0x01000193) >>> 0
    b = Math.imul(b + key.charCodeAt(i), 0x85ebca6b) >>> 0
  }
  return `mdl_${a.toString(36)}${b.toString(36)}`
}

function hash(text: string, seed: number): number {
  // FNV-1a over UTF-16 code units.
  let h = (0x811c9dc5 ^ seed) >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h & (LEARNED_DIMS - 1)
}

/**
 * The distinct feature indices of a text: character 3- to 5-grams inside each word (padded with
 * spaces, so word starts and ends count) plus single words and word pairs.
 */
export function featurize(text: string): Uint32Array {
  const words = text
    .slice(0, MAX_CHARS)
    .normalize('NFKC')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  const seen = new Set<number>()
  let previous = ''
  for (const word of words) {
    seen.add(hash(word, 1))
    if (previous) seen.add(hash(`${previous} ${word}`, 2))
    previous = word
    const padded = ` ${word} `
    for (let n = 3; n <= 5; n++)
      for (let i = 0; i + n <= padded.length; i++) seen.add(hash(padded.slice(i, i + n), 3))
  }
  return Uint32Array.from(seen)
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z))

function margin(features: Uint32Array, weights: Float32Array, bias: number): number {
  if (features.length === 0) return bias
  let sum = 0
  for (let i = 0; i < features.length; i++) sum += weights[features[i]!]!
  // Each feature is worth 1/sqrt(n): vectors have unit length whatever the text length.
  return bias + sum / Math.sqrt(features.length)
}

/** Probability in [0, 1] that the text is like the attacks the model was trained on. */
export function scoreModel(model: ScoringModel, text: string): number {
  return sigmoid(margin(featurize(text), model.weights, model.bias))
}

export function encodeWeights(weights: Float32Array): string {
  const bytes = new Uint8Array(weights.buffer, weights.byteOffset, weights.byteLength)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function decodeModel(model: LearnedModel): ScoringModel {
  const binary = atob(model.weights)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  if (model.dims !== LEARNED_DIMS || bytes.length !== LEARNED_DIMS * 4)
    throw new Error(`Model ${model.id} was trained with a different feature space`)
  return {
    id: model.id,
    name: model.name,
    bias: model.bias,
    weights: new Float32Array(bytes.buffer),
  }
}

export type TrainProgress = {
  stage: 'features' | 'training' | 'testing'
  /** Completed share of the whole run, 0 to 1. */
  done: number
  detail: string
}

export type TrainResult = {
  weights: Float32Array
  bias: number
  attacks: number
  benign: number
  metrics: LearnedMetrics
}

const EPOCHS = 8
const HOLD_OUT_EVERY = 5

/** Deterministic shuffle, so the same data always trains the same model. */
function shuffled(n: number, seed: number): Uint32Array {
  const order = Uint32Array.from({ length: n }, (_, i) => i)
  let state = seed >>> 0
  for (let i = n - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const j = state % (i + 1)
    const tmp = order[i]!
    order[i] = order[j]!
    order[j] = tmp
  }
  return order
}

/**
 * Trains on four fifths of the examples and tests on the rest. Yields to the event loop between
 * batches and reports progress, so a browser can show a progress bar while it runs.
 */
export async function trainModel(
  examples: LabelledText[],
  onProgress: (p: TrainProgress) => void = () => {},
  threshold = 0.5,
): Promise<TrainResult> {
  // Hand control back to the page only after a stretch of real work. Browsers slow timers in
  // background tabs to one per second, so pausing on every batch would stall training there.
  let lastPause = performance.now()
  const pause = async () => {
    if (performance.now() - lastPause < 50) return
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    lastPause = performance.now()
  }
  const total = examples.length
  if (total < 20) throw new Error('Not enough examples to train on')

  const features: Uint32Array[] = new Array(total)
  for (let i = 0; i < total; i++) {
    features[i] = featurize(examples[i]!.text)
    if (i % 250 === 0) {
      onProgress({ stage: 'features', done: (i / total) * 0.3, detail: `${i} of ${total} rows` })
      await pause()
    }
  }

  const order = shuffled(total, 42)
  const test: number[] = []
  const train: number[] = []
  order.forEach((index, position) => {
    if (position % HOLD_OUT_EVERY === 0) test.push(index)
    else train.push(index)
  })
  const attacks = examples.filter((e) => e.attack).length
  const benign = total - attacks
  if (attacks === 0 || benign === 0)
    throw new Error('Training needs both attack and benign examples')
  // Balance the classes: a dataset that is mostly attacks must not learn to flag everything.
  const weightOf = (attack: boolean) => total / (2 * (attack ? attacks : benign))

  const weights = new Float32Array(LEARNED_DIMS)
  const squares = new Float32Array(LEARNED_DIMS)
  let bias = 0
  let biasSquares = 0
  const RATE = 0.5
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const pass = shuffled(train.length, 1000 + epoch)
    for (let step = 0; step < pass.length; step++) {
      const index = train[pass[step]!]!
      const f = features[index]!
      const example = examples[index]!
      const error =
        (sigmoid(margin(f, weights, bias)) - (example.attack ? 1 : 0)) * weightOf(example.attack)
      // AdaGrad: frequent features take smaller steps, rare ones larger.
      const g = error / Math.sqrt(f.length || 1)
      const g2 = g * g
      for (let i = 0; i < f.length; i++) {
        const k = f[i]!
        squares[k] = squares[k]! + g2
        weights[k] = weights[k]! - (RATE * g) / Math.sqrt(squares[k]! + 1e-8)
      }
      biasSquares += error * error
      bias -= (RATE * error) / Math.sqrt(biasSquares + 1e-8)
      if (step % 500 === 0) {
        onProgress({
          stage: 'training',
          done: 0.3 + ((epoch + step / pass.length) / EPOCHS) * 0.65,
          detail: `pass ${epoch + 1} of ${EPOCHS}`,
        })
        await pause()
      }
    }
  }

  onProgress({ stage: 'testing', done: 0.97, detail: `${test.length} held-out rows` })
  await pause()
  let caught = 0
  let heldOutAttacks = 0
  let flagged = 0
  let heldOutBenign = 0
  for (const index of test) {
    const hit = sigmoid(margin(features[index]!, weights, bias)) >= threshold
    if (examples[index]!.attack) {
      heldOutAttacks++
      if (hit) caught++
    } else {
      heldOutBenign++
      if (hit) flagged++
    }
  }
  onProgress({ stage: 'testing', done: 1, detail: 'done' })
  return {
    weights,
    bias,
    attacks,
    benign,
    metrics: {
      recall: heldOutAttacks ? caught / heldOutAttacks : 0,
      falsePositiveRate: heldOutBenign ? flagged / heldOutBenign : 0,
      heldOutAttacks,
      heldOutBenign,
    },
  }
}
