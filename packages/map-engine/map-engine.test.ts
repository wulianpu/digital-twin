import { describe, expect, it } from 'vitest'
import { buildDefaultStyle, createMapAccess, zoomForScaleMeters, scaleMetersForZoom } from './src/public'

describe('default style', () => {
  it('builds an offline-safe style without raster tiles', () => {
    const style = buildDefaultStyle() as {
      version: number
      layers: Array<{ id: string }>
      sources: Record<string, unknown>
    }
    expect(style.version).toBe(8)
    expect(style.layers.map((l) => l.id)).toContain('twin-base-background')
    expect(Object.keys(style.sources)).toHaveLength(0)
  })

  it('includes raster source when configured', () => {
    const style = buildDefaultStyle({
      rasterTilesUrl: 'https://tiles.example/{z}/{x}/{y}.png'
    }) as { sources: Record<string, { type: string }> }
    expect(style.sources['twin-base-raster']).toBeDefined()
    expect(style.sources['twin-base-raster'].type).toBe('raster')
  })
})

describe('zoom <-> scale conversion', () => {
  it('round-trips approximately', () => {
    const zoom = zoomForScaleMeters(1000, 31.36, 1024)
    const scale = scaleMetersForZoom(zoom, 31.36, 1024)
    expect(scale).toBeCloseTo(1000, 0)
    expect(zoom).toBeGreaterThan(10)
    expect(zoom).toBeLessThan(22)
  })

  it('higher zoom means smaller scale', () => {
    expect(zoomForScaleMeters(100, 0, 512)).toBeGreaterThan(
      zoomForScaleMeters(10000, 0, 512)
    )
  })
})

/** ---------------- Issue #14：MapAccess lazy boot 状态机闭环 */

// @vitest-environment jsdom
import { describe as describeJsdom, expect as expectJsdom, it as itJsdom, vi } from 'vitest'
void expectJsdom
// createMapAccess 经静态导入（vi.mock 会被提升到所有 import 之前）

const maplibreState = vi.hoisted(() => {
  const state = {
    instances: [] as Array<{
      removed: boolean
      removeCount: number
      styleLoaded: boolean
      loadListeners: Array<() => void>
    }>,
    failNext: false,
    defaultStyleLoaded: true
  }
  return state
})

vi.mock('maplibre-gl', () => ({
  Map: class {
    removed = false
    removeCount = 0
    styleLoaded = true
    loadListeners: Array<() => void> = []
    constructor(_opts: unknown) {
      if (maplibreState.failNext) {
        maplibreState.failNext = false
        throw new Error('transient map init failure')
      }
      this.styleLoaded = maplibreState.defaultStyleLoaded
      maplibreState.instances.push(this)
    }
    isStyleLoaded() {
      return this.styleLoaded
    }
    once(event: string, cb: () => void) {
      if (event === 'load') this.loadListeners.push(cb)
    }
    on() {}
    remove() {
      this.removed = true
      this.removeCount++
    }
    stop() {}
    resize() {}
    getCenter() {
      return { lng: 0, lat: 0 }
    }
    getZoom() {
      return 10
    }
    getBearing() {
      return 0
    }
    getPitch() {
      return 0
    }
  }
}))

describeJsdom('MapAccess lazy boot 状态机（Issue #14）', () => {
  function makeAccess() {
    maplibreState.instances.length = 0
    maplibreState.failNext = false
    maplibreState.defaultStyleLoaded = true
    // WebGL2 能力检查桩（jsdom 无 WebGL）
    const spy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({} as CanvasRenderingContext2D)
    const access = createMapAccess({
      getViewport: () => document.createElement('div')
    })
    return {
      access,
      instances: maplibreState.instances,
      restore: () => spy.mockRestore()
    }
  }

  itJsdom('首次 boot transient reject → 第二次 use() 真实重试并可成功', async () => {
    const { access, instances, restore } = makeAccess()
    maplibreState.failNext = true
    await expect(access.use()).rejects.toThrowError(/transient/)
    expect(access.state).toBe('UNINITIALIZED') // 可重试，非 poisoned

    const ctx = await access.use()
    expect(access.state).toBe('ACTIVE')
    expect(ctx.instance).toBeDefined()
    // 失败的构造不产生实例；重试创建新的 Map
    expect(instances).toHaveLength(1)
    restore()
  })

  itJsdom('并发 use() 共享同一 attempt（Map 只构造一次）', async () => {
    const { access, instances, restore } = makeAccess()
    const [c1, c2] = await Promise.all([access.use(), access.use()])
    expect(instances).toHaveLength(1)
    expect(c1).toBe(c2)
    restore()
  })

  itJsdom('use pending（style 未就绪）→ dispose → 立即中止并销毁 Map，不复活 ACTIVE', async () => {
    const { access, restore } = makeAccess()
    maplibreState.defaultStyleLoaded = false // 让 boot 挂在 style-ready 等待
    const usePromise = access.use()
    await vi.waitFor(() => expect(maplibreState.instances.length).toBe(1))
    const inst = maplibreState.instances[0]!

    access.dispose() // terminal teardown（pending 期间）
    expect(access.state).toBe('DISPOSED')
    void inst
    expect(maplibreState.instances[0]!.removed).toBe(true) // 迟到的 Map 被立即销毁

    await expect(usePromise).rejects.toThrowError() // aborted
    expect(access.currentContext).toBeUndefined() // 终态不变量
    await expect(access.use()).rejects.toThrowError(/disposed/) // fail-fast
    expect(access.state).toBe('DISPOSED') // DISPOSED 永不复活
    restore()
  })
})
