import type { Site } from '@twin/world'

/** Standalone demo site (single-site composition). */
export const SITE_CHANGEXING: Site = {
  id: 'site-changxing',
  name: '长兴造船基地',
  description: '船坞总装 + 码头舾装 + 分段堆场',
  origin: {
    longitudeDegrees: 121.7821,
    latitudeDegrees: 31.3622,
    heightMeters: 4.2,
    verticalReference: 'ellipsoid'
  },
  bounds: { south: 31.354, west: 121.772, north: 31.371, east: 121.793 }
}
