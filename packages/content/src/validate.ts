import { assetRefKey } from './registry'
import type {
  AssetManifest,
  SiteContentManifest,
  WorldContentManifest
} from './types'

export interface ValidationIssue {
  readonly path: string
  readonly message: string
}

const VALID_KINDS = new Set([
  'glb',
  'gltf',
  'ktx2-texture',
  'tileset',
  'collision-proxy',
  'kinematic-model',
  'binary-metadata'
])

const VALID_ROLES = new Set(['terrain', 'tileset', 'base-model', 'water', 'environment'])

/** Pure manifest validation shared by the asset-pipeline tooling and tests. */
export function validateAssetManifest(manifest: AssetManifest): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const seen = new Set<string>()
  manifest.assets.forEach((asset, i) => {
    const path = `assets[${i}]`
    if (!asset.ref?.id) issues.push({ path, message: 'missing asset id' })
    if (asset.ref && seen.has(assetRefKey(asset.ref))) {
      issues.push({ path, message: `duplicate asset id "${assetRefKey(asset.ref)}"` })
    }
    if (asset.ref) seen.add(assetRefKey(asset.ref))
    if (!VALID_KINDS.has(asset.kind)) {
      issues.push({ path, message: `invalid kind "${asset.kind}"` })
    }
    const needsUrl = asset.kind !== 'binary-metadata'
    if (needsUrl && !asset.url) {
      issues.push({ path, message: `asset of kind "${asset.kind}" requires url` })
    }
    if (asset.url && !/^(https?:\/\/|memory:|\/)/.test(asset.url)) {
      issues.push({ path, message: `unsupported url scheme in "${asset.url}"` })
    }
  })
  return issues
}

export function validateContentManifest(
  manifest: WorldContentManifest,
  assets?: AssetManifest
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const assetIds = new Set((assets?.assets ?? []).map((a) => assetRefKey(a.ref)))
  const contentIds = new Set<string>()
  manifest.content.forEach((c, i) => {
    const path = `content[${i}]`
    if (!c.id) issues.push({ path, message: 'missing content id' })
    if (contentIds.has(c.id)) {
      issues.push({ path, message: `duplicate content id "${c.id}"` })
    }
    contentIds.add(c.id)
    if (!VALID_ROLES.has(c.role)) {
      issues.push({ path, message: `invalid role "${c.role}"` })
    }
    if (assets && !assetIds.has(assetRefKey(c.asset))) {
      issues.push({
        path,
        message: `unknown asset ref "${assetRefKey(c.asset)}"`
      })
    }
    if (
      c.anchor &&
      (!c.anchor.frameId || !c.anchor.pose || !c.anchor.pose.positionMeters)
    ) {
      issues.push({ path, message: 'malformed spatial anchor' })
    }
  })
  ;(manifest.sites ?? []).forEach((s: SiteContentManifest, i: number) => {
    for (const id of s.baseContent) {
      if (!contentIds.has(id)) {
        issues.push({
          path: `sites[${i}]`,
          message: `site "${s.siteId}" references unknown content id "${id}"`
        })
      }
    }
  })
  return issues
}
