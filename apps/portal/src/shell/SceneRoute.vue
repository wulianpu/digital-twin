<script setup lang="ts">
import { watch } from 'vue'
import { useRoute } from 'vue-router'
import { inject } from 'vue'
import { coordinatorKey } from '../keys'
import type { SceneCoordinator } from '../coordinator'
import { isKnownScene } from '../router'

const route = useRoute()
const coordinator = inject<SceneCoordinator>(coordinatorKey)!

watch(
  () => route.params.sceneId as string | undefined,
  (sceneId) => {
    if (sceneId && isKnownScene(sceneId)) {
      void coordinator.select(sceneId)
    }
  },
  { immediate: true }
)
</script>

<template>
  <span style="display: none" />
</template>
