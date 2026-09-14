import { entityKey } from './types'
import type { Disposable } from './lifecycle'
import type { EntityRef, SelectionState } from './types'

export interface SelectionApi {
  /** Current selection snapshot (stable identity across engines, §57). */
  readonly current: SelectionState
  setPrimary(entity: EntityRef | undefined): void
  setSecondary(entities: readonly EntityRef[]): void
  toggle(entity: EntityRef): void
  clear(): void
  isSelected(entity: EntityRef): boolean
  onChange(cb: (state: SelectionState) => void): Disposable
}

/**
 * Selection belongs to the World context, NOT to any engine. A selection
 * made on the 2D map survives switching to 3D — there is exactly one
 * business selection, engines only render it.
 */
export function createSelectionApi(): SelectionApi {
  let primary: EntityRef | undefined
  let secondary: EntityRef[] = []
  const listeners = new Set<(state: SelectionState) => void>()

  function emit(): void {
    const snapshot: SelectionState = {
      get primary() {
        return primary
      },
      get secondary() {
        return secondary
      }
    }
    for (const cb of listeners) cb(snapshot)
  }

  const api: SelectionApi = {
    get current() {
      return { primary, secondary: secondary }
    },
    setPrimary(entity) {
      if (
        primary === entity ||
        (primary !== undefined &&
          entity !== undefined &&
          entityKey(primary) === entityKey(entity))
      ) {
        return
      }
      primary = entity
      emit()
    },
    setSecondary(entities) {
      secondary = [...entities]
      emit()
    },
    toggle(entity) {
      const key = entityKey(entity)
      if (primary && entityKey(primary) === key) {
        primary = undefined
      } else {
        primary = entity
        secondary = secondary.filter((e) => entityKey(e) !== key)
      }
      emit()
    },
    clear() {
      if (!primary && secondary.length === 0) return
      primary = undefined
      secondary = []
      emit()
    },
    isSelected(entity) {
      const key = entityKey(entity)
      return (
        (primary !== undefined && entityKey(primary) === key) ||
        secondary.some((e) => entityKey(e) === key)
      )
    },
    onChange(cb) {
      listeners.add(cb)
      return {
        dispose: () => {
          listeners.delete(cb)
        }
      }
    }
  }
  return api
}
