import type * as THREE from 'three'
import type { TilesDiagnostics, TilesPolicy } from './types'

/** Minimal structural type of the 3DTilesRendererJS renderer we rely on. */
export interface TilesRendererLike {
  group: THREE.Group
  setCamera(camera: THREE.Camera): void
  setResolution(width: number, height: number): void
  update(): void
  dispose(): void
  errorTarget?: number
  lruCache?: {
    maxBytesSize?: number
    maxItemSize?: number
    minSize?: number
    cachedBytes?: number
    cachedItems?: number
    isFull?: boolean
    unloadPercent?: number
  }
  downloadQueue?: { size?: number }
  parseQueue?: { size?: number }
  stats?: {
    downloaded?: number
    parsed?: number
    failed?: number
    inFrustum?: number
    visible?: number
  }
}

export type TilesRendererFactory = (url: string) => Promise<TilesRendererLike>

export interface TilesetHandle {
  readonly url: string
  readonly group: THREE.Group
  remove(): void
}

const EMPTY_DIAGNOSTICS: TilesDiagnostics = {
  cachedBytes: 0,
  maxBytes: 0,
  isFull: false,
  loadProgress: 1,
  queued: 0,
  downloading: 0,
  parsing: 0,
  loaded: 0,
  visible: 0,
  active: 0,
  failed: 0
}

/**
 * TilesSystem (§48): the ONLY place a TilesRenderer is created (§48 forbids
 * scenes from `new TilesRenderer(...)`). Owns the GlobalTileCache policy
 * (§49): explicit byte/item budget shared by every tileset of this engine.
 */
interface TilesetEntry {
  renderer: TilesRendererLike
  group: THREE.Group
  /** Issue #25：registration identity——remove() 按 token compare-and-delete。 */
  token: object
}

/**
 * TilesSystem (§48): the ONLY place a TilesRenderer is created (§48 forbids
 * scenes from `new TilesRenderer(...)`). Owns the GlobalTileCache policy
 * (§49): explicit byte/item budget shared by every tileset of this engine.
 *
 * Issue #25：terminal disposed state + pending identity——
 * - dispose() 后 addTileset fail-fast，pending 创建的 late renderer
 *   exactly-once 回收，不重新注册/挂载；
 * - 同 URL（含 in-flight）重复 add 一律 fail-fast；
 * - remove() 按 token compare-and-delete，stale handle 不误删后来者。
 */
export class TilesSystem {
  private readonly tilesets = new Map<string, TilesetEntry>()
  private readonly pending = new Set<string>()
  private readonly tokens = new Map<string, object>()
  private sharedCache: TilesRendererLike['lruCache'] | undefined
  private disposed = false

  constructor(
    private readonly policy: TilesPolicy = {},
    private readonly factory: TilesRendererFactory = defaultFactory
  ) {}

  /** 终态只读量（runtime fire-and-forget continuation 的守卫依据）。 */
  get isDisposed(): boolean {
    return this.disposed
  }

  async addTileset(
    url: string,
    configure?: (renderer: TilesRendererLike, group: THREE.Group) => void
  ): Promise<TilesetHandle> {
    if (this.disposed) {
      throw new Error('[scene-engine] TilesSystem disposed (Issue #25 terminal state)')
    }
    // Issue #25-B：duplicate check 覆盖 in-flight add
    if (this.tilesets.has(url) || this.pending.has(url)) {
      throw new Error(`[scene-engine] tileset already registered: ${url}`)
    }
    this.pending.add(url)
    let renderer: TilesRendererLike
    try {
      renderer = await this.factory(url)
    } finally {
      this.pending.delete(url)
    }
    if (this.disposed) {
      // #25-A：late renderer 在 terminal teardown 后 exactly-once 回收
      renderer.dispose()
      throw new Error('[scene-engine] TilesSystem disposed during tileset load')
    }
    if (this.tilesets.has(url)) {
      renderer.dispose()
      throw new Error(`[scene-engine] tileset already registered: ${url}`)
    }
    // Explicit cache policy (§49, Appendix A): never rely on defaults.
    if (renderer.lruCache) {
      if (this.sharedCache === undefined) this.sharedCache = renderer.lruCache
      else renderer.lruCache = this.sharedCache
      if (this.policy.maxBytes !== undefined) {
        renderer.lruCache.maxBytesSize = this.policy.maxBytes
      }
      if (this.policy.maxItems !== undefined) {
        renderer.lruCache.maxItemSize = this.policy.maxItems
      }
      renderer.lruCache.minSize = 0
    }
    if (this.policy.sseMultiplier !== undefined && renderer.errorTarget !== undefined) {
      renderer.errorTarget = this.policy.sseMultiplier
    }
    const group = renderer.group
    const token = {}
    this.tilesets.set(url, { renderer, group, token })
    this.tokens.set(url, token)
    configure?.(renderer, group)
    let removed = false
    return {
      url,
      group,
      remove: () => {
        if (removed) return
        removed = true
        this.removeTileset(url, token)
      }
    }
  }

