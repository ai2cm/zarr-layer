declare module '@carbonplan/theme' {
  const theme: Record<string, unknown>
  export default theme
}

declare module '@carbonplan/colormaps' {
  export function useThemedColormap(
    name: string,
    options?: { format?: string }
  ): string[]
  export function makeColormap(
    name: string,
    options?: { format?: string }
  ): string[]
}

declare module '@carbonplan/icons' {
  import { FC } from 'react'
  export const RotatingArrow: FC<any>
  export const Info: FC<any>
}

declare module '@carbonplan/layouts' {
  import { FC } from 'react'
  export const Sidebar: FC<any>
  export const SidebarDivider: FC<any>
}
