<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { GraphicsDiagnostics } from '@twin/sdk'

const props = defineProps<{
  getDiagnostics: () => GraphicsDiagnostics | undefined
  pollMs?: number
}>()

const diag = ref<GraphicsDiagnostics | undefined>()
let timer: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  timer = setInterval(() => {
    diag.value = props.getDiagnostics()
  }, props.pollMs ?? 1000)
  timer.unref?.()
})

onBeforeUnmount(() => {
  if (timer !== undefined) clearInterval(timer)
})
</script>

<template>
  <div class="twin-diag">
    <div class="twin-diag-title">Diagnostics</div>
    <template v-if="diag">
      <div class="twin-diag-row"><span>quality</span><b>{{ diag.quality }}</b></div>
      <div class="twin-diag-row"><span>fps</span><b>{{ diag.frame.fps }}</b></div>
      <div class="twin-diag-row"><span>p50 / p95</span><b>{{ diag.frame.p50Ms }} / {{ diag.frame.p95Ms }} ms</b></div>
      <div class="twin-diag-row"><span>draw calls</span><b>{{ diag.renderer.drawCalls }}</b></div>
      <div class="twin-diag-row"><span>triangles</span><b>{{ diag.renderer.triangles.toLocaleString() }}</b></div>
      <div class="twin-diag-row"><span>textures / geoms</span><b>{{ diag.renderer.textures }} / {{ diag.renderer.geometries }}</b></div>
      <div class="twin-diag-row"><span>frame cbs</span><b>{{ diag.frameCallbacks }}</b></div>
      <div class="twin-diag-row"><span>entities</span><b>{{ diag.entityCount }}</b></div>
      <div class="twin-diag-row" v-if="diag.tiles"><span>tiles</span><b>{{ (diag.tiles.cachedBytes / 1048576).toFixed(1) }} MB{{ diag.tiles.isFull ? ' (FULL)' : '' }}</b></div>
      <div class="twin-diag-row" v-if="diag.jsHeapMB !== undefined"><span>js heap</span><b>{{ diag.jsHeapMB }} MB</b></div>
    </template>
    <div v-else class="twin-diag-row"><span>engine idle</span></div>
  </div>
</template>

<style scoped>
.twin-diag {
  font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #cfe3ff;
  background: rgba(10, 18, 32, 0.88);
  border: 1px solid rgba(120, 160, 220, 0.25);
  border-radius: 8px;
  padding: 10px 12px;
  min-width: 220px;
}

.twin-diag-title {
  font-weight: 700;
  margin-bottom: 4px;
  color: #8fc1ff;
}

.twin-diag-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
</style>
