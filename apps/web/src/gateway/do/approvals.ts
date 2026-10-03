import { DurableObject } from 'cloudflare:workers'
import type { ApprovalView, LiveMessage } from '@acl/shared'

export type ApprovalStatus = 'approved' | 'declined' | 'expired'

type Waiter = { resolve: (status: ApprovalStatus) => void; timer: ReturnType<typeof setTimeout> }

/**
 * One per organization. Holds requests waiting for a human decision and fans out live
 * traffic to connected dashboards over hibernatable WebSockets.
 *
 * Waiting gateway requests keep an RPC call open, so the object stays in memory while any
 * approval is pending. If it is evicted anyway, waiters see an error and treat it as expired.
 */
export class ApprovalDO extends DurableObject<Env> {
  private pending = new Map<string, ApprovalView>()
  private waiters = new Map<string, Waiter[]>()
  private dedupe = new Map<string, string>()
  /** Decisions that arrived before anyone waited (or for late joiners). */
  private decided = new Map<string, ApprovalStatus>()

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return new Response('Expected WebSocket', { status: 426 })
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1])
    pair[1].send(JSON.stringify({ type: 'hello', pending: [...this.pending.values()] }))
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === 'ping') ws.send('pong')
  }

  async webSocketClose(ws: WebSocket, code: number) {
    ws.close(code, 'closing')
  }

  publish(message: LiveMessage) {
    const data = JSON.stringify(message)
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data)
      } catch {}
    }
  }

  /**
   * Registers an approval. Requests with the same `dedupeKey` (for example the same new
   * device) share one approval instead of flooding the queue.
   */
  register(view: ApprovalView, dedupeKey?: string): { approvalId: string; created: boolean } {
    const existing = dedupeKey ? this.dedupe.get(dedupeKey) : undefined
    if (existing && this.pending.has(existing)) return { approvalId: existing, created: false }
    this.pending.set(view.id, view)
    if (dedupeKey) this.dedupe.set(dedupeKey, view.id)
    this.publish({ type: 'approval_created', approval: view })
    return { approvalId: view.id, created: true }
  }

  async wait(approvalId: string, timeoutMs: number): Promise<ApprovalStatus> {
    const done = this.decided.get(approvalId)
    if (done) return done
    if (!this.pending.has(approvalId)) return 'expired'
    return new Promise<ApprovalStatus>((resolve) => {
      const timer = setTimeout(() => this.settle(approvalId, 'expired'), timeoutMs)
      const list = this.waiters.get(approvalId) ?? []
      list.push({ resolve, timer })
      this.waiters.set(approvalId, list)
    })
  }

  decide(approvalId: string, status: 'approved' | 'declined'): boolean {
    return this.settle(approvalId, status)
  }

  listPending(): ApprovalView[] {
    return [...this.pending.values()]
  }

  private settle(approvalId: string, status: ApprovalStatus): boolean {
    const known = this.pending.delete(approvalId)
    for (const [key, id] of this.dedupe) if (id === approvalId) this.dedupe.delete(key)
    const list = this.waiters.get(approvalId) ?? []
    this.waiters.delete(approvalId)
    for (const w of list) {
      clearTimeout(w.timer)
      w.resolve(status)
    }
    if (!known && list.length === 0) return false
    this.decided.set(approvalId, status)
    if (this.decided.size > 500) {
      const oldest = this.decided.keys().next().value
      if (oldest) this.decided.delete(oldest)
    }
    this.publish({ type: 'approval_decided', approvalId, status })
    return true
  }
}

export function approvalsStub(env: Env, orgId: string) {
  return env.APPROVALS.get(env.APPROVALS.idFromName(orgId))
}
