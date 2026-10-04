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

  /**
   * Adds placeholders to the vault. Requests of one session run in parallel (tool results, the
   * output guard), so entries are merged rather than the whole vault replaced.
   */
  async mergeVault(entries: Record<string, string>): Promise<void> {
    const vault = (await this.ctx.storage.get<Record<string, string>>('vault')) ?? {}
    await this.ctx.storage.put('vault', { ...vault, ...entries })
  }

  /** Short-lived notes between stages, e.g. a tool call's verdict for the hook to reuse. */
  async remember(key: string, value: unknown, ttlMs: number): Promise<void> {
    const now = Date.now()
    await this.ctx.storage.put(`memo:${key}`, { value, expires: now + ttlMs })
    const memos = await this.ctx.storage.list<{ expires: number }>({ prefix: 'memo:', limit: 200 })
    const stale = [...memos].filter(([, m]) => m.expires < now).map(([k]) => k)
    if (stale.length) await this.ctx.storage.delete(stale)
  }

  async recall(key: string): Promise<unknown> {
    const memo = await this.ctx.storage.get<{ value: unknown; expires: number }>(`memo:${key}`)
    return memo && memo.expires > Date.now() ? memo.value : null
  }
}

export function sessionStub(env: Env, orgId: string, sessionId: string) {
  return env.SESSIONS.get(env.SESSIONS.idFromName(`${orgId}:${sessionId}`))
}
