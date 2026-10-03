import { member } from '@acl/db'
import { redirect } from '@tanstack/react-router'
import { createMiddleware } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { and, eq } from 'drizzle-orm'
import { createAuth } from './auth.ts'
import { getDb } from './env.ts'

export const authMiddleware = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  const db = getDb()
  const auth = createAuth(db)
  const session = await auth.api.getSession({ headers: getRequest().headers })
  if (!session) throw redirect({ to: '/login' })
  return next({ context: { db, auth, user: session.user, session: session.session } })
})

export const orgMiddleware = createMiddleware({ type: 'function' })
  .middleware([authMiddleware])
  .server(async ({ next, context }) => {
    const orgId = context.session.activeOrganizationId
    if (!orgId) throw redirect({ to: '/onboarding' })
    const membership = await context.db.query.member.findFirst({
      where: and(eq(member.organizationId, orgId), eq(member.userId, context.user.id)),
    })
    if (!membership) throw redirect({ to: '/onboarding' })
    const isAdmin = membership.role === 'admin'
    return next({ context: { orgId, role: membership.role, isAdmin } })
  })

export const adminMiddleware = createMiddleware({ type: 'function' })
  .middleware([orgMiddleware])
  .server(async ({ next, context }) => {
    if (!context.isAdmin) throw new Error('Only organization admins can do this')
    return next()
  })
