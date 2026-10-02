/**
 * @module zarr-layer
 *
 * MapLibre/Mapbox custom layer implementation for rendering Zarr datasets.
 * Implements CustomLayerInterface for direct WebGL rendering.
 */

import type { GetOptions, Readable } from '@zarrita/storage'
import {
  loadDimensionValues,
  getBands,
  toSelectorProps,
  normalizeSelector,
} from './zarr-utils'
import { ZarrStore } from './zarr-store'
import { maplibreFragmentShaderSource, type ShaderData } from './shaders'
import { ColormapState } from './colormap'
import { ZarrRenderer } from './zarr-renderer'
import type { CustomShaderConfig } from './renderer-types'
import type {
  Bounds,
  ColormapArray,
  SpatialDimensions,
  DimIndicesProps,
  LoadingStateCallback,
  MapLike,
  Selector,
  NormalizedSelector,
  ZarrLayerOptions,
  TransformRequest,
} from './types'
import type { ZarrMode, RenderContext } from './zarr-mode'
import { TiledMode } from './tiled-mode'
import { UntiledMode, normalizedCacheBytesFor } from './untiled-mode'
import {
  DEFAULT_CHUNK_CACHE_BYTES,
  validCacheBytes,
  type CachingStore,
} from './caching-store'
import {
  computeWorldOffsets,
  resolveProjectionParams,
  isGlobeProjection as checkGlobeProjection,
} from './map-utils'
import { MAPBOX_IDENTITY_MATRIX } from './mapbox-utils'
import type { QueryGeometry, QueryOptions, QueryResult } from './query/types'
import {
  ESTIMATE_RECENT_STEPS,
  EVICTION_TIER_DISPLAYED,
  EVICTION_TIER_OTHER,
  EVICTION_TIER_WINDOW,
  MAX_WINDOW_REFILLS,
  SPATIAL_DIM_NAMES,
  WINDOW_REFILL_DELAY_MS,
} from './constants'
import {
  DEFAULT_PREFETCH_CONCURRENCY,
  PrefetchQueue,
  normalizeConcurrency,
  type PrefetchStepInfo,
} from './prefetch-queue'
import {
  DEFAULT_PREFETCH_MAX_REQUESTS,
  RequestLimiter,
} from './request-limiter'
import { configureRequestGate } from './request-gate'

type MapboxInternals = {
  transform?: {
    expandedFarZProjMatrix?: Float32Array | Float64Array | number[]
    worldSize?: number
  }
  painter?: {
    transform?: {
      expandedFarZProjMatrix?: Float32Array | Float64Array | number[]
      worldSize?: number
    }
  }
}

/** Extract Mapbox's internal expandedFarZ projection matrix and worldSize.
 *  Falls back per-field: transform may exist without the expanded matrix,
 *  while painter.transform carries it (or vice versa across Mapbox versions). */
function getMapboxGlobeInternals(map: MapLike) {
  const m = map as MapLike & MapboxInternals
  return {
    expandedFarZProjMatrix:
      m.transform?.expandedFarZProjMatrix ??
      m.painter?.transform?.expandedFarZProjMatrix,
    worldSize: m.transform?.worldSize ?? m.painter?.transform?.worldSize,
  }
}

