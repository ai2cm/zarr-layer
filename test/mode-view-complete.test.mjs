// When UntiledMode / TiledMode report a complete view, through the real call
// sites (updateVisibleRegions, fetchRegion, fetchTileData) on a minimal fake
// `this`, like the UntiledMode primitive tests. Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as zarr from 'zarrita'
import { loadSrc } from './load-src.mjs'

const { UntiledMode } = await loadSrc('src/untiled-mode.ts')
const { TiledMode } = await loadSrc('src/tiled-mode.ts')

// WebGL stub: constants read as 0, every method is a no-op
const gl = new Proxy(
  {},
  {
    get: (_, prop) =>
      typeof prop === 'string' && prop === prop.toUpperCase() ? 0 : () => ({}),
  }
)

const P = UntiledMode.prototype

// A region that is fully renderable, at `selectorVersion`
function validRegion(x, y, selectorVersion) {
  return {
    key: `0:${x}:${y}`,
    levelIndex: 0,
    regionX: x,
    regionY: y,
    loading: false,
    requestId: null,
    selectorVersion,
    data: new Float32Array(16),
    bandData: new Map(),
    bandTexturesUploaded: new Set(),
    width: 4,
    height: 4,
    channels: 1,
    textureUploaded: true,
    texture: {},
    vertexBuffer: {},
    pixCoordBuffer: {},
    vertexArr: {},
    mercatorBounds: {},
  }
}

// Fake untiled `this` with two regions in view at level 0
function untiled(overrides = {}) {
  const calls = []
  const visible = [
    { regionX: 0, regionY: 0 },
    { regionX: 1, regionY: 0 },
  ]
  const state = {
    viewCompleteCallback: () => calls.push(1),
    lastViewCompleteToken: '',
    lastViewportHash: '',
    lastVisibleRegions: [],
    lastVisibleRegionsLevel: -1,
    currentLevelIndex: 0,
    selectorVersion: 2,
    currentSelectorHash: 'h2',
    regionCache: new Map(),
    visibleRegionKeys: new Set(),
    requestCanceller: { currentVersion: 0, controllers: new Map() },
    normalizedCache: { get: () => undefined, put() {} },
    getVisibleRegions: () => visible,
    makeRegionKey: (l, x, y) => `${l}:${x}:${y}`,
    isRegionValid: P.isRegionValid,
    currentLevelCoversViewport: P.currentLevelCoversViewport,
    checkViewComplete: P.checkViewComplete,
    invalidate() {},
    fetched: [],
    fetchRegions(regions) {
      this.fetched.push(...regions)
    },
    fetchRegionsThrottled(regions) {
      this.fetched.push(...regions)
    },
    ...overrides,
  }
  return { state, calls }
}

test('updateVisibleRegions: every region restored from the normalized cache, no reads -> one report', () => {
  const { state, calls } = untiled()
  // Both regions hold data for the previous selector (version 1); the
  // normalized cache has the current selector's data for both
  for (const [x, y] of [
    [0, 0],
    [1, 0],
  ]) {
    state.regionCache.set(`0:${x}:${y}`, validRegion(x, y, 1))
  }
  state.normalizedCache.get = () => ({
    data: new Float32Array(16),
    bandData: new Map(),
    width: 4,
    height: 4,
    channels: 1,
  })
  P.updateVisibleRegions.call(state, {}, gl)
  assert.deepEqual(state.fetched, [], 'nothing fetched')
  assert.equal(calls.length, 1)
  // The next frame (same view) does not report again
  P.updateVisibleRegions.call(state, {}, gl)
  assert.equal(calls.length, 1)
})

test('updateVisibleRegions: a region that must be fetched -> no report', () => {
  const { state, calls } = untiled()
  state.regionCache.set('0:0:0', validRegion(0, 0, 2))
  state.regionCache.set('0:1:0', validRegion(1, 0, 1)) // stale, not cached
  P.updateVisibleRegions.call(state, {}, gl)
  assert.deepEqual(state.fetched, [{ regionX: 1, regionY: 0 }])
  assert.equal(calls.length, 0)
})

// Fake untiled `this` for fetchRegion of region (1, 0); region (0, 0) is
// already current. `array` is what zarr.get reads.
async function fetchRegionState(array, overrides = {}) {
  const { state, calls } = untiled({
    lastVisibleRegions: [
      { regionX: 0, regionY: 0 },
      { regionX: 1, regionY: 0 },
    ],
    lastVisibleRegionsLevel: 0,
    isRemoved: false,
    dimIndices: { lat: { index: 1 }, lon: { index: 2 } },
    zarrStore: {
      describe: () => ({ fill_value: null, scaleFactor: 1, addOffset: 0 }),
    },
    levels: [],
    bandNames: ['v'],
    fixedDataScale: 1,
    buildChannelCombinations: P.buildChannelCombinations,
    createRegionGeometry() {},
    ...overrides,
  })
  state.regionCache.set('0:0:0', validRegion(0, 0, 2))
  const region = validRegion(1, 0, 1)
  state.regionCache.set('0:1:0', region)
  const snapshot = {
    index: 0,
    zarrArray: array,
    baseSliceArgs: [0, null, null],
    width: 8,
    height: 4,
    regionSize: [4, 4],
    selectorVersion: 2,
    baseMultiValueDims: [],
  }
  const run = () => P.fetchRegion.call(state, 1, 0, gl, snapshot)
  return { state, calls, region, run }
}

