import type { SceneContext, SceneEntry, SceneMount } from '@twin/sdk'
import { reactive } from 'vue'
import { frameLocalToGeodetic } from '@twin/spatial'
import { AGV_CONTRACT, agvEntity, decodeAgv, type AgvState } from '@twin/domain-agv'
import { createNavigationLayout } from './data'
import { mountPanel, type PanelHandle, type PanelState } from './ui/mountPanel'
import type { MapMountHandle } from './map'

/**
 * 行车导航 (Vehicle Navigation) — 2D-ONLY scene.
 *
 * This scene never touches ctx.graphics and never imports three: a
 * standalone build of it contains no 3D runtime at all (Freeze Gate #7).
 */

function resolveSite(ctx: SceneContext) {
  const scope = ctx.world.session.scope
  const sites = ctx.world.sites
  const site =
    (scope.kind === 'site' ? sites.get(scope.siteId) : undefined) ?? sites.list()[0]
  if (!site) throw new Error('[vehicle-navigation] no site configured for this session')
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

    const layout = createNavigationLayout(site, frame)
    const state = reactive<PanelState>({ agvs: {}, selectedKey: undefined })

    // Scene-private Vue UI (§62): local state, scoped CSS, no portal Pinia.
    const uiLayer = ctx.ui.createLayer({ order: 10, className: 'vehicle-navigation-ui' })

    // eslint-disable-next-line prefer-const -- 先声明后异步赋值：闭包在就绪前需可选语义
    let mapHandle: MapMountHandle | undefined


    function lngLatOf(x: number, y: number) {
      const g = frameLocalToGeodetic(frame, { x, y: 0, z: y })
      return { longitudeDegrees: g.longitudeDegrees, latitudeDegrees: g.latitudeDegrees }
    }

    function applySelection(key: string | undefined) {
      state.selectedKey = key
      mapHandle?.setSelected(key)
      ctx.selection.setPrimary(key ? agvEntity(key) : undefined)
    }

    function onSelect(key: string) {
      applySelection(state.selectedKey === key ? undefined : key)
    }

    function onFocus(key: string) {
      const s = state.agvs[key]
      if (!s) return
      const { longitudeDegrees, latitudeDegrees } = lngLatOf(s.xMeters, s.yMeters)
      void ctx.view.setTarget({
        target: {
          longitudeDegrees,
          latitudeDegrees,
          heightMeters: 0,
          verticalReference: 'ellipsoid'
        },
        scaleMeters: 400
      })
    }

    const panel: PanelHandle = mountPanel(uiLayer.element, {
      state,
      routeNames: layout.routes.map((r) => r.name),
      onSelect,
      onFocus
    })

    // 2D representation only — the map engine is the single lazy capability.
    const { mountMap } = await import('./map')
    mapHandle = await mountMap(ctx, layout, {
      onPickAgv: (key) => applySelection(key ?? undefined)
    })

    // Business-state path (§35): AGV telemetry at low Hz drives the 2D view.
    const agvStates = new Map<string, AgvState>()
    const subscription = ctx.data.subscribe({ contract: AGV_CONTRACT }, (env) => {
      const s = decodeAgv(env)
      if (!s) return
      agvStates.set(env.key, s)
      state.agvs[env.key] = s
      mapHandle?.updateAgvs(agvStates)
    })

    // Selection continuity (§57): the one business selection feeds both engines.
    const selectionSub = ctx.selection.onChange((sel) => {
      if (sel.primary?.namespace === 'agv') {
        state.selectedKey = sel.primary.id
        mapHandle?.setSelected(sel.primary.id)
      } else if (!sel.primary) {
        state.selectedKey = undefined
        mapHandle?.setSelected(undefined)
      }
    })

    return {
      unmount() {
        subscription.dispose()
        selectionSub.dispose()
        panel?.unmount()
        uiLayer.dispose()
        void mapHandle?.dispose()
      }
    }
  }
}

export default entry
