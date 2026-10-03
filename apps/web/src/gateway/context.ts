import type { Db } from '@acl/db'
import type { DeviceStatus } from '@acl/shared'
import type { Context } from 'hono'

export type Principal = {
  userId: string
  orgId: string
  deviceId: string
  deviceStatus: DeviceStatus
}

export type AppEnv = {
  Bindings: Env
  Variables: {
    db: Db
    principal: Principal
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
