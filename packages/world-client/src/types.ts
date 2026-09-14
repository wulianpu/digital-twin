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

export interface SubscribeOptions {
  /** Mark cached values stale when sourceTime falls behind by this much. */
  staleAfterMs?: number
}

export type EnvelopeHandler<T = unknown> = (envelope: DataEnvelope<T>) => void
