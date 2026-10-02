/**
 * Incremental time-step prefetch queue.
 *
 * `ZarrLayer.prefetchTimeSteps(indices)` hands the *wanted* window (in
 * priority order) to `set()`. Unlike the previous abort-everything behaviour,
 * a new window:
 *   - keeps each step currently in flight running when it is still wanted
 *     (an aborted `zarr.get` leaves nothing in the cache, so aborting it
 *     would throw the work away);
 *   - aborts an in-flight step only when it is no longer wanted (or the time
 *     dimension changed);
 *   - replaces the not-yet-started steps with the new window, minus steps
 *     already cached, so stale steps from an old window are dropped.
 *
 * Up to `maxConcurrentSteps` steps (default 4) are in flight at once; free
 * slots are filled from the front of the window, so steps start in priority
 * order. An aborted step keeps its slot until its fetch settles, so an
 * aborted step never competes with a new one beyond the limit. (Cache
 * attribution does not depend on this: ZarrLayer attributes each access by
 * its request's signal, one signal per step.) Pass `maxConcurrentSteps: 1`
 * for the previous strictly sequential behaviour.
 *
 * Shard batches (ace-viz task 44): with `batchSize` > 1, steps whose time
 * indices share a batch (`floor(index / batchSize)`, i.e. one shard along
 * the time dim) start together: starting a step also starts every other
 * pending step of its batch, even past `maxConcurrentSteps` (so at most
 * `maxConcurrentSteps + batchSize - 1` steps are in flight). Their range
 * reads then go out in the same task and the range coalescing layer merges
 * adjacent inner chunks of the shard into one request.
 *
 * No policy lives here (direction, horizon, debounce): callers decide which
 * window they want. The per-step fetch is injected (`fetchStep`), so this
 * class has no dependency on the rendering modes and is unit-testable.
 */

/**
 * Fetch one time step. Resolve `false` when the step could not be attempted
 * yet (e.g. the mode is still initializing); the queue retries it, with
 * backoff, for as long as it is still wanted. Resolve `'failed'` when a
 * read failed (a 5xx or network error after the store's own retry): the
 * queue retries it after a jittered exponential backoff, up to
 * `maxFailureRetries` times while it is still wanted, then drops it (a
 * later window can ask again). Any other resolution (or a rejection)
 * counts as done.
 */
export type PrefetchStepFetcher = (
  timeIndex: number,
  timeDimName: string,
  signal: AbortSignal,
  info: PrefetchStepInfo
) => Promise<boolean | void | 'failed'>

export interface PrefetchStepInfo {
  /**
   * Start order of this step (0, 1, 2, ... over the queue's lifetime; a
   * retry keeps its number). Lower = started earlier = higher priority,
   * since steps start in window order.
   */
  seq: number
  /**
   * Shard batch of the step (`floor(index / batchSize)`), when batching is
   * on; steps started together share it (see the class comment).
   */
  batch?: number
}

export interface PrefetchQueueOptions {
  fetchStep: PrefetchStepFetcher
  isCached: (timeIndex: number) => boolean
  /**
   * Steps in flight at once (default 4: one day of 6-hourly data).
   * Fractional values are floored; invalid values (non-finite or below 1)
   * use the default.
   */
  maxConcurrentSteps?: number
  /**
   * First retry delay for a step whose fetcher resolved `false`; doubles on
   * each further retry up to `maxRetryDelayMs`. There is no retry cap: a step
   * is retried until it is fetched or a later set()/clear() drops it, so a
   * layer that isn't ready yet (e.g. in a background tab where no render
   * pass has run) still fills once it is.
   */
  retryDelayMs?: number
  maxRetryDelayMs?: number
  /**
   * Backoff for a step whose fetcher resolved `'failed'`: the first retry
   * after `failureRetryDelayMs` (default 1000), doubling up to
   * `maxFailureRetryDelayMs` (default 16000), each scaled by a random
   * factor in [0.5, 1.5) so failed steps don't retry in lockstep; at most
   * `maxFailureRetries` retries (default 5). The step keeps its slot while
   * it waits, so a burst of failures (e.g. a rate limit) also slows the
   * steps behind it.
   */
  failureRetryDelayMs?: number
  maxFailureRetryDelayMs?: number
  maxFailureRetries?: number
  /** Random source for the jitter (tests). */
  random?: () => number
  /**
   * Steps per batch (see the class comment), read each time steps start, so
   * it can change once the array is known. Values below 2 (or invalid) mean
   * no batching. Default: no batching.
   */
  batchSize?: () => number
  /**
   * Steps at the front of the window (window positions below this) are
   * never batched: they start alone, as soon as a slot is free. Default
   * `DEFAULT_BATCH_NEAR_STEPS` (8).
   */
  batchNearSteps?: number
  /**
   * Called when `busy` changes: true when the queue starts working through
   * steps, false once nothing is in flight or pending.
   */
  onBusyChange?: (busy: boolean) => void
}

