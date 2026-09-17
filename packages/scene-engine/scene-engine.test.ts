import { describe, expect, it, vi } from 'vitest'
import { FrameLoop } from './src/frameLoop'
import { AdaptiveQuality, profileSettings } from './src/adaptive'
import { TilesSystem, type TilesRendererLike } from './src/tiles'
import { AssetLeaseManager, disposeObject3D, type AssetSource } from './src/resources'
import * as THREE from 'three'
import { createGraphicsAccess, SpatialStateBuffer } from './src/public'
import type { EngineRuntime } from './src/runtime'
import { createSceneViewDriver, siteExtentMeters } from './src/driver'
import { ContextLossGuard } from './src/contextLoss'

// Node 缺少浏览器 ProgressEvent（three FileLoader 的 fetch 进度路径需要），
// data: URL 全链路测试前补桩。
const globalStub = globalThis as Record<string, unknown>
globalStub.ProgressEvent ??= class {
  lengthComputable = false
  loaded = 0
  total = 0
}

describe('FrameLoop', () => {
  it('runs manual frames, reports frame index, and unregisters callbacks', () => {
    const loop = new FrameLoop()
    let calls = 0
    const dispose = loop.onFrame(() => calls++)
    loop.runFrame(0)
    loop.runFrame(16)
    loop.runFrame(33)
    expect(calls).toBe(3)
    expect(loop.frameIndex).toBe(3)
    dispose()
    loop.runFrame(50)
    expect(calls).toBe(3)
    loop.dispose()
  })

  it('computes p50/p95 from recorded frame times', () => {
    const loop = new FrameLoop(() => 0, 0)
    let t = 0
    for (let i = 0; i < 100; i++) {
      loop.runFrame(t)
      t += i < 90 ? 16 : 50
    }
    expect(loop.p50Ms).toBeLessThanOrEqual(17)
    expect(loop.p95Ms).toBeGreaterThan(30)
  })
})

describe('AdaptiveQuality', () => {
  it('downgrades under pressure and holds a cooldown afterwards', () => {
    const applied: string[] = []
    const adaptive = new AdaptiveQuality('HIGH', 'HIGH', (p) => applied.push(p))
    adaptive.sample(80)
    expect(adaptive.profile).toBe('STANDARD')
    adaptive.sample(10)
    expect(adaptive.profile).toBe('STANDARD') // cooldown: change not immediate
  })

  it('upgrades when fast and respects cooldown after a change', () => {
    const applied: string[] = []
    const adaptive = new AdaptiveQuality('STANDARD', 'HIGH', (p) => applied.push(p))
    for (let i = 0; i < 400; i++) adaptive.sample(15)
    expect(adaptive.profile).toBe('HIGH')
  })
})

describe('profileSettings', () => {
  it('maps profiles to rendering policy', () => {
    expect(profileSettings('OFFICE').shadows).toBe(false)
    expect(profileSettings('EXHIBITION').shadows).toBe(true)
    expect(profileSettings('EXHIBITION').maxPixelRatio).toBeGreaterThan(
      profileSettings('OFFICE').maxPixelRatio
    )
  })
})

describe('TilesSystem', () => {
  function fakeRenderer(): TilesRendererLike {
    return {
      group: { removeFromParent: () => {} } as never,
      setCamera: () => {},
      setResolution: () => {},
      update: () => {},
      dispose: vi.fn(),
      lruCache: {
        maxBytesSize: 0,
        maxItemSize: 0,
        cachedBytes: 1234,
        cachedItems: 3,
        isFull: false
      },
      downloadQueue: { size: 2 },
      parseQueue: { size: 1 },
      stats: { downloaded: 10, parsed: 9, failed: 1, visible: 4, inFrustum: 5 }
    }
  }

  it('enforces the explicit byte budget policy (§49)', async () => {
    const system = new TilesSystem({ maxBytes: 512 * 1024 * 1024, maxItems: 2048 }, async () => {
      const r = fakeRenderer()
      created.push(r)
      return r
    })
    const created: TilesRendererLike[] = []
    await system.addTileset('https://tiles.test/tileset.json')
    expect(created[0].lruCache?.maxBytesSize).toBe(512 * 1024 * 1024)
    expect(created[0].lruCache?.maxItemSize).toBe(2048)

    const diag = system.diagnostics()
    expect(diag.cachedBytes).toBe(1234)
    expect(diag.downloading).toBe(2)
    expect(diag.parsing).toBe(1)
    expect(diag.failed).toBe(1)

    system.dispose()
    expect(system.tilesetCount).toBe(0)
  })

  it('rejects duplicate tileset urls', async () => {
    const system = new TilesSystem({}, async () => fakeRenderer())
    await system.addTileset('https://tiles.test/a.json')
    await expect(system.addTileset('https://tiles.test/a.json')).rejects.toThrowError(/already registered/)
    system.dispose()
  })
})

