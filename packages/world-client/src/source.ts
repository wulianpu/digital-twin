import type { DataEnvelope, DataQuery, WorldMode } from './types'
import type { Disposable } from '@twin/world'

/**
 * A world data source (live / history / simulation). The browser reaches the
 * Platform Gateway through one source per mode (§34, §81); protocol details
 * (MQTT / Kafka / OPC UA / AIS …) never leak past this interface.
 */
export interface DataSource {
  readonly kind: WorldMode
  snapshot(query: DataQuery): Promise<readonly DataEnvelope[]>
  subscribe(query: DataQuery, cb: (envelope: DataEnvelope) => void): Disposable
  dispose(): void
}
