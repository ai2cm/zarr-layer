import { useRef, useEffect } from 'react'
import { Box } from 'theme-ui'
import { Sidebar, SidebarDivider } from '@carbonplan/layouts'
import { Link } from '@carbonplan/components'
import Controls from './controls'
import { useAppStore } from '../lib/store'

const SidebarContent = () => (
  <>
    <Box
      as='h1'
      sx={{
        fontSize: [4],
        fontFamily: 'heading',
        letterSpacing: 'heading',
        lineHeight: 'heading',
      }}
    >
      @carbonplan/zarr-layer
    </Box>
    <Box sx={{ color: 'secondary', my: 2 }}>
      Flexible Zarr rendering for MapLibre/Mapbox. View the project on{' '}
      <Link
        href='https://github.com/carbonplan/zarr-layer'
        target='_blank'
        sx={{ color: 'secondary', '&:hover': { color: 'primary' } }}
      >
        GitHub
      </Link>
      .
    </Box>
    <SidebarDivider sx={{ my: 3 }} />
    <Controls />
  </>
)

const SidebarComponent = () => {
  const sidebarRef = useRef<HTMLDivElement>(null)
  const setSidebarWidth = useAppStore((state) => state.setSidebarWidth)

  useEffect(() => {
    const updateSidebarWidth = () => {
      if (sidebarRef.current) {
        const width =
          sidebarRef.current.parentElement?.parentElement?.offsetWidth ?? 0
        setSidebarWidth(width)
      }
    }
    updateSidebarWidth()
    window.addEventListener('resize', updateSidebarWidth)
    return () => {
      window.removeEventListener('resize', updateSidebarWidth)
      setSidebarWidth(0)
    }
  }, [setSidebarWidth])

  return (
    <>
      {/* Desktop sidebar */}
      <Box sx={{ display: ['none', 'none', 'block'] }}>
        <Sidebar expanded={true} side='left' width={4}>
          <div ref={sidebarRef}>
            <SidebarContent />
          </div>
        </Sidebar>
      </Box>

      {/* Mobile bottom panel */}
      <Box
        sx={{
          display: ['block', 'block', 'none'],
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: '50vh',
          bg: 'background',
          overflowY: 'auto',
          zIndex: 1000,
          px: [4, 5],
          py: [3],
          borderTop: '1px solid',
          borderColor: 'muted',
        }}
      >
        <SidebarContent />
      </Box>
    </>
  )
}

export default SidebarComponent
