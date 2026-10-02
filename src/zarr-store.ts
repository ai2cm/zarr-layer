import * as zarr from 'zarrita'
import type {
  AbsolutePath,
  Readable,
  AsyncReadable,
  GetOptions,
} from '@zarrita/storage'
import {
  CachingStore,
  DEFAULT_CHUNK_CACHE_BYTES,
  RangeIgnoredError,
  RangeNotSatisfiableError,
  RangeRateLimitedError,
  validCacheBytes,
} from './caching-store'
import { withRangeCoalescing } from './range-coalescing'
import { gatedFetch } from './request-gate'
import type {
  Bounds,
  SpatialDimensions,
  DimIndicesProps,
  CRS,
  UntiledLevel,
  TransformRequest,
} from './types'
import type { XYLimits } from './map-utils'
import { DEFAULT_TILE_SIZE } from './constants'
import { identifyDimensionIndices, resolveOpenFunc } from './zarr-utils'

interface PyramidMetadata {
  levels: string[]
  maxLevelIndex: number
  tileSize: number
  crs: CRS
}

interface MultiscaleDataset {
  path: string
  pixels_per_tile?: number
  crs?: string
}

interface Multiscale {
  datasets: MultiscaleDataset[]
}

// zarr-conventions/multiscales format (untiled multiscales)
interface UntiledMultiscaleLayoutEntry {
  asset: string
  transform?: {
    scale?: [number, number]
    translation?: [number, number]
  }
  derived_from?: string
}

interface UntiledMultiscaleMetadata {
  layout: UntiledMultiscaleLayoutEntry[]
  resampling_method?: string
  crs?: 'EPSG:4326' | 'EPSG:3857'
}

type ZarrStoreType =
  | zarr.FetchStore
  | zarr.Listable<zarr.FetchStore>
  | CachingStore
  | Readable
  | AsyncReadable

interface ZarrStoreOptions {
  /** URL to Zarr store. Required unless customStore is provided. */
  source?: string
  version?: 2 | 3 | null
  variable: string
  spatialDimensions?: SpatialDimensions
  bounds?: Bounds
  crs?: string
  coordinateKeys?: string[]
  latIsAscending?: boolean | null
  proj4?: string
  transformRequest?: TransformRequest
  /** Custom store to use instead of FetchStore. When provided, source becomes optional. */
  customStore?: Readable | AsyncReadable
  /**
   * Maximum bytes for chunk cache. Set to 0 to disable caching. Default:
   * 100 MB. Fractions are floored; an invalid value (non-finite or negative)
   * falls back to the default with a warning.
   */
  maxChunkCacheBytes?: number
  /**
   * Internal: whether to wrap the store in a CachingStore, independent of the
   * current budget (a live layer may have resized its budget to 0 and must
   * keep an empty cache across reinitialization). Defaults to
   * `maxChunkCacheBytes > 0`.
   */
  chunkCacheEnabled?: boolean
  /**
   * Read byte ranges with range requests through the chunk cache (see
   * `CachingStore` range mode and `ZarrLayerOptions.rangeRequests`).
   * Default false.
   */
  rangeRequests?: boolean
  /**
   * Background classifier for the CachingStore (see
   * `CachingStore.setBackgroundClassifier`), installed as soon as it is
   * created, so metadata and coordinate reads made during initialization
   * are classified too.
   */
  backgroundClassifier?: (opts?: GetOptions) => boolean
  /**
   * Store objects the caller already read (or is reading), by key relative
   * to the store root: e.g. the root `zarr.json` and coordinate chunks such
   * as `time/c/0`. Reads of these keys use them instead of the network (see
   * `withPreloadedObjects`). A root `zarr.json` with `zarr_format: 3` also
   * sets `version` to 3 when it is not given, so no v2 key is probed.
   */
  preloadedObjects?: PreloadedObjects
}

/**
 * Store objects by key relative to the store root (`zarr.json`,
 * `time/c/0`): their bytes, `undefined` for an object known to be missing,
 * or a promise of either (a read still in flight).
 */
export type PreloadedObjects = Record<
  string,
  Uint8Array | undefined | Promise<Uint8Array | undefined>
>

/** `zarr.json` -> `/zarr.json` (store keys are absolute paths). */
const absoluteKey = (key: string): AbsolutePath =>
  `/${key.replace(/^\/+/, '')}` as AbsolutePath

/**
 * Wrap a store so reads of preloaded keys are served from `preloaded`
 * (absolute keys) instead of the base store. A preloaded read that rejects
 * falls back to the base store. Ranges of a preloaded object are sliced
 * from it. The map is live: keys added later are used too.
 */
export function withPreloadedObjects<S extends AsyncReadable>(
  store: S,
  preloaded: Map<
    AbsolutePath,
    Uint8Array | undefined | Promise<Uint8Array | undefined>
  >
): AsyncReadable {
  const preloadedBytes = async (
    key: AbsolutePath
  ): Promise<{ hit: boolean; bytes?: Uint8Array }> => {
    if (!preloaded.has(key)) return { hit: false }
    try {
      return { hit: true, bytes: await preloaded.get(key) }
    } catch {
      // The caller's read failed: read it ourselves
      preloaded.delete(key)
      return { hit: false }
    }
  }
  const wrapped: AsyncReadable = {
    async get(key, opts) {
      const { hit, bytes } = await preloadedBytes(key)
      return hit ? bytes : store.get(key, opts)
    },
  }
  if (typeof store.getRange === 'function') {
    wrapped.getRange = async (key, range, opts) => {
      const { hit, bytes } = await preloadedBytes(key)
      if (!hit) return store.getRange!(key, range, opts)
      if (!bytes) return undefined
      return 'suffixLength' in range
        ? bytes.slice(Math.max(0, bytes.length - range.suffixLength))
        : bytes.slice(range.offset, range.offset + range.length)
    }
  }
  return wrapped
}

/** The `zarr_format` of a preloaded root `zarr.json`, if it is readable now. */
function preloadedZarrFormat(preloaded?: PreloadedObjects): number | null {
  const bytes = preloaded?.['zarr.json'] ?? preloaded?.['/zarr.json']
  if (!(bytes instanceof Uint8Array)) return null
  try {
    const format = JSON.parse(new TextDecoder().decode(bytes))?.zarr_format
    return typeof format === 'number' ? format : null
  } catch {
    return null
  }
}

