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
const { TiledMode } = await loadSrc('src/tiled-mode.ts')
const modeUtils = await loadSrc('src/mode-utils.ts')

const tick = () => new Promise((r) => setTimeout(r, 0))
// With mocked timers: let pending promise chains run
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

// ---- PrefetchQueue: shard batches ----------------------------------------

function batchQueue({
  batchSize = 4,
  maxConcurrentSteps = 1,
  result,
  near = 0,
} = {}) {
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
    batchNearSteps: near,
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
  let estimate = null
  layer.getEstimatedTimestepBytes = () => estimate
  assert.equal(layer.getPrefetchBatchSize(), 1, 'no estimate yet (bootstrap)')
  estimate = 1e7
  assert.equal(layer.getPrefetchBatchSize(), 4)
  layer.zarrStore = store([4, 1, 4160, 11520], false)
  assert.equal(layer.getPrefetchBatchSize(), 1, 'whole objects')
  layer.zarrStore = store([400, 1, 180, 360])
  assert.equal(layer.getPrefetchBatchSize(), 1, 'too many steps per shard')
  layer.zarrStore = store(null)
  assert.equal(layer.getPrefetchBatchSize(), 1, 'not sharded')
  // prefetchBatchSteps halves an even shard extent until it fits
  const make = (prefetchBatchSteps) => {
    const l = new ZarrLayer({
      id: 't',
      source: 'http://example.invalid/s.zarr',
      variable: 'v',
      clim: [0, 1],
      colormap: ['#000000', '#ffffff'],
      prefetchBatchSteps,
    })
    l.getEstimatedTimestepBytes = () => 1e7
    l.zarrStore = store([8, 1, 4160, 11520])
    return l.getPrefetchBatchSize()
  }
  assert.equal(make(undefined), 4)
  assert.equal(make(2), 2)
  assert.equal(make(8), 8)
  assert.equal(make(1), 1)
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

test('scheduleErrorRetry: failures in one cycle count once; the next cycle doubles', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const st = modeUtils.createErrorRetryState()
  let retries = 0
  // 8 regions fail together: one timer, one cycle
  for (let i = 0; i < 8; i++)
    modeUtils.scheduleErrorRetry(st, `r${i}`, () => retries++)
  assert.equal(st.failures, 1)
  t.mock.timers.tick(1250)
  assert.equal(retries, 1, 'first cycle: 1 s ± 25 %')
  for (let i = 0; i < 8; i++)
    modeUtils.scheduleErrorRetry(st, `r${i}`, () => retries++)
  assert.equal(st.failures, 2)
  t.mock.timers.tick(1499)
  assert.equal(retries, 1, 'second cycle: at least 1.5 s')
  t.mock.timers.tick(1001)
  assert.equal(retries, 2, 'second cycle: under 2.5 s (not 16-30 s)')
})

test('errorRetrySucceeded: the backoff resets only when no failed region is left', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const st = modeUtils.createErrorRetryState()
  modeUtils.scheduleErrorRetry(st, 'broken', () => {})
  modeUtils.scheduleErrorRetry(st, 'flaky', () => {})
  t.mock.timers.tick(2000)
  modeUtils.errorRetrySucceeded(st, 'flaky')
  assert.equal(
    st.failures,
    1,
    'a neighbour loading does not reset the broken region'
  )
  modeUtils.scheduleErrorRetry(st, 'broken', () => {})
  assert.equal(st.failures, 2)
  t.mock.timers.tick(3000)
  modeUtils.errorRetrySucceeded(st, 'broken')
  assert.equal(st.failures, 0)
})

