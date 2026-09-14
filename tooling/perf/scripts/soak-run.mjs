#!/usr/bin/env node
/**
 * 24h 内存 plateau soak 自动化执行器（I5-3 / DoD #5，A2 健壮化重写）。
 *
 * 设计：**node 侧逐轮驱动**——每轮由本进程控制（hash 导航切换场景 →
 * 页面内单步执行 → node 采样 heap），页面崩溃/导航异常时自动重建页面并
 * 续跑，周期计数不丢失。24h 验收：
 *
 *   node scripts/soak-run.mjs --url http://localhost:8080 \
 *     --cycles 1152 --cycleIntervalSec 73 --out soak-24h.json
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

const baseUrl = arg('url', 'http://localhost:8080')
const cycles = Number(arg('cycles', 20))
const cycleIntervalSec = Number(arg('cycleIntervalSec', 0))
const outPath = arg('out', join(toolDir, 'reports', `soak-${cycles}.json`))
const user = arg('user', '张工')
// 24h 墙钟：1152 轮 × (1.5s 工作 + 73s 间隔) ≈ 23.9h；超时 = 轮数 × 单轮上限 × 1.5
const _timeoutMin = Number(
  arg('timeoutMin', Math.ceil((cycles * (1500 + cycleIntervalSec * 1000)) / 60000 * 1.5) + 15)
)

mkdirSync(join(toolDir, 'reports'), { recursive: true })

function analyze(samples) {
  const pts = samples.filter((s) => s.heapMB !== undefined)
  const n = pts.length
  if (n < 2) return { detected: false, slopeMBPerCycle: Number.NaN }
  const mx = pts.reduce((a, p) => a + p.cycle, 0) / n
  const my = pts.reduce((a, p) => a + p.heapMB, 0) / n
  let num = 0
  let den = 0
  for (const p of pts) {
    num += (p.cycle - mx) * (p.heapMB - my)
    den += (p.cycle - mx) ** 2
  }
  const slope = den === 0 ? Number.NaN : num / den
  const half = Math.floor(n / 2)
  const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y.heapMB, 0) / a.length) * 10) / 10 : undefined)
  return {
    detected: Number.isFinite(slope) && slope <= 0.05, // §71：仅增长性泄漏判不稳
    slopeMBPerCycle: Math.round(slope * 1000) / 1000,
    firstHalfAvgMB: avg(pts.slice(0, half)),
    secondHalfAvgMB: avg(pts.slice(half)),
    thresholdMBPerCycle: 0.05
  }
}

const browser = await chromium.launch({
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-precise-memory-info'
  ]
})
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } })

let page
async function ensurePage() {
  try {
    if (page && !page.isClosed()) {
      await page.evaluate(() => 1) // 存活探测
      return
    }
  } catch {
    /* 页面已失效，重建 */
  }
  console.log('[soak] (re)creating page…')
  page = await context.newPage()
  await page.goto(`${baseUrl}/?soakStep=1#/scene/global-ships`)
  await page.waitForLoadState('domcontentloaded')
  const login = page.getByRole('textbox', { name: '用户名' })
  await login.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
  if (await login.isVisible().catch(() => false)) {
    await login.fill(user)
    await page.getByRole('button', { name: '登录' }).click()
    console.log('[soak] signed in')
    await page.waitForTimeout(2500)
  }
  // 等待步进接口就绪（应用挂载后注册）
  for (let i = 0; i < 20; i++) {
    if (await page.evaluate(() => typeof window.__twinSoakStep === 'function').catch(() => false)) break
    await page.waitForTimeout(500)
  }
}

async function stepCycle() {
  await ensurePage()
  return page.evaluate(() => window.__twinSoakStep())
}

const startedAt = Date.now()
const samples = []
let consecutiveFailures = 0

for (let cycle = 1; cycle <= cycles; cycle++) {
  let error
  let heapMB
  try {
    heapMB = await stepCycle()
    consecutiveFailures = 0
  } catch (e) {
    error = String(e?.message ?? e).slice(0, 200)
    consecutiveFailures++
    if (consecutiveFailures >= 5) {
      console.error(`[soak] 连续 ${consecutiveFailures} 轮失败，中止`)
      break
    }
  }
  samples.push({
    cycle,
    tMs: Date.now() - startedAt,
    heapMB,
    ...(error !== undefined ? { error } : {})
  })
  if (cycle % 25 === 0) {
    console.log(`[soak] ${cycle}/${cycles} 轮（heap ${heapMB ?? '?'}MB）`)
  }
  if (cycleIntervalSec > 0 && cycle < cycles) {
    await new Promise((r) => setTimeout(r, cycleIntervalSec * 1000))
  }
}

await browser.close()

const completed = samples.filter((s) => !s.error).length
const plateau = analyze(samples)
const pass =
  completed === cycles &&
  samples.every((s) => !s.error) &&
  plateau.detected === true

const summary = {
  cycles: `${completed}/${cycles}`,
  durationMs: Date.now() - startedAt,
  plateau,
  firstHeapMB: samples[0]?.heapMB,
  lastHeapMB: samples.at(-1)?.heapMB,
  errors: samples.filter((s) => s.error).length,
  pass
}

writeFileSync(outPath, JSON.stringify({ summary, samples, plateau }, null, 2))
console.log('[soak] summary:', JSON.stringify(summary))
console.log(`[soak] report written: ${outPath}`)

if (!pass) {
  console.error('✗ soak 未通过验收标准（§71）')
  process.exit(1)
}
console.log('✓ soak 通过验收标准（§71：plateau，无增长性泄漏）')
