// ZarrLayer / UntiledMode prefetch primitives, loaded from src via esbuild.
// Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc } from './load-src.mjs'

const { ZarrLayer } = await loadSrc('src/zarr-layer.ts')
const { UntiledMode } = await loadSrc('src/untiled-mode.ts')

const tick = () => new Promise((r) => setTimeout(r, 0))

// A layer with a fake mode and chunk cache. The mode's per-step fetch
// records the member it was fetched for and stays in flight until released
// (or aborted). On release it "reads" the step's chunks through the layer's
// access attribution, like CachingStore's listener does: `chunksFor(member,
// idx)` names them (default one chunk per member and step).
function fakeLayer({
  chunksFor = (m, t) => [`m${m}/t${t}`],
  onLoadingStateChange,
  layerOptions = {},
} = {}) {
  const layer = new ZarrLayer({
    ...layerOptions,
    onLoadingStateChange,
    id: 'test',
    source: 'http://example.invalid/store.zarr',
    variable: 'v',
    clim: [0, 1],
    colormap: ['#000000', '#ffffff'],
    selector: { time: 0, member: 0 },
  })
  const resident = new Set()
  const fetches = []
  layer.zarrStore = {
    cachingStore: {
      has: (k) => resident.has(k),
      maxBytes: 1000,
      getTotalBytes: () => resident.size * 10,
      get size() {
        return resident.size
      },
    },
  }
  layer.mode = {
    setSelector: async () => {},
    dispose() {},
    prefetchTimeSteps(indices, dim, signal, options) {
      const idx = indices[0]
      const member = layer.normalizedSelector.member.selected
      return new Promise((resolve) => {
        const entry = { idx, member, signal, options, aborted: false }
        // Like zarrita: every store access of this request carries its signal
        entry.release = () => {
          for (const key of chunksFor(member, idx)) {
            resident.add(key)
            layer.attributeChunkAccess(key, { signal })
          }
          resolve(true)
        }
        signal.addEventListener('abort', () => {
          entry.aborted = true
          resolve(true)
        })
        fetches.push(entry)
      })
    },
  }
  // Fetch one step for the current member and wait for it to land
  const fetchStep = async (idx) => {
    layer.prefetchTimeSteps([idx])
    await tick()
    fetches.at(-1).release()
    await tick()
  }
  return { layer, fetches, resident, fetchStep }
}

test('cache status is per member: B is prefetched, switching back to A needs no fetch', async () => {
  const { layer, fetches, fetchStep } = fakeLayer()
  await fetchStep(2) // member 0 (A)
  assert.equal(layer.isTimeStepCached(2), true)

  await layer.setSelector({ time: 0, member: 1 })
  assert.equal(
    layer.isTimeStepCached(2),
    false,
    "A's chunks must not count for B"
  )
  assert.deepEqual(layer.getCacheStatus([2]), { 2: 'missing' })

  await fetchStep(2)
  assert.deepEqual([fetches[1].idx, fetches[1].member], [2, 1])
  assert.equal(layer.isTimeStepCached(2), true)

  await layer.setSelector({ time: 0, member: 0 })
  assert.equal(layer.isTimeStepCached(2), true, "A's chunks are still resident")
  layer.prefetchTimeSteps([2])
  await tick()
  assert.equal(fetches.length, 2, 'no refetch for A')
})

test('chunks shared by members are recorded per member; eviction downgrades both', async () => {
  const { layer, fetches, resident, fetchStep } = fakeLayer({
    chunksFor: (m, t) => [`shared/t${t}`],
  })
  await fetchStep(3) // member 0
  await layer.setSelector({ time: 0, member: 1 })
  // Nothing recorded for member 1 yet, although the chunk is resident
  assert.equal(layer.isTimeStepCached(3), false)
  await fetchStep(3) // a cache hit in reality; records member 1's keys
  assert.equal(fetches.length, 2)
  assert.equal(layer.isTimeStepCached(3), true)

  resident.delete('shared/t3')
  assert.equal(layer.isTimeStepCached(3), false)
  await layer.setSelector({ time: 0, member: 0 })
  assert.equal(layer.isTimeStepCached(3), false)
})

