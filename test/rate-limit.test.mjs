// ace-viz task 44 (HF resolver rate limit): shard-batched prefetch, the
// limiter's batch groups, macrotask range coalescing, the per-origin request
// gate (token bucket + 429 backoff), prefetch step retries after a failure,
// and the delayed refetch after a failed render read. Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as zarr from 'zarrita'
import { loadSrc } from './load-src.mjs'

const { PrefetchQueue } = await loadSrc('src/prefetch-queue.ts')
const { RequestLimiter } = await loadSrc('src/request-limiter.ts')
const { withRangeCoalescing } = await loadSrc('src/range-coalescing.ts')
const {
  RequestGate,
  gatedFetch,
  configureRequestGate,
  requestGateFor,
  resetRequestGates,
} = await loadSrc('src/request-gate.ts')
const { readShardShape } = await loadSrc('src/zarr-store.ts')
const { ZarrLayer } = await loadSrc('src/zarr-layer.ts')
const { UntiledMode } = await loadSrc('src/untiled-mode.ts')
const modeUtils = await loadSrc('src/mode-utils.ts')

const tick = () => new Promise((r) => setTimeout(r, 0))
// With mocked timers: let pending promise chains run
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

// ---- PrefetchQueue: shard batches ----------------------------------------

function batchQueue({ batchSize = 4, maxConcurrentSteps = 1, result } = {}) {
  const started = []
  const open = new Map()
  const cached = new Set()
  const queue = new PrefetchQueue({
    fetchStep: (idx, _dim, signal, info) =>
      new Promise((resolve) => {
        started.push({ idx, batch: info.batch })
        if (result) return resolve(result(idx))
        open.set(idx, () => {
          cached.add(idx)
          resolve(true)
        })
        signal.addEventListener('abort', () => resolve(true))
      }),
    isCached: (i) => cached.has(i),
    maxConcurrentSteps,
    batchSize: () => batchSize,
    failureRetryDelayMs: 1,
    maxFailureRetryDelayMs: 4,
    random: () => 0.5,
  })
  return { queue, started, open, cached }
}

test('queue: a step starts with the pending steps of its shard batch, past the step limit', () => {
  const h = batchQueue({ maxConcurrentSteps: 1 })
  // Window order: 5 first, then 8 (batch 2), 4, 6, 7 (batch 1)
  h.queue.set([5, 8, 4, 6, 7])
  assert.deepEqual(
    h.started.map((s) => s.idx),
    [5, 4, 6, 7],
    'batch 1 (steps 4-7) starts together; 8 waits'
  )
  assert.ok(h.started.every((s) => s.batch === 1))
  assert.deepEqual(h.queue.pendingIndices, [8])
})

test('queue: cached batch-mates are skipped; batchSize 1 keeps per-step starts', () => {
  const h = batchQueue({ maxConcurrentSteps: 1 })
  h.cached.add(6)
  h.queue.set([4, 5, 6, 7])
  assert.deepEqual(
    h.started.map((s) => s.idx),
    [4, 5, 7]
  )
  const g = batchQueue({ batchSize: 1, maxConcurrentSteps: 1 })
  g.queue.set([4, 5, 6, 7])
  assert.deepEqual(
    g.started.map((s) => s.idx),
    [4]
  )
  assert.equal(g.started[0].batch, undefined)
})

test("queue: a step that resolves 'failed' is retried with backoff, then dropped", async () => {
  let calls = 0
  const h = batchQueue({
    batchSize: 1,
    result: () => (++calls <= 2 ? 'failed' : true),
  })
  h.queue.set([3])
  await h.queue.whenIdle()
  assert.equal(calls, 3, 'two failures, then a success')
  assert.equal(h.queue.stats.failureRetries, 2)
  assert.equal(h.queue.stats.completed, 1)

  let n = 0
  const always = batchQueue({ batchSize: 1, result: () => (n++, 'failed') })
  always.queue.set([3])
  await always.queue.whenIdle()
  assert.equal(n, 6, 'first attempt + maxFailureRetries (5)')
})

