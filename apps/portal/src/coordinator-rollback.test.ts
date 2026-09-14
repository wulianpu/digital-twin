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
