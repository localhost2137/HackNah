import type { Db } from '@acl/db'

/** Internal compatibility scope for policy, SSO and gateway records. Never user-selectable. */
export async function getInstanceId(db: Db): Promise<string> {
  const rows = await db.query.organization.findMany({ columns: { id: true }, limit: 2 })
  if (rows.length !== 1)
    throw new Error('Apply the single-tenant database migration before starting the app.')
  return rows[0]!.id
}
