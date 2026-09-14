import type { Site } from '@twin/world'
import type { ReferenceFrame } from '@twin/spatial'
import { frameLocalToGeodetic } from '@twin/spatial'
import { stackEntity } from '@twin/domain-logistics'

/**
 * Deterministic stack yard layout, authored in the site frame and projected
 * to WGS84 through the ReferenceFrame (Phase-1 "位置不跳变" contract).
 */

export interface StackCell {
  key: string
  code: string
  segment: string
  weightTonnes: number
  /** Frame-local rectangle. */
  cx: number
  cy: number
  widthM: number
  lengthM: number
  heightM: number
  status: 'stored' | 'inbound' | 'outbound' | 'maintenance'
}

export interface StackLayout {
  readonly frame: ReferenceFrame
  readonly cells: readonly StackCell[]
  readonly featureCollection: GeoJSON.FeatureCollection
  readonly entityOf: (code: string) => { namespace: string; id: string }
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

export function createStackLayout(site: Site, frame: ReferenceFrame): StackLayout {
  const rng = mulberry32(
    site.id.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) + 17
  )
  const cols = 6
  const rows = 4
  const cellW = 64
  const cellL = 42
  const gap = 14
  const x0 = -(cols * (cellW + gap)) / 2
  const y0 = -(rows * (cellL + gap)) / 2

  const segments = ['分段A', '分段B', '分段C', '分段D']
  const statuses: StackCell['status'][] = ['stored', 'stored', 'stored', 'inbound', 'outbound', 'maintenance']

  const cells: StackCell[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col
      const code = `STACK-${String.fromCharCode(65 + row)}-${String(index + 1).padStart(3, '0')}`
      cells.push({
        key: stackEntity(code).id,
        code,
        segment: segments[Math.floor(rng() * segments.length)],
        weightTonnes: Math.round(80 + rng() * 420),
        cx: x0 + col * (cellW + gap) + cellW / 2,
        cy: y0 + row * (cellL + gap) + cellL / 2,
        widthM: cellW,
        lengthM: cellL,
        heightM: 4 + Math.floor(rng() * 3),
        status: statuses[Math.floor(rng() * statuses.length)]
      })
    }
  }

  const polygonOf = (cell: StackCell): number[][] => {
    const hw = cell.widthM / 2
    const hl = cell.lengthM / 2
    const corners = [
      { x: cell.cx - hw, y: cell.cy - hl },
      { x: cell.cx + hw, y: cell.cy - hl },
      { x: cell.cx + hw, y: cell.cy + hl },
      { x: cell.cx - hw, y: cell.cy + hl },
      { x: cell.cx - hw, y: cell.cy - hl }
    ]
    return corners.map((p) => {
      const g = frameLocalToGeodetic(frame, { x: p.x, y: 0, z: p.y })
      return [round6(g.longitudeDegrees), round6(g.latitudeDegrees)]
    })
  }

  const features: GeoJSON.Feature[] = cells.map((cell) => ({
    type: 'Feature',
    id: cell.code,
    properties: {
      key: cell.code,
      label: cell.code,
      segment: cell.segment,
      weight: cell.weightTonnes,
      status: cell.status
    },
    geometry: {
      type: 'Polygon',
      coordinates: [polygonOf(cell)]
    }
  }))

  return {
    frame,
    cells,
    featureCollection: { type: 'FeatureCollection', features },
    entityOf: (code) => stackEntity(code)
  }
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6
}
