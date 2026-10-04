import { createDb } from '@acl/db'
import { HEADER_TRACE_ID } from '@acl/shared'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppEnv } from './context.ts'
import { deviceAuth } from './routes/device-auth.ts'
import { mcp } from './routes/mcp.ts'
import { messages } from './routes/messages.ts'
import { pluginApi } from './routes/session.ts'

export { consumeEvents } from './consumer.ts'
export { ApprovalDO } from './do/approvals.ts'
export { RateLimiterDO } from './do/rate-limiter.ts'
export { SessionDO } from './do/session.ts'

/** Paths served by the gateway; everything else is the dashboard. */
export const GATEWAY_PATH = /^\/(v1|mcp|auth|health)(\/|$)/

export const gatewayApp = new Hono<AppEnv>()
  .use('*', async (c, next) => {
    c.set('db', createDb(c.env.DB))
    await next()
    const traceId = c.get('traceId')
    if (traceId) c.res.headers.set(HEADER_TRACE_ID, traceId)
  })
  .get('/health', (c) => c.json({ ok: true }))
  .use('/auth/*', cors({ origin: (origin, c) => (origin === c.env.PUBLIC_URL ? origin : null) }))
  .route('/auth', deviceAuth)
  .route('/v1/acl', pluginApi)
  .route('/v1', messages)
  .route('/mcp', mcp)
  .onError((err, c) => {
    console.error(err)
    return c.json({ type: 'error', error: { type: 'api_error', message: 'Gateway error' } }, 500)
  })