test("queue: a failed step's retry stops when a new window drops it", async () => {
  let calls = 0
  const queue = new PrefetchQueue({
    fetchStep: async () => (calls++, 'failed'),
    isCached: () => false,
    failureRetryDelayMs: 10_000,
    random: () => 0.5,
  })
  queue.set([1])
  await tick()
  queue.set([2])
  await tick()
  assert.equal(calls, 2, 'step 1 once, then step 2; step 1 is not retried')
  queue.clear()
  await queue.whenIdle()
})

// ---- RequestLimiter groups -------------------------------------------------

test('limiter: tasks of a running group start past the cap; others wait', async () => {
  const limiter = new RequestLimiter(2)
  const release = []
  const task = (name, log) => () =>
    new Promise((r) => {
      log.push(name)
      release.push(r)
    })
  const log = []
  limiter.run(task('a1', log), { group: 'A' })
  limiter.run(task('x', log))
  // Cap reached: a group-A task still starts, an ungrouped one waits
  limiter.run(task('a2', log), { group: 'A' })
  limiter.run(task('y', log))
  limiter.run(task('b1', log), { group: 'B' })
  assert.deepEqual(log, ['a1', 'x', 'a2'])
  assert.equal(limiter.pending, 2)
  // When a waiter of a group starts, its group's other waiters go with it
  const l2 = new RequestLimiter(1)
  const log2 = []
  const rel2 = []
  const t2 = (name) => () =>
    new Promise((r) => {
      log2.push(name)
      rel2.push(r)
    })
  l2.run(t2('first'))
  l2.run(t2('c1'), { group: 'C' })
  l2.run(t2('z'))
  l2.run(t2('c2'), { group: 'C' })
  rel2[0]()
  await tick()
  assert.deepEqual(log2, ['first', 'c1', 'c2'])
  for (const r of release) r()
})

// ---- Range coalescing across microtask depths -------------------------------

test('coalescing: reads issued in one task at different promise depths go out as one request', async () => {
  const calls = []
  const base = {
    async get() {
      return undefined
    },
    async getRange(key, range) {
      calls.push(range)
      return new Uint8Array(range.length)
    },
  }
  const store = await zarr.extendStore(base, (s) => withRangeCoalescing(s))
  const deep = async (n, offset) => {
    for (let i = 0; i < n; i++) await Promise.resolve()
    return store.getRange('/a', { offset, length: 10 })
  }
  // Like zarrita: chunk reads reach getRange after different numbers of awaits
  await Promise.all([deep(0, 0), deep(3, 10), deep(9, 20), deep(20, 30)])
  assert.deepEqual(calls, [{ offset: 0, length: 40 }])
})

// ---- RequestGate -----------------------------------------------------------

function fakeClock() {
  let t = 0
  return { now: () => t, advance: (ms) => (t += ms) }
}

test('gate: the token bucket lets a burst through, then paces at the rate', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const gate = new RequestGate({ maxRequestsPerSecond: 4, burst: 2 })
  const got = []
  for (let i = 0; i < 5; i++) gate.acquire().then(() => got.push(i))
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(got, [0, 1], 'burst of 2')
  t.mock.timers.tick(250)
  await Promise.resolve()
  assert.deepEqual(got, [0, 1, 2], 'one more token per 250 ms')
  t.mock.timers.tick(500)
  await Promise.resolve()
  assert.deepEqual(got, [0, 1, 2, 3, 4])
})

test('gate: no cap means no waiting', async () => {
  const gate = new RequestGate()
  for (let i = 0; i < 50; i++) await gate.acquire()
  assert.equal(gate.stats.waited, 0)
})

test('gate: a 429 starts a jittered cooldown; one probe, then the rest after it succeeds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const gate = new RequestGate({}, { random: () => 0.5 }) // jitter factor 1
  const first = await gate.acquire()
  gate.done(first, 'rate-limited')
  assert.equal(gate.rateLimited, true)
  const got = []
  const tickets = []
  for (let i = 0; i < 3; i++)
    gate.acquire().then((tk) => {
      got.push(i)
      tickets.push(tk)
    })
  t.mock.timers.tick(1999)
  await Promise.resolve()
  assert.deepEqual(got, [], 'waiting out the 2 s cooldown')
  t.mock.timers.tick(1)
  await Promise.resolve()
  assert.deepEqual(got, [0], 'one probe')
  assert.equal(tickets[0].probe, true)
  gate.done(tickets[0], 'ok')
  await Promise.resolve()
  assert.deepEqual(got, [0, 1, 2], 'the others follow the successful probe')
  assert.equal(gate.rateLimited, false)
})

