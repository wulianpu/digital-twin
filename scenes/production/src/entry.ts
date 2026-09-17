import type { SceneContext, SceneEntry, SceneMount } from '@twin/sdk'
import { SceneViewController } from '@twin/scenes-shared'
import { reactive } from 'vue'
import { CRANE_CONTRACT, craneEntity, decodeCrane, type CraneState } from '@twin/domain-crane'
import { AGV_CONTRACT, decodeAgv, type AgvState } from '@twin/domain-agv'
import {
  PRODUCTION_ALARM_CONTRACT,
  PRODUCTION_TASK_CONTRACT,
  decodeAlarm,
  decodeTask,
  summarize,
  type AlarmState,
  type ProductionTaskState
} from '@twin/domain-production'
import { createProductionLayout } from './data'
import {
  mountProductionPanel,
  type ProductionPanelState
} from './ui/mountPanel'
import type { ProductionMapHandle } from './map'
import type { ProductionGraphicsHandle } from './graphics'

/**
 * 生产数字孪生 (Production Twin) — Architecture Spike B.
 *
 * 验证：World state 单一来源；Split view；高频 Spatial Fast Path
 * （WorldClient → StateBuffer → frame boundary → representation）；
 * Live / History / Simulation 与 Scene/View 正交（§27-28）；长时挂载稳定。
 */

function resolveSite(ctx: SceneContext) {
  const scope = ctx.world.session.scope
  const sites = ctx.world.sites
  const site =
    (scope.kind === 'site' ? sites.get(scope.siteId) : undefined) ?? sites.list()[0]
  if (!site) throw new Error('[production] no site configured for this session')
  return site
}

