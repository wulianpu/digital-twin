import { createScriptedSource, type ScriptedSource } from '@twin/world-client'
import { VESSEL_CONTRACT } from '@twin/domain-vessel'
import { CRANE_CONTRACT, simulateCrane } from '@twin/domain-crane'
import { AGV_CONTRACT, simulateAgvOnRoute } from '@twin/domain-agv'
import { STACK_CONTRACT } from '@twin/domain-logistics'
import type { Site } from '@twin/world'

export interface StandaloneDemoSource {
  live: ScriptedSource
  tick(timeMs: number): void
  dispose(): void
}

const AGV_ROUTE = [
  { x: -450, y: 240 },
  { x: 430, y: 240 },
  { x: 430, y: -320 },
  { x: 60, y: -320 },
  { x: 60, y: -430 },
  { x: -240, y: -430 },
  { x: -240, y: -200 },
  { x: -450, y: -200 }
]

/** Compact in-app gateway for standalone demos (platform gateway in production). */
export function createDemoDataSource(site: Site): StandaloneDemoSource {
  let revision = 0
  const live = createScriptedSource({ kind: 'live' })

  function tick(timeMs: number): void {
    revision++
    const envelopes = []
    for (let i = 0; i < 6; i++) {
      const code = `AGV-0${i + 1}`
      const s = simulateAgvOnRoute(AGV_ROUTE, timeMs, 4 + (i % 3) * 1.5, i * 180)
      envelopes.push(
        envelope(AGV_CONTRACT, code, timeMs, { ...s, taskId: s.taskId }, revision)
      )
    }
    const craneBases = [
      { code: 'CRANE-001', gantryTrackMeters: 380, boomHeadingDeg: 0 },
      { code: 'CRANE-002', gantryTrackMeters: 380, boomHeadingDeg: 0 }
    ]
    for (const base of craneBases) {
      envelopes.push(
        envelope(
          CRANE_CONTRACT,
          `production/${base.code}`,
          timeMs,
          simulateCrane(base, timeMs),
          revision
        )
      )
    }
    const rows = ['A', 'B', 'C', 'D']
    for (const row of rows) {
      for (let i = 1; i <= 6; i++) {
        if ((i + row.charCodeAt(0) + Math.floor(timeMs / 5000)) % 7 === 0) {
          const code = `STACK-${row}-${String(i).padStart(3, '0')}`
          envelopes.push(
            envelope(STACK_CONTRACT, `yard/${code}`, timeMs, {
              blockCode: code,
              status: (['inbound', 'outbound', 'stored'] as const)[i % 3],
              weightTonnes: 120 + i * 37,
              segment: `分段${row}`
            }, revision)
          )
        }
      }
    }
    envelopes.push(
      envelope(VESSEL_CONTRACT, 'ais/412345001', timeMs, {
        name: `${site.name}·泊位试验船`,
        shipType: 'crane-vessel',
        longitudeDegrees: site.origin.longitudeDegrees + 0.004,
        latitudeDegrees: site.origin.latitudeDegrees - 0.006,
        sogKnots: 0.2,
        cogDegrees: 90,
        headingDegrees: 45,
        lengthMeters: 216
      }, revision)
    )
    live.emit(envelopes)
  }

  return {
    live,
    tick,
    dispose: () => live.dispose()
  }
}

function envelope(
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
