/**
 * @module range-coalescing
 *
 * Microtask-tick range batching, like zarrita's `withRangeCoalescing`
 * (same grouping: per path, sorted, merged across gaps up to
 * `coalesceSize`; suffix reads pass through), with one difference in abort
 * handling. zarrita aborts a group's fetch when *any* of its requests'
 * signals aborts (`AbortSignal.any`), which rejects the other requests of
 * the group with an AbortError although their callers never aborted (ace-viz
 * task 46 review). Here:
 *
 * - a request whose own signal aborts rejects on its own, at once;
 * - the group's fetch is aborted only when *every* request in it has
 *   aborted (never, if one of them has no signal);
 * - requests already aborted at flush time are left out of the groups, so
 *   they don't widen a fetch.
 *
 * And one difference in timing (ace-viz task 44): the batch is flushed on
 * the next macrotask (a MessageChannel message, see `nextTask`), not in a microtask, so every range
 * read issued in the same task is grouped, whatever the depth of the
 * promise chains that issued it. zarrita's getChunk reaches getRange after a
 * variable number of awaits (shard index, CachingStore, limiter), so a
 * microtask flush split the reads of one prefetch batch (several time steps
 * of one shard, issued together) into many requests. The cost is one
 * macrotask of latency per read, negligible next to a network round trip.
 *
 * Adapted from zarrita (github.com/manzt/zarrita.js), 0.7.1
 * `src/extension/range-coalescing.ts`.
 * Copyright (c) 2020-2023 Trevor Manz, MIT License.
 */

import * as zarr from 'zarrita'
import type { AbsolutePath, AsyncReadable, RangeQuery } from '@zarrita/storage'
import { BACKGROUND_REQUEST_HEADER } from './caching-store'

export const DEFAULT_COALESCE_SIZE = 32768
/**
 * Largest merged request (bytes). A shard batch of 4 release 3 km steps is
 * one ~42 MB run; this only stops pathological merges (task 44 review).
 */
export const DEFAULT_MAX_GROUP_BYTES = 64 * 1024 * 1024

interface PendingRequest {
  offset: number
  length: number
  signal?: AbortSignal
  /** Carries the background marker (see `BACKGROUND_REQUEST_HEADER`). */
  background: boolean
  resolve: (data: Uint8Array | undefined) => void
  reject: (err: unknown) => void
  settled: boolean
  /** Removes the request's abort listener (set by groupSignal). */
  detach?: () => void
}

/** Settle a request once, dropping its abort listener. */
function settle(
  req: PendingRequest,
  outcome: { data: Uint8Array | undefined } | { error: unknown }
): void {
  if (req.settled) return
  req.settled = true
  req.detach?.()
  if ('error' in outcome) req.reject(outcome.error)
  else req.resolve(outcome.data)
}

interface Group {
  offset: number
  length: number
  requests: PendingRequest[]
}

/**
 * Resolve on the next macrotask. A MessageChannel message, not
 * `setTimeout(0)`: browsers clamp timers in hidden tabs to about 1 s, which
 * would delay every coalesced read by a second there.
 */
let channel: MessageChannel | null = null
const nextTaskQueue: Array<() => void> = []
export function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel === 'undefined') {
      setTimeout(resolve, 0)
      return
    }
    type Port = MessagePort & { ref?: () => void; unref?: () => void }
    if (!channel) {
      channel = new MessageChannel()
      const port = channel.port1 as Port
      port.onmessage = () => {
        nextTaskQueue.shift()?.()
        // Node: an idle port must not keep the process alive
        if (nextTaskQueue.length === 0) port.unref?.()
      }
    }
    nextTaskQueue.push(resolve)
    ;(channel.port1 as Port).ref?.()
    channel.port2.postMessage(0)
  })
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function groupRequests(
  sorted: PendingRequest[],
  coalesceSize: number,
  maxGroupBytes: number = DEFAULT_MAX_GROUP_BYTES
): Group[] {
  const groups: Group[] = []
  let current: PendingRequest[] = []
  let start = 0
  let end = 0
  for (const req of sorted) {
    if (
      current.length > 0 &&
      req.offset <= end + coalesceSize &&
      Math.max(end, req.offset + req.length) - start <= maxGroupBytes
    ) {
      current.push(req)
      end = Math.max(end, req.offset + req.length)
      continue
    }
    if (current.length > 0) {
      groups.push({ offset: start, length: end - start, requests: current })
    }
    current = [req]
    start = req.offset
    end = req.offset + req.length
  }
  if (current.length > 0) {
    groups.push({ offset: start, length: end - start, requests: current })
  }
  return groups
}

