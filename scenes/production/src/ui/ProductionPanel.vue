<script setup lang="ts">
import type { KpiSummary } from '@twin/domain-production'
import type { CraneState } from '@twin/domain-crane'

const props = defineProps<{
  kpi: KpiSummary
  worldMode: 'live' | 'history' | 'simulation'
  clockLabel: string
  view: 'map' | 'graphics'
  tasks: Array<{ taskId: string; title: string; status: string; progressPct: number }>
  alarms: Array<{ alarmId: string; severity: string; message: string }>
  selectedCrane: { code: string; state: CraneState } | undefined
}>()

const emit = defineEmits<{
  setView: [view: 'map' | 'graphics']
  ackAlarm: [alarmId: string]
  exportSnapshot: []
}>()

function ack(alarmId: string): void {
  emit('ackAlarm', alarmId)
}
function exportSnapshot(): void {
  emit('exportSnapshot')
}
</script>

<template>
  <div class="twin-panel-card prod-panel">
    <div class="prod-header">
      <div class="prod-title">生产数字孪生</div>
      <div class="prod-view-toggle">
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

    <div class="prod-mode">
      <span class="prod-mode-label">{{ { live: 'LIVE 实时', history: 'HISTORY 历史回放', simulation: 'SIMULATION 仿真' }[props.worldMode] }}</span>
      <span class="prod-clock">{{ props.clockLabel }}</span>
    </div>

    <div class="prod-kpis">
      <div class="prod-kpi"><b>{{ props.kpi.runningTasks }}</b><span>进行中</span></div>
      <div class="prod-kpi"><b>{{ props.kpi.donePct }}%</b><span>完成率</span></div>
      <div class="prod-kpi" :class="{ danger: props.kpi.criticalAlarms > 0 }">
        <b>{{ props.kpi.openAlarms }}</b><span>告警</span>
      </div>
    </div>

    <div v-if="props.selectedCrane" class="prod-crane">
      <b>{{ props.selectedCrane.code }}</b>
      <span :class="['prod-crane-status', props.selectedCrane.state.status]">
        {{ { running: '作业中', idle: '待机', fault: '故障' }[props.selectedCrane.state.status] }}
      </span>
      <div class="prod-crane-metrics">
        <span>吊高 {{ props.selectedCrane.state.hookHeightMeters.toFixed(1) }}m</span>
        <span>载荷 {{ props.selectedCrane.state.loadTonnes.toFixed(0) }}t</span>
        <span>大车 {{ props.selectedCrane.state.gantryMeters.toFixed(0) }}m</span>
      </div>
    </div>

    <div class="prod-actions">
      <button class="twin-btn prod-export" data-export-snapshot @click="exportSnapshot">
        导出状态快照
      </button>
    </div>

    <div class="prod-section">任务</div>
    <div class="prod-tasks">
      <div v-for="t in props.tasks" :key="t.taskId" class="prod-task">
        <span class="prod-task-title">{{ t.title }}</span>
        <div class="prod-task-bar">
          <div class="prod-task-fill" :style="{ width: t.progressPct + '%' }" />
        </div>
        <span class="prod-task-pct">{{ t.progressPct }}%</span>
      </div>
    </div>

    <div v-if="props.alarms.length > 0" class="prod-section">告警</div>
    <div class="prod-alarms">
      <div
        v-for="a in props.alarms"
        :key="a.alarmId"
        class="prod-alarm"
        :class="a.severity"
      >
        <span>{{ a.message }}</span>
        <button class="twin-btn prod-ack" :data-ack-alarm="a.alarmId" @click="ack(a.alarmId)">
          确认
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.prod-panel {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 340px;
  max-height: calc(100% - 28px);
  overflow-y: auto;
}

.prod-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.prod-title {
  font-weight: 700;
  color: #8fc1ff;
}

.prod-view-toggle {
  display: flex;
  gap: 4px;
}

.prod-mode {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  margin-bottom: 8px;
  color: #9db8d8;
}

.prod-mode-label {
  color: #ffd166;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.prod-kpis {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.prod-kpi {
  flex: 1;
  text-align: center;
  border: 1px solid var(--twin-border);
  border-radius: 8px;
  padding: 6px 0;
}

.prod-kpi b {
  display: block;
  font-size: 18px;
  color: #cfe3ff;
}

.prod-kpi.danger b {
  color: #e05d5d;
}

.prod-kpi span {
  font-size: 11px;
  color: #7e97b8;
}

.prod-crane {
  border: 1px solid var(--twin-border);
  border-radius: 8px;
  padding: 8px;
  margin-bottom: 10px;
  font-size: 12px;
}

.prod-crane-status.running { color: #57d9a3; }
.prod-crane-status.idle { color: #ffd166; }
.prod-crane-status.fault { color: #e05d5d; }

.prod-crane-metrics {
  display: flex;
  gap: 12px;
  margin-top: 4px;
  color: #9db8d8;
}

.prod-section {
  font-size: 11px;
  color: #7e97b8;
  margin: 8px 0 4px;
  letter-spacing: 0.08em;
}

.prod-task {
  display: grid;
  grid-template-columns: 1fr 90px 34px;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  padding: 3px 0;
}

.prod-task-bar {
  height: 6px;
  background: rgba(120, 160, 220, 0.15);
  border-radius: 3px;
  overflow: hidden;
}

.prod-task-fill {
  height: 100%;
  background: var(--twin-accent);
}

.prod-task-pct {
  text-align: right;
  color: #9db8d8;
}

.prod-alarm {
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 6px;
  margin-bottom: 4px;
  border-left: 3px solid;
}

.prod-alarm.warning {
  border-color: #ffd166;
  background: rgba(255, 209, 102, 0.1);
}

.prod-alarm.critical {
  border-color: #e05d5d;
  background: rgba(224, 93, 93, 0.12);
}

.prod-alarm.info {
  border-color: #4f9cf9;
  background: rgba(79, 156, 249, 0.1);
}

.prod-alarm {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.prod-ack {
  padding: 1px 8px;
  font-size: 11px;
  flex-shrink: 0;
}

.prod-actions {
  margin-bottom: 8px;
}

.prod-export {
  font-size: 12px;
}
</style>
