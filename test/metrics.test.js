/**
 * 交付指标（P3）单测：全是手写夹具，不依赖真实项目。
 *
 * 重点保三条口径：
 * 1. 数据不足 ⇒ null（不是 0），且 unavailable 给出人话原因；
 * 2. 0 是合法值（近 7 天没发布就是 0），不能和 null 混淆；
 * 3. 坏时间行跳过、跨账本不配对——宁可少样本，也不编一个数出来。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { computeMetrics, MAX_LEDGER_LINES, readMetricLedger } from '../lib/metrics.js'

const NOW = Date.parse('2026-11-23T12:00:00.000Z')
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** hoursBefore：NOW 之前多少小时的时间戳。 */
const at = (hoursBefore) => new Date(NOW - hoursBefore * HOUR_MS).toISOString()

const emptyEvidence = (patch = {}) => ({
  receipts: { receipts: [], badLines: 0, missing: true, lastAt: null },
  review: { available: false, reason: 'no-ledger', rounds: null, blocking: null, fixed: null, lastRound: null, issues: [] },
  acceptance: {
    items: [],
    empty: true,
    badJson: false,
    missing: true,
    total: 0,
    withResult: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    stale: 0,
    passWithoutEvidence: 0,
    appliesToCurrent: true,
  },
  ...patch,
})

const metric = (result, key) => result.metrics[key]

const unavailableKeys = (result) => result.unavailable.map((item) => item.metric)

test('交付周期：两个已发布迭代取中位数；未发布迭代不参与', () => {
  const receipts = [
    { at: at(50), iteration_id: 'v1.0', stage: 'requirements', status: 'in_progress' },
    { at: at(46), iteration_id: 'v1.0', stage: 'release', status: 'completed' },
    { at: at(30), iteration_id: 'v1.1', stage: 'implementation', status: 'in_progress' },
    { at: at(20), iteration_id: 'v1.1', stage: 'release', status: 'completed' },
    // 未发布迭代：有回执但没有 release。
    { at: at(10), iteration_id: 'v1.2', stage: 'requirements', status: 'completed' },
    // bootstrap：冷启动不算交付周期。
    { at: at(80), iteration_id: 'bootstrap', stage: 'bootstrap', status: 'completed' },
    { at: at(70), iteration_id: 'bootstrap', stage: 'release', status: 'completed' },
  ]
  const result = computeMetrics({ evidence: emptyEvidence({ receipts: { receipts, badLines: 0 } }), now: NOW })
  const lead = metric(result, 'leadTimeHours')
  assert.equal(lead.value, 7, '(4h + 10h) / 2 = 7h')
  assert.equal(lead.sample, 2)
  assert.equal(lead.unit, 'hours')
  assert.equal(lead.source, 'receipts')
  assert.ok(lead.definition.length <= 40, `definition 要短：${lead.definition}`)
  assert.ok(!unavailableKeys(result).includes('leadTimeHours'))
})

test('交付周期：审计事件与非 completed 的发布不算发布；没有已发布迭代为 null', () => {
  const withAudit = [
    // 只有审计事件 + 一条 release：审计事件不能当"迭代开始"。
    { at: at(9), iteration_id: 'v2.0', stage: 'acceptance', status: 'completed', event: 'acceptance-recheck' },
    { at: at(8), iteration_id: 'v2.0', stage: 'release', status: 'completed' },
    { at: at(6), iteration_id: 'v2.1', stage: 'release', status: 'in_progress' },
  ]
  const auditResult = computeMetrics({ evidence: emptyEvidence({ receipts: { receipts: withAudit } }), now: NOW })
  // 审计事件不算迭代开始：v2.0 的开始就是那条 release 本身 ⇒ 0 小时（若把审计事件当开始会是 1 小时）。
  assert.equal(metric(auditResult, 'leadTimeHours').value, 0)
  assert.equal(metric(auditResult, 'leadTimeHours').sample, 1, '只有 v2.0 算已发布；in_progress 的发布不算')

  const unpublished = computeMetrics({
    evidence: emptyEvidence({
      receipts: { receipts: [{ at: at(3), iteration_id: 'v3.0', stage: 'implementation', status: 'in_progress' }] },
    }),
    now: NOW,
  })
  assert.equal(metric(unpublished, 'leadTimeHours').value, null)
  assert.ok(unavailableKeys(unpublished).includes('leadTimeHours'))
  const gap = unpublished.unavailable.find((item) => item.metric === 'leadTimeHours')
  assert.match(gap.reason, /发布/)
})

