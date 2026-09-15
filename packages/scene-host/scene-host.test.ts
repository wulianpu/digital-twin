// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { SceneHost, createViewService, type SceneHostOptions } from './src/public'
import type { SceneMount } from '@twin/sdk'
import { SceneUnmountedError, type SceneContext, type SceneEntry } from '@twin/sdk'

function makeServices(): SceneHostOptions['services'] & { data: unknown } {
  return {
    world: {} as never,
    spatial: {} as never,
    data: {
      subscribe: () => ({ dispose: () => {} })
    } as never,
    selection: {} as never,
    view: {} as never,
    assets: {} as never
  }
}

function makeHost(overrides: Partial<SceneHostOptions> = {}): {
  host: SceneHost
  uiContainer: HTMLElement
} {
  const uiContainer = document.createElement('div')
  const host = new SceneHost({
    viewport: { ui: uiContainer },
    services: makeServices() as SceneHostOptions['services'],
    ...overrides
  })
  return { host, uiContainer }
}

function entryThat(
  mount: (ctx: SceneContext) => Promise<{ unmount(): void | Promise<void> }>
): SceneEntry {
  return { mount }
}

describe('SceneHost lifecycle', () => {
  it('mounts and unmounts with abort signal', async () => {
    const { host } = makeHost()
    let abortFired = false
    let unmounted = false
    const entry = entryThat(async (ctx) => {
      ctx.signal.addEventListener('abort', () => {
        abortFired = true
      })
      return {
        unmount: () => {
          unmounted = true
        }
      }
    })
    const mount = await host.mount(entry)
    expect(mount.state).toBe('active')
    expect(host.contextState).toBe('active')
    await mount.unmount()
    expect(unmounted).toBe(true)
    expect(abortFired).toBe(true)
    expect(mount.state).toBe('unmounted')
    expect(host.contextState).toBe('revoked')
  })

  it('unmount is idempotent (§12.1)', async () => {
    const { host } = makeHost()
    let unmountCalls = 0
    const mount = await host.mount(
      entryThat(async () => ({
        unmount: () => {
          unmountCalls++
        }
      }))
    )
    await mount.unmount()
    await mount.unmount()
    await mount.unmount()
    expect(unmountCalls).toBe(1)
  })

  it('is exception-safe: host cleanup runs after scene cleanup throws (§12.2)', async () => {
    const onError = vi.fn()
    const { host, uiContainer } = makeHost({ onError })
    const mount = await host.mount(
      entryThat(async (ctx) => {
        ctx.ui.createLayer()
        return {
          unmount: () => {
            throw new Error('scene cleanup exploded')
          }
        }
      })
    )
    const result = await mount.unmount()
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'scene-unmount')
    expect(result.errors).toHaveLength(1)
    // Host-owned UI layers removed anyway.
    expect(uiContainer.children).toHaveLength(0)
  })

  it('is time-bounded: deadline forces continuation (§12.3)', async () => {
    vi.useFakeTimers()
    try {
      const onError = vi.fn()
      const { host } = makeHost({ unmountDeadlineMs: 50, onError })
      const mount = await host.mount(
        entryThat(async () => ({
          unmount: () => new Promise<void>(() => {}) // hangs forever
        }))
      )
      const resultP = mount.unmount()
      await vi.advanceTimersByTimeAsync(80)
      const result = await resultP
      expect(result.timedOut).toBe(true)
      expect(mount.state).toBe('unmounted')
      expect(host.contextState).toBe('revoked')
      expect(onError).toHaveBeenCalledWith(expect.any(Error), 'deadline')
    } finally {
      vi.useRealTimers()
    }
  })

  it('revokes the context after unmount: stale writes throw (§13)', async () => {
    const { host } = makeHost()
    let captured: SceneContext | undefined
    const mount = await host.mount(
      entryThat(async (ctx) => {
        captured = ctx
        return { unmount: () => {} }
      })
    )
    await mount.unmount()
    expect(() => captured!.ui).toThrowError(SceneUnmountedError)
    expect(() => captured!.data).toThrowError(/revoked/)
    // signal stays readable for finally-blocks
    expect(captured!.signal.aborted).toBe(true)
  })

  it('mount 失败：cleanup 兜底后向调用方 reject（问题1 契约）', async () => {
    const onError = vi.fn()
    const { host } = makeHost({ onError })
    const mountPromise = host.mount({
      mount: async () => {
        throw new Error('nope')
      }
    })
    // 问题1：失败不被吞掉——cleanup 完成后原始错误重新抛出
    await expect(mountPromise).rejects.toThrow('nope')
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'mount')
    expect(host.contextState).toBe('revoked')
  })

  it('auto-unmounts a previous mount when mounting a new scene', async () => {
    const { host } = makeHost()
    const firstUnmount = vi.fn()
    await host.mount(entryThat(async () => ({ unmount: firstUnmount })))
    await host.mount(entryThat(async () => ({ unmount: () => {} })))
    expect(firstUnmount).toHaveBeenCalledTimes(1)
  })

  it('tracks and cleans up ui layers created via ctx.ui', async () => {
    const { host, uiContainer } = makeHost()
    const mount = await host.mount(
      entryThat(async (ctx) => {
        ctx.ui.createLayer()
        ctx.ui.createLayer()
        expect(uiContainer.children).toHaveLength(2)
        return { unmount: () => {} } // scene "forgets" to remove layers
      })
    )
    await mount.unmount()
    expect(uiContainer.children).toHaveLength(0)
  })
})

