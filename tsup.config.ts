import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  splitting: false,
  clean: true,
  external: ['maplibre-gl', 'mapbox-gl', 'numcodecs'],
  // Bundle zarrita and @zarrita/storage inline so esbuild tree-shakes
  // Node-only modules (FileSystemStore, ZipFileStore, ReferenceStore) that
  // would otherwise break webpack consumers via node:buffer/node:fs imports.
  // numcodecs remains external to avoid bundling WASM codec implementations.
  noExternal: ['zarrita', '@zarrita/storage'],
})