test('近 7 天发布：窗口边界含端点，0 是合法值而不是 null', () => {
  const receipts = [
    { at: at(167), iteration_id: 'v1.0', stage: 'release', status: 'completed' },
    { at: new Date(NOW - 7 * DAY_MS).toISOString(), iteration_id: 'v1.0', stage: 'release', status: 'completed' }, // 恰好 7 天
    { at: new Date(NOW - 7 * DAY_MS - 1).toISOString(), iteration_id: 'v1.0', stage: 'release', status: 'completed' }, // 刚出窗
    { at: new Date(NOW + HOUR_MS).toISOString(), iteration_id: 'v1.0', stage: 'release', status: 'completed' }, // 未来
    { at: at(5), iteration_id: 'v1.0', stage: 'release', status: 'in_progress' },
    { at: at(4), iteration_id: 'v1.0', stage: 'implementation', status: 'completed' },
  ]
  const result = computeMetrics({ evidence: emptyEvidence({ receipts: { receipts } }), now: NOW })
  const deploy = metric(result, 'deploymentFrequency7d')
  assert.equal(deploy.value, 2, '窗口内只有两条 completed 的 release')
  assert.equal(deploy.sample, 2)
  assert.equal(deploy.unit, 'releases')

  const none = computeMetrics({ evidence: emptyEvidence(), now: NOW })
  assert.equal(metric(none, 'deploymentFrequency7d').value, 0, '没发布是 0，不是 null')
  assert.ok(!unavailableKeys(none).includes('deploymentFrequency7d'))
})

test('返工率：近 30 天 fix/reject 占比；无数据为 null；坏时间与窗口外不算', () => {
  const history = [
    { at: at(1), round: 1, verdict: 'fix' },
    { at: at(2), round: 2, verdict: 'reject' },
    { at: at(3), round: 3, verdict: 'pass' },
    { at: at(4), round: 4, verdict: 'nothing-to-review' },
    { at: at(24 * 10), round: 5, verdict: 'fix' }, // 10 天前：在 30 天窗口内、不在 7 天窗口内
    { at: at(24 * 40), round: 6, verdict: 'fix' }, // 40 天前，出窗
    { at: '不是时间', round: 7, verdict: 'fix' }, // 坏时间跳过
  ]
  const result = computeMetrics({ evidence: emptyEvidence(), history, now: NOW })
  const rate = metric(result, 'changeFailureRate')
  assert.equal(rate.value, 0.6, '3 / 5')
  assert.equal(rate.sample, 5)
  assert.equal(rate.unit, 'ratio')
  assert.equal(rate.source, 'review-history')
  assert.ok(rate.definition.length <= 40)

  const noHistory = computeMetrics({ evidence: emptyEvidence(), history: [], now: NOW })
  assert.equal(metric(noHistory, 'changeFailureRate').value, null)
  assert.ok(unavailableKeys(noHistory).includes('changeFailureRate'))

  // 窗口可切到 7 天：10 天前那一轮出窗，只剩 4 轮、其中 2 轮未通过。
  const week = computeMetrics({ evidence: emptyEvidence(), history, now: NOW, windowDays: 7 })
  assert.equal(metric(week, 'changeFailureRate').sample, 4)
  assert.equal(metric(week, 'changeFailureRate').value, 0.5)
})

test('修复时长：未通过轮次配最早 fixed 处置取中位数；缺处置为 null', () => {
  const history = [
    { at: at(10), round: 1, verdict: 'fix', ledger: 'ledger-a' },
    { at: at(8), round: 2, verdict: 'reject', ledger: 'ledger-a' },
    { at: at(5), round: 3, verdict: 'pass', ledger: 'ledger-a' },
    { at: at(4), round: 4, verdict: 'fix', ledger: 'ledger-a' }, // 没有处置
  ]
  const dispositions = [
    { at: at(7), round: 1, status: 'deferred', ledger: 'ledger-a' },
    { at: at(6), round: 1, status: 'fixed', ledger: 'ledger-a' }, // 6h 前 ⇒ 距 history 的 10h 前是 4h
    { at: at(0), round: 2, status: 'fixed', ledger: 'ledger-a' }, // 8h
    { at: at(1), round: 3, status: 'fixed', ledger: 'ledger-a' }, // pass 轮不配对
  ]
  const result = computeMetrics({ evidence: emptyEvidence(), history, dispositions, now: NOW })
  const fix = metric(result, 'reviewFixHours')
  assert.equal(fix.value, 6, '(4h + 8h) / 2')
  assert.equal(fix.sample, 2)
  assert.equal(fix.unit, 'hours')
  assert.match(fix.source, /dispositions/)

  const unpaired = computeMetrics({ evidence: emptyEvidence(), history, dispositions: [], now: NOW })
  assert.equal(metric(unpaired, 'reviewFixHours').value, null)
  assert.ok(unavailableKeys(unpaired).includes('reviewFixHours'))
})

