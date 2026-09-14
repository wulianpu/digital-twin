<script setup lang="ts">
import { computed, inject } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { SCENE_CATALOG, canEnter } from '../catalog'
import { coordinatorKey } from '../keys'
import { useSessionStore } from '../stores'

const router = useRouter()
const route = useRoute()
const coordinator = inject(coordinatorKey)!
const session = useSessionStore()

const activeSceneId = computed(
  () => (route.params.sceneId as string | undefined) ?? coordinator.activeSceneId
)

function select(sceneId: string): void {
  void router.push(`/scene/${sceneId}`)
}

function preload(sceneId: string): void {
  coordinator.preload(sceneId) // code prefetch only (§61)
}
</script>

<template>
  <aside class="portal-sidebar">
    <div class="portal-brand">
      <div class="portal-brand-name">船舶制造数字孪生</div>
      <div class="portal-brand-sub">Architecture Freeze v1.2</div>
    </div>

    <nav class="portal-catalog">
      <div class="portal-catalog-title">场景目录</div>
      <button
        v-for="definition in SCENE_CATALOG"
        :key="definition.id"
        class="portal-catalog-item"
        :data-scene-id="definition.id"
        :data-active="activeSceneId === definition.id"
        :disabled="!canEnter(definition, session.user.permissions)"
        :title="definition.permissions && !canEnter(definition, session.user.permissions) ? '无权限' : definition.description"
        @click="select(definition.id)"
        @mouseenter="preload(definition.id)"
      >
        <span class="portal-catalog-icon">{{ definition.icon }}</span>
        <span class="portal-catalog-name">{{ definition.name }}</span>
      </button>
    </nav>

    <div class="portal-user">
      <span class="portal-user-dot" />
      {{ session.user.name }}
    </div>
  </aside>
</template>

<style scoped>
.portal-sidebar {
  width: 216px;
  flex-shrink: 0;
  background: rgba(11, 18, 32, 0.96);
  border-right: 1px solid var(--twin-border);
  display: flex;
  flex-direction: column;
  padding: 14px 10px;
}

.portal-brand {
  padding: 4px 8px 14px;
}

.portal-brand-name {
  font-weight: 700;
  font-size: 15px;
  color: #d7e6ff;
}

.portal-brand-sub {
  font-size: 10px;
  color: #7e97b8;
  letter-spacing: 0.06em;
}

.portal-catalog {
  flex: 1;
  overflow-y: auto;
}

.portal-catalog-title {
  font-size: 11px;
  color: #7e97b8;
  padding: 0 8px 6px;
  letter-spacing: 0.1em;
}

.portal-catalog-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  margin-bottom: 2px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #cfe3ff;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}

.portal-catalog-item:hover {
  background: rgba(79, 156, 249, 0.12);
}

.portal-catalog-item[data-active='true'] {
  background: rgba(79, 156, 249, 0.28);
  font-weight: 600;
}

.portal-catalog-item:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.portal-catalog-icon {
  font-size: 15px;
}

.portal-user {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 8px 0;
  font-size: 12px;
  color: #9db8d8;
}

.portal-user-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #57d9a3;
}
</style>
