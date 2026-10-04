import { type Db, model } from '@acl/db'
import {
  anthropicErrorFromOpenAI,
  decryptString,
  findModel,
  fromOpenAIResponse,
  type MessagesRequest,
  type ModelEntry,
  modelKeyAad,
  openAIStreamToAnthropic,
  toOpenAIRequest,
} from '@acl/shared'
import { asc, eq } from 'drizzle-orm'
import { TtlCache } from './cache.ts'
import { upstreamRequest } from './upstream.ts'

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
      apiFormat: r.apiFormat,
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
  format: 'anthropic' | 'openai'
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
  if (catalog.length === 0)
    return { ...fallback, model: requested, format: 'anthropic', entry: null }
  const entry = findModel(catalog, requested) as CatalogModel | null
  if (!entry) return { error: `Model ${requested} is not in the organization's model catalog` }
  const apiKey = entry.apiKeyEnc
    ? await decryptString(env.ENCRYPTION_KEY, entry.apiKeyEnc, modelKeyAad(entry.id))
    : entry.baseUrl
      ? null
      : fallback.apiKey
  // The default upstream is OpenRouter, which serves both formats; its OpenAI API lives under /v1.
  const defaultBase =
    entry.apiFormat === 'openai' ? `${fallback.baseUrl.replace(/\/$/, '')}/v1` : fallback.baseUrl
  return {
    baseUrl: entry.baseUrl || defaultBase,
    apiKey,
    model: entry.upstreamModel || requested,
    format: entry.apiFormat,
    entry,
  }
}

/**
 * Sends a Messages request to the route's upstream and answers in the Anthropic format whatever
 * the upstream speaks: an `openai` upstream gets chat completions and its answer is translated
 * back, stream included.
 */
export async function fetchMessages(
  env: Env,
  route: UpstreamRoute,
  incoming: Request,
  body: MessagesRequest,
): Promise<Response> {
  if (route.format === 'anthropic')
    return fetch(upstreamRequest(env, route, incoming, '/v1/messages', JSON.stringify(body)))
  const request = upstreamRequest(
    env,
    route,
    incoming,
    '/chat/completions',
    JSON.stringify(toOpenAIRequest(body, route.model)),
  )
  const upstream = await fetch(request)
  if (!upstream.ok || !upstream.body) {
    const raw = await upstream.text().catch(() => '')
    return Response.json(anthropicErrorFromOpenAI(upstream.status, raw), {
      status: upstream.status || 502,
    })
  }
  if (body.stream === true)
    return new Response(openAIStreamToAnthropic(upstream.body, route.model), {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
    })
  return Response.json(fromOpenAIResponse(await upstream.json(), route.model))
}

export function invalidateModelCache(orgId: string) {
  catalogCache.delete(orgId)
}
