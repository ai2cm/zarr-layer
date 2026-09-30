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
  // A render of the displayed step: the mode reports chunk loading around
  // its reads (no prefetch signal), like untiled mode's fetchRegions.
  const render = async (keys, { finish = true } = {}) => {
    layer.handleChunkLoadingChange({ loading: true, chunks: true })
    for (const key of keys) await store.get(key)
    if (finish)
      layer.handleChunkLoadingChange({ loading: false, chunks: false })
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

test('a completed render of the displayed step reads cached', async () => {
  const { render, keysFor, status } = statusLayer()
  await render(keysFor(0))
  assert.equal(status(0), 'cached')
})

test('render reads without a finished render do not count as cached', async () => {
  const { layer, render, keysFor, status } = statusLayer()
  // Still loading
  await render(keysFor(0).slice(0, 1), { finish: false })
  assert.equal(status(0), 'partial')
  // The user steps away before the render finishes: step 0 stays partial,
  // and step 1's loading end does not complete it
  await layer.setSelector({ time: { selected: 1, type: 'index' } })
  layer.handleChunkLoadingChange({ loading: false, chunks: false })
  assert.equal(status(0), 'partial')
  assert.equal(status(1), 'missing')
})

test('a render during a step change completes only the step it read for', async () => {
  const { layer, store, render, keysFor, status } = statusLayer()
  layer.handleChunkLoadingChange({ loading: true, chunks: true })
  await store.get(keysFor(0)[0])
  // Displayed step changes while chunks are still loading; step 1 is read
  await layer.setSelector({ time: { selected: 1, type: 'index' } })
  for (const key of keysFor(1)) await store.get(key)
  layer.handleChunkLoadingChange({ loading: false, chunks: false })
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
