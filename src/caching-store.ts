/**
 * @module caching-store
 *
 * LRU byte-level cache that wraps a zarrita AsyncReadable store.
 * Intercepts store.get() calls to cache raw chunk bytes (Uint8Array),
 * so all zarr operations (zarr.get slicing, array.getChunk, queries)
 * benefit from caching transparently.
 */

import type { AsyncReadable } from '@zarrita/storage'

type AbsolutePath = `/${string}`
type RangeQuery = { offset: number; length: number } | { suffixLength: number }

interface CacheEntry {
  data: Uint8Array
  byteSize: number
}

export class CachingStore implements AsyncReadable<RequestInit> {
  private cache: Map<string, CacheEntry> = new Map()
  private totalBytes: number = 0
  readonly maxBytes: number
  private baseStore: AsyncReadable<RequestInit>

  constructor(
    baseStore: AsyncReadable<RequestInit>,
    maxBytes: number = 100 * 1024 * 1024 // 100 MB default
  ) {
    this.baseStore = baseStore
    this.maxBytes = maxBytes
  }

  async get(
    key: AbsolutePath,
    opts?: RequestInit
  ): Promise<Uint8Array | undefined> {
    const cached = this.cache.get(key)
    if (cached) {
      // LRU: move to end of Map (most recently used)
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached.data
    }

    const result = await this.baseStore.get(key, opts)
    if (result !== undefined) {
      this.evictUntilFits(result.byteLength)
      const entry: CacheEntry = { data: result, byteSize: result.byteLength }
      this.cache.set(key, entry)
      this.totalBytes += result.byteLength
    }
    return result
  }

  async getRange(
    key: AbsolutePath,
    range: RangeQuery,
    opts?: RequestInit
  ): Promise<Uint8Array | undefined> {
    // For sharded zarr v3, chunk reads may go through getRange.
    // Cache with a composite key that includes the range.
    const rangeKey = this.rangeKey(key, range)
    const cached = this.cache.get(rangeKey)
    if (cached) {
      this.cache.delete(rangeKey)
      this.cache.set(rangeKey, cached)
      return cached.data
    }

    const result = await this.baseStore.getRange?.(key, range, opts)
    if (result !== undefined) {
      this.evictUntilFits(result.byteLength)
      const entry: CacheEntry = { data: result, byteSize: result.byteLength }
      this.cache.set(rangeKey, entry)
      this.totalBytes += result.byteLength
    }
    return result
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
    while (this.totalBytes + newBytes > this.maxBytes && this.cache.size > 0) {
      const oldest = this.cache.keys().next().value
      if (!oldest) break
      const entry = this.cache.get(oldest)!
      this.totalBytes -= entry.byteSize
      this.cache.delete(oldest)
    }
  }
}
