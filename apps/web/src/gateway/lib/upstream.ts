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

export function upstreamRequest(
  env: Env,
  incoming: Request,
  path: string,
  body?: BodyInit | null,
): Request {
  const url = new URL(incoming.url)
  const target = new URL(path + url.search, env.UPSTREAM_BASE_URL)
  const headers = new Headers()
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = incoming.headers.get(name)
    if (value) headers.set(name, value)
  }
  if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01')
  headers.set('authorization', `Bearer ${env.OPENROUTER_API_KEY}`)
  headers.set('http-referer', env.PUBLIC_URL)
  headers.set('x-title', 'AI Control Layer')
  return new Request(target, {
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
