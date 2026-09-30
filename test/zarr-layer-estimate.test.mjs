// ZarrLayer per-step byte estimate (getEstimatedTimestepBytes /
// getRecommendedPrefetchCount) against a real CachingStore, loaded from src
// via esbuild. Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc } from './load-src.mjs'

const { ZarrLayer } = await loadSrc('src/zarr-layer.ts')
const { CachingStore } = await loadSrc('src/caching-store.ts')

const tick = () => new Promise((r) => setTimeout(r, 0))

// A layer wired to a real CachingStore over a fake base store whose entries
// are `sizes[key]` bytes. The fake mode's per-step fetch reads the step's
// keys (`keysFor(member, idx)`) through the store with the request's signal,
// like zarrita does, once released; `release({ abortAfter: n })` aborts the
// step after its first n keys. Keys in `failing` fail to fetch; like untiled
// mode, the step swallows the error, reports it and still resolves done.
function estimateLayer({
  sizes,
  keysFor,
  maxBytes = 100_000,
  failing = new Set(),
}) {
  const layer = new ZarrLayer({
    id: 'test',
    source: 'http://example.invalid/store.zarr',
    variable: 'v',
    clim: [0, 1],
    colormap: ['#000000', '#ffffff'],
    selector: { time: { selected: 0, type: 'index' }, member: 0 },
  })
  const base = {
    async get(key) {
      if (failing.has(key)) throw new Error(`fetch failed: ${key}`)
      const n = sizes[key]
      return n === undefined ? undefined : new Uint8Array(n)
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
      const member = layer.normalizedSelector.member.selected
      return new Promise((resolve) => {
        const entry = { idx, member }
        entry.release = async ({ abortAfter = Infinity } = {}) => {
          const keys = keysFor(member, idx)
          for (let i = 0; i < keys.length; i++) {
            if (i === abortAfter) {
              entry.abort()
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
        entry.abort = () => layer.prefetchTimeSteps([], dim)
        fetches.push(entry)
      })
    },
  }
  // Prefetch one step for the current member and wait for it to land
  const fetchStep = async (idx, releaseOptions) => {
    layer.prefetchTimeSteps([idx])
    await tick()
    await fetches.at(-1).release(releaseOptions)
    await tick()
  }
  // A render read of the displayed step (no prefetch signal)
  const renderRead = (key) => store.get(key)
  return { layer, store, fetches, fetchStep, renderRead }
}

test('no estimate from coordinates and a partial displayed step; then the prefetched step own bytes', async () => {
  const sizes = {
    '/time/c/0': 50,
    '/lat/c/0': 40,
    '/v/c/0/0': 1000,
    '/v/c/0/1': 1000,
    '/v/c/1/0': 1000,
    '/v/c/1/1': 1000,
  }
  const { layer, fetchStep, renderRead } = estimateLayer({
    sizes,
    keysFor: (m, t) => [`/v/c/${t}/0`, `/v/c/${t}/1`],
  })
  // Init: coordinate arrays, then half of the displayed step (time 0)
  await renderRead('/time/c/0')
  await renderRead('/lat/c/0')
  await renderRead('/v/c/0/0')
  // All of step 0's recorded keys are resident, but no fetch of it completed
  assert.equal(layer.isTimeStepCached(0), false)
  assert.equal(layer.getCacheStatus([0])[0], 'partial')
  assert.equal(layer.getEstimatedTimestepBytes(), null)
  assert.equal(layer.getRecommendedPrefetchCount(), null)

  await fetchStep(1)
  assert.equal(layer.getEstimatedTimestepBytes(), 2000)
  // floor((100000 * 0.9 - 2000) / 2000)
  assert.equal(layer.getRecommendedPrefetchCount(), 44)
})

test('an entry shared by two steps (coalesced shard) is split between them', async () => {
  // Shard /v/c/0 holds time steps 0 and 1, /v/c/1 holds 2 and 3
  const sizes = { '/v/c/0': 2000, '/v/c/1': 2000 }
  const { layer, fetchStep } = estimateLayer({
    sizes,
    keysFor: (m, t) => [`/v/c/${Math.floor(t / 2)}`],
  })
  await fetchStep(2)
  // Neighbour not recorded yet: the whole shard counts (errs high)
  assert.equal(layer.getEstimatedTimestepBytes(), 2000)
  await fetchStep(3)
  assert.equal(layer.getEstimatedTimestepBytes(), 1000)
  await fetchStep(0)
  // Step 0 alone on its shard, steps 2 and 3 split theirs
  assert.equal(layer.getEstimatedTimestepBytes(), (2000 + 1000 + 1000) / 3)
})

test('an entry shared by members at the same time is not split', async () => {
  // The member dim is inside the chunk: members read the same key
  const sizes = { '/v/c/1': 1000, '/v/c/2': 1000 }
  const { layer, fetchStep } = estimateLayer({
    sizes,
    keysFor: (m, t) => [`/v/c/${t}`],
  })
  await fetchStep(1)
  await layer.setSelector({ time: { selected: 0, type: 'index' }, member: 1 })
  await fetchStep(1)
  await fetchStep(2)
  assert.equal(layer.getEstimatedTimestepBytes(), 1000)
})

test('an aborted prefetch step does not count', async () => {
  const sizes = { '/v/c/1/0': 1000, '/v/c/1/1': 1000 }
  const { layer, store, fetchStep } = estimateLayer({
    sizes,
    keysFor: (m, t) => [`/v/c/${t}/0`, `/v/c/${t}/1`],
  })
  await fetchStep(1, { abortAfter: 1 })
  // Its recorded keys are all resident, but the step is incomplete
  assert.equal(layer.getCacheStatus([1])[1], 'partial')
  assert.equal(layer.getEstimatedTimestepBytes(), null)
  // Fetched again to completion: counts, with all its keys
  await fetchStep(1)
  assert.equal(layer.getCacheStatus([1])[1], 'cached')
  assert.equal(layer.getEstimatedTimestepBytes(), 2000)
})

test('eviction does not change the estimate', async () => {
  const sizes = {}
  for (let t = 0; t < 5; t++) {
    sizes[`/v/c/${t}/0`] = 1000
    sizes[`/v/c/${t}/1`] = 1000
  }
  // Room for two steps: fetching more evicts the oldest
  const { layer, store, fetchStep } = estimateLayer({
    sizes,
    keysFor: (m, t) => [`/v/c/${t}/0`, `/v/c/${t}/1`],
    maxBytes: 4000,
  })
  for (let t = 0; t < 5; t++) await fetchStep(t)
  assert.equal(store.has('/v/c/0/0'), false, 'step 0 evicted')
  assert.equal(layer.getCacheStatus([0])[0], 'missing')
  assert.equal(layer.getEstimatedTimestepBytes(), 2000)
  // floor((4000 * 0.9 - 2000) / 2000)
  assert.equal(layer.getRecommendedPrefetchCount(), 0)
})

test('a budget change keeps the estimate and rescales the recommended count', async () => {
  const sizes = { '/v/c/1': 1000, '/v/c/2': 1000 }
  const { layer, store, fetchStep } = estimateLayer({
    sizes,
    keysFor: (m, t) => [`/v/c/${t}`],
    maxBytes: 10_000,
  })
  await fetchStep(1)
  await fetchStep(2)
  assert.equal(layer.getRecommendedPrefetchCount(), 8) // (9000 - 1000) / 1000
  store.setMaxBytes(5000)
  assert.equal(layer.getEstimatedTimestepBytes(), 1000)
  assert.equal(layer.getRecommendedPrefetchCount(), 3) // (4500 - 1000) / 1000
  // "Clear cache" and restore: sizes are remembered
  store.setMaxBytes(0)
  store.setMaxBytes(20_000)
  assert.equal(store.size, 0)
  assert.equal(layer.getEstimatedTimestepBytes(), 1000)
  assert.equal(layer.getRecommendedPrefetchCount(), 17) // (18000 - 1000) / 1000
})

test('getEntryBytes reads the size without touching LRU order', async () => {
  const store = new CachingStore({ get: async () => new Uint8Array(10) }, 20)
  await store.get('/a')
  await store.get('/b')
  assert.equal(store.getEntryBytes('/a'), 10)
  assert.equal(store.getEntryBytes('/missing'), undefined)
  await store.get('/c') // evicts the least recently used: still /a
  assert.equal(store.has('/a'), false)
  assert.equal(store.has('/b'), true)
  assert.equal(store.getEntryBytes('/c'), 10)
})

test('render reads of other levels or regions do not count towards a measured step', async () => {
  const sizes = {
    '/0/v/c/1': 1000,
    '/0/v/c/2': 1000,
    '/1/v/c/1/0': 1000,
    '/1/v/c/1/1': 1000,
  }
  const { layer, fetchStep, renderRead } = estimateLayer({
    sizes,
    keysFor: (m, t) => [`/0/v/c/${t}`],
  })
  await fetchStep(1)
  await fetchStep(2)
  assert.equal(layer.getEstimatedTimestepBytes(), 1000)
  // The user moves to step 1 and zooms in: renders read a finer level
  await layer.setSelector({ time: { selected: 1, type: 'index' }, member: 0 })
  await renderRead('/1/v/c/1/0')
  await renderRead('/1/v/c/1/1')
  assert.equal(layer.getEstimatedTimestepBytes(), 1000)
})

test('a prefetch step with a failed chunk fetch does not count', async () => {
  const sizes = { '/v/c/1/0': 1000, '/v/c/1/1': 1000, '/v/c/2/0': 1000 }
  const { layer, fetchStep } = estimateLayer({
    sizes,
    keysFor: (m, t) => [`/v/c/${t}/0`, `/v/c/${t}/1`],
    failing: new Set(['/v/c/2/1']),
  })
  await fetchStep(2)
  assert.equal(layer.getEstimatedTimestepBytes(), null)
  await fetchStep(1)
  assert.equal(layer.getEstimatedTimestepBytes(), 2000)
})

test('the estimate follows a change of view: it averages the most recent steps', async () => {
  // Steps 0-19 measured zoomed out (1000 B), then 20-35 zoomed in (5000 B)
  const sizes = {}
  for (let t = 0; t < 36; t++) sizes[`/v/c/${t}`] = t < 20 ? 1000 : 5000
  const { layer, fetchStep } = estimateLayer({
    sizes,
    keysFor: (m, t) => [`/v/c/${t}`],
    maxBytes: 1_000_000,
  })
  for (let t = 0; t < 20; t++) await fetchStep(t)
  assert.equal(layer.getEstimatedTimestepBytes(), 1000)
  for (let t = 20; t < 28; t++) await fetchStep(t)
  assert.equal(layer.getEstimatedTimestepBytes(), 3000) // 8 old, 8 new
  for (let t = 28; t < 36; t++) await fetchStep(t)
  assert.equal(layer.getEstimatedTimestepBytes(), 5000)
})

test('two steps sharing a shard, both in flight, split it once both land', async () => {
  const sizes = { '/v/c/0': 2000 }
  const { layer, fetches } = estimateLayer({
    sizes,
    keysFor: (m, t) => ['/v/c/0'],
  })
  layer.prefetchTimeSteps([0, 1])
  await tick()
  assert.equal(fetches.length, 2)
  await fetches[0].release()
  await tick()
  // Step 1 is still in flight: step 0 alone carries the shard (errs high)
  assert.equal(layer.getEstimatedTimestepBytes(), 2000)
  await fetches[1].release()
  await tick()
  assert.equal(layer.getEstimatedTimestepBytes(), 1000)
})
