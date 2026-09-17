// @vitest-environment jsdom
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { geodeticToEcef } from '@twin/spatial'
import type { EngineRuntime, SceneEngineOptions } from '@twin/scene-engine'
import type { GraphicsDiagnostics } from '@twin/sdk'
import { buildFoundation, type PortalFoundation } from './foundation'

/**
 * Issue #31：Portal 真实 Foundation wiring 的 frame-mode 集成回归——
 * 同一会话 GLOBAL → SITE → GLOBAL round-trip：
 * - global-ships 路径能拿到 `GraphicsContext.global`（不再出现
 *   "engine was not configured in global mode"）；
 * - SITE Scene 继续 frame-local meters，不继承 GLOBAL km/root policy；
 * - View binding 与 graphics 读取同一已提交 mode authority；
 * - 非活跃 runtime 保持 suspend，无双 RAF/双画布。
 */

function installFakeWebSocket(): () => void {
  class FakeWS {
    send(): void {}
    close(): void {}
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    onmessage: ((e: { data: unknown }) => void) | null = null
    constructor(_url: string) {
      queueMicrotask(() => this.onopen?.())
    }
  }
  ;(globalThis as Record<string, unknown>).WebSocket = FakeWS
  return () => {
    delete (globalThis as Record<string, unknown>).WebSocket
  }
}

const restoreWs = installFakeWebSocket()
afterAll(() => restoreWs())

function makeFakeRuntime(opts: SceneEngineOptions) {
  const orbitFocus = vi.fn()
  const canvas = document.createElement('canvas')
  // 真实 createRuntime 在 boot 时把 canvas 挂入 viewport——fake 保持一致
  opts.getViewport?.()?.appendChild(canvas)
  const rt = {
    context: {
      renderScene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      renderer: { domElement: canvas },
      onFrame: () => ({ dispose: () => {} }),
      onPick: () => ({ dispose: () => {} }),
      environment: {},
      global:
        opts.global === true
          ? { enabled: true as const, setObjectEcefPosition: vi.fn() }
          : undefined,
      entities: {
        register: vi.fn(() => ({ dispose: () => {} })),
        getPosition: vi.fn(() => false),
        has: () => false,
        count: 0,
        clear: vi.fn()
      },
      suspend: vi.fn(),
      resume: vi.fn(),
      getDiagnostics: () => ({}) as unknown as GraphicsDiagnostics
    },
    orbit: {
      focus: orbitFocus,
      state: { target: { x: 0, y: 0, z: 0 }, distance: 100 },
      cameraPose: vi.fn()
    },
    frameLoop: {},
    tiles: { tilesetCount: 0 },
    entitySystem: {},
    environment: {},
    earth: undefined,
    adaptive: { force: vi.fn() },
    createMountRoot: () => {
      const root = new THREE.Group()
      return { root, detach: () => root.removeFromParent() }
    },
    suspend: vi.fn(),
    resume: vi.fn(),
    dispose: vi.fn()
  }
  return {
    rt: rt as unknown as EngineRuntime,
    orbitFocus,
    canvas,
    suspend: rt.suspend,
    resume: rt.resume,
    dispose: rt.dispose
  }
}

type CreatedBoot = {
  opts: SceneEngineOptions
  rt: EngineRuntime
  orbitFocus: ReturnType<typeof vi.fn>
  canvas: HTMLCanvasElement
  suspend: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}

const disposables: PortalFoundation[] = []
afterEach(async () => {
  while (disposables.length) {
    const f = disposables.pop()
    if (f) await f.dispose()
  }
})

async function buildWithFactory() {
  const created: CreatedBoot[] = []
  const foundation = buildFoundation({
    graphicsRuntimeFactory: async (opts) => {
      const fake = makeFakeRuntime(opts)
      created.push({ opts, ...fake })
      return fake.rt
    }
  })
  disposables.push(foundation)
  foundation.workspace.setContainers({
    map: document.createElement('div'),
    graphics: document.createElement('div')
  })
  return { foundation, created }
}

const TARGET = {
  longitudeDegrees: 122.5,
  latitudeDegrees: 30.2,
  heightMeters: 0,
  verticalReference: 'ellipsoid' as const
}

