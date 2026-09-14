/**
 * @twin/content — Asset & WorldContent model (Foundation, §40-42).
 */

export type {
  AssetId,
  AssetRef,
  AssetKind,
  AssetDescriptor,
  ContentId,
  ContentRole,
  WorldContent,
  SiteContentManifest,
  AssetManifest,
  WorldContentManifest
} from './types'
export { ContentRegistry, assetRefKey } from './registry'
export { validateAssetManifest, validateContentManifest } from './validate'
export type { ValidationIssue } from './validate'
