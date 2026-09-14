import type { Site } from '@twin/world'

/**
 * Demo site registry (Site A / Site B for the freeze-gate site switch loop).
 * Real deployments register sites through the platform data layer.
 */
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

export const SITE_QIDONG: Site = {
  id: 'site-qidong',
  name: '启东海洋工程基地',
  description: '海工建造 + 出运码头',
  origin: {
    longitudeDegrees: 121.6523,
    latitudeDegrees: 31.6857,
    heightMeters: 3.8,
    verticalReference: 'ellipsoid'
  },
  bounds: { south: 31.678, west: 121.643, north: 31.693, east: 121.662 }
}

export const DEMO_SITES: readonly Site[] = [SITE_CHANGEXING, SITE_QIDONG]
