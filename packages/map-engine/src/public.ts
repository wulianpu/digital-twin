/**
 * @twin/map-engine — MapLibre 2D engine (Foundation, §2.2, §16, §22-24, §52-53).
 *
 * IMPORTANT: this public entry must NOT statically import `maplibre-gl`.
 * The engine is a lazy capability; MapLibre loads on the first `use()`
 * (CI-enforced by the architecture tests).
 */

export { createMapAccess } from './mapAccess'
export { buildDefaultStyle } from './style'
export { createMapViewDriver, zoomForScaleMeters, scaleMetersForZoom } from './driver'

export type {
  MapAccess,
  MapContext,
  MapEngineOptions,
  MapEngineState,
  MapViewDriver,
  MapDriverOptions
} from './types'