// Task 30: steps run concurrently (default 4), so these use more steps than
// slots to still cover the queued (not yet started) part of the window.
test('time-only selector change keeps state and the queue', async () => {
  const { layer, fetches, fetchStep } = fakeLayer()
  await fetchStep(2)
  layer.prefetchTimeSteps([4, 5, 6, 7, 8])
  await tick()
  await layer.setSelector({ time: 5, member: 0 })
  assert.equal(layer.isTimeStepCached(2), true)
  assert.deepEqual(
    fetches.slice(1).map((f) => [f.idx, f.aborted]),
    [
      [4, false],
      [5, false],
      [6, false],
      [7, false],
    ]
  )
  assert.deepEqual(layer.prefetchQueue.pendingIndices, [8])
})

test('member change aborts every in-flight step and drops the queue', async () => {
  const { layer, fetches } = fakeLayer()
  layer.prefetchTimeSteps([3, 4, 5, 6, 7])
  await tick()
  assert.equal(fetches.length, 4)
  assert.ok(fetches.every((f) => f.member === 0))

  await layer.setSelector({ time: 0, member: 1 })
  await tick()
  assert.ok(fetches.every((f) => f.aborted))
  assert.equal(fetches.length, 4, 'step 7 (old member) must not start')
})

test('getCacheDebugInfo: byte fields from the cache, step fields for the current member', async () => {
  const { layer, fetchStep } = fakeLayer()
  await fetchStep(1)
  await fetchStep(2)
  await layer.setSelector({ time: 0, member: 1 })
  await fetchStep(1)
  const info = layer.getCacheDebugInfo()
  assert.equal(info.maxBytes, 1000)
  assert.equal(info.usedBytes, 30)
  assert.equal(info.chunksInCache, 3)
  assert.equal(info.timestepsRecorded, 1)
  assert.deepEqual(info.perTimestepHits, [
    { timeIndex: 1, recorded: 1, hits: 1 },
  ])
  assert.equal(info.avgChunksPerTimestep, 1)
})

test('a render access during an in-flight prefetch is recorded under the displayed step', async () => {
  const { layer, fetches, resident } = fakeLayer()
  // Displayed step: time index 0 (index selectors drive render attribution)
  await layer.setSelector({ time: { selected: 0, type: 'index' }, member: 0 })
  layer.prefetchTimeSteps([7])
  await tick()
  assert.equal(fetches.length, 1)
  // The map renders the displayed step (time 0) with its own request signal
  resident.add('m0/t0')
  layer.attributeChunkAccess('m0/t0', { signal: new AbortController().signal })
  // ...and an access without options (e.g. a metadata read)
  layer.attributeChunkAccess('m0/t0')
  fetches[0].release()
  await tick()
  assert.equal(layer.isTimeStepCached(0), true, 'displayed step recorded')
  const recorded = layer.getCacheDebugInfo().perTimestepHits
  assert.deepEqual(recorded, [
    { timeIndex: 0, recorded: 1, hits: 1 },
    { timeIndex: 7, recorded: 1, hits: 1 },
  ])
  // Evicting the displayed step's chunk must not downgrade step 7
  resident.delete('m0/t0')
  assert.equal(layer.isTimeStepCached(7), true)
})

test('prefetch waits while metadata loads (setVariable) and then fetches', async () => {
  const { layer, fetches } = fakeLayer()
  layer.metadataLoading = true // setVariable in progress; old mode still set
  layer.prefetchTimeSteps([2])
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(fetches.length, 0, 'must not fetch through the old mode')
  layer.metadataLoading = false
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(fetches.length, 1)
  assert.equal(fetches[0].idx, 2)
  fetches[0].release()
})

test('onLoadingStateChange reports prefetch activity as `prefetching`, separate from loading/chunks', async () => {
  const states = []
  const { layer, fetches } = fakeLayer({
    onLoadingStateChange: (s) => states.push({ ...s }),
  })
  layer.prefetchTimeSteps([1, 2])
  await tick()
  assert.deepEqual(states.at(-1), {
    loading: false,
    metadata: false,
    chunks: false,
    prefetching: true,
    error: null,
  })
  fetches[0].release()
  await tick()
  fetches[1].release()
  await tick()
  assert.deepEqual(states.at(-1), {
    loading: false,
    metadata: false,
    chunks: false,
    prefetching: false,
    error: null,
  })
  assert.deepEqual(
    states.map((s) => s.prefetching),
    [true, false],
    'one emission per busy change'
  )

  // Render-driven chunk loading during a prefetch: chunks drives loading,
  // prefetching does not
  layer.prefetchTimeSteps([3])
  await tick()
  layer.handleChunkLoadingChange({ loading: true, chunks: true })
  assert.deepEqual(
    [states.at(-1).loading, states.at(-1).chunks, states.at(-1).prefetching],
    [true, true, true]
  )
  layer.handleChunkLoadingChange({ loading: false, chunks: false })
  assert.deepEqual(
    [states.at(-1).loading, states.at(-1).chunks, states.at(-1).prefetching],
    [false, false, true]
  )
  layer.prefetchQueue.clear()
  await layer.prefetchQueue.whenIdle()
  assert.equal(states.at(-1).prefetching, false)
})

