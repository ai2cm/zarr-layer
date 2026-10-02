// UntiledMode.queryData X-mapping on 0-360 longitude stores (ace-viz task 48):
// queries are mapped against the shifted [-180, 180] frame, so the fetch must
// shift columns by 180° too, or it reads the antipode. Runs the real
// queryData / fetchQueryData on a fake `this` over an in-memory array whose
// values are each column's center longitude. Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as zarr from 'zarrita'
import { loadSrc } from './load-src.mjs'

const { UntiledMode } = await loadSrc('src/untiled-mode.ts')
const { boundsToMercatorNorm } = await loadSrc('src/map-utils.ts')

const WIDTH = 360 // 1° columns
const HEIGHT = 4 // 45° rows, lat ascending

// A [lat, lon] array; each cell holds its column's center lon in [xMin, xMax)
async function lonArray(xMin) {
  const arr = await zarr.create(zarr.root(new Map()).resolve('v'), {
    shape: [HEIGHT, WIDTH],
    chunkShape: [HEIGHT, 90],
    dtype: 'float32',
  })
  const data = new Float32Array(HEIGHT * WIDTH)
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) data[y * WIDTH + x] = xMin + x + 0.5
  await zarr.set(arr, null, {
    data,
    shape: [HEIGHT, WIDTH],
    stride: [WIDTH, 1],
  })
  return arr
}

// Fake untiled `this` over a global store whose lon extent starts at `xMin`
async function mode({ lon360 }) {
  const xMin = lon360 ? 0 : -180
  const xyLimits = { xMin, xMax: xMin + 360, yMin: -90, yMax: 90 }
  const zarrArray = await lonArray(xMin)
  const dimIndices = {
    lat: { name: 'lat', index: 0, array: null },
    lon: { name: 'lon', index: 1, array: null },
  }
  const self = Object.create(UntiledMode.prototype)
  Object.assign(self, {
    variable: 'v',
    selector: {},
    zarrArray,
    dimIndices,
    xyLimits,
    width: WIDTH,
    height: HEIGHT,
    crs: 'EPSG:4326',
    latIsAscending: true,
    lon360Wrap: lon360,
    proj4def: null,
    cachedWGS84Transformer: null,
    levels: [],
    currentLevelIndex: -1,
    dimensionValues: {},
    _antimeridianWarnings: new Set(),
    // As initialize() sets it: [-180, 180] for 0-360 data
    mercatorBounds: boundsToMercatorNorm(
      { ...xyLimits, xMin: -180, xMax: 180 },
      'EPSG:4326'
    ),
    zarrStore: {
      describe: () => ({
        dimensions: ['lat', 'lon'],
        coordinates: {},
        dimIndices,
        scaleFactor: 1,
        addOffset: 0,
        fill_value: null,
      }),
    },
  })
  return self
}

const point = (lon, lat = 10) => ({ type: 'Point', coordinates: [lon, lat] })
const rect = (west, east, south = -30, north = 30) => ({
  type: 'Polygon',
  coordinates: [
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ],
})

// The store's lon for a query lon in [-180, 180)
const storeLon = (lon, lon360) => (lon360 && lon < 0 ? lon + 360 : lon)

// Sampled store lon (the cell value) at each returned point, mapped back to
// [-180, 180), next to the returned coordinate lon
function sampled(result) {
  return result.v.map((v, i) => ({
    value: v > 180 ? v - 360 : v,
    lon: result.coordinates.lon[i],
  }))
}

for (const lon360 of [true, false]) {
  const label = lon360 ? '0-360' : '-180..180'

  test(`${label}: point queries sample the queried lon in both hemispheres`, async () => {
    const m = await mode({ lon360 })
    for (const lon of [-179.5, -105.2, -0.5, 0.5, 75.3, 179.5]) {
      const result = await m.queryData(point(lon))
      assert.equal(result.v.length, 1, `lon ${lon}`)
      const want = Math.floor(storeLon(lon, lon360)) + 0.5
      assert.equal(result.v[0], want, `lon ${lon}: sampled ${result.v[0]}`)
      assert.ok(
        Math.abs(result.coordinates.lon[0] - lon) <= 0.5,
        `lon ${lon}: coordinate ${result.coordinates.lon[0]}`
      )
    }
  })

  test(`${label}: bbox straddling lon 0 returns every column, values matching coords`, async () => {
    const m = await mode({ lon360 })
    const result = await m.queryData(rect(-3, 3))
    const pts = sampled(result)
    const lons = [...new Set(pts.map((p) => p.value))].sort((a, b) => a - b)
    assert.deepEqual(lons, [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5])
    for (const p of pts) assert.ok(Math.abs(p.value - p.lon) < 1e-6)
  })

  test(`${label}: bbox crossing the antimeridian returns both sides`, async () => {
    const m = await mode({ lon360 })
    const result = await m.queryData(rect(177, 183))
    const pts = sampled(result)
    const lons = [...new Set(pts.map((p) => p.value))].sort((a, b) => a - b)
    assert.deepEqual(lons, [-179.5, -178.5, -177.5, 177.5, 178.5, 179.5])
    for (const p of pts) assert.ok(Math.abs(p.value - p.lon) < 1e-6)
  })
}

test('0-360: bbox within one hemisphere fetches a single contiguous strip', async () => {
  const m = await mode({ lon360: true })
  const slices = []
  const fetch = m.fetchQueryData
  m.fetchQueryData = function (sel, bounds, signal) {
    slices.push([bounds.minX, bounds.maxX])
    return fetch.call(this, sel, bounds, signal)
  }
  const result = await m.queryData(rect(-110, -100))
  assert.deepEqual(slices, [[250, 260]])
  for (const p of sampled(result)) assert.ok(Math.abs(p.value - p.lon) < 1e-6)
  slices.length = 0
  await m.queryData(rect(-3, 3))
  assert.deepEqual(slices, [
    [357, 360],
    [0, 3],
  ])
})
