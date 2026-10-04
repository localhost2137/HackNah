import { type Db, mcpCredential, type mcpServer } from '@acl/db'
import { credentialAad, decryptString, encryptString, refreshAccessToken } from '@acl/shared'
import { and, eq, isNull } from 'drizzle-orm'

type Server = typeof mcpServer.$inferSelect

export class MissingCredentialError extends Error {}

/** Refresh a little early so a token doesn't expire mid-call. */
const EXPIRY_SKEW_MS = 60_000

/**
 * Returns the bearer token to use for `server` on behalf of `userId`, refreshing OAuth tokens
 * when needed. `null` means the server needs no auth.
 */
export async function upstreamToken(
  env: Env,
  db: Db,
  server: Server,
  userId: string,
): Promise<string | null> {
  if (server.authType === 'none') return null
  const owner = server.credentialMode === 'org' ? null : userId
  const row = await db.query.mcpCredential.findFirst({
    where: and(
      eq(mcpCredential.mcpServerId, server.id),
      owner ? eq(mcpCredential.userId, owner) : isNull(mcpCredential.userId),
    ),
  })
  if (!row) {
    throw new MissingCredentialError(
      owner
        ? `Connect your ${server.name} account in the Hack?Nah! dashboard (Integrations).`
        : `${server.name} has no credential configured.`,
    )
  }
  const aad = credentialAad(server.id, row.userId)
  const fresh = !row.expiresAt || row.expiresAt.getTime() - EXPIRY_SKEW_MS > Date.now()
  if (fresh || !row.refreshTokenEnc || !server.oauth)
    return decryptString(env.ENCRYPTION_KEY, row.accessTokenEnc, aad)

  const clientSecret = server.oauth.clientSecretEnc
    ? await decryptString(
        env.ENCRYPTION_KEY,
        server.oauth.clientSecretEnc,
        `mcp-client:${server.id}`,
      )
    : null
  const refreshed = await refreshAccessToken(
    { tokenUrl: server.oauth.tokenUrl, clientId: server.oauth.clientId, clientSecret },
    await decryptString(env.ENCRYPTION_KEY, row.refreshTokenEnc, aad),
  )
  await db
    .update(mcpCredential)
    .set({
      accessTokenEnc: await encryptString(env.ENCRYPTION_KEY, refreshed.access_token, aad),
      refreshTokenEnc: refreshed.refresh_token
        ? await encryptString(env.ENCRYPTION_KEY, refreshed.refresh_token, aad)
        : row.refreshTokenEnc,
      expiresAt: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000) : null,
    })
    .where(eq(mcpCredential.id, row.id))
  return refreshed.access_token
}
