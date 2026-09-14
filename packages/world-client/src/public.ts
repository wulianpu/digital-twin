/**
 * @twin/world-client — world state client (Foundation, §33-36).
 * Must not depend on Vue, Three or MapLibre (CI-enforced).
 */

export type {
  DataContractId,
  DataQuality,
  DataEnvelope,
  DataQuery,
  DataSubscription,
  SubscribeOptions,
  Timestamp,
  EnvelopeHandler
} from './types'
export type { DataSource } from './source'
export { WorldClient } from './client'
export type { DataApi, WorldClientOptions } from './client'
export { createScriptedSource } from './sources/scripted'
export type { ScriptedSource, ScriptedSourceOptions, ScriptedTickContext } from './sources/scripted'
export { createReplaySource } from './sources/replay'
export type { ReplaySource, ReplaySourceOptions, ReplayFrame } from './sources/replay'
export { createWebSocketSource } from './sources/websocket'
export type {
  WebSocketSource,
  WebSocketSourceOptions,
  WebSocketLike,
  SocketFactory,
  GatewayConnectionState,
  GatewayErrorFrame
} from './sources/websocket'
export { SpatialStateBuffer, createPoseSample } from './stateBuffer'
export type { PoseWrite, PoseSample } from './stateBuffer'
