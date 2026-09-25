// Unit tests for the incremental prefetch queue.
// Run: node --test test/ (Node >= 23.6 strips the TypeScript types natively).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PrefetchQueue } from '../src/prefetch-queue.ts'

// Fake fetcher: each step resolves when the test calls finish(idx), or
// rejects with AbortError when its signal aborts (like zarr.get).
// `maxConcurrentSteps` defaults to 1 here: the task-19 tests below encode the
// strictly sequential order, which the queue keeps with a limit of 1. The
// concurrency tests (task 30) pass the limit explicitly or omit the option
// with `concurrent: true` to use the queue's default (4).
function harness({
  notReadyFor = new Map(),
  maxRetryDelayMs,
  onBusyChange,
  maxConcurrentSteps = 1,
  concurrent = false,
} = {}) {
  const cached = new Set()
  const log = []
  const seqs = []
  const open = new Map()
  // Fetches started and not yet settled; `peak` is the most at once
  const live = { now: 0, peak: 0 }
  const fetchStep = (idx, dim, signal, info) =>
    new Promise((resolve, reject) => {
      log.push(`start ${idx}${dim === 'time' ? '' : ':' + dim}`)
      seqs.push([idx, info?.seq])
      live.now++
      live.peak = Math.max(live.peak, live.now)
      const left = notReadyFor.get(idx) ?? 0
      if (left > 0) {
        notReadyFor.set(idx, left - 1)
        log.push(`notready ${idx}`)
        live.now--
        resolve(false)
        return
      }
      signal.addEventListener('abort', () => {
        log.push(`abort ${idx}`)
        open.delete(idx)
        live.now--
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      })
      open.set(idx, () => {
        cached.add(idx)
        log.push(`done ${idx}`)
        open.delete(idx)
        live.now--
        resolve(true)
      })
    })
  const queue = new PrefetchQueue({
    fetchStep,
    isCached: (i) => cached.has(i),
    retryDelayMs: 1,
    maxRetryDelayMs,
    onBusyChange,
    ...(concurrent ? {} : { maxConcurrentSteps }),
  })
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const finish = async (idx) => {
    await tick()
    assert.ok(
      open.has(idx),
      `step ${idx} not in flight (log: ${log.join(', ')})`
    )
    open.get(idx)()
    await tick()
  }
  return { queue, cached, log, finish, tick, live, seqs, open }
}

test('fetches the window sequentially in priority order', async () => {
  const h = harness()
  h.queue.set([3, 1, 2])
  await h.finish(3)
  await h.finish(1)
  await h.finish(2)
  await h.queue.whenIdle()
  assert.deepEqual(h.log, [
    'start 3',
    'done 3',
    'start 1',
    'done 1',
    'start 2',
    'done 2',
  ])
  assert.deepEqual(h.queue.stats, {
    started: 3,
    completed: 3,
    aborted: 0,
  })
})

test('keeps the in-flight step when it is still wanted', async () => {
  const h = harness()
  h.queue.set([1, 2, 3])
  await h.tick()
  assert.equal(h.queue.inFlightIndex, 1)
  // Cursor moved: the new window still contains 1
  h.queue.set([2, 1, 4])
  assert.equal(h.queue.inFlightIndex, 1)
  assert.deepEqual(h.queue.pendingIndices, [2, 4])
  await h.finish(1)
  await h.finish(2)
  await h.finish(4)
  await h.queue.whenIdle()
  assert.ok(!h.log.includes('abort 1'))
  assert.ok(!h.log.includes('start 3'), 'dropped step 3 must not be fetched')
  assert.equal(h.queue.stats.aborted, 0)
})

test('aborts the in-flight step only when no longer wanted, then continues', async () => {
  const h = harness()
  h.queue.set([1, 2])
  await h.tick()
  h.queue.set([5, 6])
  await h.tick()
  assert.ok(h.log.includes('abort 1'))
  assert.equal(h.queue.inFlightIndex, 5)
  await h.finish(5)
  await h.finish(6)
  await h.queue.whenIdle()
  assert.deepEqual(h.log, [
    'start 1',
    'abort 1',
    'start 5',
    'done 5',
    'start 6',
    'done 6',
  ])
  assert.equal(h.queue.stats.aborted, 1)
})

test('skips cached, duplicate and invalid indices', async () => {
  const h = harness()
  h.cached.add(2)
  h.queue.set([1, 2, 1, 3, -1, 2.5])
  await h.tick()
  assert.equal(h.queue.inFlightIndex, 1)
  assert.deepEqual(h.queue.pendingIndices, [3])
  await h.finish(1)
  await h.finish(3)
  await h.queue.whenIdle()
  assert.equal(h.queue.stats.started, 2)
})

