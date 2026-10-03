import { mcpCredential, mcpServer } from '@acl/db'
import {
  credentialAad,
  decryptString,
  encryptString,
  exchangeAuthorizationCode,
  randomId,
} from '@acl/shared'
import { createFileRoute } from '@tanstack/react-router'
import { and, eq, isNull } from 'drizzle-orm'
import { audit } from '#/server/audit.ts'
import { env, getDb } from '#/server/env.ts'
import { clearFlowCookie, readFlowCookie, redirectUri } from '#/server/oauth.ts'

function back(request: Request, params: Record<string, string>) {
  const url = new URL('/integrations', request.url)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new Response(null, {
    status: 302,
    headers: { location: url.toString(), 'set-cookie': clearFlowCookie },
  })
}

export const Route = createFileRoute('/api/oauth/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const flow = await readFlowCookie(request, url.searchParams.get('state'))
        if (!flow) return back(request, { error: 'The connection attempt expired. Try again.' })
        const providerError = url.searchParams.get('error')
        if (providerError)
          return back(request, {
            error: url.searchParams.get('error_description') ?? providerError,
          })
        const code = url.searchParams.get('code')
        if (!code) return back(request, { error: 'Missing authorization code' })

        const db = getDb()
        const server = await db.query.mcpServer.findFirst({
          where: and(eq(mcpServer.id, flow.serverId), eq(mcpServer.orgId, flow.orgId)),
        })
        if (!server?.oauth) return back(request, { error: 'Server no longer exists' })

        try {
          const clientSecret = server.oauth.clientSecretEnc
            ? await decryptString(
                env.ENCRYPTION_KEY,
                server.oauth.clientSecretEnc,
                `mcp-client:${server.id}`,
              )
            : null
          const tokens = await exchangeAuthorizationCode(
            { tokenUrl: server.oauth.tokenUrl, clientId: server.oauth.clientId, clientSecret },
            { code, redirectUri: redirectUri(), codeVerifier: flow.verifier },
          )
          const aad = credentialAad(server.id, flow.userId)
          await db
            .delete(mcpCredential)
            .where(
              and(
                eq(mcpCredential.mcpServerId, server.id),
                flow.userId ? eq(mcpCredential.userId, flow.userId) : isNull(mcpCredential.userId),
              ),
            )
          await db.insert(mcpCredential).values({
            id: randomId('cred'),
            orgId: flow.orgId,
            mcpServerId: server.id,
            userId: flow.userId,
            accessTokenEnc: await encryptString(env.ENCRYPTION_KEY, tokens.access_token, aad),
            refreshTokenEnc: tokens.refresh_token
              ? await encryptString(env.ENCRYPTION_KEY, tokens.refresh_token, aad)
              : null,
            expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
            accountLabel: tokens.scope ? `scopes: ${tokens.scope}` : null,
          })
          await audit(db, {
            orgId: flow.orgId,
            actorId: flow.actorId,
            action: 'mcp.credential.oauth',
            target: server.id,
            data: { shared: flow.userId === null },
          })
          return back(request, { connected: server.slug })
        } catch (err) {
          return back(request, {
            error: err instanceof Error ? err.message : 'Token exchange failed',
          })
        }
      },
    },
  },
})
