import { mcpServer, member } from '@acl/db'
import { pkceChallenge } from '@acl/shared'
import { createFileRoute } from '@tanstack/react-router'
import { and, eq } from 'drizzle-orm'
import { createAuth } from '#/server/auth.ts'
import { getDb } from '#/server/env.ts'
import { createFlowCookie, redirectUri } from '#/server/oauth.ts'

/** Starts the OAuth authorization-code flow (with PKCE) to connect an MCP server account. */
export const Route = createFileRoute('/api/oauth/start/$serverId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const db = getDb()
        const session = await createAuth(db).api.getSession({ headers: request.headers })
        const orgId = session?.session.activeOrganizationId
        if (!session || !orgId) return Response.redirect(new URL('/login', request.url), 302)

        const server = await db.query.mcpServer.findFirst({
          where: and(eq(mcpServer.id, params.serverId), eq(mcpServer.orgId, orgId)),
        })
        if (server?.authType !== 'oauth2' || !server.oauth)
          return new Response('Not an OAuth server', { status: 400 })

        const membership = await db.query.member.findFirst({
          where: and(eq(member.organizationId, orgId), eq(member.userId, session.user.id)),
        })
        if (!membership) return new Response('Forbidden', { status: 403 })
        const shared = server.credentialMode === 'org'
        if (shared && membership.role === 'member')
          return new Response('Only admins can connect the shared account', { status: 403 })

        const { flow, cookie } = await createFlowCookie({
          serverId: server.id,
          orgId,
          userId: shared ? null : session.user.id,
          actorId: session.user.id,
        })
        const url = new URL(server.oauth.authorizeUrl)
        url.searchParams.set('response_type', 'code')
        url.searchParams.set('client_id', server.oauth.clientId)
        url.searchParams.set('redirect_uri', redirectUri())
        url.searchParams.set('state', flow.nonce)
        url.searchParams.set('code_challenge', await pkceChallenge(flow.verifier))
        url.searchParams.set('code_challenge_method', 'S256')
        if (server.oauth.scopes.length) url.searchParams.set('scope', server.oauth.scopes.join(' '))
        if (server.oauth.authorizeUrl.includes('atlassian')) {
          url.searchParams.set('audience', 'api.atlassian.com')
          url.searchParams.set('prompt', 'consent')
        }
        return new Response(null, {
          status: 302,
          headers: { location: url.toString(), 'set-cookie': cookie },
        })
      },
    },
  },
})
