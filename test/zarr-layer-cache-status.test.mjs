// ZarrLayer cache status: a step reads 'cached' only after a fetch of it
// completed (task: aborted prefetch steps read as cached). Real CachingStore
// over a fake base store, loaded from src via esbuild. Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc } from './load-src.mjs'

const { ZarrLayer } = await loadSrc('src/zarr-layer.ts')
const { CachingStore } = await loadSrc('src/caching-store.ts')

const tick = () => new Promise((r) => setTimeout(r, 0))

// Two chunks per step: /v/c/<t>/0 and /v/c/<t>/1, 1000 bytes each. The fake
// mode's prefetch reads them through the store with the step's signal and
// stays in flight until released; `release({ abortAfter: n })` aborts the
// step (via a new window without it) after its first n chunks.
function statusLayer({ maxBytes = 100_000, failing = new Set() } = {}) {
  const layer = new ZarrLayer({
    id: 'test',
    source: 'http://example.invalid/store.zarr',
    variable: 'v',
    clim: [0, 1],
    colormap: ['#000000', '#ffffff'],
    selector: { time: { selected: 0, type: 'index' } },
  })
  const keysFor = (t) => [`/v/c/${t}/0`, `/v/c/${t}/1`]
  const base = {
    async get(key) {
      if (failing.has(key)) throw new Error(`fetch failed: ${key}`)
      return new Uint8Array(1000)
    },
  }
  const store = new CachingStore(base, maxBytes)
  store.addAccessListener((key, opts) => layer.attributeChunkAccess(key, opts))
  layer.zarrStore = { cachingStore: store }
  const fetches = []
  layer.mode = {
    setSelector: async () => {},
    dispose() {},
    prefetchTimeSteps(indices, dim, signal, options) {
      const idx = indices[0]
      return new Promise((resolve) => {
        const entry = { idx }
        entry.release = async ({ abortAfter = Infinity } = {}) => {
          const keys = keysFor(idx)
          for (let i = 0; i < keys.length; i++) {
            if (i === abortAfter) {
              layer.prefetchTimeSteps([], dim)
              break
            }
            try {
              await store.get(keys[i], { signal })
            } catch {
              options.onFetchError?.()
            }
          }
          resolve(true) // untiled mode resolves true when aborted too
        }
        fetches.push(entry)
      })
    },
  }
  const fetchStep = async (idx, releaseOptions) => {
    layer.prefetchTimeSteps([idx])
    await tick()
    await fetches.at(-1).release(releaseOptions)
    await tick()
  }
  // A render of the displayed step: its reads (no prefetch signal), with the
  // mode's chunk-loading edges around them, then (if `complete`) the mode's
  // report that every visible region holds data for the current selector.
  const render = async (keys, { complete = true } = {}) => {
    layer.handleChunkLoadingChange({ loading: true, chunks: true })
    for (const key of keys) {
      try {
        await store.get(key)
      } catch {
        // the mode swallows a failed region read and renders the rest
      }
    }
    layer.handleChunkLoadingChange({ loading: false, chunks: false })
    if (complete) layer.handleViewComplete()
  }
  const status = (t) => layer.getCacheStatus([t])[t]
  return { layer, store, fetches, fetchStep, render, keysFor, status }
}

test('a step aborted partway reads partial and the next window refetches it', async () => {
  const { layer, fetches, fetchStep, status } = statusLayer()
  await fetchStep(3, { abortAfter: 1 })
  assert.equal(status(3), 'partial')
  assert.equal(layer.isTimeStepCached(3), false)

  // The next window that includes it fetches it again, to completion
  layer.prefetchTimeSteps([3])
  await tick()
  assert.equal(fetches.length, 2, 'refetched')
  await fetches[1].release()
  await tick()
  assert.equal(status(3), 'cached')

  // Now cached: a later window skips it
  layer.prefetchTimeSteps([3])
  await tick()
  assert.equal(fetches.length, 2)
})

test('a step aborted before any chunk landed reads missing', async () => {
  const { fetchStep, status } = statusLayer()
  await fetchStep(4, { abortAfter: 0 })
  assert.equal(status(4), 'missing')
})

test('a completed step reads cached; evicting one of its chunks makes it partial', async () => {
  // Room for 3 chunks: step 1 then step 2 evicts step 1's first chunk
  const { store, fetchStep, status } = statusLayer({ maxBytes: 3000 })
  await fetchStep(1)
  assert.equal(status(1), 'cached')
  await fetchStep(2)
  assert.equal(store.has('/v/c/1/0'), false)
  assert.equal(status(1), 'partial')
  assert.equal(status(2), 'cached')
})

test('a step with a failed chunk fetch is not cached', async () => {
  const { fetchStep, status } = statusLayer({
    failing: new Set(['/v/c/5/1']),
  })
  await fetchStep(5)
  assert.equal(status(5), 'partial')
})

