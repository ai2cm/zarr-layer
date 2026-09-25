/**
 * Concurrency cap shared by all background prefetch requests of a layer.
 *
 * `run(fn)` starts `fn` once fewer than `max` tasks are running. Waiting
 * tasks start in priority order (lower number first; FIFO among equals), so
 * the chunks of the highest-priority prefetch step go out first even while
 * several steps are in flight. A waiting task whose signal aborts leaves the
 * wait list and rejects with an AbortError without ever running, so an
 * aborted step never holds or waits for a slot.
 *
 * `chunkQueue()` adapts it to zarrita's `createQueue` option (`zarr.get`
 * calls `add` once per chunk), so the cap counts chunk requests, not
 * regions.
 */

/**
 * Default cap on a layer's prefetch chunk requests in flight (all steps).
 * Measured in Chromium against the Hugging Face CDN (task 30; 3 MB chunks,
 * HTTP/2): prefetch throughput was about 30 / 40 / 47-53 / 38 MB/s with caps
 * of 6 / 8 / 12 / 16. The render path keeps its own 32-region limit and does
 * not go through this cap.
 */
export const DEFAULT_PREFETCH_MAX_REQUESTS = 12

/** Structural twin of zarrita's `ChunkQueue` (`zarr.get` `createQueue`). */
export interface ChunkQueueLike {
  add(fn: () => Promise<void>): void
  onIdle(): Promise<void[]>
}

export interface LimiterRunOptions {
  /** Lower runs first. Default 0. */
  priority?: number
  /** Aborting while waiting removes the task and rejects with AbortError. */
  signal?: AbortSignal
}

interface Waiter {
  priority: number
  seq: number
  start: () => void
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason
  if (reason instanceof Error && reason.name === 'AbortError') return reason
  const err = new Error('Aborted')
  err.name = 'AbortError'
  return err
}

export class RequestLimiter {
  readonly max: number
  private running = 0
  private seq = 0
  private waiters: Waiter[] = []
  /** Highest number of tasks ever running at once (for tests/debugging). */
  peak = 0

  constructor(max: number) {
    if (!Number.isFinite(max) || max < 1) {
      throw new RangeError(`RequestLimiter: max must be >= 1 (got ${max})`)
    }
    this.max = Math.floor(max)
  }

  /** Tasks currently running. */
  get active(): number {
    return this.running
  }

  /** Tasks waiting for a slot. */
  get pending(): number {
    return this.waiters.length
  }

  run<T>(fn: () => Promise<T>, options: LimiterRunOptions = {}): Promise<T> {
    const { priority = 0, signal } = options
    if (signal?.aborted) return Promise.reject(abortError(signal))
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener('abort', onAbort)
        this.running++
        if (this.running > this.peak) this.peak = this.running
        let p: Promise<T>
        try {
          p = Promise.resolve(fn())
        } catch (e) {
          p = Promise.reject(e)
        }
        p.then(resolve, reject).finally(() => {
          this.running--
          this.next()
        })
      }
      const waiter: Waiter = { priority, seq: this.seq++, start }
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter)
        if (i === -1) return
        this.waiters.splice(i, 1)
        reject(abortError(signal!))
      }
      if (this.running < this.max) {
        start()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      // Keep the list sorted: priority, then arrival
      let i = this.waiters.length
      while (
        i > 0 &&
        (this.waiters[i - 1].priority > priority ||
          (this.waiters[i - 1].priority === priority &&
            this.waiters[i - 1].seq > waiter.seq))
      ) {
        i--
      }
      this.waiters.splice(i, 0, waiter)
    })
  }

  /** A zarrita chunk queue whose chunk fetches go through this limiter. */
  chunkQueue(options: LimiterRunOptions = {}): ChunkQueueLike {
    const promises: Promise<void>[] = []
    return {
      add: (fn) => {
        promises.push(this.run(fn, options))
      },
      onIdle: () => Promise.all(promises),
    }
  }

  private next(): void {
    while (this.running < this.max && this.waiters.length > 0) {
      this.waiters.shift()!.start()
    }
  }
}