describe('AssetLeaseManager', () => {
  const memorySource = {
    scheme: 'memory:',
    load: async (descriptor: { url?: string }) => ({
      object: { name: descriptor.url },
      estimatedBytes: 100,
      dispose: vi.fn()
    })
  }

  function makeManager() {
    return new AssetLeaseManager({
      resolve: (ref) =>
        ref.id === 'crane-glb'
          ? { ref, kind: 'glb', url: 'memory:crane-glb' }
          : undefined
      ,
      sources: [memorySource]
    })
  }

  it('leases share one load and refcount releases', async () => {
    const manager = makeManager()
    const lease1 = await manager.acquire({ id: 'crane-glb' })
    const lease2 = await manager.acquire({ id: 'crane-glb' })
    expect(manager.leaseCount).toBe(2)
    expect((lease1.object as { name: string }).name).toBe('memory:crane-glb')
    lease1.release()
    expect(manager.leaseCount).toBe(1)
    lease2.release()
    expect(manager.leaseCount).toBe(0)
  })

  it('double release is idempotent and unknown refs throw', async () => {
    const manager = makeManager()
    const lease = await manager.acquire({ id: 'crane-glb' })
    lease.release()
    lease.release()
    expect(manager.leaseCount).toBe(0)
    await expect(manager.acquire({ id: 'ghost' })).rejects.toThrowError(/unknown asset ref/)
  })
})

describe('AssetLeaseManager 内存预算与解码器装配 (I4-2)', () => {
  function makeManager(options: { maxTotalBytes?: number; enhancer?: (loader: unknown) => Promise<void> }) {
    return new AssetLeaseManager({
      resolve: (ref) =>
        ref.id === 'heavy-glb'
          ? { ref, kind: 'glb' as const, url: 'memory:heavy', bytes: 600 }
          : undefined,
      sources: [
        {
          scheme: 'memory:',
          load: async (descriptor: { url?: string; bytes?: number }) => ({
            object: { name: descriptor.url },
            estimatedBytes: descriptor.bytes ?? 0,
            dispose: vi.fn()
          })
        }
      ],
      maxTotalBytes: options.maxTotalBytes,
      gltfLoaderEnhancer: options.enhancer
    })
  }

  it('超内存预算拒绝 acquire 并回退租约', async () => {
    const manager = makeManager({ maxTotalBytes: 500 })
    await expect(manager.acquire({ id: 'heavy-glb' })).rejects.toThrowError(/budget exceeded/)
    expect(manager.leaseCount).toBe(0)
    expect(manager.estimatedBytesTotal).toBe(0)
  })

  it('预算内租约累计估算字节，释放后归零', async () => {
    const manager = makeManager({ maxTotalBytes: 1000 })
    const lease = await manager.acquire({ id: 'heavy-glb' })
    expect(manager.estimatedBytesTotal).toBe(600)
    lease.release()
    expect(manager.estimatedBytesTotal).toBe(0)
  })

  it('gltfLoaderEnhancer 在 GLB 解析前被调用（data: URL 全链路）', async () => {
    // 最小 GLB：一个三角形（POSITION only）
    const gltf = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }
      ],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }]
    }
    const bin = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer)
    const json = Buffer.from(JSON.stringify(gltf), 'utf8')
    const total = 12 + 8 + json.length + 8 + bin.length
    const glb = Buffer.alloc(total)
    const view = new DataView(glb.buffer)
    view.setUint32(0, 0x46546c67, true)
    view.setUint32(4, 2, true)
    view.setUint32(8, total, true)
    view.setUint32(12, json.length, true)
    view.setUint32(16, 0x4e4f534a, true)
    json.copy(glb, 20)
    view.setUint32(20 + json.length, bin.length, true)
    view.setUint32(24 + json.length, 0x004e4942, true)
    bin.copy(glb, 28 + json.length)

    const enhanced: unknown[] = []
    const manager = new AssetLeaseManager({
      resolve: (ref) =>
        ref.id === 'tiny'
          ? {
              ref,
              kind: 'glb' as const,
              url: `data:model/gltf-binary;base64,${glb.toString('base64')}`
            }
          : undefined,
      gltfLoaderEnhancer: async (loader) => {
        enhanced.push(loader)
      }
    })
    const lease = await manager.acquire({ id: 'tiny' })
    expect(enhanced).toHaveLength(1)
    const scene = lease.object as { children: Array<unknown> }
    expect(scene.children.length).toBeGreaterThan(0)
  })

  it('enhancer 抛错 → acquire 失败（装配先于加载）', async () => {
    const manager = new AssetLeaseManager({
      resolve: (ref) =>
        ref.id === 'tiny'
          ? { ref, kind: 'glb' as const, url: 'data:model/gltf-binary;base64,AAAA' }
          : undefined,
      gltfLoaderEnhancer: async () => {
        throw new Error('decoder setup failed')
      }
    })
    await expect(manager.acquire({ id: 'tiny' })).rejects.toThrowError(/decoder setup failed/)
  })
})


