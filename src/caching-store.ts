/**
 * @module caching-store
 *
 * Byte-level cache that wraps a zarrita AsyncReadable store. Evicts in LRU
 * order, optionally by priority tier first (see `setEvictionPolicy`).
 * Intercepts store.get() / getRange() calls to cache raw bytes (Uint8Array),
 * so all zarr operations (zarr.get slicing, array.getChunk, queries)
 * benefit from caching transparently.
 *
 * Two ways to read a byte range (sharded zarr v3 reads a shard's index with a
 * suffix range, then each inner chunk with an offset range):
 * - full-object mode (the default): getRange downloads the whole object with
 *   get(), caches it under its key and slices it in memory.
 * - range mode (`rangeRequests: true`): getRange asks the base store for just
 *   those bytes and caches them under a range key (see `rangeCacheKey`).
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
 * For a range read in range mode the key is the range key (see
 * `rangeCacheKey`); for one served from a whole cached object it is the
 * object's key.
 */
export type AccessListener = (cacheKey: string, opts?: GetOptions) => void

/**
 * Eviction priorities (see `CachingStore.setEvictionPolicy`). When the cache
 * is over budget, entries of the lowest tier go first, least recently used
 * first within a tier; a higher tier is only touched once every lower one is
 * empty.
 */
export interface EvictionPolicy {
  /**
   * Tier of a cache key. Higher = kept longer. Called for every entry each
   * time an eviction is needed, so it must be cheap (a Set lookup). A
   * non-finite result counts as 0.
   */
  priority(cacheKey: string): number
  /** Called for each entry evicted to make room, with its tier and size. */
  onEvict?(cacheKey: string, priority: number, byteSize: number): void
}

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

/**
 * Separator between an object key and its range in range cache keys: NUL,
 * which cannot occur in a zarr key (an object key containing `#` or `:` is
 * never mistaken for a range key).
 */
export const RANGE_KEY_SEPARATOR = '\u0000'

/**
 * Cache key of a byte range of `key` in range mode:
 * `<key>\0<offset>:<length>` or `<key>\0suffix:<length>` (see
 * `RANGE_KEY_SEPARATOR`). It is what the access listener reports and what
 * `has` / `getEntryBytes` take for that range.
 *
 * Keys name byte positions, not content: like the whole-object cache, this
 * assumes objects do not change while cached. A suffix key in particular
 * names "the last N bytes", which would silently go stale if the object
 * were rewritten with another length.
 */
export function rangeCacheKey(key: string, range: RangeQuery): string {
  return 'suffixLength' in range
    ? `${key}${RANGE_KEY_SEPARATOR}suffix:${range.suffixLength}`
    : `${key}${RANGE_KEY_SEPARATOR}${range.offset}:${range.length}`
}

/**
 * Delay before the one retry of a failed range read: a random value in
 * [RANGE_RETRY_DELAY_MS, 3 × RANGE_RETRY_DELAY_MS), so the reads of a failed
 * burst don't all retry in the same instant.
 */
export const RANGE_RETRY_DELAY_MS = 250

/** The default retry delay (see RANGE_RETRY_DELAY_MS). */
export const jitteredRetryDelayMs = (): number =>
  RANGE_RETRY_DELAY_MS * (1 + 2 * Math.random())

/** Wait `ms`, rejecting with an AbortError if `signal` aborts first. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Thrown by a range-capable fetch when a server answered a Range request
 * with the whole object (200 instead of 206), as a proxy that drops the
 * Range header does. Carries the body, so the caller can use it as the full
 * object instead of downloading it again. See `createFetchStore`.
 */
export class RangeIgnoredError extends Error {
  readonly data: Uint8Array
  constructor(url: string, data: Uint8Array) {
    super(`Range request answered with the whole object: ${url}`)
    this.name = 'RangeIgnoredError'
    this.data = data
  }
}

/**
 * Thrown by a range-capable fetch when a server rejects a Range request
 * (416 Range Not Satisfiable). See `createFetchStore`.
 */
export class RangeNotSatisfiableError extends Error {
  constructor(url: string) {
    super(`Range request rejected (416): ${url}`)
    this.name = 'RangeNotSatisfiableError'
  }
}

/**
 * Thrown by a range-capable fetch when a server rate-limits a Range request
 * (429). Not retried: retrying in step makes it worse; the caller refetches
 * later (ace-viz task 44 owns backoff). See `createFetchStore`.
 */
