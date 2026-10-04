const FORWARD_REQUEST_HEADERS = [
  'anthropic-version',
  'anthropic-beta',
  'content-type',
  'accept',
  'x-stainless-retry-count',
]
const DROP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'set-cookie',
])

export type UpstreamTarget = { baseUrl: string; apiKey: string | null }

export function upstreamRequest(
  env: Env,
  target: UpstreamTarget,
  incoming: Request,
  path: string,
  body?: BodyInit | null,
): Request {
  const url = new URL(incoming.url)
  const base = target.baseUrl.endsWith('/') ? target.baseUrl : `${target.baseUrl}/`
  const destination = new URL(path.replace(/^\//, '') + url.search, base)
  const headers = new Headers()
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = incoming.headers.get(name)
    if (value) headers.set(name, value)
  }
  if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01')
  if (target.apiKey) {
    // Anthropic's own API takes x-api-key; OpenRouter and compatible servers take a bearer token.
    if (destination.hostname === 'api.anthropic.com') headers.set('x-api-key', target.apiKey)
    else headers.set('authorization', `Bearer ${target.apiKey}`)
  }
  headers.set('http-referer', env.PUBLIC_URL)
  headers.set('x-title', 'Hack?Nah!')
  return new Request(destination, {
    method: incoming.method,
    headers,
    body: body === undefined ? incoming.body : body,
  })
}

export function clientResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers()
  for (const [name, value] of upstream)
    if (!DROP_RESPONSE_HEADERS.has(name)) headers.set(name, value)
  return headers
}

/** Reads a stream to text, keeping at most `maxBytes`. Always drains the stream. */
export async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let out = ''
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (size < maxBytes) {
      out += decoder.decode(value.subarray(0, maxBytes - size), { stream: true })
    }
    size += value.byteLength
  }
  return out + decoder.decode()
}
