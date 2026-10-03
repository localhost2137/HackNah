import { approval, auditLog, type Db, device } from '@acl/db'
import { and, eq } from 'drizzle-orm'
import { approvalsStub } from './do/approvals.ts'
import { invalidateDeviceStatus } from './lib/auth.ts'

export { refreshServerTools } from './routes/mcp.ts'
export { invalidateDeviceStatus }

/** Hands the dashboard's live-updates WebSocket to the org's ApprovalDO. */
export function openLiveSocket(env: Env, orgId: string, request: Request): Promise<Response> {
  return approvalsStub(env, orgId).fetch(request)
}

/**
 * Records the decision, trusts the device when the approval was a new-device one, and wakes
 * the gateway request that is waiting on it.
 */
export async function decideApproval(
  env: Env,
  db: Db,
  args: { orgId: string; approvalId: string; status: 'approved' | 'declined'; decidedBy: string },
): Promise<{ delivered: boolean }> {
  const [row] = await db
    .update(approval)
    .set({ status: args.status, decidedBy: args.decidedBy, decidedAt: new Date() })
    .where(
      and(
        eq(approval.id, args.approvalId),
        eq(approval.orgId, args.orgId),
        eq(approval.status, 'pending'),
      ),
    )
    .returning()
  if (!row) throw new Error('Approval not found or already decided')

  if (row.trustsDevice && row.deviceId && args.status === 'approved') {
    await db
      .update(device)
      .set({ status: 'trusted', approvedBy: args.decidedBy, approvedAt: new Date() })
      .where(and(eq(device.id, row.deviceId), eq(device.status, 'pending')))
    invalidateDeviceStatus(row.deviceId)
  }
  await db.insert(auditLog).values({
    orgId: args.orgId,
    actorId: args.decidedBy,
    action: `approval.${args.status}`,
    target: row.id,
    data: { eventId: row.eventId, userId: row.userId, trustsDevice: row.trustsDevice },
  })
  const delivered = await approvalsStub(env, args.orgId).decide(row.id, args.status)
  return { delivered }
}
