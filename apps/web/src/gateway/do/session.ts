import { DurableObject } from 'cloudflare:workers'

export type SessionState = {
  orgId: string
  userId: string
  deviceId: string
  resourceIds: string[]
  startedAt: string
}

/**
 * One Claude Code session. Pins the session to the user and device that started it, holds the
 * resource scope picked with `/acl resources`, and the redaction vault so placeholders stay
 * stable for the whole conversation.
 */
export class SessionDO extends DurableObject<Env> {
  async touch(owner: {
    orgId: string
    userId: string
    deviceId: string
  }): Promise<{ ok: true; state: SessionState; created: boolean } | { ok: false; reason: string }> {
    const existing = await this.ctx.storage.get<SessionState>('state')
    if (existing) {
      if (existing.userId !== owner.userId || existing.orgId !== owner.orgId)
        return { ok: false, reason: 'Session belongs to a different user' }
      if (existing.deviceId !== owner.deviceId)
        return { ok: false, reason: 'Session was started on a different device' }
      return { ok: true, state: existing, created: false }
    }
    const state: SessionState = { ...owner, resourceIds: [], startedAt: new Date().toISOString() }
    await this.ctx.storage.put('state', state)
    return { ok: true, state, created: true }
  }

  async setResources(resourceIds: string[]): Promise<SessionState | null> {
    const state = await this.ctx.storage.get<SessionState>('state')
    if (!state) return null
    const next = { ...state, resourceIds: [...new Set(resourceIds)] }
    await this.ctx.storage.put('state', next)
    return next
  }

  /** Placeholder -> original value. */
  async getVault(): Promise<Record<string, string>> {
    return (await this.ctx.storage.get<Record<string, string>>('vault')) ?? {}
  }

  async saveVault(entries: Record<string, string>): Promise<void> {
    await this.ctx.storage.put('vault', entries)
  }
}

export function sessionStub(env: Env, orgId: string, sessionId: string) {
  return env.SESSIONS.get(env.SESSIONS.idFromName(`${orgId}:${sessionId}`))
}