// UntiledMode.prefetchTimeSteps readiness contract, on a minimal fake `this`
function modeState(overrides) {
  return {
    zarrArray: { shape: [1, 1, 1] },
    baseSliceArgsReady: true,
    lastVisibleRegions: [],
    lastVisibleRegionsLevel: 0,
    currentLevelIndex: 0,
    regionSize: [1, 1],
    height: 1,
    width: 1,
    dimIndices: {},
    selector: {},
    ...overrides,
  }
}

async function runPrimitive(state) {
  const started = []
  const result = await UntiledMode.prototype.prefetchTimeSteps.call(
    state,
    [1],
    'time',
    new AbortController().signal,
    (i) => started.push(i)
  )
  return { result, started }
}

test('UntiledMode primitive: not ready until a visible-region pass ran for the current level', async () => {
  for (const overrides of [
    { zarrArray: null },
    { baseSliceArgsReady: false },
    { lastVisibleRegionsLevel: -1, currentLevelIndex: -1 },
    { lastVisibleRegionsLevel: -1, currentLevelIndex: 0 },
    { lastVisibleRegionsLevel: 0, currentLevelIndex: 1 },
  ]) {
    const { result, started } = await runPrimitive(modeState(overrides))
    assert.equal(result, false, JSON.stringify(overrides))
    assert.deepEqual(started, [])
  }
})

test('UntiledMode primitive: a completed pass with nothing visible is a done no-op', async () => {
  const { result, started } = await runPrimitive(
    modeState({
      lastVisibleRegions: [],
      lastVisibleRegionsLevel: 2,
      currentLevelIndex: 2,
    })
  )
  assert.equal(result, true)
  assert.deepEqual(started, [])
})

// ---- Task 30: concurrent steps, shared request cap ----

test('prefetchConcurrency: at most that many steps in flight; default 4; invalid warns', async () => {
  const two = fakeLayer({ layerOptions: { prefetchConcurrency: 2 } })
  two.layer.prefetchTimeSteps([1, 2, 3, 4, 5])
  await tick()
  assert.deepEqual(
    two.fetches.map((f) => f.idx),
    [1, 2]
  )
  two.fetches[1].release()
  await tick()
  assert.deepEqual(
    two.fetches.map((f) => f.idx),
    [1, 2, 3]
  )
  two.layer.prefetchQueue.clear()

  const def = fakeLayer()
  def.layer.prefetchTimeSteps([1, 2, 3, 4, 5, 6])
  await tick()
  assert.equal(def.fetches.length, 4)
  def.layer.prefetchQueue.clear()

  const warnings = []
  const warn = console.warn
  console.warn = (msg) => warnings.push(String(msg))
  try {
    const bad = fakeLayer({
      layerOptions: { prefetchConcurrency: 0, prefetchMaxRequests: NaN },
    })
    assert.equal(bad.layer.prefetchQueue.maxConcurrentSteps, 4)
    assert.equal(bad.layer.prefetchLimiter.max, 12)
  } finally {
    console.warn = warn
  }
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /prefetchConcurrency/)
  assert.match(warnings[1], /prefetchMaxRequests/)
})

// A mode whose step fetch pushes `chunksPerStep` chunk tasks through the
// createQueue the layer passes (like zarr.get does), each held until released.
function capLayer({ maxRequests, chunksPerStep }) {
  const { layer } = fakeLayer({
    layerOptions: { prefetchMaxRequests: maxRequests },
  })
  const running = [] // { step, n, release }
  const live = { now: 0, peak: 0 }
  layer.mode.prefetchTimeSteps = async (indices, dim, signal, options) => {
    const step = indices[0]
    const queue = options.createQueue()
    for (let n = 0; n < chunksPerStep; n++) {
      queue.add(
        () =>
          new Promise((resolve, reject) => {
            live.now++
            live.peak = Math.max(live.peak, live.now)
            const entry = { step, n }
            entry.release = () => {
              live.now--
              running.splice(running.indexOf(entry), 1)
              resolve()
            }
            signal.addEventListener('abort', () => {
              if (!running.includes(entry)) return
              live.now--
              running.splice(running.indexOf(entry), 1)
              const err = new Error('aborted')
              err.name = 'AbortError'
              reject(err)
            })
            running.push(entry)
          })
      )
    }
    try {
      await queue.onIdle()
    } catch (e) {
      if (e.name !== 'AbortError') throw e
    }
    return true
  }
  return { layer, running, live }
}