describe('Portal frame-mode authority（Issue #31）', () => {
  it('GLOBAL → SITE → GLOBAL round-trip：mode authority / context / view 单位 / suspend 全链路', async () => {
    const { foundation, created } = await buildWithFactory()
    foundation.workspace.setPrimary('scene')

    // 初始 scope=global → 首次 use() boot GLOBAL access
    expect(foundation.graphicsAccess.mode).toBe('global')
    const ctxGlobal = await foundation.graphicsAccess.use()
    expect(created).toHaveLength(1)
    expect(created[0]!.opts.global).toBe(true)
    // global-ships 的 guard：graphics.global 必须存在
    expect(ctxGlobal.global).toBeDefined()
    expect(ctxGlobal.global?.enabled).toBe(true)

    // GLOBAL view 路径：WGS84 → ECEF km；20km scale → 20（scene-km），不是 20000
    await foundation.view.setTarget({ target: TARGET, scaleMeters: 20_000 })
    const ecef = geodeticToEcef(TARGET)
    expect(created[0]!.orbitFocus).toHaveBeenCalledWith(
      { x: ecef.xMeters / 1000, y: ecef.zMeters / 1000, z: -ecef.yMeters / 1000 },
      20
    )

    // 切 SITE scope → use() 提交 site mode：boot SITE access（global!==true）
    foundation.world.setScope({ kind: 'site', siteId: 'site-changxing' })
    const ctxSite = await foundation.graphicsAccess.use()
    expect(created).toHaveLength(2)
    expect(created[1]!.opts.global).not.toBe(true)
    // SITE context 不带 global env（不继承 GLOBAL km/root policy）
    expect(ctxSite.global).toBeUndefined()
    // 非活跃 runtime suspend（无双 RAF）
    expect(created[0]!.suspend).toHaveBeenCalled()

    // SITE view 路径：frame-local meters；scaleMeters 保持米
    foundation.spatial.setActiveFrame('frame:site-changxing')
    await foundation.view.setTarget({ target: TARGET, scaleMeters: 20_000 })
    const local = foundation.spatial.geodeticToLocal(TARGET)
    expect(created[1]!.orbitFocus).toHaveBeenCalledWith(local, 20_000)

    // 切回 GLOBAL：复用已 boot 的 global runtime（不重新 boot）+ resume
    foundation.world.setScope({ kind: 'global' })
    await foundation.graphicsAccess.use()
    expect(created).toHaveLength(2)
    expect(created[0]!.resume).toHaveBeenCalled()
    expect(foundation.graphicsAccess.mode).toBe('global')
    expect(created[1]!.suspend).toHaveBeenCalled()

    // View binding 与 graphics 同一 authority：Engine=GLOBAL ⇒ View=GLOBAL
    await foundation.view.setTarget({ target: TARGET, scaleMeters: 20_000 })
    const calls = created[0]!.orbitFocus.mock.calls
    expect(calls[calls.length - 1]).toEqual([
      { x: ecef.xMeters / 1000, y: ecef.zMeters / 1000, z: -ecef.yMeters / 1000 },
      20
    ])
  })

  it('canvas 随 mode 归属 viewport；同 mode 重复 use() 幂等不抖动', async () => {
    const { foundation, created } = await buildWithFactory()
    const viewport = document.createElement('div')
    foundation.workspace.setContainers({ map: viewport, graphics: viewport })

    foundation.world.setScope({ kind: 'site', siteId: 'site-changxing' })
    await foundation.graphicsAccess.use()
    expect(created).toHaveLength(1)
    expect(created[0]!.canvas.parentElement).toBe(viewport)

    foundation.world.setScope({ kind: 'global' })
    await foundation.graphicsAccess.use()
    // global canvas 进入 viewport，site canvas 被移出（无双画布叠放）
    expect(created[1]!.canvas.parentElement).toBe(viewport)
    expect(created[0]!.canvas.parentElement).not.toBe(viewport)

    // 同 mode 再次 use()：幂等——非活跃 runtime 不被重复 suspend
    const siteSuspendsBefore = created[0]!.suspend.mock.calls.length
    await foundation.graphicsAccess.use()
    expect(created[1]!.canvas.parentElement).toBe(viewport)
    expect(created[0]!.suspend.mock.calls.length).toBe(siteSuspendsBefore)
  })

  it('dispose 终止两个底层 access（exactly-once 资源回收）', async () => {
    const { foundation, created } = await buildWithFactory()
    await foundation.graphicsAccess.use()
    foundation.world.setScope({ kind: 'site', siteId: 'site-changxing' })
    await foundation.graphicsAccess.use()
    expect(created).toHaveLength(2)
    await foundation.dispose()
    expect(created[0]!.dispose).toHaveBeenCalled()
    expect(created[1]!.dispose).toHaveBeenCalled()
  })
})