interface StoreDescription {
  dimensions: string[]
  shape: number[]
  chunks: number[]
  fill_value: number | null
  dtype: string | null
  levels: string[]
  maxLevelIndex: number
  tileSize: number
  crs: CRS
  multiscaleType: 'tiled' | 'untiled' | 'none'
  untiledLevels: UntiledLevel[]
  dimIndices: DimIndicesProps
  xyLimits: XYLimits | null
  scaleFactor: number
  addOffset: number
  coordinates: Record<string, (string | number)[]>
  latIsAscending: boolean
  lon360Wrap: boolean
  proj4: string | null
}

/**
 * A fetch that applies `transformRequest` to each request, with the fully
 * resolved URL. This enables per-path authentication like presigned S3 URLs.
 */
const transformedFetch =
  (transformRequest: TransformRequest) =>
  async (request: Request): Promise<Response> => {
    const { url: transformedUrl, ...overrides } = await transformRequest(
      request.url,
      { method: request.method as 'GET' | 'HEAD' }
    )
    const mergedHeaders = new Headers(request.headers)
    if (overrides.headers) {
      for (const [k, v] of Object.entries(
        overrides.headers as Record<string, string>
      )) {
        mergedHeaders.set(k, v)
      }
    }
    // Use `request` as the base init so signal/body/credentials/etc. carry
    // over (Request's own properties aren't spread-friendly), then overlay
    // transformRequest overrides with merged headers last.
    const response = await fetch(
      new Request(new Request(transformedUrl, request), {
        ...overrides,
        headers: mergedHeaders,
      })
    )
    // Remap 403 to 404 for S3/CloudFront compatibility: these services
    // return 403 (not 404) for missing or inaccessible paths.
    if (response.status === 403) {
      return new Response(null, { status: 404 })
    }
    return response
  }

/**
 * Wrap a fetch so a Range request that did not get a 206 is reported
 * instead of passed through: FetchStore would hand the whole body of a 200
 * back as if it were the range. A 200 throws `RangeIgnoredError` with the
 * body (the CachingStore keeps it as the whole object), a 416 throws
 * `RangeNotSatisfiableError`, a 429 `RangeRateLimitedError`. Requests
 * without a Range header pass through.
 * A network-level failure (TypeError) passes through: the caller treats it
 * as a dropout (a CORS refusal of Range can't be told from a blip).
 */
export const checkRangeResponses =
  (inner: (request: Request) => Promise<Response>) =>
  async (request: Request): Promise<Response> => {
    const response = await inner(request)
    if (!request.headers.has('Range')) return response
    if (response.status === 200) {
      // Kept even when bigger than the cache budget: this is exactly what
      // whole-object mode downloads and keeps (the most recent entry is
      // retained over budget), and dropping it would re-download the object
      // for each of its inner chunks. A Range-dropping hop degrades to
      // whole-object mode rather than failing (ace-viz task 46).
      const body = new Uint8Array(await response.arrayBuffer())
      throw new RangeIgnoredError(request.url, body)
    }
    if (response.status === 416 || response.status === 429) {
      // Drain, so the connection can be reused
      await response.body?.cancel().catch(() => {})
      throw response.status === 416
        ? new RangeNotSatisfiableError(request.url)
        : new RangeRateLimitedError(request.url)
    }
    return response
  }

/**
 * Factory function to create a store with optional request transformation.
 * When transformRequest is provided, uses FetchStore's native fetch handler
 * to intercept each request with the fully resolved URL.
 *
 * With `rangeRequests`, suffix ranges (shard indexes) are one `bytes=-N`
 * request instead of a HEAD plus a range, and range responses are checked
 * (see `checkRangeResponses`). Every request goes through its origin's
 * `RequestGate` (`gatedFetch`): an optional rate cap, and a 429 is retried
 * after a backoff instead of failing (ace-viz task 44).
 */
export const createFetchStore = (
  url: string,
  transformRequest?: TransformRequest,
  rangeRequests: boolean = false
): zarr.FetchStore => {
  // Every request goes through its origin's gate (rate cap, 429 backoff;
  // see request-gate.ts), under the Range checks so a 429 is retried there
  const inner = gatedFetch(
    transformRequest
      ? transformedFetch(transformRequest)
      : (request: Request) => fetch(request)
  )
  if (rangeRequests) {
    return new zarr.FetchStore(url, {
      useSuffixRequest: true,
      fetch: checkRangeResponses(inner),
    })
  }
  return new zarr.FetchStore(url, { fetch: inner })
}

/**
 * The shard shape of a sharded zarr v3 array (its `chunk_grid` chunk shape
 * when a `sharding_indexed` codec is present), or null: not sharded, not
 * v3, or unreadable. zarrita does not expose it (`array.chunks` is the inner
 * chunk shape). The array's zarr.json was just read to open it, so this is
 * served from consolidated metadata or the chunk cache.
 */
export async function readShardShape(
  store: { get(key: AbsolutePath): Promise<Uint8Array | undefined> },
  arrayPath: string
): Promise<number[] | null> {
  try {
    const path = arrayPath.replace(/^\/+/, '')
    const bytes = await store.get(`/${path}/zarr.json` as AbsolutePath)
    if (!bytes) return null
    const meta = JSON.parse(new TextDecoder().decode(bytes))
    const codecs = Array.isArray(meta?.codecs) ? meta.codecs : []
    if (
      !codecs.some((c: { name?: string }) => c?.name === 'sharding_indexed')
    ) {
      return null
    }
    const shape = meta?.chunk_grid?.configuration?.chunk_shape
    return Array.isArray(shape) && shape.every(Number.isInteger) ? shape : null
  } catch {
    return null
  }
}

interface CachedStore {
  store: Promise<ZarrStoreType>
  /** The preloaded objects its base store serves (see withPreloadedObjects). */
  preloaded: Map<
    AbsolutePath,
    Uint8Array | undefined | Promise<Uint8Array | undefined>
  >
}

export class ZarrStore {
  private static _storeCache = new Map<string, CachedStore>()

  source: string
  version: 2 | 3 | null
  variable: string
  spatialDimensions: SpatialDimensions
  private explicitBounds: Bounds | null
  coordinateKeys: string[]
  private transformRequest?: TransformRequest
  private customStore?: Readable | AsyncReadable

