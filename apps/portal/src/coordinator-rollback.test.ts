import { describe, expect, it, vi } from 'vitest'
import type { HostMount, SceneHost } from '@twin/scene-host'
import { SceneCoordinator, type CoordinatorState } from './coordinator'
import { SCENE_CATALOG } from './catalog'

/**
 * I7 补强：切换失败回滚路径（§10/§11）——host.mount 抛错时状态回到
 * error、不遗留半挂载，且后续选择可恢复。
 */

function failingHostOnce(failScene: string) {
  const calls: string[] = []
  const host = {
    unmount: vi.fn(async () => ({ errors: [], timedOut: false })),
    mount: vi.fn(async (entry: unknown, options: { sceneId?: string }) => {
      calls.push(`mount:${options.sceneId}`)
      if (options.sceneId === failScene) {
        throw new Error(`boot failed for ${failScene}`)
      }
      calls.push(`mounted:${options.sceneId}`)
      return {
        state: 'active',
        sceneId: options.sceneId,
        done: Promise.resolve({ errors: [], timedOut: false }),
        unmount: async () => ({ errors: [], timedOut: false })
      } as unknown as HostMount
    })
  }
  return { host: host as unknown as SceneHost, calls }
}

function statesCollector() {
  const states: CoordinatorState[] = []
  return {
    onStateChange: (s: CoordinatorState) => states.push(s),
    states
  }
}

describe('SceneCoordinator 回滚路径（§10/§11，I7 补强）', () => {
  it('host.mount 抛错 → error 态，错误经 onError 上报', async () => {
    const { host, calls } = failingHostOnce('stack-yard')
    const onError = vi.fn()
    const { states } = statesCollector()
    const collector = statesCollector()
    const coordinator = new SceneCoordinator(host, SCENE_CATALOG, {
      permissions: () => ['scene:production', 'scene:simulation'],
      onError,
      onStateChange: collector.onStateChange
    })
    void states

    await coordinator.select('stack-yard')
    expect(coordinator.state.kind).toBe('error')
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'stack-yard')
    expect(calls).toContain('mount:stack-yard')
    expect(collector.states.at(-1)?.kind).toBe('error')
  })

  it('失败后再次选择其他场景可恢复', async () => {
    let failNext = true
    const host = {
      unmount: vi.fn(async () => ({ errors: [], timedOut: false })),
      mount: vi.fn(async (_entry: unknown, options: { sceneId?: string }) => {
        if (failNext && options.sceneId === 'global-ships') {
          failNext = false
          throw new Error('transient boot failure')
        }
        return {
          state: 'active',
          sceneId: options.sceneId,
          done: Promise.resolve({ errors: [], timedOut: false }),
          unmount: async () => ({ errors: [], timedOut: false })
        } as unknown as HostMount
      })
    }
    const coordinator = new SceneCoordinator(
      host as unknown as SceneHost,
      SCENE_CATALOG,
      { permissions: () => ['scene:production', 'scene:simulation'] }
    )

    await coordinator.select('global-ships')
    expect(coordinator.state.kind).toBe('error')

    await coordinator.select('global-ships') // 重试成功
    expect(coordinator.state.kind).toBe('active')
  })

  it('卸载旧场景先于挂载新场景（§11 事务顺序）', async () => {
    const order: string[] = []
    const host = {
      unmount: vi.fn(async () => {
        order.push('unmount-current')
        return { errors: [], timedOut: false }
      }),
      mount: vi.fn(async () => {
        order.push('mount-target')
        return {
          state: 'active',
          done: Promise.resolve({ errors: [], timedOut: false }),
          unmount: async () => ({ errors: [], timedOut: false })
        } as unknown as HostMount
      })
    }
    const coordinator = new SceneCoordinator(
      host as unknown as SceneHost,
      SCENE_CATALOG,
      { permissions: () => ['scene:production', 'scene:simulation'] }
    )
    await coordinator.select('heavy-transport')
    expect(order).toEqual(['unmount-current', 'mount-target'])
  })
})

