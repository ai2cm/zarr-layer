/**
 * @module request-gate
 *
 * Per-origin gate in front of every HTTP request a zarr-layer fetch store
 * makes (ace-viz task 44). It does two things:
 *
 * - **Rate cap** (opt-in, `maxRequestsPerSecond`): a token bucket. A request
 *   waits for a token; the bucket holds `burst` tokens and refills at the
 *   rate. For hosts that limit requests, not bytes: a Hugging Face Bucket's
 *   `/resolve/` URLs count against a per-IP "resolvers" budget (anonymous:
 *   3,000 per 5 minutes).
 * - **429 backoff** (always on): a 429 response puts the origin into a
 *   cooldown (exponential, 2 s doubling up to 30 s, with ±25 % jitter).
 *   Requests wait it out; then one request goes first as a probe, and the
 *   others follow once it succeeds (a failed probe starts a longer
 *   cooldown). The rate-limited request itself is retried after the
 *   cooldown, so callers see a slow read, not an error, and a render keeps
 *   showing its loading state. Waiting ends early when the request's
 *   signal aborts; after `RATE_LIMIT_GIVE_UP_MS` (6 min) the read fails
 *   with `RangeRateLimitedError`. JS can't read the reset time (HF doesn't expose its
 *   `ratelimit` headers to CORS), hence the backoff.
 *
 * A 429 that arrives without CORS headers reaches JS as a network
 * TypeError, which can't be told from a dropout. With
 * `networkErrorsBackOff` (set together with a rate cap, i.e. on hosts known
 * to rate-limit), a TypeError also starts a cooldown before it is rethrown;
 * the caller's own retry (CachingStore retries a range once) then waits for
 * it. Otherwise TypeErrors pass through untouched.
 *
 * Requests leave in arrival order (FIFO); render and prefetch reads are not
 * told apart at this level.
 */

import { RangeRateLimitedError } from './caching-store'

export interface RequestGateOptions {
  /** Token-bucket rate; undefined / invalid / <= 0: no cap. */
  maxRequestsPerSecond?: number
  /** Bucket size (requests that can go at once after idling). Default 10. */
  burst?: number
  /** Treat a network TypeError like a 429 (see the module comment). */
  networkErrorsBackOff?: boolean
}

export const DEFAULT_REQUEST_BURST = 10
export const RATE_LIMIT_BACKOFF_MS = 2000
export const RATE_LIMIT_MAX_BACKOFF_MS = 30000
/**
 * A request still rate-limited after this long (from its first attempt)
 * fails with `RangeRateLimitedError` instead of retrying on: longer than
 * one 5-minute fixed window plus the longest cooldown.
 */
export const RATE_LIMIT_GIVE_UP_MS = 6 * 60 * 1000

/** How a request that went through the gate ended. */
export type GateOutcome = 'ok' | 'rate-limited' | 'error'

export interface GateTicket {
  /** The one request allowed out while recovering from a 429. */
  probe: boolean
  /**
   * The gate's limit epoch when the ticket was issued (bumped by every
   * 429). Only the probe, or a ticket issued after the latest 429, can end
   * the rate-limited state with a success: a request that left before the
   * 429 and answers 200 afterwards says nothing about the limit now.
   */
  epoch: number
}

interface Waiter {
  resolve: (ticket: GateTicket) => void
  reject: (err: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

function abortError(signal: AbortSignal): unknown {
  const reason = signal.reason
  if (reason instanceof Error && reason.name === 'AbortError') return reason
  return new DOMException('The operation was aborted.', 'AbortError')
}

export class RequestGate {
  private rate = 0
  private burst = DEFAULT_REQUEST_BURST
  private tokens = DEFAULT_REQUEST_BURST
  private refilledAt = 0
  networkErrorsBackOff = false
  private queue: Waiter[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private cooldownUntil = 0
  /** A 429 (or backed-off network error) since the last success. */
  private limited = false
  private probing = false
  private backoffMs = 0
  private limitEpoch = 0
  private readonly now: () => number
  private readonly random: () => number
  /** Counters, for tests and debugging. */
  readonly stats = { requests: 0, rateLimited: 0, waited: 0 }

  constructor(
    options: RequestGateOptions = {},
    deps: { now?: () => number; random?: () => number } = {}
  ) {
    this.now = deps.now ?? (() => Date.now())
    this.random = deps.random ?? Math.random
    this.configure(options)
  }

  /** Change the rate cap / burst / network-error rule. */
  configure(options: RequestGateOptions): void {
    const rate = options.maxRequestsPerSecond
    this.rate =
      typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : 0
    const burst = options.burst
    this.burst =
      typeof burst === 'number' && Number.isFinite(burst) && burst >= 1
        ? Math.floor(burst)
        : DEFAULT_REQUEST_BURST
    this.tokens = Math.min(this.tokens, this.burst)
    this.refilledAt = this.now()
    if (options.networkErrorsBackOff !== undefined) {
      this.networkErrorsBackOff = options.networkErrorsBackOff
    }
    this.pump()
  }

  /** Requests per second of the cap (0 = none). */
  get maxRequestsPerSecond(): number {
    return this.rate
  }

  /** True while in a cooldown or waiting for a probe to succeed. */
  get rateLimited(): boolean {
    return this.limited
  }

  /** Requests waiting to go out. */
  get pending(): number {
    return this.queue.length
  }

  /**
   * Wait for this request's turn. Resolves with a ticket to pass to done();
   * rejects with an AbortError if `signal` aborts first.
   */
  acquire(signal?: AbortSignal): Promise<GateTicket> {
    if (signal?.aborted) return Promise.reject(abortError(signal))
    return new Promise<GateTicket>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal }
      if (signal) {
        waiter.onAbort = () => {
          const i = this.queue.indexOf(waiter)
          if (i === -1) return
          this.queue.splice(i, 1)
          reject(abortError(signal))
          this.pump()
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.queue.push(waiter)
      this.pump()
      if (this.queue.includes(waiter)) this.stats.waited++
    })
  }

  /** Report how a request that got `ticket` ended. */
  done(ticket: GateTicket, outcome: GateOutcome): void {
    if (ticket.probe) this.probing = false
    if (outcome === 'ok') {
      if (ticket.probe || ticket.epoch === this.limitEpoch) {
        this.limited = false
        this.backoffMs = 0
      }
    } else if (outcome === 'rate-limited') {
      this.stats.rateLimited++
      this.limited = true
      this.limitEpoch++
      const now = this.now()
      // Several requests in flight when the limit hit each get a 429:
      // one cooldown, not one doubling per request
      if (now >= this.cooldownUntil) {
        this.backoffMs = this.backoffMs
          ? Math.min(this.backoffMs * 2, RATE_LIMIT_MAX_BACKOFF_MS)
          : RATE_LIMIT_BACKOFF_MS
        const jitter = 0.75 + 0.5 * this.random()
        this.cooldownUntil = now + this.backoffMs * jitter
      }
    }
    this.pump()
  }

  /** Release waiters whose turn it is; schedule the next check. */
  private pump(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    while (this.queue.length > 0) {
      const now = this.now()
      if (now < this.cooldownUntil) {
        this.schedule(this.cooldownUntil - now)
        return
      }
      // Recovering: one probe at a time until one succeeds
      if (this.limited && this.probing) return
      if (this.rate > 0) {
        this.tokens = Math.min(
          this.burst,
          this.tokens + ((now - this.refilledAt) / 1000) * this.rate
        )
        this.refilledAt = now
        if (this.tokens < 1) {
          this.schedule(((1 - this.tokens) / this.rate) * 1000)
          return
        }
        this.tokens -= 1
      }
      const waiter = this.queue.shift()!
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
      }
      const probe = this.limited
      if (probe) this.probing = true
      this.stats.requests++
      waiter.resolve({ probe, epoch: this.limitEpoch })
    }
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = null
      this.pump()
    }, Math.max(0, Math.ceil(ms)))
  }
}

