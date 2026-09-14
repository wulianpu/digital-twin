import { describe, expect, it } from 'vitest'
import {
  ContentRegistry,
  assetRefKey,
  validateAssetManifest,
  validateContentManifest
} from './src/public'

describe('ContentRegistry', () => {
  it('resolves assets, content and site base content', () => {
    const registry = new ContentRegistry()
    registry.registerAssetManifest({
      assets: [
        { ref: { id: 'gantry-crane-glb', version: 'r3' }, kind: 'glb', url: 'memory:crane' }
      ]
    })
    registry.registerContentManifest({
      content: [
        {
          id: 'changxing-crane-003',
          asset: { id: 'gantry-crane-glb', version: 'r3' },
          role: 'base-model',
          entity: { namespace: 'production', id: 'CRANE-003' }
        }
      ],
      sites: [{ siteId: 'site-changxing', baseContent: ['changxing-crane-003'] }]
    })

    expect(registry.getAsset({ id: 'gantry-crane-glb', version: 'r3' })?.kind).toBe('glb')
    expect(registry.getContent('changxing-crane-003')?.entity?.id).toBe('CRANE-003')
    expect(registry.getSiteContent('site-changxing')).toHaveLength(1)
    expect(registry.contentByRole('site-changxing', 'base-model')).toHaveLength(1)
    expect(registry.contentByRole(undefined, 'water')).toHaveLength(0)
  })

  it('assetRefKey prefers versioned key', () => {
    expect(assetRefKey({ id: 'a', version: 'v2' })).toBe('a@v2')
    expect(assetRefKey({ id: 'a' })).toBe('a')
  })
})

describe('manifest validation', () => {
  it('flags duplicates, bad kinds and missing urls', () => {
    const issues = validateAssetManifest({
      assets: [
        { ref: { id: 'a' }, kind: 'glb', url: 'https://x/y.glb' },
        { ref: { id: 'a' }, kind: 'glb', url: 'https://x/y.glb' },
        { ref: { id: 'b' }, kind: 'wat' as never },
        { ref: { id: 'c' }, kind: 'gltf', url: 'ftp://nope' }
      ]
    })
    expect(issues.map((i) => i.message)).toEqual(
      expect.arrayContaining([
        'duplicate asset id "a"',
        'invalid kind "wat"',
        'unsupported url scheme in "ftp://nope"'
      ])
    )
  })

  it('flags unknown asset refs and dangling site content', () => {
    const assets = {
      assets: [
        { ref: { id: 'known' }, kind: 'glb' as const, url: 'https://x.glb' }
      ]
    }
    const issues = validateContentManifest(
      {
        content: [
          { id: 'c1', asset: { id: 'missing' }, role: 'base-model' },
          { id: 'c2', asset: { id: 'known' }, role: 'tileset' }
        ],
        sites: [{ siteId: 's', baseContent: ['c2', 'ghost'] }]
      },
      assets
    )
    expect(issues).toHaveLength(2)
    expect(issues[0].message).toContain('unknown asset ref')
    expect(issues[1].message).toContain('unknown content id "ghost"')
  })
})
