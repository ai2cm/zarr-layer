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
 *   aborted (never, if one of them has no signal).
 */

import * as zarr from 'zarrita'
import type { AbsolutePath, AsyncReadable, RangeQuery } from '@zarrita/storage'

export const DEFAULT_COALESCE_SIZE = 32768

interface PendingRequest {
  offset: number
  length: number
  signal?: AbortSignal
  resolve: (data: Uint8Array | undefined) => void
  reject: (err: unknown) => void
  settled: boolean
}

interface Group {
  offset: number
  length: number
  requests: PendingRequest[]
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function groupRequests(
  sorted: PendingRequest[],
  coalesceSize: number
): Group[] {
  const groups: Group[] = []
  let current: PendingRequest[] = []
  let start = 0
  let end = 0
  for (const req of sorted) {
    if (current.length > 0 && req.offset <= end + coalesceSize) {
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
      if (!req.settled) {
        req.settled = true
        req.reject(abortError())
      }
      if (--live === 0 && cancellable) controller.abort()
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return cancellable ? controller.signal : undefined
}

export const withRangeCoalescing = zarr.defineStoreExtension(
  (store: AsyncReadable, opts: { coalesceSize?: number } = {}) => {
    if (!store.getRange) {
      throw new Error('withRangeCoalescing requires a store with getRange')
    }
    const baseGetRange = store.getRange.bind(store)
    const coalesceSize = opts.coalesceSize ?? DEFAULT_COALESCE_SIZE
    let pending = new Map<AbsolutePath, PendingRequest[]>()
    let scheduled = false

    async function fetchGroup(path: AbsolutePath, group: Group) {
      const signal = groupSignal(group.requests)
      try {
        const data = await baseGetRange(
          path,
          { offset: group.offset, length: group.length },
          { signal }
        )
        if (data && data.length < group.length) {
          throw new Error(
            `Short read: expected ${group.length} bytes but received ${data.length}`
          )
        }
        for (const req of group.requests) {
          if (req.settled) continue
          req.settled = true
          if (!data) {
            req.resolve(undefined)
            continue
          }
          const start = req.offset - group.offset
          req.resolve(data.slice(start, start + req.length))
        }
      } catch (err) {
        for (const req of group.requests) {
          if (req.settled) continue
          req.settled = true
          req.reject(err)
        }
      }
    }

    function flush() {
      const work = pending
      pending = new Map()
      scheduled = false
      for (const [path, requests] of work) {
        requests.sort((a, b) => a.offset - b.offset)
        for (const group of groupRequests(requests, coalesceSize)) {
          void fetchGroup(path, group)
        }
      }
    }

    return {
      getRange(
        key: AbsolutePath,
        range: RangeQuery,
        options?: { signal?: AbortSignal }
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
            resolve,
            reject,
            settled: false,
          })
          if (!scheduled) {
            scheduled = true
            queueMicrotask(flush)
          }
        })
      },
    }
  }
)
