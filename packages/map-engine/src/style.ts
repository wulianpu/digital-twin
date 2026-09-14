import type { GeodeticPosition } from '@twin/spatial'

/**
 * Host base style (§52): the MapEngine owns the base style and base sources.
 * The built-in style is fully offline (background + optional raster imagery);
 * `styleUrl` may point at any MapLibre style for deployment.
 */
export interface DefaultStyleOptions {
  rasterTilesUrl?: string
  attribution?: string
  initialCenter?: GeodeticPosition
  initialZoom?: number
}

export function buildDefaultStyle(options: DefaultStyleOptions = {}): Record<string, unknown> {
  const center: [number, number] = options.initialCenter
    ? [options.initialCenter.longitudeDegrees, options.initialCenter.latitudeDegrees]
    : [121.78, 31.36]
  const layers: Record<string, unknown>[] = [
    {
      id: 'twin-base-background',
      type: 'background',
      paint: { 'background-color': '#0b1220' }
    }
  ]
  const sources: Record<string, unknown> = {}
  if (options.rasterTilesUrl) {
    sources['twin-base-raster'] = {
      type: 'raster',
      tiles: [options.rasterTilesUrl],
      tileSize: 256,
      maxzoom: 19,
      attribution: options.attribution ?? ''
    }
    layers.push({
      id: 'twin-base-raster-layer',
      type: 'raster',
      source: 'twin-base-raster',
      paint: { 'raster-opacity': 0.9 }
    })
  }
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources,
    layers,
    center,
    zoom: options.initialZoom ?? 3
  }
}
