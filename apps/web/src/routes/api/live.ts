import { member } from '@acl/db'
import { createFileRoute } from '@tanstack/react-router'
import { and, eq } from 'drizzle-orm'
import { openLiveSocket } from '#/gateway/control.ts'
import { createAuth } from '#/server/auth.ts'
import { env, getDb } from '#/server/env.ts'

/**
 * WebSocket for live events and approvals. Authenticates the dashboard session, then hands
 * the upgrade to the org's ApprovalDO.
 */
export const Route = createFileRoute('/api/live')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
          return new Response('Expected WebSocket', { status: 426 })
        const db = getDb()
        const session = await createAuth(db).api.getSession({ headers: request.headers })
        const orgId = session?.session.activeOrganizationId
        if (!session || !orgId) return new Response('Unauthorized', { status: 401 })
        const membership = await db.query.member.findFirst({
          where: and(eq(member.organizationId, orgId), eq(member.userId, session.user.id)),
        })
        if (!membership || !['owner', 'admin'].includes(membership.role))
          return new Response('Forbidden', { status: 403 })
        return openLiveSocket(env, orgId, request)
      },
    },
  },
})
