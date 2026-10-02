export { ZarrLayer } from './zarr-layer'
export {
  RequestGate,
  requestGateFor,
  configureRequestGate,
  gatedFetch,
} from './request-gate'
export type { RequestGateOptions } from './request-gate'
export type {
  ZarrLayerOptions,
  ColormapArray,
  SpatialDimensions,
  LoadingState,
  LoadingStateCallback,
  Selector,
  TransformRequest,
  RequestParameters,
} from './types'

// Query interface exports
export type {
  QueryResult,
  QueryDataValues,
  QueryGeometry,
  QueryOptions,
} from './query/types'

// Codec registry — re-export for registering custom codecs
export { registry as codecRegistry } from 'zarrita'