test('scheduleErrorRetry: stops after ERROR_RETRY_MAX_CYCLES in one view; a view change starts over', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const st = modeUtils.createErrorRetryState()
  let retries = 0
  for (let i = 0; i < modeUtils.ERROR_RETRY_MAX_CYCLES; i++) {
    assert.equal(
      modeUtils.scheduleErrorRetry(st, 'r', () => retries++),
      true
    )
    t.mock.timers.tick(40000)
  }
  assert.equal(retries, modeUtils.ERROR_RETRY_MAX_CYCLES)
  assert.equal(
    modeUtils.scheduleErrorRetry(st, 'r', () => retries++),
    false
  )
  assert.equal(st.timer, null, 'no timer: the mode stops reporting loading')
  t.mock.timers.tick(60000)
  assert.equal(retries, modeUtils.ERROR_RETRY_MAX_CYCLES)
  modeUtils.errorRetryViewChanged(st)
  assert.equal(
    modeUtils.scheduleErrorRetry(st, 'r', () => retries++),
    true
  )
})

test('UntiledMode: failed regions schedule one delayed invalidate, loading meanwhile, not after the retries stop', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const P = UntiledMode.prototype
  let invalidations = 0
  const state = {
    isRemoved: false,
    errorRetry: modeUtils.createErrorRetryState(),
    throttleState: modeUtils.createThrottleState(),
    loadingManager: { metadataLoading: false, chunksLoading: false },
    requestCanceller: { controllers: new Map() },
    invalidate: () => invalidations++,
    emitLoadingState: P.emitLoadingState,
  }
  const loading = () => state.loadingManager.chunksLoading
  for (const key of ['0:0,2', '0:1,2', '0:0,3', '0:1,3']) {
    P.scheduleRetryAfterError.call(state, key)
  }
  assert.equal(loading(), true, 'loading while the retry is pending')
  t.mock.timers.tick(1250)
  assert.equal(invalidations, 1, 'one invalidate for the four regions')
  assert.equal(loading(), false, 'nothing in flight after the timer')
  // Keep failing: retries stop after the cycles, and so does "loading"
  for (let i = 1; i < modeUtils.ERROR_RETRY_MAX_CYCLES + 2; i++) {
    P.scheduleRetryAfterError.call(state, '0:0,2')
    t.mock.timers.tick(40000)
  }
  assert.equal(invalidations, modeUtils.ERROR_RETRY_MAX_CYCLES)
  state.loadingManager.chunksLoading = false
  P.scheduleRetryAfterError.call(state, '0:0,2')
  assert.equal(loading(), false, 'no forced loading state once retries stop')
  // Removed: no retry
  modeUtils.errorRetryViewChanged(state.errorRetry)
  state.isRemoved = true
  P.scheduleRetryAfterError.call(state, '0:0,2')
  t.mock.timers.tick(60000)
  assert.equal(invalidations, modeUtils.ERROR_RETRY_MAX_CYCLES)
})

// ---- Review round 1 --------------------------------------------------------

test('queue: steps at the front of the window start alone, never batched', () => {
  const h = batchQueue({ maxConcurrentSteps: 1, near: 2 })
  h.queue.set([1, 2, 3, 5, 6, 7])
  // 1 is near: alone. (2 is near too, so it stays pending.)
  assert.deepEqual(
    h.started.map((s) => [s.idx, s.batch]),
    [[1, undefined]]
  )
  h.open.get(1)()
  return tick().then(() => {
    assert.deepEqual(h.started.at(-1), { idx: 2, batch: undefined })
    h.open.get(2)()
    return tick().then(() => {
      // 3 is far: it starts with... nothing else of batch 0 pending; then
      // batch 1 (5, 6, 7) together once a slot frees
      assert.deepEqual(
        h.started.slice(2).map((s) => s.idx),
        [3]
      )
      h.open.get(3)()
      return tick().then(() => {
        assert.deepEqual(
          h.started.slice(3).map((s) => [s.idx, s.batch]),
          [
            [5, 1],
            [6, 1],
            [7, 1],
          ]
        )
      })
    })
  })
})

test('limiter: a group bypasses the cap only up to GROUP_OVERSHOOT x max in all', async () => {
  const { GROUP_OVERSHOOT } = await loadSrc('src/request-limiter.ts')
  const limiter = new RequestLimiter(2)
  let started = 0
  for (let i = 0; i < 20; i++) {
    limiter.run(() => (started++, new Promise(() => {})), { group: 'A' })
  }
  assert.equal(started, 2 * GROUP_OVERSHOOT)
  assert.equal(limiter.pending, 20 - 2 * GROUP_OVERSHOOT)
})

