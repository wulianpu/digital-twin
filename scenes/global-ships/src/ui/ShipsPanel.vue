<script setup lang="ts">
const props = defineProps<{
  ships: Array<{ key: string; name: string; type: string; sogKnots: number; headingDegrees: number }>
  selectedKey: string | undefined
  view: 'map' | 'graphics'
}>()

defineEmits<{
  select: [key: string]
  focus: [key: string]
  setView: [view: 'map' | 'graphics']
}>()

const typeLabel: Record<string, string> = {
  container: '集装箱船',
  'bulk-carrier': '散货船',
  'crane-vessel': '起重船',
  tug: '拖轮',
  other: '其他'
}
</script>

<template>
  <div class="twin-panel-card ships-panel">
    <div class="ships-header">
      <div class="ships-title">全球船舶</div>
      <div class="ships-view-toggle">
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
          地球
        </button>
      </div>
    </div>
    <div class="ships-list">
      <div
        v-for="ship in props.ships"
        :key="ship.key"
        class="ships-row"
        :class="{ selected: ship.key === props.selectedKey }"
        :data-ship-key="ship.key"
        @click="$emit('select', ship.key)"
        @dblclick="$emit('focus', ship.key)"
      >
        <span class="ships-name">{{ ship.name }}</span>
        <span class="ships-type">{{ typeLabel[ship.type] ?? ship.type }}</span>
        <span class="ships-sog">{{ ship.sogKnots.toFixed(1) }} kn</span>
      </div>
    </div>
    <div v-if="props.selectedKey" class="ships-foot">双击行或地图船舶可聚焦</div>
  </div>
</template>

<style scoped>
.ships-panel {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 300px;
  max-height: calc(100% - 28px);
  display: flex;
  flex-direction: column;
}

.ships-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.ships-title {
  font-weight: 700;
  color: #8fc1ff;
}

.ships-view-toggle {
  display: flex;
  gap: 4px;
}

.ships-list {
  overflow-y: auto;
}

.ships-row {
  display: grid;
  grid-template-columns: 1.4fr 1fr 0.6fr;
  font-size: 12px;
  padding: 4px 6px;
  border-top: 1px solid rgba(120, 160, 220, 0.12);
  cursor: pointer;
}

.ships-row:hover {
  background: rgba(79, 156, 249, 0.12);
}

.ships-row.selected {
  background: rgba(79, 156, 249, 0.22);
}

.ships-name {
  font-family: ui-monospace, monospace;
}

.ships-type {
  color: #9db8d8;
}

.ships-sog {
  color: #57d9a3;
  text-align: right;
}

.ships-foot {
  margin-top: 6px;
  font-size: 11px;
  color: #7e97b8;
}
</style>