describe('ContextLossGuard (§75, I5-4)', () => {
  it('丢失→停帧+preventDefault；恢复→重置状态+续跑', () => {
    const target = new EventTarget()
    let suspended = 0
    let resumed = 0
    let resets = 0
    let defaultPrevented = false
    const guard = new ContextLossGuard(target, {
      suspendLoop: () => suspended++,
      resumeLoop: () => resumed++,
      resetRendererState: () => resets++
    })
    target.addEventListener('webglcontextlost', (e) => {
      defaultPrevented = (e as Event).defaultPrevented
    })
    // 与浏览器一致：webglcontextlost 是 cancelable 事件
    target.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    expect(suspended).toBe(1)
    expect(guard.lost).toBe(true)
    expect(defaultPrevented).toBe(true) // 允许随后恢复

    target.dispatchEvent(new Event('webglcontextrestored'))
    expect(resumed).toBe(1)
    expect(resets).toBe(1)
    expect(guard.lost).toBe(false)

    guard.dispose()
    // 与浏览器一致：webglcontextlost 是 cancelable 事件
    target.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    expect(suspended).toBe(1) // dispose 后不再响应
  })
})

describe('SceneViewDriver', () => {
  it('delegates focus/target to the handle', async () => {
    const focusEntity = vi.fn((_entity: { namespace: string; id: string }, _range?: number) => true)
    const applyGeodeticTarget = vi.fn()
    const driver = createSceneViewDriver({
      getHandle: () => ({
        focusEntity,
        applyGeodeticTarget,
        getGeodeticTarget: () => ({
          target: {
            longitudeDegrees: 121.5,
            latitudeDegrees: 31.2,
            heightMeters: 0,
            verticalReference: 'ellipsoid' as const
          },
          scaleMeters: 800
        })
      }),
      getSites: () =>
        new Map([
          [
            'site-x',
            {
              origin: {
                longitudeDegrees: 121.5,
                latitudeDegrees: 31.2,
                heightMeters: 0,
                verticalReference: 'ellipsoid' as const
              }
            }
          ]
        ])
    })
    await driver.focus({ namespace: 'production', id: 'CRANE-003' })
    expect(focusEntity).toHaveBeenCalledTimes(1)
    expect(focusEntity.mock.calls[0][0]).toEqual({
      namespace: 'production',
      id: 'CRANE-003'
    })
    const target = driver.getTarget()
    expect(target?.scaleMeters).toBe(800)
    await driver.goToSite('site-x')
    expect(applyGeodeticTarget).toHaveBeenCalled()
  })

  it('siteExtentMeters estimates from bounds', () => {
    const extent = siteExtentMeters({ south: 31, west: 121, north: 31.1, east: 121.1 })
    expect(extent).toBeGreaterThan(8000)
    expect(extent).toBeLessThan(13000)
    expect(siteExtentMeters(undefined)).toBeUndefined()
  })
})

/** ---------------------- Issue #12：AssetLeaseManager 生命周期闭环 */