  dimensions: string[] = []
  shape: number[] = []
  chunks: number[] = []
  /**
   * Outer (shard) chunk shape of a sharded v3 array, read in range mode only
   * (for prefetch shard batches, ace-viz task 44); null otherwise.
   */
  shards: number[] | null = null
  fill_value: number | null = null
  dtype: string | null = null
  levels: string[] = []
  maxLevelIndex: number = 0
  tileSize: number = DEFAULT_TILE_SIZE
  crs: CRS = 'EPSG:4326'
  multiscaleType: 'tiled' | 'untiled' | 'none' = 'none'
  untiledLevels: UntiledLevel[] = []
  dimIndices: DimIndicesProps = {}
  xyLimits: XYLimits | null = null
  scaleFactor: number = 1
  addOffset: number = 0
  coordinates: Record<string, (string | number)[]> = {}
  latIsAscending: boolean = true // Default: row 0 = south; overridden by detection
  lon360Wrap: boolean = false // True when data uses 0-360 longitude convention
  private _latIsAscendingUserSet: boolean = false
  proj4: string | null = null
  private _crsFromMetadata: boolean = false // Track if CRS was explicitly set from metadata
  private _crsOverride: boolean = false // Track if CRS was explicitly set by user
  private maxChunkCacheBytes: number = DEFAULT_CHUNK_CACHE_BYTES
  private chunkCacheEnabled: boolean
  private rangeRequests: boolean
  private backgroundClassifier: ((opts?: GetOptions) => boolean) | null
  /** The caching store wrapper, if chunk caching is enabled. */
  cachingStore: CachingStore | null = null

  /**
   * Returns the coarsest (lowest resolution) level path.
   * - Tiled pyramids: level 0 is coarsest
   * - Untiled multiscale: last level (maxLevelIndex) is coarsest
   */
  get coarsestLevel(): string | undefined {
    if (this.levels.length === 0) return undefined
    return this.multiscaleType === 'untiled'
      ? this.levels[this.maxLevelIndex]
      : this.levels[0]
  }

  store: ZarrStoreType | null = null
  root: zarr.Location<ZarrStoreType> | null = null
  private _arrayHandles = new Map<
    string,
    Promise<zarr.Array<zarr.DataType, Readable>>
  >()

  initialized: Promise<this>
  /**
   * Resolves once the root group and the variable's array metadata are read
   * (dimensions, shape, chunks, levels), before the coordinate reads that
   * `initialized` also waits for; rejects if initialization fails first.
   * Lets a caller start reads that only need the array metadata (e.g.
   * `prefetchShardIndexes`) concurrently with the coordinates.
   */
  metadataReady: Promise<this>
  private _resolveMetadata!: (store: this) => void
  private preloadedObjects?: PreloadedObjects

  constructor({
    source,
    version = null,
    variable,
    spatialDimensions = {},
    bounds,
    crs,
    coordinateKeys = [],
    latIsAscending = null,
    proj4,
    transformRequest,
    customStore,
    maxChunkCacheBytes,
    chunkCacheEnabled,
    rangeRequests = false,
    backgroundClassifier,
    preloadedObjects,
  }: ZarrStoreOptions) {
    if (!source && !customStore) {
      throw new Error('source is required when customStore is not provided')
    }
    if (!variable) {
      throw new Error('variable is a required parameter')
    }
    this.source = source ?? 'custom-store'
    // A preloaded root zarr.json tells the format: open only that one
    // (zarrita's auto-detection probes v2 keys first on a fresh store)
    const preloadedFormat = preloadedZarrFormat(preloadedObjects)
    this.version =
      version ?? (preloadedFormat === 3 ? 3 : preloadedFormat === 2 ? 2 : null)
    this.preloadedObjects = preloadedObjects
    this.variable = variable
    this.spatialDimensions = spatialDimensions
    this.explicitBounds = bounds ?? null
    this.coordinateKeys = coordinateKeys
    if (latIsAscending !== null) {
      this.latIsAscending = latIsAscending
      this._latIsAscendingUserSet = true
    }
    this.proj4 = proj4 ?? null
    if (crs) {
      const normalized = crs.toUpperCase()
      if (normalized === 'EPSG:4326' || normalized === 'EPSG:3857') {
        this.crs = normalized
        this._crsOverride = true
      } else if (!this.proj4) {
        console.warn(
          `[zarr-layer] CRS "${crs}" requires 'proj4' to render correctly. ` +
            `Falling back to inferred CRS.`
        )
      }
    }
    this.transformRequest = transformRequest
    this.customStore = customStore
    if (maxChunkCacheBytes !== undefined) {
      const valid = validCacheBytes(maxChunkCacheBytes)
      if (valid === null) {
        console.warn(
          `[zarr-layer] Invalid maxChunkCacheBytes ${maxChunkCacheBytes}; ` +
            `using the default of ${DEFAULT_CHUNK_CACHE_BYTES} bytes.`
        )
      } else {
        this.maxChunkCacheBytes = valid
      }
    }
    this.chunkCacheEnabled = chunkCacheEnabled ?? this.maxChunkCacheBytes > 0
    // Range mode lives in the chunk cache; without one, zarrita already
    // reads ranges straight from the base store
    this.rangeRequests = rangeRequests && this.chunkCacheEnabled
    this.backgroundClassifier = backgroundClassifier ?? null

    let rejectMetadata!: (err: unknown) => void
    this.metadataReady = new Promise<this>((resolve, reject) => {
      this._resolveMetadata = resolve
      rejectMetadata = reject
    })
    // Not every caller waits on it; `initialized` reports the same error
    this.metadataReady.catch(() => {})
    this.initialized = this._initialize()
    this.initialized.catch(rejectMetadata)
  }

