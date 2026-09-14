import { createApp, defineComponent, h, reactive } from 'vue'
import StackYardPanel from './StackYardPanel.vue'

export interface StackPanelState {
  selectedCode: string | undefined
  view: 'map' | 'graphics'
  stackStates: Record<string, string>
}

export interface StackPanelBindings {
  cells: ReadonlyArray<{ code: string; segment: string; weightTonnes: number; status: string }>
  state: StackPanelState
  onSelect(code: string): void
  onFocus(code: string): void
  onSetView(view: 'map' | 'graphics'): void
}

export interface StackPanelHandle {
  unmount(): void
}

export function mountStackPanel(
  element: HTMLElement,
  bindings: StackPanelBindings
): StackPanelHandle {
  const state = reactive(bindings.state)

  const Host = defineComponent({
    setup() {
      return () =>
        h(StackYardPanel, {
          cells: bindings.cells,
          selectedCode: state.selectedCode,
          view: state.view,
          stackStates: state.stackStates,
          onSelect: (code: string) => bindings.onSelect(code),
          onFocus: (code: string) => bindings.onFocus(code),
          onSetView: (view: 'map' | 'graphics') => bindings.onSetView(view)
        })
    }
  })

  const app = createApp(Host)
  app.mount(element)
  return { unmount: () => app.unmount() }
}
