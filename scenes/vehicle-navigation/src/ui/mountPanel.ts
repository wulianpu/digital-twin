import { createApp, defineComponent, h, reactive, type Component } from 'vue'
import NavigationPanel from './NavigationPanel.vue'
import type { AgvState } from '@twin/domain-agv'

export interface PanelState {
  agvs: Record<string, AgvState>
  selectedKey: string | undefined
}

export interface PanelBindings {
  state: PanelState
  routeNames: readonly string[]
  onSelect(key: string): void
  onFocus(key: string): void
}

export interface PanelHandle {
  unmount(): void
}

/** Scene-private Vue UI (§62): local reactive state, scoped styles, no Pinia. */
export function mountPanel(element: HTMLElement, bindings: PanelBindings): PanelHandle {
  const reactiveState = reactive(bindings.state)

  const Host = defineComponent({
    setup() {
      return () =>
        h(NavigationPanel as Component, {
          agvs: Object.entries(reactiveState.agvs).map(([key, s]) => ({
            key,
            speedMs: s.speedMs,
            batteryPct: s.batteryPct,
            taskId: s.taskId
          })),
          selectedKey: reactiveState.selectedKey,
          routeNames: bindings.routeNames,
          onSelect: (key: string) => bindings.onSelect(key),
          onFocus: (key: string) => bindings.onFocus(key)
        })
    }
  })

  const app = createApp(Host)
  app.mount(element)
  return {
    unmount: () => app.unmount()
  }
}
