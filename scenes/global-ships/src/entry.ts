import { SceneViewController } from '@twin/scenes-shared'
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

    // Issue #18-r2：view intent 控制器——joinable single-flight boot +
    // monotonic intent + latest-view commit（含 boot 后按 intent 显式 suspend）
    const view = new SceneViewController({
      prepareGraphics: async () => {
        const { mountGraphics } = await import('./graphics')
        const handle = await mountGraphics(ctx)
        if (ctx.signal.aborted) {
          handle.dispose() // #1：unmount 竞态下的迟到引导立即自毁
          graphicsHandle = undefined
          return handle
        }
        graphicsHandle = handle
        graphicsHandle.updateShips(states)
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
        console.error('[global-ships] 3D 初始化失败（已回滚到 2D）', error)
      }
    })

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
      onSetView: (v) => void view.setView(v)
    })

    const { mountMap } = await import('./map')
    mapHandle = await mountMap(ctx, tracks, {
      onPickShip: (key) => applySelection(key ?? undefined)
    })

    // AIS business-state stream (1 Hz from the gateway).
    const subscription = ctx.data.subscribe({ contract: VESSEL_CONTRACT }, (env) => {
      // Issue #27：tombstone——实体离场，撤销本地 state/track/selection
      if (env.op === 'delete') {
        states.delete(env.key)
        tracks.drop(env.key)
        if (state.selectedKey === env.key) {
          state.selectedKey = undefined
          mapHandle?.setSelected(undefined)
          mapHandle?.setTrack(undefined)
          ctx.selection.setPrimary(undefined)
        }
        return
      }
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