test('coalescing: a merged request is capped at maxGroupBytes; members settle one per task', async () => {
  const calls = []
  const base = {
    async get() {},
    async getRange(key, range) {
      calls.push(range)
      return new Uint8Array(range.length)
    },
  }
  const store = await zarr.extendStore(base, (s) =>
    withRangeCoalescing(s, { maxGroupBytes: 25 })
  )
  await Promise.all(
    [0, 10, 20, 30].map((offset) =>
      store.getRange('/a', { offset, length: 10 })
    )
  )
  assert.deepEqual(calls, [
    { offset: 0, length: 20 },
    { offset: 20, length: 20 },
  ])
  // One group: a member's continuation runs before the next member settles
  const one = await zarr.extendStore(base, (s) => withRangeCoalescing(s))
  const order = []
  await Promise.all(
    [0, 10, 20].map((offset) =>
      one.getRange('/b', { offset, length: 10 }).then(() => {
        order.push(offset)
        return Promise.resolve().then(() => order.push(`after ${offset}`))
      })
    )
  )
  assert.deepEqual(order, [0, 'after 0', 10, 'after 10', 20, 'after 20'])
})

test('gate: a success from a request sent before the 429 does not end the rate limit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const gate = new RequestGate({}, { random: () => 0.5 })
  const a = await gate.acquire()
  const b = await gate.acquire()
  gate.done(a, 'rate-limited')
  gate.done(b, 'ok') // left before the 429, answered after it
  assert.equal(gate.rateLimited, true)
  const got = []
  for (let i = 0; i < 3; i++) gate.acquire().then((tk) => got.push(tk))
  t.mock.timers.tick(2000)
  await flush()
  assert.equal(got.length, 1, 'still one probe after the cooldown')
  assert.equal(got[0].probe, true)
  gate.done(got[0], 'ok')
  await flush()
  assert.equal(got.length, 3)
  assert.equal(gate.rateLimited, false)
})

test('gatedFetch: still rate-limited after giveUpMs -> RangeRateLimitedError', async () => {
  let clock = 1000
  const gate = new RequestGate({}, { random: () => 0.5 })
  let calls = 0
  const f = gatedFetch(
    async () => {
      calls++
      clock += 400_000 // this attempt ended 400 s after the first started
      return new Response(null, { status: 429 })
    },
    () => gate,
    { giveUpMs: 360_000, now: () => clock }
  )
  await assert.rejects(f(new Request('http://h.invalid/a')), {
    name: 'RangeRateLimitedError',
  })
  assert.equal(calls, 1, 'no retry past the deadline')
})

// ---- Review round 2 --------------------------------------------------------

test('gatedFetch: a 429 just before giveUpMs is not retried after the cooldown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const giveUpMs = 360_000
  const gate = new RequestGate({}, { random: () => 0.5 })
  let calls = 0
  const f = gatedFetch(
    async () => {
      calls++
      // Answers 1 ms before the deadline: the retry would wait a 2 s cooldown
      t.mock.timers.tick(giveUpMs - 1)
      return new Response(null, { status: 429 })
    },
    () => gate
  )
  const result = f(new Request('http://h.invalid/a')).then(
    () => 'resolved',
    (err) => err.name
  )
  await flush()
  assert.equal(calls, 1)
  t.mock.timers.tick(2000)
  await flush()
  assert.equal(await result, 'RangeRateLimitedError')
  assert.equal(calls, 1, 'no request sent past the deadline')
  // The released ticket was the probe: the next request can still go out
  const next = await gate.acquire()
  assert.equal(next.probe, true)
})

