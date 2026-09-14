import type { SiteId, EntityRef } from '@twin/world'
import type { SpatialAnchor } from '@twin/spatial'

/**
 * Content & Asset model (Architecture Freeze v1.2 §40-42).
 * Asset = reusable digital resource. WorldContent = how an asset enters the world.
 */

export type AssetId = string

export interface AssetRef {
  readonly id: AssetId
  /** Runtime assets are regenerable; version pins regeneration output. */
  readonly version?: string
}

export type AssetKind =
  | 'glb'
  | 'gltf'
  | 'ktx2-texture'
  | 'tileset'
  | 'collision-proxy'
  | 'kinematic-model'
  | 'binary-metadata'

export interface AssetDescriptor {
  readonly ref: AssetRef
  readonly kind: AssetKind
  /**
   * URL for `http(s)://` loading, or a registered source scheme such as
   * `memory:<name>` used by tests / demos.
   */
  readonly url?: string
  readonly bytes?: number
  readonly metadata?: Readonly<Record<string, string | number | boolean>>
}

export type ContentId = string

export type ContentRole =
  | 'terrain'
  | 'tileset'
  | 'base-model'
  | 'water'
  | 'environment'

export interface WorldContent {
  readonly id: ContentId
  readonly asset: AssetRef
  readonly anchor?: SpatialAnchor
  readonly role: ContentRole
  /** Stable entity this content represents, if any. */
  readonly entity?: EntityRef
}

export interface SiteContentManifest {
  readonly siteId: SiteId
  readonly baseContent: readonly ContentId[]
}

export interface AssetManifest {
  readonly assets: readonly AssetDescriptor[]
}

export interface WorldContentManifest {
  readonly content: readonly WorldContent[]
  readonly sites?: readonly SiteContentManifest[]
}
