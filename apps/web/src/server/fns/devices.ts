import { device, deviceCode, gatewayRefreshToken, user } from '@acl/db'
import { randomId } from '@acl/shared'
import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { invalidateDeviceStatus } from '#/gateway/control.ts'
import { audit } from '../audit.ts'
import { adminMiddleware, orgMiddleware } from '../middleware.ts'

export const listDevices = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async ({ context: { db, orgId, isAdmin, user: me } }) => {
    return db
      .select({ device, userName: user.name, userEmail: user.email })
      .from(device)
      .innerJoin(user, eq(user.id, device.userId))
      .where(and(eq(device.orgId, orgId), isAdmin ? undefined : eq(device.userId, me.id)))
      .orderBy(desc(device.createdAt))
  })

export const setDeviceStatus = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ id: z.string(), status: z.enum(['trusted', 'revoked']) }))
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    const [row] = await db
      .update(device)
      .set(
        data.status === 'trusted'
          ? { status: 'trusted', approvedBy: me.id, approvedAt: new Date() }
          : { status: 'revoked' },
      )
      .where(and(eq(device.id, data.id), eq(device.orgId, orgId)))
      .returning()
    if (!row) throw new Error('Device not found')
    if (data.status === 'revoked') {
      await db
        .update(gatewayRefreshToken)
        .set({ revokedAt: new Date() })
        .where(and(eq(gatewayRefreshToken.deviceId, row.id), isNull(gatewayRefreshToken.revokedAt)))
    }
    invalidateDeviceStatus(row.id)
    await audit(db, {
      orgId,
      actorId: me.id,
      action: `device.${data.status}`,
      target: row.id,
      data: { label: row.label },
    })
    return row
  })

const userCodeSchema = z
  .string()
  .transform((s) => s.toUpperCase().replace(/[^A-Z0-9]/g, ''))
  .pipe(z.string().length(8))
  .transform((s) => `${s.slice(0, 4)}-${s.slice(4)}`)

export const lookupDeviceCode = createServerFn({ method: 'GET' })
  .middleware([orgMiddleware])
  .validator(z.object({ userCode: userCodeSchema }))
  .handler(async ({ data, context: { db, user: me } }) => {
    const row = await db.query.deviceCode.findFirst({
      where: and(
        eq(deviceCode.userCode, data.userCode),
        eq(deviceCode.status, 'pending'),
        gt(deviceCode.expiresAt, new Date()),
      ),
    })
    if (!row) return null
    const known = await db.query.device.findFirst({
      where: and(eq(device.userId, me.id), eq(device.fingerprintHash, row.fingerprintHash)),
    })
    return {
      userCode: row.userCode,
      label: row.deviceLabel,
      platform: row.platform,
      ip: row.ip,
      country: row.country,
      expiresAt: row.expiresAt,
      knownDevice: known ? { label: known.label, status: known.status } : null,
    }
  })

/**
 * Approves a plugin login. The first device of a user is trusted right away (they just proved
 * who they are in the dashboard). Any later new device starts as `pending` and its first
 * request goes to the approvals queue: that is the "login from a different computer" check.
 */
export const decideDeviceCode = createServerFn({ method: 'POST' })
  .middleware([orgMiddleware])
  .validator(z.object({ userCode: userCodeSchema, approve: z.boolean() }))
  .handler(async ({ data, context: { db, orgId, user: me } }) => {
    const row = await db.query.deviceCode.findFirst({
      where: and(
        eq(deviceCode.userCode, data.userCode),
        eq(deviceCode.status, 'pending'),
        gt(deviceCode.expiresAt, new Date()),
      ),
    })
    if (!row) throw new Error('This code is invalid or has expired')

    if (!data.approve) {
      await db
        .update(deviceCode)
        .set({ status: 'denied' })
        .where(eq(deviceCode.deviceCodeHash, row.deviceCodeHash))
      return { status: 'denied' as const }
    }

    let dev = await db.query.device.findFirst({
      where: and(eq(device.userId, me.id), eq(device.fingerprintHash, row.fingerprintHash)),
    })
    if (dev?.status === 'revoked') throw new Error('This device was revoked by an administrator')
    if (!dev) {
      const trusted = await db.query.device.findFirst({
        where: and(eq(device.userId, me.id), eq(device.orgId, orgId), eq(device.status, 'trusted')),
      })
      ;[dev] = await db
        .insert(device)
        .values({
          id: randomId('dev'),
          orgId,
          userId: me.id,
          fingerprintHash: row.fingerprintHash,
          label: row.deviceLabel,
          platform: row.platform,
          status: trusted ? 'pending' : 'trusted',
          firstSeenIp: row.ip,
          firstSeenCountry: row.country,
        })
        .returning()
    }
    await db
      .update(deviceCode)
      .set({ status: 'approved', orgId, userId: me.id })
      .where(eq(deviceCode.deviceCodeHash, row.deviceCodeHash))
    await audit(db, {
      orgId,
      actorId: me.id,
      action: 'device.login',
      target: dev!.id,
      data: { label: row.deviceLabel },
    })
    return { status: 'approved' as const, deviceStatus: dev!.status }
  })
