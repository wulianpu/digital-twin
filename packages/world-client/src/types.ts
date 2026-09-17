import type { WorldScope, WorldMode } from '@twin/world'
import type { Disposable } from '@twin/world'

export type { WorldMode }

/**
 * Data contract & envelope (Architecture Freeze v1.2 §33).
 * Foundation only understands the envelope; payload semantics belong to
 * Scenes / Domain contracts.
 */

export type DataContractId = string

export type DataQuality = 'good' | 'stale' | 'bad' | 'unknown'

export type Timestamp = number

export interface DataEnvelope<T = unknown> {
  contract: DataContractId
  key: string
  sourceTime: Timestamp
  ingestTime: Timestamp
  revision?: number
  quality: DataQuality
  payload: T
  /**
   * Issue #27：实体生命周期操作。缺省等价 'upsert'；'delete' 为 tombstone——
   * 表示该 key 已离场（payload 无意义），参与同 key revision 排序，
   * 且不会被 staleness sweep 复活为 good。
   */
  op?: 'upsert' | 'delete'
}

export interface DataQuery {
  contract: DataContractId
  scope?: WorldScope
  /** Restrict to specific envelope keys (e.g. entity keys). */
  keys?: readonly string[]
}

export interface DataSubscription extends Disposable {
  readonly query: DataQuery
}

export type EnvelopeHandler<T = unknown> = (envelope: DataEnvelope<T>) => void
