import { describe, expect, it } from 'vitest'
import { buildDefaultStyle, zoomForScaleMeters, scaleMetersForZoom } from './src/public'

describe('default style', () => {
  it('builds an offline-safe style without raster tiles', () => {
    const style = buildDefaultStyle() as {
      version: number
      layers: Array<{ id: string }>
      sources: Record<string, unknown>
    }
    expect(style.version).toBe(8)
    expect(style.layers.map((l) => l.id)).toContain('twin-base-background')
    expect(Object.keys(style.sources)).toHaveLength(0)
  })

  it('includes raster source when configured', () => {
    const style = buildDefaultStyle({
      rasterTilesUrl: 'https://tiles.example/{z}/{x}/{y}.png'
    }) as { sources: Record<string, { type: string }> }
    expect(style.sources['twin-base-raster']).toBeDefined()
    expect(style.sources['twin-base-raster'].type).toBe('raster')
  })
})

describe('zoom <-> scale conversion', () => {
  it('round-trips approximately', () => {
    const zoom = zoomForScaleMeters(1000, 31.36, 1024)
    const scale = scaleMetersForZoom(zoom, 31.36, 1024)
    expect(scale).toBeCloseTo(1000, 0)
    expect(zoom).toBeGreaterThan(10)
    expect(zoom).toBeLessThan(22)
  })

  it('higher zoom means smaller scale', () => {
    expect(zoomForScaleMeters(100, 0, 512)).toBeGreaterThan(
      zoomForScaleMeters(10000, 0, 512)
    )
  })
})