  private async _initialize(): Promise<this> {
    // Range mode builds a different base store (see createFetchStore)
    const storeCacheKey = `${this.source}:${this.version ?? 'auto'}${
      this.rangeRequests ? ':range' : ''
    }`

    if (this.customStore) {
      // Validate that custom store implements required Readable interface
      if (typeof this.customStore.get !== 'function') {
        throw new Error(
          'customStore must implement Readable interface with get() method'
        )
      }
      // Use custom store directly (e.g., IcechunkStore)
      this.store = this.customStore as ZarrStoreType
    } else {
      const bypassCache = !!this.transformRequest
      let cached = bypassCache
        ? undefined
        : ZarrStore._storeCache.get(storeCacheKey)

      if (cached) {
        // A store opened by an earlier layer: its base store serves this
        // layer's preloaded objects too. Newer ones replace older ones (the
        // app may have re-read the store), so this layer's chunk cache,
        // empty so far, reads the fresh bytes. The root zarr.json is the
        // exception: the opened store parsed its consolidated metadata once.
        for (const [key, value] of Object.entries(
          this.preloadedObjects ?? {}
        )) {
          cached.preloaded.set(absoluteKey(key), value)
        }
      } else {
        const preloaded: CachedStore['preloaded'] = new Map()
        for (const [key, value] of Object.entries(
          this.preloadedObjects ?? {}
        )) {
          preloaded.set(absoluteKey(key), value)
        }
        const baseStore = withPreloadedObjects(
          createFetchStore(
            this.source,
            this.transformRequest,
            this.rangeRequests
          ),
          preloaded
        )
        // When the version is known, tell the consolidated-metadata wrapper
        // to only try that format — avoids a wasted .zmetadata fetch on v3
        // stores (and vice versa). Falls back to auto-detect when unknown.
        // v3 consolidated metadata support is experimental; the outer
        // `.catch` keeps us on the raw store if the wrapper trips.
        const consolidatedOpts: zarr.ConsolidatedMetadataOptions | undefined =
          this.version === 2
            ? { format: 'v2' }
            : this.version === 3
            ? { format: 'v3' }
            : undefined
        // Range coalescing groups concurrent HTTP range requests into fewer
        // round-trips, reducing latency when fetching many tiles in parallel.
        // Our own copy of zarrita's: a group is aborted only when all of its
        // requests are, so one caller's abort never fails another's range.
        const storePromise = zarr.extendStore(
          baseStore,
          (store) =>
            zarr
              .withMaybeConsolidatedMetadata(store, consolidatedOpts)
              .catch(() => store),
          (store) => withRangeCoalescing(store)
        ) as Promise<ZarrStoreType>
        cached = { store: storePromise, preloaded }
        if (!bypassCache) {
          ZarrStore._storeCache.set(storeCacheKey, cached)
        }
      }

      this.store = await cached.store
    }

    // Wrap with CachingStore for chunk-level caching (unless disabled)
    if (this.chunkCacheEnabled) {
      this.cachingStore = new CachingStore(
        this.store as AsyncReadable,
        this.maxChunkCacheBytes,
        {
          rangeRequests: this.rangeRequests,
          // Our fetch stores go through gatedFetch, which strips the
          // background marker; a custom store would send it
          markBackground: !this.customStore,
        }
      )
      this.cachingStore.setBackgroundClassifier(this.backgroundClassifier)
      this.store = this.cachingStore as unknown as ZarrStoreType
    }

    this.root = zarr.root(this.store)
    await this._loadMetadata()
    this._resolveMetadata(this)

    // Independent reads (bounds from lat/lon, selector coordinates): issue
    // them together rather than one round trip after another
    await Promise.all([this._loadSpatialMetadata(), this._loadCoordinates()])

    return this
  }

  /**
   * Start reading the shard indexes of one step of a sharded v3 array into
   * the chunk cache, so the first render's index reads are cache hits (or
   * join these in flight) instead of waiting for initialization to finish.
   * `selection` gives the index of every non-spatial dimension (a dimension
   * of length 1 may be left out); the lat/lon extent is covered whole, so
   * this only runs when that is at most `maxShards` shards. Range mode only
   * (an index read is a small suffix request there; in whole-object mode it
   * would download whole shards), single-level stores only. Errors are
   * swallowed: the render reads the index again and reports them.
   * Resolves to the number of shard indexes requested.
   */
  async prefetchShardIndexes(
    selection: Record<string, number>,
    { maxShards = 4 }: { maxShards?: number } = {}
  ): Promise<number> {
    const store = this.cachingStore
    if (!store?.rangeRequests || this.levels.length > 0) return 0
    try {
      const keys = await this._shardKeys(selection, maxShards)
      if (!keys) return 0
      await Promise.all(
        keys.paths.map((path) =>
          store
            .getRange(path, { suffixLength: keys.indexBytes })
            .catch(() => undefined)
        )
      )
      return keys.paths.length
    } catch {
      return 0
    }
  }

  /**
   * The shard keys (absolute paths) of one step of the variable, and the
   * size of the suffix zarrita reads as a shard index; null when the array
   * is not sharded with an index at the end, uses a chunk key encoding
   * other than the defaults, or the step is not fully selected.
   */
  private async _shardKeys(
    selection: Record<string, number>,
    maxShards: number
  ): Promise<{ paths: AbsolutePath[]; indexBytes: number } | null> {
    if (!this.store) return null
    const bytes = await this.store.get(`/${this.variable}/zarr.json`)
    if (!bytes) return null
    const meta = JSON.parse(new TextDecoder().decode(bytes))
    const sharding = (Array.isArray(meta?.codecs) ? meta.codecs : []).find(
      (c: { name?: string }) => c?.name === 'sharding_indexed'
    )
    const shardShape: unknown = meta?.chunk_grid?.configuration?.chunk_shape
    const innerShape: unknown = sharding?.configuration?.chunk_shape
    const shape = this.shape
    const ints = (a: unknown): a is number[] =>
      Array.isArray(a) &&
      a.length === shape.length &&
      a.every((n) => Number.isInteger(n) && n > 0)
    if (!sharding || !ints(shardShape) || !ints(innerShape)) return null
    if ((sharding.configuration.index_location ?? 'end') !== 'end') return null

    const encoding = meta.chunk_key_encoding ?? { name: 'default' }
    const isDefault = encoding.name === 'default'
    if (!isDefault && encoding.name !== 'v2') return null
    const separator: string =
      encoding.configuration?.separator ?? (isDefault ? '/' : '.')

    const spatial = new Set(
      [this.dimIndices.lat?.index, this.dimIndices.lon?.index].filter(
        (i): i is number => typeof i === 'number'
      )
    )
    let coords: number[][] = [[]]
    for (let i = 0; i < shape.length; i++) {
      let options: number[]
      if (spatial.has(i)) {
        const n = Math.ceil(shape[i] / shardShape[i])
        options = Array.from({ length: n }, (_, k) => k)
      } else {
        const name = this.dimensions[i]
        const idx = selection[name] ?? (shape[i] === 1 ? 0 : undefined)
        if (!Number.isInteger(idx) || idx! < 0 || idx! >= shape[i]) return null
        options = [Math.floor(idx! / shardShape[i])]
      }
      coords = coords.flatMap((c) => options.map((o) => [...c, o]))
      if (coords.length > maxShards) return null
    }
    const base = this.variable.replace(/^\/+/, '')
    const paths = coords.map((c) => {
      const key = isDefault
        ? ['c', ...c].join(separator)
        : c.length
        ? c.join(separator)
        : '0'
      return `/${base}/${key}` as AbsolutePath
    })
    const innerCount = shardShape.reduce(
      (n, s, i) => n * (s / innerShape[i]),
      1
    )
    // As zarrita's sharded chunk getter: 16 bytes per inner chunk plus a
    // 4-byte checksum
    return { paths, indexBytes: 16 * innerCount + 4 }
  }

