import type { SceneContext, SceneEntry, SceneMount } from '@twin/sdk'
import { frameLocalToGeodetic } from '@twin/spatial'
import { pointAlongRoute, type Vec2 } from '@twin/domain-agv'
import { assessRouteRisk } from '@twin/domain-logistics'
import { createTransportPlan } from './data'
import { createApp, defineComponent, h, reactive, type Component } from 'vue'
import TransportPanel from './ui/TransportPanel.vue'
import type { TransportMapHandle } from './map'
import type { TransportGraphicsHandle } from './graphics'

/**
 * 大件运输 / 吊装 (Heavy Transport) — Architecture Spike C.
 *
 * 验证：Site 局部坐标系内的运动学（frame-local route math）、
 * 视觉/碰撞资产分离、Scene 私有仿真预演（§28 — 不创建 Simulation World）、
 * Map 路径规划 + 3D 风险检查组合。
 */

function resolveSite(ctx: SceneContext) {
  const scope = ctx.world.session.scope
  const sites = ctx.world.sites
  const site =
    (scope.kind === 'site' ? sites.get(scope.siteId) : undefined) ?? sites.list()[0]
  if (!site) throw new Error('[heavy-transport] no site configured for this session')
  return site
}

interface TransportState {
  view: 'map' | 'graphics'
  progressMeters: number
  speedMs: number
  playing: boolean
  riskViolating: boolean
  zoneLabel: string | undefined
  clearanceMeters: number
}

const entry: SceneEntry = {
  async mount(ctx: SceneContext): Promise<SceneMount> {
    const site = resolveSite(ctx)
    const frame = ctx.spatial.registerEnuFrame(
      `frame:${site.id}`,
      ctx.spatial.toEllipsoidal(site.origin)
      ).frame
    ctx.spatial.setActiveFrame(frame.id)

    const plan = createTransportPlan(site, frame)
    // 热路径进度值保持在 reactive 之外（§65）：每帧写 reactive 会强制
    // Vue 逐帧重渲；UI 以 10Hz 从该值同步。
    let progressMeters = 0
    let uiAccumulator = 0
    const state = reactive<TransportState>({
      view: 'map',
      progressMeters: 0,
      speedMs: 6,
      playing: true,
      riskViolating: false,
      zoneLabel: undefined,
      clearanceMeters: Number.POSITIVE_INFINITY
    })

    const uiLayer = ctx.ui.createLayer({ order: 10, className: 'heavy-transport-ui' })

    // eslint-disable-next-line prefer-const -- 先声明后异步赋值：闭包在就绪前需可选语义
    let mapHandle: TransportMapHandle | undefined
    let graphicsHandle: TransportGraphicsHandle | undefined
    let graphicsBooting = false
    let lastFrameMs = 0

    function poseAt(meters: number): { point: Vec2; headingDeg: number } {
      return pointAlongRoute(plan.route, meters)
    }

    function applyGraphicsPose(): void {
      // 每帧：仅非 reactive 的表示层更新（3D 平滑运动）
      const { point, headingDeg } = poseAt(progressMeters)
      graphicsHandle?.setTrolleyPose({ x: point.x, y: point.y, headingDeg })
    }

    function applyPose(): void {
      // 10Hz：reactive UI 同步 + 2D marker + 风险评估
      applyGraphicsPose()
      const { point } = poseAt(progressMeters)
      mapHandle?.updateTrolley(point)
      const risk = assessRouteRisk(point, plan.zones)
      state.riskViolating = risk.violating
      state.zoneLabel = plan.zones.find((z) => z.id === risk.zoneId)?.label
      state.clearanceMeters = Number.isFinite(risk.clearanceMeters)
        ? risk.clearanceMeters
        : 0
      mapHandle?.setRisk(risk.violating)
      graphicsHandle?.setRiskHighlight(risk.violating)
    }

    function focusTrolley(): void {
      const { point } = poseAt(progressMeters)
      const g = frameLocalToGeodetic(frame, { x: point.x, y: 0, z: point.y })
      void ctx.view.setTarget({
        target: {
          longitudeDegrees: g.longitudeDegrees,
          latitudeDegrees: g.latitudeDegrees,
          heightMeters: 0,
          verticalReference: 'ellipsoid'
        },
        scaleMeters: 120
      })
    }

    const Host = defineComponent({
      setup() {
        return () =>
          h(TransportPanel as Component, {
            view: state.view,
            progressMeters: state.progressMeters,
            totalMeters: plan.routeLengthMeters,
            speedMs: state.speedMs,
            riskViolating: state.riskViolating,
            zoneLabel: state.zoneLabel,
            riskLabel: `最近限制区净距 ${Math.round(Math.max(0, state.clearanceMeters))} m`,
            playing: state.playing,
            onSetView: (view: 'map' | 'graphics') => void setView(view),
            onSetProgress: (meters: number) => {
              progressMeters = meters
              state.progressMeters = meters
              applyPose()
            },
            onSetSpeed: (speedMs: number) => {
              state.speedMs = speedMs
            },
            onTogglePlay: () => {
              state.playing = !state.playing
            }
          })
      }
    })

    async function setView(view: 'map' | 'graphics'): Promise<void> {
      if (state.view === view) return
      state.view = view
      if (view === 'graphics') {
        if (!graphicsHandle && !graphicsBooting) {
          graphicsBooting = true
          try {
            const { mountGraphics } = await import('./graphics')
            graphicsHandle = await mountGraphics(ctx, plan)
            graphicsBooting = false
            if (ctx.signal.aborted) {
              graphicsHandle.dispose()
              graphicsHandle = undefined
              return
            }
          } catch (error) {
            // Issue #17-r2：unmount 竞态下的 SceneUnmountedError 静默放弃
            //（Host 已兜底回收），booting 标志必须复位以免永久卡死；
            // 真实失败（非 teardown）仍上抛给 UI。
            graphicsBooting = false
            if (!ctx.signal.aborted) throw error
            return
          }
          // Scene-private preview loop (§28) — the engine's frame loop is
          // the ONLY animation entry (§21); progress is scene state.
          ctx.graphics!.currentContext!.onFrame(({ deltaSeconds, elapsedSeconds }) => {
            if (state.playing && !graphicsBooting) {
              // 热路径（§65）：位姿逐帧、非 reactive；UI/2D/风险按 10Hz 节流
              progressMeters =
                (progressMeters + deltaSeconds * state.speedMs) %
                plan.routeLengthMeters
              applyGraphicsPose()
              uiAccumulator += deltaSeconds
              if (uiAccumulator >= 0.1) {
                uiAccumulator = 0
                state.progressMeters = progressMeters
                lastFrameMs = elapsedSeconds
                applyPose()
              }
            }
          })
          void lastFrameMs
        }
        mapHandle?.suspend()
        ctx.graphics?.currentContext?.resume()
        focusTrolley()
      } else {
        mapHandle?.resume()
        ctx.graphics?.currentContext?.suspend() // §64: 非活跃引擎挂起
      }
      uiLayer.element.dispatchEvent(
        new CustomEvent('twin-scene-view', { detail: { view }, bubbles: true })
      )
    }

    const app = createApp(Host)
    app.mount(uiLayer.element)

    const { mountMap } = await import('./map')
    mapHandle = await mountMap(ctx, plan)

    progressMeters = 0
    applyPose()

    return {
      unmount() {
        app.unmount()
        uiLayer.dispose()
        void mapHandle?.dispose()
        graphicsHandle?.dispose()
      }
    }
  }
}

export default entry
