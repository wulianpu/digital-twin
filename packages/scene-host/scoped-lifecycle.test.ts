// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { MountScope, SceneScopeClosedError } from './src/scope'
import {
  scopedWorldApi,
  scopedSpatialApi,
  scopedSelectionApi,
  scopedViewApi
} from './src/scopedLifecycle'
import { SceneHost, createViewService, type SceneHostOptions } from './src/public'
import { createWorldApi, createSelectionApi } from '@twin/world'
import { createSpatialApi } from '@twin/spatial'
import type { SceneContext, SceneEntry } from '@twin/sdk'

const GEO = {
  longitudeDegrees: 121.78,
  latitudeDegrees: 31.36,
  heightMeters: 4,
  verticalReference: 'ellipsoid' as const
}

function makeViewInner() {
  const sceneDriver = {
    focus: vi.fn(async () => {}),
    goToSite: vi.fn(async () => {}),
    setTarget: vi.fn(async () => {}),
    getTarget: () => undefined
  }
  const view = createViewService({
    mapDriver: sceneDriver,
    sceneDriver,
    getPrimary: () => 'scene'
  })
  return { view, sceneDriver }
}

describe('scoped lifecycle wrappers（Issue #4 zombie-write 防线）', () => {
  it('active：写操作透传到 inner', () => {
    const scope = new MountScope()
    const world = createWorldApi()
    const scoped = scopedWorldApi(world, scope)
    scoped.setMode('history')
    expect(world.session.mode).toBe('history')
    scoped.setScope({ kind: 'site', siteId: 's1' })
    expect(world.session.scope).toEqual({ kind: 'site', siteId: 's1' })
    scoped.clock.seek(1_000)
    expect(world.clock.now().epochMillis).toBe(1_000)
  })

  it('closing：状态写操作被拒（unmount 开始即不得改写平台状态）', () => {
    const scope = new MountScope()
    const selection = createSelectionApi()
    const scoped = scopedSelectionApi(selection, scope)
    scope.close()
    expect(() => scoped.setPrimary({ namespace: 'vessel', id: 'hull-1' })).toThrow(
      SceneScopeClosedError
    )
    expect(selection.current.primary).toBeUndefined()
  })

  it('disposed：world/selection 写操作抛 SceneScopeClosedError，读操作仍有效', () => {
    const scope = new MountScope()
    const world = createWorldApi()
    const selection = createSelectionApi()
    const scopedWorld = scopedWorldApi(world, scope)
    const scopedSelection = scopedSelectionApi(selection, scope)
    scope.dispose()

    // zombie write：fail-fast 抛错，inner 状态不变（Issue #4 验收语义）
    expect(() => scopedWorld.setMode('history')).toThrow(SceneScopeClosedError)
    expect(() => scopedWorld.setScope({ kind: 'global' })).toThrow(SceneScopeClosedError)
    expect(() => scopedWorld.clock.seek(1)).toThrow(SceneScopeClosedError)
    expect(world.session.mode).toBe('live')
    expect(() =>
      scopedSelection.setPrimary({ namespace: 'v', id: 'x' })
    ).toThrow(SceneScopeClosedError)
    expect(() => scopedSelection.toggle({ namespace: 'v', id: 'y' })).toThrow(
      SceneScopeClosedError
    )
    expect(() => scopedSelection.clear()).toThrow(SceneScopeClosedError)
    expect(selection.current.primary).toBeUndefined()

    // reads 仍透传：scene 可安全降级（session/current 为快照，按值比较）
    expect(scopedWorld.worldId).toBe(world.worldId)
    // live 模式下 session.time / clock.now() 为墙钟，两次调用允许毫秒级差异
    expect(scopedWorld.session.mode).toBe(world.session.mode)
    expect(scopedWorld.session.scope).toEqual(world.session.scope)
    expect(
      Math.abs(
        scopedWorld.session.time.epochMillis - world.session.time.epochMillis
      )
    ).toBeLessThan(50)
    expect(scopedSelection.current).toEqual(selection.current)
    expect(Math.abs(scopedWorld.clock.now().epochMillis - world.clock.now().epochMillis)).toBeLessThan(50)
  })

  it('disposed：spatial 写/创建被拒，读与坐标转换仍有效', () => {
    const scope = new MountScope()
    const spatial = createSpatialApi()
    const scoped = scopedSpatialApi(spatial, scope)
    // Issue #8：scene-owned frame 经 owner handle 注册
    scoped.registerEnuFrame('f1', GEO)
    scoped.setActiveFrame('f1')
    scope.dispose()

    // scope.dispose 兜底回收 scene-owned frame（不再遗留永久 registry entry）
    expect(scoped.getFrame('f1')).toBeUndefined()
    expect(scoped.activeFrameId).toBeUndefined()
    expect(scoped.listFrames().length).toBe(0)

    expect(() => scoped.registerEnuFrame('f2', GEO)).toThrow(SceneScopeClosedError)
    expect(() =>
      scoped.registerFrame({ id: 'f3', originECEF: { x: 0, y: 0, z: 0 }, basisECEF: {
        xx: 1, xy: 0, xz: 0, yx: 0, yy: 1, yz: 0, zx: 0, zy: 0, zz: 1
      } } as never)
    ).toThrow(SceneScopeClosedError)
    expect(() => scoped.registerVerticalOffset('ellipsoid', 'ellipsoid', 1)).toThrow(
      SceneScopeClosedError
    )
    expect(() => scoped.setActiveFrame('f2')).toThrow(SceneScopeClosedError)
  })

  it('disposed：view 异步写抛错，不触达 driver', async () => {
    const scope = new MountScope()
    const { view, sceneDriver } = makeViewInner()
    const scoped = scopedViewApi(view, scope)
    scope.dispose()

    // fail-fast：同步抛错（不产生无人处理的 rejected promise）
    expect(() => scoped.focus({ namespace: 'v', id: 'x' })).toThrow(SceneScopeClosedError)
    expect(() => scoped.goToSite('site-1')).toThrow(SceneScopeClosedError)
    expect(() => scoped.setTarget({ target: GEO })).toThrow(SceneScopeClosedError)
    expect(sceneDriver.focus).not.toHaveBeenCalled()
    expect(sceneDriver.goToSite).not.toHaveBeenCalled()
    expect(sceneDriver.setTarget).not.toHaveBeenCalled()
    // reads 仍透传
    expect(scoped.primary).toBe('scene')
  })

  it('Disposable 返回 API 立即 track：scope.dispose 后 listener/资源被兜底释放', () => {
    const scope = new MountScope()
    const world = createWorldApi()
    const selection = createSelectionApi()
    const spatial = createSpatialApi()
    const scopedWorld = scopedWorldApi(world, scope)
    const scopedSelection = scopedSelectionApi(selection, scope)
    const scopedSpatial = scopedSpatialApi(spatial, scope)

    let sessionEvents = 0
    let tickEvents = 0
    let selectionEvents = 0
    let frameEvents = 0
    scopedWorld.onSessionChanged(() => sessionEvents++)
    scopedWorld.time.onTick(() => tickEvents++)
    scopedSelection.onChange(() => selectionEvents++)
    scopedSpatial.onActiveFrameChanged(() => frameEvents++)
    scopedWorld.sites.register({
      id: 's-x',
      name: 'X',
      origin: GEO,
      bounds: { south: 1, west: 1, north: 2, east: 2 }
    })
    scopedSpatial.registerFrame({ id: 'f-t', kind: 'enu', origin: GEO } as never)

    scope.dispose()

    // Host 兜底：listener 全部移除、注册资源全部释放
    world.setMode('history')
    expect(sessionEvents).toBe(0)
    expect(tickEvents).toBe(0)
    expect(selectionEvents).toBe(0)
    expect(frameEvents).toBe(0)
    expect(world.sites.get('s-x')).toBeUndefined()
    expect(spatial.getFrame('f-t')).toBeUndefined()
  })

  it('Scene 手工 dispose 仍有效（Host 只是兜底）', () => {
    const scope = new MountScope()
    const selection = createSelectionApi()
    const scoped = scopedSelectionApi(selection, scope)
    let events = 0
    const d = scoped.onChange(() => events++)
    d.dispose()
    selection.setPrimary({ namespace: 'v', id: 'a' })
    expect(events).toBe(0)
  })
})

