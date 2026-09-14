import type { MapContext, SceneContext } from '@twin/sdk'
import { sceneScopedId } from '@twin/sdk'
import type { GeoJSONSource } from 'maplibre-gl'
import type { StackCell, StackLayout } from './data'

const SCENE_ID = 'stack-yard'

export interface StackMapHandlers {
  onPickStack(code: string | undefined): void
}

export interface StackMapHandle {
  /** feature-state 驱动选中高亮与状态颜色（§22 原生 API）。 */
  setSelected(code: string | undefined): void
  setStatus(code: string, status: string): void
  suspend(): void
  resume(): void
  dispose(): void | Promise<void>
}

export async function mountMap(
  ctx: SceneContext,
  layout: StackLayout,
  handlers: StackMapHandlers
): Promise<StackMapHandle> {
  const mapContext: MapContext = await ctx.map!.use()
  const map = mapContext.instance

  const sourceId = sceneScopedId(SCENE_ID, 'stacks')
  const fillId = sceneScopedId(SCENE_ID, 'stack-fill')
  const lineId = sceneScopedId(SCENE_ID, 'stack-line')
  const labelId = sceneScopedId(SCENE_ID, 'stack-label')

  map.addSource(sourceId, {
    type: 'geojson',
    data: layout.featureCollection,
    promoteId: 'key'
  })

  map.addLayer({
    id: fillId,
    type: 'fill',
    source: sourceId,
    paint: {
      'fill-color': [
        'match',
        ['get', 'status'],
        'inbound',
        '#57d9a3',
        'outbound',
        '#ffd166',
        'maintenance',
        '#e05d5d',
        '#3a6ea5'
      ],
      'fill-opacity': [
        'case',
        ['boolean', ['feature-state', 'selected'], false],
        0.85,
        0.45
      ]
    }
  })
  map.addLayer({
    id: lineId,
    type: 'line',
    source: sourceId,
    paint: {
      'line-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#ffffff', '#7ea6d9'],
      'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2.5, 1]
    }
  })
  map.addLayer({
    id: labelId,
    type: 'symbol',
    source: sourceId,
    minzoom: 13.5,
    layout: {
      'text-field': ['get', 'label'],
      'text-size': 10,
      'text-letter-spacing': 0.05
    },
    paint: { 'text-color': '#d7e6ff', 'text-halo-color': '#0a1220', 'text-halo-width': 1.4 }
  })

  let selected: string | undefined

  const onClick = (e: { point: { x: number; y: number } }) => {
    const features = map.queryRenderedFeatures(e.point as unknown as [number, number], { layers: [fillId] })
    const code = (features[0]?.properties as { key?: string } | undefined)?.key
    handlers.onPickStack(code)
  }
  map.on('click', onClick)

  return {
    setSelected(code) {
      if (selected && map.getSource(sourceId)) {
        map.setFeatureState({ source: sourceId, id: selected }, { selected: false })
      }
      selected = code
      if (selected) {
        map.setFeatureState({ source: sourceId, id: selected }, { selected: true })
      }
    },
    setStatus(code, status) {
      if (!map.getSource(sourceId)) return
      map.setFeatureState({ source: sourceId, id: code }, { status })
      // Colors read from properties via match(); refresh the data feature so
      // the new status renders without a full setData.
      const source = map.getSource(sourceId) as GeoJSONSource | undefined
      const feature = layout.featureCollection.features.find(
        (f) => (f.properties as { key?: string }).key === code
      )
      if (feature && source) {
        ;(feature.properties as { status?: string }).status = status
        source.setData(layout.featureCollection)
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
      for (const id of [labelId, lineId, fillId]) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      if (map.getSource(sourceId)) map.removeSource(sourceId)
    }
  }
}

export type { StackCell }