const ARRAY_META = {
  shape: [1, 4, 8],
  chunkShape: [1, 4, 4],
  dtype: 'float32',
  fillValue: 0,
}

// An in-memory array; with `failChunks`, opened over a store whose chunk
// reads reject (metadata still resolves)
async function memoryArray({ failChunks = false } = {}) {
  const map = new Map()
  const array = await zarr.create(zarr.root(map).resolve('v'), ARRAY_META)
  if (!failChunks) return array
  const store = {
    async get(key) {
      if (!key.startsWith('/v/c/')) return map.get(key) // metadata
      throw new Error(`fetch failed: ${key}`)
    },
  }
  return zarr.open(zarr.root(store).resolve('v'), { kind: 'array' })
}

test('fetchRegion: a completed fetch makes the view current -> one report', async () => {
  const { calls, region, run } = await fetchRegionState(await memoryArray())
  await run()
  assert.equal(region.selectorVersion, 2)
  assert.equal(calls.length, 1)
})

test('fetchRegion: a rejecting zarr.get -> no report, version not advanced', async () => {
  const failing = await memoryArray({ failChunks: true })
  const { calls, region, run } = await fetchRegionState(failing)
  const error = console.error
  const logged = []
  console.error = (...args) => logged.push(String(args[1]))
  try {
    await run()
  } finally {
    console.error = error
  }
  assert.match(logged.join(), /fetch failed/, 'failed in zarr.get')
  assert.equal(region.selectorVersion, 1)
  assert.equal(calls.length, 0)
})

test('fetchRegion: a throw after the version guard -> no report, version not advanced', async () => {
  // The read succeeds; texture upload then throws (e.g. an allocation failure)
  const throwingGl = new Proxy(gl, {
    get: (target, prop) =>
      prop === 'texImage2D'
        ? () => {
            throw new Error('out of memory')
          }
        : target[prop],
  })
  const { state, calls, region } = await fetchRegionState(await memoryArray())
  const snapshot = {
    index: 0,
    zarrArray: await memoryArray(),
    baseSliceArgs: [0, null, null],
    width: 8,
    height: 4,
    regionSize: [4, 4],
    selectorVersion: 2,
    baseMultiValueDims: [],
  }
  const error = console.error
  const logged = []
  console.error = (...args) => logged.push(String(args[1]))
  try {
    await P.fetchRegion.call(state, 1, 0, throwingGl, snapshot)
  } finally {
    console.error = error
  }
  assert.match(logged.join(), /out of memory/, 'threw after the read')
  assert.equal(region.selectorVersion, 1, 'stays stale, so it is refetched')
  assert.equal(calls.length, 0)
})

test('TiledMode fetchTileData: reports once the last visible tile lands; a failed tile does not', async () => {
  const calls = []
  const selector = { time: { selected: 1, type: 'index' } }
  const hash = JSON.stringify(selector)
  const tiles = new Map([
    ['0,0,0', { data: new Float32Array(1), selectorHash: hash }],
    ['1,0,0', { data: null, selectorHash: null }],
  ])
  const state = {
    viewCompleteCallback: () => calls.push(1),
    lastViewCompleteToken: '',
    selector,
    visibleTiles: [
      [0, 0, 0],
      [1, 0, 0],
    ],
    tileBounds: {},
    pendingChunks: new Set(['1,0,0']),
    requestCanceller: { controllers: new Map() },
    emitLoadingState() {},
    invalidate() {},
    checkViewComplete: TiledMode.prototype.checkViewComplete,
    tileCache: {
      get: (k) => tiles.get(k),
      // Like Tiles.fetchTile: null when the fetch failed or was aborted
      fetchTile: async () => null,
    },
  }
  const fetchTileData = (t) =>
    TiledMode.prototype.fetchTileData.call(state, t, hash, 1)
  await fetchTileData([1, 0, 0])
  assert.equal(calls.length, 0, 'failed tile')

  state.pendingChunks.add('1,0,0')
  state.tileCache.fetchTile = async () => {
    const tile = tiles.get('1,0,0')
    tile.data = new Float32Array(1)
    tile.selectorHash = hash
    return tile
  }
  await fetchTileData([1, 0, 0])
  assert.equal(calls.length, 1)
})