test('errorRetrySucceeded: the last failed key loading cancels the pending retry', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const st = modeUtils.createErrorRetryState()
  let retries = 0
  modeUtils.scheduleErrorRetry(st, 'a', () => retries++)
  modeUtils.scheduleErrorRetry(st, 'b', () => retries++)
  modeUtils.errorRetrySucceeded(st, 'a')
  assert.notEqual(st.timer, null, "'b' still failed: the retry stays")
  modeUtils.errorRetrySucceeded(st, 'b')
  assert.equal(st.timer, null)
  assert.equal(st.failures, 0)
  t.mock.timers.tick(60000)
  assert.equal(retries, 0, 'no invalidate once nothing failed is left')
  // UntiledMode no longer forces "chunks loading"
  const P = UntiledMode.prototype
  const state = {
    errorRetry: st,
    throttleState: modeUtils.createThrottleState(),
    loadingManager: { metadataLoading: false, chunksLoading: false },
  }
  P.emitLoadingState.call(state)
  assert.equal(state.loadingManager.chunksLoading, false)
})

// ---- Review round 3 --------------------------------------------------------

test('errorRetryViewChanged: cancels the old view retry; new-view failures start at the first backoff', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const st = modeUtils.createErrorRetryState()
  let old = 0
  let fresh = 0
  // Five cycles in: the next retry would be 16-30 s away
  for (let i = 0; i < 5; i++) {
    modeUtils.scheduleErrorRetry(st, 'r', () => old++)
    t.mock.timers.tick(40000)
  }
  modeUtils.scheduleErrorRetry(st, 'r', () => old++)
  const before = old
  modeUtils.errorRetryViewChanged(st)
  assert.equal(
    st.timer,
    null,
    'no timer left: the mode stops reporting loading'
  )
  modeUtils.scheduleErrorRetry(st, 'n', () => fresh++)
  t.mock.timers.tick(1250)
  assert.equal(fresh, 1, 'new view: retried within 1 s +- 25 %')
  t.mock.timers.tick(60000)
  assert.equal(old, before, 'the old view retry never ran')
})

test('UntiledMode / TiledMode: a view change with a retry pending refreshes the loading state', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const untiled = {
    errorRetry: modeUtils.createErrorRetryState(),
    throttleState: modeUtils.createThrottleState(),
    loadingManager: { metadataLoading: false, chunksLoading: false },
    requestCanceller: { controllers: new Map() },
    isRemoved: false,
    invalidate: () => {},
    emitLoadingState: UntiledMode.prototype.emitLoadingState,
  }
  UntiledMode.prototype.scheduleRetryAfterError.call(untiled, '0:0,0')
  assert.equal(untiled.loadingManager.chunksLoading, true)
  UntiledMode.prototype.errorRetryViewChanged.call(untiled)
  assert.equal(untiled.loadingManager.chunksLoading, false, 'untiled')

  const tiled = {
    errorRetry: modeUtils.createErrorRetryState(),
    throttleState: modeUtils.createThrottleState(),
    loadingManager: { metadataLoading: false, chunksLoading: false },
    pendingChunks: new Set(),
    tileCache: {},
    visibleTiles: [[2, 1, 1]],
    invalidate: () => {},
    emitLoadingState: TiledMode.prototype.emitLoadingState,
  }
  TiledMode.prototype.scheduleRetryAfterError.call(tiled, '2,1,1')
  assert.equal(tiled.loadingManager.chunksLoading, true)
  TiledMode.prototype.errorRetryViewChanged.call(tiled)
  assert.equal(tiled.loadingManager.chunksLoading, false, 'tiled')
})

test('TiledMode: a failed request for a tile no longer visible does not join the retry state', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let invalidations = 0
  const tiled = {
    errorRetry: modeUtils.createErrorRetryState(),
    throttleState: modeUtils.createThrottleState(),
    loadingManager: { metadataLoading: false, chunksLoading: false },
    pendingChunks: new Set(),
    tileCache: {},
    visibleTiles: [[3, 4, 2]],
    invalidate: () => invalidations++,
    emitLoadingState: TiledMode.prototype.emitLoadingState,
  }
  TiledMode.prototype.scheduleRetryAfterError.call(tiled, '2,1,1') // off-screen now
  assert.equal(tiled.errorRetry.failedKeys.size, 0)
  assert.equal(tiled.errorRetry.timer, null)
  assert.equal(tiled.loadingManager.chunksLoading, false)
  TiledMode.prototype.scheduleRetryAfterError.call(tiled, '3,4,2') // visible
  assert.deepEqual([...tiled.errorRetry.failedKeys], ['3,4,2'])
  t.mock.timers.tick(1250)
  assert.equal(invalidations, 1)
})

