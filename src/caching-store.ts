/**
 * @module caching-store
 *
 * LRU byte-level cache that wraps a zarrita AsyncReadable store.
 * Intercepts store.get() calls to cache raw chunk bytes (Uint8Array),
 * so all zarr operations (zarr.get slicing, array.getChunk, queries)
 * benefit from caching transparently.
 */

import type { AsyncReadable, GetOptions, RangeQuery } from '@zarrita/storage'

type AbsolutePath = `/${string}`

interface CacheEntry {
  data: Uint8Array
  byteSize: number
}

/**
 * Called on every access with the cache key and the caller's options (as
 * passed by zarrita: `{ signal }`), so listeners can tell requests apart.
 */
export type AccessListener = (cacheKey: string, opts?: GetOptions) => void

/** Default chunk-cache budget (100 MB), used when no valid budget is given. */
export const DEFAULT_CHUNK_CACHE_BYTES = 100 * 1024 * 1024

/**
 * Validate a cache budget. Returns the budget with fractions floored, or
 * `null` when it is invalid (non-finite or negative). `0` is valid. Shared
 * by the constructor options and every `setMax*Bytes` setter so they agree
 * on what "invalid" means: constructors fall back to the default, setters
 * ignore the value and keep the current budget.
 */
export function validCacheBytes(bytes: number): number | null {
  return Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : null
}

export class CachingStore implements AsyncReadable {
  private cache: Map<string, CacheEntry> = new Map()
  private totalBytes: number = 0
  private _maxBytes: number
  private baseStore: AsyncReadable
  private accessListeners: Set<AccessListener> = new Set()

  constructor(
    baseStore: AsyncReadable,
    maxBytes: number = DEFAULT_CHUNK_CACHE_BYTES
  ) {
    this.baseStore = baseStore
    // Callers (ZarrStore) validate and warn; this only guards against an
    // unbounded or NaN budget.
    this._maxBytes = validCacheBytes(maxBytes) ?? DEFAULT_CHUNK_CACHE_BYTES
  }

  /** Current byte budget. */
  get maxBytes(): number {
    return this._maxBytes
  }

  /**
   * Change the byte budget of a live cache. Fractional values are floored;
   * an invalid value (non-finite or negative, see `validCacheBytes`) is
   * ignored with a warning and the current budget is kept.
   *
   * - Shrinking evicts least-recently-used entries immediately until the
   *   cache fits the new budget.
   * - Growing never evicts; the extra room is filled by subsequent fetches.
   * - `0` evicts everything. The store keeps wrapping the base store, and (as
   *   with any entry larger than the budget) the single most recent fetch is
   *   still retained so `getRange` on a sharded file does not refetch the
   *   whole shard for every inner chunk. Restoring a positive budget later
   *   resumes normal caching, so `setMaxBytes(0)` followed by
   *   `setMaxBytes(previous)` acts as a "clear cache".
   */
  setMaxBytes(bytes: number): void {
    const next = validCacheBytes(bytes)
    if (next === null) {
      console.warn(
        `[zarr-layer] Ignoring invalid chunk cache budget ${bytes}; ` +
          `keeping ${this._maxBytes} bytes.`
      )
      return
    }
    const shrinking = next < this._maxBytes
    this._maxBytes = next
    // An explicit 0 always empties, including an entry retained while the
    // budget was already 0.
    if (shrinking || next === 0) this.evictUntilFits(0)
  }

  /**
   * Register a listener invoked with the cache key on every get/getRange call,
   * after the entry has been resolved (whether served from cache or freshly
   * fetched). Returns a disposer that removes the listener.
   *
   * Used by ZarrLayer to attribute fetched chunks to time-step indices for
   * cache-status reporting that survives LRU eviction.
   */
  addAccessListener(fn: AccessListener): () => void {
    this.accessListeners.add(fn)
    return () => {
      this.accessListeners.delete(fn)
    }
  }

  private notifyAccess(cacheKey: string, opts?: GetOptions): void {
    for (const fn of this.accessListeners) fn(cacheKey, opts)
  }

  async get(
    key: AbsolutePath,
    opts?: GetOptions
  ): Promise<Uint8Array | undefined> {
    const cached = this.cache.get(key)
    if (cached) {
      // LRU: move to end of Map (most recently used)
      this.cache.delete(key)
      this.cache.set(key, cached)
      this.notifyAccess(key, opts)
      return cached.data
    }

    const result = await this.baseStore.get(key, opts)
    if (result !== undefined) {
      this.evictUntilFits(result.byteLength)
      const entry: CacheEntry = { data: result, byteSize: result.byteLength }
      this.cache.set(key, entry)
      this.totalBytes += result.byteLength
      this.notifyAccess(key, opts)
    }
    return result
  }

  async getRange(
    key: AbsolutePath,
    range: RangeQuery,
    opts?: GetOptions
  ): Promise<Uint8Array | undefined> {
    // Fetch the full file and slice in memory rather than issuing HTTP Range
    // requests. Multi-hop proxy chains (jupyter-server-proxy) do not reliably
    // forward Range headers, causing 416 errors for sharded zarr v3 reads.
    // The full file is cached by get(), so all inner-chunk reads after the
    // first hit the LRU cache without any additional network requests.
    const full = await this.get(key, opts)
    if (!full) return undefined
    if ('suffixLength' in range) {
      const start = full.length - range.suffixLength
      return full.slice(start >= 0 ? start : 0)
    }
    return full.slice(range.offset, range.offset + range.length)
  }

  /** Check if a key is in the cache. */
  has(key: string): boolean {
    return this.cache.has(key)
  }

  /** Check cache status for multiple keys. */
  getStatus(keys: string[]): ('cached' | 'missing')[] {
    return keys.map((k) => (this.cache.has(k) ? 'cached' : 'missing'))
  }

  /** Total bytes currently stored in the cache. */
  getTotalBytes(): number {
    return this.totalBytes
  }

  /** Number of entries in the cache. */
  get size(): number {
    return this.cache.size
  }

  /** Clear all cached data. */
  clear(): void {
    this.cache.clear()
    this.totalBytes = 0
  }

  private rangeKey(key: string, range: RangeQuery): string {
    if ('suffixLength' in range) {
      return `${key}:suffix-${range.suffixLength}`
    }
    return `${key}:${range.offset}-${range.offset + range.length}`
  }

  private evictUntilFits(newBytes: number): void {
    while (this.totalBytes + newBytes > this._maxBytes && this.cache.size > 0) {
      const oldest = this.cache.keys().next().value
      if (!oldest) break
      const entry = this.cache.get(oldest)!
      this.totalBytes -= entry.byteSize
      this.cache.delete(oldest)
    }
  }
}
