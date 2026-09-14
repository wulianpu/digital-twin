<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * Viewport host: three stacked containers (map / graphics / scene UI).
 * The application hands these DOM nodes to the engine ports and to the
 * SceneHost; this component owns nothing but layout + view mode classes.
 */
export type ViewMode = 'map' | 'graphics' | 'split'

const props = defineProps<{ mode: ViewMode }>()

const rootEl = ref<HTMLDivElement | null>(null)
const mapEl = ref<HTMLDivElement | null>(null)
const graphicsEl = ref<HTMLDivElement | null>(null)
const uiEl = ref<HTMLDivElement | null>(null)

defineExpose({
  get mapContainer() {
    return mapEl.value
  },
  get graphicsContainer() {
    return graphicsEl.value
  },
  get uiContainer() {
    return uiEl.value
  }
})

watch(
  () => props.mode,
  () => {
    // Engines size against the container; notify after class changes settle.
    window.dispatchEvent(new CustomEvent('twin-viewport-resized'))
  }
)

onMounted(() => {
  const observer = new ResizeObserver(() => {
    window.dispatchEvent(new CustomEvent('twin-viewport-resized'))
  })
  if (rootEl.value) observer.observe(rootEl.value)
  onBeforeUnmount(() => observer.disconnect())
})
</script>

<template>
  <div ref="rootEl" class="twin-viewport" :data-mode="props.mode">
    <div ref="mapEl" class="twin-viewport-layer twin-viewport-map" />
    <div ref="graphicsEl" class="twin-viewport-layer twin-viewport-graphics" />
    <div ref="uiEl" class="twin-viewport-layer twin-viewport-ui" />
  </div>
</template>

<style scoped>
.twin-viewport {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #0a1220;
}

.twin-viewport-layer {
  position: absolute;
  inset: 0;
}

.twin-viewport-ui {
  pointer-events: none;
}

.twin-viewport-ui :deep(*) {
  pointer-events: auto;
}

.twin-viewport[data-mode='map'] .twin-viewport-graphics {
  display: none;
}

.twin-viewport[data-mode='graphics'] .twin-viewport-map {
  display: none;
}

.twin-viewport[data-mode='split'] .twin-viewport-map {
  right: 50%;
  width: 50%;
}

.twin-viewport[data-mode='split'] .twin-viewport-graphics {
  left: 50%;
  width: 50%;
}
</style>
