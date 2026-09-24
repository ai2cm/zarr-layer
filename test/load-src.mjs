// Bundle a zarr-layer source module with esbuild (installed with tsup) and
// import it, so tests exercise src/ directly without a dist build. npm
// packages stay external and resolve from node_modules.
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function loadSrc(relPath) {
  const result = await build({
    entryPoints: [path.join(root, relPath)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    write: false,
    logLevel: 'silent',
  })
  // Write next to the sources so bare imports resolve from node_modules
  const dir = mkdtempSync(path.join(root, 'node_modules', '.test-bundle-'))
  const out = path.join(dir, path.basename(relPath).replace(/\.ts$/, '.mjs'))
  writeFileSync(out, result.outputFiles[0].contents)
  try {
    return await import(pathToFileURL(out).href)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
