// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { SceneDefinition, SceneEntry, SceneMount } from '@twin/sdk'
import { SceneHost, createViewService, type SceneHostOptions } from '@twin/scene-host'
import { createWorldApi, createSelectionApi } from '@twin/world'
import { createSpatialApi } from '@twin/spatial'
import { SceneCoordinator } from './coordinator'

/**
 * #10-r2：使用**真实 SceneHost** 的 ownership 一致性集成测试——
 * fake host 不维护 current mount，会掩盖 active 真值分叉。
 */

function deferredMount(): {
  promise: Promise<SceneMount>
  resolve: (mount: SceneMount) => void
} {
  let resolve!: (mount: SceneMount) => void
  const promise = new Promise<SceneMount>((res) => {
    resolve = res
  })
  return { promise, resolve }
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

function entryMounting(): { entry: SceneEntry; resolveMount: (m: SceneMount) => void } {
  const { promise, resolve } = deferredMount()
  return { entry: { mount: () => promise }, resolveMount: resolve }
}

function entryOk(): SceneEntry {
  return { mount: async () => ({ unmount: async () => {} }) }
}

describe('Coordinator × 真实 SceneHost：active 真值一致（#10-r2）', () => {
  it('A active → B mount pending → select A：最终 coordinator 与 Host 的 active 一致且真实', async () => {
    const host = makeRealHost()
    const b = entryMounting()
    const catalog: SceneDefinition[] = [
      { id: 'scene-a', name: 'A', load: async () => entryOk() },
      { id: 'scene-b', name: 'B', load: async () => b.entry }
    ]
    const coordinator = new SceneCoordinator(host, catalog)

    // A active（真实 Host mount）
    await coordinator.select('scene-a')
    expect(coordinator.activeSceneId).toBe('scene-a')
    expect(host.activeMount?.state).toBe('active')
    expect(host.activeMount?.sceneId).toBe('scene-a')

    // B：事务先卸载 A，再 pending 在 B.entry.mount 上
    const pB = coordinator.select('scene-b')
    await vi.waitFor(() => expect(host.activeMount?.state).toBe('mounting'))
    // 恒等式：A 已被卸载，Coordinator 不得再报告 A
    expect(coordinator.activeSceneId).toBeUndefined()

    // 用户重选 A → 真实重试（B 的 pending mount 被 Host teardown，复活防线 reject）
    await coordinator.select('scene-a')
    b.resolveMount({ unmount: async () => {} }) // B 晚到 resolve
    await pB.catch(() => {}) // stale B 的 host.mount 以 SceneUnmountedError reject

    // 真值一致：Coordinator ownership === Host active mount
    expect(coordinator.state).toMatchObject({ kind: 'active', sceneId: 'scene-a' })
    expect(coordinator.activeSceneId).toBe('scene-a')
    expect(host.activeMount?.state).toBe('active')
    expect(host.activeMount?.sceneId).toBe('scene-a')
    expect(host.contextState).toBe('active')
  })
})

/** ------------------------------------ #10-r3：reconcile intent/generation identity */

function deferredLoad(): {
  promise: Promise<SceneEntry>
  resolve: (entry: SceneEntry) => void
} {
  let resolve!: (entry: SceneEntry) => void
  const promise = new Promise<SceneEntry>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('reconcile 的 intent/generation identity（#10-r3，真实 SceneHost）', () => {
  it('补偿 load 晚到 + D 已 commit：reconcile 不得 mount(A)、D 保持 ACTIVE', async () => {
    const host = makeRealHost()
    const b = entryMounting()
    const aReconcileLoad = deferredLoad()
    const aLoads = [Promise.resolve(entryOk()), aReconcileLoad.promise]
    const catalog: SceneDefinition[] = [
      { id: 'scene-a', name: 'A', load: () => aLoads.shift()! },
      { id: 'scene-b', name: 'B', load: async () => b.entry },
      { id: 'scene-c', name: 'C', permissions: ['secret'], load: async () => entryOk() },
      { id: 'scene-d', name: 'D', load: async () => entryOk() }
    ]
    const coordinator = new SceneCoordinator(host, catalog, { permissions: () => [] })

    await coordinator.select('scene-a')
    expect(coordinator.activeSceneId).toBe('scene-a')

    // B：卸载 A → mount pending
    const pB = coordinator.select('scene-b')
    await vi.waitFor(() => expect(host.activeMount?.state).toBe('mounting'))
    // C denied（noop intent）→ B stale 后将开始补偿
    await coordinator.select('scene-c')
    expect(coordinator.state).toMatchObject({ kind: 'denied', sceneId: 'scene-c' })

    // 放行 B 的 entry.mount → B stale-after-mount → 进入 reconcile(A)
    // reconcile 的 A.load pending 期间，用户选择 D
    b.resolveMount({ unmount: async () => {} })
    const pBSettled = pB.catch(() => {})
    const pD = coordinator.select('scene-d')
    await pD
    expect(coordinator.state).toMatchObject({ kind: 'active', sceneId: 'scene-d' })

    // A 的补偿 load 现在才 resolve → reconcile 必须放弃，绝不 mount(A) teardown D
    aReconcileLoad.resolve(entryOk())
    await pBSettled
    await coordinator['reconcileTail']
    await flushMicrotasks()

    expect(coordinator.state).toMatchObject({ kind: 'active', sceneId: 'scene-d' })
    expect(coordinator.activeSceneId).toBe('scene-d')
    expect(host.activeMount?.state).toBe('active')
    expect(host.activeMount?.sceneId).toBe('scene-d')
  })

  it('D mount pending 期间补偿 load resolve：reconcile 不得取消 D', async () => {
    const host = makeRealHost()
    const b = entryMounting()
    const d = entryMounting()
    const aReconcileLoad = deferredLoad()
    const aLoads = [Promise.resolve(entryOk()), aReconcileLoad.promise]
    const catalog: SceneDefinition[] = [
      { id: 'scene-a', name: 'A', load: () => aLoads.shift()! },
      { id: 'scene-b', name: 'B', load: async () => b.entry },
      { id: 'scene-c', name: 'C', permissions: ['secret'], load: async () => entryOk() },
      { id: 'scene-d', name: 'D', load: async () => d.entry }
    ]
    const coordinator = new SceneCoordinator(host, catalog, { permissions: () => [] })

    await coordinator.select('scene-a')
    const pB = coordinator.select('scene-b')
    await vi.waitFor(() => expect(host.activeMount?.state).toBe('mounting'))
    await coordinator.select('scene-c')

    b.resolveMount({ unmount: async () => {} })
    const pBSettled = pB.catch(() => {})

    // D 进入 host.mount pending；此时补偿 A.load resolve
    const pD = coordinator.select('scene-d')
    await vi.waitFor(() => expect(host.activeMount?.state).toBe('mounting'))
    aReconcileLoad.resolve(entryOk())
    await coordinator['reconcileTail']
    await pBSettled

    // D 晚到 resolve → 正常 ACTIVE，而不是被 stale reconcile 打成 ERROR
    d.resolveMount({ unmount: async () => {} })
    await pD

    expect(coordinator.state).toMatchObject({ kind: 'active', sceneId: 'scene-d' })
    expect(coordinator.activeSceneId).toBe('scene-d')
    expect(host.activeMount?.state).toBe('active')
    expect(host.activeMount?.sceneId).toBe('scene-d')
  })

  it('连续 noop intent：补偿为新 generation 重跑一轮并恢复 A', async () => {
    const host = makeRealHost()
    const b = entryMounting()
    const aReconcileLoad = deferredLoad()
    const aLoads = [Promise.resolve(entryOk()), aReconcileLoad.promise]
    const catalog: SceneDefinition[] = [
      {
        id: 'scene-a',
        name: 'A',
        load: () => aLoads.shift() ?? Promise.resolve(entryOk())
      },
      { id: 'scene-b', name: 'B', load: async () => b.entry },
      { id: 'scene-c', name: 'C', permissions: ['secret'], load: async () => entryOk() },
      { id: 'scene-e', name: 'E', permissions: ['secret-2'], load: async () => entryOk() }
    ]
    const coordinator = new SceneCoordinator(host, catalog, { permissions: () => [] })

    await coordinator.select('scene-a')
    const pB = coordinator.select('scene-b')
    await vi.waitFor(() => expect(host.activeMount?.state).toBe('mounting'))
    await coordinator.select('scene-c') // noop intent（denied C）

    b.resolveMount({ unmount: async () => {} })
    const pBSettled = pB.catch(() => {})

    // 补偿 load pending 期间，又一次 noop intent（denied E）：
    // 补偿必须为 E 的 generation 重跑一轮，而不是按旧结果直接放弃
    const pE = coordinator.select('scene-e')
    await pE
    aReconcileLoad.resolve(entryOk())
    await pBSettled
    await coordinator['reconcileTail']
    await flushMicrotasks()

    // 补偿为新 generation 重跑 → A 真实恢复
    expect(coordinator.state).toMatchObject({ kind: 'active', sceneId: 'scene-a' })
    expect(coordinator.activeSceneId).toBe('scene-a')
    expect(host.activeMount?.state).toBe('active')
    expect(host.activeMount?.sceneId).toBe('scene-a')
  })
})

async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await Promise.resolve()
  await Promise.resolve()
}
