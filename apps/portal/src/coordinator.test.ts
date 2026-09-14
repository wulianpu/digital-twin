import { describe, expect, it, vi } from 'vitest'
import type { SceneHost } from '@twin/scene-host'
import { SceneCoordinator } from './coordinator'
import { SCENE_CATALOG } from './catalog'

/**
 * I2-4: 权限拒绝路径 + 正常进入路径（进入前强制校验，I2-2）。
 */

function stubHost() {
  const host = {
    mount: vi.fn(async () => ({
      unmount: async () => ({ errors: [], timedOut: false }),
      state: 'active'
    })),
    unmount: vi.fn(async () => ({ errors: [], timedOut: false }))
  }
  return host as unknown as SceneHost & { mount: ReturnType<typeof vi.fn> }
}

describe('SceneCoordinator 权限强制 (I2-2)', () => {
  it('无权限 → denied 态，绝不触发 load/host.mount', async () => {
    const host = stubHost()
    const seen: string[] = []
    const coordinator = new SceneCoordinator(host, SCENE_CATALOG, {
      permissions: () => ['scene:simulation'], // 缺少 scene:production
      onStateChange: (s) => seen.push(s.kind)
    })
    await coordinator.select('production')
    expect(coordinator.state.kind).toBe('denied')
    expect(seen).toEqual(['denied'])
    expect(host.mount).not.toHaveBeenCalled()
  })

  it('未登录（空权限）→ denied', async () => {
    const host = stubHost()
    const coordinator = new SceneCoordinator(host, SCENE_CATALOG, {
      permissions: () => []
    })
    await coordinator.select('production')
    expect(coordinator.state.kind).toBe('denied')
    expect(host.mount).not.toHaveBeenCalled()
  })

  it('有权限 → 正常进入 active', async () => {
    const host = stubHost()
    const coordinator = new SceneCoordinator(host, SCENE_CATALOG, {
      permissions: () => ['scene:production', 'scene:simulation']
    })
    await coordinator.select('production')
    expect(coordinator.state.kind).toBe('active')
    expect(host.mount).toHaveBeenCalledTimes(1)
  })

  it('未提供 permissions 提供者时保持旧行为（不强制）', async () => {
    const host = stubHost()
    const coordinator = new SceneCoordinator(host, SCENE_CATALOG, {})
    await coordinator.select('production')
    expect(coordinator.state.kind).toBe('active')
    expect(host.mount).toHaveBeenCalledTimes(1)
  })
})