function scaleMercatorMatrix(
  matrix: number[] | Float32Array | Float64Array,
  scale: number
): Float32Array {
  // Mapbox's customLayerMatrix() is the projection matrix scaled from world
  // pixels to normalized Mercator units. To mimic its expanded-far variant,
  // scale the basis columns but leave translation unchanged.
  const out = new Float32Array(matrix)
  for (let i = 0; i < 4; i++) out[i] *= scale
  for (let i = 4; i < 8; i++) out[i] *= scale
  for (let i = 8; i < 12; i++) out[i] *= scale
  return out
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function mapboxGlobeToMercatorTransition(zoom: number): number {
  // Mirrors Mapbox's current globeToMercatorTransition(zoom) helper.
  return smoothstep(5, 6, zoom)
}

/** Chunk keys recorded for one step: a time index + selection. */
interface StepKeys {
  timeIndex: number
  selection: string
  keys: Set<string>
  /**
   * Keys read by this step's latest prefetch that ran to completion (not
   * aborted, no failed chunk fetch), or null if none has. Unlike `keys`
   * (every access ever attributed to the step, including render reads of
   * other levels/regions and coordinate reads at init), this is exactly one
   * fetch of the step for the regions then in view: the per-step byte
   * estimate is measured from it. `keys` of an in-flight or render-only
   * step may be a partial set.
   */
  measuredKeys: Set<string> | null
  /** Order in which `measuredKeys` was set (higher = more recent). */
  measuredSeq: number
  /**
   * Keys of the step's latest completed fetch, or null while none has
   * completed: a prefetch that ran to completion (its key set, as
   * `measuredKeys`), or a render of the displayed step that the mode
   * reported fully rendered (see `handleViewComplete`).
   * The step reads as 'cached' only when this is set and all of it is
   * resident, so a step aborted partway (whose `keys` are all resident but
   * incomplete) reads 'partial' and is fetched again.
   */
  completeKeys: Set<string> | null
  /**
   * The step's latest prefetch had a failed chunk read. The prefetch queue
   * retries such a step itself, with backoff (task 44), so the window refill
   * leaves it alone (see refillWindow). Cleared by a fetch that completes.
   */
  lastFetchFailed: boolean
}

/** Largest shard batch (time steps) the prefetch queue starts together. */
export const MAX_PREFETCH_BATCH = 16
/** Default `prefetchBatchSteps`. */
export const DEFAULT_PREFETCH_BATCH_STEPS = 4

export class ZarrLayer {
  readonly type: 'custom' = 'custom'
  readonly renderingMode: '2d' | '3d'

  id: string
  private url: string
  private variable: string
  private zarrVersion: 2 | 3 | null = null
  private spatialDimensions: SpatialDimensions
  private bounds: Bounds | undefined
  private crs: string | undefined
  private latIsAscending: boolean | null = null
  private selector: Selector
  private invalidate: () => void

  private colormap: ColormapState
  private clim: [number, number]
  private opacity: number
  private minZoom: number
  private maxZoom: number
  private selectorHash: string = ''

  private _fillValue: number | null = null
  private scaleFactor: number = 1
  private offset: number = 0
  private fixedDataScale: number
  // Once true, fixedDataScale is locked (mode has captured it)
  private dataScaleLocked: boolean = false

  private gl: WebGL2RenderingContext | undefined
  private map: MapLike | null = null
  private renderer: ZarrRenderer | null = null
  private mode: ZarrMode | null = null
  private tileNeedsRender: boolean = true

  private projectionChangeHandler: (() => void) | null = null
  private resolveGl(
    map: MapLike,
    gl: WebGL2RenderingContext | WebGLRenderingContext | null
  ): WebGL2RenderingContext {
    const isWebGL2 =
      gl &&
      typeof gl.getUniformLocation === 'function' &&
      typeof (gl as WebGL2RenderingContext).drawBuffers === 'function'
    if (isWebGL2) {
      return gl as WebGL2RenderingContext
    }

    const describe = (obj: unknown) =>
      obj
        ? {
            type: obj.constructor?.name,
            keys: Object.keys(obj),
          }
        : null
    console.error('Invalid WebGL2 context passed to onAdd', {
      providedGl: describe(gl),
      painterGl: describe(map?.painter?.context?.gl),
      rendererGl: describe(map?.renderer?.getContext?.()),
    })
    throw new Error('`map` did not provide a valid WebGL2 context')
  }

  private zarrStore: ZarrStore | null = null
  private levelInfos: string[] = []
  private dimIndices: DimIndicesProps = {}
  private dimensionValues: {
    [key: string]: Float64Array | number[] | string[]
  } = {}
  private normalizedSelector: NormalizedSelector = {}
  private isRemoved: boolean = false
  private fragmentShaderSource: string = maplibreFragmentShaderSource
  private customFrag: string | undefined
  private customUniforms: Record<string, number> = {}
  private bandNames: string[] = []
  private customShaderConfig: CustomShaderConfig | null = null
  private onLoadingStateChange: LoadingStateCallback | undefined
  private metadataLoading: boolean = false
  private chunksLoading: boolean = false
  private initError: Error | null = null
  private throttleMs: number
  private proj4: string | undefined
  private transformRequest: TransformRequest | undefined
  private customStore: Readable | undefined
  private renderPoles: boolean
  private lastIsGlobe: boolean | null = null
  private usingDirectMapboxGlobePath: boolean = false
  private maxChunkCacheBytes: number | undefined
  /**
   * Whether the chunk cache exists at all. Fixed at construction (unset or
   * a budget > 0 after validation), so runtime resizes (including to 0) never
   * enable or disable caching across `setVariable` or remove/re-add.
   */
  private readonly chunkCacheEnabled: boolean
  /** Range mode of the chunk cache (see `ZarrLayerOptions.rangeRequests`). */
  private readonly rangeRequests: boolean
  /** Time dim of the last prefetchTimeSteps call ('time' until then). */
  private prefetchTimeDimName: string = 'time'
  /**
   * Incremental prefetch queue (see prefetch-queue.ts): up to
   * `prefetchConcurrency` steps in flight, each fetched through the mode's
   * one-step `prefetchTimeSteps` primitive.
   */
  private readonly prefetchQueue: PrefetchQueue
  /**
   * Cap on prefetch chunk requests in flight across all prefetch steps
   * (`prefetchMaxRequests`). Render fetches don't go through it (on HTTP/1.1
   * hosts both still share the browser's ~6 connections per host).
   * Earlier-started (higher-priority) steps get free slots first.
   */
  private readonly prefetchLimiter: RequestLimiter
  /** Most steps per prefetch batch (`prefetchBatchSteps`). */
  private readonly prefetchBatchSteps: number
  /**
   * CachingStore cache keys per step, where a step is a time index *plus*
   * the values of the other non-spatial selector dims (the "selection", e.g.
   * an ensemble member): see stepKey(). Populated as fetches happen
   * (prefetch + render). Cache status is derived by re-checking each key's
   * residency in the CachingStore, so LRU evictions automatically downgrade a
   * step's status, and chunks shared by several selections are recorded under
   * each of them.
   */
  private timestepKeys: Map<string, StepKeys> = new Map()
  /**
   * Byte size of each recorded key, taken from the CachingStore when the
   * access is recorded. Kept after the entry is evicted, so the per-step
   * estimate does not depend on what is still resident. Cleared with
   * timestepKeys.
   */
  private keyBytes: Map<string, number> = new Map()
  /** Counter for StepKeys.measuredSeq. */
  private measureCount: number = 0
  /**
   * Prefetch requests in flight, keyed by the AbortSignal the queue created
   * for the step. zarrita forwards that same signal to every store.get /
   * getRange of the request, so the access listener can attribute each
   * access to the request that made it: accesses carrying a registered
   * signal belong to that prefetch step; all others (render fetches) belong
   * to the displayed time index and current selection. Per request, not a
   * global "currently prefetching" flag, so a render during a prefetch is
   * never credited to the prefetched step. The selection is captured when
   * the step starts.
   */
  private prefetchSignals: WeakMap<
    AbortSignal,
    { timeIndex: number; selection: string; keys: Set<string> }
  > = new WeakMap()
  /**
   * Non-prefetch reads attributed to the displayed step since it became
   * displayed (see handleViewComplete). `step` is the stepKey they were
   * attributed to; a read for another step restarts the set.
   */
  private displayedReads: { step: string; keys: Set<string> } | null = null
  /** Memoized currentSelection(); reset when the selector or time dim changes. */
  private selectionCache: string | null = null
  /** Disposer for the continuous CachingStore access listener. */
  private removeAccessListener: (() => void) | null = null
  /**
   * The last prefetch window (deduped, in the caller's order) and its time
   * dim, or null before the first `prefetchTimeSteps` call. Its steps' keys
   * are protected from eviction (see evictionPriority), and it is refilled
   * when it has holes while the queue is idle (see refillWindow).
   */
  private prefetchWindow: { indices: number[]; dim: string } | null = null
  /** Refills of the current window so far (see MAX_WINDOW_REFILLS). */
  private windowRefills: number = 0
  private refillTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Keys of the prefetch window's steps and of the displayed step, rebuilt
   * lazily (on the next eviction) after anything they depend on changes.
   */
  private protectedKeys: {
    window: Map<string, number>
    displayed: Set<string>
  } | null = null
  private mapboxDirectGlobePathAvailable: boolean = false

  private canUseMapboxDirectGlobePath(): boolean {
    if (this.mapboxDirectGlobePathAvailable) {
      return true
    }
    if (!this.map || !this.isGlobeProjection()) {
      return false
    }

    // Probe for internal matrix — may not be populated yet during early
    // lifecycle events. Failed probes keep retrying until it appears.
    const { expandedFarZProjMatrix, worldSize } = getMapboxGlobeInternals(
      this.map
    )
    if (expandedFarZProjMatrix && worldSize) {
      this.mapboxDirectGlobePathAvailable = true
      return true
    }
    return false
  }

  private configureMapboxRenderPath(): void {
    if (!this.map || !this.mode) return

    const isUntiled = this.mode instanceof UntiledMode
    const resolvedProj4 = this.zarrStore?.proj4 ?? this.proj4
    const resolvedCrs = this.zarrStore?.crs ?? this.crs
    const isEcefEligible = !!resolvedProj4 || resolvedCrs === 'EPSG:4326'
    const isGlobe = this.isGlobeProjection()
    const transition =
      this.map.getZoom && isGlobe
        ? mapboxGlobeToMercatorTransition(this.map.getZoom())
        : 1
    // FRAGILE: Mapbox classifies a custom layer as draped whenever renderToTile
    // exists. We use the direct globe path only for untiled, terrain-off,
    // ECEF-eligible datasets at the fully-globe endpoint. During the zoom morph,
    // restore the draped path so Mapbox handles the transition itself with its
    // internal globe/mercator matrices. This means polar coverage can snap back
    // to the draped path near the 5-6 zoom morph window; that is intentional,
    // and is currently more stable than trying to carry the direct ECEF path
    // through Mapbox's custom-layer transition contract.
    // canUseMapboxDirectGlobePath() probes for Mapbox-only internals, so it
    // doubles as the Mapbox discriminator — MapLibre will never pass this gate.
    const shouldUseDirectGlobePath =
      this.renderPoles &&
      isUntiled &&
      isEcefEligible &&
      !this.map.getTerrain?.() &&
      isGlobe &&
      this.canUseMapboxDirectGlobePath() &&
      transition <= 1e-3

    if (shouldUseDirectGlobePath === this.usingDirectMapboxGlobePath) return
    this.usingDirectMapboxGlobePath = shouldUseDirectGlobePath

    if (shouldUseDirectGlobePath) {
      Object.defineProperty(this, 'renderToTile', {
        value: undefined,
        configurable: true,
        writable: true,
      })
      this.map.triggerRepaint?.()
    } else if (Object.prototype.hasOwnProperty.call(this, 'renderToTile')) {
      delete (this as { renderToTile?: unknown }).renderToTile
      // Re-entering the draped path requires fresh tile draws; otherwise Mapbox
      // can show a one-frame gap before renderToTile repopulates tile textures.
      this.tileNeedsRender = true
      this.map.triggerRepaint?.()
    }
  }

  get fillValue(): number | null {
    return this._fillValue
  }

  private isGlobeProjection(): boolean {
    const projection = this.map?.getProjection ? this.map.getProjection() : null
    return checkGlobeProjection(projection)
  }

  /** Check for projection changes and notify mode. Returns current isGlobe state. */
  private syncProjectionState(): boolean {
    const isGlobe = this.isGlobeProjection()
    if (this.lastIsGlobe !== null && this.lastIsGlobe !== isGlobe) {
      this.mode?.onProjectionChange(isGlobe)
    }
    this.lastIsGlobe = isGlobe
    return isGlobe
  }

  constructor({
    id,
    source,
    variable,
    selector = {},
    colormap,
    clim,
    opacity = 1,
    minzoom = 0,
    maxzoom = Infinity,
    zarrVersion,
    spatialDimensions = {},
    bounds,
    crs,
    latIsAscending = null,
    fillValue,
    customFrag,
    uniforms,
    renderingMode = '3d',
    onLoadingStateChange,
    throttleMs = 100,
    proj4,
    transformRequest,
    store,
    renderPoles = false,
    maxChunkCacheBytes,
    rangeRequests = false,
    prefetchConcurrency,
    prefetchMaxRequests,
    maxRequestsPerSecond,
    requestBurst,
    prefetchBatchSteps,
  }: ZarrLayerOptions) {
    if (!id) {
      throw new Error('[ZarrLayer] id is required')
    }
    if (!source && !store) {
      throw new Error(
        '[ZarrLayer] source is required when store is not provided'
      )
    }
    if (!variable) {
      throw new Error('[ZarrLayer] variable is required')
    }
    if (!colormap || !Array.isArray(colormap) || colormap.length === 0) {
      throw new Error(
        '[ZarrLayer] colormap is required and must be an array of [r, g, b] or hex string values'
      )
    }
    if (!clim || !Array.isArray(clim) || clim.length !== 2) {
      throw new Error('[ZarrLayer] clim is required and must be [min, max]')
    }
    if (proj4 && !bounds) {
      console.warn(
        `[ZarrLayer] proj4 provided without explicit bounds. ` +
          `Bounds will be derived from coordinate arrays if available (see subsequent log for values). ` +
          `For best performance, provide bounds in source CRS units.`
      )
    }

    this.id = id
    this.url = source ?? id // Use id as fallback identifier when using custom store
    this.variable = variable
    this.zarrVersion = zarrVersion ?? null
    this.spatialDimensions = spatialDimensions
    this.bounds = bounds
    this.crs = crs
    this.latIsAscending = latIsAscending ?? null
    this.selector = selector
    this.normalizedSelector = normalizeSelector(selector)
    this.selectorHash = this.computeSelectorHash(this.normalizedSelector)
    this.renderingMode = renderingMode
    this.invalidate = () => {}
    this.colormap = new ColormapState(colormap)
    this.clim = clim
    this.fixedDataScale = Math.max(Math.abs(clim[0]), Math.abs(clim[1]), 1)
    this.opacity = opacity
    this.minZoom = minzoom
    this.maxZoom = maxzoom

    this.customFrag = customFrag
    this.customUniforms = uniforms || {}

    this.bandNames = getBands(variable, this.normalizedSelector)
    if (this.bandNames.length > 1 || customFrag) {
      this.customShaderConfig = {
        bands: this.bandNames,
        customFrag: customFrag,
        customUniforms: this.customUniforms,
      }
    }

    if (fillValue !== undefined) this._fillValue = fillValue
    this.onLoadingStateChange = onLoadingStateChange
    this.throttleMs = throttleMs
    this.proj4 = proj4
    this.transformRequest = transformRequest
    this.customStore = store
    this.renderPoles = renderPoles
    // An invalid budget behaves exactly like an unset one (100 MB chunk
    // cache, default decoded-cache budget).
    let chunkBudget =
      maxChunkCacheBytes === undefined
        ? undefined
        : validCacheBytes(maxChunkCacheBytes)
    if (chunkBudget === null) {
      console.warn(
        `[ZarrLayer] Invalid maxChunkCacheBytes ${maxChunkCacheBytes}; ` +
          `using the default of ${DEFAULT_CHUNK_CACHE_BYTES} bytes.`
      )
      chunkBudget = undefined
    }
    this.maxChunkCacheBytes = chunkBudget
    this.chunkCacheEnabled = chunkBudget === undefined || chunkBudget > 0
    this.rangeRequests = rangeRequests

    const steps = normalizeConcurrency(
      prefetchConcurrency,
      DEFAULT_PREFETCH_CONCURRENCY
    )
    const requests = normalizeConcurrency(
      prefetchMaxRequests,
      DEFAULT_PREFETCH_MAX_REQUESTS
    )
    for (const [name, value, used] of [
      ['prefetchConcurrency', prefetchConcurrency, steps],
      ['prefetchMaxRequests', prefetchMaxRequests, requests],
    ] as const) {
      if (value !== undefined && Math.floor(value) !== used) {
        console.warn(`[ZarrLayer] Invalid ${name} ${value}; using ${used}.`)
      }
    }
    // The source origin's shared request gate (task 44): a layer that asks
    // for a cap sets it for every layer reading from that origin
    if (source && maxRequestsPerSecond !== undefined) {
      configureRequestGate(source, {
        maxRequestsPerSecond,
        burst: requestBurst,
      })
    }
    this.prefetchBatchSteps = normalizeConcurrency(
      prefetchBatchSteps,
      DEFAULT_PREFETCH_BATCH_STEPS
    )
    this.prefetchLimiter = new RequestLimiter(requests)
    this.prefetchQueue = new PrefetchQueue({
      fetchStep: (timeIdx, timeDimName, signal, info) =>
        this.prefetchOneStep(timeIdx, timeDimName, signal, info),
      isCached: (timeIdx) => this.isTimeStepCached(timeIdx),
      onBusyChange: (busy) => {
        this.emitLoadingState()
        if (!busy) this.scheduleWindowRefill()
      },
      maxConcurrentSteps: steps,
      batchSize: () => this.getPrefetchBatchSize(),
    })
  }

  private emitLoadingState(): void {
    if (!this.onLoadingStateChange) return
    this.onLoadingStateChange({
      loading: this.metadataLoading || this.chunksLoading,
      metadata: this.metadataLoading,
      chunks: this.chunksLoading,
      prefetching: this.prefetchQueue.busy,
      error: this.initError,
    })
  }

  private handleChunkLoadingChange = (state: {
    loading: boolean
    chunks: boolean
  }): void => {
    this.chunksLoading = state.chunks
    this.emitLoadingState()
  }

  /**
   * The mode reports that the current view of the displayed step is fully
   * rendered (every visible region or tile holds data for the current
   * selector; see `ZarrMode.setViewCompleteCallback`). A region that failed
   * or was aborted is not rendered for the current selector, so an
   * interrupted render never gets here; nor does a throttled one until its
   * fetch lands. It does get here for a redisplay served from the mode's
   * own caches, which makes no store reads.
   *
   * Counts as a completed fetch of the displayed step: its complete set
   * becomes the earlier complete set (or, if none, every key recorded for
   * the step: a conservative stand-in, since a redisplay from the mode's
   * caches reads nothing) plus the reads made while it was displayed.
   */
  private handleViewComplete = (): void => {
    if (this.initError) return
    const timeIdx = this.getCurrentTimeIdx()
    if (timeIdx === null) return
    const step = this.stepKey(timeIdx, this.currentSelection())
    const entry = this.timestepKeys.get(step)
    if (!entry) return
    const complete = new Set(entry.completeKeys ?? entry.keys)
    if (this.displayedReads?.step === step) {
      for (const key of this.displayedReads.keys) complete.add(key)
    }
    entry.completeKeys = complete
    entry.lastFetchFailed = false
    this.protectedKeys = null
  }

  setOpacity(opacity: number) {
    this.opacity = opacity
    this.invalidate()
  }

  setClim(clim: [number, number]) {
    this.clim = clim
    // Allow fixedDataScale to update until mode captures it
    if (!this.dataScaleLocked) {
      this.fixedDataScale = Math.max(Math.abs(clim[0]), Math.abs(clim[1]), 1)
    }
    this.invalidate()
  }

  setColormap(colormap: ColormapArray) {
    this.colormap.apply(colormap)
    if (this.gl) {
      this.colormap.upload(this.gl)
    }
    this.invalidate()
  }

  setUniforms(uniforms: Record<string, number>) {
    if (!this.customShaderConfig) {
      console.warn(
        '[ZarrLayer] setUniforms() called but layer was not created with customFrag. ' +
          'Uniforms will not be applied. Recreate the layer with customFrag and uniforms options.'
      )
      return
    }
    this.customUniforms = { ...this.customUniforms, ...uniforms }
    this.customShaderConfig.customUniforms = this.customUniforms
    this.invalidate()
  }

  async setVariable(variable: string) {
    if (variable === this.variable) return

    this.metadataLoading = true
    this.emitLoadingState()

    try {
      this.initError = null
      this.variable = variable
      this.removeAccessListener?.()
      this.removeAccessListener = null
      this.prefetchQueue.clear()
      this.resetPrefetchWindow()
      this.timestepKeys.clear()
      this.displayedReads = null
      this.keyBytes.clear()
      if (this.zarrStore) {
        this.zarrStore.cleanup()
        this.zarrStore = null
      }
      this.dimensionValues = {}
      this._fillValue = null
      // Reset and recompute fixedDataScale from current clim for new mode
      this.dataScaleLocked = false
      this.fixedDataScale = Math.max(
        Math.abs(this.clim[0]),
        Math.abs(this.clim[1]),
        1
      )
      await this.initialize()
      await this.initializeMode()
      this.invalidate()
    } catch (err) {
      this.initError = err instanceof Error ? err : new Error(String(err))
      console.error('[zarr-layer] Failed to reset:', this.initError.message)
      if (this.mode && this.gl) {
        this.mode.dispose(this.gl)
        this.mode = null
      }
      this.removeAccessListener?.()
      this.removeAccessListener = null
      this.prefetchQueue.clear()
      this.resetPrefetchWindow()
      this.timestepKeys.clear()
      this.displayedReads = null
      this.keyBytes.clear()
      if (this.zarrStore) {
        this.zarrStore.cleanup()
        this.zarrStore = null
      }
    } finally {
      this.metadataLoading = false
      this.emitLoadingState()
    }
  }

  async setSelector(selector: Selector) {
    const normalized = normalizeSelector(selector)
    const nextHash = this.computeSelectorHash(normalized)
    if (nextHash === this.selectorHash) {
      return
    }
    const previousSelection = this.currentSelection()
    this.selectorHash = nextHash
    this.selector = selector
    this.normalizedSelector = normalized
    this.selectionCache = null
    this.protectedKeys = null
    // A different selection (e.g. ensemble member): queued and in-flight
    // prefetch steps are for the old one, so drop them. Synchronous, before
    // any await, so a prefetchTimeSteps call right after setSelector queues
    // steps for the new selection. Recorded step keys are kept: they are
    // per selection, so switching back reads as cached without a refetch.
    // The window is forgotten too: its indices were sent for the old
    // selection, so they must not protect or refill the new one's steps
    // (the caller sends a window for the new selection).
    if (this.currentSelection() !== previousSelection) {
      this.prefetchQueue.clear()
      this.resetPrefetchWindow()
    }

    this.bandNames = getBands(this.variable, this.normalizedSelector)
    if (this.bandNames.length > 1 || this.customFrag) {
      this.customShaderConfig = {
        bands: this.bandNames,
        customFrag: this.customFrag,
        customUniforms: this.customUniforms,
      }
    } else {
      this.customShaderConfig = null
    }

    if (this.mode) {
      await this.mode.setSelector(this.normalizedSelector)
    }

    this.invalidate()
  }

  /**
   * Pre-fetch chunk data for the given time step indices.
   * Populates the chunk cache in the background so that future
   * setSelector() calls for these time steps are instant.
   *
   * Incremental: each call replaces the wanted window (in priority order).
   * Steps being fetched keep running if they are still in the new list and
   * are aborted only if they are not; queued steps no longer listed are
   * dropped, and cached steps are skipped. Up to `prefetchConcurrency` steps
   * (default 4) are fetched at once, with at most `prefetchMaxRequests`
   * chunk requests (default 12) in flight across them.
   *
   * @param timeIndices - Array of time step indices to pre-fetch
   * @param timeDimName - Name of the time dimension (default: 'time')
   */
  prefetchTimeSteps(timeIndices: number[], timeDimName: string = 'time'): void {
    if (!this.mode?.prefetchTimeSteps) return
    if (timeDimName !== this.prefetchTimeDimName) {
      this.prefetchTimeDimName = timeDimName
      this.selectionCache = null
    }
    const indices = [...new Set(timeIndices)].filter(
      (idx) => Number.isInteger(idx) && idx >= 0
    )
    // Drop the previous window first, with its pending refill check: an armed
    // timer would otherwise fire early for this window (its idle callback
    // sees the timer and doesn't start its own WINDOW_REFILL_DELAY_MS).
    this.resetPrefetchWindow()
    this.prefetchWindow = { indices, dim: timeDimName }
    this.prefetchQueue.set(indices, timeDimName)
  }

  /** Forget the prefetch window and cancel a pending refill check. */
  private resetPrefetchWindow(): void {
    this.prefetchWindow = null
    this.windowRefills = 0
    this.protectedKeys = null
    if (this.refillTimer !== null) {
      clearTimeout(this.refillTimer)
      this.refillTimer = null
    }
  }

  /**
   * CachingStore eviction tier of a key (see `CachingStore.setEvictionPolicy`):
   * keys of the displayed step are kept longest, then keys of the prefetch
   * window's steps, and everything else (steps behind the playhead, an old
   * window, metadata) is evicted first, LRU. Window keys get a priority in
   * [EVICTION_TIER_WINDOW, EVICTION_TIER_DISPLAYED) by their step's window
   * position (see getProtectedKeys), so a window that doesn't fit the
   * budget evicts inside itself from its far end.
   */
  private evictionPriority(cacheKey: string): number {
    const keys = this.getProtectedKeys()
    if (keys.displayed.has(cacheKey)) return EVICTION_TIER_DISPLAYED
    return keys.window.get(cacheKey) ?? EVICTION_TIER_OTHER
  }

  /**
   * Window keys map to a priority inside the window tier by the step's
   * position (the window is in priority order): from just under
   * EVICTION_TIER_DISPLAYED for the first step down to EVICTION_TIER_WINDOW
   * for the last. So a window over the budget (an estimate that was low)
   * evicts its farthest steps first, not the least recently used ones,
   * which are the steps nearest the playhead (fetched first). A key shared
   * by several steps takes the nearest one's.
   */
  private getProtectedKeys(): {
    window: Map<string, number>
    displayed: Set<string>
  } {
    if (this.protectedKeys) return this.protectedKeys
    const selection = this.currentSelection()
    const window = new Map<string, number>()
    const indices = this.prefetchWindow?.indices ?? []
    const n = indices.length
    indices.forEach((idx, pos) => {
      const entry = this.timestepKeys.get(this.stepKey(idx, selection))
      if (!entry) return
      const priority =
        EVICTION_TIER_WINDOW +
        ((n - 1 - pos) / n) * (EVICTION_TIER_DISPLAYED - EVICTION_TIER_WINDOW)
      for (const key of entry.keys) {
        if (!window.has(key)) window.set(key, priority)
      }
    })
    const displayed = new Set<string>()
    const timeIdx = this.getCurrentTimeIdx()
    if (timeIdx !== null) {
      const step = this.stepKey(timeIdx, selection)
      const entry = this.timestepKeys.get(step)
      // The step's last complete view plus what it has read since it
      // became displayed, not every key it ever read (other zoom levels)
      for (const key of entry?.completeKeys ?? entry?.keys ?? []) {
        displayed.add(key)
      }
      if (this.displayedReads?.step === step) {
        for (const key of this.displayedReads.keys) displayed.add(key)
      }
    }
    this.protectedKeys = { window, displayed }
    return this.protectedKeys
  }

  /** Make `cachingStore` evict by this layer's tiers (evictionPriority). */
  private installEvictionPolicy(cachingStore: CachingStore): void {
    this.protectedKeys = null
    cachingStore.setEvictionPolicy({
      priority: (key) => this.evictionPriority(key),
      onEvict: this.handleEviction,
    })
  }

  /**
   * An evicted protected key may leave a hole in the window. The size is
   * remembered too: an entry evicted between being stored and its access
   * being reported (an over-budget window, several steps in flight) would
   * otherwise have no known size for the estimate and the refill's budget
   * check.
   */
  private handleEviction = (
    key: string,
    tier: number,
    byteSize: number
  ): void => {
    if (!this.keyBytes.has(key)) this.keyBytes.set(key, byteSize)
    if (tier >= EVICTION_TIER_WINDOW && !this.prefetchQueue.busy) {
      this.scheduleWindowRefill()
    }
  }

  private scheduleWindowRefill(): void {
    if (this.refillTimer !== null || !this.prefetchWindow || this.isRemoved) {
      return
    }
    this.refillTimer = setTimeout(() => {
      this.refillTimer = null
      this.refillWindow()
    }, WINDOW_REFILL_DELAY_MS)
  }

  /**
   * Refetch the holes of the last prefetch window when the queue is idle:
   * steps that read chunks which are no longer all resident (evicted, or a
   * fetch cut short), so they refill without waiting for the caller's next
   * move. A step whose latest fetch failed is not a hole: the prefetch
   * queue already retried it with backoff (task 44), and retrying it here
   * too would multiply its attempts against the request budget. Skipped
   * when the window
   * doesn't fit the cache budget (refilling would only evict another of its
   * steps), and at most MAX_WINDOW_REFILLS times per window.
   */
  private refillWindow(): void {
    const window = this.prefetchWindow
    if (!window || window.indices.length === 0) return
    if (this.prefetchQueue.busy || this.metadataLoading || this.isRemoved) {
      return
    }
    if (window.dim !== this.prefetchTimeDimName) return
    if (this.windowRefills >= MAX_WINDOW_REFILLS) return
    // A hole is a step that read chunks which are no longer all resident,
    // and whose latest fetch didn't fail. A step with no recorded keys is
    // left to the caller's next window: its fetch read nothing (every chunk
    // absent, e.g. a sparse store, or it failed before any read), and
    // refetching it would only repeat that.
    const selection = this.currentSelection()
    const status = this.getCacheStatus(window.indices)
    const holes = window.indices.filter((idx) => {
      if (status[idx] === 'cached') return false
      const entry = this.timestepKeys.get(this.stepKey(idx, selection))
      return !!entry && entry.keys.size > 0 && !entry.lastFetchFailed
    })
    if (holes.length === 0) return
    if (!this.windowFitsBudget(window.indices)) return
    this.windowRefills++
    // Only the holes, at their positions in the window (requeue keeps the
    // queue's window, so the near rule and shard batching apply as for the
    // window itself)
    this.prefetchQueue.requeue(holes, window.dim)
  }

  /**
   * Whether the window's steps (and the displayed step) fit the cache
   * budget: the known sizes of their complete (else recorded) keys, each
   * entry counted once, plus the per-step estimate for steps with no keys.
   */
  private windowFitsBudget(indices: number[]): boolean {
    const cachingStore = this.zarrStore?.cachingStore
    if (!cachingStore) return false
    const selection = this.currentSelection()
    const estimate = this.getEstimatedTimestepBytes() ?? 0
    const seen = new Set<string>()
    let bytes = 0
    const steps = new Set(indices)
    const current = this.getCurrentTimeIdx()
    if (current !== null) steps.add(current)
    for (const idx of steps) {
      const entry = this.timestepKeys.get(this.stepKey(idx, selection))
      const keys = entry?.completeKeys ?? entry?.keys
      if (!keys || keys.size === 0) {
        bytes += estimate
        continue
      }
      for (const key of keys) {
        if (seen.has(key)) continue
        seen.add(key)
        bytes += this.keyBytes.get(key) ?? 0
      }
    }
    return bytes <= cachingStore.maxBytes
  }

  /**
   * Time steps per prefetch batch: the shard extent along the time dim of a
   * sharded v3 array read by range (ace-viz task 44), else 1. The prefetch
   * queue starts the steps of one batch together so their inner-chunk
   * ranges coalesce into few requests; a caller building windows can align
   * a window's far end to a batch boundary (the ace-viz webapp does). Whole
   * objects (`rangeRequests` off, or after a fallback) and batches above
   * MAX_PREFETCH_BATCH steps (e.g. a 100 km shard of 400 steps) give 1.
   */
  getPrefetchBatchSize(): number {
    const store = this.zarrStore
    if (!store?.shards || !store.cachingStore?.rangeRequests) return 1
    // Not in the bootstrap window: batch once a step has been measured
    if (this.getEstimatedTimestepBytes() === null) return 1
    const timeIdx = store.dimensions.indexOf(this.prefetchTimeDimName)
    let size = timeIdx === -1 ? 1 : store.shards[timeIdx]
    if (!Number.isInteger(size) || size > MAX_PREFETCH_BATCH) return 1
    // At most prefetchBatchSteps: halve an even shard extent (Morton order
    // keeps each aligned half of a shard's steps contiguous, e.g. steps 0-1
    // and 2-3 of a 4-step shard)
    while (size > this.prefetchBatchSteps && size % 2 === 0) size /= 2
    return size >= 2 && size <= this.prefetchBatchSteps ? size : 1
  }

  /**
   * The current values of the non-time, non-spatial selector dims, as a
   * stable string (e.g. `{"member":{"selected":3,"type":"index"}}`).
   */
  private currentSelection(): string {
    if (this.selectionCache === null) {
      const rest: NormalizedSelector = {}
      for (const [dim, spec] of Object.entries(this.normalizedSelector)) {
        if (dim === this.prefetchTimeDimName) continue
        if (SPATIAL_DIM_NAMES.has(dim.toLowerCase())) continue
        rest[dim] = spec
      }
      this.selectionCache = this.computeSelectorHash(rest)
    }
    return this.selectionCache
  }

  /** Internal timestepKeys key: time index + selection. */
  private stepKey(timeIndex: number, selection: string): string {
    return `${timeIndex}|${selection}`
  }

  /**
   * Queue primitive: fetch one step through the current mode. Resolves false
   * when the step can't be fetched yet (so the queue retries it): while
   * metadata is loading (initial add, or setVariable, where the old mode is
   * still installed until the new one is built) or when the mode says so.
   */
  private async prefetchOneStep(
    timeIdx: number,
    timeDimName: string,
    signal: AbortSignal,
    info: PrefetchStepInfo
  ): Promise<boolean | 'failed'> {
    if (this.metadataLoading) return false
    const mode = this.mode
    if (!mode?.prefetchTimeSteps) return true
    // One signal per step, so with several steps in flight each access is
    // still attributed to the step whose request made it.
    const selection = this.currentSelection()
    // Keys this fetch reads, for the per-step byte estimate
    const keys = new Set<string>()
    this.prefetchSignals.set(signal, { timeIndex: timeIdx, selection, keys })
    // Steps of one shard batch share a limiter group, so their chunk reads
    // go out together and coalesce (task 44)
    const limiterOptions = { priority: info.seq, signal, group: info.batch }
    let failed = false
    try {
      const done = await mode.prefetchTimeSteps(
        [timeIdx],
        timeDimName,
        signal,
        {
          createQueue: () => this.prefetchLimiter.chunkQueue(limiterOptions),
          onFetchError: () => {
            failed = true
          },
        }
      )
      // Modes also resolve true when aborted, so check the signal: only a
      // step that ran to completion without a failed chunk fetch read its
      // full key set.
      if (done !== false && !signal.aborted && !failed && keys.size > 0) {
        const entry = this.timestepKeys.get(this.stepKey(timeIdx, selection))
        if (entry) {
          entry.measuredKeys = keys
          entry.measuredSeq = ++this.measureCount
          // Exactly the step's chunks for the regions in view
          entry.completeKeys = keys
          this.protectedKeys = null
        }
      }
      if (done === false) return false
      const entry = this.timestepKeys.get(this.stepKey(timeIdx, selection))
      if (!signal.aborted && entry) entry.lastFetchFailed = failed
      // A failed read: the queue retries the step with backoff (task 44)
      return failed && !signal.aborted ? 'failed' : true
    } finally {
      this.prefetchSignals.delete(signal)
    }
  }

  /** Read the layer's currently-selected time index, if any. */
  private getCurrentTimeIdx(): number | null {
    const spec = this.normalizedSelector?.[this.prefetchTimeDimName]
    if (spec && spec.type === 'index' && typeof spec.selected === 'number') {
      return spec.selected
    }
    return null
  }

  /**
   * CachingStore access listener: attribute a chunk key to the prefetch step
   * whose request made the access (by its signal), else to the displayed step.
   */
  private attributeChunkAccess(cacheKey: string, opts?: GetOptions): void {
    const step = opts?.signal
      ? this.prefetchSignals.get(opts.signal)
      : undefined
    if (step) {
      this.recordChunkAccess(step.timeIndex, step.selection, cacheKey)
      step.keys.add(cacheKey)
      return
    }
    const timeIdx = this.getCurrentTimeIdx()
    if (timeIdx !== null) {
      const selection = this.currentSelection()
      this.recordChunkAccess(timeIdx, selection, cacheKey)
      const step = this.stepKey(timeIdx, selection)
      if (this.displayedReads?.step !== step) {
        this.displayedReads = { step, keys: new Set() }
      }
      this.displayedReads.keys.add(cacheKey)
    }
  }

  /** Record a chunk-key access for a step (time index + selection). */
  private recordChunkAccess(
    timeIndex: number,
    selection: string,
    cacheKey: string
  ): void {
    const key = this.stepKey(timeIndex, selection)
    let entry = this.timestepKeys.get(key)
    if (!entry) {
      entry = {
        timeIndex,
        selection,
        keys: new Set(),
        measuredKeys: null,
        measuredSeq: 0,
        completeKeys: null,
        lastFetchFailed: false,
      }
      this.timestepKeys.set(key, entry)
    }
    entry.keys.add(cacheKey)
    this.protectedKeys = null
    // Listeners run after the entry is stored, so it is resident here
    const bytes = this.zarrStore?.cachingStore?.getEntryBytes(cacheKey)
    if (bytes !== undefined) this.keyBytes.set(cacheKey, bytes)
  }

  /** Recorded steps of the current selection. */
  private currentSelectionSteps(): StepKeys[] {
    const selection = this.currentSelection()
    const out: StepKeys[] = []
    for (const entry of this.timestepKeys.values()) {
      if (entry.selection === selection) out.push(entry)
    }
    return out
  }

  /**
   * Check whether chunk data for a given time step index is currently
   * resident in the chunk cache. Used by animation loops to detect buffering.
   */
  isTimeStepCached(timeIndex: number): boolean {
    return this.getCacheStatus([timeIndex])[timeIndex] === 'cached'
  }

  /**
   * Get cache status for multiple time step indices, for the current values
   * of the other selector dims (e.g. the selected ensemble member).
   * Returns 'cached' when a fetch of the step completed (a prefetch, or a
   * render of it while displayed) and all of that fetch's chunks are still
   * resident; 'partial' when some of the step's recorded chunks are resident
   * but it is not 'cached' (e.g. a prefetch aborted partway, or an evicted
   * chunk); 'missing' when none are resident or it was never fetched.
   */
  getCacheStatus(
    timeIndices: number[]
  ): Record<number, 'cached' | 'partial' | 'missing'> {
    const result: Record<number, 'cached' | 'partial' | 'missing'> = {}
    const cachingStore = this.zarrStore?.cachingStore ?? null
    const selection = this.currentSelection()
    for (const idx of timeIndices) {
      const entry = this.timestepKeys.get(this.stepKey(idx, selection))
      const keys = entry?.keys
      if (!entry || !keys || keys.size === 0) {
        result[idx] = 'missing'
        continue
      }
      const complete = entry.completeKeys
      if (!cachingStore) {
        // Unreachable in practice: keys are recorded by the CachingStore's
        // access listener, so without a cache no step has keys.
        result[idx] = complete ? 'cached' : 'partial'
        continue
      }
      if (complete) {
        let all = true
        for (const key of complete) {
          if (!cachingStore.has(key)) {
            all = false
            break
          }
        }
        if (all) {
          result[idx] = 'cached'
          continue
        }
      }
      let hits = 0
      for (const key of keys) {
        if (cachingStore.has(key)) hits++
      }
      result[idx] = hits === 0 ? 'missing' : 'partial'
    }
    return result
  }

  /**
   * Average number of chunk keys recorded per time step. Returns 0 before
   * any fetch has completed. Consumers (e.g. cache indicators) can use this
   * to size segments so each segment represents a comparable amount of work
   * across coarse (1 chunk/step) and high-res (many chunks/step) datasets.
   */
  getChunksPerTimestep(): number {
    if (this.timestepKeys.size === 0) return 0
    let total = 0
    for (const { keys } of this.timestepKeys.values()) total += keys.size
    return total / this.timestepKeys.size
  }

  /**
   * Average chunk-cache bytes one time step of the current selection costs,
   * measured from the steps' own keys: the average, over the most recently
   * measured steps (up to 16, so it follows a zoom or pan), of the byte
   * sizes of the keys each step's latest completed prefetch read (see
   * `StepKeys.measuredKeys`). A cache entry
   * read by k such steps (e.g. a shard holding several time steps) counts
   * 1/k towards each. Entries no prefetch read (metadata, coordinate arrays,
   * render reads) do not count. Sizes are remembered when a key is
   * recorded, so eviction or a budget change does not change the estimate.
   *
   * Returns null until a prefetch step has completed: keys of an in-flight
   * or render-only step can be a partial set, which would underestimate.
   * Only untiled mode prefetches, so in tiled mode this is always null.
   * Until a shard's neighbouring steps are measured, its whole size counts
   * towards the one step that read it, so the early estimate errs high.
   *
   * If one chunk fails on every step, no step is measured and this stays
   * null (callers keep their bootstrap window).
   *
   * O(measured keys of the current selection); cheap enough to poll.
   */
  getEstimatedTimestepBytes(): number | null {
    if (!this.zarrStore?.cachingStore) return null
    const measured: { keys: Set<string>; seq: number }[] = []
    for (const { measuredKeys, measuredSeq } of this.currentSelectionSteps()) {
      if (measuredKeys) measured.push({ keys: measuredKeys, seq: measuredSeq })
    }
    // Sharing counts every measured step: a neighbour measured earlier
    // still shares the entry (and keys of another view are distinct keys)
    const sharedBy = new Map<string, number>()
    for (const { keys } of measured) {
      for (const key of keys) sharedBy.set(key, (sharedBy.get(key) ?? 0) + 1)
    }
    measured.sort((a, b) => b.seq - a.seq)
    let total = 0
    let counted = 0
    for (const { keys } of measured) {
      if (counted === ESTIMATE_RECENT_STEPS) break
      let bytes = 0
      for (const key of keys) {
        const size = this.keyBytes.get(key)
        if (size !== undefined) bytes += size / sharedBy.get(key)!
      }
      if (bytes > 0) {
        total += bytes
        counted++
      }
    }
    return counted > 0 ? total / counted : null
  }

  /**
   * Number of *additional* time steps the chunk cache has room for beyond
   * the currently-displayed one, leaving headroom (default 90%). Reserves
   * one step's worth of bytes for the current selector so prefetching never
   * evicts what the user is actively viewing.
   *
   * Returns null while there is no per-step cost estimate, i.e. until the
   * first prefetch step completes (see `getEstimatedTimestepBytes`; always
   * in tiled mode, which does not prefetch).
   * Callers should treat null as "prefetch a small bootstrap window": the
   * estimate becomes available as those steps land.
   */
  getRecommendedPrefetchCount(safetyFactor: number = 0.9): number | null {
    const cachingStore = this.zarrStore?.cachingStore ?? null
    if (!cachingStore) return null
    const perStep = this.getEstimatedTimestepBytes()
    if (perStep === null || perStep <= 0) return null
    const budget = cachingStore.maxBytes * safetyFactor - perStep
    if (budget <= 0) return 0
    return Math.floor(budget / perStep)
  }

  /**
   * Resize the chunk cache of a live layer. Shrinking evicts
   * least-recently-used entries immediately; growing never evicts. Because
   * `getRecommendedPrefetchCount` reads the live budget, the prefetch window
   * follows the new size on its next call. `0` empties the cache (see
   * `CachingStore.setMaxBytes`); restoring the previous value afterwards
   * acts as "clear cache".
   *
   * Internal secondary caches (untiled mode's normalized-data cache) are
   * rescaled with it, so this is the single memory knob for the layer.
   *
   * If called before the store is initialized the value is used when the
   * cache is created. Whether the cache exists is fixed at construction: on
   * a layer constructed with `maxChunkCacheBytes: 0` this is a no-op, and a
   * budget of 0 keeps an empty cache in place (also across `setVariable` or
   * remove/re-add) so a later positive budget resumes caching.
   *
   * Fractional values are floored. An invalid value (non-finite or
   * negative) is ignored with a warning and the current budget is kept.
   */
  setMaxChunkCacheBytes(bytes: number): void {
    const valid = validCacheBytes(bytes)
    if (valid === null) {
      console.warn(
        `[ZarrLayer] Ignoring invalid chunk cache budget ${bytes}; ` +
          `keeping the current budget.`
      )
      return
    }
    if (!this.chunkCacheEnabled) return
    this.maxChunkCacheBytes = valid
    this.zarrStore?.setMaxChunkCacheBytes(this.maxChunkCacheBytes)
    this.mode?.setNormalizedCacheBytes?.(
      normalizedCacheBytesFor(this.maxChunkCacheBytes)
    )
  }

  /**
   * Diagnostic snapshot of the chunk cache state vs. recorded keys.
   * Useful for tuning maxChunkCacheBytes when the indicator is stuck at
   * 'partial' for a high-resolution dataset. `timestepsRecorded` and
   * `perTimestepHits` cover the current selection (other non-time dims);
   * `avgChunksPerTimestep` averages over every recorded step.
   */
  getCacheDebugInfo(): {
    maxBytes: number | null
    usedBytes: number | null
    chunksInCache: number | null
    timestepsRecorded: number
    avgChunksPerTimestep: number
    perTimestepHits: { timeIndex: number; recorded: number; hits: number }[]
  } {
    const cachingStore = this.zarrStore?.cachingStore ?? null
    const perTimestepHits: {
      timeIndex: number
      recorded: number
      hits: number
    }[] = []
    const steps = this.currentSelectionSteps()
    for (const { timeIndex, keys } of steps) {
      let hits = 0
      if (cachingStore) {
        for (const key of keys) if (cachingStore.has(key)) hits++
      }
      perTimestepHits.push({ timeIndex, recorded: keys.size, hits })
    }
    perTimestepHits.sort((a, b) => a.timeIndex - b.timeIndex)
    return {
      maxBytes: cachingStore?.maxBytes ?? null,
      usedBytes: cachingStore?.getTotalBytes() ?? null,
      chunksInCache: cachingStore?.size ?? null,
      timestepsRecorded: steps.length,
      avgChunksPerTimestep: this.getChunksPerTimestep(),
      perTimestepHits,
    }
  }

  onAdd(
    map: MapLike,
    gl: WebGL2RenderingContext | WebGLRenderingContext
  ): void {
    this._onAddAsync(map, gl)
  }

  private async _onAddAsync(
    map: MapLike,
    gl: WebGL2RenderingContext | WebGLRenderingContext
  ): Promise<void> {
    this.map = map
    const resolvedGl = this.resolveGl(map, gl)
    this.gl = resolvedGl
    this.invalidate = () => {
      this.tileNeedsRender = true
      if (map.triggerRepaint) map.triggerRepaint()
    }

    this.initError = null
    this.metadataLoading = true
    this.emitLoadingState()

    try {
      this.colormap.upload(resolvedGl as WebGL2RenderingContext)
      this.renderer = new ZarrRenderer(
        resolvedGl as WebGL2RenderingContext,
        this.fragmentShaderSource
      )

      this.projectionChangeHandler = () => {
        const isGlobe = this.isGlobeProjection()
        if (this.lastIsGlobe !== isGlobe) {
          this.mode?.onProjectionChange(isGlobe)
          this.lastIsGlobe = isGlobe
        }
        this.configureMapboxRenderPath()
      }
      if (typeof map.on === 'function' && this.projectionChangeHandler) {
        map.on('projectionchange', this.projectionChangeHandler)
        map.on('style.load', this.projectionChangeHandler)
        map.on('move', this.projectionChangeHandler)
      }

      await this.initialize()
      await this.initializeMode()
      this.configureMapboxRenderPath()

      const isGlobe = this.isGlobeProjection()
      this.lastIsGlobe = isGlobe
      this.mode?.onProjectionChange(isGlobe)

      this.mode?.update(this.map, this.gl!)
    } catch (err) {
      this.initError = err instanceof Error ? err : new Error(String(err))
      console.error(
        `[zarr-layer] Failed to initialize: ${this.initError.message}. ` +
          `Use onLoadingStateChange callback to handle errors and call map.removeLayer('${this.id}') to clean up.`
      )
      this._disposeResources(resolvedGl)
    } finally {
      this.metadataLoading = false
      this.emitLoadingState()
    }

    if (!this.initError) {
      this.invalidate()
    }
  }

  private computeSelectorHash(selector: NormalizedSelector): string {
    const sortKeys = (value: unknown): unknown => {
      if (Array.isArray(value) || value === null) return value
      if (typeof value !== 'object') return value

      const obj = value as Record<string, unknown>
      const sorted: Record<string, unknown> = {}
      Object.keys(obj)
        .sort()
        .forEach((k) => {
          sorted[k] = sortKeys(obj[k])
        })
      return sorted
    }

    return JSON.stringify(sortKeys(selector))
  }

  private async initializeMode() {
    if (!this.zarrStore || !this.gl) return

    if (this.mode) {
      this.mode.dispose(this.gl)
    }

    const desc = this.zarrStore.describe()

    // Mode selection based on auto-detected metadata format:
    // - 'tiled' = OME-NGFF style with slippy map tile convention
    // - 'untiled' = zarr-conventions/multiscales format or single-level
    // - 'none' = single-level dataset (also uses UntiledMode)
    if (desc.multiscaleType === 'tiled') {
      this.mode = new TiledMode(
        this.zarrStore,
        this.variable,
        this.normalizedSelector,
        this.invalidate,
        this.throttleMs,
        this.fixedDataScale
      )
    } else {
      // Use UntiledMode for untiled multiscales and single-level datasets
      this.mode = new UntiledMode(
        this.zarrStore,
        this.variable,
        this.normalizedSelector,
        this.invalidate,
        this.throttleMs,
        this.fixedDataScale,
        normalizedCacheBytesFor(this.maxChunkCacheBytes)
      )
    }

    // Lock immediately after mode captures the value, before async initialize()
    this.dataScaleLocked = true

    this.mode.setLoadingCallback(this.handleChunkLoadingChange)
    this.mode.setViewCompleteCallback?.(this.handleViewComplete)
    await this.mode.initialize()

    if (this.map && this.gl) {
      this.mode.update(this.map, this.gl)
    }
  }

  private async initialize(): Promise<void> {
    try {
      this.zarrStore = new ZarrStore({
        source: this.url,
        version: this.zarrVersion,
        variable: this.variable,
        spatialDimensions: this.spatialDimensions,
        bounds: this.bounds,
        crs: this.crs,
        latIsAscending: this.latIsAscending,
        coordinateKeys: Object.keys(this.selector),
        proj4: this.proj4,
        transformRequest: this.transformRequest,
        customStore: this.customStore,
        maxChunkCacheBytes: this.maxChunkCacheBytes,
        chunkCacheEnabled: this.chunkCacheEnabled,
        rangeRequests: this.rangeRequests,
      })

      await this.zarrStore.initialized

      // Install a continuous access listener so chunks fetched during render
      // frames (which happen asynchronously, not inside setSelector) are
      // attributed to a time step. Prefetch iterations override the default
      // attribution per request (see prefetchSignals).
      if (this.zarrStore.cachingStore) {
        this.removeAccessListener?.()
        this.removeAccessListener =
          this.zarrStore.cachingStore.addAccessListener((cacheKey, opts) => {
            this.attributeChunkAccess(cacheKey, opts)
          })
        this.installEvictionPolicy(this.zarrStore.cachingStore)
        // Prefetch reads (a registered step signal) take the request gate's
        // background lane, so render reads go first (ace-viz task 49)
        this.zarrStore.cachingStore.setBackgroundClassifier(
          (opts) => !!opts?.signal && this.prefetchSignals.has(opts.signal)
        )
      }

      const desc = this.zarrStore.describe()

      this.levelInfos = desc.levels
      this.dimIndices = desc.dimIndices
      this.scaleFactor = desc.scaleFactor
      this.offset = desc.addOffset

      if (
        this._fillValue === null &&
        desc.fill_value !== null &&
        desc.fill_value !== undefined
      ) {
        this._fillValue = desc.fill_value
      }

      this.normalizedSelector = normalizeSelector(this.selector)
      await this.loadInitialDimensionValues()

      this.bandNames = getBands(this.variable, this.normalizedSelector)
      if (this.bandNames.length > 1 || this.customFrag) {
        this.customShaderConfig = {
          bands: this.bandNames,
          customFrag: this.customFrag,
          customUniforms: this.customUniforms,
        }
      } else {
        this.customShaderConfig = null
      }
    } catch (err) {
      // Clean up partially-initialized store before re-throwing
      if (this.zarrStore) {
        this.zarrStore.cleanup()
        this.zarrStore = null
      }
      throw err
    }
  }

  private async loadInitialDimensionValues(): Promise<void> {
    if (!this.zarrStore?.root) return

    const multiscaleLevel =
      this.levelInfos.length > 0 ? this.levelInfos[0] : null

    for (const [dimName, value] of Object.entries(this.selector)) {
      this.normalizedSelector[dimName] = toSelectorProps(value)
    }
    for (const dimName of Object.keys(this.dimIndices)) {
      // Skip spatial dimensions - don't load coordinate arrays for these
      if (!SPATIAL_DIM_NAMES.has(dimName.toLowerCase())) {
        try {
          this.dimensionValues[dimName] = await loadDimensionValues(
            this.dimensionValues,
            multiscaleLevel,
            this.dimIndices[dimName],
            this.zarrStore.root,
            this.zarrStore.version
          )

          if (!this.normalizedSelector[dimName]) {
            this.normalizedSelector[dimName] = { selected: 0 }
          }
        } catch (err) {
          console.warn(`Failed to load dimension values for ${dimName}:`, err)
        }
      }
    }
  }

  private isZoomInRange(): boolean {
    if (!this.map?.getZoom) return true
    // In MapLibre globe mode, pole enlargement compensation can push
    // getZoom() negative. Clamp to 0 so that artifact alone doesn't
    // hide the layer.
    const zoom = Math.max(0, this.map.getZoom())
    return zoom >= this.minZoom && zoom <= this.maxZoom
  }

  prerender(
    _gl: WebGL2RenderingContext | WebGLRenderingContext,
    _params: unknown
  ) {
    if (this.isRemoved || !this.gl || !this.mode || !this.map) return
    if (!this.isZoomInRange()) return

    this.syncProjectionState()
    this.mode.update(this.map, this.gl)
  }

  render(
    _gl: WebGL2RenderingContext | WebGLRenderingContext,
    params: unknown,
    projection?: { name: string },
    projectionToMercatorMatrix?: number[] | Float32Array | Float64Array,
    projectionToMercatorTransition?: number,
    _centerInMercator?: number[],
    _pixelsPerMeterRatio?: number
  ) {
    if (
      this.isRemoved ||
      !this.renderer ||
      !this.gl ||
      !this.mode ||
      !this.map
    ) {
      return
    }

    if (!this.isZoomInRange()) {
      return
    }

    this.configureMapboxRenderPath()

    const projectionParams = resolveProjectionParams(
      params,
      projection,
      projectionToMercatorMatrix,
      projectionToMercatorTransition
    )

    if (!projectionParams.matrix) {
      return
    }

    // Legacy MapLibre (no shaderData): fall back to mapbox-style shader path
    // using identity globe-to-merc matrix + transition=1 (pure mercator).
    const legacyMapboxFallback =
      !projectionParams.mapbox && !projectionParams.shaderData
        ? {
            projection: { name: 'mercator' },
            globeToMercatorMatrix: MAPBOX_IDENTITY_MATRIX,
            transition: 1,
          }
        : undefined

    const isGlobe = this.isGlobeProjection()
    const worldOffsets = computeWorldOffsets(this.map, isGlobe)
    const colormapTexture = this.colormap.ensureTexture(this.gl)
    let expandedFarZMercatorMatrix: Float32Array | undefined
    if (projectionParams.mapbox?.projection.name === 'globe') {
      // FRAGILE: Mapbox's internal globe raster pass uses expandedFarZProjMatrix,
      // while customLayerMatrix() uses the regular far plane. Scale the
      // projection matrix by worldSize so the direct ECEF path shares the globe
      // surface's depth behavior.
      const { expandedFarZProjMatrix, worldSize } = getMapboxGlobeInternals(
        this.map
      )
      if (expandedFarZProjMatrix && worldSize) {
        expandedFarZMercatorMatrix = scaleMercatorMatrix(
          expandedFarZProjMatrix,
          worldSize
        )
      }
    }

    const context: RenderContext = {
      gl: this.gl,
      matrix: projectionParams.matrix,
      uniforms: {
        clim: this.clim,
        opacity: this.opacity,
        fillValue: this._fillValue,
        scaleFactor: this.scaleFactor,
        offset: this.offset,
        fixedDataScale: this.fixedDataScale,
      },
      colormapTexture,
      worldOffsets,
      customShaderConfig: this.customShaderConfig || undefined,
      shaderData: projectionParams.shaderData,
      projectionData: projectionParams.projectionData,
      mapbox: projectionParams.mapbox
        ? {
            ...projectionParams.mapbox,
            directGlobePathActive: this.usingDirectMapboxGlobePath,
            expandedFarZMercatorMatrix:
              projectionParams.mapbox.projection.name === 'globe'
                ? expandedFarZMercatorMatrix
                : undefined,
          }
        : legacyMapboxFallback,
    }

    this.mode.render(this.renderer, context)

    this.tileNeedsRender = false
  }

  renderToTile(
    _gl: WebGL2RenderingContext | WebGLRenderingContext,
    tileId: { z: number; x: number; y: number }
  ) {
    if (
      this.isRemoved ||
      !this.renderer ||
      !this.gl ||
      !this.mode ||
      !this.map
    ) {
      return
    }

    this.configureMapboxRenderPath()

    const isGlobe = this.syncProjectionState()
    this.mode.update(this.map, this.gl)

    const colormapTexture = this.colormap.ensureTexture(this.gl)

    const context: RenderContext = {
      gl: this.gl,
      matrix: new Float32Array(16),
      uniforms: {
        clim: this.clim,
        opacity: this.opacity,
        fillValue: this._fillValue,
        scaleFactor: this.scaleFactor,
        offset: this.offset,
        fixedDataScale: this.fixedDataScale,
      },
      colormapTexture,
      worldOffsets: [0],
      customShaderConfig: this.customShaderConfig || undefined,
      isGlobe,
    }

    this.tileNeedsRender =
      this.mode.renderToTile?.(this.renderer, tileId, context) ?? false
  }

  // Mapbox specific custom layer method required to trigger rerender on eg dataset update.
  shouldRerenderTiles() {
    const needsRender = this.tileNeedsRender
    this.tileNeedsRender = false
    return needsRender
  }

  /**
   * Dispose all GL resources and internal state.
   * Does NOT remove the layer from the map - call map.removeLayer(id) for that.
   */
  private _disposeResources(
    gl: WebGL2RenderingContext | WebGLRenderingContext
  ): void {
    this.isRemoved = true

    this.renderer?.dispose()
    this.renderer = null

    this.colormap.dispose(gl)

    this.prefetchQueue.clear()
    this.resetPrefetchWindow()
    this.mode?.dispose(gl)
    this.mode = null

    this.removeAccessListener?.()
    this.removeAccessListener = null

    if (this.zarrStore) {
      this.zarrStore.cleanup()
      this.zarrStore = null
    }

    if (
      this.map &&
      this.projectionChangeHandler &&
      typeof this.map.off === 'function'
    ) {
      this.map.off('projectionchange', this.projectionChangeHandler)
      this.map.off('style.load', this.projectionChangeHandler)
      this.map.off('move', this.projectionChangeHandler)
    }
  }

  onRemove(_map: MapLike, gl: WebGL2RenderingContext | WebGLRenderingContext) {
    const resolvedGl = this.gl ?? this.resolveGl(_map, gl)
    this._disposeResources(resolvedGl)
  }

  // ========== Query Interface ==========

  /**
   * Query all data values within a geographic region.
   * @param geometry - GeoJSON Point, Polygon or MultiPolygon geometry.
   * @param selector - Optional selector to override the layer's selector.
   * @returns Promise resolving to the query result matching carbonplan/maps structure.
   */
  async queryData(
    geometry: QueryGeometry,
    selector?: Selector,
    options?: QueryOptions
  ): Promise<QueryResult> {
    if (!this.mode?.queryData) {
      return {
        [this.variable]: [],
        dimensions: [],
        coordinates: {},
      }
    }
    return this.mode.queryData(geometry, selector, options)
  }
}
