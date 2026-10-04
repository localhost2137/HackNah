import {
  baselineSignatures,
  mergeSignatures,
  type Signature,
  signature,
  signatureFeed,
} from '@acl/shared'

const REFRESH_MS = 30_000
const FETCH_TIMEOUT_MS = 3000

export type SignatureSet = {
  signatures: Signature[]
  /** Per feed URL: how many signatures it delivered, or why it could not be read. */
  feeds: { url: string; count: number; version: string; error?: string }[]
  loadedAt: number
}

let current: SignatureSet = { signatures: baselineSignatures, feeds: [], loadedAt: 0 }
let lastGood = new Map<string, Signature[]>()
let refreshing: Promise<SignatureSet> | null = null

/** Entries that fail validation are dropped one by one; the rest of the feed still loads. */
async function fetchFeed(url: string): Promise<{ signatures: Signature[]; version: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as { version?: unknown; signatures?: unknown[] }
  const whole = signatureFeed.safeParse(body)
  if (whole.success) return { signatures: whole.data.signatures, version: whole.data.version }
  if (!Array.isArray(body.signatures)) throw new Error('not a signature feed')
  const valid = body.signatures.flatMap((entry) => {
    const parsed = signature.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
  return { signatures: valid, version: typeof body.version === 'string' ? body.version : '' }
}

async function refresh(urls: string[]): Promise<SignatureSet> {
  const feeds: SignatureSet['feeds'] = []
  const lists: Signature[][] = []
  const good = new Map<string, Signature[]>()
  await Promise.all(
    urls.map(async (url) => {
      try {
        const feed = await fetchFeed(url)
        good.set(url, feed.signatures)
        lists.push(feed.signatures)
        feeds.push({ url, count: feed.signatures.length, version: feed.version })
      } catch (err) {
        // An unreachable feed keeps its last delivered signatures instead of dropping them.
        const kept = lastGood.get(url) ?? []
        good.set(url, kept)
        lists.push(kept)
        feeds.push({
          url,
          count: kept.length,
          version: '',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }),
  )
  lastGood = good
  current = {
    signatures: mergeSignatures(baselineSignatures, ...lists),
    feeds,
    loadedAt: Date.now(),
  }
  return current
}

/**
 * The built-in baseline plus every feed in `SIGNATURE_FEED_URL` (comma-separated). Feeds are
 * re-read every 30 seconds, so a signature added upstream takes effect without a deploy.
 */
export async function loadSignatures(
  env: Partial<Pick<Env, 'SIGNATURE_FEED_URL'>>,
): Promise<SignatureSet> {
  const urls = (env.SIGNATURE_FEED_URL ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
  if (urls.length === 0) return current
  if (Date.now() - current.loadedAt < REFRESH_MS) return current
  refreshing ??= refresh(urls).finally(() => {
    refreshing = null
  })
  // Only the very first load waits; later refreshes happen behind the current set.
  return current.loadedAt === 0 ? refreshing : current
}