describe('SceneHost × scoped lifecycle 集成（缓存引用 zombie 写防线）', () => {
  it('unmount 后，Scene 缓存的 world/spatial/selection/view 写全部被拒（Issue #4 验收用例）', async () => {
    const world = createWorldApi()
    const selection = createSelectionApi()
    const spatial = createSpatialApi()
    const { view, sceneDriver } = makeViewInner()
    const services = {
      world,
      spatial,
      data: { subscribe: () => ({ dispose: () => {} }) },
      selection,
      view,
      assets: {}
    } as unknown as SceneHostOptions['services']

    const host = new SceneHost({
      viewport: { ui: document.createElement('div') },
      services
    })

    let cachedWorld: SceneContext['world'] | undefined
    let cachedSpatial: SceneContext['spatial'] | undefined
    let cachedSelection: SceneContext['selection'] | undefined
    let cachedView: SceneContext['view'] | undefined
    const entry: SceneEntry = {
      mount: async (ctx) => {
        // 典型 zombie 场景：Scene 在 mount 时缓存 API 引用
        cachedWorld = ctx.world
        cachedSpatial = ctx.spatial
        cachedSelection = ctx.selection
        cachedView = ctx.view
        return { unmount: () => {} }
      }
    }
    const mount = await host.mount(entry)
    await mount.unmount()

    // 缓存引用在 unmount 后写入 → 抛 SceneScopeClosedError，全局状态不变
    expect(() => cachedWorld!.setMode('history')).toThrow(SceneScopeClosedError)
    expect(world.session.mode).toBe('live')
    expect(() => cachedWorld!.clock.seek(1)).toThrow(SceneScopeClosedError)
    expect(() =>
      cachedSelection!.setPrimary({ namespace: 'v', id: 'zombie' })
    ).toThrow(SceneScopeClosedError)
    expect(selection.current.primary).toBeUndefined()
    expect(() => cachedSpatial!.setActiveFrame('f1')).toThrow(SceneScopeClosedError)
    expect(() => cachedView!.goToSite('site-1')).toThrow(SceneScopeClosedError)
    expect(sceneDriver.goToSite).not.toHaveBeenCalled()
  })

  it('mount 进行中的写操作不受影响（active 透传）', async () => {
    const world = createWorldApi()
    const services = {
      world,
      spatial: createSpatialApi(),
      data: { subscribe: () => ({ dispose: () => {} }) },
      selection: createSelectionApi(),
      view: makeViewInner().view,
      assets: {}
    } as unknown as SceneHostOptions['services']
    const host = new SceneHost({
      viewport: { ui: document.createElement('div') },
      services
    })
    const mount = await host.mount({
      mount: async (ctx) => {
        ctx.world.setMode('history')
        expect(world.session.mode).toBe('history')
        return { unmount: () => {} }
      }
    })
    expect(mount.state).toBe('active')
  })
})

