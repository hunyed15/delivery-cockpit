/**
 * 周报导出单测：纯函数，不读盘。
 *
 * 重点：
 * - 七个区块都在，标题日期范围跟着 days 走；
 * - null 显示「—」、0 正常显示 0，空数据写「无」而不是补 0；
 * - 表格里的 `|` 与换行必须转义，否则周报会错位；
 * - 数据缺口与代理口径脚注必须出现（不冒充线上指标）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildWeeklyReport, reportFileName } from '../lib/report.js'

const NOW = '2026-11-23T12:00:00.000Z'

function makeMetric(value, overrides = {}) {
  return {
    value,
    unit: 'ratio',
    sample: 2,
    definition: '一句人话口径',
    source: 'receipts',
    ...overrides,
  }
}

function makeMetrics(patch = {}) {
  return {
    generatedAt: NOW,
    windowDays: 30,
    metrics: {
      leadTimeHours: makeMetric(6, { unit: 'hours', source: 'receipts', definition: '已发布迭代从首条动态到发布的中位时长（代理）' }),
      deploymentFrequency7d: makeMetric(0, { unit: 'releases', source: 'receipts', sample: 0, definition: '近 7 天完成的发布记录数（代理）' }),
      changeFailureRate: makeMetric(0.3333, { unit: 'ratio', source: 'review-history', sample: 3, definition: '近 30 天检查轮次未通过的占比（代理）' }),
      reviewFixHours: makeMetric(null, { unit: 'hours', source: 'review-history+dispositions', sample: 0, definition: '检查未通过到首次修复处置的中位时长（代理）' }),
      acceptanceRate: makeMetric(0.5, { unit: 'ratio', source: 'acceptance', sample: 2, definition: '本轮验收通过 / 有结果条目' }),
      blockingInventory: makeMetric(3, { unit: 'items', source: 'review+acceptance', sample: 3, definition: '未处置检查问题 + 验收没通过/卡住' }),
      ...patch.metrics,
    },
    unavailable: patch.unavailable ?? [{ metric: 'reviewFixHours', reason: '还没有能配对的检查处置记录' }],
  }
}

function makeDetail(patch = {}) {
  return {
    project: { name: '客户管理', path: 'C:\\demo\\shop' },
    iteration: { current: 'v1.2', isBootstrap: false },
    nextAction: {
      stageId: 'implementation',
      stageName: '代码开发',
      title: '先把客户列表做出来',
      reason: 'PRD 已定，代码还没开始',
      instruction: '调用 `tdd-loop`：先写测试再实现',
      disabled: false,
      disabledReason: null,
    },
    features: {
      items: [
        { id: 'FR-1', title: '能添加客户 | 并校验', statusLabel: '已完成', acceptance: { passed: 2, total: 2 } },
        { id: 'FR-2', title: '能导出', statusLabel: '进行中', acceptance: { passed: 0, total: 0 } },
      ],
    },
    acceptance: {
      total: 3,
      withResult: 2,
      passed: 1,
      failed: 1,
      blocked: 0,
      stale: 0,
      items: [
        { id: 'A1', title: '能添加客户', result: 'pass', stale: false },
        { id: 'A2', title: '能导出 CSV', result: 'fail', stale: false },
        { id: 'A3', title: '能删除客户', result: null, stale: false },
      ],
    },
    review: { available: true, rounds: 2, blocking: 3, fixed: 1 },
    ledger: {
      receipts: [
        {
          id: 'r-1',
          at: '2026-11-22T03:00:00.000Z',
          stageName: '代码开发',
          status: 'completed',
          summary: '加了客户列表 | 接口',
        },
      ],
    },
    ...patch,
  }
}

test('周报：七个区块与标题日期范围（days=7）', () => {
  const markdown = buildWeeklyReport({ detail: makeDetail(), metrics: makeMetrics(), days: 7, now: NOW })
  assert.ok(markdown.startsWith('# 客户管理 项目周报（2026-11-16 ~ 2026-11-23）'), '标题含项目名与 7 天日期范围')
  for (const heading of ['## 概览', '## 交付指标', '## 功能进度', '## 验收', '## 代码检查', '## 最近动态', '## 下一步']) {
    assert.ok(markdown.includes(heading), `缺少区块 ${heading}`)
  }
  assert.match(markdown, /- 当前迭代：v1\.2/)
  assert.match(markdown, /- 当前阶段：代码开发/)
  assert.match(markdown, /- 下一步：先把客户列表做出来/)
  assert.match(markdown, /- 下一步理由：PRD 已定，代码还没开始/)
})

test('周报：指标表 null 显示 —、0 正常显示、缺口与代理口径脚注齐备', () => {
  const markdown = buildWeeklyReport({ detail: makeDetail(), metrics: makeMetrics(), days: 7, now: NOW })
  assert.match(markdown, /\| 交付周期 \| 6 小时 \|/, '小时类指标带单位')
  assert.match(markdown, /\| 近 7 天发布 \| 0 次 \|/, '0 是合法值，不能被吞成 —')
  assert.match(markdown, /\| 返工率 \| 33% \|/, '比率保留整数百分比')
  assert.match(markdown, /\| 修复时长 \| — \|/, 'null 显示 —')
  assert.match(markdown, /\| 验收通过率 \| 50% \|/)
  assert.match(markdown, /\| 待修问题 \| 3 项 \|/)
  assert.ok(markdown.includes('**数据缺口**'))
  assert.ok(markdown.includes('- 修复时长：还没有能配对的检查处置记录'), '缺口要点名指标与人话原因')
  assert.ok(markdown.includes('「—」表示数据不足，不代表 0'), '必须标注代理口径与 — 的含义')
  assert.ok(markdown.includes('来源：检查记录'), 'source 枚举要换成人话')
  assert.ok(markdown.includes('样本：3'))
})

test('周报：功能/验收/代码检查/最近动态/下一步内容', () => {
  const markdown = buildWeeklyReport({ detail: makeDetail(), metrics: makeMetrics(), days: 7, now: NOW })
  assert.ok(markdown.includes('- 能添加客户 \\| 并校验（已完成）· 验收通过 2/2'), '功能行：名称/状态/验收通过数，管道符转义')
  assert.ok(markdown.includes('- 能导出（进行中）· 还没验收'))
  assert.match(markdown, /- 通过：1；失败：1；卡住：0；待确认：1；需重验：0/)
  assert.ok(markdown.includes('- 能导出 CSV：没通过'))
  assert.ok(markdown.includes('- 能删除客户：待确认'))
  assert.match(markdown, /- 轮次：2/)
  assert.match(markdown, /- 待修问题：3/)
  assert.match(markdown, /- 已修：1/)
  assert.match(markdown, /- 最近结论：还有 3 个问题待修/)
  assert.ok(markdown.includes('- 2026-11-22 03:00 · 代码开发 · 已完成 · 加了客户列表 \\| 接口'))
  assert.ok(markdown.includes('调用 `tdd-loop`：先写测试再实现'), '下一步要带指令原文')
  assert.ok(markdown.includes('```'))
})

test('周报：空数据写无/—，绝不补 0', () => {
  const markdown = buildWeeklyReport({ detail: {}, metrics: null, days: 7, now: NOW })
  assert.match(markdown, /- 项目名：—/)
  assert.match(markdown, /\| 待修问题 \| — \|/) // metrics=null 时库存也不能显示 0
  assert.ok(markdown.includes('## 功能进度\n\n无'))
  assert.ok(markdown.includes('## 最近动态\n\n无'))
  assert.ok(markdown.includes('## 验收\n\n- 通过：—；失败：—；卡住：—；待确认：—；需重验：—'))
  assert.ok(markdown.includes('## 代码检查\n\n- 轮次：—'))
  assert.ok(markdown.includes('还没有算出来') || markdown.includes('还没算出来'))
  assert.ok(!/\| 待修问题 \| 0/.test(markdown), '数据不足不能补成 0')
})

test('周报：days 只认 7/14/30，其它回退 7；30 天标题范围正确', () => {
  const week = buildWeeklyReport({ detail: makeDetail(), metrics: makeMetrics(), days: 3, now: NOW })
  assert.ok(week.startsWith('# 客户管理 项目周报（2026-11-16 ~ 2026-11-23）'), '非法 days 回退 7')
  const fortnight = buildWeeklyReport({ detail: makeDetail(), metrics: makeMetrics(), days: 14, now: NOW })
  assert.ok(fortnight.startsWith('# 客户管理 项目周报（2026-11-09 ~ 2026-11-23）'))
  const month = buildWeeklyReport({ detail: makeDetail(), metrics: makeMetrics(), days: 30, now: NOW })
  assert.ok(month.startsWith('# 客户管理 项目周报（2026-10-24 ~ 2026-11-23）'))
})

test('周报：指标定义里的管道符与新行要转义，表格不被打散', () => {
  const metrics = makeMetrics({
    metrics: { leadTimeHours: makeMetric(6, { unit: 'hours', definition: '甲|乙 定义\n第二行' }) },
  })
  const markdown = buildWeeklyReport({ detail: makeDetail(), metrics, days: 7, now: NOW })
  assert.ok(markdown.includes('甲\\|乙 定义 第二行'), '表格单元格必须转义 | 与换行')
  // 该行恰好 3 个单元格：表头一行 + 数据一行，不能因为 | 多出列。
  const row = markdown.split('\n').find((line) => line.startsWith('| 交付周期 '))
  assert.equal((row.match(/(?<!\\)\|/g) || []).length, 4, `数据行应有 4 个分隔竖线：${row}`)
})

test('周报：需要重新确认的条目单独标出；超过 20 条截断', () => {
  const items = Array.from({ length: 25 }, (_value, index) => ({
    id: `A${index + 1}`,
    title: `验收项 ${index + 1}`,
    result: 'fail',
    stale: false,
  }))
  items.unshift({ id: 'A-stale', title: '曾通过但界面变了', result: 'pass', stale: true })
  const detail = makeDetail({ acceptance: { total: 26, withResult: 26, passed: 1, failed: 25, blocked: 0, stale: 1, items } })
  const markdown = buildWeeklyReport({ detail, metrics: makeMetrics(), days: 7, now: NOW })
  assert.ok(markdown.includes('曾通过但界面变了：通过（需要重新确认）'), 'pass 但需重验要列出并标注')
  assert.ok(markdown.includes('另有 6 条未列出'), '超过 20 条要说明截断')
})

test('reportFileName：项目名做文件名安全处理，日期按 UTC', () => {
  assert.equal(reportFileName('客户管理', NOW), '客户管理-weekly-2026-11-23.md')
  assert.equal(reportFileName('a/b:c*d', NOW), 'a-b-c-d-weekly-2026-11-23.md')
  assert.equal(reportFileName('', NOW), 'project-weekly-2026-11-23.md')
})
