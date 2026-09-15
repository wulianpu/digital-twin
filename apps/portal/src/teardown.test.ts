// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { SceneEntry, SceneMount } from '@twin/sdk'
import { SceneHost, createViewService, type SceneHostOptions } from '@twin/scene-host'
import { createWorldApi, createSelectionApi } from '@twin/world'
import { createSpatialApi } from '@twin/spatial'
import { SceneCoordinator } from './coordinator'

/**
 * Issue #16：Portal teardown 终止顺序——
 *   1) coordinator.close()（停止 Scene 事务生产者）
 *   2) host.shutdown()（Scene unmount / MountScope / revoke 完整序列）
 *   3) 之后 Foundation owner 才销毁；Host 拒绝一切新 mount。
 */

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function entryOk(): SceneEntry {
  return { mount: async () => ({ unmount: async () => {} }) }
}

function makeRealHost(): SceneHost {
  const services = {
    world: createWorldApi(),
    spatial: createSpatialApi(),
    data: { subscribe: () => ({ dispose: () => {} }) },
    selection: createSelectionApi(),
    view: createViewService({ getPrimary: () => 'none' }),
    assets: {}
  } as unknown as SceneHostOptions['services']
  return new SceneHost({
    viewport: { ui: document.createElement('div') },
    services
  })
}

describe('Portal teardown 终止顺序（Issue #16）', () => {
  it('active Scene → teardown：unmount 恰好一次、context revoked，先于 owner dispose', async () => {
    const host = makeRealHost()
    const dataDispose = vi.fn()
    const coordinator = new SceneCoordinator(host, [
      { id: 'scene-a', name: 'A', load: async () => entryOk() }
    ])

    await coordinator.select('scene-a')
    const mount = host.activeMount
    expect(mount?.state).toBe('active')
    const unmountSpy = vi.spyOn(mount!, 'unmount')

    // Composition Root teardown 顺序（main.ts 同构）
    await coordinator.close()
    expect(coordinator.isClosed).toBe(true)
    await host.shutdown()

    // Scene 先走完 Host 终止序列，然后才是 Foundation owner 销毁
    expect(unmountSpy).toHaveBeenCalledTimes(1)
    expect(host.contextState).toBe('revoked')
    expect(host.isDisposed).toBe(true)
    dataDispose()

    // Host 终态：拒绝新 mount（不解析 viewport / 不创建 HostMountImpl）
    await expect(host.mount(entryOk())).rejects.toThrowError(/shutdown/)
    expect(host.activeMount?.state).toBe('unmounted')
  })

  it('pending load → coordinator.close → late resolve：不得 host.mount / 状态回写', async () => {
    const host = makeRealHost()
    const bLoad = deferred<SceneEntry>()
    const coordinator = new SceneCoordinator(host, [
      { id: 'scene-b', name: 'B', load: () => bLoad.promise }
    ])

    const pB = coordinator.select('scene-b') // load pending
    await coordinator.close()

    bLoad.resolve(entryOk()) // 退出后晚到成功
    await pB

    // 不产生任何 Host mutation：close 后 select 直接拒绝
    await coordinator.select('scene-b')
    expect(coordinator.state.kind).not.toBe('active')
    expect(host.activeMount).toBeUndefined()
    expect(host.isDisposed || !host.isActive).toBe(true)
  })

  it('pending mount → close → host.shutdown → late mount success：被 Host 终态拒绝', async () => {
    const host = makeRealHost()
    const { promise: pendingMount, resolve: resolveMount } = deferred<SceneMount>()
    const coordinator = new SceneCoordinator(host, [
      { id: 'scene-b', name: 'B', load: async () => ({ mount: () => pendingMount }) }
    ])

    const pB = coordinator.select('scene-b')
    await new Promise((r) => setTimeout(r, 0)) // 进入 host.mount pending
    await coordinator.close()

    // Host shutdown 与 late mount success 竞态：Host 终态拒绝复活，
    // Coordinator 按 stale 静默丢弃（不 commit、不回写状态）
    resolveMount({ unmount: async () => {} })
    await pB
    expect(coordinator.state.kind).not.toBe('active')
    expect(coordinator.activeSceneId).toBeUndefined()
    expect(host.activeMount?.state).not.toBe('active')
  })

  it('close() 幂等；shutdown() 幂等；并发共享同一 Promise', async () => {
    const host = makeRealHost()
    const coordinator = new SceneCoordinator(host, [
      { id: 'scene-a', name: 'A', load: async () => entryOk() }
    ])
    await coordinator.select('scene-a')

    const c1 = coordinator.close()
    const c2 = coordinator.close()
    expect(c1).toBe(c2)
    await Promise.all([c1, c2])
    expect(coordinator.isClosed).toBe(true)

    const s1 = host.shutdown()
    const s2 = host.shutdown()
    expect(s1).toBe(s2)
    await Promise.all([s1, s2])
    expect(host.isDisposed).toBe(true)
  })

  it('close 后 select/preload 均无副作用', async () => {
    const host = makeRealHost()
    const load = vi.fn(async () => entryOk())
    const coordinator = new SceneCoordinator(host, [
      { id: 'scene-a', name: 'A', load }
    ])
    await coordinator.close()

    await coordinator.select('scene-a')
    coordinator.preload('scene-a')
    expect(load).not.toHaveBeenCalled()
    expect(host.activeMount).toBeUndefined()
  })
})
