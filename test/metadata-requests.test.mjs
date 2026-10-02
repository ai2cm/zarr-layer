// ace-viz task 52 (time to first image): opening a layer on a consolidated
// zarr v3 store reads each metadata object once, never probes v2 keys
// (.zmetadata / .zattrs / .zgroup) once the format is known, and reads the
// coordinates and the displayed step's shard index concurrently right after
// zarr.json. Objects the app already read (`preloadedObjects`) are not read
// again. A fake HTTP server answers in waves (see fake-v3-store.mjs), so a
// request's wave is the length of the chain of round trips it waited on.
// Run: npm test
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadSrc } from './load-src.mjs'
import { buildFakeV3Store, fakeFetch } from './fake-v3-store.mjs'

const { ZarrLayer } = await loadSrc('src/zarr-layer.ts')

const V2_KEYS = /(^|\/)\.(zmetadata|zattrs|zgroup|zarray)$/
const describe = (r) => `${r.key}${r.range ? ` (${r.range})` : ''}`

beforeEach((t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
})

function openLayer(t, options = {}, store = buildFakeV3Store()) {
  const { base, objects } = store
  const server = fakeFetch(base, objects)
  t.mock.method(globalThis, 'fetch', server.fetch)
  const layer = new ZarrLayer({
    id: 'test',
    source: base,
    variable: 'v',
    clim: [0, 1],
    colormap: ['#000000', '#ffffff'],
    // Step 5: the second shard (4 steps per shard)
    selector: {
      time: { selected: 5, type: 'index' },
      ensemble: { selected: 0, type: 'index' },
    },
    rangeRequests: true,
    ...options,
  })
  return { layer, server, objects }
}

// Each (key, range) requested at most once (in one layer: two layers on
// one store keep separate chunk caches)
function assertNoRepeats(requests) {
  const seen = new Set()
  for (const r of requests) {
    const id = describe(r)
    assert.ok(!seen.has(id), `${id} requested twice: ${requests.map(describe)}`)
    seen.add(id)
  }
}

const SHARD_INDEX = 'v/c/1/0/0/0 (bytes=-260)'

test('zarrVersion 3: zarr.json once, then coords and the shard index together; no v2 probes', async (t) => {
  const { layer, server } = openLayer(t, { zarrVersion: 3 })
  await server.runUntil(layer.initialize())
  const { requests } = server
  assert.deepEqual(
    requests.filter((r) => V2_KEYS.test(r.key)).map(describe),
    [],
    'no v2 keys'
  )
  assertNoRepeats(requests)
  const wave = (n) =>
    requests
      .filter((r) => r.wave === n)
      .map(describe)
      .sort()
  assert.deepEqual(wave(1), ['zarr.json'])
  assert.deepEqual(wave(2), [
    'ensemble/c/0',
    'latitude/c/0',
    'longitude/c/0',
    'time/c/0',
    SHARD_INDEX,
  ])
  assert.equal(requests.length, 6, requests.map(describe).join(', '))
})

test('the first read of the displayed step reuses the prefetched shard index', async (t) => {
  const { layer, server } = openLayer(t, { zarrVersion: 3 })
  await server.runUntil(layer.initialize())
  const before = server.requests.length
  const chunk = await server.runUntil(
    layer.zarrStore.getArray().then((a) => a.getChunk([5, 0, 1, 1]))
  )
  assert.ok(chunk.data.length > 0)
  const after = server.requests.slice(before)
  assert.equal(after.length, 1, after.map(describe).join(', '))
  assert.match(
    after[0].range,
    /^bytes=\d+-\d+$/,
    'an inner chunk, not the index'
  )
})

test('a preloaded v3 zarr.json stands for zarrVersion 3 and is not fetched', async (t) => {
  const store = buildFakeV3Store()
  const { layer, server } = openLayer(
    t,
    { preloadedObjects: { 'zarr.json': store.objects.get('zarr.json') } },
    store
  )
  await server.runUntil(layer.initialize())
  const keys = server.requests.map(describe)
  assert.ok(!keys.includes('zarr.json'), keys.join(', '))
  assert.deepEqual(
    keys.filter((k) => V2_KEYS.test(k)),
    [],
    'no v2 keys'
  )
  assertNoRepeats(server.requests)
  // Everything else in one round trip
  assert.ok(
    server.requests.every((r) => r.wave === 1),
    keys.join(', ')
  )
})

