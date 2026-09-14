import type { MapContext, SceneContext } from '@twin/sdk'
import { sceneScopedId } from '@twin/sdk'
import { frameLocalToGeodetic } from '@twin/spatial'
import type { GeoJSONSource } from 'maplibre-gl'
import type { AgvState } from '@twin/domain-agv'
import type { CraneState } from '@twin/domain-crane'
import type { ProductionLayout } from './data'

const SCENE_ID = 'production'

export interface ProductionMapHandle {
  updateAgvs(states: ReadonlyMap<string, AgvState>): void
  updateCranes(states: ReadonlyMap<string, CraneState>): void
  setSelected(key: string | undefined): void
  suspend(): void
  resume(): void
  dispose(): void | Promise<void>
}

export async function mountMap(
  ctx: SceneContext,
  layout: ProductionLayout,
  handlers: { onPick(key: string | undefined, namespace: string): void }
): Promise<ProductionMapHandle> {
  const mapContext: MapContext = await ctx.map!.use()
  const map = mapContext.instance

  const buildingSource = sceneScopedId(SCENE_ID, 'buildings')
  const lineSource = sceneScopedId(SCENE_ID, 'lines')
  const agvSource = sceneScopedId(SCENE_ID, 'agvs')
  const trailSource = sceneScopedId(SCENE_ID, 'trails')
  const craneSource = sceneScopedId(SCENE_ID, 'cranes')
  const buildingFill = sceneScopedId(SCENE_ID, 'building-fill')
  const buildingLine = sceneScopedId(SCENE_ID, 'building-line')
  const buildingLabel = sceneScopedId(SCENE_ID, 'building-label')
  const quayLine = sceneScopedId(SCENE_ID, 'quay-line')
  const agvDot = sceneScopedId(SCENE_ID, 'agv-dot')
  const craneDot = sceneScopedId(SCENE_ID, 'crane-dot')
  const craneLabel = sceneScopedId(SCENE_ID, 'crane-label')

  map.addSource(buildingSource, {
    type: 'geojson',
    data: layout.buildingCollection,
    promoteId: 'key'
  })
  map.addSource(lineSource, {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { kind: 'quay' },
          geometry: { type: 'LineString', coordinates: layout.quayCoordinates }
        }
      ]
    }
  })
  map.addSource(agvSource, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
    promoteId: 'key'
  })
  map.addSource(craneSource, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
    promoteId: 'key'
  })
  map.addSource(trailSource, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  })

  map.addLayer({
    id: buildingFill,
    type: 'fill',
    source: buildingSource,
    paint: {
      'fill-color': '#33415c',
      'fill-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.9, 0.55]
    }
  })
  map.addLayer({
    id: buildingLine,
    type: 'line',
    source: buildingSource,
    paint: { 'line-color': '#7ea6d9', 'line-width': 1 }
  })
  map.addLayer({
    id: buildingLabel,
    type: 'symbol',
    source: buildingSource,
    minzoom: 14,
    layout: { 'text-field': ['get', 'label'], 'text-size': 11 },
    paint: { 'text-color': '#d7e6ff', 'text-halo-color': '#0a1220', 'text-halo-width': 1.4 }
  })
  map.addLayer({
    id: quayLine,
    type: 'line',
    source: lineSource,
    filter: ['==', ['get', 'kind'], 'quay'],
    paint: { 'line-color': '#ffd166', 'line-width': 3 }
  })
  map.addLayer({
    id: craneDot,
    type: 'circle',
    source: craneSource,
    paint: {
      'circle-radius': 8,
      'circle-color': ['match', ['get', 'status'], 'running', '#57d9a3', 'fault', '#e05d5d', '#ffd166'],
      'circle-stroke-color': '#06121f',
      'circle-stroke-width': 1.5
    }
  })
  map.addLayer({
    id: craneLabel,
    type: 'symbol',
    source: craneSource,
    minzoom: 14.5,
    layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.3] },
    paint: { 'text-color': '#cfe3ff', 'text-halo-color': '#0a1220', 'text-halo-width': 1.2 }
  })
  map.addLayer({
    id: sceneScopedId(SCENE_ID, 'agv-trail'),
    type: 'line',
    source: trailSource,
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': '#4f9cf9', 'line-width': 2, 'line-opacity': 0.55 }
  })
  map.addLayer({
    id: agvDot,
    type: 'circle',
    source: agvSource,
    paint: {
      'circle-radius': 6,
      'circle-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#ffffff', '#4f9cf9'],
      'circle-stroke-color': '#06121f',
      'circle-stroke-width': 1.2
    }
  })

  const onClick = (e: { point: { x: number; y: number } }) => {
    const agvHit = map.queryRenderedFeatures(e.point as unknown as [number, number], { layers: [agvDot] })
    if (agvHit.length > 0) {
      handlers.onPick((agvHit[0].properties as { key?: string }).key, 'agv')
      return
    }
    const craneHit = map.queryRenderedFeatures(e.point as unknown as [number, number], { layers: [craneDot] })
    if (craneHit.length > 0) {
      handlers.onPick((craneHit[0].properties as { key?: string }).key, 'production')
      return
    }
    const buildingHit = map.queryRenderedFeatures(e.point as unknown as [number, number], { layers: [buildingFill] })
    if (buildingHit.length > 0) {
      handlers.onPick((buildingHit[0].properties as { key?: string }).key, 'facility')
      return
    }
    handlers.onPick(undefined, '')
  }
  map.on('click', onClick)

  let selectedKey: string | undefined
  const trails = new Map<string, Array<[number, number]>>()

  function toLngLat(x: number, z: number): [number, number] {
    const g = frameLocalToGeodetic(layout.frame, { x, y: 0, z })
    return [g.longitudeDegrees, g.latitudeDegrees]
  }

  return {
    updateAgvs(states) {
      const features: GeoJSON.Feature[] = []
      for (const [key, s] of states) {
        const g = toLngLat(s.xMeters, s.yMeters)
        features.push({
          type: 'Feature',
          id: key,
          properties: { key, label: key },
          geometry: { type: 'Point', coordinates: g }
        })
      }
      ;(map.getSource(agvSource) as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features
      })
      // B3: AGV 轨迹尾线（每台保留最近 30 点）
      const trailFeatures: GeoJSON.Feature[] = []
      for (const [key, s] of states) {
        const g = toLngLat(s.xMeters, s.yMeters)
        const trail = trails.get(key) ?? []
        const last = trail[trail.length - 1]
        if (!last || Math.abs(last[0] - g[0]) > 1e-6 || Math.abs(last[1] - g[1]) > 1e-6) {
          trail.push(g)
          if (trail.length > 30) trail.shift()
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
      ;(map.getSource(trailSource) as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        trailFeaturesLength: trailFeatures.length,
        features: trailFeatures
      } as GeoJSON.FeatureCollection)
    },
    updateCranes(states) {
      const features: GeoJSON.Feature[] = layout.cranes.map((base) => {
        const s = states.get(base.code)
        const gantryX = base.x + (s?.gantryMeters ?? 0)
        return {
          type: 'Feature',
          id: base.code,
          properties: {
            key: base.code,
            label: base.code,
            status: s?.status ?? 'idle',
            load: s?.loadTonnes ?? 0
          },
          geometry: {
            type: 'Point',
            coordinates: toLngLat(gantryX, base.z)
          }
        }
      })
      ;(map.getSource(craneSource) as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features
      })
    },
    setSelected(key) {
      if (selectedKey && map.getSource(agvSource)) {
        map.setFeatureState({ source: agvSource, id: selectedKey }, { selected: false })
      }
      selectedKey = key
      if (selectedKey) {
        map.setFeatureState({ source: agvSource, id: selectedKey }, { selected: true })
      }
    },
    suspend() {
      mapContext.suspend()
    },
    resume() {
      mapContext.resume()
    },
    dispose() {
      map.off('click', onClick)
      for (const id of [
        sceneScopedId(SCENE_ID, 'agv-trail'),
        agvDot,
        craneLabel,
        craneDot,
        quayLine,
        buildingLabel,
        buildingLine,
        buildingFill
      ]) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [craneSource, agvSource, lineSource, buildingSource, trailSource]) {
        if (map.getSource(id)) map.removeSource(id)
      }
    }
  }
}
