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
 * the aborted fetch to settle before starting the next one, so per-step
 * attribution callbacks never overlap.
 *
 * No policy lives here (direction, horizon, debounce): callers decide which
 * window they want. The per-step fetch is injected (`fetchStep`), so this
 * class has no dependency on the rendering modes and is unit-testable.
 */

/**
 * Fetch one time step. Resolve `false` when the step could not be attempted
 * yet (e.g. the mode is still initializing); the queue retries it after
 * `retryDelayMs` while it is still wanted. Any other resolution (or a
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
  /** Delay between retries of a step whose fetcher resolved `false`. */
  retryDelayMs?: number
  /** Retries per step before it is dropped. */
  maxRetries?: number
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
  private readonly maxRetries: number
  private pending: number[] = []
  private dim: string = 'time'
  private inFlight: InFlight | null = null
  private running: boolean = false
  private idleWaiters: Array<() => void> = []
  readonly stats: PrefetchQueueStats = { started: 0, completed: 0, aborted: 0 }

  constructor(options: PrefetchQueueOptions) {
    this.fetchStep = options.fetchStep
    this.isCached = options.isCached
    this.retryDelayMs = options.retryDelayMs ?? 100
    this.maxRetries = options.maxRetries ?? 30
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
    const keepInFlight =
      current !== null && current.dim === timeDimName && seen.has(current.index)
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

  /** Resolves once the queue has nothing in flight and nothing pending. */
  whenIdle(): Promise<void> {
    if (!this.running) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private async pump(): Promise<void> {
    this.running = true
    try {
      while (this.pending.length > 0) {
        const index = this.pending.shift()!
        if (this.isCached(index)) continue
        const controller = new AbortController()
        const dim = this.dim
        this.inFlight = { index, dim, controller }
        this.stats.started++
        try {
          for (let attempt = 0; ; attempt++) {
            const result = await this.fetchStep(index, dim, controller.signal)
            if (result !== false || controller.signal.aborted) break
            if (attempt >= this.maxRetries) break
            await new Promise((r) => setTimeout(r, this.retryDelayMs))
            if (controller.signal.aborted) break
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
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const w of waiters) w()
    }
  }
}
