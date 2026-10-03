import type { GatewayEvent } from '@acl/shared'
import startHandler from '@tanstack/react-start/server-entry'
import { consumeEvents, GATEWAY_PATH, gatewayApp } from './gateway/app.ts'

export { ApprovalDO, RateLimiterDO, SessionDO } from './gateway/app.ts'

/** One Worker: the gateway (Claude Code traffic) and the dashboard share the same origin. */
export default {
  fetch(request, env, ctx) {
    if (GATEWAY_PATH.test(new URL(request.url).pathname)) return gatewayApp.fetch(request, env, ctx)
    return startHandler.fetch(request)
  },
  queue: (batch, env) => consumeEvents(batch, env),
} satisfies ExportedHandler<Env, GatewayEvent>
