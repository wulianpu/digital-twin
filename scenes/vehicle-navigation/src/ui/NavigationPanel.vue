<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  agvs: Array<{ key: string; speedMs: number; batteryPct: number; taskId?: string }>
  selectedKey: string | undefined
  routeNames: readonly string[]
}>()

const emit = defineEmits<{
  select: [key: string]
  focus: [key: string]
}>()

const batteryClass = computed(() => (pct: number) =>
  pct < 30 ? 'low' : pct < 60 ? 'mid' : 'ok'
)
</script>

<template>
  <div class="twin-panel-card nav-panel">
    <div class="nav-title">行车导航</div>
    <div class="nav-routes">
      <span v-for="name in props.routeNames" :key="name" class="nav-route-chip">{{ name }}</span>
    </div>
    <table class="nav-table">
      <thead>
        <tr><th>AGV</th><th>速度</th><th>电量</th><th>任务</th></tr>
      </thead>
      <tbody>
        <tr
          v-for="agv in props.agvs"
          :key="agv.key"
          :data-agv-key="agv.key"
          :class="{ selected: agv.key === props.selectedKey }"
          @click="emit('select', agv.key)"
          @dblclick="emit('focus', agv.key)"
        >
          <td>{{ agv.key }}</td>
          <td>{{ (agv.speedMs * 3.6).toFixed(0) }} km/h</td>
          <td><span :class="['battery', batteryClass(agv.batteryPct)]">{{ Math.round(agv.batteryPct) }}%</span></td>
          <td>{{ agv.taskId ?? '—' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.nav-panel {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 300px;
}

.nav-title {
  font-weight: 700;
  margin-bottom: 8px;
  color: #8fc1ff;
}

.nav-routes {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.nav-route-chip {
  font-size: 11px;
  border: 1px solid var(--twin-border);
  border-radius: 10px;
  padding: 1px 8px;
  color: #9db8d8;
}

.nav-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.nav-table th {
  text-align: left;
  color: #7e97b8;
  font-weight: 500;
  padding: 2px 4px;
}

.nav-table td {
  padding: 3px 4px;
  border-top: 1px solid rgba(120, 160, 220, 0.12);
}

.nav-table tr.selected td {
  background: rgba(79, 156, 249, 0.18);
}

.nav-table tr {
  cursor: pointer;
}

.battery.ok { color: #57d9a3; }
.battery.mid { color: #ffd166; }
.battery.low { color: #e05d5d; }
</style>
