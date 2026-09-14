import type { Site } from '@twin/world'
import {
  SpatialStateBuffer,
  createReplaySource,
  createScriptedSource
} from '@twin/world-client'
import type { ReplaySource, ScriptedSource } from '@twin/world-client'
import {
  VESSEL_CONTRACT,
  type VesselState
} from '@twin/domain-vessel'
import { CRANE_CONTRACT, simulateCrane } from '@twin/domain-crane'
import { AGV_CONTRACT, simulateAgvOnRoute, type AgvState } from '@twin/domain-agv'
import { STACK_CONTRACT } from '@twin/domain-logistics'
import {
  PRODUCTION_ALARM_CONTRACT,
  PRODUCTION_TASK_CONTRACT,
  type AlarmSeverity
} from '@twin/domain-production'
import { DEMO_AGV_LOOP } from '@twin/domain-agv'
import { SITE_CHANGEXING } from './sites'

export interface DemoGateway {
  readonly live: ScriptedSource
  readonly simulation: ScriptedSource
  readonly stateBuffer: SpatialStateBuffer
  /** Drive all generators from the world clock (live or virtual time). */
  tick(mode: 'live' | 'simulation', timeMs: number): void
  /** Build a replay source from the recorded history ring. */
  buildHistorySource(): ReplaySource
  /** B2：按业务名称搜索船舶（供 foundation.searchEntities 合并）。 */
  searchVesselsByName(term: string, limit?: number): Array<{ key: string; label: string }>
  historyRange(): { start: number; end: number }
  dispose(): void
}

const AGV_CODES = ['AGV-01', 'AGV-02', 'AGV-03', 'AGV-04', 'AGV-05', 'AGV-06']
const CRANE_BASES = [
  { code: 'CRANE-001', gantryTrackMeters: 380, boomHeadingDeg: 0 },
  { code: 'CRANE-002', gantryTrackMeters: 380, boomHeadingDeg: 0 },
  { code: 'CRANE-003', gantryTrackMeters: 380, boomHeadingDeg: 0 },
  { code: 'CRANE-004', gantryTrackMeters: 380, boomHeadingDeg: 0 }
]
// A3：AGV 沿行车导航场景展示的主干道环线行驶（单一事实源）
const AGV_ROUTE = DEMO_AGV_LOOP

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface VesselSeed {
  mmsi: string
  name: string
  shipType: VesselState['shipType']
  baseLon: number
  baseLat: number
  lonAmp: number
  latAmp: number
  periodMs: number
  phase: number
  speedKnots: number
  lengthMeters: number
}

const VESSEL_SEEDS: VesselSeed[] = [
  { mmsi: '412345001', name: '沪舟101', shipType: 'container', baseLon: 122.2, baseLat: 31.0, lonAmp: 0.55, latAmp: 0.28, periodMs: 5_400_000, phase: 0.0, speedKnots: 12.4, lengthMeters: 299 },
  { mmsi: '412345002', name: '长融7', shipType: 'bulk-carrier', baseLon: 122.45, baseLat: 30.6, lonAmp: 0.4, latAmp: 0.5, periodMs: 7_200_000, phase: 1.1, speedKnots: 9.8, lengthMeters: 224 },
  { mmsi: '412345003', name: '振华32', shipType: 'crane-vessel', baseLon: 121.9, baseLat: 31.15, lonAmp: 0.25, latAmp: 0.2, periodMs: 9_000_000, phase: 2.4, speedKnots: 6.2, lengthMeters: 165 },
  { mmsi: '412345004', name: '港拖12', shipType: 'tug', baseLon: 121.85, baseLat: 31.32, lonAmp: 0.12, latAmp: 0.1, periodMs: 3_600_000, phase: 0.7, speedKnots: 8.9, lengthMeters: 38 },
  { mmsi: '412345005', name: '东海集装箱66', shipType: 'container', baseLon: 122.6, baseLat: 31.4, lonAmp: 0.5, latAmp: 0.35, periodMs: 6_000_000, phase: 3.2, speedKnots: 14.1, lengthMeters: 335 },
  { mmsi: '412345006', name: '华洋散货9', shipType: 'bulk-carrier', baseLon: 122.0, baseLat: 30.2, lonAmp: 0.45, latAmp: 0.4, periodMs: 8_400_000, phase: 4.5, speedKnots: 8.2, lengthMeters: 190 },
  { mmsi: '412345007', name: '启东半潜1', shipType: 'crane-vessel', baseLon: 122.3, baseLat: 31.9, lonAmp: 0.35, latAmp: 0.22, periodMs: 10_800_000, phase: 5.1, speedKnots: 5.4, lengthMeters: 216 },
  { mmsi: '412345008', name: '外高桥拖3', shipType: 'tug', baseLon: 121.6, baseLat: 31.45, lonAmp: 0.15, latAmp: 0.12, periodMs: 4_200_000, phase: 2.8, speedKnots: 7.6, lengthMeters: 35 },
  { mmsi: '412345009', name: '中远之星', shipType: 'container', baseLon: 122.75, baseLat: 30.9, lonAmp: 0.6, latAmp: 0.45, periodMs: 6_600_000, phase: 1.9, speedKnots: 16.3, lengthMeters: 366 },
  { mmsi: '412345010', name: '崇明货1588', shipType: 'bulk-carrier', baseLon: 121.5, baseLat: 31.6, lonAmp: 0.3, latAmp: 0.3, periodMs: 7_800_000, phase: 0.4, speedKnots: 7.1, lengthMeters: 145 },
  { mmsi: '412345011', name: '长江驳201', shipType: 'bulk-carrier', baseLon: 121.3, baseLat: 31.75, lonAmp: 0.2, latAmp: 0.18, periodMs: 5_000_000, phase: 3.7, speedKnots: 5.2, lengthMeters: 105 },
  { mmsi: '412345012', name: '洋山拖8', shipType: 'tug', baseLon: 122.05, baseLat: 30.63, lonAmp: 0.18, latAmp: 0.14, periodMs: 4_800_000, phase: 5.8, speedKnots: 9.3, lengthMeters: 40 }
]