describe('Issue #5：nested capability / mutable alias / create-before-guard', () => {
  it('A: ctx.world.selection 与 ctx.selection 是同一 scoped 实例', async () => {
    const world = createWorldApi()
    const selection = createSelectionApi()
    const services = {
      world,
      spatial: createSpatialApi(),
      data: { subscribe: () => ({ dispose: () => {} }) },
      selection,
      view: makeViewInner().view,
      assets: {}
    } as unknown as SceneHostOptions['services']
    const host = new SceneHost({
      viewport: { ui: document.createElement('div') },
      services
    })
    let nested: unknown
    let primaryPath: unknown
    const mount = await host.mount({
      mount: async (ctx) => {
        nested = ctx.world.selection
        primaryPath = ctx.selection
        return { unmount: () => {} }
      }
    })
    expect(nested).toBe(primaryPath)
    await mount.unmount()
    // 两条访问路径生命周期语义一致：同样被拒
    expect(() =>
      (nested as SceneContext['selection']).setPrimary({ namespace: 'v', id: 'zombie' })
    ).toThrow(SceneScopeClosedError)
    expect(selection.current.primary).toBeUndefined()
  })

  it('B1: session.scope/entity 是快照——修改返回对象不影响 inner', () => {
    const scope = new MountScope()
    const world = createWorldApi({ initialScope: { kind: 'site', siteId: 's1' } })
    const scoped = scopedWorldApi(world, scope)
    const snap = scoped.session
    if (snap.scope.kind === 'site') snap.scope.siteId = 'hijacked'
    expect(world.session.scope).toEqual({ kind: 'site', siteId: 's1' })

    world.setScope({ kind: 'entity', entity: { namespace: 'vessel', id: 'a' } })
    const snap2 = scoped.session
    if (snap2.scope.kind === 'entity') snap2.scope.entity.id = 'zombie'
    expect(world.session.scope).toEqual({
      kind: 'entity',
      entity: { namespace: 'vessel', id: 'a' }
    })
  })

  it('B2: selection.current 是快照——修改 primary/secondary 不影响 inner', () => {
    const scope = new MountScope()
    const selection = createSelectionApi()
    const scoped = scopedSelectionApi(selection, scope)
    scoped.setPrimary({ namespace: 'vessel', id: 'keep' })
    scoped.setSecondary([{ namespace: 'agv', id: 's1' }])
    const snap = scoped.current
    snap.primary!.id = 'zombie'
    snap.secondary[0]!.id = 'zombie'
    expect(selection.current.primary).toEqual({ namespace: 'vessel', id: 'keep' })
    expect(selection.current.secondary).toEqual([{ namespace: 'agv', id: 's1' }])
    expect(selection.isSelected({ namespace: 'vessel', id: 'keep' })).toBe(true)
  })

  it('B3: sites.get/list 返回克隆——修改不影响 registry truth', () => {
    const scope = new MountScope()
    const world = createWorldApi()
    const scoped = scopedWorldApi(world, scope)
    scoped.sites.register({
      id: 'site-a',
      name: 'A',
      origin: { ...GEO },
      bounds: { south: 1, west: 1, north: 2, east: 2 }
    })
    const site = scoped.sites.get('site-a')!
    site.origin.heightMeters = 99_999
    ;(site as { name: string }).name = 'Hijacked'
    expect(world.sites.get('site-a')!.origin.heightMeters).toBe(GEO.heightMeters)
    expect(world.sites.get('site-a')!.name).toBe('A')
    const listed = scoped.sites.list()[0]!
    ;(listed.bounds as { south: number }).south = -50
    expect(world.sites.list()[0]!.bounds.south).toBe(1)
  })

  it('B4: frame 冻结——registerEnuFrame/registerFrame 返回值不可变，registry 存副本', () => {
    const scope = new MountScope()
    const spatial = createSpatialApi()
    const scoped = scopedSpatialApi(spatial, scope)
    const ensured = scoped.registerEnuFrame('f1', GEO).frame
    const baselineX = ensured.originECEF.x
    expect(() => { (ensured.originECEF as { x: number }).x = 0 }).toThrow(TypeError)
    expect(() => { (ensured.basisECEF as { xx: number }).xx = 0 }).toThrow(TypeError)

    const callerFrame = {
      id: 'f2',
      originECEF: { x: 1, y: 2, z: 3 },
      basisECEF: { xx: 1, xy: 0, xz: 0, yx: 0, yy: 1, yz: 0, zx: 0, zy: 0, zz: 1 }
    } as never
    scoped.registerFrame(callerFrame)
    // 调用方对象后续变化不影响 registry（存储的是 frozen 副本）
    ;(callerFrame as { originECEF: { x: number } }).originECEF.x = 999
    const stored = scoped.getFrame('f2')!
    expect(stored).not.toBe(callerFrame)
    expect(stored.originECEF.x).toBe(1)
    expect(() => { (stored.originECEF as { x: number }).x = 0 }).toThrow(TypeError)
    void baselineX
  })

  it('C: close 后 sites.register 在 inner create 前拒绝（无瞬时增删）', () => {
    const scope = new MountScope()
    const world = createWorldApi()
    const scoped = scopedWorldApi(world, scope)
    scope.close()
    expect(() =>
      scoped.sites.register({
        id: 'late-site',
        name: 'Late',
        origin: { ...GEO },
        bounds: { south: 1, west: 1, north: 2, east: 2 }
      })
    ).toThrow(SceneScopeClosedError)
    expect(world.sites.get('late-site')).toBeUndefined()
    expect(world.sites.list().length).toBe(0)
  })

  it('C: close 后 onSessionChanged/onTick/onChange 在 inner create 前拒绝', () => {
    const scope = new MountScope()
    const world = createWorldApi()
    const selection = createSelectionApi()
    const spatial = createSpatialApi()
    const scopedWorld = scopedWorldApi(world, scope)
    const scopedSelection = scopedSelectionApi(selection, scope)
    const scopedSpatial = scopedSpatialApi(spatial, scope)
    scope.close()

    let sessionEvents = 0
    let tickEvents = 0
    let selectionEvents = 0
    let frameEvents = 0
    expect(() => scopedWorld.onSessionChanged(() => sessionEvents++)).toThrow(
      SceneScopeClosedError
    )
    expect(() => scopedWorld.time.onTick(() => tickEvents++)).toThrow(SceneScopeClosedError)
    expect(() => scopedSelection.onChange(() => selectionEvents++)).toThrow(
      SceneScopeClosedError
    )
    expect(() => scopedSpatial.onActiveFrameChanged(() => frameEvents++)).toThrow(
      SceneScopeClosedError
    )
    // listener 从未注册：inner 状态变化不触发任何回调
    world.setMode('history')
    selection.setPrimary({ namespace: 'v', id: 'x' })
    spatial.setActiveFrame(undefined)
    expect(sessionEvents).toBe(0)
    expect(tickEvents).toBe(0)
    expect(selectionEvents).toBe(0)
    expect(frameEvents).toBe(0)
  })
})

