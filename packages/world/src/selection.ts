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
export function createSelectionApi(
  onListenerError?: (error: unknown, meta: { event: string }) => void
): SelectionApi {
  let primary: EntityRef | undefined
  let secondary: EntityRef[] = []
  const listeners = new Set<(state: SelectionState) => void>()
  const failing = new WeakMap<(state: SelectionState) => void, true>()

/** Issue #5：snapshot 与内部 state 脱离别名（copy-on-read）。 */
function snapshotState(): SelectionState {
  return {
    primary: primary ? { ...primary } : undefined,
    secondary: secondary.map((entity) => ({ ...entity }))
  }
}

/** Issue #20：逐 listener 隔离 + 限频上报（与 #19 同策略）。 */
function notifyListeners(
  listeners: Set<(state: SelectionState) => void>,
  value: SelectionState
): void {
  for (const cb of [...listeners]) {
    try {
      cb(value)
      failing.delete(cb)
    } catch (error) {
      if (failing.has(cb)) continue // 已上报，限频
      failing.set(cb, true)
      try {
        onListenerError?.(error, { event: 'selection.changed' })
      } catch {
        /* sink 自身异常不得击穿 dispatch */
      }
    }
  }
}

/** Issue #6：write-side alias 防线——setter 入参立即拷贝，内部 truth
 * 不持有调用方可继续修改的 EntityRef 引用（identity 比较仍走 entityKey）。 */
function ownEntity(entity: EntityRef): EntityRef {
  return { ...entity }
}

function emit(): void {
  notifyListeners(listeners, snapshotState())
}

const api: SelectionApi = {
  get current() {
    return snapshotState()
  },
    setPrimary(entity) {
      if (
        primary !== undefined &&
        entity !== undefined &&
        entityKey(primary) === entityKey(entity)
      ) {
        return
      }
      primary = entity ? ownEntity(entity) : undefined
      emit()
    },
    setSecondary(entities) {
      secondary = entities.map(ownEntity)
      emit()
    },
    toggle(entity) {
      const key = entityKey(entity)
      if (primary && entityKey(primary) === key) {
        primary = undefined
      } else {
        primary = ownEntity(entity)
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