  private async _loadCoordinates(): Promise<void> {
    if (!this.coordinateKeys.length || !this.levels.length) return

    await Promise.all(
      this.coordinateKeys.map(async (key) => {
        try {
          const coordPath = `${this.levels[0]}/${key}`
          const coordArray = await this._getArray(coordPath)
          const chunk = await coordArray.getChunk([0])
          this.coordinates[key] = Array.from(
            chunk.data as ArrayLike<number | string>
          )
        } catch (err) {
          console.warn(`Failed to load coordinate array for '${key}':`, err)
        }
      })
    )
  }

  /**
   * Resize the chunk cache of a live store (see `CachingStore.setMaxBytes`).
   * Fractional values are floored; an invalid value (non-finite or negative,
   * see `validCacheBytes`) is ignored with a warning, keeping the current
   * budget, and returns false.
   *
   * The value is also remembered, so calling this before `initialized`
   * resolves sets the budget of the cache that initialization creates. It
   * only changes the budget: whether a `CachingStore` wrapper exists is fixed
   * at construction (`chunkCacheEnabled`), so a store created with caching
   * disabled stays uncached and one resized to 0 keeps an empty cache.
   * Returns true when a live cache was resized.
   */
  setMaxChunkCacheBytes(bytes: number): boolean {
    const valid = validCacheBytes(bytes)
    if (valid === null) {
      console.warn(
        `[zarr-layer] Ignoring invalid chunk cache budget ${bytes}; ` +
          `keeping ${this.maxChunkCacheBytes} bytes.`
      )
      return false
    }
    this.maxChunkCacheBytes = valid
    if (!this.cachingStore) return false
    this.cachingStore.setMaxBytes(this.maxChunkCacheBytes)
    return true
  }

  cleanup() {
    this._arrayHandles.clear()
    this.store = null
    this.root = null
  }

  describe(): StoreDescription {
    return {
      dimensions: this.dimensions,
      shape: this.shape,
      chunks: this.chunks,
      fill_value: this.fill_value,
      dtype: this.dtype,
      levels: this.levels,
      maxLevelIndex: this.maxLevelIndex,
      tileSize: this.tileSize,
      crs: this.crs,
      multiscaleType: this.multiscaleType,
      untiledLevels: this.untiledLevels,
      dimIndices: this.dimIndices,
      xyLimits: this.xyLimits,
      scaleFactor: this.scaleFactor,
      addOffset: this.addOffset,
      coordinates: this.coordinates,
      latIsAscending: this.latIsAscending,
      lon360Wrap: this.lon360Wrap,
      proj4: this.proj4,
    }
  }

  async getChunk(
    level: string,
    chunkIndices: number[],
    options?: { signal?: AbortSignal }
  ): Promise<zarr.Chunk<zarr.DataType>> {
    const key = `${level}/${this.variable}`
    const array = await this._getArray(key)
    return array.getChunk(chunkIndices, options)
  }

  async getLevelArray(
    level: string
  ): Promise<zarr.Array<zarr.DataType, Readable>> {
    const key = `${level}/${this.variable}`
    return this._getArray(key)
  }

  async getArray(): Promise<zarr.Array<zarr.DataType, Readable>> {
    return this._getArray(this.variable)
  }

  /**
   * Get metadata (shape, chunks, scale/offset/fill) for a specific untiled level.
   * Uses zarrita's array properties — no manual JSON fetching needed.
   * On consolidated stores, metadata is served from cache (no network).
   */
  async getUntiledLevelMetadata(levelAsset: string): Promise<{
    shape: number[]
    chunks: number[]
    scaleFactor: number | undefined
    addOffset: number | undefined
    fillValue: number | null
    dtype: string | null
  }> {
    const array = await this.getLevelArray(levelAsset)
    const attrs = array.attrs as Record<string, unknown>
    const dtype = (array.dtype as string) || null
    const fillValue = this.normalizeFillValue(array.fillValue)

    // Float data typically stores already-physical values (e.g., pyramid levels
    // created by averaging). Integer data stores raw counts needing conversion.
    const isFloatData = !!dtype?.includes('float')

    let scaleFactor: number | undefined = undefined
    let addOffset: number | undefined = undefined

    if (isFloatData) {
      scaleFactor = 1
      addOffset = 0
    } else {
      if (attrs?.scale_factor !== undefined) {
        scaleFactor = attrs.scale_factor as number
      }
      if (attrs?.add_offset !== undefined) {
        addOffset = attrs.add_offset as number
      }
    }

    return {
      shape: array.shape,
      chunks: array.chunks,
      scaleFactor,
      addOffset,
      fillValue,
      dtype,
    }
  }

  private async _getArray(
    key: string
  ): Promise<zarr.Array<zarr.DataType, Readable>> {
    if (!this.root) {
      throw new Error('Zarr store accessed before initialization completed')
    }

    let handle = this._arrayHandles.get(key)

    if (!handle) {
      const location = this.root.resolve(key)
      const openFunc = resolveOpenFunc(this.version)
      handle = openFunc(location, { kind: 'array' }).catch((err: Error) => {
        this._arrayHandles.delete(key)
        throw err
      })
      this._arrayHandles.set(key, handle)
    }

    return handle
  }

  private isConsolidatedStore(store: ZarrStoreType | null): store is {
    contents(): { path: `/${string}`; kind: 'array' | 'group' }[]
  } {
    return (
      store !== null &&
      typeof (store as { contents?: unknown }).contents === 'function'
    )
  }

