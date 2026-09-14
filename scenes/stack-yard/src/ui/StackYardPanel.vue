<script setup lang="ts">
const props = defineProps<{
  cells: ReadonlyArray<{
    code: string
    segment: string
    weightTonnes: number
    status: string
  }>
  selectedCode: string | undefined
  view: 'map' | 'graphics'
  stackStates: Record<string, string>
}>()

defineEmits<{
  select: [code: string]
  setView: [view: 'map' | 'graphics']
  focus: [code: string]
}>()

const statusLabel: Record<string, string> = {
  stored: '在堆',
  inbound: '待入',
  outbound: '待出',
  maintenance: '维护'
}

function displayStatus(code: string): string {
  return props.stackStates[code] ?? props.cells.find((c) => c.code === code)?.status ?? 'stored'
}
</script>

<template>
  <div class="twin-panel-card yard-panel">
    <div class="yard-header">
      <div class="yard-title">分段堆场</div>
      <div class="yard-view-toggle">
        <button
          class="twin-btn"
          data-view-toggle="map"
          :data-active="props.view === 'map'"
          @click="$emit('setView', 'map')"
        >
          2D
        </button>
        <button
          class="twin-btn"
          data-view-toggle="graphics"
          :data-active="props.view === 'graphics'"
          @click="$emit('setView', 'graphics')"
        >
          3D
        </button>
      </div>
    </div>

    <div v-if="props.selectedCode" class="yard-selected">
      <b>{{ props.selectedCode }}</b>
      <span class="yard-status">{{ statusLabel[displayStatus(props.selectedCode)] }}</span>
      <button class="twin-btn yard-focus" @click="$emit('focus', props.selectedCode)">聚焦</button>
    </div>

    <div class="yard-list">
      <div
        v-for="cell in props.cells"
        :key="cell.code"
        class="yard-row"
        :class="{ selected: cell.code === props.selectedCode }"
        :data-stack-code="cell.code"
        @click="$emit('select', cell.code)"
      >
        <span class="yard-code">{{ cell.code }}</span>
        <span class="yard-seg">{{ cell.segment }}</span>
        <span class="yard-weight">{{ cell.weightTonnes }}t</span>
        <span class="yard-status">{{ statusLabel[displayStatus(cell.code)] }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.yard-panel {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 320px;
  max-height: calc(100% - 28px);
  display: flex;
  flex-direction: column;
}

.yard-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.yard-title {
  font-weight: 700;
  color: #8fc1ff;
}

.yard-view-toggle {
  display: flex;
  gap: 4px;
}

.yard-selected {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  margin-bottom: 6px;
  border: 1px solid var(--twin-border);
  border-radius: 6px;
  font-size: 13px;
}

.yard-focus {
  margin-left: auto;
  padding: 2px 10px;
  font-size: 12px;
}

.yard-list {
  overflow-y: auto;
}

.yard-row {
  display: grid;
  grid-template-columns: 1.3fr 0.9fr 0.7fr 0.7fr;
  font-size: 12px;
  padding: 4px 6px;
  border-top: 1px solid rgba(120, 160, 220, 0.12);
  cursor: pointer;
}

.yard-row:hover {
  background: rgba(79, 156, 249, 0.12);
}

.yard-row.selected {
  background: rgba(79, 156, 249, 0.22);
}

.yard-code {
  font-family: ui-monospace, monospace;
  color: #cfe3ff;
}

.yard-seg {
  color: #9db8d8;
}

.yard-weight {
  color: #ffd166;
}

.yard-status {
  color: #57d9a3;
}
</style>
