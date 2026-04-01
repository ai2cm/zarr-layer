import React from 'react'
import { Box, IconButton, ThemeUIStyleObject } from 'theme-ui'
import { get, useThemeUI } from 'theme-ui'
import { useAppStore } from '../lib/store'

export const useAttributionStyles = (): ThemeUIStyleObject => {
  const { theme } = useThemeUI()
  const primary = get(theme, 'rawColors.primary')
  const secondary = get(theme, 'rawColors.secondary')

  return {
    '& .maplibregl-control-container, & .mapboxgl-control-container': {
      fontSize: [0, 0, 1, 1],
      '& .maplibregl-ctrl-attrib, & .mapboxgl-ctrl-attrib': {
        bg: 'hinted',
        alignItems: 'center',
        border: '1px solid',
        borderColor: 'secondary',
        color: 'primary',
        display: 'flex',
        '& a': { color: 'primary' },
        '& .maplibregl-ctrl-attrib-button, & .mapboxgl-ctrl-attrib-button': {
          bg: 'hinted',
          backgroundImage: `url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' fill-rule='evenodd' viewBox='0 0 20 20'%3E%3Cpath fill='${encodeURIComponent(
            primary
          )}' d='M4 10a6 6 0 1 0 12 0 6 6 0 1 0-12 0m5-3a1 1 0 1 0 2 0 1 1 0 1 0-2 0m0 3a1 1 0 1 1 2 0v3a1 1 0 1 1-2 0'/%3E%3C/svg%3E")`,
          '&:hover, &:focus-visible': {
            backgroundImage: `url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' fill-rule='evenodd' viewBox='0 0 20 20'%3E%3Cpath fill='${encodeURIComponent(
              secondary
            )}' d='M4 10a6 6 0 1 0 12 0 6 6 0 1 0-12 0m5-3a1 1 0 1 0 2 0 1 1 0 1 0-2 0m0 3a1 1 0 1 1 2 0v3a1 1 0 1 1-2 0'/%3E%3C/svg%3E")`,
          },
        },
      },
    },
  }
}

const ZoomButton = ({
  onClick,
  label,
  children,
  border,
}: {
  onClick: () => void
  label: string
  children: React.ReactNode
  border?: boolean
}) => (
  <IconButton
    onClick={onClick}
    aria-label={label}
    sx={{
      cursor: 'pointer',
      width: '24px',
      height: '24px',
      p: 0,
      borderRadius: 0,
      bg: 'hinted',
      border: 'none',
      borderBottom: border ? '1px solid' : 'none',
      borderColor: 'secondary',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'primary',
      '&:hover, &:focus-visible': { color: 'secondary' },
    }}
  >
    {children}
  </IconButton>
)

const ATTRIBUTION_HEIGHT = {
  maplibre: 35,
  mapbox: 20,
}

const MapZoomControls = () => {
  const mapInstance = useAppStore((state) => state.mapInstance)
  const mapProvider = useAppStore((state) => state.mapProvider)

  if (!mapInstance) return null

  const offset = ATTRIBUTION_HEIGHT[mapProvider] + 10

  const zoomIn = () => {
    const zoom = mapInstance.getZoom()
    const bounds = mapInstance.getBounds().toArray()
    const center: [number, number] = [
      (bounds[0][0] + bounds[1][0]) / 2,
      (bounds[0][1] + bounds[1][1]) / 2,
    ]
    mapInstance.easeTo({ center, zoom: zoom + 1 })
  }

  const zoomOut = () => {
    const zoom = mapInstance.getZoom()
    const bounds = mapInstance.getBounds().toArray()
    const center: [number, number] = [
      (bounds[0][0] + bounds[1][0]) / 2,
      (bounds[0][1] + bounds[1][1]) / 2,
    ]
    mapInstance.easeTo({ center, zoom: zoom - 1 })
  }

  return (
    <Box
      sx={{
        position: 'absolute',
        bottom: [
          `calc(50vh + ${offset}px)`,
          `calc(50vh + ${offset}px)`,
          `${offset}px`,
        ],
        right: '10px',
        display: 'flex',
        flexDirection: 'column',
        bg: 'hinted',
        border: '1px solid',
        borderColor: 'secondary',
        borderRadius: '20px',
        overflow: 'hidden',
      }}
    >
      <ZoomButton onClick={zoomIn} label='Zoom in' border>
        <svg width='20' height='20' viewBox='0 0 20 20'>
          <path
            stroke='currentColor'
            strokeWidth='2'
            strokeLinecap='round'
            fill='none'
            d='M10 6v8M6 10h8'
          />
        </svg>
      </ZoomButton>
      <ZoomButton onClick={zoomOut} label='Zoom out'>
        <svg width='20' height='20' viewBox='0 0 20 20'>
          <path
            stroke='currentColor'
            strokeWidth='2'
            strokeLinecap='round'
            fill='none'
            d='M6 10h8'
          />
        </svg>
      </ZoomButton>
    </Box>
  )
}

export default MapZoomControls
