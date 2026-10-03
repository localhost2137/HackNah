import { DurableObject } from 'cloudflare:workers'

export type RateLimitResult = { allowed: boolean; remaining: number; resetAt: number }

/**
 * Sliding-window counter (two fixed windows, weighted). One instance per
 * (org, rule, subject) so hot keys don't contend with each other.
 */
export class RateLimiterDO extends DurableObject<Env> {
  async hit(limit: number, windowSec: number): Promise<RateLimitResult> {
    const windowMs = windowSec * 1000
    const now = Date.now()
    const current = Math.floor(now / windowMs)
    const stored = (await this.ctx.storage.get<{ window: number; count: number; prev: number }>(
      'w',
    )) ?? {
      window: current,
      count: 0,
      prev: 0,
    }
    let { count, prev } = stored
    if (stored.window !== current) {
      prev = stored.window === current - 1 ? stored.count : 0
      count = 0
    }
    const elapsed = (now % windowMs) / windowMs
    const estimated = prev * (1 - elapsed) + count
    const resetAt = (current + 1) * windowMs
    if (estimated >= limit) {
      await this.ctx.storage.put('w', { window: current, count, prev })
      return { allowed: false, remaining: 0, resetAt }
    }
    count += 1
    await this.ctx.storage.put('w', { window: current, count, prev })
    return { allowed: true, remaining: Math.max(0, Math.floor(limit - estimated - 1)), resetAt }
  }
}
