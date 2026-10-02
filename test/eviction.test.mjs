// Window-aware eviction (task 45): CachingStore eviction tiers, ZarrLayer's
// protection of the prefetch window and the displayed step, and the window
// refill. Loaded from src via esbuild. Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc } from './load-src.mjs'

const { CachingStore } = await loadSrc('src/caching-store.ts')
const { ZarrLayer } = await loadSrc('src/zarr-layer.ts')
const { PrefetchQueue } = await loadSrc('src/prefetch-queue.ts')
const {
  WINDOW_REFILL_DELAY_MS,
  MAX_WINDOW_REFILLS,
  EVICTION_TIER_OTHER,
  EVICTION_TIER_WINDOW,
  EVICTION_TIER_DISPLAYED,
} = await loadSrc('src/constants.ts')

const tick = () => new Promise((r) => setTimeout(r, 0))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- CachingStore tiers ----

const sizedBase = (n = 100) => ({
  async get() {
    return new Uint8Array(n)
  },
})

async function fill(store, keys) {
  for (const k of keys) await store.get(k)
}

test('without a policy eviction is plain LRU', async () => {
  const store = new CachingStore(sizedBase(), 300)
  await fill(store, ['/a', '/b', '/c'])
  await store.get('/a') // touch: /b is now the oldest
  await store.get('/d')
  assert.deepEqual(
    ['/a', '/b', '/c', '/d'].map((k) => store.has(k)),
    [true, false, true, true]
  )
})

test('the lowest tier is evicted first, LRU within it', async () => {
  const store = new CachingStore(sizedBase(), 400)
  const tiers = { '/w1': 1, '/w2': 1, '/o1': 0, '/o2': 0 }
  const evicted = []
  store.setEvictionPolicy({
    priority: (k) => tiers[k] ?? 0,
    onEvict: (k, tier) => evicted.push([k, tier]),
  })
  // Window keys are the least recently used, as ahead-of-playhead steps are
  await fill(store, ['/w1', '/w2', '/o1', '/o2'])
  await store.get('/n1')
  assert.deepEqual(evicted, [['/o1', 0]])
  await store.get('/n2')
  assert.deepEqual(evicted, [
    ['/o1', 0],
    ['/o2', 0],
  ])
  assert.equal(store.has('/w1'), true)
  assert.equal(store.has('/w2'), true)
})

test('when the lower tiers are empty eviction falls back to LRU in the next tier', async () => {
  const store = new CachingStore(sizedBase(), 300)
  const tiers = { '/w1': 1, '/w2': 1, '/d': 2 }
  const evicted = []
  store.setEvictionPolicy({
    priority: (k) => tiers[k] ?? 0,
    onEvict: (k, tier) => evicted.push([k, tier]),
  })
  await fill(store, ['/d', '/w1', '/w2'])
  tiers['/w3'] = 1
  await store.get('/w3') // no tier-0 entry: the oldest window key goes
  assert.deepEqual(evicted, [['/w1', 1]])
  assert.equal(store.has('/d'), true)
  // Only the top tier left over budget: LRU inside it
  tiers['/w2'] = 2
  tiers['/w3'] = 2
  await store.get('/x')
  assert.deepEqual(evicted.at(-1), ['/d', 2])
  assert.equal(store.getTotalBytes(), 300)
})

test('a shrinking budget evicts by tier; clearing the policy restores LRU', async () => {
  const store = new CachingStore(sizedBase(), 400)
  const tiers = { '/a': 1, '/b': 1 }
  store.setEvictionPolicy({ priority: (k) => tiers[k] ?? 0 })
  await fill(store, ['/a', '/b', '/c', '/d'])
  store.setMaxBytes(200)
  assert.deepEqual(
    ['/a', '/b', '/c', '/d'].map((k) => store.has(k)),
    [true, true, false, false]
  )
  store.setEvictionPolicy(null)
  store.setMaxBytes(100)
  assert.deepEqual(
    ['/a', '/b'].map((k) => store.has(k)),
    [false, true]
  )
})

test('a non-finite priority counts as tier 0', async () => {
  const store = new CachingStore(sizedBase(), 200)
  store.setEvictionPolicy({ priority: (k) => (k === '/a' ? NaN : 1) })
  await fill(store, ['/b', '/a'])
  await store.get('/c')
  assert.equal(store.has('/a'), false)
  assert.equal(store.has('/b'), true)
})