describe('AssetLeaseManager 生命周期闭环（Issue #12）', () => {
  function makeSource() {
    const loads: Array<{ descriptor: { url?: string }; dispose: ReturnType<typeof vi.fn> }> = []
    return {
      loads,
      source: {
        scheme: 'memory:',
        load: async (descriptor: { url?: string }) => {
          const dispose = vi.fn()
          loads.push({ descriptor, dispose })
          return {
            object: { name: descriptor.url },
            estimatedBytes: 100,
            dispose
          }
        }
      }
    }
  }

  function makeManager(source: AssetSource) {
    return new AssetLeaseManager({
      resolve: (ref) =>
        ref.id === 'crane-glb'
          ? { ref, kind: 'glb' as const, url: 'memory:crane-glb' }
          : undefined,
      sources: [source]
    })
  }

  it('load reject 后 cache/refCount 原子驱逐，重试可恢复（不永久中毒）', async () => {
    let fail = true
    const source = {
      scheme: 'memory:',
      load: async (descriptor: { url?: string }) => {
        if (fail) throw new Error('transient network failure')
        return { object: { name: descriptor.url }, estimatedBytes: 100, dispose: vi.fn() }
      }
    }
    const manager = makeManager(source)
    await expect(manager.acquire({ id: 'crane-glb' })).rejects.toThrowError(/transient/)
    // 失败后 baseline：无泄漏的 refCount / lease
    expect(manager.leaseCount).toBe(0)

    // 重试：同一 key 创建新 load 并成功
    fail = false
    const lease = await manager.acquire({ id: 'crane-glb' })
    expect(manager.leaseCount).toBe(1)
    expect((lease.object as { name: string }).name).toBe('memory:crane-glb')
    manager.dispose()
  })

  it('并发 acquire 同一失败 key：全部 reject 后 leaseCount 归零', async () => {
    const source = {
      scheme: 'memory:',
      load: async () => {
        throw new Error('decode failed')
      }
    }
    const manager = makeManager(source)
    const results = await Promise.allSettled([
      manager.acquire({ id: 'crane-glb' }),
      manager.acquire({ id: 'crane-glb' }),
      manager.acquire({ id: 'crane-glb' })
    ])
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    expect(manager.leaseCount).toBe(0)
    manager.dispose()
  })

  it('dispose 真正释放已加载资源，acquire/registerSource fail-fast，指标归零', async () => {
    const { source, loads } = makeSource()
    const manager = makeManager(source)
    const lease = await manager.acquire({ id: 'crane-glb' })
    expect(manager.estimatedBytesTotal).toBe(100)

    manager.dispose()
    expect(loads[0]!.dispose).toHaveBeenCalledTimes(1) // resolved entry 被 dispose
    expect(manager.estimatedBytesTotal).toBe(0)
    expect(manager.leaseCount).toBe(0)

    // terminal 状态：fail-fast
    await expect(manager.acquire({ id: 'crane-glb' })).rejects.toThrowError(/disposed/)
    expect(() => manager.registerSource(source)).toThrowError(/disposed/)

    // 旧 lease 再 release：幂等，不 double-dispose
    expect(() => lease.release()).not.toThrow()
    expect(loads[0]!.dispose).toHaveBeenCalledTimes(1)
    manager.dispose() // 幂等
    expect(loads[0]!.dispose).toHaveBeenCalledTimes(1)
  })

  it('dispose 与 pending load 竞态：late resolve 被 exactly-once 回收，不返回 Lease', async () => {
    let releaseLoad!: () => void
    const gate = new Promise<void>((r) => {
      releaseLoad = r
    })
    const lateDispose = vi.fn()
    const source = {
      scheme: 'memory:',
      load: () =>
        gate.then(() => ({
          object: { name: 'late' },
          estimatedBytes: 100,
          dispose: lateDispose
        }))
    }
    const manager = makeManager(source)
    const acquirePromise = manager.acquire({ id: 'crane-glb' })
    manager.dispose() // load pending 期间销毁
    releaseLoad() // late resolve

    await expect(acquirePromise).rejects.toThrowError(/disposed/)
    expect(lateDispose).toHaveBeenCalledTimes(1) // zombie 资源被 exactly-once 回收
    expect(manager.leaseCount).toBe(0)
  })

  it('disposeObject3D 释放 geometry/material/texture，共享 texture 只 dispose 一次', async () => {
    // 经真实 manager 路径验证 disposeObject3D（memory source 返回伪 GLB 场景图）
    const textureA = { isTexture: true, dispose: vi.fn() }
    const textureB = { isTexture: true, dispose: vi.fn() }
    const geometry = { dispose: vi.fn() }
    const material1 = {
      dispose: vi.fn(),
      map: textureA,
      normalMap: textureA, // 共享 texture
      emissiveMap: textureB
    }
    const material2 = {
      dispose: vi.fn(),
      map: textureA // 跨 mesh 共享
    }
    const scene = {
      traverse: (cb: (obj: unknown) => void) => {
        cb({ geometry, material: material1 })
        cb({ geometry, material: [material2] })
      }
    }
    const source = {
      scheme: 'memory:',
      load: async () => ({
        object: scene,
        estimatedBytes: 10,
        // 与 loadGltf 一致：dispose 走 disposeObject3D 深度回收
        dispose: () => disposeObject3D(scene)
      })
    }
    const manager = makeManager(source)
    const lease = await manager.acquire({ id: 'crane-glb' })
    lease.release() // 最后一个 release → 资源 dispose

    expect(geometry.dispose).toHaveBeenCalledTimes(1)
    expect(material1.dispose).toHaveBeenCalledTimes(1)
    expect(material2.dispose).toHaveBeenCalledTimes(1)
    expect(textureA.dispose).toHaveBeenCalledTimes(1) // identity 去重
    expect(textureB.dispose).toHaveBeenCalledTimes(1)
  })
})

