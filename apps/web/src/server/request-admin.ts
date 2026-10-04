import { member } from '@acl/db'
import { and, eq } from 'drizzle-orm'
import { createAuth } from './auth.ts'
import { getDb } from './env.ts'
import { getInstanceId } from './instance.ts'

/** The signed-in admin, from the session cookie; null for anyone else. */
export async function requestAdmin(request: Request) {
  const db = getDb()
  const session = await createAuth(db).api.getSession({ headers: request.headers })
  if (!session) return null
  const orgId = await getInstanceId(db)
  const membership = await db.query.member.findFirst({
    where: and(eq(member.organizationId, orgId), eq(member.userId, session.user.id)),
  })
  return membership?.role === 'admin' ? { db, orgId, userId: session.user.id } : null
}
