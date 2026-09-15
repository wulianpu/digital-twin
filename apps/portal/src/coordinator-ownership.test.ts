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