test('a render the mode reports complete reads cached', async () => {
  const { render, keysFor, status } = statusLayer()
  await render(keysFor(0))
  assert.equal(status(0), 'cached')
})

test('a render whose loading ended after a failed read is not cached', async () => {
  // One read lands, the other fails; the mode still emits chunks:false but
  // never reports the view complete (the failed region is not current)
  const { render, keysFor, status } = statusLayer({
    failing: new Set(['/v/c/0/1']),
  })
  await render(keysFor(0), { complete: false })
  assert.equal(status(0), 'partial')
})

test('a render aborted partway (loading ends, not complete) is not cached', async () => {
  const { layer, render, keysFor, status } = statusLayer()
  await render(keysFor(0).slice(0, 1), { complete: false })
  assert.equal(status(0), 'partial')
  // The user steps away: step 0 stays partial
  await layer.setSelector({ time: { selected: 1, type: 'index' } })
  layer.handleViewComplete() // step 1's view (nothing recorded for it)
  assert.equal(status(0), 'partial')
  assert.equal(status(1), 'missing')
})

test('(a) a view completing while chunks still read as loading (throttle) counts', async () => {
  // Fast stepping: untiled mode keeps chunks=true while a throttled fetch is
  // pending, so no chunks:false edge arrives, but the displayed step's
  // regions did land for the current selector
  const { layer, store, keysFor, status } = statusLayer()
  layer.handleChunkLoadingChange({ loading: true, chunks: true })
  for (const key of keysFor(0)) await store.get(key)
  layer.handleViewComplete()
  assert.equal(layer.chunksLoading, true)
  assert.equal(status(0), 'cached')
})

test('(b) a redisplay served from the mode cache (no reads) reads cached', async () => {
  const { layer, store, keysFor, status } = statusLayer()
  // Step 0's chunks were read while displayed, but its render was cut off
  // (the step changed before the mode reported it complete)
  for (const key of keysFor(0)) await store.get(key)
  await layer.setSelector({ time: { selected: 1, type: 'index' } })
  await layer.setSelector({ time: { selected: 0, type: 'index' } })
  assert.equal(status(0), 'partial')
  // Back on step 0: the normalized cache restores every region, no reads
  layer.handleViewComplete()
  assert.equal(status(0), 'cached')
  // Its recorded chunks are what the status checks
  store.setMaxBytes(0)
  store.setMaxBytes(100_000)
  assert.equal(status(0), 'missing')
})

test('a step change mid-render completes only the step on screen', async () => {
  const { layer, store, render, keysFor, status } = statusLayer()
  layer.handleChunkLoadingChange({ loading: true, chunks: true })
  await store.get(keysFor(0)[0])
  // Displayed step changes before step 0's view completes; step 1 is read
  await layer.setSelector({ time: { selected: 1, type: 'index' } })
  for (const key of keysFor(1)) await store.get(key)
  layer.handleViewComplete()
  assert.equal(status(0), 'partial')
  assert.equal(status(1), 'cached')
  // A later render pass (e.g. a pan) of step 1 adds to its complete set
  await render(['/v/c/1/extra'])
  store.setMaxBytes(0)
  store.setMaxBytes(100_000)
  // Step 1's own chunks come back (read outside a render), the extra one not
  for (const key of keysFor(1)) await store.get(key)
  assert.equal(status(1), 'partial')
})

test('a completed prefetch replaces the render-complete set', async () => {
  const { store, fetches, render, fetchStep, keysFor, status } = statusLayer()
  // Render read an extra chunk (e.g. another level) for step 0
  await render([...keysFor(0), '/v/c/0/other-level'])
  assert.equal(status(0), 'cached')
  // The extra chunk is evicted (step 0's own chunks come back): partial
  store.setMaxBytes(0)
  store.setMaxBytes(100_000)
  for (const key of keysFor(0)) await store.get(key)
  assert.equal(status(0), 'partial')
  // So the next window prefetches it; the completed prefetch is the exact
  // set for the current view, without the extra chunk
  await fetchStep(0)
  assert.equal(fetches.length, 1)
  assert.equal(store.has('/v/c/0/other-level'), false)
  assert.equal(status(0), 'cached')
})