// One registry per page, even with several copies of this module (two
// bundles of zarr-layer): the limit is per client IP, not per copy
const GATES_KEY = Symbol.for('zarr-layer.requestGates')
const globalGates = globalThis as unknown as {
  [GATES_KEY]?: Map<string, RequestGate>
}
const gates: Map<string, RequestGate> = (globalGates[GATES_KEY] ??= new Map())

function originOf(url: string): string {
  try {
    return new URL(url, globalThis.location?.href).origin
  } catch {
    return url
  }
}

/** The shared gate for `url`'s origin (created on first use). */
export function requestGateFor(url: string): RequestGate {
  const origin = originOf(url)
  let gate = gates.get(origin)
  if (!gate) {
    gate = new RequestGate()
    gates.set(origin, gate)
  }
  return gate
}

/**
 * Configure the gate of `url`'s origin. A rate cap also turns on
 * `networkErrorsBackOff` (unless given): a host worth capping is one that
 * rate-limits, whose 429s may arrive without CORS headers.
 */
export function configureRequestGate(
  url: string,
  options: RequestGateOptions
): RequestGate {
  const gate = requestGateFor(url)
  const capped =
    typeof options.maxRequestsPerSecond === 'number' &&
    options.maxRequestsPerSecond > 0
  gate.configure({
    networkErrorsBackOff: capped,
    ...options,
  })
  return gate
}

/** Drop every gate (tests). */
export function resetRequestGates(): void {
  gates.clear()
}

/**
 * Wrap a fetch so every request goes through its origin's gate: waits for
 * its turn, and a 429 is retried after the cooldown (see the module
 * comment) until it succeeds, the request's signal aborts, or `giveUpMs`
 * (default 6 min) has passed (then `RangeRateLimitedError`).
 */
export function gatedFetch(
  inner: (request: Request) => Promise<Response>,
  gateFor: (url: string) => RequestGate = requestGateFor,
  {
    giveUpMs = RATE_LIMIT_GIVE_UP_MS,
    now = () => Date.now(),
  }: { giveUpMs?: number; now?: () => number } = {}
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const gate = gateFor(request.url)
    const start = now()
    for (let attempt = 0; ; attempt++) {
      const ticket = await gate.acquire(request.signal)
      // A retry whose cooldown ran past the deadline: give up without
      // sending it (release the ticket; 'error' leaves the gate's limit
      // state alone, and a probe ticket passes the probe on)
      if (attempt > 0 && now() - start >= giveUpMs) {
        gate.done(ticket, 'error')
        throw new RangeRateLimitedError(request.url)
      }
      let response: Response
      try {
        response = await inner(request)
      } catch (err) {
        const network = err instanceof TypeError && !request.signal?.aborted
        gate.done(
          ticket,
          network && gate.networkErrorsBackOff ? 'rate-limited' : 'error'
        )
        throw err
      }
      if (response.status === 429) {
        // Drain, so the connection can be reused
        await response.body?.cancel().catch(() => {})
        gate.done(ticket, 'rate-limited')
        // Past a whole HF window (5 min) plus a cooldown: fail the read
        if (now() - start >= giveUpMs) {
          throw new RangeRateLimitedError(request.url)
        }
        continue
      }
      // Any other answer: the server is not rate-limiting us
      gate.done(ticket, 'ok')
      return response
    }
  }
}