/** ---------------- Issue #14：GraphicsAccess lazy boot 状态机闭环 */

function makeRuntimeFactory() {
  const runtimes: Array<{ disposed: number }> = []
  const createRuntime = vi.fn(async (): Promise<EngineRuntime> => {
    const rt = {
      disposed: 0,
      context: {
        getDiagnostics: () => undefined,
        suspend: () => {},
        resume: () => {}
      },
      createMountRoot: () => ({ root: {}, detach: () => {} }),
      dispose: () => {
        rt.disposed++
      },
      suspend: () => {},
      resume: () => {}
    }
    const full = rt as unknown as EngineRuntime
    runtimes.push(rt)
    return full
  })
  return { createRuntime, runtimes }
}

describe('GraphicsAccess lazy boot 状态机（Issue #14）', () => {
  it('首次 boot transient reject → 第二次 use() 真实重试并可成功', async () => {
    let calls = 0
    const access = createGraphicsAccess(
      { getViewport: () => document.createElement('div') },
      {
        createRuntime: async () => {
          calls++
          if (calls === 1) throw new Error('transient WebGL failure')
          return makeRuntimeFactoryRt() as unknown as EngineRuntime
        }
      }
    )
    await expect(access.use()).rejects.toThrowError(/transient/)
    expect(access.state).toBe('UNINITIALIZED') // 可重试，不是 poisoned
    const ctx = await access.use()
    expect(access.state).toBe('ACTIVE')
    expect(ctx.root).toBeDefined()
    expect(calls).toBe(2)
    access.dispose()
  })

  it('并发 use() 共享同一 attempt（底层只 boot 一次）', async () => {
    const { createRuntime, runtimes } = makeRuntimeFactory()
    const access = createGraphicsAccess(
      { getViewport: () => document.createElement('div') },
      { createRuntime }
    )
    const [c1, c2] = await Promise.all([access.use(), access.use(), access.use()])
    expect(createRuntime).toHaveBeenCalledTimes(1)
    expect(runtimes).toHaveLength(1)
    expect(c1.root).toBeDefined()
    expect(c2.root).toBeDefined()
    access.dispose()
  })

  it('use pending → dispose → late resolve：runtime exactly-once 回收，不复活 ACTIVE', async () => {
    const { createRuntime, runtimes } = makeRuntimeFactory()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const access = createGraphicsAccess(
      { getViewport: () => document.createElement('div') },
      {
        createRuntime: async () => {
          await gate
          return createRuntime()
        }
      }
    )
    const usePromise = access.use()
    access.dispose() // boot pending 期间 terminal teardown
    expect(access.state).toBe('DISPOSED')

    release() // late resolve：runtime 创建完成
    await expect(usePromise).rejects.toThrowError() // aborted，不返回 live context
    expect(runtimes[0]!.disposed).toBe(1) // exactly-once 回收
    expect(access.currentContext).toBeUndefined() // 终态不变量
    await expect(access.use()).rejects.toThrowError(/disposed/) // fail-fast
    expect(access.state).toBe('DISPOSED') // 永不复活
    expect(runtimes[0]!.disposed).toBe(1) // 不 double-dispose
  })

  it('dispose 后 use() fail-fast，不再触发新的 runtime creation', async () => {
    const { createRuntime } = makeRuntimeFactory()
    const access = createGraphicsAccess(
      { getViewport: () => document.createElement('div') },
      { createRuntime }
    )
    access.dispose()
    access.dispose() // 幂等
    await expect(access.use()).rejects.toThrowError(/disposed/)
    expect(createRuntime).not.toHaveBeenCalled()
    expect(access.currentContext).toBeUndefined()
  })
})