function vesselEnvelopes(timeMs: number): Array<{ key: string; payload: VesselState }> {
  return VESSEL_SEEDS.map((seed) => {
    const t = (timeMs / seed.periodMs) * Math.PI * 2 + seed.phase
    const lon = seed.baseLon + Math.sin(t) * seed.lonAmp
    const lat = seed.baseLat + Math.cos(t * 0.9) * seed.latAmp
    const dLon = Math.cos(t) * seed.lonAmp
    const dLat = -Math.sin(t * 0.9) * 0.9 * seed.latAmp
    return {
      key: `ais/${seed.mmsi}`,
      payload: {
        name: seed.name,
        shipType: seed.shipType,
        longitudeDegrees: lon,
        latitudeDegrees: lat,
        sogKnots: seed.speedKnots,
        cogDegrees: (Math.atan2(dLon, dLat) * 180) / Math.PI,
        headingDegrees: (Math.atan2(dLon, dLat) * 180) / Math.PI,
        navStatus: 0,
        lengthMeters: seed.lengthMeters
      }
    }
  })
}

function craneEnvelopes(timeMs: number, revision: number) {
  return CRANE_BASES.map((base) => ({
    key: `production/${base.code}`,
    payload: simulateCrane(base, timeMs),
    revision
  }))
}

function agvEnvelopes(timeMs: number): Array<{ key: string; payload: AgvState }> {
  return AGV_CODES.map((code, i) => ({
    key: `agv/${code}`,
    payload: simulateAgvOnRoute(AGV_ROUTE, timeMs, 4 + (i % 3) * 1.5, i * 180)
  }))
}

function stackEnvelopes(timeMs: number, revision: number) {
  const rows = ['A', 'B', 'C', 'D']
  const rng = mulberry32(Math.floor(timeMs / 5000))
  const out: Array<{ key: string; payload: Record<string, unknown>; revision: number }> = []
  for (const row of rows) {
    for (let i = 1; i <= 6; i++) {
      const code = `STACK-${row}-${String(i).padStart(3, '0')}`
      if (rng() < 0.08) {
        const statuses = ['inbound', 'outbound', 'maintenance', 'stored']
        out.push({
          key: `yard/${code}`,
          payload: {
            blockCode: code,
            status: statuses[Math.floor(rng() * statuses.length)],
            weightTonnes: Math.round(80 + rng() * 420),
            segment: `分段${row}`
          },
          revision
        })
      }
    }
  }
  return out
}

const TASK_TITLES = [
  'H1498 船坞搭载',
  'H1502 分段涂装',
  'H1489 轴系照光',
  'H1505 分段合拢',
  'H1492 码头舾装',
  'H1510 下水准备'
]

function taskEnvelopes(timeMs: number, revision: number) {
  return TASK_TITLES.map((title, i) => {
    const progress = ((timeMs / 90_000 + i * 0.17) % 1) * 100
    return {
      key: `production/TASK-${i + 1}`,
      payload: {
        taskId: `TASK-${i + 1}`,
        title,
        status: progress >= 100 ? 'done' : progress > 5 ? 'running' : 'queued',
        progressPct: Math.round(progress),
        siteId: SITE_CHANGEXING.id
      },
      revision
    }
  })
}

const ALARM_POOL: Array<{ id: string; message: string; severity: AlarmSeverity }> = [
  { id: 'ALM-1', message: 'CRANE-003 大车行走偏移超限', severity: 'critical' },
  { id: 'ALM-2', message: '堆场 A 区大风预警', severity: 'warning' },
  { id: 'ALM-3', message: 'AGV-05 电量低于 20%', severity: 'warning' },
  { id: 'ALM-4', message: '船坞排水泵切换至备用', severity: 'info' }
]

