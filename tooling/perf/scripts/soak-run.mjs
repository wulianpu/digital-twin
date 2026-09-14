#!/usr/bin/env node
/**
 * 24h 内存 plateau soak 自动化执行器（I5-3 / DoD #5）。
 *
 * 在 headless Chromium 中驱动 Portal 的 `?soak=1` 采集通道，
 * 执行 N 轮场景切换循环并落盘 JSON 报告。24h 验收：
 *
 *   node scripts/soak-run.mjs --cycles 1152 --out soak-24h.json
 *
 * 通过标准（§71）：completed === cycles、errors === 0、
 * plateau.detected === true（斜率 ≤ 0.05 MB/轮）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const toolDir = fileURLToPath(new URL('..', import.meta.url))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const baseUrl = arg('url', 'http://127.0.0.1:5173')
const cycles = Number(arg('cycles', 20))
const outPath = arg('out', join(toolDir, 'reports', `soak-${cycles}-cycles.json`))
const cycleIntervalSec = Number(arg('cycleIntervalSec', 0))
const timeoutMin = Number(
  arg('timeoutMin', Math.max(10, Math.ceil((cycles * (2.5 + cycleIntervalSec)) / 60) + 10))
)
const user = arg('user', '张工')

mkdirSync(join(toolDir, 'reports'), { recursive: true })

const browser = await chromium.launch({
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-precise-memory-info'
  ]
})
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })

console.log(`[soak] target=${baseUrl} cycles=${cycles} timeout=${timeoutMin}min`)
await page.goto(`${baseUrl}/?soak=1&soakCycles=${cycles}#/scene/global-ships`)
await page.waitForLoadState('domcontentloaded')

const login = page.getByRole('textbox', { name: '用户名' })
await login.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
if (await login.isVisible().catch(() => false)) {
  await login.fill(user)
  await page.getByRole('button', { name: '登录' }).click()
  console.log('[soak] signed in')
}

// 轮询报告（soak 通道完成后写入 window.__twinSoakReport）
const deadline = Date.now() + timeoutMin * 60_000
let report
while (Date.now() < deadline) {
  report = await page.evaluate(() => window.__twinSoakReport ?? null)
  if (report) break
  await page.waitForTimeout(5000)
}

await browser.close()

if (!report) {
  console.error('✗ soak 报告超时未产出')
  process.exit(1)
}

const pass =
  report.completedCycles === report.totalCycles &&
  (report.samples ?? []).every((s) => !s.error) &&
  report.plateau.detected === true

const summary = {
  cycles: `${report.completedCycles}/${report.totalCycles}`,
  durationMs: report.durationMs,
  plateau: report.plateau,
  firstHeapMB: report.samples?.[0]?.heapMB,
  lastHeapMB: report.samples?.at(-1)?.heapMB,
  errors: (report.samples ?? []).filter((s) => s.error).length,
  pass
}

writeFileSync(outPath, JSON.stringify({ summary, ...report }, null, 2))
console.log('[soak] summary:', JSON.stringify(summary))
console.log(`[soak] report written: ${outPath}`)

if (!pass) {
  console.error('✗ soak 未通过验收标准（§71）')
  process.exit(1)
}
console.log('✓ soak 通过验收标准（§71：plateau，无增长性泄漏）')