export class RangeRateLimitedError extends Error {
  constructor(url: string) {
    super(`Range request rate-limited (429): ${url}`)
    this.name = 'RangeRateLimitedError'
  }
}

/**
 * Range reads that failed with a network-level error (TypeError) on their
 * last attempt, in a row, on a store where no range read has succeeded yet,
 * after which `console.error` says the deployment may not allow Range (once
 * per store). A first attempt whose retry succeeds doesn't count, so a blip
 * under many concurrent reads stays quiet. A TypeError never
 * switches modes: from JS a CORS refusal looks exactly like a network blip.
 */
export const RANGE_NETWORK_FAILURES_BEFORE_ERROR = 6

/**
 * Request header marking a background (prefetch) read, so the request gate
 * serves render reads first (ace-viz task 49; see `request-gate.ts`, whose
 * `gatedFetch` removes it before the request leaves). Set by the
 * CachingStore on base-store reads its background classifier picks, and
 * only with `markBackground` (a base store whose requests go through
 * `gatedFetch`): any other store would send it.
 */
export const BACKGROUND_REQUEST_HEADER = 'x-zarr-layer-background'

/** GetOptions as passed down to a base store (FetchStore takes headers). */
type BaseGetOptions = GetOptions & { headers?: Record<string, string> }

export interface CachingStoreOptions {
  /**
   * Read byte ranges with range requests to the base store (its `getRange`)
   * instead of downloading whole objects. Default false. Falls back to the
   * whole object, and stays there for the rest of the store's life, when
   * the server ignores (200) or rejects (416) a range; see `getRange`.
   */
  rangeRequests?: boolean
  /**
   * Delay before the one retry of a failed range read, in ms. Default:
   * `jitteredRetryDelayMs` (250–750 ms). Tests pass `() => 0`.
   */
  retryDelayMs?: () => number
  /**
   * The base store sends its requests through `gatedFetch`, so reads picked
   * by `setBackgroundClassifier` may carry `BACKGROUND_REQUEST_HEADER`.
   * Default false (the classifier is then ignored).
   */
  markBackground?: boolean
}

/** A base-store fetch shared by every concurrent miss on one cache key. */
interface InflightFetch<T> {
  promise: Promise<T>
  /** Aborts the base-store request; used when the last waiter aborts. */
  controller: AbortController
  /** Callers currently awaiting `promise` (those without a signal never leave). */
  waiters: number
  settled: boolean
}

/** A range read's bytes and the cache key they are attributed to. */
interface RangeResult {
  data: Uint8Array
  cacheKey: string
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

// By name rather than instanceof, so errors from another copy of this
// module (e.g. a second bundle) are recognised too
const errorName = (err: unknown): string | undefined =>
  (err as { name?: unknown } | null)?.name as string | undefined

function ignoredRangeBody(err: unknown): Uint8Array | null {
  const data = (err as { data?: unknown } | null)?.data
  return errorName(err) === 'RangeIgnoredError' && data instanceof Uint8Array
    ? data
    : null
}

function sliceRange(full: Uint8Array, range: RangeQuery): Uint8Array {
  if ('suffixLength' in range) {
    const start = full.length - range.suffixLength
    return full.slice(start >= 0 ? start : 0)
  }
  return full.slice(range.offset, range.offset + range.length)
}

export class CachingStore implements AsyncReadable {
  private cache: Map<string, CacheEntry> = new Map()
  private totalBytes: number = 0
  private _maxBytes: number
  private baseStore: AsyncReadable
  private accessListeners: Set<AccessListener> = new Set()
  /** Base-store fetches in flight, by cache key (see get() / getRange()). */
  private inflight: Map<string, InflightFetch<unknown>> = new Map()
  /**
   * Whether getRange issues range requests. Starts as the `rangeRequests`
   * option (when the base store has getRange) and turns off for good when
   * the server ignores or rejects a range.
   */
  private _rangeRequests: boolean
  /** Whether any range entry was ever stored (see dropRangesOf). */
  private usedRanges: boolean = false
  private readonly retryDelayMs: () => number
  /** Whether a range read has ever succeeded (only for the error below). */
  private rangeSucceeded: boolean = false
  /** Failed range attempts with a TypeError since the last success. */
  private networkFailures: number = 0
  private reportedNetworkFailures: boolean = false
  /** Eviction tiers; null = plain LRU. */
  private evictionPolicy: EvictionPolicy | null = null
  private readonly markBackground: boolean
  private isBackground: ((opts?: GetOptions) => boolean) | null = null

