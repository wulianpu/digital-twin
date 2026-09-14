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

    async function setView(view: 'map' | 'graphics'): Promise<void> {
      if (state.view === view) return
      state.view = view
      if (view === 'graphics') {
        if (!graphicsHandle && !graphicsBooting) {
          graphicsBooting = true
          const { mountGraphics } = await import('./graphics')
          graphicsHandle = await mountGraphics(ctx, {
            register: (entity, object) => ctx.graphics!.currentContext!.entities.register(entity, object)
          })
          graphicsBooting = false
          if (ctx.signal.aborted) {
            graphicsHandle.dispose()
            graphicsHandle = undefined
            return
          }
          graphicsHandle.updateShips(states)
        }
        mapHandle?.suspend()
        ctx.graphics?.currentContext?.resume()
      } else {
        mapHandle?.resume()
        ctx.graphics?.currentContext?.suspend()
      }
      uiLayer.element.dispatchEvent(
        new CustomEvent('twin-scene-view', { detail: { view }, bubbles: true })
      )
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