test('gate: a failed probe doubles the cooldown (to 30 s max); 429s already in flight do not', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const gate = new RequestGate({}, { random: () => 0.5 })
  const a = await gate.acquire()
  const b = await gate.acquire()
  gate.done(a, 'rate-limited')
  gate.done(b, 'rate-limited') // same burst: no doubling
  let probe = gate.acquire()
  t.mock.timers.tick(2000)
  let tk = await probe
  gate.done(tk, 'rate-limited') // 4 s now
  probe = gate.acquire()
  let settled = false
  probe.then(() => (settled = true))
  t.mock.timers.tick(3999)
  await Promise.resolve()
  assert.equal(settled, false)
  t.mock.timers.tick(1)
  tk = await probe
  for (const ms of [8000, 16000, 30000, 30000]) {
    gate.done(tk, 'rate-limited')
    probe = gate.acquire()
    t.mock.timers.tick(ms - 1)
    settled = false
    probe.then(() => (settled = true))
    await Promise.resolve()
    assert.equal(settled, false, `still cooling at ${ms - 1} ms`)
    t.mock.timers.tick(1)
    tk = await probe
  }
})

test('gate: aborting while waiting rejects with an AbortError and frees the queue', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const gate = new RequestGate({ maxRequestsPerSecond: 1, burst: 1 })
  await gate.acquire()
  const controller = new AbortController()
  const waiting = gate.acquire(controller.signal)
  assert.equal(gate.pending, 1)
  controller.abort()
  await assert.rejects(waiting, { name: 'AbortError' })
  assert.equal(gate.pending, 0)
})

test('gatedFetch: a 429 is retried after the cooldown and the caller gets the answer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const gate = new RequestGate({}, { random: () => 0.5 })
  const statuses = [429, 206]
  let calls = 0
  const f = gatedFetch(
    async () => new Response('x', { status: statuses[calls++] }),
    () => gate
  )
  const pending = f(new Request('http://h.invalid/a'))
  await flush()
  assert.equal(calls, 1)
  t.mock.timers.tick(2000)
  const res = await pending
  assert.equal(res.status, 206)
  assert.equal(calls, 2)
  assert.equal(gate.stats.rateLimited, 1)
})

test('gatedFetch: a TypeError backs off only with networkErrorsBackOff (rate-capped hosts)', async () => {
  const fail = async () => {
    throw new TypeError('Failed to fetch')
  }
  const plain = new RequestGate()
  await assert.rejects(
    gatedFetch(fail, () => plain)(new Request('http://h.invalid/a')),
    TypeError
  )
  assert.equal(plain.rateLimited, false)
  const capped = new RequestGate({
    maxRequestsPerSecond: 5,
    networkErrorsBackOff: true,
  })
  await assert.rejects(
    gatedFetch(fail, () => capped)(new Request('http://h.invalid/a')),
    TypeError
  )
  assert.equal(capped.rateLimited, true)
})

test('configureRequestGate: one gate per origin; a cap turns on the network-error backoff', () => {
  resetRequestGates()
  try {
    const g = configureRequestGate(
      'https://huggingface.co/buckets/a/resolve/x.zarr',
      {
        maxRequestsPerSecond: 5,
      }
    )
    assert.equal(requestGateFor('https://huggingface.co/other'), g)
    assert.notEqual(requestGateFor('https://example.org/x'), g)
    assert.equal(g.maxRequestsPerSecond, 5)
    assert.equal(g.networkErrorsBackOff, true)
    // A layer with a source and the option configures it
    new ZarrLayer({
      id: 't',
      source: 'https://huggingface.co/buckets/b/resolve/y.zarr',
      variable: 'v',
      clim: [0, 1],
      colormap: ['#000000', '#ffffff'],
      maxRequestsPerSecond: 3,
    })
    assert.equal(g.maxRequestsPerSecond, 3)
  } finally {
    resetRequestGates()
  }
})

// ---- Batch size ------------------------------------------------------------

