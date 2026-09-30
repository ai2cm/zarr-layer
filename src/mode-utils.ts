/**
 * @module mode-utils
 *
 * Shared utilities for ZarrMode implementations (TiledMode and UntiledMode).
 * Provides common patterns for throttling, request cancellation, and loading state management.
 */

import type { LoadingStateCallback, LoadingState } from './types'

// ============================================================================
// Error retry (ace-viz task 44)
// ============================================================================

/**
 * A delayed re-render after a render read failed (not aborted). Without it,
 * a paused map whose region or tile read failed (a 5xx or network error
 * after the store's retry) stayed blank until the next pan, zoom or time
 * change.
 *
 * - `scheduleErrorRetry(state, key, retry)` records `key` (a region or tile)
 *   as failed and sets one timer, if none is pending, that calls `retry`
 *   (the mode's `invalidate`, which refetches whatever is still missing).
 *   Failures while a timer is pending join that cycle: the backoff grows
 *   once per retry cycle, not once per failed region.
 * - The delay is `ERROR_RETRY_BASE_MS` doubling per cycle up to
 *   `ERROR_RETRY_MAX_MS`, scaled by a random factor in [0.75, 1.25).
 * - `errorRetrySucceeded(state, key)` clears `key`; the backoff resets only
 *   once no failed key is left, so a permanently broken region keeps its
 *   growing delay even while its neighbours load.
 * - After `ERROR_RETRY_MAX_CYCLES` cycles no more retries are scheduled
 *   until `errorRetryViewChanged` (a new view or selector) starts over.
 * - While a retry is pending the mode reports chunks loading, so the UI
 *   shows its loading state instead of a blank; once retries stop, it no
 *   longer does.
 */
export interface ErrorRetryState {
  timer: ReturnType<typeof setTimeout> | null
  /** Retry cycles scheduled since the last reset. */
  failures: number
  /** Regions / tiles whose latest read failed. */
  failedKeys: Set<string>
}

export const ERROR_RETRY_BASE_MS = 1000
export const ERROR_RETRY_MAX_MS = 30000
/** Retry cycles per view (1 + 2 + 4 + 8 + 16 + 30 s, about a minute). */
export const ERROR_RETRY_MAX_CYCLES = 6

export function createErrorRetryState(): ErrorRetryState {
  return { timer: null, failures: 0, failedKeys: new Set() }
}

/** Delay before retry cycle `failures` (1-based), jittered. */
export function errorRetryDelay(
  failures: number,
  random: () => number = Math.random
): number {
  const base = Math.min(
    ERROR_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1),
    ERROR_RETRY_MAX_MS
  )
  return base * (0.75 + 0.5 * random())
}

/**
 * `key` failed: schedule `retry` after the next backoff delay. No-op while a
 * retry is pending (the failure joins it) or once the cycles are used up.
 * Returns whether a retry is pending.
 */
export function scheduleErrorRetry(
  state: ErrorRetryState,
  key: string,
  retry: () => void
): boolean {
  state.failedKeys.add(key)
  if (state.timer !== null) return true
  if (state.failures >= ERROR_RETRY_MAX_CYCLES) return false
  state.failures++
  state.timer = setTimeout(() => {
    state.timer = null
    retry()
  }, errorRetryDelay(state.failures))
  return true
}

/** `key`'s read succeeded; reset the backoff once nothing failed is left. */
export function errorRetrySucceeded(state: ErrorRetryState, key: string): void {
  state.failedKeys.delete(key)
  if (state.failedKeys.size === 0) state.failures = 0
}

/** The view or selector changed: start the retry cycles over. */
export function errorRetryViewChanged(state: ErrorRetryState): void {
  state.failures = 0
  state.failedKeys.clear()
}

export function clearErrorRetry(state: ErrorRetryState): void {
  if (state.timer !== null) clearTimeout(state.timer)
  state.timer = null
  state.failures = 0
  state.failedKeys.clear()
}

// ============================================================================
// Throttle Management
// ============================================================================

export interface ThrottleState {
  lastFetchTime: number
  throttleTimeout: ReturnType<typeof setTimeout> | null
  throttledPending: boolean
}

export function createThrottleState(): ThrottleState {
  return {
    lastFetchTime: 0,
    throttleTimeout: null,
    throttledPending: false,
  }
}

/**
 * Check if we should throttle (wait before fetching).
 * Returns the wait time in ms if we should throttle, or 0 if we can proceed.
 */
export function getThrottleWaitTime(
  state: ThrottleState,
  throttleMs: number
): number {
  if (throttleMs <= 0) return 0
  const now = Date.now()
  const timeSinceLastFetch = now - state.lastFetchTime
  if (timeSinceLastFetch < throttleMs) {
    return throttleMs - timeSinceLastFetch
  }
  return 0
}

/**
 * Schedule a throttled update callback after the wait time.
 * Only schedules if no timeout is already pending.
 */
export function scheduleThrottledUpdate(
  state: ThrottleState,
  waitTime: number,
  invalidate: () => void
): void {
  if (state.throttleTimeout) return // Already scheduled

  state.throttledPending = true
  state.throttleTimeout = setTimeout(() => {
    state.throttleTimeout = null
    state.throttledPending = false
    invalidate()
  }, waitTime)
}

/**
 * Mark that a fetch is starting (update timestamp).
 */
export function markFetchStart(state: ThrottleState): void {
  state.lastFetchTime = Date.now()
}

/**
 * Clear any pending throttle timeout.
 */
export function clearThrottle(state: ThrottleState): void {
  if (state.throttleTimeout) {
    clearTimeout(state.throttleTimeout)
    state.throttleTimeout = null
  }
  state.throttledPending = false
}

// ============================================================================
// Request Cancellation
// ============================================================================

export interface RequestCanceller {
  controllers: Map<number, AbortController>
  currentVersion: number
}

export function createRequestCanceller(): RequestCanceller {
  return {
    controllers: new Map(),
    currentVersion: 0,
  }
}

/**
 * Cancel all requests older than the completed version.
 */
export function cancelOlderRequests(
  canceller: RequestCanceller,
  completedVersion: number
): void {
  for (const [version, controller] of canceller.controllers) {
    if (version < completedVersion) {
      controller.abort()
      canceller.controllers.delete(version)
    }
  }
}

/**
 * Cancel all pending requests.
 */
export function cancelAllRequests(canceller: RequestCanceller): void {
  for (const controller of canceller.controllers.values()) {
    controller.abort()
  }
  canceller.controllers.clear()
}

/**
 * Check if any requests are still pending (not aborted).
 */
export function hasActiveRequests(canceller: RequestCanceller): boolean {
  for (const controller of canceller.controllers.values()) {
    if (!controller.signal.aborted) {
      return true
    }
  }
  return false
}

// ============================================================================
// Loading State Management
// ============================================================================

export interface LoadingManager {
  callback: LoadingStateCallback | undefined
  metadataLoading: boolean
  chunksLoading: boolean
}

export function createLoadingManager(): LoadingManager {
  return {
    callback: undefined,
    metadataLoading: false,
    chunksLoading: false,
  }
}

export function setLoadingCallback(
  manager: LoadingManager,
  callback: LoadingStateCallback | undefined
): void {
  manager.callback = callback
}

export function emitLoadingState(manager: LoadingManager): void {
  if (!manager.callback) return
  const state: LoadingState = {
    loading: manager.metadataLoading || manager.chunksLoading,
    metadata: manager.metadataLoading,
    chunks: manager.chunksLoading,
    error: null,
  }
  manager.callback(state)
}