describe('force 重选（I10-1：站点切换重跑场景）', () => {
  it('同场景 + force → 完整重跑（卸载旧挂载并重新挂载）', async () => {
    const { host, calls } = (() => {
      const calls: string[] = []
      const host = {
        unmount: vi.fn(async () => {
          calls.push('unmount')
          return { errors: [], timedOut: false }
        }),
        mount: vi.fn(async (_e: unknown, o: { sceneId?: string }) => {
          calls.push(`mount:${o.sceneId}`)
          return {
            state: 'active',
            sceneId: o.sceneId,
            done: Promise.resolve({ errors: [], timedOut: false }),
            unmount: async () => ({ errors: [], timedOut: false })
          } as unknown as HostMount
        })
      }
      return { host: host as unknown as SceneHost, calls }
    })()
    const coordinator = new SceneCoordinator(host, SCENE_CATALOG, {
      permissions: () => ['scene:production', 'scene:simulation']
    })

    await coordinator.select('production')
    expect(coordinator.state.kind).toBe('active')
    await coordinator.select('production', { force: true })
    expect(coordinator.state.kind).toBe('active')
    expect(calls.filter((c) => c.startsWith('mount')).length).toBe(2)
  })
})

/** ------------------------------------------------------ #3 复审：last-selection-wins 竞态 */

import type { SceneDefinition, SceneEntry } from '@twin/sdk'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function entryOk(): SceneEntry {
  return { mount: async () => ({ unmount: async () => {} }) }
}

function makeRaceHost() {
  type Handle = {
    resolve: () => void
    reject: (e: unknown) => void
    unmount: ReturnType<typeof vi.fn>
  }
  const handles: Record<string, Handle[]> = {}
  const host = {
    unmount: vi.fn(async () => ({ errors: [], timedOut: false })),
    mount: vi.fn(async (_e: unknown, o: { sceneId?: string }) => {
      const d = deferred<HostMount>()
      const unmount = vi.fn(async () => ({ errors: [], timedOut: false }))
      const handle: Handle = {
        resolve: () =>
          d.resolve({
            state: 'active',
            sceneId: o.sceneId,
            done: Promise.resolve({ errors: [], timedOut: false }),
            unmount
          } as unknown as HostMount),
        reject: d.reject,
        unmount
      }
      ;(handles[o.sceneId!] ??= []).push(handle)
      return d.promise
    })
  }
  const last = (sceneId: string): Handle => handles[sceneId]!.at(-1)!
  return { host: host as unknown as SceneHost, handles, last }
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await Promise.resolve()
  await Promise.resolve()
}

