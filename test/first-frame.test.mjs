// ace-viz task 52 items 4-5 (time to first image): a layer given the
// displayed step's shard index (`preloadedShardIndexes`, e.g. from a
// build-time manifest) reads only the inner chunks for its first frame, and
// `firstFrameRangeRequests` reads the first frame by range on a layer that
// otherwise reads whole shards, switching to whole objects once the frame is
// in or prefetch starts. Uses the fake store and waved fetch of
// fake-v3-store.mjs. Run: npm test
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc } from './load-src.mjs'
import { buildFakeV3Store, fakeFetch } from './fake-v3-store.mjs'

const { ZarrLayer } = await loadSrc('src/zarr-layer.ts')

const describe = (r) => `${r.key}${r.range ? ` (${r.range})` : ''}`
// The fake store's shard index: 16 inner chunks x 16 bytes + a 4-byte checksum
const INDEX_BYTES = 16 * 16 + 4

beforeEach((t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
})

// Every object the layer reads on open, preloaded (as the app's manifest does)
function preloadAll(objects) {
  const out = {}
  for (const key of [
    'zarr.json',
    'time/c/0',
    'ensemble/c/0',
    'latitude/c/0',
    'longitude/c/0',
  ]) {
    out[key] = objects.get(key)
  }
  return out
}

function openLayer(t, options = {}) {
  const store = buildFakeV3Store()
  const server = fakeFetch(store.base, store.objects)
  t.mock.method(globalThis, 'fetch', server.fetch)
  const layer = new ZarrLayer({
    id: 'test',
    source: store.base,
    variable: 'v',
    clim: [0, 1],
    colormap: ['#000000', '#ffffff'],
    // Step 5: the second shard (4 steps per shard)
    selector: {
      time: { selected: 5, type: 'index' },
      ensemble: { selected: 0, type: 'index' },
    },
    zarrVersion: 3,
    ...(typeof options === 'function' ? options(store.objects) : options),
  })
  return { layer, server, objects: store.objects }
}

const indexOf = (objects, key) => {
  const body = objects.get(key)
  return body.slice(body.length - INDEX_BYTES)
}

const read = (layer, server, coords) =>
  server.runUntil(layer.zarrStore.getArray().then((a) => a.getChunk(coords)))

test('a preloaded shard index: no request on open, only the inner chunk for the first read', async (t) => {
  const { layer, server } = openLayer(t, (objects) => ({
    rangeRequests: true,
    preloadedObjects: preloadAll(objects),
    preloadedShardIndexes: { 'v/c/1/0/0/0': indexOf(objects, 'v/c/1/0/0/0') },
  }))
  await server.runUntil(layer.initialize())
  assert.deepEqual(server.requests.map(describe), [], 'nothing on open')
  const chunk = await read(layer, server, [5, 0, 1, 1])
  // Inner chunk 7 of shard 1 (the fake store fills it with 100 * shard + i)
  assert.equal(chunk.data[0], 107)
  assert.equal(server.requests.length, 1, server.requests.map(describe).join())
  assert.match(server.requests[0].range, /^bytes=\d+-\d+$/)
})

test('a preloaded shard index of another length is not used', async (t) => {
  const { layer, server } = openLayer(t, (objects) => ({
    rangeRequests: true,
    preloadedObjects: preloadAll(objects),
    preloadedShardIndexes: {
      'v/c/1/0/0/0': indexOf(objects, 'v/c/1/0/0/0').slice(4),
    },
  }))
  await server.runUntil(layer.initialize())
  assert.deepEqual(server.requests.map(describe), [
    `v/c/1/0/0/0 (bytes=-${INDEX_BYTES})`,
  ])
})

test('whole-object mode ignores preloaded shard indexes (it reads the whole shard)', async (t) => {
  const { layer, server } = openLayer(t, (objects) => ({
    preloadedObjects: preloadAll(objects),
    preloadedShardIndexes: { 'v/c/1/0/0/0': indexOf(objects, 'v/c/1/0/0/0') },
  }))
  await server.runUntil(layer.initialize())
  const chunk = await read(layer, server, [5, 0, 1, 1])
  assert.equal(chunk.data[0], 107)
  assert.deepEqual(server.requests.map(describe), ['v/c/1/0/0/0'])
})

test('firstFrameRangeRequests: the first frame by range, then whole shards once prefetch starts', async (t) => {
  const { layer, server } = openLayer(t, (objects) => ({
    firstFrameRangeRequests: true,
    preloadedObjects: preloadAll(objects),
  }))
  await server.runUntil(layer.initialize())
  // The displayed step's shard index is read on open, as in range mode
  assert.deepEqual(server.requests.map(describe), [
    `v/c/1/0/0/0 (bytes=-${INDEX_BYTES})`,
  ])
  assert.equal(layer.zarrStore.cachingStore.rangeRequests, true)
  const first = await read(layer, server, [5, 0, 1, 1])
  assert.equal(first.data[0], 107)
  assert.match(server.requests.at(-1).range, /^bytes=\d+-\d+$/)

  layer.prefetchTimeSteps([0], 'time')
  assert.equal(layer.zarrStore.cachingStore.rangeRequests, false)
  assert.equal(layer.getPrefetchBatchSize(), 1, 'whole shards: no batches')
  const before = server.requests.length
  const other = await read(layer, server, [0, 0, 0, 0])
  assert.equal(other.data[0], 0)
  assert.deepEqual(server.requests.slice(before).map(describe), ['v/c/0/0/0/0'])
})

test('firstFrameRangeRequests: a completed view also ends range reads; an empty window does not', async (t) => {
  const { layer, server } = openLayer(t, (objects) => ({
    firstFrameRangeRequests: true,
    preloadedObjects: preloadAll(objects),
  }))
  await server.runUntil(layer.initialize())
  layer.prefetchTimeSteps([], 'time')
  assert.equal(layer.zarrStore.cachingStore.rangeRequests, true)
  layer.handleViewComplete()
  assert.equal(layer.zarrStore.cachingStore.rangeRequests, false)
})

test('firstFrameRangeRequests is ignored when rangeRequests is on', async (t) => {
  const { layer, server } = openLayer(t, (objects) => ({
    rangeRequests: true,
    firstFrameRangeRequests: true,
    preloadedObjects: preloadAll(objects),
  }))
  await server.runUntil(layer.initialize())
  layer.prefetchTimeSteps([0], 'time')
  assert.equal(layer.zarrStore.cachingStore.rangeRequests, true)
})
