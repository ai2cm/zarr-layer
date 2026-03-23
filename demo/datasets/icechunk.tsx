import { IcechunkStore } from '@carbonplan/icechunk-js'
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
  zarrVersion: 3,
  info: 'IMERG Precipitation (Virtualized NetCDF Icechunk)',
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
    selector: { time: { selected: 0, type: 'index' } },
  }),
}

export default icechunkPrecip
