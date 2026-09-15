import type { SceneContext, SceneEntry, SceneMount } from '@twin/sdk'
import { SceneViewController } from '@twin/scenes-shared'
import { reactive } from 'vue'
import { frameLocalToGeodetic } from '@twin/spatial'
import { STACK_CONTRACT, decodeStack } from '@twin/domain-logistics'
import { createStackLayout } from './data'
import { mountStackPanel, type StackPanelState } from './ui/mountPanel'
import type { StackMapHandle } from './map'
import type { StackGraphicsHandle } from './graphics'

/**
 * 分段堆场 (Stack Yard) — Architecture Spike A.
 *
 * 2D 核心 + optional 3D。验证：
 * - Map-only cold start（进入场景不加载 three）
 * - 2D → 3D lazy load（首次进入 3D 才下载 graphics chunk）
 * - Selection continuity（2D 选中，切 3D 仍保持）
 * - 3D → 2D（引擎 suspend/resume，Scene 不重挂）
 */

function resolveSite(ctx: SceneContext) {
  const scope = ctx.world.session.scope
  const sites = ctx.world.sites
  const site =
    (scope.kind === 'site' ? sites.get(scope.siteId) : undefined) ?? sites.list()[0]
  if (!site) throw new Error('[stack-yard] no site configured for this session')
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

    const layout = createStackLayout(site, frame)

    const state = reactive<StackPanelState>({
      selectedCode: undefined,
      view: 'map',
      stackStates: Object.fromEntries(layout.cells.map((c) => [c.code, c.status]))
    })

    const uiLayer = ctx.ui.createLayer({ order: 10, className: 'stack-yard-ui' })

    // eslint-disable-next-line prefer-const -- 先声明后异步赋值：闭包在就绪前需可选语义
    let mapHandle: StackMapHandle | undefined
    let graphicsHandle: StackGraphicsHandle | undefined

    // Issue #18-r2：view intent 控制器——joinable single-flight boot +
    // monotonic intent + latest-view commit（含 boot 后按 intent 显式 suspend）
    const view = new SceneViewController({
      prepareGraphics: async () => {
        const { mountGraphics } = await import('./graphics')
        const handle = await mountGraphics(ctx, layout, {
          onPickStack: (code) => applySelection(code ?? undefined)
        })
        if (ctx.signal.aborted) {
          handle.dispose() // #1：unmount 竞态下的迟到引导立即自毁
          graphicsHandle = undefined
          return handle
        }
        graphicsHandle = handle
        return handle
      },
      applyActiveView: (v) => {
        if (v === 'graphics') {
          mapHandle?.suspend()
          ctx.graphics?.currentContext?.resume()
        } else {
          mapHandle?.resume()
          ctx.graphics?.currentContext?.suspend() // §64: 非活跃引擎挂起
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
        console.error('[scene] 3D 初始化失败（已回滚到 2D）', error)
      }
    })


    function applySelection(code: string | undefined) {
      state.selectedCode = code
      mapHandle?.setSelected(code)
      ctx.selection.setPrimary(code ? layout.entityOf(code) : undefined)
    }

    function onSelect(code: string) {
      applySelection(state.selectedCode === code ? undefined : code)
    }

    function onFocus(code: string) {
      const cell = layout.cells.find((c) => c.code === code)
      if (!cell) return
      const g = frameLocalToGeodetic(layout.frame, {
        x: cell.cx,
        y: cell.heightM,
        z: cell.cy
      })
      void ctx.view.setTarget({
        target: {
          longitudeDegrees: g.longitudeDegrees,
          latitudeDegrees: g.latitudeDegrees,
          heightMeters: g.heightMeters,
          verticalReference: 'ellipsoid'
        },
        scaleMeters: 160
      })
    }

    const panel = mountStackPanel(uiLayer.element, {
      cells: layout.cells.map((c) => ({
        code: c.code,
        segment: c.segment,
        weightTonnes: c.weightTonnes,
        status: c.status
      })),
      state,
      onSelect,
      onFocus,
      onSetView: (v) => void view.setView(v)
    })

    // Map-only cold start: the initial view never imports three.
    const { mountMap } = await import('./map')
    mapHandle = await mountMap(ctx, layout, {
      onPickStack: (code) => applySelection(code ?? undefined)
    })

    // Business-state path (§35): stack status updates (low Hz).
    const subscription = ctx.data.subscribe({ contract: STACK_CONTRACT }, (env) => {
      const s = decodeStack(env)
      if (!s) return
      state.stackStates[s.blockCode] = s.status
      mapHandle?.setStatus(s.blockCode, s.status)
    })

    // Selection continuity (§57).
    const selectionSub = ctx.selection.onChange((sel) => {
      if (sel.primary?.namespace === 'yard') {
        state.selectedCode = sel.primary.id
        mapHandle?.setSelected(sel.primary.id)
      } else if (!sel.primary) {
        state.selectedCode = undefined
        mapHandle?.setSelected(undefined)
      }
    })

    return {
      unmount() {
        subscription.dispose()
        selectionSub.dispose()
        panel.unmount()
        uiLayer.dispose()
        void mapHandle?.dispose()
        graphicsHandle?.dispose()
      }
    }
  }
}

export default entry
