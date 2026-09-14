<script setup lang="ts">
import { inject, onBeforeUnmount, ref } from 'vue'
import type { ViewMode } from '@twin/ui'
import type { QualityProfile } from '@twin/scene-engine'
import type { ConnectionState } from '../foundation'
import { foundationKey } from '../keys'
import { useSessionStore } from '../stores'

defineProps<{ viewMode: ViewMode }>()
const emit = defineEmits<{ 'update:viewMode': [mode: ViewMode] }>()

const foundation = inject(foundationKey)!
const session = useSessionStore()

// I3-3: 连接状态与数据降级可见（2s 轮询，指示器成本可忽略）。
const conn = ref<ConnectionState>({ state: 'local', staleCount: 0 })
// S2: 底图/style 异常（glyphs 不可达时文字标注降级）可见化。
const mapIssues = ref<readonly string[]>([])
// B3: 历史时间线 scrubber（环范围拖动 → clock.seek → 回放即时推进）
const histRange = ref<{ start: number; end: number }>({ start: 0, end: 0 })
const scrubMs = ref(0)
const connPoll = setInterval(() => {
  conn.value = foundation.connection()
  mapIssues.value = foundation.mapAccess.currentContext?.styleIssues() ?? []
  if (session.worldMode !== 'live') {
    histRange.value = foundation.historyRange()
    scrubMs.value = foundation.world.time.now().epochMillis
  }
}, 2000)
connPoll.unref?.()
onBeforeUnmount(() => clearInterval(connPoll))

function onScrubInput(event: Event): void {
  const v = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(v) || v <= 0) return
  foundation.world.clock.seek(v)
  foundation.tick()
}

const CONN_LABEL: Record<ConnectionState['state'], string> = {
  local: '演示数据',
  open: '网关已连接',
  connecting: '连接中…',
  closed: '已断开 · 重连中'
}
// B2: 全局实体搜索（缓存键）→ 选中 + 定位
const searchTerm = ref('')
const results = ref<Array<{ contract: string; key: string; label?: string }>>([])

function onSearchInput(): void {
  results.value = foundation.searchEntities(searchTerm.value, 8)
}

function pickResult(item: { contract: string; key: string; label?: string }): void {
  const [namespace, id] = item.key.split('/')
  const entity = { namespace, id }
  foundation.selection.setPrimary(entity)
  // 预热缓存并定位（contract 随结果携带）
  void foundation.data
    .query({ contract: item.contract, keys: [item.key] })
    .catch(() => {})
  void foundation.view.focus(entity)
  searchTerm.value = ''
  results.value = []
}

const CONN_HINT: Record<ConnectionState['state'], string> = {
  local: '使用内置演示网关（未配置 VITE_GATEWAY_WS_URL）',
  open: '平台网关连接正常',
  connecting: '正在连接平台网关…',
  closed: '平台网关连接断开，正在自动重连'
}

const MODES: Array<{ id: 'live' | 'history' | 'simulation'; label: string }> = [
  { id: 'live', label: 'LIVE' },
  { id: 'history', label: 'HISTORY' },
  { id: 'simulation', label: 'SIM' }
]

const SITES = [
  { id: 'global', label: '全球' },
  { id: 'site-changxing', label: '长兴' },
  { id: 'site-qidong', label: '启东' }
]

function setWorldMode(mode: 'live' | 'history' | 'simulation'): void {
  session.worldMode = mode
  foundation.world.setMode(mode)
  foundation.data.setMode(mode)
  if (mode === 'history') {
    foundation.world.clock.seek(Date.now() - 10 * 60_000)
  }
}

function setScope(siteId: string): void {
  session.activeSiteId = siteId === 'global' ? undefined : siteId
  foundation.world.setScope(
    siteId === 'global'
      ? { kind: 'global' }
      : { kind: 'site', siteId }
  )
}

function setTimeSpeed(speed: number): void {
  session.timeSpeed = speed
  foundation.world.clock.setSpeed(speed)
}

function setQuality(profile: QualityProfile): void {
  foundation.graphicsAccess.applyQuality(profile)
}

const QUALITIES: QualityProfile[] = ['OFFICE', 'STANDARD', 'HIGH', 'EXHIBITION']
</script>

