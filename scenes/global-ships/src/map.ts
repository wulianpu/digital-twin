import type { MapContext, SceneContext } from '@twin/sdk'
import { sceneScopedId } from '@twin/sdk'
import type { GeoJSONSource } from 'maplibre-gl'
import type { VesselState } from '@twin/domain-vessel'
import type { VesselTrackRegistry } from '@twin/domain-vessel'

const SCENE_ID = 'global-ships'

export interface ShipsMapHandlers {
  onPickShip(key: string | undefined): void
}

export interface ShipsMapHandle {
  /** Push current vessel states into the map (throttled by caller). */
  updateShips(states: ReadonlyMap<string, VesselState>): void
  /** Show the track line of the selected vessel. */
  setTrack(coordinates: Array<[number, number]> | undefined): void
  setSelected(key: string | undefined): void
  suspend(): void
  resume(): void
  dispose(): void | Promise<void>
}

export async function mountMap(
  ctx: SceneContext,
  tracks: VesselTrackRegistry,
  handlers: ShipsMapHandlers
): Promise<ShipsMapHandle> {
  const mapContext: MapContext = await ctx.map!.use()
  const map = mapContext.instance

  const shipsSource = sceneScopedId(SCENE_ID, 'ships')
  const trackSource = sceneScopedId(SCENE_ID, 'track')
  const shipsDot = sceneScopedId(SCENE_ID, 'ship-dot')
  const shipsLabel = sceneScopedId(SCENE_ID, 'ship-label')
  const trackLine = sceneScopedId(SCENE_ID, 'track-line')

  map.addSource(shipsSource, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
    promoteId: 'key'
  })
  map.addSource(trackSource, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  })

  map.addLayer({
    id: trackLine,
    type: 'line',
    source: trackSource,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffd166', 'line-width': 2, 'line-opacity': 0.8 }
  })
  map.addLayer({
    id: shipsDot,
    type: 'circle',
    source: shipsSource,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 3, 8, 8],
      'circle-color': [
        'match',
        ['get', 'type'],
        'container',
        '#4f9cf9',
        'bulk-carrier',
        '#57d9a3',
        'crane-vessel',
        '#ffd166',
        'tug',
        '#e05d5d',
        '#9db8d8'
      ],
      'circle-stroke-color': '#06121f',
      'circle-stroke-width': 1
    }
  })
  map.addLayer({
    id: shipsLabel,
    type: 'symbol',
    source: shipsSource,
    minzoom: 3.2,
    layout: {
      'text-field': ['get', 'label'],
      'text-size': 10,
      'text-offset': [0, 1.2]
    },
    paint: { 'text-color': '#cfe3ff', 'text-halo-color': '#0a1220', 'text-halo-width': 1.4 }
  })

  let selected: string | undefined

  const onClick = (e: { point: { x: number; y: number } }) => {
    const feats = map.queryRenderedFeatures(e.point as unknown as [number, number], { layers: [shipsDot] })
    const key = (feats[0]?.properties as { key?: string } | undefined)?.key
    handlers.onPickShip(key)
  }
  map.on('click', onClick)

  return {
    updateShips(states) {
      const features: GeoJSON.Feature[] = []
      for (const [key, s] of states) {
        features.push({
          type: 'Feature',
          id: key,
          properties: {
            key,
            label: s.name ?? key,
            type: s.shipType ?? 'other',
            sog: s.sogKnots,
            heading: s.headingDegrees
          },
          geometry: {
            type: 'Point',
            coordinates: [round5(s.longitudeDegrees), round5(s.latitudeDegrees)]
          }
        })
      }
      ;(map.getSource(shipsSource) as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features
      })
    },
    setTrack(coordinates) {
      const data: GeoJSON.FeatureCollection =
        coordinates && coordinates.length >= 2
          ? {
              type: 'FeatureCollection',
              features: [
                {
                  type: 'Feature',
                  properties: {},
                  geometry: { type: 'LineString', coordinates }
                }
              ]
            }
          : { type: 'FeatureCollection', features: [] }
      ;(map.getSource(trackSource) as GeoJSONSource | undefined)?.setData(data)
    },
    setSelected(key) {
      if (selected && map.getSource(shipsSource)) {
        map.setFeatureState({ source: shipsSource, id: selected }, { selected: false })
      }
      selected = key
      if (selected) {
        map.setFeatureState({ source: shipsSource, id: selected }, { selected: true })
      }
      void tracks
    },
    suspend() {
      mapContext.suspend()
    },
    resume() {
      mapContext.resume()
    },
    dispose() {
      map.off('click', onClick)
      for (const id of [shipsLabel, shipsDot, trackLine]) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      for (const id of [trackSource, shipsSource]) {
        if (map.getSource(id)) map.removeSource(id)
      }
    }
  }
}

function round5(v: number): number {
  return Math.round(v * 1e5) / 1e5
}
