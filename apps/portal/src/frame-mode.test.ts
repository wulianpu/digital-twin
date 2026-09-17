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

/**
 * #31 复审：deferred runtime factory——boot promise 由测试手动 resolve，
 * 且 fake runtime 在 factory 调用时刻即 append canvas（与真实
 * createRuntime 一致：canvas/资源在 promise resolve 前已就绪）。
 * 用于覆盖 pending boot × rapid mode switch 竞态。
 */
async function buildWithDeferredFactory() {
  type DeferredBoot = CreatedBoot & { resolve: () => void }
  const boots: DeferredBoot[] = []
  const foundation = buildFoundation({
    graphicsRuntimeFactory: (opts) =>
      new Promise<EngineRuntime>((resolve) => {
        const fake = makeFakeRuntime(opts)
        boots.push({ opts, ...fake, resolve: () => resolve(fake.rt) })
      })
  })
  disposables.push(foundation)
  const viewport = document.createElement('div')
  foundation.workspace.setContainers({ map: viewport, graphics: viewport })
  return { foundation, boots, viewport }
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

  // ---- #31 复审：pending boot × rapid mode switch 竞态 ----

  it('GLOBAL pending → SITE commit → GLOBAL late resolve：晚到 runtime 被 quarantine，无双 RAF/双 canvas', async () => {
    const { foundation, boots, viewport } = await buildWithDeferredFactory()
    const useG1 = foundation.graphicsAccess.use() // GLOBAL boot 挂起
    expect(boots).toHaveLength(1)
    expect(boots[0]!.opts.global).toBe(true)

    // SITE 提交（authority 易主时 GLOBAL 仍 pending）
    foundation.world.setScope({ kind: 'site', siteId: 'site-changxing' })
    const useS = foundation.graphicsAccess.use()
    boots[1]!.resolve()
    await useS
    expect(foundation.graphicsAccess.mode).toBe('site')
    expect(boots).toHaveLength(2)
    const g = boots[0]!
    const s = boots[1]!
    // fake 与真实 createRuntime 一致：canvas 在 boot resolve 前已 append
    expect(s.canvas.parentElement).toBe(viewport)

    // GLOBAL boot 晚到——必须被 quarantine，不得自留在 viewport/RAF
    g.resolve()
    await expect(useG1).rejects.toThrow(/superseded/)
    expect(g.suspend).toHaveBeenCalled()
    expect(g.canvas.parentElement).not.toBe(viewport)
    expect(s.canvas.parentElement).toBe(viewport)
    expect(foundation.graphicsAccess.mode).toBe('site')
  })

  it('SITE pending → GLOBAL commit → SITE late resolve：对称方向同样不复活', async () => {
    const { foundation, boots, viewport } = await buildWithDeferredFactory()
    foundation.world.setScope({ kind: 'site', siteId: 'site-changxing' })
    const useS = foundation.graphicsAccess.use() // SITE boot 挂起

    // 切回 GLOBAL 并完成提交
    foundation.world.setScope({ kind: 'global' })
    const useG = foundation.graphicsAccess.use()
    boots.find((b) => b.opts.global === true)!.resolve()
    await useG
    expect(foundation.graphicsAccess.mode).toBe('global')

    // SITE boot 晚到 → quarantine
    boots.find((b) => b.opts.global !== true)!.resolve()
    await expect(useS).rejects.toThrow(/superseded/)
    const s = boots.find((b) => b.opts.global !== true)!
    const g = boots.find((b) => b.opts.global === true)!
    expect(s.suspend).toHaveBeenCalled()
    expect(s.canvas.parentElement).not.toBe(viewport)
    expect(g.canvas.parentElement).toBe(viewport)
  })

  it('GLOBAL(1) pending → SITE → GLOBAL(2)：旧 continuation 不误伤重新选中的 GLOBAL authority', async () => {
    const { foundation, boots, viewport } = await buildWithDeferredFactory()
    const useG1 = foundation.graphicsAccess.use() // GLOBAL(1) boot 挂起（single-flight）

    foundation.world.setScope({ kind: 'site', siteId: 'site-changxing' })
    const useS = foundation.graphicsAccess.use()
    boots[1]!.resolve()
    await useS
    expect(foundation.graphicsAccess.mode).toBe('site')

    // 切回 GLOBAL——与 GLOBAL(1) 共享同一 single-flight boot
    foundation.world.setScope({ kind: 'global' })
    const useG2 = foundation.graphicsAccess.use()
    const g = boots.find((b) => b.opts.global === true)!
    const s = boots.find((b) => b.opts.global !== true)!
    g.resolve()

    // 两个 continuation 都命中同侧 access：不得 suspend 最新 GLOBAL authority
    await useG2
    await expect(useG1).resolves.toBeDefined()
    expect(g.suspend).not.toHaveBeenCalled()
    expect(g.resume).toHaveBeenCalled()
    expect(s.suspend).toHaveBeenCalled()
    expect(foundation.graphicsAccess.mode).toBe('global')
    expect(g.canvas.parentElement).toBe(viewport)
    expect(s.canvas.parentElement).not.toBe(viewport)
  })

  it('dispose 时 pending boot 沿 #14 terminal 机制回收（router 不复活）', async () => {
    const { foundation, boots } = await buildWithDeferredFactory()
    const useG1 = foundation.graphicsAccess.use()
    await foundation.dispose()
    // 先让 pending boot settle——晚到的 boot 被 #14-B commit 前重校验回收
    boots[0]!.resolve()
    await expect(useG1).rejects.toThrow()
    expect(boots[0]!.dispose).toHaveBeenCalled()
    expect(boots[0]!.resume).not.toHaveBeenCalled()
  })
})