// ---- ZarrLayer ----

// A layer over a real CachingStore with the layer's eviction policy. Each
// step t has `chunks` keys /v/c/<t>/<i> of 1000 bytes. The fake mode's
// prefetch reads them with the step's signal and resolves right away.
function evictionLayer({
  maxBytes,
  chunks = 2,
  failing = new Map(),
  prefetchConcurrency,
} = {}) {
  const layer = new ZarrLayer({
    id: 'test',
    source: 'http://example.invalid/store.zarr',
    variable: 'v',
    clim: [0, 1],
    colormap: ['#000000', '#ffffff'],
    selector: { time: { selected: 0, type: 'index' } },
    prefetchConcurrency,
  })
  // Keys of step t for ensemble member m (a non-time selector dim); no
  // member keeps the plain /v/c/<t>/<i> keys
  const keysFor = (t, m) =>
    Array.from({ length: chunks }, (_, i) =>
      m === undefined ? `/v/c/${t}/${i}` : `/v/c/${t}/${m}/${i}`
    )
  const member = () => layer.selector?.member?.selected
  const baseGets = []
  const base = {
    async get(key) {
      baseGets.push(key)
      // failing: key -> number of times left to fail
      const left = failing.get(key) ?? 0
      if (left > 0) {
        failing.set(key, left - 1)
        throw new Error(`fetch failed: ${key}`)
      }
      return new Uint8Array(1000)
    },
  }
  // The queue's own retry of failed steps (task 44), at test speed
  Object.assign(layer.prefetchQueue, {
    failureRetryDelayMs: 5,
    maxFailureRetryDelayMs: 10,
    random: () => 0.5,
  })
  const store = new CachingStore(base, maxBytes)
  store.addAccessListener((key, opts) => layer.attributeChunkAccess(key, opts))
  layer.zarrStore = { cachingStore: store }
  layer.installEvictionPolicy(store)
  const stepFetches = []
  layer.mode = {
    setSelector: async () => {},
    dispose() {},
    async prefetchTimeSteps(indices, dim, signal, options) {
      stepFetches.push(indices[0])
      for (const key of keysFor(indices[0], member())) {
        try {
          await store.get(key, { signal })
        } catch {
          options.onFetchError?.()
        }
      }
      return true
    },
  }
  const prefetch = async (indices) => {
    layer.prefetchTimeSteps(indices)
    await layer.prefetchQueue.whenIdle()
    await tick()
  }
  const display = (t) =>
    layer.setSelector({ time: { selected: t, type: 'index' } })
  const render = async (t) => {
    for (const key of keysFor(t)) await store.get(key)
    layer.handleViewComplete()
  }
  const status = (indices) => {
    const s = layer.getCacheStatus(indices)
    return indices.map((i) => s[i])
  }
  return {
    layer,
    store,
    keysFor,
    baseGets,
    stepFetches,
    prefetch,
    display,
    render,
    status,
  }
}

test('playback: steps behind the playhead are evicted before the window ahead', async () => {
  // Room for 4 steps. Displayed step 0, window 0-3 prefetched.
  const { prefetch, display, render, status, baseGets } = evictionLayer({
    maxBytes: 8000,
  })
  await prefetch([0, 1, 2, 3])
  assert.deepEqual(status([0, 1, 2, 3]), [
    'cached',
    'cached',
    'cached',
    'cached',
  ])
  // Play: each step is rendered (most recently used), the window moves on
  for (let t = 1; t <= 4; t++) {
    await display(t)
    await render(t)
    await prefetch([t, t + 1, t + 2, t + 3])
  }
  // Window 4-7 fully cached; with LRU, the steps just played would have
  // stayed and the prefetched ones ahead would have been evicted
  assert.deepEqual(status([4, 5, 6, 7]), [
    'cached',
    'cached',
    'cached',
    'cached',
  ])
  assert.deepEqual(status([0, 1, 2, 3]), [
    'missing',
    'missing',
    'missing',
    'missing',
  ])
  // Nothing downloaded twice
  assert.equal(new Set(baseGets).size, baseGets.length)
})

