import type { MapAccess, MapContext, MapEngineOptions, MapEngineState } from './types'
import { buildDefaultStyle } from './style'

type MLMap = import('maplibre-gl').Map

function ensureWebGL2(): void {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2')
  if (!gl) {
    throw new Error(
      '[map-engine] WebGL2 is required by MapLibre GL JS v6 (production baseline, §2.2). ' +
        'This browser/环境不支持 WebGL2。'
    )
  }
}

/**
 * MapAccess implementation: engine boots lazily on first use() (§16, §25).
 * `maplibre-gl` is reached through dynamic import so 3D-only builds never
 * download it and the 2D code path stays chunked.
 */
export function createMapAccess(options: MapEngineOptions): MapAccess {
  let state: MapEngineState = 'UNINITIALIZED'
  let disposed = false
  // Issue #14：lazy boot 状态机闭环——attempt identity（generation）+
  // terminal monotonicity（DISPOSED 永不复活）+ 失败可重试。
  let generation = 0
  let instance: MLMap | undefined
  let context: MapContextImpl | undefined
  let bootAttempt: { generation: number; promise: Promise<MapContext> } | undefined
  /** 中止当前 boot 的挂起等待（dispose 竞态时立即 reject，不拖到 15s 兜底）。 */
  let abortCurrentBoot: ((error: Error) => void) | undefined

  function abortedError(): Error {
    return new Error('[map-engine] boot attempt aborted (access disposed)')
  }

  const access: MapAccess = {
    get state() {
      return state
    },
    get currentContext() {
      if (disposed) return undefined // 终态不变量：dispose 后永久 undefined
      return context ?? undefined
    },
    use() {
      if (disposed) {
        return Promise.reject(new Error('[map-engine] access disposed'))
      }
      // 同 generation 内并发 use() 共享同一次 boot attempt
      if (bootAttempt && bootAttempt.generation === generation) {
        return bootAttempt.promise
      }
      const attempt = ++generation
      const promise = boot(attempt)
      bootAttempt = { generation: attempt, promise }
      return promise
    },
    dispose() {
      if (disposed) return
      disposed = true
      generation++ // 使所有 pending attempt 失去 commit authority
      abortCurrentBoot?.(abortedError())
      context?.dispose()
      context = undefined
      instance = undefined
      bootAttempt = undefined
      state = 'DISPOSED'
    }
  }

  async function boot(attempt: number): Promise<MapContext> {
    let localMap: MLMap | undefined
    try {
      const el = options.getViewport()
      if (!el) throw new Error('[map-engine] map viewport container is unavailable')
      ensureWebGL2()

      // Lazy: first use() pulls MapLibre + its CSS.
      const [maplibregl, css] = await Promise.all([
        import('maplibre-gl'),
        import('maplibre-gl/dist/maplibre-gl.css')
      ])
      void css
      if (attempt !== generation || disposed) throw abortedError()

      const style = options.styleUrl
        ? options.styleUrl
        : (buildDefaultStyle({
            rasterTilesUrl: options.rasterTilesUrl,
            attribution: options.attribution,
            initialCenter: options.initialCenter,
            initialZoom: options.initialZoom
          }) as import('maplibre-gl').StyleSpecification)

      localMap = new maplibregl.Map({
        container: el,
        style,
        center: options.initialCenter
          ? [options.initialCenter.longitudeDegrees, options.initialCenter.latitudeDegrees]
          : undefined,
        zoom: options.initialZoom,
        attributionControl: options.attribution ? {} : false,
        doubleClickZoom: true,
        dragRotate: true
      })
      // #14-B：destructive 副作用（DOM canvas 挂载）之后必须重校验——
      // attempt 已 stale 时立即销毁迟到的 Map，绝不复活 DISPOSED access。
      if (attempt !== generation || disposed) {
        localMap.remove()
        localMap = undefined
        throw abortedError()
      }
      instance = localMap

      state = 'ACTIVE'
      context = new MapContextImpl(instance, el, () => {
        state = 'SUSPENDED'
      }, () => {
        state = 'ACTIVE'
      })

      // §52 生命周期：把「style 已就绪」作为 MapContext 交付条件之一。
      // 否则 reload 直连场景时，Scene 的首个 addSource 会与 style 异步加载
      // 竞态（"Style is not done loading"）——该时序属于引擎职责，不留给 Scene。
      const map = instance
      await new Promise<void>((resolve, reject) => {
        if (map.isStyleLoaded()) return resolve()
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true
          clearTimeout(guard)
          resolve()
        }
        // 兜底：远程 style/glyphs 异常时不无限挂起（Scene 随后自行处理失败）。
        const guard = setTimeout(finish, 15_000)
        guard.unref?.()
        map.once('load', finish)
        map.once('error', finish)
        // #14：dispose 竞态立即中止等待（不拖到 15s 兜底）
        abortCurrentBoot = (error) => {
          if (settled) return
          settled = true
          clearTimeout(guard)
          reject(error)
        }
      })
      if (attempt !== generation || disposed) throw abortedError()

      return context
    } catch (error) {
      // #14-C：reject 只清理属于本 attempt 的 pending slot（identity 比较），
      // 不会误清后来 generation 的新 attempt；未 dispose 时回到可重试状态。
      if (bootAttempt && bootAttempt.generation === attempt) {
        bootAttempt = undefined
      }
      if (localMap) {
        try {
          localMap.remove()
        } catch {
          /* 已被 dispose 路径移除 */
        }
        if (instance === localMap) instance = undefined
      }
      if (!disposed && state !== 'DISPOSED') state = 'UNINITIALIZED'
      throw error
    }
  }

  return access
}

class MapContextImpl implements MapContext {
  private readonly styleIssueLog: string[] = []

  constructor(
    private readonly map: MLMap,
    readonly container: HTMLElement,
    private readonly onSuspend: () => void,
    private readonly onResume: () => void
  ) {
    // S2：底图/style 异常捕获（glyphs 不可达时文字标注降级，此处可见化）。
    this.map.on('error', (e: import('maplibre-gl').ErrorEvent) => {
      const message = String(e?.error?.message ?? '')
      if (/glyph|style|sprite/i.test(message)) {
        this.styleIssueLog.push(message.slice(0, 200))
        if (this.styleIssueLog.length > 10) this.styleIssueLog.shift()
      }
    })
  }

  get instance(): MLMap {
    return this.map
  }

  styleIssues(): readonly string[] {
    return this.styleIssueLog
  }

  suspend(): void {
    this.map.stop()
    this.onSuspend()
  }

  resume(): void {
    this.map.resize()
    this.onResume()
  }

  resize(): void {
    this.map.resize()
  }

  getViewState() {
    const c = this.map.getCenter()
    return {
      center: {
        longitudeDegrees: c.lng,
        latitudeDegrees: c.lat,
        heightMeters: 0,
        verticalReference: 'ellipsoid' as const
      },
      zoom: this.map.getZoom(),
      bearingRadians: (this.map.getBearing() * Math.PI) / 180,
      pitchRadians: (this.map.getPitch() * Math.PI) / 180
    }
  }

  dispose(): void {
    this.map.remove()
  }}
