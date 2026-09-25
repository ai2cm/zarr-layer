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
 * No policy lives here (direction, horizon, debounce): callers decide which
 * window they want. The per-step fetch is injected (`fetchStep`), so this
 * class has no dependency on the rendering modes and is unit-testable.
 */

/**
 * Fetch one time step. Resolve `false` when the step could not be attempted
 * yet (e.g. the mode is still initializing); the queue retries it, with
 * backoff, for as long as it is still wanted. Any other resolution (or a
 * rejection) counts as done.
 */
export type PrefetchStepFetcher = (
  timeIndex: number,
  timeDimName: string,
  signal: AbortSignal,
  info: PrefetchStepInfo
) => Promise<boolean | void>

export interface PrefetchStepInfo {
  /**
   * Start order of this step (0, 1, 2, ... over the queue's lifetime; a
   * retry keeps its number). Lower = started earlier = higher priority,
   * since steps start in window order.
   */
  seq: number
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
}

interface InFlight {
  index: number
  dim: string
  controller: AbortController
}

export const DEFAULT_PREFETCH_CONCURRENCY = 4

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
  }

  constructor(options: PrefetchQueueOptions) {
    this.fetchStep = options.fetchStep
    this.isCached = options.isCached
    this.retryDelayMs = options.retryDelayMs ?? 100
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 1000
    this.onBusyChange = options.onBusyChange
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

    this.dim = timeDimName
    this.pending = wanted.filter((idx) => !kept.has(idx) && !this.isCached(idx))
    this.fill()
  }

  /** Drop all pending steps and abort every step in flight. */
  clear(): void {
    this.pending = []
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

  /** Start pending steps (front first) while slots are free. */
  private fill(): void {
    while (
      this.inFlight.length < this.maxConcurrentSteps &&
      this.pending.length > 0
    ) {
      const index = this.pending.shift()!
      if (this.isCached(index)) continue
      const step: InFlight = {
        index,
        dim: this.dim,
        controller: new AbortController(),
      }
      this.inFlight.push(step)
      this.stats.started++
      this.setBusy(true)
      void this.run(step, this.seq++)
    }
    this.updateBusy()
  }

  private async run(step: InFlight, seq: number): Promise<void> {
    const { index, dim, controller } = step
    try {
      let delay = this.retryDelayMs
      for (;;) {
        const result = await this.fetchStep(index, dim, controller.signal, {
          seq,
        })
        if (result !== false || controller.signal.aborted) break
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