export interface PrefetchQueueStats {
  /** Steps handed to `fetchStep` (retries not counted). */
  started: number
  /** Steps that ran to completion without being aborted. */
  completed: number
  /** In-flight steps aborted because a new window no longer wanted them. */
  aborted: number
  /** Retries of steps whose fetch failed (see `'failed'`). */
  failureRetries: number
}

interface InFlight {
  index: number
  dim: string
  controller: AbortController
  batch?: number
}

export const DEFAULT_PREFETCH_CONCURRENCY = 4
/** Default `batchNearSteps`. */
export const DEFAULT_BATCH_NEAR_STEPS = 8
/**
 * Window positions that start alone even for appended steps (see isNear),
 * capped at `batchNearSteps`.
 */
export const APPENDED_NEAR_STEPS = 2

/** A positive integer, or `fallback` for undefined / invalid input. */
export function normalizeConcurrency(
  value: number | undefined,
  fallback: number
): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 1) return fallback
  return Math.floor(value)
}

export class PrefetchQueue {
  private readonly fetchStep: PrefetchStepFetcher
  private readonly isCached: (timeIndex: number) => boolean
  private readonly retryDelayMs: number
  private readonly maxRetryDelayMs: number
  private readonly onBusyChange: ((busy: boolean) => void) | undefined
  private readonly batchSize: (() => number) | undefined
  private readonly nearSteps: number
  /** Position of each step in the latest window. */
  private windowPos = new Map<number, number>()
  /**
   * Steps the latest window appended past every step it kept from the
   * previous one (playback extending its lookahead): exempt from the near
   * rule, see isNear.
   */
  private appended = new Set<number>()
  private readonly failureRetryDelayMs: number
  private readonly maxFailureRetryDelayMs: number
  private readonly maxFailureRetries: number
  private readonly random: () => number
  /** Max steps in flight (aborted-but-unsettled steps count). */
  readonly maxConcurrentSteps: number
  private pending: number[] = []
  private dim: string = 'time'
  /** In start order; includes aborted steps until their fetch settles. */
  private inFlight: InFlight[] = []
  private isBusy: boolean = false
  private seq: number = 0
  private idleWaiters: Array<() => void> = []
  readonly stats: PrefetchQueueStats = {
    started: 0,
    completed: 0,
    aborted: 0,
    failureRetries: 0,
  }

  constructor(options: PrefetchQueueOptions) {
    this.fetchStep = options.fetchStep
    this.isCached = options.isCached
    this.retryDelayMs = options.retryDelayMs ?? 100
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 1000
    this.onBusyChange = options.onBusyChange
    this.batchSize = options.batchSize
    this.nearSteps = options.batchNearSteps ?? DEFAULT_BATCH_NEAR_STEPS
    this.failureRetryDelayMs = options.failureRetryDelayMs ?? 1000
    this.maxFailureRetryDelayMs = options.maxFailureRetryDelayMs ?? 16000
    this.maxFailureRetries = options.maxFailureRetries ?? 5
    this.random = options.random ?? Math.random
    this.maxConcurrentSteps = normalizeConcurrency(
      options.maxConcurrentSteps,
      DEFAULT_PREFETCH_CONCURRENCY
    )
  }