describe('SceneCoordinator 竞态：stale 异步结果不得覆盖最新选择（#3 复审）', () => {
  it('B.load pending → select C → C ACTIVE → B.load 晚到 reject：C 不变、不上报 stale 错误', async () => {
    const bLoad = deferred<SceneEntry>()
    const catalog: SceneDefinition[] = [
      { id: 'scene-b', name: 'B', load: () => bLoad.promise },
      { id: 'scene-c', name: 'C', load: async () => entryOk() }
    ]
    const { host, last } = makeRaceHost()
    const onError = vi.fn()
    const coordinator = new SceneCoordinator(host, catalog, { onError })

    const pB = coordinator.select('scene-b')
    const pC = coordinator.select('scene-c')
    await flush() // select 需经 microtask 才到达 host.mount
    last('scene-c').resolve()
    await pC
    expect(coordinator.state).toMatchObject({ kind: 'active', sceneId: 'scene-c' })

    bLoad.reject(new Error('late load failure'))
    await pB
    await flush()

    expect(coordinator.state).toMatchObject({ kind: 'active', sceneId: 'scene-c' })
    expect(onError).not.toHaveBeenCalled()
  })

  it('B.mount 晚到成功（stale）：先 teardown 再丢弃，绝不 commit', async () => {
    const catalog: SceneDefinition[] = [
      { id: 'scene-b', name: 'B', load: async () => entryOk() },
      { id: 'scene-c', name: 'C', load: async () => entryOk() }
    ]
    const { host, handles, last } = makeRaceHost()
    const coordinator = new SceneCoordinator(host, catalog)

    const pB = coordinator.select('scene-b')
    await flush() // B 的 host.mount 已 pending
    // B 的 host.mount 已 pending；用户选择 C
    const pC = coordinator.select('scene-c')
    await flush()
    last('scene-c').resolve()
    await pC
    expect(coordinator.state).toMatchObject({ kind: 'active', sceneId: 'scene-c' })

    // B 的 mount 晚到成功 → 必须被 teardown 后丢弃
    last('scene-b').resolve()
    await pB
    await flush()

    expect(coordinator.state).toMatchObject({ kind: 'active', sceneId: 'scene-c' })
    expect(handles['scene-b']![0]!.unmount).toHaveBeenCalledTimes(1)
  })

  it('B.mount 晚到 reject：不得改变 C 的状态', async () => {
    const catalog: SceneDefinition[] = [
      { id: 'scene-b', name: 'B', load: async () => entryOk() },
      { id: 'scene-c', name: 'C', load: async () => entryOk() }
    ]
    const { host, last } = makeRaceHost()
    const onError = vi.fn()
    const coordinator = new SceneCoordinator(host, catalog, { onError })

    const pB = coordinator.select('scene-b')
    await flush()
    const pC = coordinator.select('scene-c')
    await flush()
    last('scene-c').resolve()
    await pC

    last('scene-b').reject(new Error('late boot failure'))
    await pB
    await flush()

    expect(coordinator.state).toMatchObject({ kind: 'active', sceneId: 'scene-c' })
    expect(onError).not.toHaveBeenCalled()
  })

  it('A rollback pending → select C → rollback 晚到完成：C 不被覆盖，stale prevMount 被回收', async () => {
    const aRollbackLoad = deferred<SceneEntry>()
    const aLoads: Array<Promise<SceneEntry>> = [
      Promise.resolve(entryOk()),
      aRollbackLoad.promise
    ]
    const catalog: SceneDefinition[] = [
      { id: 'scene-a', name: 'A', load: () => aLoads.shift()! },
      { id: 'scene-b', name: 'B', load: async () => entryOk() },
      { id: 'scene-c', name: 'C', load: async () => entryOk() }
    ]
    const { host, last } = makeRaceHost()
    const coordinator = new SceneCoordinator(host, catalog)

    // A active
    const pA = coordinator.select('scene-a')
    await flush()
    last('scene-a').resolve()
    await pA
    expect(coordinator.state).toMatchObject({ kind: 'active', sceneId: 'scene-a' })

    // B mount fail → 进入 rollback（rollback 的 A.load pending）
    const pB = coordinator.select('scene-b')
    await flush()
    last('scene-b').reject(new Error('boot failed'))
    await flush()

    // rollback 的 A.load 先完成 → rollback 进入 host.mount(A) pending
    aRollbackLoad.resolve(entryOk())
    await flush()

    // rollback mount pending 期间，用户选择 C
    const pC = coordinator.select('scene-c')
    await flush()
    last('scene-c').resolve()
    await pC
    expect(coordinator.state).toMatchObject({ kind: 'active', sceneId: 'scene-c' })

    // rollback mount 晚到成功 → stale：prevMount 必须被回收，C 不被覆盖
    last('scene-a').resolve()
    await pB
    await flush()

    expect(coordinator.state).toMatchObject({ kind: 'active', sceneId: 'scene-c' })
    // rollback 的 host.mount(A) 是 A 的第二个 handle
    expect(last('scene-a').unmount).toHaveBeenCalledTimes(1)
    // 全程不得进入 error（stale rollback 失败/被 supersede 均静默丢弃）
    expect(coordinator.state.kind).toBe('active')
  })

  it('loadControllers 按 controller identity 清理：stale generation 不误删新 controller', async () => {
    const d1 = deferred<SceneEntry>()
    const d2 = deferred<SceneEntry>()
    const loads = [d1.promise, d2.promise]
    const catalog: SceneDefinition[] = [
      { id: 'scene-b', name: 'B', load: () => loads.shift()! }
    ]
    const { host, handles } = makeRaceHost()
    const coordinator = new SceneCoordinator(host, catalog)

    const p1 = coordinator.select('scene-b') // gen1：load pending
    const p2 = coordinator.select('scene-b') // gen2：同 sceneId 新 controller

    // gen1 的 load 晚到成功：isCurrent=false 丢弃，且不得删除 gen2 的 controller
    d1.resolve(entryOk())
    await p1
    const controllers = coordinator as unknown as {
      loadControllers: Map<string, unknown>
    }
    expect(controllers.loadControllers.get('scene-b')).toBeDefined()

    // gen2 正常完成：load → unmount → mount → active
    d2.resolve(entryOk())
    await flush()
    handles['scene-b']![0]!.resolve()
    await p2
    expect(coordinator.state).toMatchObject({ kind: 'active', sceneId: 'scene-b' })
    expect(controllers.loadControllers.size).toBe(0)
  })
})