  /** Issue #25-C：compare-by-token——stale handle 不误删后来 owner 的 entry。 */
  private removeTileset(url: string, token: object): void {
    const entry = this.tilesets.get(url)
    if (!entry || entry.token !== token) return
    this.tilesets.delete(url)
    this.tokens.delete(url)
    entry.group.removeFromParent()
    entry.renderer.dispose()
  }

  has(url: string): boolean {
    return this.tilesets.has(url)
  }

  /** Issue #25-C：按 token 的 compare-and-delete（runtime terminal 兜底用）。 */
  removeTilesetByToken(url: string, token: object): void {
    this.removeTileset(url, token)
  }

  frame(camera: THREE.Camera, width: number, height: number): void {
    for (const { renderer } of this.tilesets.values()) {
      renderer.setCamera(camera)
      renderer.setResolution(width, height)
      renderer.update()
    }
  }

  get tilesetCount(): number {
    return this.tilesets.size
  }

  diagnostics(): TilesDiagnostics {
    let diag = EMPTY_DIAGNOSTICS
    for (const { renderer } of this.tilesets.values()) {
      const cache = renderer.lruCache
      const stats = renderer.stats
      diag = {
        cachedBytes: Math.max(diag.cachedBytes, cache?.cachedBytes ?? 0),
        maxBytes: Math.max(diag.maxBytes, cache?.maxBytesSize ?? this.policy.maxBytes ?? 0),
        isFull: diag.isFull || cache?.isFull === true,
        loadProgress: Math.min(diag.loadProgress, loadProgressOf(renderer)),
        queued: diag.queued + (renderer.downloadQueue?.size ?? 0),
        downloading: diag.downloading + (renderer.downloadQueue?.size ?? 0),
        parsing: diag.parsing + (renderer.parseQueue?.size ?? 0),
        loaded: diag.loaded + (stats?.downloaded ?? 0),
        visible: diag.visible + (stats?.visible ?? 0),
        active: diag.active + (stats?.inFrustum ?? 0),
        failed: diag.failed + (stats?.failed ?? 0)
      }
    }
    return diag
  }

  dispose(): void {
    this.disposed = true
    for (const { renderer, group } of [...this.tilesets.values()]) {
      group.removeFromParent()
      renderer.dispose()
    }
    this.tilesets.clear()
    this.sharedCache = undefined
  }
}

function loadProgressOf(renderer: TilesRendererLike): number {
  const err = renderer.stats?.failed ?? 0
  const done = (renderer.stats?.downloaded ?? 0) + err
  const queued = renderer.downloadQueue?.size ?? 0
  const total = done + queued
  return total === 0 ? 1 : done / total
}

/** Default factory: 3DTilesRendererJS is reached ONLY here (§48). */
const defaultFactory: TilesRendererFactory = async (url) => {
  const { TilesRenderer } = await import('3d-tiles-renderer')
  const renderer = new TilesRenderer(url) as unknown as TilesRendererLike
  // The group must live in the BaseWorldRoot; the caller parents it.
  return renderer
}
