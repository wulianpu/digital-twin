import { createApp, defineComponent, h, onUnmounted, reactive } from 'vue'
import ShipsPanel from './ShipsPanel.vue'

export interface ShipRow {
  key: string
  name: string
  type: string
  sogKnots: number
  headingDegrees: number
}

export interface ShipsPanelState {
  selectedKey: string | undefined
  view: 'map' | 'graphics'
}

export interface ShipsPanelBindings {
  getShips(): ShipRow[]
  state: ShipsPanelState
  onSelect(key: string): void
  onFocus(key: string): void
  onSetView(view: 'map' | 'graphics'): void
  refreshIntervalMs?: number
}

export interface ShipsPanelHandle {
  unmount(): void
}

export function mountShipsPanel(
  element: HTMLElement,
  bindings: ShipsPanelBindings
): ShipsPanelHandle {
  const state = reactive(bindings.state)
  const listHolder = reactive<{ list: ShipRow[] }>({ list: [] })

  const Host = defineComponent({
    setup() {
      const timer = setInterval(() => {
        listHolder.list = bindings.getShips()
      }, bindings.refreshIntervalMs ?? 2000)
      timer.unref?.()
      // Vue effect hygiene (§62): the interval dies with the component.
      onUnmounted(() => clearInterval(timer))
      return () =>
        h(ShipsPanel, {
          ships: listHolder.list,
          selectedKey: state.selectedKey,
          view: state.view,
          onSelect: bindings.onSelect,
          onFocus: bindings.onFocus,
          onSetView: bindings.onSetView
        })
    }
  })

  const app = createApp(Host)
  app.mount(element)
  return { unmount: () => app.unmount() }
}
