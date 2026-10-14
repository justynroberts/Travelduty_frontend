interface Entry<V> {
  value: V;
  storedAt: number;
}

export interface CacheResult<V> {
  value: V;
  /** True when the loader failed and a value past its TTL was served instead. */
  stale: boolean;
}

export interface LoadOptions {
  ttlMs: number;
  /** How long past the TTL a value may still be served if a refresh fails. */
  staleIfErrorMs?: number;
}

/**
 * In-memory TTL cache with stale-if-error semantics. Used in front of external APIs so a
 * brief third-party outage degrades data freshness instead of failing requests.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();

  constructor(
    private readonly maxEntries = 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  async getOrLoad(key: string, loader: () => Promise<V>, opts: LoadOptions): Promise<CacheResult<V>> {
    const entry = this.entries.get(key);
    const age = entry ? this.now() - entry.storedAt : Infinity;
    if (entry && age < opts.ttlMs) return { value: entry.value, stale: false };

    try {
      return { value: await this.load(key, loader), stale: false };
    } catch (err) {
      if (entry && age < opts.ttlMs + (opts.staleIfErrorMs ?? 0)) return { value: entry.value, stale: true };
      throw err;
    }
  }

  set(key: string, value: V) {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.delete(key);
    this.entries.set(key, { value, storedAt: this.now() });
  }

  clear() {
    this.entries.clear();
  }

  /** Concurrent misses for the same key share one upstream call. */
  private load(key: string, loader: () => Promise<V>): Promise<V> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = loader()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}