  /** Replace the wanted window (priority order). See the class comment. */
  set(timeIndices: number[], timeDimName: string = 'time'): void {
    const seen = new Set<number>()
    const wanted: number[] = []
    for (const idx of timeIndices) {
      if (!Number.isInteger(idx) || idx < 0 || seen.has(idx)) continue
      seen.add(idx)
      wanted.push(idx)
    }

    const kept = new Set<number>()
    for (const step of this.inFlight) {
      // A step already aborted by an earlier set() is on its way out; it
      // can't be kept, so a window that wants it again re-queues it.
      if (step.controller.signal.aborted) continue
      if (step.dim === timeDimName && seen.has(step.index)) {
        kept.add(step.index)
      } else {
        step.controller.abort()
        this.stats.aborted++
      }
    }

    const sameDim = this.dim === timeDimName
    const previous = sameDim ? this.windowPos : new Map<number, number>()
    const wasAppended = sameDim ? this.appended : new Set<number>()
    this.dim = timeDimName
    this.windowPos = new Map(wanted.map((idx, pos) => [idx, pos]))
    this.pending = wanted.filter((idx) => !kept.has(idx) && !this.isCached(idx))
    // An extension of the previous window: steps after the last step it
    // kept are new lookahead, not the step about to be shown. Steps
    // appended earlier and still pending keep the flag (with the shard cut,
    // the ticks between shard boundaries append nothing, and a shard that
    // waited for a slot would otherwise start step by step)
    let lastKept = -1
    wanted.forEach((idx, pos) => {
      if (previous.has(idx)) lastKept = pos
    })
    const appended = new Set(lastKept < 0 ? [] : wanted.slice(lastKept + 1))
    for (const idx of this.pending) {
      if (wasAppended.has(idx)) appended.add(idx)
    }
    this.appended = appended
    this.fill()
  }

  /**
   * Queue `timeIndices` of the latest window again, keeping that window
   * (its positions and appended steps), so the near rule and shard
   * batching treat them as they would in the window: unlike set(), which
   * would make them a window of their own, every one of them in the near
   * positions and none batched. Steps the window doesn't list, cached
   * steps and steps in flight are skipped; pending steps are kept, and
   * everything pending runs in window order. A different time dim is a
   * no-op.
   */
  requeue(timeIndices: number[], timeDimName: string = 'time'): void {
    if (timeDimName !== this.dim) return
    const inFlight = new Set(this.inFlightIndices)
    const queued = new Set(this.pending)
    for (const idx of timeIndices) {
      if (!this.windowPos.has(idx) || queued.has(idx) || inFlight.has(idx)) {
        continue
      }
      if (this.isCached(idx)) continue
      queued.add(idx)
      this.pending.push(idx)
    }
    const pos = (idx: number) => this.windowPos.get(idx) ?? Infinity
    this.pending.sort((x, y) => pos(x) - pos(y))
    this.fill()
  }

  /** Drop all pending steps and abort every step in flight. */
  clear(): void {
    this.pending = []
    // The next window starts fresh (the near rule applies again)
    this.windowPos = new Map()
    this.appended = new Set()
    for (const step of this.inFlight) {
      if (step.controller.signal.aborted) continue
      step.controller.abort()
      this.stats.aborted++
    }
    this.updateBusy()
  }

  /**
   * First (highest-priority) step being fetched, or null. Aborted steps
   * that have not settled yet are not reported.
   */
  get inFlightIndex(): number | null {
    return this.inFlightIndices[0] ?? null
  }

  /** Steps being fetched (not aborted), in start order. */
  get inFlightIndices(): number[] {
    return this.inFlight
      .filter((s) => !s.controller.signal.aborted)
      .map((s) => s.index)
  }

  /** Steps waiting to be fetched, in order. */
  get pendingIndices(): number[] {
    return [...this.pending]
  }

  /** True while a step is in flight (or waiting to retry) or pending. */
  get busy(): boolean {
    return this.isBusy
  }

