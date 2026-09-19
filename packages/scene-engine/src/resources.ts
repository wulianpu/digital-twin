import type { AssetApi, AssetLease } from '@twin/sdk'
import type { AssetDescriptor, AssetRef } from '@twin/content'
import { assetRefKey } from '@twin/content'

/**
 * AssetApi / AssetLease (§43-44): platform owns shared assets; scenes only
 * lease and release. Refcounted — the last release disposes GPU resources.
 * NOTE: this module must not statically import three (the public entry
 * re-exports it); heavy loaders are dynamically imported on first use.
 *
 * Issue #12（生命周期闭环）：
 * - load reject → 失败 entry 原子驱逐（compare-by-entry identity），
 *   refCount 回滚，后续 acquire 创建新 load 并可重试，失败不再永久中毒；
 * - manager `disposed` 终态：dispose 幂等、acquire fail-fast、
 *   pending load late resolve 的 LoadedAsset 被 exactly-once 回收且不返回 Lease；
 * - `dispose()` 真正释放全部 owned 资源（resolved / pending / active lease），
 *   resolvedBytes / leaseCount 归零；
 * - GLTF GPU 回收覆盖 geometry / material / material 引用的 Texture
 *   （共享 texture 按 identity 去重）。
 */

export interface LoadedAsset {
  object: unknown
  estimatedBytes: number
  dispose(): void
}

export interface AssetSource {
  /** Scheme the source handles, e.g. 'https:', 'memory:'. */
  readonly scheme: string
  load(descriptor: AssetDescriptor): Promise<LoadedAsset>
}

export interface AssetApiOptions {
  /** Resolve a ref to a descriptor via the ContentRegistry. */
  resolve(ref: AssetRef): AssetDescriptor | undefined
  /** Extra sources, e.g. a memory source for tests/demos. */
  sources?: readonly AssetSource[]
  /**
   * 资产总字节预算（I4-2 内存预算接线）：所有活跃租约的估算字节之和
   * 超过该值时，新的 acquire 被拒绝（错误信息含当前用量）。
   */
  maxTotalBytes?: number
  /**
   * GLTFLoader 装配钩子（I4-2）：KTX2 / DRACO / meshopt 解码器在应用层
   * 组合注入（组合根持有 renderer 与部署配置，平台层保持无感知）。
   *
   * #12-r2：enhancer reject 视为装配瞬时失败——manager 会清除失败
   * attempt 并在下一次 acquire 重试重建。
   * #12-r3：enhancer 可返回 disposer（函数或 { dispose() }），把
   * DRACO/KTX2 worker 等 decoder-stack 资源的 ownership 转移给
   * manager——manager dispose() 时 exactly-once 回收；装配期间 terminal
   * 的 late stack 立即回收，不 commit READY。enhancer 若在 reject 前
   * 已创建部分资源，须自行回滚（返回值只覆盖成功路径的归属转移）。
   */
  gltfLoaderEnhancer?: (
    loader: unknown
  ) => void | GltfStackDisposable | Promise<void | GltfStackDisposable>
}

interface CacheEntry {
  refCount: number
  load: Promise<LoadedAsset>
  /** resolve 后填充；驱逐/释放时优先用它做 exactly-once dispose。 */
  loaded?: LoadedAsset
  /** entry 已被驱逐/释放（迟到的 acquire continuation 不得再返回 Lease）。 */
  disposed: boolean
}

interface GLTFLoaderLike {
  loadAsync(url: string): Promise<{ scene: unknown }>
}

/**
 * Issue #22：AssetKind 运行时路由缺失的 fail-fast——
 * kind 决定 parser/runtime owner，scheme 只决定 transport/source。
 */
export class UnsupportedAssetKindError extends Error {
  readonly id: string
  readonly kind: string
  constructor(id: string, version: string | undefined, kind: string, reason: string) {
    super(
      `[scene-engine] asset "${id}@${version ?? '0'}" kind "${kind}" has no runtime loader: ${reason}`
    )
    this.name = 'UnsupportedAssetKindError'
    this.id = id
    this.kind = kind
  }
}

