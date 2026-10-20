// Non-uniform latitude spacing (ace-viz: X-SHiELD 3 km rows are 0.0312° apart
// except 32 rows at each pole, 0.0393° apart). Rows used to be placed linearly
// between the outer edges, drawing mid-latitude rows up to ~0.13° poleward of
// their coordinates. With a non-uniform axis the store keeps its row edges and
// region bounds and queries map rows <-> latitudes through them. Run: npm test
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import * as zarr from 'zarrita'
import { loadSrc } from './load-src.mjs'
import { buildFakeV3Store, fakeFetch } from './fake-v3-store.mjs'

const { latEdgesFromCenters, latEdgesAreUniform, latToRow, rowToLat } =
  await loadSrc('src/lat-axis.ts')
const { ZarrStore } = await loadSrc('src/zarr-store.ts')
const { UntiledMode } = await loadSrc('src/untiled-mode.ts')
const { boundsToMercatorNorm } = await loadSrc('src/map-utils.ts')

beforeEach((t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
})

// Global ascending centers: `cap` rows of `capStep` at each pole, the rest
// evenly spaced in between
function cappedAxis(n, cap, capStep) {
  const step = (180 - 2 * cap * capStep) / (n - 2 * cap)
  const edges = [-90]
  for (let i = 0; i < n; i++) {
    const s = i < cap || i >= n - cap ? capStep : step
    edges.push(edges[i] + s)
  }
  return edges.slice(0, n).map((e, i) => (e + edges[i + 1]) / 2)
}