test('repeated identical windows do not restart anything', async () => {
  const h = harness()
  h.queue.set([1, 2, 3])
  await h.tick()
  for (let i = 0; i < 10; i++) h.queue.set([1, 2, 3])
  await h.finish(1)
  await h.finish(2)
  await h.finish(3)
  await h.queue.whenIdle()
  assert.deepEqual(h.queue.stats, {
    started: 3,
    completed: 3,
    aborted: 0,
  })
})

test('changing the time dimension aborts the in-flight step', async () => {
  const h = harness()
  h.queue.set([1], 'time')
  await h.tick()
  h.queue.set([1], 'valid_time')
  await h.tick()
  assert.ok(h.log.includes('abort 1'))
  await h.finish(1)
  await h.queue.whenIdle()
  assert.deepEqual(h.log, [
    'start 1',
    'abort 1',
    'start 1:valid_time',
    'done 1',
  ])
})

test('retries a step whose fetcher is not ready yet', async () => {
  const h = harness({ notReadyFor: new Map([[1, 2]]) })
  h.queue.set([1])
  await new Promise((r) => setTimeout(r, 20))
  await h.finish(1)
  await h.queue.whenIdle()
  assert.deepEqual(h.log, [
    'start 1',
    'notready 1',
    'start 1',
    'notready 1',
    'start 1',
    'done 1',
  ])
  assert.equal(h.queue.stats.started, 1)
})

test('clear() aborts in flight and drops pending', async () => {
  const h = harness()
  h.queue.set([1, 2, 3])
  await h.tick()
  h.queue.clear()
  await h.queue.whenIdle()
  assert.deepEqual(h.log, ['start 1', 'abort 1'])
  assert.equal(h.queue.inFlightIndex, null)
})

test('holding a key: sliding windows extend instead of restarting', async () => {
  // Simulate a forward window of 4 that slides by one step per move while
  // each step takes one "finish" to complete: no in-flight abort ever.
  const h = harness()
  let cursor = 0
  const windowAt = (c) => [c + 1, c + 2, c + 3, c + 4]
  h.queue.set(windowAt(cursor))
  for (let move = 0; move < 6; move++) {
    await h.finish(h.queue.inFlightIndex)
    cursor++
    h.queue.set(windowAt(cursor))
  }
  assert.equal(h.queue.stats.aborted, 0)
  for (let i = 1; i <= 6; i++) assert.ok(h.cached.has(i), `step ${i} cached`)
  h.queue.clear()
  await h.queue.whenIdle()
})

test('re-wanting a step aborted by an earlier window re-queues it', async () => {
  const h = harness()
  h.queue.set([1])
  await h.tick()
  h.queue.set([3]) // aborts 1; its fetch has not settled yet
  h.queue.set([1, 3]) // must not treat the aborted 1 as still in flight
  assert.deepEqual(h.queue.pendingIndices, [1, 3])
  await h.finish(1)
  await h.finish(3)
  await h.queue.whenIdle()
  assert.ok(h.cached.has(1) && h.cached.has(3))
  assert.deepEqual(h.log, [
    'start 1',
    'abort 1',
    'start 1',
    'done 1',
    'start 3',
    'done 3',
  ])
})

test('a still-wanted step that is not ready is retried until it is fetched (no cap)', async () => {
  // 150 "not ready" results: more than the old 100-retry cap
  const h = harness({ notReadyFor: new Map([[1, 150]]), maxRetryDelayMs: 1 })
  h.queue.set([1])
  const deadline = Date.now() + 5000
  while (h.log.filter((l) => l === 'notready 1').length < 150) {
    assert.ok(Date.now() < deadline, 'step stopped retrying')
    await new Promise((r) => setTimeout(r, 5))
  }
  await h.finish(1)
  await h.queue.whenIdle()
  assert.ok(h.cached.has(1))
  assert.deepEqual(h.queue.stats, { started: 1, completed: 1, aborted: 0 })
})

test('a not-ready step stops retrying once a new window drops it', async () => {
  const h = harness({
    notReadyFor: new Map([[1, Infinity]]),
    maxRetryDelayMs: 1,
  })
  h.queue.set([1])
  await new Promise((r) => setTimeout(r, 20))
  h.queue.set([2])
  await h.finish(2)
  await h.queue.whenIdle()
  const retries = h.log.filter((l) => l === 'notready 1').length
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(h.log.filter((l) => l === 'notready 1').length, retries)
  assert.ok(h.cached.has(2))
})

