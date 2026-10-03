import { member, organization, session as sessionTable } from '@acl/db'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { asc, eq } from 'drizzle-orm'
import { createAuth } from '../auth.ts'
import { getDb } from '../env.ts'

export type Viewer = {
  user: { id: string; name: string; email: string }
  activeOrgId: string | null
  orgs: { id: string; name: string; slug: string; role: string }[]
}

/** The signed-in user and their organizations, or null when signed out. */
export const getViewer = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Viewer | null> => {
    const db = getDb()
    const session = await createAuth(db).api.getSession({ headers: getRequest().headers })
    if (!session) return null
    const orgs = await db
      .select({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        role: member.role,
      })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(eq(member.userId, session.user.id))
      .orderBy(asc(member.createdAt))
    let activeOrgId = session.session.activeOrganizationId ?? null
    // SSO sign-in creates the session before it adds the membership, so the first session of a
    // provisioned user has no active org yet.
    if (!activeOrgId && orgs[0]) {
      activeOrgId = orgs[0].id
      await db
        .update(sessionTable)
        .set({ activeOrganizationId: activeOrgId })
        .where(eq(sessionTable.id, session.session.id))
    }
    return {
      user: { id: session.user.id, name: session.user.name, email: session.user.email },
      activeOrgId,
      orgs,
    }
  },
)