  /**
   * Unified metadata loading using zarrita's built-in APIs.
   * zarrita auto-detects Zarr v2/v3 format and provides parsed metadata
   * via group.attrs and array.shape/chunks/dtype/fillValue/dimensionNames/attrs.
   */
  private async _loadMetadata(): Promise<void> {
    if (!this.root) throw new Error('Zarr store not initialized')

    // Open root group to get multiscales metadata from attrs
    const openFunc = resolveOpenFunc(this.version)
    const group = await openFunc(this.root, { kind: 'group' })
    const rootAttrs = group.attrs as Record<string, unknown>

    if (rootAttrs?.multiscales) {
      const pyramid = this._getPyramidMetadata(
        rootAttrs.multiscales as Multiscale[] | UntiledMultiscaleMetadata
      )
      this.levels = pyramid.levels
      this.maxLevelIndex = pyramid.maxLevelIndex
      this.tileSize = pyramid.tileSize
      if (!this._crsOverride) {
        this.crs = pyramid.crs
      }
    }

    // Open target array to get shape, chunks, dtype, fill_value, dimensions
    const basePath =
      this.levels.length > 0
        ? `${this.levels[0]}/${this.variable}`
        : this.variable
    const array = await this._getArray(basePath)
    const arrayAttrs = array.attrs as Record<string, unknown>

    // zarrita's dimensionNames returns the unified answer for v2
    // (_ARRAY_DIMENSIONS) and v3 (dimension_names).
    this.dimensions = array.dimensionNames ?? []
    this.shape = array.shape
    // zarrita's array.chunks already handles sharding (inner chunk shape)
    this.chunks = array.chunks
    if (this.rangeRequests && this.store) {
      this.shards = await readShardShape(this.store, basePath)
    }
    this.fill_value = this.normalizeFillValue(array.fillValue)
    this.dtype = (array.dtype as string) || null
    this.scaleFactor =
      typeof arrayAttrs?.scale_factor === 'number' ? arrayAttrs.scale_factor : 1
    this.addOffset =
      typeof arrayAttrs?.add_offset === 'number' ? arrayAttrs.add_offset : 0

    await this._computeDimIndices()
  }

  private async _computeDimIndices() {
    if (this.dimensions.length === 0) return

    this.dimIndices = identifyDimensionIndices(
      this.dimensions,
      this.spatialDimensions
    )

    // Collect the actual names of identified spatial dimensions
    // (e.g., 'projection_y_coordinate' if mapped to 'lat')
    const spatialDimNames = new Set(
      ['lat', 'lon']
        .filter((key) => this.dimIndices[key])
        .map((key) => this.dimIndices[key].name.toLowerCase())
    )

    // Add ALL dimensions to dimIndices so selectors can reference them by name
    // (e.g., 'time', 'level', etc. - not just lat/lon)
    for (let i = 0; i < this.dimensions.length; i++) {
      const dimName = this.dimensions[i]
      // Skip if already added (e.g., 'lat' was already mapped with its coordinate array)
      if (this.dimIndices[dimName] || this.dimIndices[dimName.toLowerCase()]) {
        continue
      }
      // Skip if this is the name of an identified spatial dimension
      // (already tracked under 'lat' or 'lon' keys)
      if (spatialDimNames.has(dimName.toLowerCase())) {
        continue
      }
      this.dimIndices[dimName] = {
        name: dimName,
        index: i,
        array: null,
      }
    }
  }

  private normalizeFillValue(value: unknown): number | null {
    if (value === undefined || value === null) return null
    if (typeof value === 'string') {
      const lower = value.toLowerCase()
      if (lower === 'nan') return Number.NaN
      const parsed = Number(value)
      return Number.isNaN(parsed) ? null : parsed
    }
    if (typeof value === 'number') {
      return value
    }
    return null
  }

  /**
   * Find the highest resolution level by comparing array shapes.
   * On consolidated stores, zarr.open serves metadata from cache (no network).
   * Users can provide explicit `bounds` to skip this detection entirely.
   */
  private async _findBoundsLevel(): Promise<string | undefined> {
    if (this.levels.length === 0 || !this.root) return undefined
    if (this.levels.length === 1) return this.levels[0]

    const firstLevel = this.levels[0]
    const lastLevel = this.levels[this.levels.length - 1]

    try {
      const [firstArray, lastArray] = await Promise.all([
        this._getArray(`${firstLevel}/${this.variable}`),
        this._getArray(`${lastLevel}/${this.variable}`),
      ])

      const firstSize = firstArray.shape.reduce((a, b) => a * b, 1)
      const lastSize = lastArray.shape.reduce((a, b) => a * b, 1)
      return firstSize >= lastSize ? firstLevel : lastLevel
    } catch {
      return firstLevel
    }
  }