export class AssetLeaseManager implements AssetApi {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly sources = new Map<string, AssetSource>()
  private readonly resolvedBytes = new Map<string, number>()
  /** exactly-once dispose 的 identity 账本（WeakSet 不阻止 GC）。 */
  private readonly disposedAssets = new WeakSet<LoadedAsset>()
  private gltfLoader: Promise<GLTFLoaderLike> | undefined
  /** #12-r3：manager 拥有的 decoder-stack disposer（enhancer 转移）。 */
  private gltfStackDisposer: (() => void) | undefined
  private gltfStackDisposed = false
  private disposed = false

  constructor(private readonly options: AssetApiOptions) {
    for (const source of options.sources ?? []) {
      this.sources.set(source.scheme, source)
    }
  }

  get leaseCount(): number {
    let count = 0
    for (const entry of this.cache.values()) count += entry.refCount
    return count
  }

  /** 活跃租约的估算字节总量（I4-2 预算与诊断）。 */
  get estimatedBytesTotal(): number {
    let total = 0
    for (const bytes of this.resolvedBytes.values()) total += bytes
    return total
  }

  async acquire(ref: AssetRef): Promise<AssetLease> {
    if (this.disposed) {
      throw new Error('[scene-engine] asset manager disposed (Issue #12 terminal state)')
    }
    const key = assetRefKey(ref)
    let entry = this.cache.get(key)
    if (!entry) {
      entry = { refCount: 0, load: this.load(ref), disposed: false }
      this.cache.set(key, entry)
    }
    entry.refCount++
    let loaded: LoadedAsset
    try {
      loaded = await entry.load
    } catch (error) {
      // #12-A：load reject → 本次/并发 claimant 各自回滚 refCount；
      // 最后一个 claimant 按 entry identity 原子驱逐中毒 entry——
      // 后续 acquire 会创建新的 load Promise 并可重试。
      entry.refCount--
      if (entry.refCount <= 0) this.evictEntry(key, entry)
      throw error
    }
    if (this.disposed || entry.disposed) {
      // #12-B：manager/entry teardown 后 late resolve——
      // 资源 exactly-once 回收，绝不返回逃逸的 Lease。
      this.disposeLoadedOnce(loaded)
      entry.refCount--
      throw new Error(`[scene-engine] asset "${key}" lease aborted (manager disposed)`)
    }
    entry.loaded = loaded // resolve 即登记，驱逐/释放路径可同步 exactly-once dispose
    this.resolvedBytes.set(key, loaded.estimatedBytes)
    // 内存预算（I4-2）：超预算则回退本次租约并拒绝。
    const maxBytes = this.options.maxTotalBytes
    if (maxBytes !== undefined && this.estimatedBytesTotal > maxBytes) {
      entry.refCount--
      if (entry.refCount <= 0) this.evictEntry(key, entry)
      throw new Error(
        `[scene-engine] asset budget exceeded: ${this.estimatedBytesTotal}B > ${maxBytes}B (ref "${key}")`
      )
    }
    let released = false
    return {
      ref,
      version: ref.version ?? '0',
      object: loaded.object,
      estimatedBytes: loaded.estimatedBytes,
      release: () => {
        if (released) return
        released = true
        const current = this.cache.get(key)
        if (!current) return // manager dispose 已兜底回收（幂等）
        current.refCount--
        if (current.refCount <= 0) this.evictEntry(key, current)
      }
    }
  }

  registerSource(source: AssetSource): void {
    if (this.disposed) {
      throw new Error('[scene-engine] asset manager disposed (registerSource rejected)')
    }
    this.sources.set(source.scheme, source)
  }