function alarmEnvelopes(timeMs: number, revision: number) {
  const idx = Math.floor(timeMs / 45_000) % ALARM_POOL.length
  const active = [ALARM_POOL[idx], ALARM_POOL[(idx + 1) % ALARM_POOL.length]]
  return active.map((a) => ({
    key: `production/${a.id}`,
    payload: {
      alarmId: a.id,
      severity: a.severity,
      message: a.message,
      acknowledged: false
    },
    revision
  }))
}

/**
 * Dev/demo Platform Gateway (§34, §81): deterministic generators for every
 * demo contract + the Spatial Fast Path buffer. Production replaces this
 * with the WebSocket transport pointed at the real gateway.
 */
export function createDemoGateway(): DemoGateway {
  const stateBuffer = new SpatialStateBuffer(256)
  let revision = 0
  const historyRing: Array<{ timeMs: number; envelopes: unknown[] }> = []
  let lastHistoryAt = 0

  function generateAll(timeMs: number) {
    revision++
    const envelopes = []
    for (const v of vesselEnvelopes(timeMs)) {
      envelopes.push(envelopeOf(VESSEL_CONTRACT, v.key, timeMs, v.payload, revision))
    }
    for (const c of craneEnvelopes(timeMs, revision)) {
      envelopes.push(envelopeOf(CRANE_CONTRACT, c.key, timeMs, c.payload, revision))
    }
    for (const a of agvEnvelopes(timeMs)) {
      envelopes.push(envelopeOf(AGV_CONTRACT, a.key, timeMs, a.payload, revision))
      // Spatial fast path: poses bypass any reactive system (§35).
      stateBuffer.upsert(a.key, {
        x: a.payload.xMeters,
        y: 0,
        z: a.payload.yMeters,
        qx: 0,
        qy: Math.sin((a.payload.headingDeg * Math.PI) / 360),
        qz: 0,
        qw: Math.cos((a.payload.headingDeg * Math.PI) / 360),
        timeMs,
        frameId: `frame:${SITE_CHANGEXING.id}`
      })
    }
    for (const s of stackEnvelopes(timeMs, revision)) {
      envelopes.push(envelopeOf(STACK_CONTRACT, s.key, timeMs, s.payload, s.revision))
    }
    for (const t of taskEnvelopes(timeMs, revision)) {
      envelopes.push(envelopeOf(PRODUCTION_TASK_CONTRACT, t.key, timeMs, t.payload, t.revision))
    }
    for (const a of alarmEnvelopes(timeMs, revision)) {
      envelopes.push(envelopeOf(PRODUCTION_ALARM_CONTRACT, a.key, timeMs, a.payload, a.revision))
    }
    return envelopes
  }

  const live = createScriptedSource({ kind: 'live' })
  const simulation = createScriptedSource({ kind: 'simulation' })

  return {
    live,
    simulation,
    stateBuffer,
    tick(mode, timeMs) {
      const envelopes = generateAll(timeMs)
      const target = mode === 'simulation' ? simulation : live
      target.emit(envelopes)
      // Record history at 1 Hz.
      if (timeMs - lastHistoryAt >= 1000) {
        lastHistoryAt = timeMs
        historyRing.push({ timeMs, envelopes })
        if (historyRing.length > 1800) historyRing.shift()
      }
    },
    buildHistorySource() {
      return createReplaySource({
        frames: historyRing.map((f) => ({
          timeMs: f.timeMs,
          envelopes: f.envelopes as never[]
        })),
        loop: true
      })
    },
    /** B2：按业务名称搜索船舶（演示数据静态名称表）。 */
    searchVesselsByName(term, limit = 4) {
      const q = term.trim().toLowerCase()
      if (!q) return []
      return VESSEL_SEEDS.filter((v) => v.name.toLowerCase().includes(q))
        .slice(0, limit)
        .map((v) => ({ key: `ais/${v.mmsi}`, label: `${v.name}（船舶）` }))
    },
    /** 历史环范围（时间线 scrubber 边界）。 */
    historyRange() {
      return historyRing.length > 0
        ? { start: historyRing[0].timeMs, end: historyRing[historyRing.length - 1].timeMs }
        : { start: 0, end: 0 }
    },
    dispose() {
      live.dispose()
      simulation.dispose()
    }
  }
}

function envelopeOf(
  contract: string,
  key: string,
  timeMs: number,
  payload: unknown,
  revision: number
) {
  return {
    contract,
    key,
    sourceTime: timeMs,
    ingestTime: Date.now(),
    revision,
    quality: 'good' as const,
    payload
  }
}

export type { Site }