test('RequestGate: a new cap starts with a full bucket of `burst`; reconfiguring a capped gate keeps its tokens', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const take = async (gate, n) => {
    let got = 0
    for (let i = 0; i < n; i++) gate.acquire().then(() => got++)
    await flush()
    return got
  }
  assert.equal(
    await take(new RequestGate({ maxRequestsPerSecond: 1, burst: 20 }), 25),
    20,
    'fresh gate'
  )
  const g = new RequestGate()
  g.configure({ maxRequestsPerSecond: 1, burst: 20 })
  assert.equal(await take(g, 25), 20, 'uncapped -> capped')
  const h = new RequestGate({ maxRequestsPerSecond: 1, burst: 20 })
  assert.equal(await take(h, 15), 15)
  h.configure({ maxRequestsPerSecond: 2, burst: 20 })
  assert.equal(
    await take(h, 10),
    5,
    'already capped: the 5 tokens left, not a refill'
  )
})

// ---- Review round 4 --------------------------------------------------------

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

test('queue: a small playback window (cap 10) batches each shard it appends, though inside the near positions', async () => {
  const h = batchQueue({ maxConcurrentSteps: 4, near: 8 })
  // The webapp's windows for cap 10, batch 4, playhead 0..5 (cut back to a shard boundary)
  const windows = [
    range(1, 7),
    range(2, 11),
    range(3, 11),
    range(4, 11),
    range(5, 11),
    range(6, 15),
  ]
  for (const w of windows) {
    h.queue.set(w)
    await tick()
    for (const [idx, done] of [...h.open]) {
      h.open.delete(idx)
      done()
    }
    await tick()
  }
  const batchOf = (idx) => h.started.find((s) => s.idx === idx)?.batch
  assert.deepEqual(
    range(8, 11).map(batchOf),
    [2, 2, 2, 2],
    'shard 8-11 (window positions 6-9)'
  )
  assert.deepEqual(
    range(12, 15).map(batchOf),
    [3, 3, 3, 3],
    'shard 12-15 (positions 6-9)'
  )
})

test('queue: a jump (no overlap) or a cleared queue keeps the near rule', async () => {
  const h = batchQueue({ maxConcurrentSteps: 8, near: 8 })
  h.queue.set(range(1, 7))
  h.queue.set(range(40, 47)) // jump: nothing kept
  assert.ok(
    h.started.filter((s) => s.idx >= 40).every((s) => s.batch === undefined),
    'all near: alone'
  )
  const g = batchQueue({ maxConcurrentSteps: 8, near: 8 })
  g.queue.set(range(1, 7))
  await tick()
  for (const done of g.open.values()) done()
  await tick()
  g.queue.clear()
  g.queue.set(range(2, 11))
  const late = g.started.filter((s) => s.idx >= 8 && s.idx <= 9)
  assert.ok(
    late.length === 2 && late.every((s) => s.batch === undefined),
    'positions 6-7 after a clear: near'
  )
})

test('RequestGate: reconfiguring a capped gate credits the refill while it sat idle', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const gate = new RequestGate({ maxRequestsPerSecond: 5, burst: 10 })
  const take = async (n) => {
    let got = 0
    for (let i = 0; i < n; i++) gate.acquire().then(() => got++)
    await flush()
    return got
  }
  assert.equal(await take(10), 10, 'page load drains the bucket')
  t.mock.timers.tick(60_000) // a minute idle: nothing queued, no pump
  // A new layer (variable switch) configures the same origin again
  gate.configure({ maxRequestsPerSecond: 5, burst: 10 })
  assert.equal(await take(10), 10, 'the full burst goes out at once')
})