  private async load(ref: AssetRef): Promise<LoadedAsset> {
    const descriptor = this.options.resolve(ref)
    if (!descriptor) throw new Error(`[scene-engine] unknown asset ref "${assetRefKey(ref)}"`)
    const url = descriptor.url
    if (!url) throw new Error(`[scene-engine] asset "${assetRefKey(ref)}" has no url`)
    const scheme = url.slice(0, url.indexOf(':') + 1) || 'https:'
    const source = this.sources.get(scheme)
    // 注册 scheme source（memory: 等）：transport+parser 由 source 自带
    //（测试/演示 escape hatch）。
    if (source) return source.load(descriptor)
    // Issue #22：scheme 决定 transport，kind 决定 parser/runtime owner——
    // 禁止以 URL scheme 代替资产语义（https: ≠ glTF）。
    if (scheme === 'https:' || scheme === 'http:' || scheme === 'data:') {
      switch (descriptor.kind) {
        case 'glb':
        case 'gltf':
        // collision-proxy 契约：编码为 GLB（demo manifest 即 .glb）
        // eslint-disable-next-line no-fallthrough -- 共享 GLTF 分支
        case 'collision-proxy':
          return this.loadGltf(url, descriptor)
        case 'tileset':
          // 3D Tiles 的 runtime owner 是 SceneEngine TilesSystem
          //（TilesPolicy.tilesetUrls / typed bridge），不是通用 Object3D lease
          throw new UnsupportedAssetKindError(
            ref.id,
            ref.version,
            'tileset',
            '3D Tiles 由 SceneEngine TilesSystem 拥有（TilesPolicy.tilesetUrls），不经 ctx.assets.acquire 加载'
          )
        case 'ktx2-texture':
        case 'binary-metadata':
        case 'kinematic-model':
          // 尚无 runtime loader：fail-fast（避免低层 GLTF parse 误报）
          throw new UnsupportedAssetKindError(
            ref.id,
            ref.version,
            descriptor.kind,
            'reserved kind（V1 无 runtime loader）'
          )
        default: {
          const exhaustive: never = descriptor.kind
          throw new UnsupportedAssetKindError(
            ref.id,
            ref.version,
            String(exhaustive),
            'unknown kind（新增 AssetKind 必须注册 runtime loader）'
          )
        }
      }
    }
    throw new Error(`[scene-engine] no asset source for scheme "${scheme}"`)
  }

  private async loadGltf(url: string, descriptor: AssetDescriptor): Promise<LoadedAsset> {
    // #12-r2：loader factory 经 rejection-safe single-flight 获取——
    // build/enhancer 的 rejected Promise 不得永久占据 gltfLoader 缓存
    const loader = await this.getGltfLoader()
    // #12-r3：terminal revalidation——dispose 后不得再启动新的
    // 网络/parse/decode 工作（loadAsync 是 manager 终态后的第一笔新开销）
    if (this.disposed) {
      throw new Error('[scene-engine] asset manager disposed (loadGltf aborted)')
    }
    const gltf = await loader.loadAsync(url)
    const scene = gltf.scene
    return {
      object: scene,
      // 清单声明的字节数（生成器/资产服务器提供）用于内存预算与诊断。
      estimatedBytes: descriptor.bytes ?? 0,
      dispose: () => {
        disposeObject3D(scene as Disposable3D)
      }
    }
  }

  private async buildGltfLoader(): Promise<GLTFLoaderLike> {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
    const loader = new GLTFLoader() as unknown as GLTFLoaderLike
    // I4-2: 解码器装配在应用层完成（组合根注入）。
    const ownership = await this.options.gltfLoaderEnhancer?.(loader)
    // #12-r3：装配期间 terminal——enhancer 创建的 decoder stack 立即回收，
    // 不写回 cache、不 commit READY（#14 同类 late-result 不变量）
    if (this.disposed) {
      toGltfStackDisposer(ownership)?.()
      throw new Error('[scene-engine] asset manager disposed during loader build')
    }
    this.gltfStackDisposer = toGltfStackDisposer(ownership)
    this.gltfStackDisposed = false
    return loader
  }

  /**
   * #12-r2：loader factory 的 rejection-safe single-flight——
   * CacheEntry 层的重试必须能真正重建 loader，否则一次瞬时的
   * enhancer/动态 import 失败会让当前 manager 内所有后续 GLTF acquire
   * 永久命中同一个 rejected Promise（只有重建 Foundation 才能恢复）。
   *
   * 不变量：
   * 1. 并发 GLTF acquire 共享一次 loader build（single-flight 不变）；
   * 2. build/enhancer reject 后按 promise identity 清除失败 attempt，
   *    不误清后来成功建立的新 loader；
   * 3. 已成功初始化的健康 loader 不因单个资产的 loadAsync 失败被销毁
   *    （asset parse/网络错误 ≠ loader factory 失败）。
   */
  private async getGltfLoader(): Promise<GLTFLoaderLike> {
    let attempt = this.gltfLoader
    if (!attempt) {
      attempt = this.buildGltfLoader()
      this.gltfLoader = attempt
    }
    try {
      const loader = await attempt
      // #12-r3：装配期间 terminal——late READY stack 立即回收，不 commit
      if (this.disposed) {
        this.disposeGltfStackOnce()
        throw new Error('[scene-engine] asset manager disposed during loader build')
      }
      return loader
    } catch (error) {
      if (this.gltfLoader === attempt) {
        this.gltfLoader = undefined
      }
      throw error
    }
  }