  private async _loadSpatialMetadata() {
    // Apply explicit bounds first (takes precedence for all multiscale types)
    // Bounds are in source CRS units (degrees for EPSG:4326, meters for EPSG:3857/proj4)
    if (this.explicitBounds) {
      const [west, south, east, north] = this.explicitBounds
      this.xyLimits = { xMin: west, xMax: east, yMin: south, yMax: north }
    }

    // Tiled pyramids: use standard global extent if no explicit bounds
    if (this.multiscaleType === 'tiled') {
      if (!this.xyLimits) {
        this.xyLimits = { xMin: -180, xMax: 180, yMin: -90, yMax: 90 }
      }
      if (!this._latIsAscendingUserSet) {
        this.latIsAscending = false // Tiled pyramids: row 0 = north
      }
      return
    }

    // For untiled: determine what we still need to detect
    const needsBounds = !this.xyLimits
    const needsLatAscending = !this._latIsAscendingUserSet

    // If explicit bounds provided and user doesn't need latIsAscending detection, skip coord fetch
    // (respects user intent to avoid coord reads by providing bounds)
    if (!needsBounds && !needsLatAscending) {
      return
    }

    // Can't fetch coords without dimension info - default already set
    if (!this.dimIndices.lon || !this.dimIndices.lat || !this.root) {
      return
    }

    try {
      const boundsLevel = await this._findBoundsLevel()

      const lonName = this.spatialDimensions.lon ?? this.dimIndices.lon.name
      const latName = this.spatialDimensions.lat ?? this.dimIndices.lat.name

      // Find the best coordinate array path from consolidated store listings.
      // On consolidated stores, uses store.contents() to enumerate all arrays;
      // on non-consolidated stores, returns null (triggers default fallback).
      const findCoordPath = async (dimName: string): Promise<string | null> => {
        const store = this.store
        if (!this.isConsolidatedStore(store)) return null

        const entries = store.contents()
        // Find all array entries whose path ends with the dimension name
        const matchingPaths = entries
          .filter(
            (e) =>
              e.kind === 'array' &&
              (e.path === `/${dimName}` || e.path.endsWith(`/${dimName}`))
          )
          .map((e) => e.path.slice(1)) // Remove leading '/'

        if (matchingPaths.length === 0) return null
        if (matchingPaths.length === 1) return matchingPaths[0]

        // Multiple matches: open each to find highest resolution (largest shape[0])
        const withSizes = await Promise.all(
          matchingPaths.map(async (path) => {
            try {
              const arr = await this._getArray(path)
              return { path, size: arr.shape[0] }
            } catch {
              return { path, size: 0 }
            }
          })
        )

        type Candidate = { path: string; size: number }
        const largest = (
          predicate: (c: Candidate) => boolean
        ): Candidate | undefined =>
          withSizes.reduce<Candidate | undefined>(
            (best, c) =>
              predicate(c) && (!best || c.size > best.size) ? c : best,
            undefined
          )

        // Prefer coord arrays within the bounds level, then root-level, then largest
        if (boundsLevel) {
          const levelPrefix = `${boundsLevel}/`
          const levelPick = largest((c) => c.path.startsWith(levelPrefix))
          if (levelPick) return levelPick.path

          const rootPick = largest((c) => !c.path.includes('/'))
          if (rootPick) return rootPick.path
        } else if (this.variable) {
          const varPick = largest((c) => c.path.startsWith(`${this.variable}/`))
          if (varPick) return varPick.path
        }

        return largest(() => true)?.path ?? null
      }

      // Find highest resolution coordinate arrays from store listings
      const [xPath, yPath] = await Promise.all([
        findCoordPath(lonName),
        findCoordPath(latName),
      ])

      // Open coord arrays: use metadata path if found, otherwise try level/dimName
      const defaultPrefix = boundsLevel ? `${boundsLevel}/` : ''
      const xarr = await this._getArray(xPath ?? `${defaultPrefix}${lonName}`)
      const yarr = await this._getArray(yPath ?? `${defaultPrefix}${latName}`)

      const xLen = xarr.shape[0]
      const yLen = yarr.shape[0]

      type ZarrResult = { data: ArrayLike<number> }
      const [xFirstTwo, xLast, yFirstTwo, yLast] = (await Promise.all([
        zarr.get(xarr, [zarr.slice(0, 2)]),
        zarr.get(xarr, [zarr.slice(xLen - 1, xLen)]),
        zarr.get(yarr, [zarr.slice(0, 2)]),
        zarr.get(yarr, [zarr.slice(yLen - 1, yLen)]),
      ])) as ZarrResult[]

      const x0 = xFirstTwo.data[0]
      const x1 = xFirstTwo.data[1] ?? x0
      const xN = xLast.data[0]
      const y0 = yFirstTwo.data[0]
      const y1 = yFirstTwo.data[1]
      const yN = yLast.data[0]

      // Detect latIsAscending from first two y values
      const detectedLatAscending = y1 > y0
      if (needsLatAscending) {
        this.latIsAscending = detectedLatAscending
      }

      // Coordinate extents from coordinate arrays (these are pixel centers)
      const coordXMin = Math.min(x0, xN)
      const coordXMax = Math.max(x0, xN)
      const coordYMin = Math.min(y0, yN)
      const coordYMax = Math.max(y0, yN)

      // Use coordinate array's own spacing for half-pixel expansion.
      // Coords represent pixel centers; extent is [first - halfPixel, last + halfPixel]
      const dx = Math.abs(x1 - x0)
      const dy = Math.abs(y1 - y0)

      // Apply half-pixel expansion (coords are pixel centers, we need edge bounds)
      let xMin = coordXMin - (Number.isFinite(dx) ? dx / 2 : 0)
      let xMax = coordXMax + (Number.isFinite(dx) ? dx / 2 : 0)
      const yMin = coordYMin - (Number.isFinite(dy) ? dy / 2 : 0)
      const yMax = coordYMax + (Number.isFinite(dy) ? dy / 2 : 0)

      // Normalize 0–360° longitude convention to -180–180°.
      if (!this.proj4 && this.crs !== 'EPSG:3857') {
        if (xMin > 180 && xMax > 180 && xMax <= 361) {
          // Both bounds > 180: shift everything (regional data in 180-360 range)
          xMin -= 360
          xMax -= 360
        } else if (
          xMin >= -1 &&
          xMax > 180 &&
          xMax <= 361 &&
          Number.isFinite(dx) &&
          Math.abs(xMax - xMin - 360) < dx
        ) {
          // Global 0-360 data: flag for per-region longitude wrapping.
          // Keep bounds as [0, 360] so pixel-to-geo mapping is correct,
          // then getRegionBounds shifts longitudes > 180 to negative values.
          this.lon360Wrap = true
        }
      }

      // For global datasets, snap bounds to exactly ±180 to avoid antimeridian
      // seams caused by grid alignment not landing on ±180. A truly global grid
      // has extent = N * dx = 360°; use dx/2 tolerance for float32 precision.
      // A dataset one cell short has extent = 360 - dx, which fails the check.
      const lonExtent = xMax - xMin
      if (Number.isFinite(dx) && Math.abs(lonExtent - 360) < dx / 2) {
        if (Math.abs(xMin + 180) < dx) xMin = -180
        if (Math.abs(xMax - 180) < dx) xMax = 180
      }

      if (needsBounds) {
        this.xyLimits = { xMin, xMax, yMin, yMax }
      }
      console.log('[zarr-store] spatial metadata:', {
        xMin,
        xMax,
        yMin,
        yMax,
        dx,
        dy,
        lon360Wrap: this.lon360Wrap,
        latIsAscending: this.latIsAscending,
      })

      // Warn users to set explicit values to skip future coordinate fetches
      if (this.multiscaleType === 'untiled') {
        const hints: string[] = []
        if (needsBounds)
          hints.push(`bounds: [${xMin}, ${yMin}, ${xMax}, ${yMax}]`)
        if (needsLatAscending && !detectedLatAscending)
          hints.push('latIsAscending: false')

        if (hints.length > 0) {
          console.warn(
            `[zarr-layer] Detected from coordinate arrays. ` +
              `Set explicitly to skip this fetch: ${hints.join(', ')}`
          )
        }
      }
    } catch (err) {
      if (needsBounds) {
        throw new Error(
          `Failed to load bounds from coordinate arrays. ` +
            `Provide explicit bounds via the 'bounds' option. ` +
            `Error: ${err instanceof Error ? err.message : err}`
        )
      }
      if (needsLatAscending) {
        console.warn(
          `[zarr-layer] Could not detect latIsAscending from coordinates. ` +
            `Defaulting to true (row 0 = south). Set explicitly if data appears flipped.`
        )
      }
    }

    // Infer CRS from bounds if not explicitly set
    // Only classify as meters if clearly outside degree range (> 360)
    // This handles both [-180, 180] and [0, 360] degree conventions
    // Applies to untiled multiscales and single-level datasets (multiscaleType === 'none')
    if (
      (this.multiscaleType === 'untiled' || this.multiscaleType === 'none') &&
      !this._crsFromMetadata &&
      !this._crsOverride &&
      this.xyLimits
    ) {
      const maxAbsX = Math.max(
        Math.abs(this.xyLimits.xMin),
        Math.abs(this.xyLimits.xMax)
      )
      if (maxAbsX > 360) {
        this.crs = 'EPSG:3857'
      }
    }
  }