test('A -> B -> A: the old window is evicted first and window A ends up whole', async () => {
  // Room for 5 steps; windows of 4
  const { prefetch, display, render, status } = evictionLayer({
    maxBytes: 10_000,
  })
  const A = [10, 11, 12, 13]
  const B = [50, 51, 52, 53]
  await prefetch(A)
  await display(50)
  await render(50)
  await prefetch(B)
  await display(10)
  await prefetch(A)
  assert.deepEqual(status(A), ['cached', 'cached', 'cached', 'cached'])
  // B's steps (outside the window, used more recently) went first
  assert.ok(status(B).filter((s) => s === 'cached').length <= 1)
})

test('the displayed step is kept even when it is outside the window', async () => {
  // Room for 3 steps: displayed step 0 plus a window of 3 doesn't fit
  const { prefetch, render, status } = evictionLayer({
    maxBytes: 6000,
    prefetchConcurrency: 1,
  })
  await render(0)
  await prefetch([1, 2, 3])
  // Over budget: the window evicts inside itself, farthest step first. The
  // last step (3) is the farthest, so storing its second chunk evicts its
  // first; step 1, nearest the front, stays whole.
  assert.deepEqual(status([0, 1, 2, 3]), [
    'cached',
    'cached',
    'partial',
    'partial',
  ])
})

test('the displayed step alone over budget: the newest entry is still kept', async () => {
  const { render, store } = evictionLayer({ maxBytes: 1000, chunks: 3 })
  await render(0)
  assert.equal(store.size, 1)
  assert.equal(store.has('/v/c/0/2'), true)
})

test('a failed step is left to the queue retry, not refilled', async () => {
  // The queue retries a failed step itself (task 44: up to 5 times, with
  // backoff); the refill must not add its own retries on top
  const failing = new Map([['/v/c/2/1', Infinity]])
  const { prefetch, status, stepFetches } = evictionLayer({
    maxBytes: 100_000,
    failing,
  })
  await prefetch([1, 2, 3])
  const attempts = stepFetches.filter((t) => t === 2).length
  assert.equal(attempts, 1 + 5)
  assert.deepEqual(status([1, 2, 3]), ['cached', 'partial', 'cached'])
  await sleep(2 * (WINDOW_REFILL_DELAY_MS + 100))
  await tick()
  assert.equal(stepFetches.filter((t) => t === 2).length, attempts)
})

test('a step that failed once and then succeeded in the queue retry is not refetched', async () => {
  const failing = new Map([['/v/c/2/1', 1]])
  const { prefetch, status, stepFetches } = evictionLayer({
    maxBytes: 100_000,
    failing,
  })
  await prefetch([1, 2, 3])
  assert.deepEqual(status([1, 2, 3]), ['cached', 'cached', 'cached'])
  await sleep(WINDOW_REFILL_DELAY_MS + 100)
  await tick()
  assert.deepEqual(stepFetches, [1, 2, 3, 2])
})

test('refill: an in-window entry evicted while the queue is idle is refetched', async () => {
  const { store, prefetch, status, stepFetches } = evictionLayer({
    maxBytes: 8000,
  })
  await prefetch([0, 1, 2])
  await sleep(WINDOW_REFILL_DELAY_MS + 100)
  assert.deepEqual(stepFetches, [0, 1, 2])
  // A budget dip evicts window keys while idle; the budget comes back
  store.setMaxBytes(3000)
  store.setMaxBytes(8000)
  assert.notDeepEqual(status([0, 1, 2]), ['cached', 'cached', 'cached'])
  await sleep(WINDOW_REFILL_DELAY_MS + 100)
  await tick()
  assert.deepEqual(status([0, 1, 2]), ['cached', 'cached', 'cached'])
})

test('no refill when the window does not fit the budget', async () => {
  // Room for 2 steps, window of 3: holes are expected and not refilled
  const { prefetch, status, stepFetches, layer } = evictionLayer({
    maxBytes: 4000,
  })
  await prefetch([0, 1, 2])
  assert.notDeepEqual(status([0, 1, 2]), ['cached', 'cached', 'cached'])
  await sleep(3 * (WINDOW_REFILL_DELAY_MS + 100))
  assert.deepEqual(stepFetches, [0, 1, 2])
  assert.equal(layer.prefetchQueue.busy, false)
})