const close = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`)

// Returned coordinates are row-edge midpoints. Edges come from midpoints of
// centers, so on a row where the spacing changes the midpoint is off its
// center by a small fraction of a cell (0.23° of 5.5° in this fixture).
const COORD_TOL = 0.25

test('uniform and near-uniform axes keep the linear mapping', () => {
  const oneDeg = Array.from({ length: 180 }, (_, i) => -89.5 + i)
  assert.equal(latEdgesAreUniform(latEdgesFromCenters(oneDeg)), true)
  // Small Gaussian-grid-like wobble (0.02 cell) is still uniform
  const wobbly = oneDeg.map((v, i) => v + 0.02 * Math.sin(i / 7))
  assert.equal(latEdgesAreUniform(latEdgesFromCenters(wobbly)), true)
})

test('X-SHiELD 3 km axis is non-uniform; its edges span ±90', () => {
  const lat = cappedAxis(5760, 32, 0.039307)
  const edges = latEdgesFromCenters(lat)
  assert.equal(latEdgesAreUniform(edges), false)
  close(edges[0], -90, 1e-9)
  close(edges[5760], 90, 1e-9)
})

test('latToRow inverts rowToLat, ascending and descending', () => {
  const asc = latEdgesFromCenters(cappedAxis(40, 4, 6))
  const desc = Float64Array.from(asc).reverse()
  for (const edges of [asc, desc]) {
    for (const row of [0, 0.25, 3.9, 4, 17.5, 36.2, 40]) {
      close(latToRow(edges, rowToLat(edges, row)), row, 1e-9, `row ${row}`)
    }
  }
  // Clamps outside the axis
  assert.equal(latToRow(asc, -95), 0)
  assert.equal(latToRow(asc, 95), 40)
  assert.equal(latToRow(desc, 95), 0)
})

async function describeStore(t, latitude) {
  const { base, objects } = buildFakeV3Store({ latitude })
  const server = fakeFetch(base, objects)
  t.mock.method(globalThis, 'fetch', server.fetch)
  const store = new ZarrStore({ source: base, variable: 'v', version: 3 })
  let done = false
  store.initialized.finally(() => (done = true))
  while (!done) {
    await new Promise((r) => setTimeout(r, 0))
    server.wave()
  }
  return (await store.initialized).describe()
}

test('store: uniform latitude keeps its bounds and has no edges', async (t) => {
  const desc = await describeStore(t)
  assert.equal(desc.latEdges, null)
  assert.equal(desc.xyLimits.yMin, -60)
  assert.equal(desc.xyLimits.yMax, 60)
})

test('store: non-uniform latitude exposes row edges and bounds from them', async (t) => {
  // Edges -90, -70, -40, 0, 40, 70, 90
  const desc = await describeStore(t, [-80, -60, -20, 20, 60, 80])
  assert.deepEqual([...desc.latEdges], [-90, -70, -40, 0, 40, 70, 90])
  assert.equal(desc.xyLimits.yMin, -90)
  assert.equal(desc.xyLimits.yMax, 90)
})

// Fake untiled `this` over a [lat, lon] array whose cells hold their row's
// center latitude, on a capped (non-uniform) ascending or descending axis
const N_LAT = 40
const WIDTH = 8 // 45° columns
async function mode({ ascending = true, withEdges = true } = {}) {
  let lat = cappedAxis(N_LAT, 4, 6)
  if (!ascending) lat = lat.reverse()
  const arr = await zarr.create(zarr.root(new Map()).resolve('v'), {
    shape: [N_LAT, WIDTH],
    chunkShape: [10, WIDTH],
    dtype: 'float64',
  })
  const data = new Float64Array(N_LAT * WIDTH)
  for (let y = 0; y < N_LAT; y++)
    for (let x = 0; x < WIDTH; x++) data[y * WIDTH + x] = lat[y]
  await zarr.set(arr, null, { data, shape: [N_LAT, WIDTH], stride: [WIDTH, 1] })

  const latEdges = withEdges ? latEdgesFromCenters(lat) : null
  const xyLimits = { xMin: -180, xMax: 180, yMin: -90, yMax: 90 }
  const mercatorBounds = boundsToMercatorNorm(xyLimits, 'EPSG:4326')
  if (latEdges) mercatorBounds.latEdges = latEdges
  const dimIndices = {
    lat: { name: 'lat', index: 0, array: null },
    lon: { name: 'lon', index: 1, array: null },
  }
  const self = Object.create(UntiledMode.prototype)
  Object.assign(self, {
    variable: 'v',
    selector: {},
    zarrArray: arr,
    dimIndices,
    xyLimits,
    width: WIDTH,
    height: N_LAT,
    regionSize: [10, WIDTH],
    crs: 'EPSG:4326',
    latIsAscending: ascending,
    latEdges,
    lon360Wrap: false,
    proj4def: null,
    cachedWGS84Transformer: null,
    levels: [],
    currentLevelIndex: -1,
    dimensionValues: {},
    _antimeridianWarnings: new Set(),
    mercatorBounds,
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
  return { m: self, lat, latEdges }
}

for (const ascending of [true, false]) {
  const label = ascending ? 'ascending' : 'descending'

  test(`${label}: region bounds are the regions' true row edges`, async () => {
    const { m, latEdges } = await mode({ ascending })
    for (let ry = 0; ry < N_LAT / 10; ry++) {
      const b = m.getRegionBounds(0, ry)
      const a = latEdges[ry * 10]
      const z = latEdges[ry * 10 + 10]
      close(b.yMin, Math.min(a, z), 1e-9, `region ${ry} yMin`)
      close(b.yMax, Math.max(a, z), 1e-9, `region ${ry} yMax`)
    }
  })

  test(`${label}: visible regions follow the row edges`, async () => {
    const { m, latEdges } = await mode({ ascending })
    // A viewport just inside the region holding rows 30-39 (ascending)
    const r = ascending ? 3 : 0
    const lo = Math.min(latEdges[r * 10], latEdges[r * 10 + 10]) + 0.01
    const hi = Math.max(latEdges[r * 10], latEdges[r * 10 + 10]) - 0.01
    const map = {
      getBounds: () => ({
        toArray: () => [
          [-10, lo],
          [10, hi],
        ],
      }),
    }
    const ys = [...new Set(m.getVisibleRegions(map).map((v) => v.regionY))]
    assert.deepEqual(ys, [r])
  })

  test(`${label}: point queries sample the row whose cell holds the lat`, async () => {
    const { m, lat } = await mode({ ascending })
    for (let row = 0; row < N_LAT; row++) {
      const result = await m.queryData({
        type: 'Point',
        coordinates: [5, lat[row]],
      })
      assert.equal(result.v.length, 1, `row ${row}`)
      assert.equal(result.v[0], lat[row], `row ${row}: sampled ${result.v[0]}`)
      close(result.coordinates.lat[0], lat[row], COORD_TOL, `row ${row} coord`)
    }
  })

  test(`${label}: bbox query values lie in the box and match their coords`, async () => {
    const { m } = await mode({ ascending })
    const rect = (s, n) => ({
      type: 'Polygon',
      coordinates: [
        [
          [-50, s],
          [50, s],
          [50, n],
          [-50, n],
          [-50, s],
        ],
      ],
    })
    const result = await m.queryData(rect(30, 70))
    assert.ok(result.v.length > 0)
    for (let i = 0; i < result.v.length; i++) {
      close(result.coordinates.lat[i], result.v[i], COORD_TOL, `point ${i}`)
      assert.ok(result.v[i] >= 30 && result.v[i] <= 70, `value ${result.v[i]}`)
    }
  })
}

test('without edges (old mapping) the same axis samples the wrong rows', async () => {
  const { m, lat } = await mode({ withEdges: false })
  let wrong = 0
  for (let row = 0; row < N_LAT; row++) {
    const result = await m.queryData({
      type: 'Point',
      coordinates: [5, lat[row]],
    })
    if (result.v[0] !== lat[row]) wrong++
  }
  assert.ok(wrong > 0, 'the fixture should exercise non-uniform spacing')
})
