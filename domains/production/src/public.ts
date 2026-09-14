import type { EntityRef } from '@twin/world'
import type { DataEnvelope } from '@twin/world-client'

/** Production task / alarm contracts (Business State Path, §35). */
export const PRODUCTION_TASK_CONTRACT = 'twin.production.task@1'
export const PRODUCTION_ALARM_CONTRACT = 'twin.production.alarm@1'

export type TaskStatus = 'queued' | 'running' | 'paused' | 'done'

export interface ProductionTaskState {
  taskId: string
  title: string
  status: TaskStatus
  progressPct: number
  siteId: string
}

export function taskEntity(taskId: string): EntityRef {
  return { namespace: 'production', id: taskId }
}

export function decodeTask(envelope: DataEnvelope): ProductionTaskState | undefined {
  const p = envelope.payload as Partial<ProductionTaskState> | undefined
  if (!p || typeof p.taskId !== 'string') return undefined
  return {
    taskId: p.taskId,
    title: p.title ?? p.taskId,
    status: p.status ?? 'queued',
    progressPct: Math.min(100, Math.max(0, p.progressPct ?? 0)),
    siteId: p.siteId ?? ''
  }
}

export type AlarmSeverity = 'info' | 'warning' | 'critical'

export interface AlarmState {
  alarmId: string
  severity: AlarmSeverity
  message: string
  sourceEntityKey?: string
  acknowledged?: boolean
}

export function decodeAlarm(envelope: DataEnvelope): AlarmState | undefined {
  const p = envelope.payload as Partial<AlarmState> | undefined
  if (!p || typeof p.alarmId !== 'string') return undefined
  return {
    alarmId: p.alarmId,
    severity: p.severity ?? 'info',
    message: p.message ?? '',
    sourceEntityKey: p.sourceEntityKey,
    acknowledged: p.acknowledged ?? false
  }
}

export interface KpiSummary {
  totalTasks: number
  runningTasks: number
  donePct: number
  openAlarms: number
  criticalAlarms: number
}

export function summarize(
  tasks: readonly ProductionTaskState[],
  alarms: readonly AlarmState[]
): KpiSummary {
  const running = tasks.filter((t) => t.status === 'running').length
  const done = tasks.filter((t) => t.status === 'done').length
  const open = alarms.filter((a) => !a.acknowledged)
  return {
    totalTasks: tasks.length,
    runningTasks: running,
    donePct: tasks.length === 0 ? 0 : Math.round((done / tasks.length) * 100),
    openAlarms: open.length,
    criticalAlarms: open.filter((a) => a.severity === 'critical').length
  }
}
