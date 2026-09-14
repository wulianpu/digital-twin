import type { MapContext, SceneContext } from '@twin/sdk'
import { sceneScopedId } from '@twin/sdk'
import { frameLocalToGeodetic } from '@twin/spatial'
import type { GeoJSONSource } from 'maplibre-gl'
import type { TransportPlan } from './data'

const SCENE_ID = 'heavy-transport'

export interface TransportMapHandle {
  /** Move the 2D trolley marker (throttled by the caller). */
  updateTrolley(position: { x: number; y: number }): void
  /** Risk tint for the route line. */
  setRisk(violating: boolean): void
  suspend(): void
  resume(): void
  dispose(): void | Promise<void>
}

export async function mountMap(
  ctx: SceneContext,
  plan: TransportPlan
): Promise<TransportMapHandle> {
  const mapContext: MapContext = await ctx.map!.use()
  const map = mapContext.instance

  const routeSource = sceneScopedId(SCENE_ID, 'route')
  const zoneSource = sceneScopedId(SCENE_ID, 'zones')
  const trolleySource = sceneScopedId(SCENE_ID, 'trolley')
  const routeLine = sceneScopedId(SCENE_ID, 'route-line')
  const zoneFill = sceneScopedId(SCENE_ID, 'zone-fill')
  const zoneLine = sceneScopedId(SCENE_ID, 'zone-line')
  const zoneLabel = sceneScopedId(SCENE_ID, 'zone-label')
  const trolleyDot = sceneScopedId(SCENE_ID, 'trolley-dot')

  map.addSource(routeSource, {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: plan.routeCoordinates }
        }
      ]
    }
  })
  map.addSource(zoneSource, { type: 'geojson', data: plan.zoneFeatures })
  map.addSource(trolleySource, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  })

  map.addLayer({
    id: routeLine,
    type: 'line',
    source: routeSource,
    layout: { 'line-cap': 'round' },
    paint: {
      'line-color': ['case', ['boolean', ['feature-state', 'risk'], false], '#e05d5d', '#57d9a3'],
      'line-width': 5
    }
  })
  map.addLayer({
    id: zoneFill,
    type: 'fill',
    source: zoneSource,
    paint: { 'fill-color': '#e05d5d', 'fill-opacity': 0.15 }
  })
  map.addLayer({
    id: zoneLine,
    type: 'line',
    source: zoneSource,
    paint: { 'line-color': '#e05d5d', 'line-width': 1.5, 'line-dasharray': [2, 2] }
  })
  map.addLayer({
    id: zoneLabel,
    type: 'symbol',
    source: zoneSource,
    minzoom: 14,
    layout: { 'text-field': ['get', 'label'], 'text-size': 10 },
    paint: { 'text-color': '#f0a35e', 'text-halo-color': '#0a1220', 'text-halo-width': 1.3 }
  })
  map.addLayer({
    id: trolleyDot,
    type: 'circle',
    source: trolleySource,
    paint: {
      'circle-radius': 9,
      'circle-color': '#ffd166',
      'circle-stroke-color': '#06121f',
      'circle-stroke-width': 2
    }
  })

  return {
    updateTrolley(position) {
      const g = frameLocalToGeodetic(plan.frame, {
        x: position.x,
        y: 0,
        z: position.y
      })
      ;(map.getSource(trolleySource) as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Point', coordinates: [g.longitudeDegrees, g.latitudeDegrees] }
          }
        ]
      })
    },
    setRisk(violating) {
      // Route risk tint (native paint property, §22).
      map.setPaintProperty(routeLine, 'line-color', violating ? '#e05d5d' : '#57d9a3')
    },
    suspend() {
      mapContext.suspend()
    },
    resume() {
      mapContext.resume()
    },
    dispose() {
      for (const id of [trolleyDot, zoneLabel, zoneLine, zoneFill, routeLine]) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [trolleySource, zoneSource, routeSource]) {
        if (map.getSource(id)) map.removeSource(id)
      }
    }
  }
}