describe('ViewService', () => {
  it('delegates to the primary driver and keeps working when none is active', async () => {
    const map = {
      focus: vi.fn(),
      goToSite: vi.fn(),
      setTarget: vi.fn(),
      getTarget: () => ({ target: { longitudeDegrees: 0, latitudeDegrees: 0, heightMeters: 0, verticalReference: 'ellipsoid' as const } })
    }
    const scene = {
      focus: vi.fn(),
      goToSite: vi.fn(),
      setTarget: vi.fn(),
      getTarget: () => undefined
    }
    let primary: 'map' | 'scene' | 'none' = 'none'
    const view = createViewService({ mapDriver: map, sceneDriver: scene, getPrimary: () => primary })

    await view.focus({ namespace: 'a', id: 'b' })
    expect(map.focus).not.toHaveBeenCalled()
    expect(scene.focus).not.toHaveBeenCalled()

    primary = 'map'
    await view.focus({ namespace: 'a', id: 'b' })
    expect(map.focus).toHaveBeenCalledTimes(1)
    expect(view.getTarget()?.target.latitudeDegrees).toBe(0)

    primary = 'scene'
    await view.goToSite('site-a')
    expect(scene.goToSite).toHaveBeenCalledWith('site-a')
  })
})

describe('HostMount late-resolve 复活防线（#3 复审）', () => {
  function deferredMount() {
    let resolve!: (value: SceneMount) => void
    const promise = new Promise<SceneMount>((res) => {
      resolve = res
    })
    return { promise, resolve }
  }

  it('teardown 先于 entry.mount resolve：不得 unmounted→active，迟到 SceneMount 一次性回收', async () => {
    const { host } = makeHost()
    const { promise, resolve } = deferredMount()
    const lateUnmount = vi.fn(async () => {})

    const mountPromise = host.mount({ mount: () => promise })
    // teardown 抢在 mount resolve 之前完成
    const unmountPromise = host.unmount()
    await unmountPromise
    expect(host.isActive).toBe(false)

    // 迟到的 SceneMount：不得复活为 active，且被 best-effort 回收
    resolve({ unmount: lateUnmount })
    await expect(mountPromise).rejects.toThrowError(SceneUnmountedError)
    expect(lateUnmount).toHaveBeenCalledTimes(1)
    expect(host.activeMount?.state).toBe('unmounted')
    expect(host.contextState).toBe('revoked')

    // 幂等：后续 unmount 不再触发第二次 cleanup
    const result = await host.unmount()
    expect(lateUnmount).toHaveBeenCalledTimes(1)
    expect(result.timedOut).toBe(false)
  })

  it('迟到的 SceneMount cleanup 抛错 → onError(host-cleanup)，仍不得复活', async () => {
    const onError = vi.fn()
    const { host } = makeHost({ onError })
    const { promise, resolve } = deferredMount()

    const mountPromise = host.mount({ mount: () => promise })
    await host.unmount()

    resolve({
      unmount: () => {
        throw new Error('late cleanup exploded')
      }
    })
    await expect(mountPromise).rejects.toThrowError(SceneUnmountedError)
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      'host-cleanup'
    )
    expect(host.activeMount?.state).toBe('unmounted')
  })
})