describe('Issue #6：write-side input alias（setter 入参防御性拷贝）', () => {
  function makeHostServices(
    world: ReturnType<typeof createWorldApi>,
    selection: ReturnType<typeof createSelectionApi>
  ): SceneHostOptions['services'] {
    return {
      world,
      spatial: createSpatialApi(),
      data: { subscribe: () => ({ dispose: () => {} }) },
      selection,
      view: makeViewInner().view,
      assets: {}
    } as unknown as SceneHostOptions['services']
  }

  it('setScope 入参别名：卸载后修改原 scope/entity 不影响 World truth，且无事件', async () => {
    const world = createWorldApi()
    const host = new SceneHost({
      viewport: { ui: document.createElement('div') },
      services: makeHostServices(world, createSelectionApi())
    })
    const retained = { kind: 'entity' as const, entity: { namespace: 'vessel', id: 'keep' } }
    let sessionEvents = 0
    const mount = await host.mount({
      mount: async (ctx) => {
        ctx.world.setScope(retained)
        ctx.world.onSessionChanged(() => sessionEvents++)
        return { unmount: () => {} }
      }
    })
    await mount.unmount()

    retained.entity.id = 'ZOMBIE'
    expect(world.session.scope).toEqual({
      kind: 'entity',
      entity: { namespace: 'vessel', id: 'keep' }
    })
    // alias mutation 不产生"状态已变但 listener 未通知"的静默
    expect(sessionEvents).toBe(0)
  })

  it('setPrimary/setSecondary/toggle 入参别名：卸载后修改原对象不影响 Selection truth', async () => {
    const selection = createSelectionApi()
    const host = new SceneHost({
      viewport: { ui: document.createElement('div') },
      services: makeHostServices(createWorldApi(), selection)
    })
    const primary = { namespace: 'vessel', id: 'keep' }
    const secondary = [{ namespace: 'agv', id: 'a1' }]
    const toggled = { namespace: 'crane', id: 't1' }
    const mount = await host.mount({
      mount: async (ctx) => {
        ctx.selection.setPrimary(primary)
        ctx.selection.setSecondary(secondary)
        ctx.selection.toggle(toggled)
        return { unmount: () => {} }
      }
    })
    await mount.unmount()

    primary.id = 'ZOMBIE'
    secondary[0]!.id = 'ZOMBIE'
    toggled.id = 'ZOMBIE'
    expect(selection.current.primary).toEqual({ namespace: 'crane', id: 't1' })
    expect(selection.current.secondary).toEqual([{ namespace: 'agv', id: 'a1' }])
    expect(selection.isSelected({ namespace: 'crane', id: 't1' })).toBe(true)
  })

  it('Foundation ownership：initialScope / initial sites / sites.register 输入均无别名', () => {
    const initialScope = { kind: 'site' as const, siteId: 's-init' }
    const initialSite = {
      id: 'site-init',
      name: 'Init',
      origin: { ...GEO },
      bounds: { south: 1, west: 1, north: 2, east: 2 }
    }
    const world = createWorldApi({ initialScope, sites: [initialSite] })

    // 初始输入对象后续修改不影响 truth
    initialScope.siteId = 'hijacked'
    initialSite.origin.heightMeters = 99_999
    expect(world.session.scope).toEqual({ kind: 'site', siteId: 's-init' })
    expect(world.sites.get('site-init')!.origin.heightMeters).toBe(GEO.heightMeters)

    // register 输入在存续期间修改同样不影响 truth
    const registered = {
      id: 'site-reg',
      name: 'Reg',
      origin: { ...GEO },
      bounds: { south: 1, west: 1, north: 2, east: 2 }
    }
    const d = world.sites.register(registered)
    registered.origin.heightMeters = 99_999
    registered.name = 'Hijacked'
    const stored = world.sites.get('site-reg')!
    expect(stored.origin.heightMeters).toBe(GEO.heightMeters)
    expect(stored.name).toBe('Reg')
    d.dispose()
    expect(world.sites.get('site-reg')).toBeUndefined()
  })
})

