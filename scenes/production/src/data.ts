import type { Site } from '@twin/world'
import type { ReferenceFrame, Vec3d } from '@twin/spatial'
import { frameLocalToGeodetic } from '@twin/spatial'

/**
 * Procedural large-site layout for the Production Twin spike. Everything is
 * authored in SITE-LOCAL meters (X=East, Y=Up, Z=-North) and projected to
 * WGS84 through the ReferenceFrame — the frame is the single source of truth.
 */

export interface BuildingFootprint {
  key: string
  name: string
  cx: number
  cz: number
  widthM: number
  depthM: number
  heightM: number
}

export interface CraneBase {
  code: string
  /** Track center in frame-local meters. */
  x: number
  z: number
  trackLengthM: number
  boomHeadingDeg: number
}

export interface ProductionLayout {
  readonly frame: ReferenceFrame
  readonly buildings: readonly BuildingFootprint[]
  readonly cranes: readonly CraneBase[]
  readonly quayLine: ReadonlyArray<{ x: number; z: number }>
  readonly waterEdgeZ: number
  readonly buildingCollection: GeoJSON.FeatureCollection
  readonly quayCoordinates: Array<[number, number]>
  readonly agvRouteLoop: ReadonlyArray<{ x: number; z: number }>
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function rectPolygon(
  frame: ReferenceFrame,
  cx: number,
  cz: number,
  w: number,
  d: number
): number[][] {
  const corners = [
    { x: cx - w / 2, z: cz - d / 2 },
    { x: cx + w / 2, z: cz - d / 2 },
    { x: cx + w / 2, z: cz + d / 2 },
    { x: cx - w / 2, z: cz + d / 2 },
    { x: cx - w / 2, z: cz - d / 2 }
  ]
  return corners.map((p) => {
    const g = frameLocalToGeodetic(frame, { x: p.x, y: 0, z: p.z })
    return [round6(g.longitudeDegrees), round6(g.latitudeDegrees)]
  })
}

export function createProductionLayout(site: Site, frame: ReferenceFrame): ProductionLayout {
  const rng = mulberry32(site.id.length * 104729 + 7)

  const buildings: BuildingFootprint[] = [
    { key: 'shop-welding', name: '焊接车间', cx: -320, cz: 120, widthM: 220, depthM: 90, heightM: 24 },
    { key: 'shop-painting', name: '涂装车间', cx: -60, cz: 120, widthM: 180, depthM: 80, heightM: 26 },
    { key: 'shop-assembly', name: '总装车间', cx: 220, cz: 100, widthM: 260, depthM: 110, heightM: 32 },
    { key: 'office', name: '联合办公楼', cx: -380, cz: 330, widthM: 120, depthM: 50, heightM: 40 },
    { key: 'warehouse', name: '配送中心', cx: 120, cz: 330, widthM: 200, depthM: 70, heightM: 18 }
  ]

  const cranes: CraneBase[] = [
    { code: 'CRANE-001', x: -350, z: -470, trackLengthM: 380, boomHeadingDeg: 0 },
    { code: 'CRANE-002', x: -120, z: -470, trackLengthM: 380, boomHeadingDeg: 0 },
    { code: 'CRANE-003', x: 110, z: -470, trackLengthM: 380, boomHeadingDeg: 0 },
    { code: 'CRANE-004', x: 340, z: -470, trackLengthM: 380, boomHeadingDeg: 0 }
  ]

  const waterEdgeZ = -520
  const quayLine = [
    { x: -520, z: -500 },
    { x: 520, z: -500 }
  ]

  const quayCoordinates = quayLine.map((p) => {
    const g = frameLocalToGeodetic(frame, { x: p.x, y: 0, z: p.z })
    return [round6(g.longitudeDegrees), round6(g.latitudeDegrees)] as [number, number]
  })

  const buildingFeatures: GeoJSON.Feature[] = buildings.map((b) => ({
    type: 'Feature',
    id: b.key,
    properties: { key: b.key, label: b.name, height: b.heightM },
    geometry: {
      type: 'Polygon',
      coordinates: [rectPolygon(frame, b.cx, b.cz, b.widthM, b.depthM)]
    }
  }))

  // AGVs loop between the yard, the shops and the quay.
  const agvRouteLoop = [
    { x: -450, z: 240 },
    { x: 430, z: 240 },
    { x: 430, z: -320 },
    { x: 60, z: -320 },
    { x: 60, z: -430 },
    { x: -240, z: -430 },
    { x: -240, z: -200 },
    { x: -450, z: -200 }
  ]
  void rng

  return {
    frame,
    buildings,
    cranes,
    quayLine,
    waterEdgeZ,
    buildingCollection: { type: 'FeatureCollection', features: buildingFeatures },
    quayCoordinates,
    agvRouteLoop
  }
}

/** Frame-local ground position -> {x, y, z} with y=0. */
export function ground(x: number, z: number): Vec3d {
  return { x, y: 0, z }
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6
}
