/**
 * @twin/world — the logical digital world (Foundation, §29-32).
 * Must not depend on Vue, Three or MapLibre (CI-enforced).
 */

export type {
  WorldId,
  SiteId,
  EntityRef,
  WorldScope,
  WorldMode,
  WorldTime,
  WorldSession,
  GeoBounds,
  Site,
  SelectionState
} from './types'
export { entityKey, parseEntityKey, boundsContains, boundsCenter } from './types'
export { WorldClock } from './clock'
export { createSelectionApi } from './selection'
export type { SelectionApi } from './selection'
export { createWorldApi } from './world'
export type { WorldApi, SiteRegistryApi, WorldTimeApi, CreateWorldOptions } from './world'
export type { Disposable } from './lifecycle'