test('the prefetch request cap holds across all in-flight steps; earlier steps get slots first', async () => {
  const { layer, running, live } = capLayer({
    maxRequests: 3,
    chunksPerStep: 4,
  })
  layer.prefetchTimeSteps([10, 11, 12, 13])
  await tick()
  assert.equal(layer.prefetchQueue.inFlightIndices.length, 4, '4 steps')
  assert.deepEqual(
    running.map((r) => r.step),
    [10, 10, 10],
    'only 3 chunk requests, all for the first step'
  )
  running[0].release()
  await tick()
  assert.deepEqual(
    running.map((r) => r.step),
    [10, 10, 10],
    "step 10's last chunk before any of step 11's"
  )
  const order = []
  while (running.length > 0) {
    assert.ok(live.now <= 3)
    order.push(running[0].step)
    running[0].release()
    await tick()
  }
  await layer.prefetchQueue.whenIdle()
  assert.equal(live.peak, 3)
  // Remaining chunks drained step by step, in priority order
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b)
  )
  assert.equal(layer.prefetchLimiter.active, 0)
})

test('aborting a step frees its queued and running request slots for the kept steps', async () => {
  const { layer, running } = capLayer({ maxRequests: 2, chunksPerStep: 3 })
  layer.prefetchTimeSteps([1, 2])
  await tick()
  assert.deepEqual(
    running.map((r) => r.step),
    [1, 1]
  )
  layer.prefetchTimeSteps([2]) // drops step 1
  await tick()
  assert.deepEqual(
    running.map((r) => r.step),
    [2, 2]
  )
  assert.equal(layer.prefetchLimiter.pending, 1, "step 2's third chunk waits")
  while (running.length > 0) {
    running[0].release()
    await tick()
  }
  await layer.prefetchQueue.whenIdle()
  assert.equal(layer.prefetchLimiter.pending, 0)
  assert.equal(layer.prefetchLimiter.active, 0)
})

test('attribution with interleaved accesses from several concurrent steps', async () => {
  const { layer, fetches, resident } = fakeLayer()
  await layer.setSelector({ time: { selected: 0, type: 'index' }, member: 0 })
  layer.prefetchTimeSteps([4, 5, 6, 7])
  await tick()
  assert.equal(fetches.length, 4)
  const byIdx = Object.fromEntries(fetches.map((f) => [f.idx, f]))
  const access = (key, signal) => {
    resident.add(key)
    layer.attributeChunkAccess(key, signal ? { signal } : undefined)
  }
  // Interleaved: steps' accesses mixed with each other and with a render
  access('k6a', byIdx[6].signal)
  access('k4a', byIdx[4].signal)
  access('render', new AbortController().signal)
  access('k7a', byIdx[7].signal)
  access('k6b', byIdx[6].signal)
  access('k5a', byIdx[5].signal)
  access('k4b', byIdx[4].signal)
  // Step 4 finishes first; the others keep attributing correctly
  byIdx[4].release()
  await tick()
  access('k5b', byIdx[5].signal)
  access('k7b', byIdx[7].signal)
  for (const idx of [5, 6, 7]) byIdx[idx].release()
  await tick()
  const hits = Object.fromEntries(
    layer
      .getCacheDebugInfo()
      .perTimestepHits.map((h) => [h.timeIndex, h.recorded])
  )
  // Each step: its own two keys plus the fake mode's release chunk (m0/tN)
  assert.deepEqual(hits, { 0: 1, 4: 3, 5: 3, 6: 3, 7: 3 })
  const keysOf = (t) =>
    [...layer.timestepKeys.get(`${t}|${layer.currentSelection()}`).keys].sort()
  assert.deepEqual(keysOf(0), ['render'])
  assert.deepEqual(keysOf(4), ['k4a', 'k4b', 'm0/t4'])
  assert.deepEqual(keysOf(5), ['k5a', 'k5b', 'm0/t5'])
  assert.deepEqual(keysOf(6), ['k6a', 'k6b', 'm0/t6'])
  assert.deepEqual(keysOf(7), ['k7a', 'k7b', 'm0/t7'])
})