test('busy: true from the first step until the queue drains, one change each way', async () => {
  const changes = []
  const h = harness({ onBusyChange: (b) => changes.push(b) })
  assert.equal(h.queue.busy, false)
  h.queue.set([])
  assert.deepEqual(changes, [], 'an empty window never starts the pump')
  h.queue.set([1, 2])
  assert.equal(h.queue.busy, true)
  await h.finish(1)
  // A new window while busy extends the same busy period
  h.queue.set([2, 3])
  await h.finish(2)
  await h.finish(3)
  await h.queue.whenIdle()
  assert.equal(h.queue.busy, false)
  assert.deepEqual(changes, [true, false])

  h.queue.set([4])
  h.queue.clear()
  await h.queue.whenIdle()
  assert.equal(h.queue.busy, false)
  assert.deepEqual(changes, [true, false, true, false], 'clear() ends it')
})

test('busy stays true while a not-ready step waits to retry', async () => {
  const changes = []
  const h = harness({
    notReadyFor: new Map([[1, 3]]),
    onBusyChange: (b) => changes.push(b),
  })
  h.queue.set([1])
  await h.tick()
  assert.equal(h.queue.busy, true)
  // Three not-ready attempts, then the fourth start stays in flight
  while (h.log.filter((l) => l === 'start 1').length < 4) {
    assert.equal(h.queue.busy, true)
    await new Promise((r) => setTimeout(r, 2))
  }
  await h.finish(1)
  await h.queue.whenIdle()
  assert.deepEqual(changes, [true, false])
})

// ---- Task 30: several steps in flight ----

test('default: up to 4 steps run concurrently, never more', async () => {
  const h = harness({ concurrent: true })
  assert.equal(h.queue.maxConcurrentSteps, 4)
  h.queue.set([1, 2, 3, 4, 5, 6, 7, 8, 9])
  await h.tick()
  assert.deepEqual(h.queue.inFlightIndices, [1, 2, 3, 4])
  assert.deepEqual(h.queue.pendingIndices, [5, 6, 7, 8, 9])
  // Finish out of order; each freed slot is refilled from the front
  for (const idx of [3, 1, 5, 2, 4, 8, 6, 7, 9]) {
    await h.finish(idx)
    assert.ok(h.live.now <= 4, `${h.live.now} in flight`)
  }
  await h.queue.whenIdle()
  assert.equal(h.live.peak, 4)
  assert.deepEqual(h.queue.stats, { started: 9, completed: 9, aborted: 0 })
})

test('maxConcurrentSteps option: invalid values use the default, fractions floor', () => {
  const make = (n) =>
    new PrefetchQueue({
      fetchStep: async () => true,
      isCached: () => false,
      maxConcurrentSteps: n,
    }).maxConcurrentSteps
  assert.equal(make(2), 2)
  assert.equal(make(2.9), 2)
  assert.equal(make(0), 4)
  assert.equal(make(-1), 4)
  assert.equal(make(NaN), 4)
  assert.equal(make(Infinity), 4)
})

test('a window change aborts only the unwanted in-flight steps and keeps the wanted ones', async () => {
  const h = harness({ maxConcurrentSteps: 4 })
  h.queue.set([1, 2, 3, 4, 5, 6])
  await h.tick()
  assert.deepEqual(h.queue.inFlightIndices, [1, 2, 3, 4])
  h.queue.set([4, 7, 2, 8])
  assert.deepEqual(h.queue.inFlightIndices, [2, 4], 'wanted steps kept')
  await h.tick()
  assert.ok(h.log.includes('abort 1') && h.log.includes('abort 3'))
  assert.ok(!h.log.includes('abort 2') && !h.log.includes('abort 4'))
  // The two freed slots go to the new steps, in window order
  assert.deepEqual(h.queue.inFlightIndices, [2, 4, 7, 8])
  assert.ok(!h.log.includes('start 5') && !h.log.includes('start 6'))
  for (const idx of [2, 4, 7, 8]) await h.finish(idx)
  await h.queue.whenIdle()
  assert.deepEqual(h.queue.stats, { started: 6, completed: 4, aborted: 2 })
  // An aborted step is never "kept": re-wanting 1 starts it again
  h.queue.set([1])
  await h.finish(1)
  assert.equal(h.log.filter((l) => l === 'start 1').length, 2)
})

