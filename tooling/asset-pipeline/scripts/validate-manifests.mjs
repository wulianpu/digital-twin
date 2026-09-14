#!/usr/bin/env node
/**
 * CI asset-manifest validation (§42). Sample manifests ship under
 * tooling/asset-pipeline/manifests/; deployments point this at their own dir:
 *   node validate-manifests.mjs /path/to/manifests
 *
 * Validation logic lives in TypeScript and runs through vitest so CI and
 * local runs share exactly one implementation.
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const target = process.argv[2]
const toolingDir = fileURLToPath(new URL('..', import.meta.url))

if (target !== undefined && !existsSync(target)) {
  console.error(`✗ manifest dir does not exist: ${target}`)
  process.exit(1)
}

if (target !== undefined) {
  const env = { ...process.env, TWIN_MANIFEST_DIR: target }
  try {
    execSync('pnpm exec vitest run tooling/asset-pipeline', {
      cwd: join(toolingDir, '..', '..'),
      stdio: 'inherit',
      env
    })
  } catch {
    process.exit(1)
  }
} else {
  execSync('pnpm exec vitest run tooling/asset-pipeline', {
    cwd: join(toolingDir, '..', '..'),
    stdio: 'inherit'
  })
}