// UntiledMode primitive against a real zarrita array whose chunk reads are
// slow, to observe how many chunk requests one step has open at once.
const zarr = await import('zarrita')
const { RequestLimiter } = await loadSrc('src/request-limiter.ts')

async function slowArray({ size = 40, chunk = 10 } = {}) {
  const files = new Map()
  const stats = { live: 0, peak: 0, chunkGets: 0 }
  const store = {
    async get(key) {
      if (key.endsWith('zarr.json')) return files.get(key)
      stats.chunkGets++
      stats.live++
      stats.peak = Math.max(stats.peak, stats.live)
      await new Promise((r) => setTimeout(r, 3))
      stats.live--
      return undefined // missing chunk: fill value
    },
    async set(key, value) {
      files.set(key, value)
    },
  }
  const arr = await zarr.create(zarr.root(store).resolve('v'), {
    shape: [4, size, size],
    chunkShape: [1, chunk, chunk],
    dtype: 'float32',
  })
  return { arr, stats }
}

function regionState(arr, { size, region }) {
  const n = size / region
  const regions = []
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) regions.push({ regionX: x, regionY: y })
  return modeState({
    zarrArray: arr,
    lastVisibleRegions: regions,
    regionSize: [region, region],
    height: size,
    width: size,
    dimIndices: { lat: { index: 1 }, lon: { index: 2 } },
    buildSliceArgsForSelector: async () => ({ sliceArgs: [1, null, null] }),
  })
}

test('UntiledMode primitive: a step fetches its regions concurrently, at most 8 at once', async () => {
  const { arr, stats } = await slowArray({ size: 40, chunk: 10 })
  const state = regionState(arr, { size: 40, region: 10 }) // 16 regions
  const result = await UntiledMode.prototype.prefetchTimeSteps.call(
    state,
    [1],
    'time',
    new AbortController().signal
  )
  assert.equal(result, true)
  assert.equal(stats.chunkGets, 16)
  assert.equal(stats.peak, 8)
})

test('UntiledMode primitive: createQueue caps chunk requests, also within multi-chunk regions', async () => {
  const { arr, stats } = await slowArray({ size: 40, chunk: 10 })
  const state = regionState(arr, { size: 40, region: 20 }) // 4 regions x 4 chunks
  const limiter = new RequestLimiter(3)
  await UntiledMode.prototype.prefetchTimeSteps.call(
    state,
    [1],
    'time',
    new AbortController().signal,
    { createQueue: () => limiter.chunkQueue() }
  )
  assert.equal(stats.chunkGets, 16)
  assert.equal(stats.peak, 3)
})

test('UntiledMode primitive: an abort mid-step starts no further regions', async () => {
  const { arr, stats } = await slowArray({ size: 40, chunk: 10 })
  const state = regionState(arr, { size: 40, region: 10 })
  const controller = new AbortController()
  const run = UntiledMode.prototype.prefetchTimeSteps.call(
    state,
    [1],
    'time',
    controller.signal
  )
  await new Promise((r) => setTimeout(r, 1))
  controller.abort()
  assert.equal(await run, true)
  assert.ok(stats.chunkGets <= 8, `${stats.chunkGets} chunk reads`)
})

test('a failed chunk does not end the step early: no access is attributed after its primitive settles', async () => {
  const { layer } = fakeLayer({ layerOptions: { prefetchMaxRequests: 1 } })
  await layer.setSelector({ time: { selected: 0, type: 'index' }, member: 0 })
  let primitiveSettled = false
  const lateAccesses = []
  layer.mode.prefetchTimeSteps = async (indices, dim, signal, options) => {
    // Like zarr.get over one region with two chunks, under a cap of 1:
    // the first chunk fails (e.g. a 5xx), the second waits for its slot.
    const queue = options.createQueue()
    queue.add(async () => {
      throw new Error('503')
    })
    queue.add(async () => {
      await new Promise((r) => setTimeout(r, 5)) // network time
      if (primitiveSettled) lateAccesses.push('k2')
      layer.attributeChunkAccess('k2', { signal })
    })
    try {
      await queue.onIdle()
    } catch {
      // the region's error is swallowed, as in UntiledMode
    }
    primitiveSettled = true
    return true
  }
  layer.prefetchTimeSteps([3])
  await layer.prefetchQueue.whenIdle()
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(lateAccesses, [])
  const sel = layer.currentSelection()
  assert.ok(layer.timestepKeys.get(`3|${sel}`)?.keys.has('k2'))
  assert.equal(layer.timestepKeys.get(`0|${sel}`), undefined)
})