  /**
   * Parse multiscale metadata to determine pyramid structure.
   *
   * Supports three multiscale formats:
   *
   * 1. **zarr-conventions/multiscales** (layout format):
   *    Uses `layout` array with transform info. Parsed by `_parseUntiledMultiscale()`.
   *    Example: `{ layout: [{ asset: "0", transform: { scale: [...] } }, ...] }`
   *
   * 2. **OME-NGFF style** (datasets format):
   *    Uses `datasets` array. If `pixels_per_tile` is present, treated as tiled pyramid.
   *    Otherwise treated as untiled multi-level.
   *    Example: `[{ datasets: [{ path: "0", crs: "EPSG:4326" }, ...] }]`
   *
   * 3. **Single level**: No multiscale metadata, treated as single untiled image.
   *
   * For untiled formats, shapes are extracted from consolidated metadata when available
   * to avoid per-level network requests.
   */
  private _getPyramidMetadata(
    multiscales: Multiscale[] | UntiledMultiscaleMetadata | undefined
  ): PyramidMetadata {
    // Default for missing or unrecognized multiscale metadata: single-level untiled
    const singleLevelUntiled = (): PyramidMetadata => {
      this.multiscaleType = 'untiled'
      return {
        levels: [],
        maxLevelIndex: 0,
        tileSize: DEFAULT_TILE_SIZE,
        crs: this.crs,
      }
    }

    if (!multiscales) return singleLevelUntiled()

    // Format 1: zarr-conventions/multiscales (has 'layout' key)
    // See: https://github.com/zarr-conventions/multiscales
    if ('layout' in multiscales && Array.isArray(multiscales.layout)) {
      return this._parseUntiledMultiscale(multiscales, singleLevelUntiled)
    }

    // Format 2: OME-NGFF style (array with 'datasets' key)
    // See: https://ngff.openmicroscopy.org/latest/
    if (Array.isArray(multiscales) && multiscales[0]?.datasets?.length) {
      const datasets = multiscales[0].datasets
      const levels = datasets.map((dataset) => String(dataset.path))
      const maxLevelIndex = levels.length - 1
      const tileSize = datasets[0].pixels_per_tile
      // If CRS is absent, default to EPSG:3857 to match pyramid (mercator) tiling.
      const crs: CRS =
        (datasets[0].crs as CRS) === 'EPSG:4326' ? 'EPSG:4326' : 'EPSG:3857'

      // If pixels_per_tile is present, this is a tiled pyramid (slippy map tiles).
      // Otherwise, treat as untiled multi-level (each level is a complete image).
      if (tileSize) {
        this.multiscaleType = 'tiled'
        return { levels, maxLevelIndex, tileSize, crs }
      }
      // Multi-level but not tiled - use UntiledMode
      this.untiledLevels = levels.map((level) => ({
        asset: level,
        scale: [1.0, 1.0] as [number, number],
        translation: [0.0, 0.0] as [number, number],
      }))
      this.multiscaleType = 'untiled'
      return { levels, maxLevelIndex, tileSize: DEFAULT_TILE_SIZE, crs }
    }

    return singleLevelUntiled()
  }

  /**
   * Parse zarr-conventions/multiscales format (layout-based).
   *
   * This format uses a `layout` array where each entry specifies:
   * - `asset`: path to the level (e.g., "0", "1", ...)
   * - `transform`: optional scale/translation for georeferencing
   *
   * Example metadata:
   * ```json
   * {
   *   "layout": [
   *     { "asset": "0", "transform": { "scale": [1.0, 1.0], "translation": [0, 0] } },
   *     { "asset": "1", "transform": { "scale": [2.0, 2.0], "translation": [0, 0] } }
   *   ],
   *   "crs": "EPSG:4326"
   * }
   * ```
   *
   * @see https://github.com/zarr-conventions/multiscales
   */
  private _parseUntiledMultiscale(
    metadata: UntiledMultiscaleMetadata,
    singleLevelUntiled: () => PyramidMetadata
  ): PyramidMetadata {
    const layout = metadata.layout
    if (!layout || layout.length === 0) return singleLevelUntiled()

    // Extract levels from layout
    const levels = layout.map((entry) => entry.asset)
    const maxLevelIndex = levels.length - 1

    // Build untiledLevels with transform info (shapes loaded lazily via getUntiledLevelMetadata)
    this.untiledLevels = layout.map((entry) => ({
      asset: entry.asset,
      scale: entry.transform?.scale ?? [1.0, 1.0],
      translation: entry.transform?.translation ?? [0.0, 0.0],
    }))

    this.multiscaleType = 'untiled'

    // Check for explicit CRS in metadata, otherwise use configured CRS
    // (bounds-based inference will happen after coordinate arrays are loaded)
    const crs: CRS = metadata.crs ?? this.crs
    if (metadata.crs && !this._crsOverride) {
      this._crsFromMetadata = true
    }

    return {
      levels,
      maxLevelIndex,
      tileSize: DEFAULT_TILE_SIZE, // Will be overridden by chunk shape
      crs,
    }
  }

  static clearCache() {
    ZarrStore._storeCache.clear()
  }
}
