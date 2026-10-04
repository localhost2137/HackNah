import { type Db, device, member } from '@acl/db'
import { and, eq } from 'drizzle-orm'
import { getInstanceId } from '../../server/instance.ts'
import type { Principal } from '../context.ts'

/** Never trust the role or device state captured when a token was issued. */
export async function canManagePlatform(db: Db, principal: Principal): Promise<boolean> {
  if (principal.deviceStatus !== 'trusted') return false
  if (principal.orgId !== (await getInstanceId(db))) return false
  const [membership, enrolled] = await Promise.all([
    db.query.member.findFirst({
      where: and(eq(member.organizationId, principal.orgId), eq(member.userId, principal.userId)),
      columns: { role: true },
    }),
    db.query.device.findFirst({
      where: and(
        eq(device.id, principal.deviceId),
        eq(device.orgId, principal.orgId),
        eq(device.userId, principal.userId),
      ),
      columns: { status: true },
    }),
  ])
  return membership?.role === 'admin' && enrolled?.status === 'trusted'
}
