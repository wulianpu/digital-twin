#!/usr/bin/env node
/**
 * Freeze Gate #7: build the 2D-only standalone app and verify the output
 * bundle contains NO Three.js / 3D Tiles runtime code.
 */
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const appDir = join(repoRoot, 'apps/standalone/vehicle-navigation')
const distDir = join(appDir, 'dist')

console.log('[check:2d-only] building @twin/standalone-vehicle-navigation ...')
rmSync(distDir, { recursive: true, force: true })
execSync('pnpm exec vite build', { cwd: appDir, stdio: 'inherit' })

// Three.js property names survive esbuild/rollup minification (they are
// object property assignments, not class names).
const FORBIDDEN = [
  'isWebGLRenderer',
  'isBufferGeometry',
  'isShaderMaterial',
  'isInstancedMesh',
  '3d-tiles-renderer',
  'WebGLRenderer'
]
const REQUIRED = ['maplibre'] // the 2D engine must obviously be present

function collectJs(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectJs(full))
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

const jsFiles = collectJs(distDir)
const cssFiles = collectJs(distDir)
void cssFiles
let bundle = ''
for (const file of jsFiles) bundle += readFileSync(file, 'utf8')

const offenders = FORBIDDEN.filter((marker) => bundle.includes(marker))
const missing = REQUIRED.filter((marker) => !bundle.includes(marker))

if (offenders.length > 0) {
  console.error('[check:2d-only] FAIL — 3D runtime found in the 2D-only build:')
  for (const offender of offenders) console.error(`  ✗ ${offender}`)
  process.exit(1)
}
if (missing.length > 0) {
  console.error('[check:2d-only] FAIL — expected 2D runtime missing:', missing)
  process.exit(1)
}

console.log(
  `[check:2d-only] PASS — ${jsFiles.length} JS chunk(s), no three/3d-tiles runtime, maplibre present.`
)
