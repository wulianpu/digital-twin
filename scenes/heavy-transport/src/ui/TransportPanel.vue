<script setup lang="ts">
const props = defineProps<{
  view: 'map' | 'graphics'
  progressMeters: number
  totalMeters: number
  speedMs: number
  riskLabel: string
  riskViolating: boolean
  zoneLabel: string | undefined
  playing: boolean
}>()

defineEmits<{
  setView: [view: 'map' | 'graphics']
  setProgress: [meters: number]
  setSpeed: [speedMs: number]
  togglePlay: []
}>()
</script>

<template>
  <div class="twin-panel-card transport-panel">
    <div class="transport-header">
      <div class="transport-title">大件运输</div>
      <div class="transport-view-toggle">
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

    <div class="transport-risk" :class="{ violation: props.riskViolating }">
      {{ props.riskViolating ? `⚠ ${props.zoneLabel ?? '限制区'} — 路径侵入` : `✓ ${props.riskLabel}` }}
    </div>

    <div class="transport-row">
      <button class="twin-btn transport-play" data-transport-play @click="$emit('togglePlay')">
        {{ props.playing ? '暂停' : '播放' }}
      </button>
      <span class="transport-progress-label">
        {{ Math.round(props.progressMeters) }} / {{ Math.round(props.totalMeters) }} m
      </span>
    </div>

    <input
      class="transport-slider"
      data-transport-progress
      type="range"
      min="0"
      :max="Math.round(props.totalMeters)"
      :value="Math.round(props.progressMeters)"
      @input="$emit('setProgress', Number(($event.target as HTMLInputElement).value))"
    />

    <label class="transport-speed">
      速度 {{ props.speedMs.toFixed(1) }} m/s
      <input
        type="range"
        min="1"
        max="15"
        step="0.5"
        :value="props.speedMs"
        @input="$emit('setSpeed', Number(($event.target as HTMLInputElement).value))"
      />
    </label>
  </div>
</template>

<style scoped>
.transport-panel {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 300px;
}

.transport-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.transport-title {
  font-weight: 700;
  color: #8fc1ff;
}

.transport-view-toggle {
  display: flex;
  gap: 4px;
}

.transport-risk {
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid rgba(87, 217, 163, 0.4);
  background: rgba(87, 217, 163, 0.1);
  color: #57d9a3;
  margin-bottom: 10px;
}

.transport-risk.violation {
  border-color: rgba(224, 93, 93, 0.6);
  background: rgba(224, 93, 93, 0.12);
  color: #e05d5d;
}

.transport-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: 12px;
  color: #9db8d8;
}

.transport-slider,
.transport-speed input {
  width: 100%;
  margin-bottom: 8px;
}

.transport-speed {
  display: block;
  font-size: 12px;
  color: #9db8d8;
}
</style>