  /** #12-r3：decoder-stack exactly-once 回收（manager 是 terminal owner）。 */
  private disposeGltfStackOnce(): void {
    if (this.gltfStackDisposed) return
    this.gltfStackDisposed = true
    this.gltfStackDisposer?.()
    this.gltfStackDisposer = undefined
  }

  /**
   * #12-C：terminal teardown——按 entry identity 原子驱逐：
   * resolved → exactly-once dispose；pending → resolve 后自动回收。
   * 旧失败 continuation 因 identity 不匹配不会误删新 generation entry。
   */
  private evictEntry(key: string, entry: CacheEntry): void {
    if (this.cache.get(key) !== entry) return
    this.cache.delete(key)
    entry.disposed = true
    this.resolvedBytes.delete(key)
    if (entry.loaded) {
      this.disposeLoadedOnce(entry.loaded)
    } else {
      void entry.load
        .then((loaded) => this.disposeLoadedOnce(loaded))
        .catch(() => {})
    }
  }

  private disposeLoadedOnce(loaded: LoadedAsset): void {
    if (this.disposedAssets.has(loaded)) return
    this.disposedAssets.add(loaded)
    loaded.dispose()
  }

  /**
   * #12-C：terminal teardown——真正释放全部 owned 资源：
   * resolved entry 立即 dispose，pending entry resolve 后自动 dispose，
   * resolvedBytes / cache / leaseCount 全部归零；幂等。
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [key, entry] of [...this.cache]) {
      entry.disposed = true
      entry.refCount = 0
      this.resolvedBytes.delete(key)
      if (entry.loaded) {
        this.disposeLoadedOnce(entry.loaded)
      } else {
        void entry.load
          .then((loaded) => this.disposeLoadedOnce(loaded))
          .catch(() => {})
      }
    }
    this.cache.clear()
    // #12-r3：manager 是 GLTF decoder-stack 的 terminal owner——
    // LoadedAsset 之外，worker/blob URL 等 loader 基础设施一并回收
    this.disposeGltfStackOnce()
    this.gltfLoader = undefined
  }
}

/** Deep-dispose a GLB scene graph's GPU resources (Owned by the manager). */
/** 导出供测试与 GLTF 路径复用（不在 public.ts 暴露给 Scene）。 */
export function disposeObject3D(root: Disposable3D): void {
  // #12-D：Geometry/Material/Texture 都可能被共享——统一按 identity 去重，
  // 保证每个 GPU 对象 exactly-once dispose。
  const seen = new WeakSet<object>()
  const disposeOnce = (resource: { dispose(): void }): void => {
    if (seen.has(resource)) return
    seen.add(resource)
    resource.dispose()
  }
  root.traverse?.((obj: unknown) => {
    const mesh = obj as { geometry?: { dispose(): void }; material?: unknown }
    if (mesh.geometry) disposeOnce(mesh.geometry)
    const material = mesh.material as
      | { dispose?(): void }
      | Array<{ dispose?(): void }>
      | undefined
    const materials = Array.isArray(material) ? material : material ? [material] : []
    for (const mat of materials) {
      if (mat.dispose) disposeOnce(mat as { dispose(): void })
      // Material.dispose() 不会释放其引用的 Texture——显式遍历属性槽位
      for (const value of Object.values(mat as Record<string, unknown>)) {
        if (isTextureLike(value)) disposeOnce(value)
      }
    }
  })
}

interface TextureLike {
  isTexture: boolean
  dispose(): void
}

function isTextureLike(value: unknown): value is TextureLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isTexture?: unknown }).isTexture === true &&
    typeof (value as { dispose?: unknown }).dispose === 'function'
  )
}

interface Disposable3D {
  traverse?(cb: (obj: unknown) => void): void
}

/** #12-r3：enhancer 可返回的 decoder-stack 归属凭据。 */
export interface GltfStackDisposable {
  dispose(): void
}

/** #12-r3：函数或 { dispose() } 两种归属凭据统一为 disposer。 */
function toGltfStackDisposer(ownership: unknown): (() => void) | undefined {
  if (!ownership) return undefined
  if (typeof ownership === 'function') return ownership as () => void
  if (typeof (ownership as { dispose?: unknown }).dispose === 'function') {
    return () => (ownership as { dispose(): void }).dispose()
  }
  return undefined
}