test('an aborted step holds its slot until its fetch settles', async () => {
  // Fetcher that ignores abort until the test settles it by hand
  const settle = new Map()
  const started = []
  const queue = new PrefetchQueue({
    fetchStep: (idx) =>
      new Promise((resolve) => {
        started.push(idx)
        settle.set(idx, resolve)
      }),
    isCached: () => false,
    maxConcurrentSteps: 2,
  })
  queue.set([1, 2])
  queue.set([3, 4]) // aborts 1 and 2; they have not settled
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(started, [1, 2], 'no new step while both slots are held')
  settle.get(1)(true)
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(started, [1, 2, 3])
  settle.get(2)(true)
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(started, [1, 2, 3, 4])
  queue.clear()
  settle.get(3)(true)
  settle.get(4)(true)
  await queue.whenIdle()
})

test('freed slots are filled in window priority order, including after a window change', async () => {
  const h = harness({ maxConcurrentSteps: 2 })
  h.queue.set([10, 11, 12, 13, 14, 15])
  await h.tick()
  assert.deepEqual(h.queue.inFlightIndices, [10, 11])
  await h.finish(11)
  assert.deepEqual(h.queue.inFlightIndices, [10, 12])
  // New priorities: 15 before 13; 10 and 12 stay in flight
  h.queue.set([15, 13, 10, 12])
  assert.deepEqual(h.queue.pendingIndices, [15, 13])
  await h.finish(12)
  assert.deepEqual(h.queue.inFlightIndices, [10, 15])
  await h.finish(10)
  assert.deepEqual(h.queue.inFlightIndices, [15, 13])
  await h.finish(13)
  await h.finish(15)
  await h.queue.whenIdle()
  const starts = h.log
    .filter((l) => l.startsWith('start'))
    .map((l) => +l.slice(6))
  assert.deepEqual(starts, [10, 11, 12, 15, 13])
  assert.ok(!h.log.includes('start 14'))
  // Each step gets the next start number (its priority for the request cap)
  assert.deepEqual(
    h.seqs.map(([, seq]) => seq),
    [0, 1, 2, 3, 4]
  )
})

test('busy with concurrency: one true/false pair across overlapping steps; clear() ends it once all settle', async () => {
  const changes = []
  const h = harness({
    concurrent: true,
    onBusyChange: (b) => changes.push(b),
  })
  h.queue.set([1, 2, 3])
  assert.equal(h.queue.busy, true)
  await h.finish(2)
  await h.finish(1)
  assert.equal(h.queue.busy, true, 'step 3 still in flight')
  h.queue.set([3, 4])
  await h.finish(4)
  await h.finish(3)
  await h.queue.whenIdle()
  assert.deepEqual(changes, [true, false])

  h.queue.set([5, 6, 7, 8, 9])
  await h.tick()
  h.queue.clear()
  assert.equal(h.queue.busy, true, 'aborted steps have not settled yet')
  await h.queue.whenIdle()
  assert.equal(h.queue.busy, false)
  assert.deepEqual(changes, [true, false, true, false])
  assert.equal(h.queue.stats.aborted, 4)
  assert.ok(!h.log.includes('start 9'))
})

test('retries under concurrency: a not-ready step keeps retrying in its slot while the others finish', async () => {
  const h = harness({
    concurrent: true,
    notReadyFor: new Map([[1, 3]]),
  })
  h.queue.set([1, 2, 3])
  await h.finish(2)
  await h.finish(3)
  while (h.log.filter((l) => l === 'start 1').length < 4) {
    await new Promise((r) => setTimeout(r, 2))
  }
  assert.deepEqual(h.queue.inFlightIndices, [1])
  assert.equal(h.queue.busy, true)
  await h.finish(1)
  await h.queue.whenIdle()
  assert.deepEqual(h.queue.stats, { started: 3, completed: 3, aborted: 0 })
})

test('retries under concurrency: a dropped not-ready step stops retrying, wanted ones continue', async () => {
  const h = harness({
    concurrent: true,
    maxRetryDelayMs: 1,
    notReadyFor: new Map([
      [1, Infinity],
      [2, 2],
    ]),
  })
  h.queue.set([1, 2])
  await new Promise((r) => setTimeout(r, 20))
  h.queue.set([2, 3]) // drops 1
  await h.finish(3)
  await h.finish(2)
  await h.queue.whenIdle()
  const retries = h.log.filter((l) => l === 'notready 1').length
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(h.log.filter((l) => l === 'notready 1').length, retries)
  assert.ok(h.cached.has(2) && h.cached.has(3))
  assert.equal(h.queue.stats.aborted, 1)
})