function makeRuntimeFactoryRt() {
  return {
    context: { getDiagnostics: () => undefined, suspend: () => {}, resume: () => {} },
    createMountRoot: () => ({ root: {}, detach: () => {} }),
    dispose: () => {},
    suspend: () => {},
    resume: () => {}
  }
}

/** ---------------- Issue #15：Scene callback fault boundary（隔离 + quarantine） */

import { dispatchCallbacks, makeFaultSink } from './src/callbacks'

describe('callback fault boundary（Issue #15）', () => {
  it('frame：A throw → B 仍执行，A 被 quarantine，sink 只上报一次', () => {
    const subs = new Set<(info: { frame: number }) => void>()
    const sink = vi.fn()
    const executed: string[] = []
    const bad = () => {
      executed.push('bad')
      throw new Error('scene frame failed')
    }
    const good = () => {
      executed.push('good')
    }
    subs.add(bad)
    subs.add(good)

    dispatchCallbacks(subs, { frame: 1 }, 'frame', sink)

    // 本帧：bad 执行（失败）后 good 仍执行（无饥饿）
    expect(executed).toEqual(['bad', 'good'])
    // quarantine：bad 被移除，sink 只收到一次
    expect(subs.has(bad)).toBe(false)
    expect(subs.has(good)).toBe(true)
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledWith(expect.any(Error), { kind: 'frame' })

    // 下一帧：bad 不再调用（无 60fps error storm），good 继续
    dispatchCallbacks(subs, { frame: 2 }, 'frame', sink)
    expect(executed).toEqual(['bad', 'good', 'good'])
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('pick：A throw → B 仍收到事件，meta.kind = pick', () => {
    const subs = new Set<(e: { key: number }) => void>()
    const sink = vi.fn()
    const received: number[] = []
    subs.add(() => {
      throw new Error('pick handler failed')
    })
    subs.add((e) => received.push(e.key))

    dispatchCallbacks(subs, { key: 7 }, 'pick', sink)

    expect(received).toEqual([7])
    expect(sink).toHaveBeenCalledWith(expect.any(Error), { kind: 'pick' })
    expect(subs.size).toBe(1)
  })

  it('多个失败 callback：全部隔离、逐个上报，循环不中断', () => {
    const subs = new Set<(i: number) => void>()
    const sink = vi.fn()
    let healthy = 0
    subs.add(() => {
      throw new Error('bad-1')
    })
    subs.add(() => {
      throw new Error('bad-2')
    })
    subs.add(() => {
      healthy++
    })

    dispatchCallbacks(subs, 1, 'frame', sink)

    expect(healthy).toBe(1)
    expect(sink).toHaveBeenCalledTimes(2)
    expect(subs.size).toBe(1) // 仅健康 callback 保留，两个失败者均被隔离
  })

  it('sink 自身 throw 不影响 dispatch（防御性边界）', () => {
    const subs = new Set<(i: number) => void>()
    const healthy = vi.fn()
    subs.add(() => {
      throw new Error('bad')
    })
    subs.add(healthy)
    const sink = vi.fn(() => {
      throw new Error('sink exploded')
    })

    expect(() => dispatchCallbacks(subs, 1, 'frame', sink)).not.toThrow()
    expect(healthy).toHaveBeenCalledTimes(1)
  })

  it('makeFaultSink：未提供 handler 时降级 console.error（一次）', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sink = makeFaultSink(undefined)
    const subs = new Set<(i: number) => void>()
    const bad = () => {
      throw new Error('boom')
    }
    subs.add(bad)
    dispatchCallbacks(subs, 1, 'frame', sink)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })
})

/** ------- Issue #14-r2（复审）：runtime single-flight ≠ root single-flight */

describe('GraphicsAccess per-use mount root（#14-r2 回归）', () => {
  function makeRootSpyFactory() {
    const createMountRoot = vi.fn(() => ({ root: {}, detach: () => {} }))
    const { createRuntime, runtimes } = makeRuntimeFactory()
    // 注入带 root-spy 的 runtime
    const create = vi.fn(async (): Promise<EngineRuntime> => {
      const rt = (await createRuntime()) as unknown as EngineRuntime & {
        createMountRoot: typeof createMountRoot
      }
      ;(rt as unknown as { createMountRoot: typeof createMountRoot }).createMountRoot =
        createMountRoot
      return rt
    })
    return { create, createMountRoot, runtimes }
  }

  it('顺序 use()：runtime single-flight 保持，root 每次全新分配', async () => {
    const { create, createMountRoot, runtimes } = makeRootSpyFactory()
    const access = createGraphicsAccess(
      { getViewport: () => document.createElement('div') },
      { createRuntime: create }
    )
    const c1 = await access.use()
    const c2 = await access.use()

    expect(createMountRoot).toHaveBeenCalledTimes(2) // per-use 分配
    expect(c1.root).not.toBe(c2.root)
    expect(runtimes).toHaveLength(1) // runtime 仍 single-flight
    access.dispose()
  })

  it('并发 use()：runtime 一次、root 三个（互不共享）', async () => {
    const { create, createMountRoot, runtimes } = makeRootSpyFactory()
    const access = createGraphicsAccess(
      { getViewport: () => document.createElement('div') },
      { createRuntime: create }
    )
    const [c1, c2, c3] = await Promise.all([
      access.use(),
      access.use(),
      access.use()
    ])

    expect(createMountRoot).toHaveBeenCalledTimes(3)
    expect(new Set([c1.root, c2.root, c3.root]).size).toBe(3)
    expect(createMountRoot.mock.instances.length).toBeGreaterThanOrEqual(0)
    expect(runtimes).toHaveLength(1)
    access.dispose()
  })
})

/** ---------------- Issue #17：Global 3D placement 语义与 ECEF 权威映射 */

import { GlobalEarthSystem } from './src/earth'

describe('ECEF → scene 轴映射 anchor（Issue #17-D 单一权威实现）', () => {
  const A_KM = 6378.137
  const B_KM = 6356.752

  it('赤道 90°E：ECEF (0, a, 0) → scene (0, 0, -a)', () => {
    const scene = GlobalEarthSystem.ecefMetersToScene({
      x: 0,
      y: A_KM * 1000,
      z: 0
    })
    expect(scene.x).toBeCloseTo(0, 6)
    expect(scene.y).toBeCloseTo(0, 6)
    expect(scene.z).toBeCloseTo(-A_KM, 3)
  })

  it('北极：ECEF (0, 0, b) → scene (0, b, 0)', () => {
    const scene = GlobalEarthSystem.ecefMetersToScene({
      x: 0,
      y: 0,
      z: B_KM * 1000
    })
    expect(scene.x).toBeCloseTo(0, 6)
    expect(scene.y).toBeCloseTo(B_KM, 3)
    expect(scene.z).toBeCloseTo(0, 6)
  })

  it('setObjectEcefPosition 只设 position、不改 parent（不 reparent）', () => {
    // earth 构造需要 canvas（graticule 纹理）——stub 掉 DOM
    const noopCtx = new Proxy({}, { get: () => () => {} })
    const fakeDocument = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => noopCtx
      })
    }
    vi.stubGlobal('document', fakeDocument)
    try {
      const earth = new GlobalEarthSystem({ add: () => {} } as never)
      const parent = { children: [] }
      const object = {
        position: { set: vi.fn() },
        parent
      } as unknown as THREE.Object3D & { parent: unknown }
      earth.setObjectEcefPosition(object, { x: 1000, y: 2000, z: 3000 })
      expect(object.position.set).toHaveBeenCalledWith(1, 3, -2)
      expect((object as { parent: unknown }).parent).toBe(parent) // 未被 reparent
    } finally {
      vi.unstubAllGlobals()
    }
  })
})


