import { DurableObject } from 'cloudflare:workers'

export type RateLimitResult = { allowed: boolean; remaining: number; resetAt: number }
export type CounterReading = { used: number; resetAt: number }

type Window = { window: number; count: number; prev: number }

/** A concurrency lease nobody released (a crashed request) frees itself after this long. */
const LEASE_TTL_MS = 10 * 60_000

/**
 * One counter per (org, limit, target, subject) so hot keys don't contend with each other.
 * Requests, tokens, USD and GPU-seconds share the same sliding window (two fixed windows,
 * weighted); concurrency is a set of leases.
 */
export class RateLimiterDO extends DurableObject<Env> {
  async #read(windowSec: number): Promise<Window & { estimated: number; resetAt: number }> {
    const windowMs = windowSec * 1000
    const now = Date.now()
    const current = Math.floor(now / windowMs)
    const stored = (await this.ctx.storage.get<Window>('w')) ?? {
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
    return {
      window: current,
      count,
      prev,
      estimated: prev * (1 - elapsed) + count,
      resetAt: (current + 1) * windowMs,
    }
  }

  /** Counts one request. With `enforce`, a request past the limit is refused and not counted. */
  async hit(limit: number, windowSec: number, enforce = true): Promise<RateLimitResult> {
    const w = await this.#read(windowSec)
    if (enforce && w.estimated >= limit) {
      await this.ctx.storage.put('w', { window: w.window, count: w.count, prev: w.prev })
      return { allowed: false, remaining: 0, resetAt: w.resetAt }
    }
    await this.ctx.storage.put('w', { window: w.window, count: w.count + 1, prev: w.prev })
    return {
      allowed: w.estimated < limit,
      remaining: Math.max(0, Math.floor(limit - w.estimated - 1)),
      resetAt: w.resetAt,
    }
  }

  /** Usage so far in the window, before this request. */
  async peek(windowSec: number): Promise<CounterReading> {
    const w = await this.#read(windowSec)
    return { used: w.estimated, resetAt: w.resetAt }
  }

  /** Adds tokens, USD or GPU-seconds once the upstream has answered. */
  async add(amount: number, windowSec: number): Promise<CounterReading> {
    const w = await this.#read(windowSec)
    await this.ctx.storage.put('w', { window: w.window, count: w.count + amount, prev: w.prev })
    return { used: w.estimated + amount, resetAt: w.resetAt }
  }

  /**
   * Takes a concurrency slot. Returns how many were in use before; with `enforce`, a request at
   * the limit gets no slot.
   */
  async acquire(
    limit: number,
    leaseId: string,
    enforce = true,
  ): Promise<{ acquired: boolean; inUse: number }> {
    const now = Date.now()
    const leases = Object.fromEntries(
      Object.entries((await this.ctx.storage.get<Record<string, number>>('leases')) ?? {}).filter(
        ([, at]) => now - at < LEASE_TTL_MS,
      ),
    )
    const inUse = Object.keys(leases).length
    if (enforce && inUse >= limit) {
      await this.ctx.storage.put('leases', leases)
      return { acquired: false, inUse }
    }
    leases[leaseId] = now
    await this.ctx.storage.put('leases', leases)
    return { acquired: true, inUse }
  }

  async release(leaseId: string): Promise<void> {
    const leases = (await this.ctx.storage.get<Record<string, number>>('leases')) ?? {}
    delete leases[leaseId]
    await this.ctx.storage.put('leases', leases)
  }
}