  constructor(
    baseStore: AsyncReadable,
    maxBytes: number = DEFAULT_CHUNK_CACHE_BYTES,
    options: CachingStoreOptions = {}
  ) {
    this.baseStore = baseStore
    // Callers (ZarrStore) validate and warn; this only guards against an
    // unbounded or NaN budget.
    this._maxBytes = validCacheBytes(maxBytes) ?? DEFAULT_CHUNK_CACHE_BYTES
    this._rangeRequests =
      !!options.rangeRequests && typeof baseStore.getRange === 'function'
    this.retryDelayMs = options.retryDelayMs ?? jitteredRetryDelayMs
    this.markBackground = !!options.markBackground
  }

  /**
   * Tell background (prefetch) reads apart by the caller's options (e.g. its
   * signal), so their base-store requests go in the request gate's
   * low-priority lane (needs `markBackground`). A shared fetch takes the
   * class of the caller that started it. `null` removes it.
   */
  setBackgroundClassifier(fn: ((opts?: GetOptions) => boolean) | null): void {
    this.isBackground = fn
  }

  /** Options for a base-store read made for a caller with `opts`. */
  private baseOpts(
    opts: GetOptions | undefined,
    signal: AbortSignal
  ): BaseGetOptions & { signal: AbortSignal } {
    const out: BaseGetOptions & { signal: AbortSignal } = { ...opts, signal }
    if (this.markBackground && this.isBackground?.(opts)) {
      out.headers = { ...out.headers, [BACKGROUND_REQUEST_HEADER]: '1' }
    }
    return out
  }

  /** Current byte budget. */
  get maxBytes(): number {
    return this._maxBytes
  }

  /**
   * Whether byte ranges are read with range requests (range mode). False
   * when the option was off, the base store has no getRange, or a server
   * ignored or rejected a range (the store then reads whole objects).
   */
  get rangeRequests(): boolean {
    return this._rangeRequests
  }