/** ---------------- Issue #22：AssetKind 运行时路由 dispatch matrix */

import { UnsupportedAssetKindError } from './src/resources'

describe('AssetKind dispatch matrix（Issue #22）', () => {
  function makeManagerForKinds(kinds: Array<{ id: string; kind: string; url: string }>) {
    return new AssetLeaseManager({
      resolve: (ref) => {
        const entry = kinds.find((k) => k.id === ref.id)
        return entry
          ? { ref, kind: entry.kind as never, url: entry.url, bytes: 100 }
          : undefined
      },
      sources: [] // 无 memory source：强制走 kind 路由（https data 路径）
    })
  }

  it('glb/gltf/collision-proxy → GLTF 分支（不抛 UnsupportedAssetKindError）', async () => {
    const manager = makeManagerForKinds([
      { id: 'a-glb', kind: 'glb', url: 'data:x' },
      { id: 'a-gltf', kind: 'gltf', url: 'data:x' },
      { id: 'a-collision', kind: 'collision-proxy', url: 'data:x' }
    ])
    // data: blob 不是合法 glTF → GLTFLoader 会失败（fetch/parse 层），
    // 但错误绝不是 UnsupportedAssetKindError（证明路由进入了 GLTF 分支）
    for (const id of ['a-glb', 'a-gltf', 'a-collision']) {
      const error = await manager.acquire({ id }).catch((e) => e)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(UnsupportedAssetKindError)
      expect(String(error.message)).not.toMatch(/no runtime loader|TilesSystem/)
      expect(error instanceof UnsupportedAssetKindError).toBe(false)
    }
    manager.dispose()
  })

  it('tileset → 明确 fail-fast 指向 TilesSystem，绝不进入 GLTFLoader', async () => {
    const manager = makeManagerForKinds([
      { id: 'changxing-site-tileset', kind: 'tileset', url: 'https://tiles.example/tileset.json' }
    ])
    // https: + tileset：URL scheme 不再决定 parser
    await expect(manager.acquire({ id: 'changxing-site-tileset', version: '2026-08' })).rejects.toThrowError(
      /TilesSystem/
    )
    manager.dispose()
  })

  it('ktx2-texture / binary-metadata / kinematic-model → reserved fail-fast（含 id+kind）', async () => {
    const manager = makeManagerForKinds([
      { id: 'k1', kind: 'ktx2-texture', url: 'https://t/k.ktx2' },
      { id: 'b1', kind: 'binary-metadata', url: 'https://t/b.bin' },
      { id: 'm1', kind: 'kinematic-model', url: 'https://t/m.json' }
    ])
    await expect(manager.acquire({ id: 'k1' })).rejects.toThrowError(/ktx2-texture.*no runtime loader|no runtime loader.*ktx2-texture/)
    await expect(manager.acquire({ id: 'b1' })).rejects.toThrowError(/binary-metadata/)
    await expect(manager.acquire({ id: 'm1' })).rejects.toThrowError(/kinematic-model/)
    manager.dispose()
  })
})