  /** Resolves once the queue has nothing in flight and nothing pending. */
  whenIdle(): Promise<void> {
    if (!this.isBusy) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  /** Wait `ms`, or less if `signal` aborts first. */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      signal.addEventListener('abort', done, { once: true })
    })
  }

  /**
   * In the first `nearSteps` positions of the window: fetched on its own,
   * never batched, so the step about to be shown doesn't wait for a whole
   * shard's coalesced response (task 44 review: head-of-line blocking).
   * Steps a window appended to the previous one's (and still pending since)
   * are exempt past the first `APPENDED_NEAR_STEPS` positions: a small
   * playback window (cap under nearSteps + batch) adds each new shard
   * inside the near positions, and would otherwise never batch.
   */
  private isNear(index: number): boolean {
    const pos = this.windowPos.get(index) ?? Infinity
    // The next steps to be shown start alone even when appended (a window
    // that overlaps the previous one by a step or two)
    if (pos < Math.min(APPENDED_NEAR_STEPS, this.nearSteps)) return true
    if (this.appended.has(index)) return false
    return pos < this.nearSteps
  }

  /** Current batch size (1 = no batching). */
  private currentBatchSize(): number {
    const size = this.batchSize?.() ?? 1
    return Number.isFinite(size) && size >= 2 ? Math.floor(size) : 1
  }

  /**
   * Start pending steps (front first) while slots are free; each step
   * brings the pending steps of its batch with it (see the class comment).
   */
  private fill(): void {
    while (
      this.inFlight.length < this.maxConcurrentSteps &&
      this.pending.length > 0
    ) {
      const index = this.pending.shift()!
      if (this.isCached(index)) continue
      const size = this.currentBatchSize()
      if (size < 2 || this.isNear(index)) {
        this.start(index)
        continue
      }
      const batch = Math.floor(index / size)
      this.start(index, batch)
      const rest: number[] = []
      for (const idx of this.pending) {
        if (Math.floor(idx / size) !== batch || this.isNear(idx)) rest.push(idx)
        else if (!this.isCached(idx)) this.start(idx, batch)
      }
      this.pending = rest
    }
    this.updateBusy()
  }

  private start(index: number, batch?: number): void {
    const step: InFlight = {
      index,
      dim: this.dim,
      controller: new AbortController(),
      batch,
    }
    this.inFlight.push(step)
    this.stats.started++
    this.setBusy(true)
    void this.run(step, this.seq++)
  }

  private async run(step: InFlight, seq: number): Promise<void> {
    const { index, dim, controller, batch } = step
    const info: PrefetchStepInfo =
      batch === undefined ? { seq } : { seq, batch }
    try {
      let delay = this.retryDelayMs
      let failureDelay = this.failureRetryDelayMs
      let failures = 0
      for (;;) {
        const result = await this.fetchStep(index, dim, controller.signal, info)
        if (controller.signal.aborted) break
        if (result === 'failed') {
          if (failures++ >= this.maxFailureRetries) break
          await this.sleep(
            failureDelay * (0.5 + this.random()),
            controller.signal
          )
          if (controller.signal.aborted || this.isCached(index)) break
          failureDelay = Math.min(failureDelay * 2, this.maxFailureRetryDelayMs)
          this.stats.failureRetries++
          continue
        }
        if (result !== false) break
        await this.sleep(delay, controller.signal)
        if (controller.signal.aborted) break
        delay = Math.min(delay * 2, this.maxRetryDelayMs)
      }
    } catch {
      // Aborted or failed: prefetch is best-effort.
    } finally {
      if (!controller.signal.aborted) this.stats.completed++
      this.inFlight.splice(this.inFlight.indexOf(step), 1)
      this.fill()
    }
  }

  private updateBusy(): void {
    this.setBusy(this.inFlight.length > 0 || this.pending.length > 0)
  }

  private setBusy(busy: boolean): void {
    if (busy === this.isBusy) return
    this.isBusy = busy
    this.onBusyChange?.(busy)
    if (!busy) {
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const w of waiters) w()
    }
  }
}