test('修复时长：不同账本的同号轮次不能配对（否则会把别人的处置算到自己头上）', () => {
  const history = [{ at: at(10), round: 1, verdict: 'fix', ledger: 'ledger-a' }]
  const dispositions = [{ at: at(6), round: 1, status: 'fixed', ledger: 'ledger-b' }]
  const result = computeMetrics({ evidence: emptyEvidence(), history, dispositions, now: NOW })
  assert.equal(metric(result, 'reviewFixHours').value, null)

  // 不带 ledger 标签的手写数据仍按 round 配对（兼容旧夹具/旧账本）。
  const untagged = computeMetrics({
    evidence: emptyEvidence(),
    history: [{ at: at(10), round: 1, verdict: 'fix' }],
    dispositions: [{ at: at(6), round: 1, status: 'fixed' }],
    now: NOW,
  })
  assert.equal(metric(untagged, 'reviewFixHours').value, 4)
})

test('验收通过率：stale 计入分母但不算通过；分母为 0 是 null', () => {
  const acceptance = { passed: 2, failed: 1, blocked: 1, stale: 1, total: 5, withResult: 4, items: [] }
  const result = computeMetrics({ evidence: emptyEvidence({ acceptance }), now: NOW })
  const rate = metric(result, 'acceptanceRate')
  assert.equal(rate.value, 0.4)
  assert.equal(rate.sample, 5)
  assert.equal(rate.source, 'acceptance')

  const empty = computeMetrics({ evidence: emptyEvidence(), now: NOW })
  assert.equal(metric(empty, 'acceptanceRate').value, null)
  assert.ok(unavailableKeys(empty).includes('acceptanceRate'))
})

test('待修问题库存：检查阻塞 + 验收失败/卡住；null 按 0 但 sample 记已知几路', () => {
  const full = computeMetrics({
    evidence: emptyEvidence({
      review: { available: true, blocking: 2, rounds: 1, fixed: 0 },
      acceptance: { passed: 1, failed: 1, blocked: 3, stale: 0 },
    }),
    now: NOW,
  })
  const inventory = metric(full, 'blockingInventory')
  assert.equal(inventory.value, 6)
  assert.equal(inventory.sample, 2, '检查 + 验收两路已知')
  assert.equal(inventory.unit, 'items')

  const partial = computeMetrics({ evidence: emptyEvidence({ acceptance: { passed: 0, failed: 1, blocked: 2, stale: 0 } }), now: NOW })
  assert.equal(metric(partial, 'blockingInventory').value, 3)
  assert.equal(metric(partial, 'blockingInventory').sample, 1, '只有验收一路已知')

  const nothing = computeMetrics({ evidence: undefined, now: NOW })
  assert.equal(metric(nothing, 'blockingInventory').value, null, '三路都没读到 → null，不是 0 项')
  assert.equal(metric(nothing, 'blockingInventory').sample, 0)
  assert.ok(unavailableKeys(nothing).includes('blockingInventory'))

  // 生产空证据（真实形状：acceptance.missing=true 且 failed/blocked=0）不能把「没读到」当 0
  const emptyShape = computeMetrics({ evidence: emptyEvidence(), now: NOW })
  assert.equal(metric(emptyShape, 'blockingInventory').value, null)
  assert.equal(metric(emptyShape, 'blockingInventory').sample, 0)
  assert.ok(unavailableKeys(emptyShape).includes('blockingInventory'))
})

test('computeMetrics：空输入不抛错，形状固定，generatedAt 用传入的 now', () => {
  const result = computeMetrics({ now: '2026-11-23T12:00:00.000Z' })
  assert.equal(result.generatedAt, '2026-11-23T12:00:00.000Z')
  assert.equal(result.windowDays, 30)
  assert.deepEqual(Object.keys(result.metrics), [
    'leadTimeHours',
    'deploymentFrequency7d',
    'changeFailureRate',
    'reviewFixHours',
    'acceptanceRate',
    'blockingInventory',
  ])
  for (const value of Object.values(result.metrics)) {
    assert.ok(typeof value.definition === 'string' && value.definition.length <= 40)
    assert.ok(typeof value.source === 'string')
    assert.ok(Number.isInteger(value.sample))
  }
  // windowDays 只接受 7/14/30，其它一律回默认 30。
  assert.equal(computeMetrics({ now: NOW, windowDays: 14 }).windowDays, 14)
  assert.equal(computeMetrics({ now: NOW, windowDays: 7 }).windowDays, 7)
  assert.equal(computeMetrics({ now: NOW, windowDays: 99 }).windowDays, 30)
})