test('preloaded coordinates (bytes or in flight) are not read again; a failed one is', async (t) => {
  const store = buildFakeV3Store()
  const { objects } = store
  let resolveTime
  const { layer, server } = openLayer(
    t,
    {
      preloadedObjects: {
        'zarr.json': objects.get('zarr.json'),
        // still in flight when the layer opens
        'time/c/0': new Promise((r) => {
          resolveTime = r
        }),
        latitude: undefined, // not a key the layer reads
        'latitude/c/0': objects.get('latitude/c/0'),
        'longitude/c/0': Promise.reject(new Error('the app read failed')),
      },
    },
    store
  )
  const init = layer.initialize()
  setTimeout(() => resolveTime(objects.get('time/c/0')), 20)
  await server.runUntil(init)
  assert.deepEqual(server.requests.map(describe).sort(), [
    'ensemble/c/0',
    'longitude/c/0',
    SHARD_INDEX,
  ])
  // The preloaded time values were used
  assert.deepEqual(layer.dimensionValues.time, [0, 6, 12, 18, 24, 30, 36, 42])
})

test('without a known format, auto-detection still works (v2 probes are upstream behaviour)', async (t) => {
  const { layer, server } = openLayer(t)
  await server.runUntil(layer.initialize())
  assert.equal(layer.zarrStore.shape.join(','), '8,1,4,8')
  assertNoRepeats(server.requests)
})

test('whole-object mode does not prefetch shards (the index is the whole shard)', async (t) => {
  const { layer, server } = openLayer(t, {
    zarrVersion: 3,
    rangeRequests: false,
  })
  await server.runUntil(layer.initialize())
  const keys = server.requests.map(describe)
  assert.ok(!keys.some((k) => k.startsWith('v/c/')), keys.join(', '))
})

test('no shard prefetch when a dimension is selected by value or left out', async (t) => {
  for (const selector of [
    { time: { selected: 30, type: 'value' }, ensemble: 0 },
    { ensemble: { selected: 0, type: 'index' } }, // time left out
  ]) {
    const { layer, server } = openLayer(t, { zarrVersion: 3, selector })
    await server.runUntil(layer.initialize())
    const keys = server.requests.map(describe)
    assert.ok(!keys.some((k) => k.startsWith('v/c/')), keys.join(', '))
  }
})

test('two layers on one store read zarr.json once (the opened store is shared)', async (t) => {
  const { layer, server } = openLayer(t, { zarrVersion: 3 })
  const other = new ZarrLayer({
    id: 'other',
    source: layer.url,
    variable: 'v',
    clim: [0, 1],
    colormap: ['#000000', '#ffffff'],
    selector: { time: { selected: 5, type: 'index' } },
    zarrVersion: 3,
    rangeRequests: true,
  })
  await server.runUntil(Promise.all([layer.initialize(), other.initialize()]))
  assert.equal(
    server.requests.filter((r) => r.key === 'zarr.json').length,
    1,
    server.requests.map(describe).join(', ')
  )
})

test('a later layer on the same source uses its own (newer) preloaded objects', async (t) => {
  const store = buildFakeV3Store()
  const { objects } = store
  const { layer, server } = openLayer(
    t,
    {
      zarrVersion: 3,
      preloadedObjects: {
        'zarr.json': objects.get('zarr.json'),
        'time/c/0': objects.get('time/c/0'),
      },
    },
    store
  )
  await server.runUntil(layer.initialize())
  assert.deepEqual(layer.dimensionValues.time, [0, 6, 12, 18, 24, 30, 36, 42])
  // The app re-read the store (a rescan) and the time axis changed
  const fresh = new Uint8Array(
    Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8]).buffer
  )
  const later = new ZarrLayer({
    id: 'later',
    source: store.base,
    variable: 'v',
    clim: [0, 1],
    colormap: ['#000000', '#ffffff'],
    selector: { time: { selected: 5, type: 'index' } },
    zarrVersion: 3,
    rangeRequests: true,
    preloadedObjects: { 'time/c/0': fresh },
  })
  const before = server.requests.length
  await server.runUntil(later.initialize())
  assert.deepEqual(later.dimensionValues.time, [1, 2, 3, 4, 5, 6, 7, 8])
  assert.ok(
    !server.requests.slice(before).some((r) => r.key === 'time/c/0'),
    'time read from the new preload, not the network'
  )
})

test('a preloaded undefined reads as a missing object (no network read)', async (t) => {
  const store = buildFakeV3Store()
  const { layer, server } = openLayer(
    t,
    { zarrVersion: 3, preloadedObjects: { 'ensemble/c/0': undefined } },
    store
  )
  await server.runUntil(layer.initialize())
  assert.ok(!server.requests.some((r) => r.key === 'ensemble/c/0'))
  // Missing chunk: zarrita's fill value (0)
  assert.deepEqual(layer.dimensionValues.ensemble, [0])
})