  /**
   * Change the byte budget of a live cache. Fractional values are floored;
   * an invalid value (non-finite or negative, see `validCacheBytes`) is
   * ignored with a warning and the current budget is kept.
   *
   * - Shrinking evicts immediately until the cache fits the new budget
   *   (least recently used first, by tier when an eviction policy is set).
   * - Growing never evicts; the extra room is filled by subsequent fetches.
   * - `0` evicts everything. The store keeps wrapping the base store, and (as
   *   with any entry larger than the budget) the single most recent fetch is
   *   still retained so, in full-object mode, `getRange` on a sharded file
   *   does not refetch the whole shard for every inner chunk. Restoring a
   *   positive budget later resumes normal caching, so `setMaxBytes(0)`
   *   followed by `setMaxBytes(previous)` acts as a "clear cache".
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
   * Set (or, with null, clear) the eviction policy. Without one, eviction is
   * plain LRU. With one, the entries of the lowest `priority` tier are
   * evicted first (LRU within the tier), so a caller can protect keys it
   * will need soon (ZarrLayer: the prefetch window and the displayed step)
   * without changing how entries are stored or looked up. If the protected
   * tiers alone exceed the budget, eviction falls back to LRU inside them,
   * tier by tier. Takes effect at the next eviction; it never evicts by
   * itself.
   */
  setEvictionPolicy(policy: EvictionPolicy | null): void {
    this.evictionPolicy = policy
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

  /** A cached entry, moved to the most-recently-used end. */
  private touch(cacheKey: string): CacheEntry | undefined {
    const cached = this.cache.get(cacheKey)
    if (cached) {
      this.cache.delete(cacheKey)
      this.cache.set(cacheKey, cached)
    }
    return cached
  }

  /**
   * Get a key, from the cache or the base store.
   *
   * Concurrent misses on one key share a single base-store fetch (see
   * `inflight`). Each caller keeps its own `signal`: aborting it rejects
   * only that caller's wait with an `AbortError`. The shared fetch is
   * aborted (its own signal, passed to the base store) only when every
   * caller waiting on it has aborted, so one caller leaving never fails
   * another, and a lone caller's abort still cancels the request. The
   * access listener fires once per caller that gets data, with that
   * caller's options.
   *
   * A base-store error (including a transient one) on a shared fetch
   * rejects every caller waiting on it; nothing is cached, and the next
   * get() starts a new fetch.
   */
  async get(
    key: AbsolutePath,
    opts?: GetOptions
  ): Promise<Uint8Array | undefined> {
    const cached = this.touch(key)
    if (cached) {
      this.notifyAccess(key, opts)
      return cached.data
    }
    const result = await this.getFull(key, opts)
    if (result !== undefined) this.notifyAccess(key, opts)
    return result
  }

  /** get() without the cache lookup or the access notification. */
  private getFull(
    key: AbsolutePath,
    opts?: GetOptions
  ): Promise<Uint8Array | undefined> {
    return this.shared(key, opts, async (signal) => {
      const result = await this.baseStore.get(key, this.baseOpts(opts, signal))
      if (result !== undefined) this.store(key, result)
      return result
    })
  }

  /**
   * Wait on the shared fetch for `cacheKey`, starting it with `fetch` if none
   * is in flight. Implements the waiter and abort semantics described on
   * get(). `fetch` gets the shared fetch's own signal and must store its
   * result before resolving, so listeners see the entry resident.
   */
  private async shared<T>(
    cacheKey: string,
    opts: GetOptions | undefined,
    fetch: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const signal = opts?.signal
    if (signal?.aborted) throw abortError()

    const shared =
      (this.inflight.get(cacheKey) as InflightFetch<T> | undefined) ??
      this.startFetch(cacheKey, fetch)
    shared.waiters++

    if (!signal) return shared.promise
    let onAbort: (() => void) | undefined
    try {
      return await Promise.race([
        shared.promise,
        new Promise<never>((_, reject) => {
          onAbort = () => {
            // This caller leaves; the last one out cancels the request
            shared.waiters--
            if (shared.waiters === 0 && !shared.settled) {
              if (this.inflight.get(cacheKey) === shared) {
                this.inflight.delete(cacheKey)
              }
              shared.controller.abort()
            }
            reject(abortError())
          }
          signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Start a shared fetch of `cacheKey` and register it in `inflight` until
   * it settles.
   */
  private startFetch<T>(
    cacheKey: string,
    fetch: (signal: AbortSignal) => Promise<T>
  ): InflightFetch<T> {
    const controller = new AbortController()
    const shared: InflightFetch<T> = {
      promise: undefined as unknown as Promise<T>,
      controller,
      waiters: 0,
      settled: false,
    }
    shared.promise = (async () => {
      try {
        return await fetch(controller.signal)
      } finally {
        shared.settled = true
        if (this.inflight.get(cacheKey) === shared) {
          this.inflight.delete(cacheKey)
        }
      }
    })()
    // Every waiter may have left (aborted); don't report the rejection as
    // unhandled
    shared.promise.catch(() => {})
    this.inflight.set(cacheKey, shared as InflightFetch<unknown>)
    return shared
  }

  /** Store an entry, replacing (and un-counting) any entry for the key. */
  private store(key: string, data: Uint8Array): void {
    if (this.usedRanges && !key.includes(RANGE_KEY_SEPARATOR)) {
      this.dropRangesOf(key)
    }
    const old = this.cache.get(key)
    if (old) {
      this.totalBytes -= old.byteSize
      this.cache.delete(key)
    }
    this.evictUntilFits(data.byteLength)
    this.cache.set(key, { data, byteSize: data.byteLength })
    this.totalBytes += data.byteLength
  }

  /**
   * Read a byte range of `key`.
   *
   * A range of an object cached whole (by get(), or by a range fallback) is
   * sliced from it and attributed to the object's key. Otherwise:
   *
   * - Full-object mode: get() the whole object, cache it, slice it.
   * - Range mode: fetch only the range with the base store's getRange, and
   *   cache it under `rangeCacheKey(key, range)`, which is also the key the
   *   access listener reports and `has` / `getEntryBytes` answer for.
   *   Concurrent reads of one range share one fetch, with get()'s abort
   *   semantics. Each range entry counts its own bytes and is evicted on its
   *   own.
   *
   * Fallbacks in range mode, so a server or proxy that does not support
   * ranges degrades to full-object mode instead of breaking:
   * - The server answered with the whole object (200, see
   *   `RangeIgnoredError`, or more bytes than asked for from a base store
   *   that does not throw it): the body is cached as the object's entry and
   *   sliced, and range mode turns off for this store.
   * - 416 (`RangeNotSatisfiableError`): range mode turns off, and the
   *   object is fetched whole.
   * - 429 (`RangeRateLimitedError`): thrown at once, not retried.
   * - Any other error (5xx, a short read, a network failure (TypeError),
   *   an AbortError the read did not ask for): retried once after
   *   `retryDelayMs` (jittered, see `RANGE_RETRY_DELAY_MS`), then thrown.
   *   A TypeError never switches modes: a CORS refusal of Range can't be
   *   told from a network blip. If range reads keep failing that way before
   *   any has succeeded, one `console.error` says so (see
   *   `RANGE_NETWORK_FAILURES_BEFORE_ERROR`); range mode is opt-in per
   *   deployment, once its hops are verified.
   *   Never a whole-object download: that would be a whole shard, which can
   *   be bigger than the cache.
   * Aborts of the read itself are rethrown, never retried. A suffix (shard
   * index) read is not cancelled by its caller's abort; see below.
   */
  async getRange(
    key: AbsolutePath,
    range: RangeQuery,
    opts?: GetOptions
  ): Promise<Uint8Array | undefined> {
    const whole = this.touch(key)
    if (whole) {
      this.notifyAccess(key, opts)
      return sliceRange(whole.data, range)
    }
    if (!this._rangeRequests) {
      const full = await this.get(key, opts)
      return full ? sliceRange(full, range) : undefined
    }

    const rangeKey = rangeCacheKey(key, range)
    const cached = this.touch(rangeKey)
    if (cached) {
      this.notifyAccess(rangeKey, opts)
      return cached.data
    }
    // A suffix read is a shard index: small, and zarrita shares one index
    // read among every chunk read of the shard while passing only the first
    // caller's signal. Letting that caller's abort cancel it would reject the
    // other chunk reads, so it runs to completion (it is still attributed to
    // the caller that made it).
    const waitOpts =
      'suffixLength' in range && opts?.signal
        ? { ...opts, signal: undefined }
        : opts
    const result = await this.shared(rangeKey, waitOpts, (signal) =>
      this.fetchRange(key, range, rangeKey, this.baseOpts(opts, signal))
    )
    if (result === undefined) return undefined
    this.notifyAccess(result.cacheKey, opts)
    return result.data
  }

  /**
   * Base-store range fetch with the fallbacks described on getRange(): a
   * whole object only when range support is shown to be broken, otherwise
   * one retry and then the error.
   */
  private async fetchRange(
    key: AbsolutePath,
    range: RangeQuery,
    rangeKey: string,
    opts: GetOptions & { signal: AbortSignal }
  ): Promise<RangeResult | undefined> {
    let data: Uint8Array | undefined
    for (let attempt = 0; ; attempt++) {
      try {
        data = await this.baseStore.getRange!(key, range, opts)
        break
      } catch (err) {
        // Our own shared fetch was aborted (every waiter left): done
        if (opts.signal.aborted) throw err
        const body = ignoredRangeBody(err)
        if (body) {
          this.disableRangeRequests(key, 'returned the whole object')
          return this.useWhole(key, body, range)
        }
        const name = errorName(err)
        if (name === 'RangeNotSatisfiableError') {
          this.disableRangeRequests(key, 'was rejected (416)')
          // Its errors reach the caller
          const full = await this.getFull(key, opts)
          return full
            ? { data: sliceRange(full, range), cacheKey: key }
            : undefined
        }
        // Rate-limited: retrying now only adds to it (task 44); a later
        // window refetches
        if (name === 'RangeRateLimitedError') throw err
        // Network-level: a dropout as far as we can tell (retried below,
        // never a switch-off: a whole-shard GET per read would follow)
        // (only exhausted reads count towards the misconfiguration error)
        if (name === 'TypeError' && attempt > 0) this.noteNetworkFailure(key)
        // Anything else (5xx, a short read, a network blip, or an
        // AbortError this fetch did not ask for, e.g. from a lower layer that
        // shares a request): retry once, then give up without downloading
        // the whole object (a 3 km shard is hundreds of MB and bigger than the
        // cache). Callers retry later: a prefetch step reports the failure
        // and is refetched, a render refetches.
        if (attempt > 0) throw err
        await delay(this.retryDelayMs(), opts.signal)
      }
    }
    if (data === undefined) return undefined
    const asked = 'suffixLength' in range ? range.suffixLength : range.length
    if (data.byteLength > asked) {
      // A base store that passes a 200 through as the result
      this.disableRangeRequests(key, 'returned the whole object')
      return this.useWhole(key, data, range)
    }
    this.usedRanges = true
    this.rangeSucceeded = true
    this.networkFailures = 0
    this.store(rangeKey, data)
    return { data, cacheKey: rangeKey }
  }

  /** Cache `full` as `key`'s whole-object entry and slice `range` from it. */
  private useWhole(
    key: string,
    full: Uint8Array,
    range: RangeQuery
  ): RangeResult {
    this.store(key, full)
    return { data: sliceRange(full, range), cacheKey: key }
  }

  /**
   * Drop the range entries of `key` once the whole object is cached, so its
   * bytes are not counted twice (ranges of it are sliced from the object
   * from now on). Only after range mode was used; O(entries).
   */
  private dropRangesOf(key: string): void {
    const prefix = `${key}${RANGE_KEY_SEPARATOR}`
    for (const [k, entry] of this.cache) {
      if (k.startsWith(prefix)) {
        this.totalBytes -= entry.byteSize
        this.cache.delete(k)
      }
    }
  }

  /**
   * Count a range read whose last attempt failed with a TypeError. After
   * RANGE_NETWORK_FAILURES_BEFORE_ERROR of them in a row on a store where no
   * range read has worked, log one error: the likely cause is a deployment
   * whose CORS (or a proxy) refuses the Range header.
   */
  private noteNetworkFailure(key: string): void {
    this.networkFailures++
    if (
      this.rangeSucceeded ||
      this.reportedNetworkFailures ||
      this.networkFailures < RANGE_NETWORK_FAILURES_BEFORE_ERROR
    ) {
      return
    }
    this.reportedNetworkFailures = true
    console.error(
      `[zarr-layer] Range reads are failing: ${this.networkFailures} range ` +
        `reads in a row failed with a network error (after a retry each) ` +
        `and none has ` +
        `succeeded (last: ${key}). If the network is up, this deployment may ` +
        `not allow the Range header: check its CORS (Access-Control-Allow-` +
        `Headers must allow Range) or turn rangeRequests off for it.`
    )
  }

  private disableRangeRequests(key: string, what: string): void {
    if (!this._rangeRequests) return
    this._rangeRequests = false
    console.warn(
      `[zarr-layer] A range request for ${key} ${what}; ` +
        `reading whole objects from now on.`
    )
  }

  /**
   * Check if a cache key (an object key, or a range key from
   * `rangeCacheKey`) is in the cache.
   */
  has(key: string): boolean {
    return this.cache.has(key)
  }

  /**
   * Byte size of a cached entry, or undefined when the key is not cached.
   * A plain lookup: unlike get(), it does not touch the LRU order, so it is
   * safe to poll.
   */
  getEntryBytes(key: string): number | undefined {
    return this.cache.get(key)?.byteSize
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

  /**
   * Clear all cached data. Fetches in flight are not cancelled: they still
   * resolve their callers and store their entries when they land.
   */
  clear(): void {
    this.cache.clear()
    this.totalBytes = 0
    this.usedRanges = false
  }

  private evictUntilFits(newBytes: number): void {
    if (this.totalBytes + newBytes <= this._maxBytes) return
    const policy = this.evictionPolicy
    if (!policy) {
      while (
        this.totalBytes + newBytes > this._maxBytes &&
        this.cache.size > 0
      ) {
        const oldest = this.cache.keys().next().value
        if (oldest === undefined) break
        this.evict(oldest)
      }
      return
    }
    // One pass in LRU order, grouped by tier; then evict tier by tier
    const tiers = new Map<number, string[]>()
    for (const key of this.cache.keys()) {
      const p = policy.priority(key)
      const tier = Number.isFinite(p) ? p : 0
      let list = tiers.get(tier)
      if (!list) tiers.set(tier, (list = []))
      list.push(key)
    }
    for (const tier of [...tiers.keys()].sort((a, b) => a - b)) {
      for (const key of tiers.get(tier)!) {
        if (this.totalBytes + newBytes <= this._maxBytes) return
        const byteSize = this.evict(key)
        policy.onEvict?.(key, tier, byteSize)
      }
    }
  }

  /** Remove an entry; returns its size (0 if it wasn't cached). */
  private evict(key: string): number {
    const entry = this.cache.get(key)
    if (!entry) return 0
    this.totalBytes -= entry.byteSize
    this.cache.delete(key)
    return entry.byteSize
  }
}