// ---------------- readMetricLedger：真实临时目录 ----------------

async function makeProject(prefix) {
  return await mkdtemp(join(tmpdir(), prefix))
}

async function writeLedger(root, dirRel, { history = [], dispositions = [] }) {
  const dir = join(root, dirRel)
  await mkdir(dir, { recursive: true })
  if (history !== null) {
    await writeFile(join(dir, 'history.jsonl'), history.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n') + '\n', 'utf8')
  }
  if (dispositions !== null) {
    await writeFile(
      join(dir, 'dispositions.jsonl'),
      dispositions.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n') + '\n',
      'utf8',
    )
  }
}

const LOCAL_REL = join('.dsh', 'claude-review', 'ledger', 'review')

test('readMetricLedger：本地账本读两行、坏行计数、缺文件不抛错', async () => {
  const root = await makeProject('dc-metrics-local-')
  try {
    await writeLedger(root, LOCAL_REL, {
      history: [{ at: '2026-11-20T10:00:00.000Z', round: 1, verdict: 'fix' }, '{坏行', { at: '2026-11-21T10:00:00.000Z', round: 2, verdict: 'pass' }],
      dispositions: [{ at: '2026-11-20T12:00:00.000Z', round: 1, status: 'fixed' }],
    })
    const ledger = await readMetricLedger(root, { reviewStorage: 'local' })
    assert.equal(ledger.history.length, 2)
    assert.equal(ledger.dispositions.length, 1)
    assert.equal(ledger.badLines, 1)
    assert.equal(ledger.truncated, false)
    assert.deepEqual(ledger.dirs, [LOCAL_REL])
    assert.equal(ledger.history[0].ledger, LOCAL_REL, '行上必须带账本目录标签，避免跨任务错配')

    const missing = await readMetricLedger(join(tmpdir(), `dc-metrics-missing-${Date.now()}`))
    assert.deepEqual(missing, { history: [], dispositions: [], dirs: [], badLines: 0, truncated: false })
    const noPath = await readMetricLedger('')
    assert.deepEqual(noPath.history, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readMetricLedger：trellis 优先，auto 不会把两种账本混在一起', async () => {
  const root = await makeProject('dc-metrics-trellis-')
  const taskRel = join('.trellis', 'tasks', 't1', 'review')
  try {
    await writeLedger(root, taskRel, { history: [{ at: '2026-11-20T10:00:00.000Z', round: 1, verdict: 'fix' }] })
    await writeLedger(root, LOCAL_REL, { history: [{ at: '2026-11-19T10:00:00.000Z', round: 9, verdict: 'pass' }] })

    const auto = await readMetricLedger(root, { reviewStorage: 'auto' })
    assert.deepEqual(auto.dirs, [taskRel], 'trellis 有账本时只用 trellis（与 evidence 口径一致）')
    assert.equal(auto.history.length, 1)
    assert.equal(auto.history[0].round, 1)

    const local = await readMetricLedger(root, { reviewStorage: 'local' })
    assert.deepEqual(local.dirs, [LOCAL_REL])
    assert.equal(local.history[0].round, 9)

    const trellisOnly = await readMetricLedger(root, { reviewStorage: 'trellis' })
    assert.deepEqual(trellisOnly.dirs, [taskRel])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readMetricLedger：最多读 2000 行（取尾部），并标记 truncated', async () => {
  const root = await makeProject('dc-metrics-cap-')
  try {
    const rows = []
    for (let index = 1; index <= MAX_LEDGER_LINES + 5; index += 1) {
      rows.push({ at: '2026-11-20T10:00:00.000Z', round: index, verdict: 'pass' })
    }
    await writeLedger(root, LOCAL_REL, { history: rows, dispositions: null })
    const ledger = await readMetricLedger(root, { reviewStorage: 'local' })
    assert.equal(ledger.history.length, MAX_LEDGER_LINES)
    assert.equal(ledger.truncated, true)
    // 追加写账本：保留的是最近的尾部，round 6..2005。
    assert.equal(ledger.history[0].round, 6)
    assert.equal(ledger.history[ledger.history.length - 1].round, MAX_LEDGER_LINES + 5)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
