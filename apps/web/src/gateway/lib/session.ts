import { HEADER_CC_SESSION_ID, HEADER_SESSION_ID } from '@acl/shared'
import type { AppContext } from '../context.ts'
import { type SessionState, sessionStub } from '../do/session.ts'

const SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/

export type ResolvedSession = { id: string; state: SessionState } | { id: null; state: null }

/**
 * Finds the Claude Code session for this request and pins it to the caller. A session id
 * reused by another user or device is rejected, which stops replaying someone else's session.
 */
export async function resolveSession(
  c: AppContext,
  fallbackId: string | null = null,
): Promise<ResolvedSession | { error: string }> {
  const raw = c.req.header(HEADER_SESSION_ID) ?? c.req.header(HEADER_CC_SESSION_ID) ?? fallbackId
  if (!raw) return { id: null, state: null }
  if (!SESSION_ID.test(raw)) return { error: 'Malformed session id' }
  const p = c.get('principal')
  const res = await sessionStub(c.env, p.orgId, raw).touch({
    orgId: p.orgId,
    userId: p.userId,
    deviceId: p.deviceId,
  })
  if (!res.ok) return { error: res.reason }
  return { id: raw, state: res.state }
}
