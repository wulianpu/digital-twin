/**
 * @twin/scene-host — scene lifecycle host (Foundation, §9, §12-13).
 */

export { SceneHost } from './host'
export { MountScope, SceneScopeClosedError } from './scope'
export type { MountScopeState } from './scope'
export {
  scopedDataApi,
  scopedAssetApi,
  scopedUiApi,
  scopedMapAccess,
  scopedGraphicsAccess
} from './scoped'
export type {
  SceneHostOptions,
  SceneViewport,
  MountOptions,
  MountResult,
  HostMount
} from './host'
export { createViewService } from './view'
export type { ViewServiceOptions } from './view'
export { createRevocableContext } from './context'
export type { ContextServices, ContextState } from './context'
export { UiApiImpl } from './ui'
