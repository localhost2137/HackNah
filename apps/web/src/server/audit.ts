import { auditLog, type Db } from '@acl/db'

export async function audit(
  db: Db,
  entry: {
    orgId: string
    actorId: string
    action: string
    target?: string
    data?: Record<string, unknown>
  },
) {
  await db.insert(auditLog).values({
    orgId: entry.orgId,
    actorId: entry.actorId,
    action: entry.action,
    target: entry.target ?? null,
    data: entry.data ?? null,
  })
}
