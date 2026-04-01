import { IcechunkStore } from 'icechunk-js'
import type { Dataset, LayerProps } from './types'

const ICECHUNK_URL =
  'https://carbonplan-share.s3.us-west-2.amazonaws.com/zarr-layer-examples/pipeline/multi_level_virtual_hybrid_icechunk.icechunk'

let _storePromise: Promise<IcechunkStore> | null = null

const icechunkPrecip: Dataset<Record<string, never>> = {
  id: 'icechunk_prec',
  source: ICECHUNK_URL,
  variable: 'IMERG_PRECTOT',
  clim: [0, 10],
  colormap: 'cool',
  bounds: [-180, -90, 180, 90],
  zarrVersion: 3,
  info: 'Virtualized NetCDF of IMERG Precipitation (EPSG:4326)',
  sourceInfo:
    'Virtualized NetCDF of NASA IMERG precipitation stored in Icechunk with native multiscales added.',
  get store() {
    return (_storePromise ??= IcechunkStore.open(ICECHUNK_URL, {
      branch: 'main',
      formatVersion: 'v1',
    }).catch((err) => {
      _storePromise = null
      throw err
    }))
  },
  defaultState: {},
  Controls: () => null,
  buildLayerProps: (): LayerProps => ({
    selector: {},
  }),
}

export default icechunkPrecip