<template>
  <header class="portal-topbar">
    <div
      class="portal-conn"
      :data-state="conn.state"
      :title="`${CONN_HINT[conn.state]}；本地陈旧数据 ${conn.staleCount} 项${mapIssues.length > 0 ? `；底图异常 ${mapIssues.length} 条（文字标注可能不可用）` : ''}`"
    >
      <span class="portal-conn-dot" />
      {{ CONN_LABEL[conn.state] }}<template v-if="conn.staleCount > 0"> · {{ conn.staleCount }} 项陈旧</template><template v-if="mapIssues.length > 0"> · 底图异常</template>
    </div>

    <div class="portal-search" data-entity-search>
      <input
        v-model="searchTerm"
        class="portal-search-input"
        placeholder="搜索实体（AGV / 船舶 / 堆位…）"
        @input="onSearchInput"
      />
      <ul v-if="results.length > 0" class="portal-search-results">
        <li
          v-for="r in results"
          :key="r.contract + r.key"
          class="portal-search-item"
          @click="pickResult(r)"
        >
          {{ r.key }}
        </li>
      </ul>
    </div>

    <div class="portal-group">
      <span class="portal-group-label">世界</span>
      <button
        v-for="m in MODES"
        :key="m.id"
        class="twin-btn portal-topbar-btn"
        data-world-mode
        :data-mode="m.id"
        :data-active="session.worldMode === m.id"
        @click="setWorldMode(m.id)"
      >
        {{ m.label }}
      </button>
      <input
        v-if="session.worldMode !== 'live' && histRange.end > 0"
        class="portal-scrub"
        type="range"
        :min="histRange.start"
        :max="histRange.end"
        :value="scrubMs"
        title="历史时间线拖动"
        @input="onScrubInput"
      />
      <input
        v-if="session.worldMode !== 'live'"
        class="portal-speed"
        type="range"
        min="0.5"
        max="16"
        step="0.5"
        :value="session.timeSpeed"
        :title="`时间倍速 ×${session.timeSpeed}`"
        @input="setTimeSpeed(Number(($event.target as HTMLInputElement).value))"
      />
    </div>

    <div class="portal-group">
      <span class="portal-group-label">范围</span>
      <button
        v-for="s in SITES"
        :key="s.id"
        class="twin-btn portal-topbar-btn"
        data-site-switch
        :data-site="s.id"
        :data-active="
          s.id === 'global'
            ? !session.activeSiteId
            : session.activeSiteId === s.id
        "
        @click="setScope(s.id)"
      >
        {{ s.label }}
      </button>
    </div>

    <div class="portal-group">
      <span class="portal-group-label">视图</span>
      <button
        v-for="m in ['map', 'split', 'graphics'] as const"
        :key="m"
        class="twin-btn portal-topbar-btn"
        :data-active="viewMode === m"
        @click="emit('update:viewMode', m)"
      >
        {{ { map: '2D', split: '分屏', graphics: '3D' }[m] }}
      </button>
    </div>

    <div class="portal-group">
      <span class="portal-group-label">质量</span>
      <button
        v-for="q in QUALITIES"
        :key="q"
        class="twin-btn portal-topbar-btn portal-quality-btn"
        :data-quality="q"
        @click="setQuality(q)"
      >
        {{ q[0] + q.slice(1).toLowerCase() }}
      </button>
    </div>

    <button
      class="twin-btn portal-topbar-btn portal-diag-toggle"
      :data-active="session.diagnosticsOpen"
      @click="session.diagnosticsOpen = !session.diagnosticsOpen"
    >
      诊断
    </button>
  </header>
</template>

<style scoped>
.portal-topbar {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--twin-border);
  background: rgba(11, 18, 32, 0.96);
  flex-wrap: wrap;
}

.portal-search {
  position: relative;
}

.portal-search-input {
  width: 220px;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--twin-text);
  background: rgba(10, 18, 32, 0.9);
  border: 1px solid var(--twin-border);
  border-radius: 6px;
  outline: none;
}

.portal-search-input:focus {
  border-color: var(--twin-accent);
}

.portal-search-results {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 30;
  margin: 0;
  padding: 4px 0;
  list-style: none;
  background: var(--twin-panel);
  border: 1px solid var(--twin-border);
  border-radius: 8px;
  max-height: 260px;
  overflow-y: auto;
}

.portal-search-item {
  padding: 5px 10px;
  font-size: 12px;
  font-family: ui-monospace, monospace;
  color: #cfe3ff;
  cursor: pointer;
}

.portal-search-item:hover {
  background: rgba(79, 156, 249, 0.18);
}

.portal-conn {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #9db8d8;
  border: 1px solid var(--twin-border);
  border-radius: 12px;
  padding: 2px 10px;
  cursor: default;
}

.portal-conn-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #57d9a3;
}

.portal-conn[data-state='open'] .portal-conn-dot {
  background: #57d9a3;
}

.portal-conn[data-state='local'] .portal-conn-dot {
  background: #4f9cf9;
}

.portal-conn[data-state='connecting'] .portal-conn-dot {
  background: #ffd166;
}

.portal-conn[data-state='closed'] .portal-conn-dot {
  background: #e05d5d;
}

.portal-conn[data-state='closed'] {
  border-color: rgba(224, 93, 93, 0.5);
  color: #ffb3b3;
}

.portal-group {
  display: flex;
  align-items: center;
  gap: 4px;
}

.portal-group-label {
  font-size: 11px;
  color: #7e97b8;
  margin-right: 4px;
  letter-spacing: 0.08em;
}

.portal-topbar-btn {
  padding: 3px 10px;
  font-size: 12px;
}

.portal-quality-btn {
  font-size: 11px;
  padding: 3px 8px;
}

.portal-speed {
  width: 90px;
  margin-left: 6px;
}

.portal-scrub {
  width: 220px;
  margin-left: 6px;
}

.portal-diag-toggle {
  margin-left: auto;
}
</style>