test('a render and a prefetch deduped onto one in-flight key are each attributed', async () => {
  // Shard /v/s/0 holds steps 0 and 1: the render of step 0 and the
  // prefetch of step 1 read it at once
  const pending = []
  const base = {
    get: () => new Promise((resolve) => pending.push(resolve)),
  }
  const layer = new ZarrLayer({
    id: 'test',
    source: 'http://example.invalid/store.zarr',
    variable: 'v',
    clim: [0, 1],
    colormap: ['#000000', '#ffffff'],
    selector: { time: { selected: 0, type: 'index' } },
  })
  const store = new CachingStore(base, 100_000)
  store.addAccessListener((key, opts) => layer.attributeChunkAccess(key, opts))
  layer.zarrStore = { cachingStore: store }
  let prefetchRead
  layer.mode = {
    setSelector: async () => {},
    dispose() {},
    async prefetchTimeSteps(indices, dim, signal) {
      prefetchRead = store.get('/v/s/0', { signal })
      await prefetchRead
      return true
    },
  }
  layer.handleChunkLoadingChange({ loading: true, chunks: true })
  const renderRead = store.get('/v/s/0')
  layer.prefetchTimeSteps([1])
  await tick()
  assert.equal(pending.length, 1, 'one base fetch')
  pending[0](new Uint8Array(1000))
  await Promise.all([renderRead, prefetchRead])
  await tick()
  layer.handleViewComplete()
  const status = layer.getCacheStatus([0, 1])
  assert.deepEqual(status, { 0: 'cached', 1: 'cached' })
  assert.deepEqual(layer.getCacheDebugInfo().perTimestepHits, [
    { timeIndex: 0, recorded: 1, hits: 1 },
    { timeIndex: 1, recorded: 1, hits: 1 },
  ])
  assert.equal(store.getTotalBytes(), 1000)
})

// Mode side: when the modes report a complete view. Called on a minimal
// fake `this`, like the UntiledMode primitive tests.
const { UntiledMode } = await loadSrc('src/untiled-mode.ts')
const { TiledMode } = await loadSrc('src/tiled-mode.ts')

function untiledState(regions, overrides = {}) {
  const calls = []
  const state = {
    viewCompleteCallback: () => calls.push(1),
    lastViewCompleteToken: '',
    lastVisibleRegionsLevel: 0,
    currentLevelIndex: 0,
    selectorVersion: 2,
    lastVisibleRegions: regions.map(([regionX, regionY]) => ({
      regionX,
      regionY,
    })),
    regionCache: new Map(),
    makeRegionKey: (l, x, y) => `${l}:${x}:${y}`,
    isRegionValid: UntiledMode.prototype.isRegionValid,
    ...overrides,
  }
  for (const [x, y] of regions) {
    state.regionCache.set(`0:${x}:${y}`, {
      loading: false,
      selectorVersion: 2,
      data: new Float32Array(1),
      textureUploaded: true,
      texture: {},
      vertexBuffer: {},
      pixCoordBuffer: {},
      vertexArr: {},
      mercatorBounds: {},
    })
  }
  const check = () => UntiledMode.prototype.checkViewComplete.call(state)
  return { state, calls, check }
}

test('UntiledMode reports a view complete once, only when every visible region is current', () => {
  const { state, calls, check } = untiledState([
    [0, 0],
    [1, 0],
  ])
  // A region still loading, or failed/aborted (older selector version)
  state.regionCache.get('0:1:0').loading = true
  check()
  state.regionCache.get('0:1:0').loading = false
  state.regionCache.get('0:1:0').selectorVersion = 1
  check()
  assert.equal(calls.length, 0)
  // Fetched, or restored from the normalized cache, for the current version
  state.regionCache.get('0:1:0').selectorVersion = 2
  check()
  check()
  assert.equal(calls.length, 1, 'once per view')
  // A new selector version: incomplete until its regions are current
  state.selectorVersion = 3
  check()
  assert.equal(calls.length, 1)
  for (const r of state.regionCache.values()) r.selectorVersion = 3
  check()
  assert.equal(calls.length, 2)
})

test('UntiledMode reports nothing before a visible-region pass for the level', () => {
  const { calls, check } = untiledState([[0, 0]], {
    lastVisibleRegionsLevel: -1,
  })
  check()
  assert.equal(calls.length, 0)
})

test('TiledMode reports a view complete only when every visible tile has current data', () => {
  const calls = []
  const selector = { time: { selected: 1, type: 'index' } }
  const hash = JSON.stringify(selector)
  const tiles = new Map([
    ['0,0,0', { data: new Float32Array(1), selectorHash: hash }],
    ['1,0,0', { data: new Float32Array(1), selectorHash: 'old' }],
  ])
  const state = {
    viewCompleteCallback: () => calls.push(1),
    lastViewCompleteToken: '',
    selector,
    visibleTiles: [
      [0, 0, 0],
      [1, 0, 0],
    ],
    pendingChunks: new Set(),
    tileCache: { get: (k) => tiles.get(k) },
  }
  const check = () => TiledMode.prototype.checkViewComplete.call(state)
  check()
  assert.equal(calls.length, 0, 'a tile holds data for an old selector')
  tiles.get('1,0,0').selectorHash = hash
  state.pendingChunks.add('1,0,0')
  check()
  assert.equal(calls.length, 0, 'a tile is pending')
  state.pendingChunks.clear()
  check()
  check()
  assert.equal(calls.length, 1)
})