const entry: SceneEntry = {
  async mount(ctx: SceneContext): Promise<SceneMount> {
    const site = resolveSite(ctx)
    const frame = ctx.spatial.registerEnuFrame(
      `frame:${site.id}`,
      ctx.spatial.toEllipsoidal(site.origin)
      ).frame
    ctx.spatial.setActiveFrame(frame.id)

    const layout = createProductionLayout(site, frame)

    // Reactive proxy created HERE so panel and entry share one reactive
    // identity — mutations through the raw target would never trigger (§62).
    const state = reactive<ProductionPanelState>({
      view: 'map',
      worldMode: ctx.world.session.mode,
      clockLabel: formatClock(ctx.world.time.now().epochMillis),
      kpi: { totalTasks: 0, runningTasks: 0, donePct: 0, openAlarms: 0, criticalAlarms: 0 },
      tasks: [],
      alarms: [],
      selectedCrane: undefined
    })

    const uiLayer = ctx.ui.createLayer({ order: 10, className: 'production-ui' })

    // eslint-disable-next-line prefer-const -- 先声明后异步赋值：闭包在就绪前需可选语义
    let mapHandle: ProductionMapHandle | undefined
    let graphicsHandle: ProductionGraphicsHandle | undefined

    // Issue #18-r4：view intent 控制器——joinable single-flight boot +
    // monotonic intent + latest-view commit（与其它 Catalog Scene 收敛）
    const view = new SceneViewController({
      prepareGraphics: async () => {
        // Lazy: three downloads only on first entry to 3D (§26).
        const { mountGraphics } = await import('./graphics')
        const handle = await mountGraphics(ctx, layout, (key, object) => {
          const [namespace, id] = key.split('/')
          return ctx.graphics!.currentContext!.entities.register({ namespace, id }, object)
        })
        if (ctx.signal.aborted) {
          handle.dispose() // #1：unmount 竞态下的迟到引导立即自毁
          graphicsHandle = undefined
          return handle
        }
        graphicsHandle = handle
        // 重放 boot 间隙积累的 crane 状态（与旧行为一致）
        for (const [code, s] of craneStates) graphicsHandle.applyCraneState(code, s)
        // Issue #23-A：显式 materialize 已有 AGV——不依赖未来新 envelope
        for (const key of agvStates.keys()) graphicsHandle.ensureAgv(key)
        return handle
      },
      applyActiveView: (v) => {
        if (v === 'graphics') {
          mapHandle?.suspend()
          ctx.graphics?.currentContext?.resume()
        } else {
          mapHandle?.resume()
          ctx.graphics?.currentContext?.suspend()
        }
      },
      suspendGraphics: () => ctx.graphics?.currentContext?.suspend(),
      dispatchView: (v) =>
        uiLayer.element.dispatchEvent(
          new CustomEvent('twin-scene-view', { detail: { view: v }, bubbles: true })
        ),
      isAborted: () => ctx.signal.aborted,
      onIntentChanged: (v) => {
        state.view = v
      },
      onRollbackToMap: () => {
        state.view = 'map'
      },
      onGraphicsError: (error) => {
        console.error('[production] 3D 初始化失败（已回滚到 2D）', error)
      }
    })

    const craneStates = new Map<string, CraneState>()
    const agvStates = new Map<string, AgvState>()
    const tasks = new Map<string, ProductionTaskState>()
    const alarms = new Map<string, AlarmState>()

    function refreshKpi(): void {
      state.kpi = summarize([...tasks.values()], [...alarms.values()])
      state.tasks = [...tasks.values()].map((t) => ({
        taskId: t.taskId,
        title: t.title,
        status: t.status,
        progressPct: Math.round(t.progressPct)
      }))
      state.alarms = [...alarms.values()]
        .filter((a) => !a.acknowledged && !ackedAlarms.has(a.alarmId))
        .slice(0, 5)
        .map((a) => ({ alarmId: a.alarmId, severity: a.severity, message: a.message }))
    }

    const panel = mountProductionPanel(uiLayer.element, {
      state,
      onSetView: (v) => void view.setView(v),
      onAckAlarm: acknowledgeAlarm,
      onExport: exportSnapshot
    })

    const { mountMap } = await import('./map')
    mapHandle = await mountMap(ctx, layout, {
      onPick: (key, namespace) => {
        if (!key) {
          ctx.selection.setPrimary(undefined)
          state.selectedCrane = undefined
          return
        }
        if (namespace === 'production') {
          const s = craneStates.get(key)
          if (s) state.selectedCrane = { code: key, state: s }
          ctx.selection.setPrimary(craneEntity(key))
        } else if (namespace === 'agv') {
          ctx.selection.setPrimary({ namespace: 'agv', id: key })
        }
      }
    })

    // Business State Path (§35): crane / task / alarm JSON envelopes.
    const craneSub = ctx.data.subscribe({ contract: CRANE_CONTRACT }, (env) => {
      const s = decodeCrane(env)
      if (!s) return
      craneStates.set(env.key, s)
      mapHandle?.updateCranes(craneStates)
      graphicsHandle?.applyCraneState(env.key, s)
      if (state.selectedCrane?.code === env.key) {
        state.selectedCrane = { code: env.key, state: s }
      }
    })

    // Spatial Fast Path (§35): the gateway mirrors AGV poses into the shared
    // SpatialStateBuffer for 3D (frame-boundary updates). Envelopes here feed
    // the 2D representation at a throttled business rate.
    const agvSub = ctx.data.subscribe({ contract: AGV_CONTRACT }, (env) => {
      const s = decodeAgv(env)
      if (!s) return
      agvStates.set(env.key, s)
      // 数据驱动的表示注册：新 AGV 出现即建 3D 网格（随后由快路径驱动）
      graphicsHandle?.ensureAgv(env.key)
    })
    const mapPushTimer = setInterval(() => {
      mapHandle?.updateAgvs(agvStates)
    }, 500)
    mapPushTimer.unref?.()

    const taskSub = ctx.data.subscribe({ contract: PRODUCTION_TASK_CONTRACT }, (env) => {
      const t = decodeTask(env)
      if (!t || t.siteId !== site.id) return
      tasks.set(t.taskId, t)
      refreshKpi()
    })

    const ackedAlarms = new Set<string>()
    const alarmSub = ctx.data.subscribe({ contract: PRODUCTION_ALARM_CONTRACT }, (env) => {
      const a = decodeAlarm(env)
      if (!a) return
      // 已确认的告警不被数据流 resurrect（演示为客户端记忆；
      // 生产部署经命令通道写入服务端，§81）
      if (ackedAlarms.has(a.alarmId)) return
      alarms.set(a.alarmId, a)
      refreshKpi()
    })
    function acknowledgeAlarm(alarmId: string): void {
      ackedAlarms.add(alarmId)
      refreshKpi()
    }

    // B4: 业务状态快照导出（值班报告）
    function exportSnapshot(): void {
      const snapshot = {
        exportedAt: new Date().toISOString(),
        worldMode: state.worldMode,
        site: site.id,
        kpi: state.kpi,
        tasks: state.tasks,
        alarms: state.alarms,
        cranes: [...craneStates.entries()].map(([code, s]) => ({ code, ...s }))
      }
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `production-snapshot-${Date.now()}.json`
      a.click()
      URL.revokeObjectURL(url)
    }

    // World mode is orthogonal to the scene (§28): reflect it, never remount.
    const sessionSub = ctx.world.onSessionChanged((session) => {
      state.worldMode = session.mode
    })

    const clockTimer = setInterval(() => {
      state.clockLabel = formatClock(ctx.world.time.now().epochMillis)
    }, 1000)
    clockTimer.unref?.()

    return {
      unmount() {
        clearInterval(mapPushTimer)
        clearInterval(clockTimer)
        craneSub.dispose()
        agvSub.dispose()
        taskSub.dispose()
        alarmSub.dispose()
        sessionSub.dispose()
        panel.unmount()
        uiLayer.dispose()
        void mapHandle?.dispose()
        graphicsHandle?.dispose()
      }
    }
  }
}

function formatClock(epochMillis: number): string {
  const d = new Date(epochMillis)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export default entry
