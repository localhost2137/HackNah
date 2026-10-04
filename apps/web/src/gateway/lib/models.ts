import { type Db, model } from '@acl/db'
import { decryptString, findModel, type ModelEntry, modelKeyAad } from '@acl/shared'
import { asc, eq } from 'drizzle-orm'
import { TtlCache } from './cache.ts'

export type CatalogModel = ModelEntry & { apiKeyEnc: string | null }

const catalogCache = new TtlCache<CatalogModel[]>(10_000)

/** The org's model catalog, in routing order. */
export function loadModels(db: Db, orgId: string): Promise<CatalogModel[]> {
  return catalogCache.get(orgId, async () => {
    const rows = await db.query.model.findMany({
      where: eq(model.orgId, orgId),
      orderBy: [asc(model.position), asc(model.createdAt)],
    })
    return rows.map((r) => ({
      id: r.id,
      pattern: r.pattern,
      label: r.label,
      kind: r.kind,
      baseUrl: r.baseUrl,
      upstreamModel: r.upstreamModel,
      inputUsdPerMTok: r.inputUsdPerMTok,
      outputUsdPerMTok: r.outputUsdPerMTok,
      cacheWriteUsdPerMTok: r.cacheWriteUsdPerMTok,
      cacheReadUsdPerMTok: r.cacheReadUsdPerMTok,
      gpuUsdPerHour: r.gpuUsdPerHour,
      enabled: r.enabled,
      apiKeyEnc: r.apiKeyEnc,
    }))
  })
}

/** Where one model request goes. `apiKey` null sends no authorization (a local server). */
export type UpstreamRoute = {
  baseUrl: string
  apiKey: string | null
  /** Model id to send upstream. */
  model: string
  entry: CatalogModel | null
}

/**
 * Routes a model id through the catalog. An empty catalog sends everything to the default
 * upstream, as before the catalog existed; otherwise a model outside it is refused.
 */
export async function routeModel(
  env: Env,
  catalog: CatalogModel[],
  requested: string,
): Promise<UpstreamRoute | { error: string }> {
  const fallback = { baseUrl: env.UPSTREAM_BASE_URL, apiKey: env.OPENROUTER_API_KEY }
  if (catalog.length === 0) return { ...fallback, model: requested, entry: null }
  const entry = findModel(catalog, requested) as CatalogModel | null
  if (!entry) return { error: `Model ${requested} is not in the organization's model catalog` }
  const apiKey = entry.apiKeyEnc
    ? await decryptString(env.ENCRYPTION_KEY, entry.apiKeyEnc, modelKeyAad(entry.id))
    : entry.baseUrl
      ? null
      : fallback.apiKey
  return {
    baseUrl: entry.baseUrl || fallback.baseUrl,
    apiKey,
    model: entry.upstreamModel || requested,
    entry,
  }
}
