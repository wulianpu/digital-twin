import type {
  AssetDescriptor,
  AssetManifest,
  AssetRef,
  ContentId,
  ContentRole,
  WorldContent,
  WorldContentManifest
} from './types'

export function assetRefKey(ref: AssetRef): string {
  return ref.version ? `${ref.id}@${ref.version}` : ref.id
}

export class ContentRegistry {
  private readonly assets = new Map<string, AssetDescriptor>()
  private readonly content = new Map<ContentId, WorldContent>()
  private readonly siteContent = new Map<string, readonly ContentId[]>()

  registerAssetManifest(manifest: AssetManifest): void {
    for (const asset of manifest.assets) {
      this.assets.set(assetRefKey(asset.ref), asset)
    }
  }

  registerContentManifest(manifest: WorldContentManifest): void {
    for (const c of manifest.content) {
      this.content.set(c.id, c)
    }
    for (const s of manifest.sites ?? []) {
      this.siteContent.set(s.siteId, s.baseContent)
    }
  }

  getAsset(ref: AssetRef): AssetDescriptor | undefined {
    return this.assets.get(assetRefKey(ref)) ?? this.assets.get(ref.id)
  }

  getContent(id: ContentId): WorldContent | undefined {
    return this.content.get(id)
  }

  getSiteContent(siteId: string): readonly WorldContent[] {
    const ids = this.siteContent.get(siteId) ?? []
    return ids
      .map((id) => this.content.get(id))
      .filter((c): c is WorldContent => c !== undefined)
  }

  contentByRole(siteId: string | undefined, role: ContentRole): readonly WorldContent[] {
    const source =
      siteId !== undefined ? this.getSiteContent(siteId) : [...this.content.values()]
    return source.filter((c) => c.role === role)
  }

  listAssets(): readonly AssetDescriptor[] {
    return [...this.assets.values()]
  }
}
