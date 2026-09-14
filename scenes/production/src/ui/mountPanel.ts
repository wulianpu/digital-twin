import { createApp, defineComponent, h, reactive, type Component } from 'vue'
import ProductionPanel from './ProductionPanel.vue'
import type { CraneState } from '@twin/domain-crane'
import type { KpiSummary } from '@twin/domain-production'

export interface ProductionPanelState {
  view: 'map' | 'graphics'
  worldMode: 'live' | 'history' | 'simulation'
  clockLabel: string
  kpi: KpiSummary
  tasks: Array<{ taskId: string; title: string; status: string; progressPct: number }>
  alarms: Array<{ alarmId: string; severity: string; message: string }>
  selectedCrane: { code: string; state: CraneState } | undefined
}

export interface ProductionPanelBindings {
  state: ProductionPanelState
  onSetView(view: 'map' | 'graphics'): void
}

export interface ProductionPanelHandle {
  unmount(): void
}

export function mountProductionPanel(
  element: HTMLElement,
  bindings: ProductionPanelBindings
): ProductionPanelHandle {
  const state = reactive(bindings.state)

  const Host = defineComponent({
    setup() {
      return () =>
        h(ProductionPanel as Component, {
          kpi: state.kpi,
          worldMode: state.worldMode,
          clockLabel: state.clockLabel,
          view: state.view,
          tasks: state.tasks,
          alarms: state.alarms,
          selectedCrane: state.selectedCrane,
          onSetView: bindings.onSetView
        })
    }
  })

  const app = createApp(Host)
  app.mount(element)
  return {
    unmount: () => app.unmount()
  }
}