test('refills of one window are capped', async () => {
  // Holes made again after every refill (budget dips while idle): refilled
  // MAX_WINDOW_REFILLS times, then left to the caller's next window
  const { layer, store, prefetch, status } = evictionLayer({
    maxBytes: 8000,
  })
  await prefetch([1, 2, 3])
  for (let i = 0; i < MAX_WINDOW_REFILLS + 1; i++) {
    store.setMaxBytes(2000)
    store.setMaxBytes(8000)
    await sleep(WINDOW_REFILL_DELAY_MS + 100)
    await layer.prefetchQueue.whenIdle()
    await tick()
  }
  assert.equal(layer.windowRefills, MAX_WINDOW_REFILLS)
  assert.notDeepEqual(status([1, 2, 3]), ['cached', 'cached', 'cached'])
})

test('a new window resets the refill count; removing the layer cancels a pending refill', async () => {
  const { layer, store, prefetch, stepFetches } = evictionLayer({
    maxBytes: 8000,
  })
  await prefetch([1, 2, 3])
  // A hole while idle schedules a refill check; a reset cancels it
  store.setMaxBytes(2000)
  store.setMaxBytes(8000)
  layer.resetPrefetchWindow() // as on removal / setVariable
  await sleep(2 * (WINDOW_REFILL_DELAY_MS + 100))
  assert.deepEqual(stepFetches, [1, 2, 3])
  // A new window starts with a fresh refill count
  layer.windowRefills = MAX_WINDOW_REFILLS
  await prefetch([1, 2, 3])
  assert.equal(layer.windowRefills, 0)
})

test('no refill for a step that read nothing (every chunk absent)', async () => {
  const { layer, store, prefetch, stepFetches } = evictionLayer({
    maxBytes: 100_000,
  })
  // Step 2's chunks don't exist: the base store returns undefined
  const get = store.baseStore.get.bind(store.baseStore)
  store.baseStore.get = async (key, opts) =>
    key.startsWith('/v/c/2/') ? undefined : get(key, opts)
  await prefetch([1, 2, 3])
  assert.equal(layer.getCacheStatus([2])[2], 'missing')
  await sleep(2 * (WINDOW_REFILL_DELAY_MS + 100))
  assert.deepEqual(stepFetches, [1, 2, 3])
})

test('a non-time selector change forgets the window: no refill or protection for the new selection', async () => {
  const sel = (m) => ({
    time: { selected: 0, type: 'index' },
    member: { selected: m, type: 'index' },
  })
  // Member 1's steps 1-3 recorded first; then window 1-3 for member 0
  const { layer, store, prefetch, keysFor, stepFetches } = evictionLayer({
    maxBytes: 100_000,
  })
  await layer.setSelector(sel(1))
  await prefetch([1, 2, 3])
  await sleep(WINDOW_REFILL_DELAY_MS + 100)
  await layer.setSelector(sel(0))
  await prefetch([1, 2, 3])
  const p = layer.evictionPriority(keysFor(1, 0)[0])
  assert.ok(p >= EVICTION_TIER_WINDOW && p < EVICTION_TIER_DISPLAYED)
  // Holes in member 0's window while idle: a refill check is pending
  store.setMaxBytes(2000)
  store.setMaxBytes(100_000)
  // Back to member 1 before the refill check runs
  await layer.setSelector(sel(1))
  assert.equal(layer.prefetchWindow, null)
  // Member 1's keys for the old window's indices are not protected
  for (const t of [1, 2, 3]) {
    assert.equal(layer.evictionPriority(keysFor(t, 1)[0]), EVICTION_TIER_OTHER)
  }
  const fetchesBefore = stepFetches.length
  await sleep(WINDOW_REFILL_DELAY_MS + 100)
  await tick()
  // No refill of the old window (member 0's holes, or member 1)
  assert.equal(stepFetches.length, fetchesBefore)
})

