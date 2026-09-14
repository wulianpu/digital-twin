#!/usr/bin/env node
/**
 * §77: all Foundation packages expose a single public entry (`src/public.ts`).
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const packages = [
  'world',
  'spatial',
  'content',
  'world-client',
  'map-engine',
  'scene-engine',
  'scene-host',
  'sdk',
  'ui'
]

let failed = false
for (const pkg of packages) {
  const manifestPath = join(repoRoot, 'packages', pkg, 'package.json')
  if (!existsSync(manifestPath)) {
    console.error(`✗ packages/${pkg}: package.json missing`)
    failed = true
    continue
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const exportsMap = manifest.exports ?? {}
  const keys = Object.keys(exportsMap)
  const expected = pkg === 'ui' ? ['.', './styles.css'] : ['.']
  const expectedTarget = pkg === 'ui' ? ['./src/public.ts', './src/styles.css'] : ['./src/public.ts']
  const sameKeys = keys.length === expected.length && expected.every((k) => keys.includes(k))
  const sameTargets =
    expectedTarget.every((t) => Object.values(exportsMap).includes(t))
  if (sameKeys && sameTargets) {
    console.log(`✓ packages/${pkg}`)
  } else {
    console.error(`✗ packages/${pkg}: exports must be ${JSON.stringify(expected)} -> ${expectedTarget.join(',')}`)
    failed = true
  }
}

process.exit(failed ? 1 : 0)
