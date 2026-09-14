import type { GeodeticPosition } from '@twin/spatial'

/** Foundation domain types (Architecture Freeze v1.2 §29-32, §40-41). */

export type WorldId = string
export type SiteId = string

/** Stable object identity (§32). Foundation does not understand namespaces. */
export interface EntityRef {
  namespace: string
  id: string
}

export function entityKey(ref: EntityRef): string {
  return `${ref.namespace}/${ref.id}`
}

export function parseEntityKey(key: string): EntityRef {
  const index = key.indexOf('/')
  if (index <= 0 || index === key.length - 1) {
    throw new Error(`[world] invalid entity key "${key}" (expected "namespace/id")`)
  }
  return { namespace: key.slice(0, index), id: key.slice(index + 1) }
}

export type WorldScope =
  | { kind: 'global' }
  | { kind: 'site'; siteId: SiteId }
  | { kind: 'entity'; entity: EntityRef }

export type WorldMode = 'live' | 'history' | 'simulation'

export interface WorldTime {
  readonly mode: WorldMode
  /** Epoch milliseconds in the mode's own timeline. */
  readonly epochMillis: number
  /** Simulation/history playback multiplier; 1 for live. */
  readonly speed: number
}

export interface WorldSession {
  readonly worldId: WorldId
  readonly mode: WorldMode
  readonly scope: WorldScope
  readonly time: WorldTime
}

export interface GeoBounds {
  readonly south: number
  readonly west: number
  readonly north: number
  readonly east: number
}

export function boundsContains(b: GeoBounds, p: GeodeticPosition): boolean {
  return (
    p.latitudeDegrees >= b.south &&
    p.latitudeDegrees <= b.north &&
    p.longitudeDegrees >= b.west &&
    p.longitudeDegrees <= b.east
  )
}

export function boundsCenter(b: GeoBounds): { longitudeDegrees: number; latitudeDegrees: number } {
  return {
    longitudeDegrees: (b.west + b.east) / 2,
    latitudeDegrees: (b.south + b.north) / 2
  }
}

/** A site (厂区 / 港区 / 基地). WorldContent linkage lives in `@twin/content`. */
export interface Site {
  readonly id: SiteId
  readonly name: string
  readonly origin: GeodeticPosition
  readonly bounds: GeoBounds
  /** Optional display metadata for catalogs / panels. */
  readonly description?: string
}

export interface SelectionState {
  readonly primary: EntityRef | undefined
  readonly secondary: readonly EntityRef[]
}
