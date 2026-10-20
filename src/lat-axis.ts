/**
 * @module lat-axis
 *
 * Row <-> latitude mapping for EPSG:4326 grids whose latitude spacing is not
 * uniform (e.g. a grid with wider rows near the poles). Elsewhere the layer
 * maps rows to latitudes linearly between the outer bounds; for such grids
 * that places rows up to many cells away from their coordinates.
 *
 * Edges are kept in array row order: edges[i] is the edge between rows i-1
 * and i, so edges[0] and edges[height] are the outer edges. They ascend when
 * latIsAscending and descend otherwise.
 *
 * Rendering uses the edges only at region (chunk) boundaries: within a
 * region the shader still maps latitude to rows linearly. That is exact where
 * a region's rows are evenly spaced, so it helps only data chunked along lat;
 * a single chunk spanning every row renders as before (queries still use the
 * edges).
 */

/**
 * Largest deviation from a linear row -> latitude mapping, in cells, at which
 * a grid is still treated as uniform (and keeps the linear mapping).
 */
export const LAT_UNIFORM_TOLERANCE_CELLS = 0.1

/**
 * Row-edge latitudes from cell-center latitudes: midpoints between centers,
 * and each outer edge half its own row's spacing beyond the outer center.
 */
export function latEdgesFromCenters(centers: ArrayLike<number>): Float64Array {
  const n = centers.length
  const edges = new Float64Array(n + 1)
  if (n === 0) return edges
  if (n === 1) {
    edges[0] = centers[0]
    edges[1] = centers[0]
    return edges
  }
  for (let i = 1; i < n; i++) edges[i] = (centers[i - 1] + centers[i]) / 2
  edges[0] = centers[0] - (centers[1] - centers[0]) / 2
  edges[n] = centers[n - 1] + (centers[n - 1] - centers[n - 2]) / 2
  return edges
}

/**
 * Whether edges are close enough to evenly spaced that a linear mapping
 * between the outer edges is within LAT_UNIFORM_TOLERANCE_CELLS everywhere.
 */
export function latEdgesAreUniform(edges: ArrayLike<number>): boolean {
  const n = edges.length - 1
  if (n < 2) return true
  const first = edges[0]
  const step = (edges[n] - first) / n
  if (step === 0 || !Number.isFinite(step)) return true
  let worst = 0
  for (let i = 1; i < n; i++) {
    const dev = Math.abs((edges[i] - first) / step - i)
    if (dev > worst) worst = dev
  }
  return worst <= LAT_UNIFORM_TOLERANCE_CELLS
}

/**
 * Latitude at a fractional edge-based row (row 0 = edges[0], row n = edges[n]),
 * interpolated linearly within a row. Clamps to the outer edges.
 */
export function rowToLat(edges: ArrayLike<number>, row: number): number {
  const n = edges.length - 1
  if (row <= 0) return edges[0]
  if (row >= n) return edges[n]
  const i = Math.floor(row)
  return edges[i] + (row - i) * (edges[i + 1] - edges[i])
}

/**
 * Fractional edge-based row of a latitude (inverse of rowToLat). Clamps to
 * [0, n] outside the outer edges.
 */
export function latToRow(edges: ArrayLike<number>, lat: number): number {
  const n = edges.length - 1
  if (n < 1) return 0
  const ascending = edges[n] >= edges[0]
  // Position along the axis in increasing-row direction
  const s = ascending ? lat : -lat
  const at = (i: number) => (ascending ? edges[i] : -edges[i])
  if (s <= at(0)) return 0
  if (s >= at(n)) return n
  let lo = 0
  let hi = n
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (at(mid) <= s) lo = mid
    else hi = mid
  }
  const span = at(hi) - at(lo)
  return span === 0 ? lo : lo + (s - at(lo)) / span
}

/**
 * Latitude of a fraction [0, 1] of the rows (0 = row 0's outer edge), using
 * edges when present and a linear mapping between latMin/latMax otherwise.
 */
export function yFracToLat(
  yFrac: number,
  latMin: number,
  latMax: number,
  latIsAscending: boolean | undefined,
  edges?: ArrayLike<number> | null
): number {
  if (edges && edges.length > 1) {
    return rowToLat(edges, yFrac * (edges.length - 1))
  }
  return latIsAscending
    ? latMin + yFrac * (latMax - latMin)
    : latMax - yFrac * (latMax - latMin)
}

/**
 * Fraction [0, 1] of the rows at a latitude (inverse of yFracToLat). Without
 * edges it is unclamped, like the linear mapping it replaces; with edges it
 * extrapolates linearly from the outer edges' spacing.
 */
export function latToYFrac(
  lat: number,
  latMin: number,
  latMax: number,
  latIsAscending: boolean | undefined,
  edges?: ArrayLike<number> | null
): number {
  if (edges && edges.length > 1) {
    const n = edges.length - 1
    const row = latToRow(edges, lat)
    // Outside the axis: continue at the outer rows' spacing, so geometry
    // vertices beyond the raster keep their (out-of-range) positions
    if (row === 0 && lat !== edges[0]) {
      const step = edges[1] - edges[0]
      if (step !== 0) return (lat - edges[0]) / step / n
    } else if (row === n && lat !== edges[n]) {
      const step = edges[n] - edges[n - 1]
      if (step !== 0) return (n + (lat - edges[n]) / step) / n
    }
    return row / n
  }
  const latRange = latMax - latMin
  return latIsAscending ? (lat - latMin) / latRange : (latMax - lat) / latRange
}
