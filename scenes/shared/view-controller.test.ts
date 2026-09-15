import { describe, expect, it, vi } from 'vitest'
import { SceneViewController, type SceneViewCallbacks } from './src/public'

/**
 * Issue #18-r3：boot reject 发生在 SceneMount abort 之后——
 * failure continuation 必须是 terminal no-op（不 rollback / 不 commit /
 * 不 dispatch / 不把 teardown race 报成 3D 初始化故障）。
 */

function makeCallbacks(overrides: Partial<SceneViewCallbacks> = {}) {
  let aborted = false
  const calls = {
    prepare: 0,
    apply: [] as string[],
    suspends: 0,
    dispatched: [] as string[],
    rollbacks: 0,
    errors: [] as unknown[],
    intentChanged: [] as string[]
  }
  const cb: SceneViewCallbacks = {
    prepareGraphics: async () => {
      calls.prepare++
      return {}
    },
    applyActiveView: (v) => {
      calls.apply.push(v)
      if (v === 'map') calls.suspends++
    },
    suspendGraphics: () => {
      calls.suspends++
    },
    dispatchView: (v) => {
      calls.dispatched.push(v)
    },
    isAborted: () => aborted,
    onIntentChanged: (v) => {
      calls.intentChanged.push(v)
    },
    onRollbackToMap: () => {
      calls.rollbacks++
    },
    onGraphicsError: (error) => {
      calls.errors.push(error)
    },
    ...overrides
  }
  return {
    cb,
    calls,
    setAborted: (v: boolean) => {
      aborted = v
    }
  }
}

describe('SceneViewController teardown reject（#18-r3）', () => {
  it('abort 后 boot reject：terminal no-op（不 rollback/commit/dispatch/报错）', async () => {
    let rejectBoot!: (e: unknown) => void
    const gate = new Promise<unknown>((_, j) => {
      rejectBoot = j
    })
    const { cb, calls, setAborted } = makeCallbacks({
      prepareGraphics: () => gate
    })
    const controller = new SceneViewController(cb)

    const p = controller.setView('graphics')
    setAborted(true) // teardown：MountScope close + signal abort
    rejectBoot(new Error('scope closed during late graphics.onPick'))
    await p

    expect(calls.rollbacks).toBe(0)
    expect(calls.apply).toEqual([])
    expect(calls.dispatched).toEqual([])
    expect(calls.errors).toEqual([]) // teardown race 不报成 3D 初始化故障
    expect(controller.view).toBe('graphics') // 不做 state 回写
  })

  it('对照：Scene 仍 active 的 boot reject → 回滚 map + 错误可见（保留 #18 语义）', async () => {
    let rejectBoot!: (e: unknown) => void
    const gate = new Promise<unknown>((_, j) => {
      rejectBoot = j
    })
    const { cb, calls, setAborted } = makeCallbacks({
      prepareGraphics: () => gate
    })
    const onGraphicsError = vi.fn()
    const controller = new SceneViewController({ ...cb, onGraphicsError })

    const p = controller.setView('graphics')
    rejectBoot(new Error('real boot failure'))
    await p

    expect(calls.rollbacks).toBe(1)
    expect(calls.apply).toEqual(['map'])
    expect(calls.dispatched).toEqual(['map'])
    expect(onGraphicsError).toHaveBeenCalledTimes(1)
    // 回滚后可重试：新 attempt 会真实启动
    void setAborted
    expect(controller.view).toBe('map')
  })
})
