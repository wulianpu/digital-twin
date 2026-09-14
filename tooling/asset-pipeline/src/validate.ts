import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  validateAssetManifest,
  validateContentManifest,
  type AssetManifest,
  type WorldContentManifest,
  type ValidationIssue
} from '@twin/content'

/** Manifest dir override (used by the CI script). */
const manifestDirOverride = process.env.TWIN_MANIFEST_DIR

export function defaultManifestDir(): string {
  return manifestDirOverride ?? join(import.meta.dirname, '..', 'manifests')
}

export function loadManifests(dir: string): {
  assets: AssetManifest[]
  content: WorldContentManifest[]
} {
  const assets: AssetManifest[] = []
  const content: WorldContentManifest[] = []
  if (!existsSync(dir)) return { assets, content }
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    if (parsed.assets) assets.push(parsed as AssetManifest)
    if (parsed.content) content.push(parsed as WorldContentManifest)
  }
  return { assets, content }
}

export function validateManifestDir(dir: string): ValidationIssue[] {
  const { assets, content } = loadManifests(dir)
  const issues: ValidationIssue[] = []
  for (const manifest of assets) {
    issues.push(...validateAssetManifest(manifest))
  }
  for (const manifest of content) {
    issues.push(...validateContentManifest(manifest, assets[0]))
  }
  return issues
}

/** Validates the active manifest directory (CI entrypoint). */
export function validateActiveManifests(): ValidationIssue[] {
  return validateManifestDir(defaultManifestDir())
}
