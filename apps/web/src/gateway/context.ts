import type { Db } from '@acl/db'
import type { DeviceStatus, RequestSignals } from '@acl/shared'
import type { Context } from 'hono'
import type { PluginRequest } from './plugin/auth.ts'

export type Principal = {
  userId: string
  orgId: string
  deviceId: string
  deviceStatus: DeviceStatus
  /**
   * What the device proved about itself and its session when it authenticated with a key-bound
   * token. Absent for bearer tokens, where guardrail checks on these signals are skipped.
   */
  signals?: RequestSignals
}

export type AppEnv = {
  Bindings: Env
  Variables: {
    db: Db
    principal: Principal
    /** Set when the request was authenticated with a DPoP proof (the hy-guard plugin). */
    plugin: PluginRequest | undefined
  }
}

export type AppContext = Context<AppEnv>

/** Client metadata recorded on every event. */
export function clientInfo(c: AppContext) {
  const cf = (c.req.raw as { cf?: { country?: string } }).cf
  return {
    ip: c.req.header('cf-connecting-ip') ?? null,
    country: cf?.country ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  }
}
