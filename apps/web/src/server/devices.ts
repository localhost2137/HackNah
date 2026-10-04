import { type Db, device, gatewayRefreshToken, pluginRefreshToken } from '@acl/db'
import { and, eq, isNull } from 'drizzle-orm'
import { invalidateDeviceStatus } from '#/gateway/control.ts'

/** Revokes every device a user enrolled in the org, with their refresh tokens. */
export async function revokeUserDevices(db: Db, orgId: string, userId: string) {
  const revoked = await db
    .update(device)
    .set({ status: 'revoked' })
    .where(and(eq(device.orgId, orgId), eq(device.userId, userId)))
    .returning({ id: device.id })
  for (const { id } of revoked) {
    await db
      .update(gatewayRefreshToken)
      .set({ revokedAt: new Date() })
      .where(and(eq(gatewayRefreshToken.deviceId, id), isNull(gatewayRefreshToken.revokedAt)))
    await db
      .update(pluginRefreshToken)
      .set({ revokedAt: new Date() })
      .where(and(eq(pluginRefreshToken.deviceId, id), isNull(pluginRefreshToken.revokedAt)))
    invalidateDeviceStatus(id)
  }
}
