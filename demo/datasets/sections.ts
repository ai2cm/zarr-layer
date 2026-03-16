export type SelectorSection = {
  label: string
  description: string
  datasetIds: string[]
}

export const SELECTOR_SECTIONS: SelectorSection[] = [
  {
    label: 'Multiscale',
    description:
      'Multiscale zarr stores. Uses the zarr-conventions/multiscales format. See topozarr for creation.',
    datasetIds: ['usgsdem', 'sentinel_2_eopf', 'Burn Probability over CONUS'],
  },
  {
    label: 'Single Resolution',
    description: 'Single-resolution datasets. Reprojected if needed.',
    datasetIds: [
      'hrrr_weather',
      'hurricane_florence',
      'polar_antarctic',
      'antarctic_era5',
      'delta_FG_CO2',
    ],
  },
  {
    label: 'Tiled Pyramids',
    description:
      'Stores resampled and rechunked to follow slippy-map tile pyramid conventions (zxy). See ndpyramid for creation',
    datasetIds: ['carbonplan_4d', 'temperature_v3', 'tasmax_pyramid_4326'],
  },
  {
    label: 'Icechunk',
    description:
      'Datasets served from Icechunk, a transactional storage engine for zarr that supports virtual datasets via VirtualiZarr. Uses @carbonplan/icechunk-js reader.',
    datasetIds: ['icechunk_air_temp'],
  },
]
