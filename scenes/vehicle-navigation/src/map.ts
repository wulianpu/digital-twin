import type { SceneContext, MapContext } from '@twin/sdk'
import { sceneScopedId } from '@twin/sdk'
import { frameLocalToGeodetic } from '@twin/spatial'
import type { GeoJSONSource } from 'maplibre-gl'
import type { AgvState } from '@twin/domain-agv'
import type { NavigationLayout } from './data'

const SCENE_ID = 'vehicle-navigation'

export interface MapHandlers {
  onPickAgv(agvKey: string | undefined): void
}

export interface MapMountHandle {
  suspend(): void
  resume(): void
  /** Replace AGV marker positions (business-path updates, low Hz). */
  updateAgvs(states: ReadonlyMap<string, AgvState>): void
  setSelected(agvKey: string | undefined): void
  dispose(): void | Promise<void>
}

/**
 * 2D representation. Scene owns its sources/layers/listeners and cleans
 * them up on unmount with the NATIVE MapLibre API (§22, §63) — the platform
 * does not wrap addSource/addLayer.
 */
export async function mountMap(
  ctx: SceneContext,
  layout: NavigationLayout,
  handlers: MapHandlers
): Promise<MapMountHandle> {
  const mapContext: MapContext = await ctx.map!.use()
  const map = mapContext.instance

  const sourceId = sceneScopedId(SCENE_ID, 'network')
  const agvSourceId = sceneScopedId(SCENE_ID, 'agvs')
  const trailSourceId = sceneScopedId(SCENE_ID, 'trails')
  const routeLineId = sceneScopedId(SCENE_ID, 'route-line')
  const routeLabelId = sceneScopedId(SCENE_ID, 'route-label')
  const zoneFillId = sceneScopedId(SCENE_ID, 'zone-fill')
  const zoneLineId = sceneScopedId(SCENE_ID, 'zone-line')
  const agvDotId = sceneScopedId(SCENE_ID, 'agv-dot')
  const agvLabelId = sceneScopedId(SCENE_ID, 'agv-label')

  map.addSource(sourceId, {
    type: 'geojson',
    data: layout.routeCollection,
    promoteId: 'key'
  })
  map.addSource(agvSourceId, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
    promoteId: 'key'
  })
  map.addSource(trailSourceId, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  })

  map.addLayer({
    id: zoneFillId,
    type: 'fill',
    source: sourceId,
    filter: ['has', 'radius'],
    paint: { 'fill-color': '#e05d5d', 'fill-opacity': 0.18 }
  })
  map.addLayer({
    id: zoneLineId,
    type: 'line',
    source: sourceId,
    filter: ['has', 'radius'],
    paint: { 'line-color': '#e05d5d', 'line-width': 1.5, 'line-dasharray': [2, 2] }
  })
  map.addLayer({
    id: routeLineId,
    type: 'line',
    source: sourceId,
    filter: ['!', ['has', 'radius']],
    paint: {
      'line-color': '#4f9cf9',
      'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 5, 3]
    }
  })
  map.addLayer({
    id: routeLabelId,
    type: 'symbol',
    source: sourceId,
    filter: ['!', ['has', 'radius']],
    layout: {
      'symbol-placement': 'line',
      'text-field': ['get', 'name'],
      'text-size': 12,
      'text-offset': [0, 1.1]
    },
    paint: { 'text-color': '#9db8d8', 'text-halo-color': '#0a1220', 'text-halo-width': 1.5 }
  })

  const emptyFC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
  ;(map.getSource(agvSourceId) as GeoJSONSource | undefined)?.setData(emptyFC)
  map.addLayer({
    id: sceneScopedId(SCENE_ID, 'agv-trail'),
    type: 'line',
    source: trailSourceId,
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': '#57d9a3', 'line-width': 2.5, 'line-opacity': 0.6 }
  })
  map.addLayer({
    id: agvDotId,
    type: 'circle',
    source: agvSourceId,
    paint: {
      'circle-radius': 7,
      'circle-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#ffd166', '#57d9a3'],
      'circle-stroke-color': '#0a1220',
      'circle-stroke-width': 1.5
    }
  })
  map.addLayer({
    id: agvLabelId,
    type: 'symbol',
    source: agvSourceId,
    minzoom: 13,
    layout: {
      'text-field': ['get', 'label'],
      'text-size': 10,
      'text-offset': [0, 1.4]
    },
    paint: { 'text-color': '#cfe3ff', 'text-halo-color': '#0a1220', 'text-halo-width': 1.2 }
  })

  const onClick = (e: { point: { x: number; y: number } }) => {
    const features = map.queryRenderedFeatures(e.point as unknown as [number, number], { layers: [agvDotId] })
    const key = (features[0]?.properties as { key?: string } | undefined)?.key
    handlers.onPickAgv(key)
  }
  map.on('click', onClick)

  let selectedKey: string | undefined
  let agvKeys: string[] = []
  const trails = new Map<string, Array<[number, number]>>()

  const handle: MapMountHandle = {
    suspend() {
      mapContext.suspend()
    },
    resume() {
      mapContext.resume()
    },
    updateAgvs(states) {
      const features: GeoJSON.Feature[] = []
      for (const [key, s] of states) {
        // AGV poses are site-frame meters; project through the frame —
        // never hand-align business models to the map (§88).
        const g = frameLocalToGeodetic(layout.frame, { x: s.xMeters, y: 0, z: s.yMeters })
        features.push({
          type: 'Feature',
          id: key,
          properties: {
            key,
            label: `${key} · ${(s.speedMs * 3.6).toFixed(0)}km/h · ${Math.round(s.batteryPct)}%`
          },
          geometry: { type: 'Point', coordinates: [g.longitudeDegrees, g.latitudeDegrees] }
        })
      }
      // I10-5: AGV 轨迹尾线（每台最近 40 点）
      const trailFeatures: GeoJSON.Feature[] = []
      for (const [key, s] of states) {
        const g = frameLocalToGeodetic(layout.frame, { x: s.xMeters, y: 0, z: s.yMeters })
        const trail = trails.get(key) ?? []
        const coord: [number, number] = [
          Math.round(g.longitudeDegrees * 1e6) / 1e6,
          Math.round(g.latitudeDegrees * 1e6) / 1e6
        ]
        const last = trail[trail.length - 1]
        if (!last || last[0] !== coord[0] || last[1] !== coord[1]) {
          trail.push(coord)
          if (trail.length > 40) trail.shift()
          trails.set(key, trail)
        }
        if (trail.length >= 2) {
          trailFeatures.push({
            type: 'Feature',
            properties: { key },
            geometry: { type: 'LineString', coordinates: [...trail] }
          })
        }
      }
      ;(map.getSource(trailSourceId) as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features: trailFeatures
      })
      ;(map.getSource(agvSourceId) as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features
      })
      agvKeys = features.map((f) => String(f.id))
      if (selectedKey && !agvKeys.includes(selectedKey)) {
        // selection state cleanup happens via setSelected on the next pick
      }
    },
    setSelected(key) {
      if (selectedKey && map.getSource(agvSourceId)) {
        map.setFeatureState({ source: agvSourceId, id: selectedKey }, { selected: false })
      }
      selectedKey = key
      if (selectedKey) {
        map.setFeatureState({ source: agvSourceId, id: selectedKey }, { selected: true })
      }
    },
    dispose() {
      map.off('click', onClick)
      for (const id of [
        sceneScopedId(SCENE_ID, 'agv-trail'),
        agvLabelId,
        agvDotId,
        routeLabelId,
        routeLineId,
        zoneLineId,
        zoneFillId
      ]) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [trailSourceId, agvSourceId, sourceId]) {
        if (map.getSource(id)) map.removeSource(id)
      }
      trails.clear()
    }
  }

  return handle
}
