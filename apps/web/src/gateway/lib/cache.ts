/**
 * Per-isolate TTL cache. Config changes made in the dashboard take effect within `ttlMs`
 * without a round trip to D1 on every request.
 */
export class TtlCache<V> {
  private store = new Map<string, { value: V; expires: number }>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 1000,
  ) {}

  async get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.store.get(key)
    if (hit && hit.expires > Date.now()) return hit.value
    const value = await load()
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value
      if (oldest !== undefined) this.store.delete(oldest)
    }
    this.store.set(key, { value, expires: Date.now() + this.ttlMs })
    return value
  }

  delete(key: string) {
    this.store.delete(key)
  }
}