test('readShardShape: the shard shape of a sharded v3 array, else null', async () => {
  const meta = (codecs) =>
    new TextEncoder().encode(
      JSON.stringify({
        chunk_grid: { configuration: { chunk_shape: [4, 1, 4160, 11520] } },
        codecs,
      })
    )
  const store = (bytes) => ({
    get: async (k) => (k === '/PRATEsfc/zarr.json' ? bytes : undefined),
  })
  assert.deepEqual(
    await readShardShape(
      store(meta([{ name: 'sharding_indexed' }])),
      'PRATEsfc'
    ),
    [4, 1, 4160, 11520]
  )
  assert.equal(
    await readShardShape(store(meta([{ name: 'bytes' }])), 'PRATEsfc'),
    null
  )
  assert.equal(await readShardShape(store(undefined), 'PRATEsfc'), null)
  assert.equal(
    await readShardShape(store(new TextEncoder().encode('{')), 'PRATEsfc'),
    null
  )
})

test('getPrefetchBatchSize: the time extent of a shard, in range mode, up to 16', () => {
  const layer = new ZarrLayer({
    id: 't',
    source: 'http://example.invalid/s.zarr',
    variable: 'v',
    clim: [0, 1],
    colormap: ['#000000', '#ffffff'],
  })
  const store = (shards, rangeRequests = true) => ({
    shards,
    dimensions: ['time', 'ensemble', 'latitude', 'longitude'],
    cachingStore: { rangeRequests },
  })
  layer.zarrStore = store([4, 1, 4160, 11520])
  assert.equal(layer.getPrefetchBatchSize(), 4)
  layer.zarrStore = store([4, 1, 4160, 11520], false)
  assert.equal(layer.getPrefetchBatchSize(), 1, 'whole objects')
  layer.zarrStore = store([400, 1, 180, 360])
  assert.equal(layer.getPrefetchBatchSize(), 1, 'too many steps per shard')
  layer.zarrStore = store(null)
  assert.equal(layer.getPrefetchBatchSize(), 1, 'not sharded')
})

// ---- Delayed refetch after a failed render read -----------------------------

test('errorRetryDelay: 1 s doubling to 30 s, jittered ±25 %', () => {
  const { errorRetryDelay } = modeUtils
  assert.equal(
    errorRetryDelay(1, () => 0.5),
    1000
  )
  assert.equal(
    errorRetryDelay(2, () => 0.5),
    2000
  )
  assert.equal(
    errorRetryDelay(6, () => 0.5),
    30000
  )
  assert.equal(
    errorRetryDelay(1, () => 0),
    750
  )
  assert.ok(errorRetryDelay(1, () => 0.999) < 1250)
})

test('UntiledMode: a failed region read schedules one delayed invalidate and reports loading meanwhile', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const P = UntiledMode.prototype
  let invalidations = 0
  const emitted = []
  const state = {
    isRemoved: false,
    errorRetry: modeUtils.createErrorRetryState(),
    throttleState: modeUtils.createThrottleState(),
    loadingManager: {
      metadataLoading: false,
      chunksLoading: false,
      callback: (s) => emitted.push(s.chunks),
    },
    requestCanceller: { controllers: new Map() },
    invalidate: () => invalidations++,
    emitLoadingState: P.emitLoadingState,
  }
  state.loadingManager.callback = undefined
  const loading = () => state.loadingManager.chunksLoading
  P.scheduleRetryAfterError.call(state)
  P.scheduleRetryAfterError.call(state) // a second failure while pending: one timer
  assert.equal(loading(), true, 'loading while the retry is pending')
  // First failure: 1 s ± 25 %
  t.mock.timers.tick(749)
  assert.equal(invalidations, 0)
  t.mock.timers.tick(501)
  assert.equal(invalidations, 1)
  assert.equal(loading(), false, 'nothing in flight after the timer')
  // Another failure: the delay has doubled (two failures so far + this one)
  P.scheduleRetryAfterError.call(state)
  t.mock.timers.tick(2999)
  assert.equal(invalidations, 1)
  t.mock.timers.tick(2001)
  assert.equal(invalidations, 2)
  modeUtils.errorRetrySucceeded(state.errorRetry)
  assert.equal(state.errorRetry.failures, 0)
  // Removed: no retry
  state.isRemoved = true
  P.scheduleRetryAfterError.call(state)
  t.mock.timers.tick(60000)
  assert.equal(invalidations, 2)
})
