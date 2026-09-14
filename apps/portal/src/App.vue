<script setup lang="ts">
import { inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { TwinViewport, DiagnosticsPanel } from '@twin/ui'
import type { ViewMode } from '@twin/ui'
import { foundationKey, coordinatorKey } from './keys'
import { isKnownScene } from './router'
import { useSessionStore } from './stores'
import { setupPerfAutomation } from './perf'
import AppSidebar from './shell/AppSidebar.vue'
import AppTopbar from './shell/AppTopbar.vue'

const foundation = inject(foundationKey)!
const coordinator = inject(coordinatorKey)!
const session = useSessionStore()
const route = useRoute()

const viewMode = ref<ViewMode>('map')

const rootEl = ref<InstanceType<typeof TwinViewport> | null>(null)

function retryActive(): void {
  const target = session.activeSceneId ?? (route.params.sceneId as string | undefined)
  if (target) void coordinator.select(target)
}

let pendingScene: string | undefined
let containersReady = false

onMounted(() => {
  foundation.workspace.setContainers({
    map: rootEl.value?.mapContainer ?? undefined,
    graphics: rootEl.value?.graphicsContainer ?? undefined
  })
  containersReady = true
  coordinator.preload('global-ships')
  // I5: URL 参数驱动的性能采集 / soak / context loss 演练（生产访问不受影响）
  setupPerfAutomation(foundation, coordinator)
  // S1: 场景内视图切换 → 壳层视图模式联动（DOM 事件，场景保持应用无关）
  rootEl.value?.uiContainer?.addEventListener('twin-scene-view', (e) => {
    const view = (e as CustomEvent<{ view?: 'map' | 'graphics' }>).detail?.view
    if (view === 'graphics') viewMode.value = 'graphics'
    else if (view === 'map') viewMode.value = 'map'
  })
  if (pendingScene) {
    const target = pendingScene
    pendingScene = undefined
    void coordinator.select(target)
  }
})

// URL ↔ Scene sync (§10). The viewport is persistent; only the scene swaps.
watch(
  () => route.params.sceneId as string | undefined,
  (sceneId) => {
    if (!sceneId || !isKnownScene(sceneId)) return
    if (!containersReady) {
      pendingScene = sceneId
      return
    }
    void coordinator.select(sceneId)
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  foundation.dispose()
})
</script>

<template>
  <div class="portal-shell">
    <AppSidebar />
    <div class="portal-main">
      <AppTopbar
        :view-mode="viewMode"
        @update:view-mode="
          (m) => {
            viewMode = m
          }
        "
      />
      <div class="portal-viewport-wrap">
        <TwinViewport ref="rootEl" :mode="viewMode" />
        <div class="portal-coordinator-status" data-coordinator-state>
          <span v-if="session.coordinatorState === 'loading'" class="portal-loading">
            正在进入「{{ session.loadingSceneId }}」…
          </span>
          <span v-else-if="session.coordinatorState === 'denied'" class="portal-denied">
            {{ session.lastError }}
          </span>
          <span v-else-if="session.coordinatorState === 'error'" class="portal-error">
            场景加载失败：{{ session.lastError }}
            <button class="twin-btn portal-retry" @click="retryActive">重试</button>
          </span>
        </div>
        <div v-if="session.diagnosticsOpen" class="portal-diagnostics">
          <DiagnosticsPanel
            :get-diagnostics="() => foundation.graphicsAccess.getDiagnostics()"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.portal-shell {
  display: flex;
  width: 100%;
  height: 100%;
}

.portal-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.portal-viewport-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
}

.portal-coordinator-status {
  position: absolute;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  pointer-events: none;
}

.portal-loading {
  background: rgba(13, 24, 42, 0.9);
  border: 1px solid var(--twin-border);
  border-radius: 16px;
  padding: 4px 14px;
  font-size: 12px;
  color: #8fc1ff;
}

.portal-error {
  background: rgba(80, 18, 18, 0.9);
  border: 1px solid #e05d5d;
  border-radius: 16px;
  padding: 4px 14px;
  font-size: 12px;
  color: #ffb3b3;
}

.portal-denied {
  background: rgba(66, 50, 10, 0.92);
  border: 1px solid rgba(255, 209, 102, 0.5);
  border-radius: 16px;
  padding: 4px 14px;
  font-size: 12px;
  color: #ffd166;
}

.portal-retry {
  margin-left: 8px;
  padding: 1px 10px;
  font-size: 11px;
}

.portal-diagnostics {
  position: absolute;
  right: 14px;
  bottom: 14px;
}
</style>
