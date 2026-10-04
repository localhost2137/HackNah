import { createDb } from '@acl/db'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppEnv } from './context.ts'
import { currentNonce, requestJti } from './plugin/dpop.ts'
import { responseSigner, signResponse } from './plugin/response-signing.ts'
import { deviceAuth } from './routes/device-auth.ts'
import { mcp } from './routes/mcp.ts'
import { messages } from './routes/messages.ts'
import { plugin } from './routes/plugin.ts'
import { pluginApi } from './routes/session.ts'

export { consumeEvents } from './consumer.ts'
export { ApprovalDO } from './do/approvals.ts'
export { RateLimiterDO } from './do/rate-limiter.ts'
export { SessionDO } from './do/session.ts'

/** Paths served by the gateway; everything else is the dashboard. */
export const GATEWAY_PATH =
  /^\/(v1|mcp|auth|health|llm|authorize|token|challenge|\.well-known\/hy-platform)(\/|$)/

const NULL_BODY_STATUS = new Set([101, 204, 205, 304])

export const gatewayApp = new Hono<AppEnv>()
  .use('*', async (c, next) => {
    c.set('db', createDb(c.env.DB))
    await next()
  })
  // The plugin protocol on every response: a fresh DPoP nonce, and for a request that carried a
  // proof, a signature over the status and body, bound to that proof. Streams are relayed as
  // they come and are not signed.
  .use('*', async (c, next) => {
    await next()
    const nonce = await currentNonce(c.env.JWT_SECRET)
    const proof = c.req.header('dpop')
    const signer = proof ? await responseSigner(c.env) : null
    const stream = (c.res.headers.get('content-type') ?? '').includes('text/event-stream')
    if (!proof || !signer || stream) {
      // Responses relayed from an upstream have immutable headers.
      const res = new Response(c.res.body, c.res)
      res.headers.set('DPoP-Nonce', nonce)
      c.res = undefined
      c.res = res
      return
    }
    const { status } = c.res
    const body = new Uint8Array(await c.res.arrayBuffer())
    const headers = new Headers(c.res.headers)
    headers.set('DPoP-Nonce', nonce)
    headers.set('Cache-Control', 'no-store')
    headers.set(
      'HY-Response-Signature',
      await signResponse(signer, requestJti(proof), status, body),
    )
    c.res = undefined
    c.res = new Response(NULL_BODY_STATUS.has(status) ? null : body, { status, headers })
  })
  .get('/health', (c) => c.json({ ok: true }))
  .use('/auth/*', cors({ origin: (origin, c) => (origin === c.env.PUBLIC_URL ? origin : null) }))
  .route('/auth', deviceAuth)
  .route('/v1/acl', pluginApi)
  // Before the model proxy, whose catch-all would forward `/v1/policy` and friends upstream.
  .route('/', plugin)
  .route('/v1', messages)
  .route('/llm/v1', messages)
  .route('/mcp', mcp)
  .onError((err, c) => {
    console.error(err)
    return c.json({ type: 'error', error: { type: 'api_error', message: 'Gateway error' } }, 500)
  })