describe('Issue #8：ensureEnuFrame ownership 收口', () => {
  function makeSpatialServices(): {
    services: SceneHostOptions['services']
    spatial: ReturnType<typeof createSpatialApi>
  } {
    const spatial = createSpatialApi()
    return {
      spatial,
      services: {
        world: createWorldApi(),
        spatial,
        data: { subscribe: () => ({ dispose: () => {} }) },
        selection: createSelectionApi(),
        view: makeViewInner().view,
        assets: {}
      } as unknown as SceneHostOptions['services']
    }
  }

  it('Scene 经 registerEnuFrame 创建 frame，unmount 后 registry 回到 mount 前 baseline', async () => {
    const { services, spatial } = makeSpatialServices()
    const host = new SceneHost({
      viewport: { ui: document.createElement('div') },
      services
    })
    const mount = await host.mount({
      mount: async (ctx) => {
        const reg = ctx.spatial.registerEnuFrame('frame:scene-temp', GEO)
        ctx.spatial.setActiveFrame(reg.frame.id)
        expect(spatial.getFrame('frame:scene-temp')).toBeDefined()
        return { unmount: () => {} }
      }
    })
    await mount.unmount()
    // DoD：Scene 正常 unmount 后，frame registry 回到 baseline，active frame 无悬空
    expect(spatial.getFrame('frame:scene-temp')).toBeUndefined()
    expect(spatial.listFrames()).toHaveLength(0)
    expect(spatial.activeFrameId).toBeUndefined()
  })

  it('cleanup throw / unmountHangs 时 scene-owned frame 同样被兜底回收', async () => {
    for (const broken of ['throw', 'hang'] as const) {
      const { services, spatial } = makeSpatialServices()
      const host = new SceneHost({
        viewport: { ui: document.createElement('div') },
        services,
        unmountDeadlineMs: 50
      })
      const mount = await host.mount({
        mount: async (ctx) => {
          ctx.spatial.registerEnuFrame(`frame:broken-${broken}`, GEO)
          return broken === 'throw'
            ? { unmount: () => { throw new Error('cleanup exploded') } }
            : { unmount: () => new Promise<void>(() => {}) }
        }
      })
      await mount.unmount()
      expect(spatial.getFrame(`frame:broken-${broken}`)).toBeUndefined()
    }
  })

  it('SceneContext.spatial 不再暴露 ensureEnuFrame（类型收窄 + 运行时无泄漏入口）', async () => {
    const { services } = makeSpatialServices()
    const host = new SceneHost({
      viewport: { ui: document.createElement('div') },
      services
    })
    await host.mount({
      mount: async (ctx) => {
        // 类型层面已收窄；运行时对象也不含 ensure 入口
        expect('ensureEnuFrame' in ctx.spatial).toBe(false)
        return { unmount: () => {} }
      }
    })
  })

  it('registerEnuFrame 借用 app-owned 同定义 frame：dispose 为 no-op，不删除 baseline', async () => {
    const { services, spatial } = makeSpatialServices()
    // Composition Root 先 ensure 平台 frame
    const appFrame = spatial.ensureEnuFrame('frame:app-owned', GEO)
    const host = new SceneHost({
      viewport: { ui: document.createElement('div') },
      services
    })
    const mount = await host.mount({
      mount: async (ctx) => {
        const reg = ctx.spatial.registerEnuFrame('frame:app-owned', GEO)
        expect(reg.frame).toBe(appFrame)
        reg.dispose() // 借用 lease：不得删除 app-owned baseline
        expect(spatial.getFrame('frame:app-owned')).toBe(appFrame)
        return { unmount: () => {} }
      }
    })
    await mount.unmount()
    // app-owned frame 不受 scene 生命周期影响
    expect(spatial.getFrame('frame:app-owned')).toBe(appFrame)
  })
})