/**
 * A signal that aborts once every request of the group has aborted, or
 * undefined when some request has no signal (the fetch can then never be
 * cancelled). Each request's own abort also rejects that request.
 */
function groupSignal(requests: PendingRequest[]): AbortSignal | undefined {
  const controller = new AbortController()
  let live = requests.length
  let cancellable = true
  for (const req of requests) {
    const signal = req.signal
    if (!signal) {
      cancellable = false
      continue
    }
    const onAbort = () => {
      settle(req, { error: abortError() })
      if (--live === 0 && cancellable) controller.abort()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    req.detach = () => signal.removeEventListener('abort', onAbort)
  }
  return cancellable ? controller.signal : undefined
}

export const withRangeCoalescing = zarr.defineStoreExtension(
  (
    store: AsyncReadable,
    opts: { coalesceSize?: number; maxGroupBytes?: number } = {}
  ) => {
    if (!store.getRange) {
      throw new Error('withRangeCoalescing requires a store with getRange')
    }
    const baseGetRange = store.getRange.bind(store)
    const coalesceSize = opts.coalesceSize ?? DEFAULT_COALESCE_SIZE
    const maxGroupBytes = opts.maxGroupBytes ?? DEFAULT_MAX_GROUP_BYTES
    let pending = new Map<AbsolutePath, PendingRequest[]>()
    let scheduled = false

    async function fetchGroup(path: AbsolutePath, group: Group) {
      const signal = groupSignal(group.requests)
      // Background (task 49) only when every member is: a render read in
      // the group makes the merged request a render read
      const headers = group.requests.every((r) => r.background)
        ? { [BACKGROUND_REQUEST_HEADER]: '1' }
        : undefined
      try {
        const data = await baseGetRange(
          path,
          { offset: group.offset, length: group.length },
          // FetchStore passes headers on into the Request
          (headers ? { signal, headers } : { signal }) as {
            signal?: AbortSignal
          }
        )
        if (data && data.length < group.length) {
          throw new Error(
            `Short read: expected ${group.length} bytes but received ${data.length}`
          )
        }
        let first = true
        for (const req of group.requests) {
          if (req.settled) continue
          // One member per task: each settle lets its caller decode the
          // chunk, and a 16-chunk group decoded in one go blocked the main
          // thread for ~0.5 s (task 44 review)
          if (!first) await nextTask()
          first = false
          if (req.settled) continue
          const start = req.offset - group.offset
          settle(req, {
            data: data ? data.slice(start, start + req.length) : undefined,
          })
        }
      } catch (err) {
        for (const req of group.requests) settle(req, { error: err })
      }
    }

    function flush() {
      const work = pending
      pending = new Map()
      scheduled = false
      for (const [path, all] of work) {
        // Requests aborted while waiting for the flush: reject, don't fetch
        const requests: PendingRequest[] = []
        for (const req of all) {
          if (req.signal?.aborted) settle(req, { error: abortError() })
          else requests.push(req)
        }
        if (requests.length === 0) continue
        requests.sort((a, b) => a.offset - b.offset)
        for (const group of groupRequests(
          requests,
          coalesceSize,
          maxGroupBytes
        )) {
          void fetchGroup(path, group)
        }
      }
    }

    return {
      getRange(
        key: AbsolutePath,
        range: RangeQuery,
        options?: { signal?: AbortSignal; headers?: Record<string, string> }
      ): Promise<Uint8Array | undefined> {
        // Suffix reads (shard indexes): size unknown, pass through
        if ('suffixLength' in range) return baseGetRange(key, range, options)
        if (options?.signal?.aborted) return Promise.reject(abortError())
        return new Promise((resolve, reject) => {
          let reqs = pending.get(key)
          if (!reqs) {
            reqs = []
            pending.set(key, reqs)
          }
          reqs.push({
            offset: range.offset,
            length: range.length,
            signal: options?.signal,
            background: !!options?.headers?.[BACKGROUND_REQUEST_HEADER],
            resolve,
            reject,
            settled: false,
          })
          if (!scheduled) {
            scheduled = true
            nextTask().then(flush)
          }
        })
      },
    }
  }
)
