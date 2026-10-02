export const DEFAULT_TILE_SIZE = 128
export const MAX_CACHED_TILES = 64
export const TILE_SUBDIVISIONS = 32
export const MERCATOR_LAT_LIMIT = 85.05112878

/** Default maximum error threshold for adaptive mesh refinement (in pixels) */
export const DEFAULT_MESH_MAX_ERROR = 0.125

/** Default maximum error for query polygon edge densification (in pixels) */
export const DEFAULT_QUERY_DENSIFY_MAX_ERROR = DEFAULT_MESH_MAX_ERROR

/** Minimum subdivisions for region geometry tessellation (globe projection) */
export const MIN_SUBDIVISIONS = 2

/** Maximum subdivisions for region geometry tessellation (globe projection) */
export const MAX_SUBDIVISIONS = 128

/** Subdivisions for flat/mercator projection (simple quad, no curvature needed) */
export const MERCATOR_SUBDIVISIONS = 1

/** Web Mercator world extent in meters (half of full world width) */
export const WEB_MERCATOR_EXTENT = 20037508.342789244

/**
 * Number of most recent completed prefetch steps the per-step byte estimate
 * averages over (ZarrLayer.getEstimatedTimestepBytes), so it follows a
 * change of view (zoom level, visible regions) within a few prefetch rounds.
 */
export const ESTIMATE_RECENT_STEPS = 16

/**
 * Window refill (ZarrLayer): how long after the prefetch queue goes idle, or
 * after an in-window cache entry is evicted while it is idle, the layer
 * checks the last prefetch window for steps that are no longer cached.
 */
export const WINDOW_REFILL_DELAY_MS = 500

/**
 * Most refills of one prefetch window (per `prefetchTimeSteps` call), so a
 * window whose steps keep getting evicted (an estimate that was off) can't
 * loop. Failed steps are never refilled: the prefetch queue retries them.
 */
export const MAX_WINDOW_REFILLS = 2

/**
 * Eviction tiers ZarrLayer gives its CachingStore (higher = kept longer).
 * Window keys use [EVICTION_TIER_WINDOW, EVICTION_TIER_DISPLAYED), nearer
 * steps higher.
 */
export const EVICTION_TIER_OTHER = 0
export const EVICTION_TIER_WINDOW = 1
export const EVICTION_TIER_DISPLAYED = 2

/** Common names for spatial dimensions. These are matched case-insensitively. */
export const SPATIAL_DIMENSION_ALIASES: Record<'lat' | 'lon', string[]> = {
  lat: ['lat', 'latitude', 'y'],
  lon: ['lon', 'longitude', 'x', 'lng'],
}

/** Flat set of all spatial dimension names */
export const SPATIAL_DIM_NAMES = new Set([
  ...SPATIAL_DIMENSION_ALIASES.lat,
  ...SPATIAL_DIMENSION_ALIASES.lon,
])
