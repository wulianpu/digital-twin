import type { SceneContext, SceneEntry, SceneMount } from '@twin/sdk'
import { reactive } from 'vue'
import {
  VESSEL_CONTRACT,
  decodeVessel,
  vesselEntity,
  VesselTrackRegistry,
  type VesselState
} from '@twin/domain-vessel'
import { mountShipsPanel, type ShipsPanelState } from './ui/mountPanel'
import type { ShipsMapHandle } from './map'

/**
 * 全球船舶 (Global Ships) — world-scale 2D situation + optional 3D globe.
 * Demonstrates global scope: no site frame, WGS84 straight to the map, and
 * ECEF camera-relative rendering when entering the globe view.
 */

const entry: SceneEntry = {
  async mount(ctx: SceneContext): Promise<SceneMount> {
    // Global scope: this scene does not activate a site frame.
    const states = new Map<string, VesselState>()
    const tracks = new VesselTrackRegistry()

    const state = reactive<ShipsPanelState>({ selectedKey: undefined, view: 'map' })
    const uiLayer = ctx.ui.createLayer({ order: 10, className: 'global-ships-ui' })

    // eslint-disable-next-line prefer-const -- 先声明后异步赋值：闭包在就绪前需可选语义
    let mapHandle: ShipsMapHandle | undefined
    let graphicsHandle: { updateShips(states: ReadonlyMap<string, VesselState>): void; dispose(): void } | undefined
    let graphicsBooting = false

    function applySelection(key: string | undefined) {
      state.selectedKey = key
      mapHandle?.setSelected(key)
      ctx.selection.setPrimary(key ? vesselEntity(key) : undefined)
      mapHandle?.setTrack(
        key ? (tracks.trackFor(key).toLineCoordinates() as Array<[number, number]>) : undefined
      )
    }

    function onSelect(key: string) {
      applySelection(state.selectedKey === key ? undefined : key)
    }

    function onFocus(key: string) {
      const s = states.get(key)
      if (!s) return
      void ctx.view.setTarget({
        target: {
          longitudeDegrees: s.longitudeDegrees,
          latitudeDegrees: s.latitudeDegrees,
          heightMeters: 0,
          verticalReference: 'ellipsoid'
        },
        scaleMeters: 20_000
      })
    }

    function pushUpdates() {
      mapHandle?.updateShips(states)
      graphicsHandle?.updateShips(states)
      if (state.selectedKey) {
        mapHandle?.setTrack(
          tracks.trackFor(state.selectedKey).toLineCoordinates() as Array<[number, number]>
        )
      }
    }

    const panel = mountShipsPanel(uiLayer.element, {
      state,
      getShips: () =>
        [...states.entries()].map(([key, s]) => ({
          key,
          name: s.name ?? key,
          type: s.shipType ?? 'other',
          sogKnots: s.sogKnots,
          headingDegrees: s.headingDegrees
        })),
      onSelect,
      onFocus,
      onSetView: (view) => void setView(view)
    })

    // Issue #18：view intent generation——Last Intent Wins。ctx.signal 只表达
    // SceneMount lifetime；view intent 自己持有 monotonic generation，跨 await
    // 的 continuation 提交任何 suspend/resume/事件副作用前必须通过 isCurrent。
    let viewIntent = 0
    let desiredView: 'map' | 'graphics' = 'map'
    let lastDispatchedView: 'map' | 'graphics' | undefined

    function commitView(): void {
      if (desiredView === 'graphics' && graphicsBooting) {
        return // boot 完成路径会再次提交
      }
      if (desiredView === 'graphics') {
        mapHandle?.suspend()
        ctx.graphics?.currentContext?.resume()
      } else {
        mapHandle?.resume()
        ctx.graphics?.currentContext?.suspend()
      }
      if (lastDispatchedView !== desiredView) {
        lastDispatchedView = desiredView
        uiLayer.element.dispatchEvent(
          new CustomEvent('twin-scene-view', { detail: { view: desiredView }, bubbles: true })
        )
      }
    }

    async function setView(view: 'map' | 'graphics'): Promise<void> {
      if (state.view === view && !graphicsBooting) return
      const generation = ++viewIntent
      desiredView = view
      state.view = view
      const isCurrent = (): boolean =>
        viewIntent === generation && !ctx.signal.aborted

      if (view === 'graphics' && !graphicsHandle && !graphicsBooting) {
        graphicsBooting = true
        try {
          const { mountGraphics } = await import('./graphics')
          graphicsHandle = await mountGraphics(ctx)
          graphicsBooting = false
          if (ctx.signal.aborted) {
            graphicsHandle.dispose()
            graphicsHandle = undefined
            return
          }
          graphicsHandle.updateShips(states)
        } catch (error) {
          graphicsBooting = false
          // 仅当前 intent 的失败才向 UI 上抛（可重试）；stale intent 的失败
          // 不得覆盖最新视图状态
          if (isCurrent()) throw error
          return
        }
      }

      // commit gate：await 之后只有最新 intent 才能提交；boot 完成时按最新
      // intent 补提交（G1 stale → G3 graphics 的场景由这里恢复）
      if (isCurrent() || (desiredView === 'graphics' && !graphicsBooting)) {
        commitView()
      }
    }

    const { mountMap } = await import('./map')
    mapHandle = await mountMap(ctx, tracks, {
      onPickShip: (key) => applySelection(key ?? undefined)
    })

    // AIS business-state stream (1 Hz from the gateway).
    const subscription = ctx.data.subscribe({ contract: VESSEL_CONTRACT }, (env) => {
      const s = decodeVessel(env)
      if (!s) return
      states.set(env.key, s)
      tracks.trackFor(env.key).push(env.sourceTime, s)
      pushUpdates()
    })

    const selectionSub = ctx.selection.onChange((sel) => {
      if (sel.primary?.namespace === 'ais') {
        state.selectedKey = sel.primary.id
        mapHandle?.setSelected(sel.primary.id)
      } else if (!sel.primary) {
        state.selectedKey = undefined
        mapHandle?.setSelected(undefined)
        mapHandle?.setTrack(undefined)
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
