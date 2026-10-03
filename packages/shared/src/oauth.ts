export type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
}

export type OAuthClient = { tokenUrl: string; clientId: string; clientSecret: string | null }

async function tokenRequest(
  client: OAuthClient,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const body = new URLSearchParams({ ...params, client_id: client.clientId })
  if (client.clientSecret) body.set('client_secret', client.clientSecret)
  const res = await fetch(client.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  })
  const text = await res.text()
  let json: Partial<TokenResponse> & { error?: string; error_description?: string }
  try {
    json = JSON.parse(text)
  } catch {
    // GitHub answers form-encoded unless asked otherwise; handle both.
    json = Object.fromEntries(new URLSearchParams(text)) as typeof json
  }
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(`Token endpoint error: ${json.error_description ?? json.error ?? res.status}`)
  }
  return {
    ...json,
    expires_in: json.expires_in ? Number(json.expires_in) : undefined,
  } as TokenResponse
}

export function exchangeAuthorizationCode(
  client: OAuthClient,
  args: { code: string; redirectUri: string; codeVerifier: string },
): Promise<TokenResponse> {
  return tokenRequest(client, {
    grant_type: 'authorization_code',
    code: args.code,
    redirect_uri: args.redirectUri,
    code_verifier: args.codeVerifier,
  })
}

export function refreshAccessToken(
  client: OAuthClient,
  refreshToken: string,
): Promise<TokenResponse> {
  return tokenRequest(client, { grant_type: 'refresh_token', refresh_token: refreshToken })
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  let bin = ''
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Additional-data string binding an encrypted credential to its server and owner. */
export function credentialAad(serverId: string, userId: string | null): string {
  return `mcp:${serverId}:${userId ?? 'org'}`
}
