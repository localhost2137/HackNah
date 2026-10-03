import { member } from '@acl/db'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { and, eq } from 'drizzle-orm'
import { createAuth } from '../auth.ts'
import { getDb } from '../env.ts'
import { getInstanceId } from '../instance.ts'

export type Viewer = {
  user: { id: string; name: string; email: string }
  role: string | null
}

export const getViewer = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Viewer | null> => {
    const db = getDb()
    const session = await createAuth(db).api.getSession({ headers: getRequest().headers })
    if (!session) return null
    const instanceId = await getInstanceId(db)
    const membership = await db.query.member.findFirst({
      where: and(eq(member.organizationId, instanceId), eq(member.userId, session.user.id)),
    })
    return {
      user: { id: session.user.id, name: session.user.name, email: session.user.email },
      role: membership?.role ?? null,
    }
  },
)
