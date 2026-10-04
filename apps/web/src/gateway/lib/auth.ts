import { device } from '@acl/db'
import {
  anthropicError,
  type DeviceStatus,
  type GatewayTokenClaims,
  HEADER_DEVICE_FINGERPRINT,
  sha256Hex,
  signJwt,
  verifyJwt,
} from '@acl/shared'
import { eq } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../context.ts'
import { TtlCache } from './cache.ts'

const deviceStatusCache = new TtlCache<'trusted' | 'pending' | 'revoked' | null>(10_000)

export function bearerToken(headers: Headers): string | null {
  const auth = headers.get('authorization')
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  return headers.get('x-api-key')
}

/**
 * Authenticates a gateway access token and works out the device status:
 * - `mismatch`: the fingerprint header doesn't match the one the token was issued to (stolen token)
 * - `new`: the device is enrolled but still waiting for an admin approval
 * Revoked devices are rejected here, whatever the guardrail says.
 */
export const requireGatewayToken = (format: 'anthropic' | 'json' = 'json') =>
  createMiddleware<AppEnv>(async (c, next) => {
    const deny = (status: 401 | 403, message: string) =>
      format === 'anthropic'
        ? c.json(
            anthropicError(status === 401 ? 'authentication_error' : 'permission_error', message),
            status,
          )
        : c.json({ error: message }, status)

    const token = bearerToken(c.req.raw.headers)
    if (!token) return deny(401, 'Missing gateway token. Run `/acl login` in Claude Code.')
    const claims = await verifyJwt<GatewayTokenClaims>(c.env.JWT_SECRET, token)
    if (!claims) return deny(401, 'Gateway token is invalid or expired.')

    const fingerprint = c.req.header(HEADER_DEVICE_FINGERPRINT)
    const presented = fingerprint ? await sha256Hex(fingerprint) : null

    const db = c.get('db')
    const stored = await deviceStatusCache.get(claims.dev, async () => {
      const row = await db.query.device.findFirst({
        where: eq(device.id, claims.dev),
        columns: { status: true },
      })
      return row?.status ?? null
    })
    if (!stored) return deny(401, 'Device is no longer enrolled.')
    if (stored === 'revoked') return deny(403, 'This device was revoked by an administrator.')

    let deviceStatus: DeviceStatus
    if (presented !== claims.fph) deviceStatus = 'mismatch'
    else if (stored === 'pending') deviceStatus = 'new'
    else deviceStatus = 'trusted'

    c.set('principal', {
      userId: claims.sub,
      orgId: claims.org,
      deviceId: claims.dev,
      deviceStatus,
    })
    await next()
  })

export function invalidateDeviceStatus(deviceId: string) {
  deviceStatusCache.delete(deviceId)
}

export async function issueAccessToken(
  env: Env,
  claims: Omit<GatewayTokenClaims, 'iat' | 'exp'>,
): Promise<{ token: string; expiresIn: number }> {
  const ttl = Number(env.ACCESS_TOKEN_TTL_SEC) || 900
  const iat = Math.floor(Date.now() / 1000)
  return {
    token: await signJwt(env.JWT_SECRET, { ...claims, iat, exp: iat + ttl }),
    expiresIn: ttl,
  }
}
