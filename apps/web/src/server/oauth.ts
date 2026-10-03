import { hmacSign, hmacVerify, randomToken, timingSafeEqual } from '@acl/shared'
import { env } from './env.ts'

export type OAuthFlowState = {
  nonce: string
  serverId: string
  orgId: string
  /** Null when an admin connects the shared org credential. */
  userId: string | null
  actorId: string
  verifier: string
  exp: number
}

const COOKIE = 'acl_mcp_oauth'
const TTL_SEC = 600

export function redirectUri(): string {
  return `${env.PUBLIC_URL}/api/oauth/callback`
}

/**
 * The PKCE verifier and flow details live in a signed, HttpOnly cookie; only the random nonce
 * travels through the provider as `state`.
 */
export async function createFlowCookie(state: Omit<OAuthFlowState, 'nonce' | 'verifier' | 'exp'>) {
  const flow: OAuthFlowState = {
    ...state,
    nonce: randomToken(16),
    verifier: randomToken(48),
    exp: Math.floor(Date.now() / 1000) + TTL_SEC,
  }
  const body = btoa(JSON.stringify(flow))
  const sig = await hmacSign(env.BETTER_AUTH_SECRET, `oauth:${body}`)
  const secure = env.PUBLIC_URL.startsWith('https://') ? '; Secure' : ''
  const cookie = `${COOKIE}=${body}.${sig}; Path=/api/oauth; HttpOnly; SameSite=Lax; Max-Age=${TTL_SEC}${secure}`
  return { flow, cookie }
}

export async function readFlowCookie(
  request: Request,
  nonce: string | null,
): Promise<OAuthFlowState | null> {
  const raw = request.headers
    .get('cookie')
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1)
  if (!raw || !nonce) return null
  const [body, sig] = raw.split('.')
  if (!body || !sig || !(await hmacVerify(env.BETTER_AUTH_SECRET, `oauth:${body}`, sig)))
    return null
  const flow = JSON.parse(atob(body)) as OAuthFlowState
  if (flow.exp * 1000 < Date.now() || !timingSafeEqual(flow.nonce, nonce)) return null
  return flow
}

export const clearFlowCookie = `${COOKIE}=; Path=/api/oauth; HttpOnly; SameSite=Lax; Max-Age=0`
