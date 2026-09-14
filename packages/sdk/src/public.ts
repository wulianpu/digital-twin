/**
 * @twin/sdk — the stable scene-facing contract surface (Foundation).
 *
 * Runtime code here is intentionally tiny (helpers + error class). Everything
 * else is type-only, so importing @twin/sdk never pulls three or maplibre
 * into a bundle (CI-enforced by the architecture tests).
 */

export {
  SceneUnmountedError,
  sceneScopedId,
  isSceneScopedId
} from './types'

export type {
  SceneId,
  SceneDefinition,
  SceneEntry,
  SceneMount,
  SceneContext,
  Disposable,
  ViewKind,
  MapViewState,
  SceneViewState,
  ViewState,
  ViewTarget,
  ViewApi,
  ViewDriver,
  AssetLease,
  AssetApi,
  UiLayer,
  UiLayerOptions,
  UiApi
} from './types'

export type {
  FrameInfo,
  PickEvent,
  MapEngineState,
  MapAccess,
  MapContext,
  MapViewDriver,
  SceneEngineState,
  QualityProfile,
  WaterState,
  EnvironmentApi,
  GlobalEnvironmentApi,
  EntitySystemApi,
  GraphicsContext,
  GraphicsAccess,
  TilesPolicy,
  TilesDiagnostics,
  GraphicsDiagnostics,
  SceneViewDriver,
  ActiveFrameProvider
} from './engines'

export type { UserIdentity, IdentityAdapter } from './identity'

// Platform semantic types re-exported for scene convenience (type-only).
export type {
  WorldApi,
  SiteRegistryApi,
  WorldTimeApi,
  WorldSession,
  WorldScope,
  WorldMode,
  WorldTime,
  WorldId,
  SiteId,
  EntityRef,
  Site,
  GeoBounds,
  SelectionState,
  SelectionApi
} from '@twin/world'
export { entityKey, parseEntityKey } from '@twin/world'
export type {
  DataApi,
  DataEnvelope,
  DataQuery,
  DataContractId,
  DataQuality,
  DataSubscription,
  SubscribeOptions,
  EnvelopeHandler
} from '@twin/world-client'
export type {
  SpatialApi,
  ReferenceFrame,
  ReferenceFrameId,
  GeodeticPosition,
  Vec3d,
  Pose,
  SpatialAnchor,
  VerticalReference
} from '@twin/spatial'
export type {
  AssetRef,
  AssetDescriptor,
  AssetKind,
  WorldContent,
  ContentId,
  ContentRole,
  ContentRegistry
} from '@twin/content'