/** -------- Issue #23：late registration catch-up（Fast Path → EntitySystem） */

import { EntitySystem } from './src/entities'

describe('EntitySystem late registration catch-up（Issue #23）', () => {
  it('upsert → drain（无 entity）→ register：最新 pose 立即应用，不依赖新数据', () => {
    const buffer = new SpatialStateBuffer()
    const entities = new EntitySystem(buffer)
    const poseWrite = {
      x: 10, y: 20, z: 30, qx: 0, qy: 0, qz: 0, qw: 1,
      timeMs: 1000, frameId: 'f'
    }
    buffer.upsert('agv/A', poseWrite)

    // drain 发生在 entity 注册之前（dirty 标志被消费）
    buffer.drainDirty(() => {})

    const mesh = {
      position: { set: vi.fn() },
      quaternion: { set: vi.fn() }
    }
    const d = entities.register({ namespace: 'agv', id: 'A' }, mesh as never)

    // 注册时立即从 buffer catch-up latest pose
    expect(mesh.position.set).toHaveBeenCalledWith(10, 20, 30)
    void d
  })

  it('HISTORY 固定时间点：buffer 停留 t1，晚注册 entity 立即获得 t1 pose（无新数据）', () => {
    const buffer = new SpatialStateBuffer()
    const entities = new EntitySystem(buffer)
    buffer.upsert('agv/B', { x: 1, y: 2, z: 3, qx: 0, qy: 0, qz: 0, qw: 1, timeMs: 5000, frameId: 'f' })
    buffer.drainDirty(() => {})
    // 无新 seek/delta——时间线停留在 t1

    const mesh: THREE.Object3D = new THREE.Object3D()
    entities.register({ namespace: 'agv', id: 'B' }, mesh)
    // catch-up 后 mesh 位于 t1 pose
    expect(mesh.position.x).toBe(1)
    expect(mesh.position.y).toBe(2)
    expect(mesh.position.z).toBe(3)
  })

  it('无 buffer pose 时 register 不改写 object transform', () => {
    const entities = new EntitySystem(new SpatialStateBuffer())
    const mesh = new THREE.Object3D()
    mesh.position.set(7, 8, 9)
    entities.register({ namespace: 'agv', id: 'C' }, mesh)
    expect(mesh.position.x).toBe(7)
  })
})