test("a new window drops the previous window's pending refill timer", async () => {
  const { store, prefetch, stepFetches } = evictionLayer({
    maxBytes: 100_000,
  })
  // Window 1 going idle arms a refill check; window 2 replaces it before
  // that fires
  await prefetch([1, 2, 3])
  await sleep(WINDOW_REFILL_DELAY_MS - 150)
  await prefetch([5, 6])
  // Holes in window 2 right after it went idle
  store.setMaxBytes(3000)
  store.setMaxBytes(100_000)
  assert.deepEqual(stepFetches, [1, 2, 3, 5, 6])
  // Window 2's refill waits its own full delay, not window 1's remainder
  await sleep(300)
  assert.deepEqual(stepFetches, [1, 2, 3, 5, 6])
  await sleep(WINDOW_REFILL_DELAY_MS)
  await tick()
  assert.ok(stepFetches.length > 5)
})

test('a refill fetches only the holes, not steps that read nothing', async () => {
  // Step 2's chunks don't exist; step 3 is evicted while idle (a hole)
  const { layer, store, prefetch, status, stepFetches } = evictionLayer({
    maxBytes: 100_000,
  })
  const get = store.baseStore.get.bind(store.baseStore)
  store.baseStore.get = async (key, opts) =>
    key.startsWith('/v/c/2/') ? undefined : get(key, opts)
  await prefetch([1, 2, 3])
  store.setMaxBytes(2000) // the farthest step (3) goes first
  store.setMaxBytes(100_000)
  assert.deepEqual(status([1, 2, 3]), ['cached', 'missing', 'missing'])
  await sleep(WINDOW_REFILL_DELAY_MS + 100)
  await layer.prefetchQueue.whenIdle()
  await tick()
  assert.deepEqual(stepFetches, [1, 2, 3, 3])
  assert.equal(layer.getCacheStatus([3])[3], 'cached')
})

test('over budget, a window evicts its farthest steps first, not the nearest', async () => {
  // Room for 3 steps, window of 5 (an estimate that was low); fetched in
  // window order, one step at a time. No step is displayed.
  const { layer, prefetch, status } = evictionLayer({
    maxBytes: 6000,
    prefetchConcurrency: 1,
  })
  await layer.setSelector({})
  await prefetch([10, 11, 12, 13, 14])
  const s = status([10, 11, 12, 13, 14])
  // The steps nearest the front of the window stay whole
  assert.deepEqual(s.slice(0, 2), ['cached', 'cached'])
  assert.ok(s.slice(2).every((x) => x !== 'cached'))
})

test('requeue keeps the window positions: refilled far steps still batch', () => {
  const started = []
  const cached = new Set()
  const queue = new PrefetchQueue({
    fetchStep: async (idx, _dim, _signal, info) => {
      started.push({ idx, batch: info.batch })
      cached.add(idx)
      return true
    },
    isCached: (i) => cached.has(i),
    maxConcurrentSteps: 1,
    batchSize: () => 4,
    batchNearSteps: 8,
  })
  queue.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  return queue.whenIdle().then(() => {
    // 9 and 10 (window positions 9, 10, batch 2) are evicted
    cached.delete(9)
    cached.delete(10)
    started.length = 0
    queue.requeue([10, 9, 42])
    // In window order, batched together (set([9, 10]) would put both in
    // the near positions and start each alone); 42 isn't in the window
    assert.deepEqual(started, [
      { idx: 9, batch: 2 },
      { idx: 10, batch: 2 },
    ])
    return queue.whenIdle()
  })
})

test('requeue keeps the appended flags: an appended hole at position 0-1 starts alone, later ones batch', async () => {
  const started = []
  const cached = new Set()
  const queue = new PrefetchQueue({
    fetchStep: async (idx, _dim, _signal, info) => {
      started.push({ idx, batch: info.batch })
      cached.add(idx)
      return true
    },
    isCached: (i) => cached.has(i),
    maxConcurrentSteps: 1,
    batchSize: () => 4,
    batchNearSteps: 8,
  })
  queue.set([0, 1])
  await queue.whenIdle()
  // Playback extends the window: 1 kept (position 0), 2-5 appended
  // (positions 1-4)
  queue.set([1, 2, 3, 4, 5])
  await queue.whenIdle()
  // Holes: 2 (appended, position 1), 4 and 5 (appended, positions 3-4,
  // batch 1)
  for (const i of [2, 4, 5]) cached.delete(i)
  started.length = 0
  queue.requeue([2, 4, 5])
  await queue.whenIdle()
  assert.deepEqual(started, [
    { idx: 2, batch: undefined },
    { idx: 4, batch: 1 },
    { idx: 5, batch: 1 },
  ])
})
