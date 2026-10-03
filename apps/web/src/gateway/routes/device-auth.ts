import { device, deviceCode, gatewayRefreshToken } from '@acl/db'
import { HEADER_DEVICE_FINGERPRINT, randomId, randomToken, sha256Hex } from '@acl/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { type AppEnv, clientInfo } from '../context.ts'
import { issueAccessToken, requireGatewayToken } from '../lib/auth.ts'

const DEVICE_CODE_TTL_SEC = 600
const POLL_INTERVAL_SEC = 5
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789'

function userCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  const chars = [...bytes].map((b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length])
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`
}

const codeRequest = z.object({
  /** Stable machine fingerprint computed by the plugin. Never stored as-is. */
  fingerprint: z.string().min(16).max(512),
  label: z.string().min(1).max(120),
  platform: z.string().max(60).optional(),
})

/**
 * OAuth 2.0 device authorization grant (RFC 8628). The plugin shows the user code, the user
 * approves it in the dashboard while logged in, and the plugin polls for tokens.
 */
export const deviceAuth = new Hono<AppEnv>()
  .post('/device/code', async (c) => {
    const body = codeRequest.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const code = randomToken(32)
    const user = userCode()
    const info = clientInfo(c)
    await c
      .get('db')
      .insert(deviceCode)
      .values({
        deviceCodeHash: await sha256Hex(code),
        userCode: user,
        fingerprintHash: await sha256Hex(body.data.fingerprint),
        deviceLabel: body.data.label,
        platform: body.data.platform ?? null,
        ip: info.ip,
        country: info.country,
        expiresAt: new Date(Date.now() + DEVICE_CODE_TTL_SEC * 1000),
      })
    const verificationUri = `${c.env.PUBLIC_URL}/device`
    return c.json({
      device_code: code,
      user_code: user,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?code=${user}`,
      expires_in: DEVICE_CODE_TTL_SEC,
      interval: POLL_INTERVAL_SEC,
    })
  })
  .post('/device/token', async (c) => {
    const body = z
      .object({ device_code: z.string() })
      .safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const db = c.get('db')
    const hash = await sha256Hex(body.data.device_code)
    const row = await db.query.deviceCode.findFirst({ where: eq(deviceCode.deviceCodeHash, hash) })
    if (!row) return c.json({ error: 'invalid_grant' }, 400)
    if (row.expiresAt.getTime() < Date.now()) return c.json({ error: 'expired_token' }, 400)
    if (row.status === 'pending') return c.json({ error: 'authorization_pending' }, 400)
    if (row.status === 'denied') return c.json({ error: 'access_denied' }, 400)
    if (row.status === 'consumed' || !row.userId || !row.orgId)
      return c.json({ error: 'invalid_grant' }, 400)

    const consumed = await db
      .update(deviceCode)
      .set({ status: 'consumed' })
      .where(and(eq(deviceCode.deviceCodeHash, hash), eq(deviceCode.status, 'approved')))
      .returning({ hash: deviceCode.deviceCodeHash })
    if (consumed.length === 0) return c.json({ error: 'invalid_grant' }, 400)

    const dev = await db.query.device.findFirst({
      where: and(eq(device.userId, row.userId), eq(device.fingerprintHash, row.fingerprintHash)),
    })
    if (!dev || dev.status === 'revoked') return c.json({ error: 'access_denied' }, 400)
    return c.json(
      await issueTokens(c.env, db, { userId: row.userId, orgId: row.orgId, device: dev }),
    )
  })
  .post('/refresh', async (c) => {
    const body = z
      .object({ refresh_token: z.string() })
      .safeParse(await c.req.json().catch(() => null))
    const fingerprint = c.req.header(HEADER_DEVICE_FINGERPRINT)
    if (!body.success || !fingerprint) return c.json({ error: 'invalid_request' }, 400)
    const db = c.get('db')
    const tokenHash = await sha256Hex(body.data.refresh_token)
    const row = await db.query.gatewayRefreshToken.findFirst({
      where: eq(gatewayRefreshToken.tokenHash, tokenHash),
    })
    if (!row || row.expiresAt.getTime() < Date.now()) return c.json({ error: 'invalid_grant' }, 400)

    if (row.revokedAt) {
      // A rotated refresh token came back: someone copied it. Kill every token of the device.
      await db
        .update(gatewayRefreshToken)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(gatewayRefreshToken.deviceId, row.deviceId),
            isNull(gatewayRefreshToken.revokedAt),
          ),
        )
      return c.json(
        { error: 'invalid_grant', error_description: 'Refresh token reuse detected' },
        400,
      )
    }

    const dev = await db.query.device.findFirst({ where: eq(device.id, row.deviceId) })
    if (!dev || dev.status === 'revoked') return c.json({ error: 'access_denied' }, 400)
    if (dev.fingerprintHash !== (await sha256Hex(fingerprint)))
      return c.json(
        { error: 'invalid_grant', error_description: 'Device fingerprint mismatch' },
        400,
      )

    await db
      .update(gatewayRefreshToken)
      .set({ revokedAt: new Date() })
      .where(eq(gatewayRefreshToken.id, row.id))
    return c.json(
      await issueTokens(c.env, db, { userId: row.userId, orgId: row.orgId, device: dev }),
    )
  })
  .get('/whoami', requireGatewayToken(), (c) => c.json(c.get('principal')))

async function issueTokens(
  env: Env,
  db: AppEnv['Variables']['db'],
  args: { userId: string; orgId: string; device: typeof device.$inferSelect },
) {
  const access = await issueAccessToken(env, {
    sub: args.userId,
    org: args.orgId,
    dev: args.device.id,
    fph: args.device.fingerprintHash,
  })
  const refresh = randomToken(32)
  const ttl = Number(env.REFRESH_TOKEN_TTL_SEC) || 2_592_000
  await db.insert(gatewayRefreshToken).values({
    id: randomId('rt'),
    tokenHash: await sha256Hex(refresh),
    orgId: args.orgId,
    userId: args.userId,
    deviceId: args.device.id,
    expiresAt: new Date(Date.now() + ttl * 1000),
  })
  await db.update(device).set({ lastSeenAt: new Date() }).where(eq(device.id, args.device.id))
  return {
    access_token: access.token,
    token_type: 'Bearer',
    expires_in: access.expiresIn,
    refresh_token: refresh,
    device_id: args.device.id,
    device_status: args.device.status,
  }
}
