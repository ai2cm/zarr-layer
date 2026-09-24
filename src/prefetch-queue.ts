/**
 * Incremental time-step prefetch queue.
 *
 * `ZarrLayer.prefetchTimeSteps(indices)` hands the *wanted* window (in
 * priority order) to `set()`. Unlike the previous abort-everything behaviour,
 * a new window:
 *   - keeps the step currently in flight running when it is still wanted
 *     (an aborted `zarr.get` leaves nothing in the cache, so aborting it
 *     would throw the work away);
 *   - aborts the in-flight step only when it is no longer wanted (or the time
 *     dimension changed);
 *   - replaces the not-yet-started steps with the new window, minus steps
 *     already cached, so stale steps from an old window are dropped.
 *
 * Steps are fetched strictly one at a time: after an abort the queue waits for
 * the aborted fetch to settle before starting the next one, so an aborted step
 * never competes with the next one for bandwidth. (Cache attribution does not
 * depend on this: ZarrLayer attributes each access by its request's signal.)
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
  signal: AbortSignal
) => Promise<boolean | void>

export interface PrefetchQueueOptions {
  fetchStep: PrefetchStepFetcher
  isCached: (timeIndex: number) => boolean
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

export class PrefetchQueue {
  private readonly fetchStep: PrefetchStepFetcher
  private readonly isCached: (timeIndex: number) => boolean
  private readonly retryDelayMs: number
  private readonly maxRetryDelayMs: number
  private readonly onBusyChange: ((busy: boolean) => void) | undefined
  private pending: number[] = []
  private dim: string = 'time'
  private inFlight: InFlight | null = null
  private running: boolean = false
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

    const current = this.inFlight
    // An in-flight step already aborted by an earlier set() is on its way
    // out; it can't be kept, so a window that wants it again re-queues it.
    const keepInFlight =
      current !== null &&
      !current.controller.signal.aborted &&
      current.dim === timeDimName &&
      seen.has(current.index)
    if (current && !keepInFlight && !current.controller.signal.aborted) {
      current.controller.abort()
      this.stats.aborted++
    }

    this.dim = timeDimName
    this.pending = wanted.filter(
      (idx) => !(keepInFlight && idx === current!.index) && !this.isCached(idx)
    )
    if (!this.running && this.pending.length > 0) void this.pump()
  }

  /** Drop all pending steps and abort the one in flight. */
  clear(): void {
    this.pending = []
    if (this.inFlight && !this.inFlight.controller.signal.aborted) {
      this.inFlight.controller.abort()
      this.stats.aborted++
    }
  }

  /** Step currently being fetched, or null. */
  get inFlightIndex(): number | null {
    return this.inFlight?.index ?? null
  }

  /** Steps waiting to be fetched, in order. */
  get pendingIndices(): number[] {
    return [...this.pending]
  }

  /** True while a step is in flight (or waiting to retry) or pending. */
  get busy(): boolean {
    return this.running
  }

  /** Resolves once the queue has nothing in flight and nothing pending. */
  whenIdle(): Promise<void> {
    if (!this.running) return Promise.resolve()
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

  private async pump(): Promise<void> {
    this.running = true
    this.onBusyChange?.(true)
    try {
      while (this.pending.length > 0) {
        const index = this.pending.shift()!
        if (this.isCached(index)) continue
        const controller = new AbortController()
        const dim = this.dim
        this.inFlight = { index, dim, controller }
        this.stats.started++
        try {
          let delay = this.retryDelayMs
          for (;;) {
            const result = await this.fetchStep(index, dim, controller.signal)
            if (result !== false || controller.signal.aborted) break
            await this.sleep(delay, controller.signal)
            if (controller.signal.aborted) break
            delay = Math.min(delay * 2, this.maxRetryDelayMs)
          }
        } catch {
          // Aborted or failed: prefetch is best-effort.
        } finally {
          if (!controller.signal.aborted) this.stats.completed++
          this.inFlight = null
        }
      }
    } finally {
      this.running = false
      this.onBusyChange?.(false)
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const w of waiters) w()
    }
  }
}
