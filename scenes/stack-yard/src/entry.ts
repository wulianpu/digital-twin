import type { SceneContext, SceneEntry, SceneMount } from '@twin/sdk'
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
    let graphicsBooting = false

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

    async function setView(view: 'map' | 'graphics'): Promise<void> {
      if (state.view === view) return
      state.view = view
      if (view === 'graphics') {
        if (!graphicsHandle && !graphicsBooting) {
          graphicsBooting = true
          try {
            // Lazy: three + graphics chunk download HERE, on demand (§26).
            const { mountGraphics } = await import('./graphics')
            graphicsHandle = await mountGraphics(ctx, layout, {
              onPickStack: (code) => applySelection(code ?? undefined)
            })
            // 问题6：late bootstrap——unmount 后完成的异步引导立即自毁
            if (ctx.signal.aborted) {
              graphicsHandle.dispose()
              graphicsHandle = undefined
              graphicsBooting = false
              return
            }
          } catch (error) {
            graphicsBooting = false
            if (!ctx.signal.aborted) throw error
            return
          }
          graphicsBooting = false
        }
        mapHandle?.suspend()
        ctx.graphics?.currentContext?.resume()
      } else {
        mapHandle?.resume()
        ctx.graphics?.currentContext?.suspend() // §64: 非活跃引擎挂起
      }
      // S1: 通知宿主应用当前视图意图（DOM 事件，场景保持应用无关）
      uiLayer.element.dispatchEvent(
        new CustomEvent('twin-scene-view', { detail: { view }, bubbles: true })
      )
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
      onSetView: (view) => void setView(view)
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
