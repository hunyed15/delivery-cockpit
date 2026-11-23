/**
 * 项目周报（Markdown 导出）：纯函数，无 I/O。
 *
 * 输入是面板已经算好的两份数据：`detail`（lib/model.js 的详情模型）与
 * `metrics`（lib/metrics.js 的交付指标）。周报不重新读盘、不重新推导状态，
 * 只做排版与空缺标注：
 * - 空数据写「无」/「—」，绝不补 0（"没读到"和"是 0"是两件事）；
 * - 指标一律标注"代理口径"，并在表后列出数据缺口；
 * - 表格单元格里的 `|` 与换行必须转义，否则周报会被渲染成错位的表。
 */

/** 允许的周报窗口（天）。路由层与这里共用同一份枚举。 */
export const REPORT_DAYS = [7, 14, 30]
export const DEFAULT_REPORT_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_ACCEPTANCE_LINES = 20
const MAX_RECEIPT_LINES = 10

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''
const asArray = (value) => (Array.isArray(value) ? value : [])
const intOrNull = (value) => (Number.isInteger(value) ? value : null)

function toMillis(value) {
  if (value instanceof Date) {
    const ms = value.getTime()
    if (Number.isFinite(ms)) return ms
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value.trim())
    if (Number.isFinite(ms)) return ms
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return Date.now()
}

function normalizeDays(value) {
  const days = Number(value)
  return REPORT_DAYS.includes(days) ? days : DEFAULT_REPORT_DAYS
}

/** 日期统一按 UTC 取，保证同一份数据在任何时区导出的标题/文件名一致。 */
function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

function utcStamp(ms) {
  const iso = new Date(ms).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
}

/** 单行文本：换行压成空格、表格管道符转义；空值统一成「—」。 */
function inline(value, fallback = '—') {
  const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value)
  if (text === '') return fallback
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
}

const cell = (value, fallback = '—') => inline(value, fallback)

/** 数字去掉多余 0：1.50 → 1.5，2 → 2。非数字返回「—」。 */
function numberText(value) {
  if (!Number.isFinite(value)) return '—'
  return String(Number(value.toFixed(2)))
}

function formatHours(value) {
  if (!Number.isFinite(value)) return '—'
  if (value >= 48) return `${numberText(value / 24)} 天`
  return `${numberText(value)} 小时`
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '—'
  return `${Math.round(value * 100)}%`
}

const METRIC_ROWS = [
  { key: 'leadTimeHours', label: '交付周期', format: formatHours },
  { key: 'deploymentFrequency7d', label: '近 7 天发布', format: (value) => `${numberText(value)} 次` },
  { key: 'changeFailureRate', label: '返工率', format: formatPercent },
  { key: 'reviewFixHours', label: '修复时长', format: formatHours },
  { key: 'acceptanceRate', label: '验收通过率', format: formatPercent },
  { key: 'blockingInventory', label: '待修问题', format: (value) => `${numberText(value)} 项` },
]

/** source 是机器枚举；周报里换成人话，不把内部字段名丢给人看。 */
const SOURCE_TEXT = {
  receipts: '项目动态',
  'review-history': '检查记录',
  'review-history+dispositions': '检查记录 + 处置',
  acceptance: '验收表',
  'review+acceptance': '检查 + 验收',
}

const STATUS_TEXT = {
  in_progress: '进行中',
  completed: '已完成',
  blocked: '卡住',
  failed: '失败',
  dropped: '已放弃',
}

const RESULT_TEXT = {
  pass: '通过',
  fail: '没通过',
  blocked: '卡住',
}

/** 文件名：项目名里的路径分隔符/控制字符换成 -，过长截断；空名回退 project。 */
export function reportFileName(projectName, now) {
  const raw = typeof projectName === 'string' ? projectName : ''
  const safe = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  const base = safe === '' ? 'project' : safe
  return `${base}-weekly-${utcDay(toMillis(now))}.md`
}

function overviewSection(detail, action, lines) {
  const project = isObject(detail.project) ? detail.project : {}
  const iteration = isObject(detail.iteration) ? detail.iteration : {}
  const current = isNonEmptyString(iteration.current) ? iteration.current.trim() : '—'
  const stage = isNonEmptyString(action.stageName) ? action.stageName.trim() : '—'

  lines.push('## 概览', '')
  lines.push(`- 项目名：${inline(project.name, '—')}`)
  lines.push(`- 当前迭代：${inline(current, '—')}`)
  lines.push(`- 当前阶段：${inline(stage, '—')}`)
  lines.push(`- 下一步：${inline(action.title, '暂时没有下一步建议')}`)
  if (isNonEmptyString(action.reason)) lines.push(`- 下一步理由：${inline(action.reason)}`)
  if (action.disabled === true && isNonEmptyString(action.disabledReason)) {
    lines.push(`- 下一步暂不可执行：${inline(action.disabledReason)}`)
  }
  lines.push('')
}

function metricsSection(metrics, lines) {
  lines.push('## 交付指标', '')
  const hasMetrics = isObject(metrics) && isObject(metrics.metrics)
  const box = isObject(metrics) ? metrics : {}
  const values = isObject(box.metrics) ? box.metrics : {}

  lines.push('| 指标 | 值 | 说明/来源 |', '| --- | --- | --- |')
  const labels = new Map(METRIC_ROWS.map((row) => [row.key, row.label]))
  for (const row of METRIC_ROWS) {
    const metric = isObject(values[row.key]) ? values[row.key] : null
    const value = metric !== null && Number.isFinite(metric.value) ? row.format(metric.value) : '—'
    const definition = metric !== null && isNonEmptyString(metric.definition) ? metric.definition.trim() : ''
    const source = metric !== null && isNonEmptyString(metric.source) ? SOURCE_TEXT[metric.source] ?? metric.source : ''
    const sample = metric !== null ? intOrNull(metric.sample) : null
    const details = []
    if (definition !== '') details.push(definition)
    if (source !== '') details.push(`来源：${source}`)
    if (sample !== null) details.push(`样本：${sample}`)
    lines.push(`| ${row.label} | ${value} | ${cell(details.length > 0 ? details.join('；') : '还没算出来')} |`)
  }
  lines.push('')

  lines.push('**数据缺口**', '')
  const gaps = []
  const seen = new Set()
  for (const gap of asArray(box.unavailable).filter(isObject)) {
    const key = typeof gap.metric === 'string' ? gap.metric : ''
    seen.add(key)
    gaps.push({ label: labels.get(key) ?? key, reason: gap.reason })
  }
  if (!hasMetrics) {
    gaps.push({ label: '交付指标', reason: '还没有算出来（随项目动态与检查记录补齐后出现）' })
  } else {
    // 契约里六项指标都应该在；缺项要说出来（而不是表格里一个孤零零的 —）。
    for (const row of METRIC_ROWS) {
      if (!isObject(values[row.key]) && !seen.has(row.key)) gaps.push({ label: row.label, reason: '还没算出来' })
    }
  }
  if (gaps.length === 0) {
    lines.push('- 无')
  } else {
    for (const gap of gaps) lines.push(`- ${inline(gap.label, '指标')}：${inline(gap.reason, '数据不足')}`)
  }
  lines.push('')
  lines.push('> 指标为代理口径（来自项目本地记录）；「—」表示数据不足，不代表 0。')
  lines.push('')
}

function featuresSection(detail, lines) {
  const features = isObject(detail.features) ? detail.features : {}
  const items = asArray(features.items).filter(isObject)
  lines.push('## 功能进度', '')
  if (items.length === 0) {
    lines.push('无')
    lines.push('')
    return
  }
  for (const item of items) {
    const acceptance = isObject(item.acceptance) ? item.acceptance : {}
    const passed = intOrNull(acceptance.passed)
    const total = intOrNull(acceptance.total)
    const acceptanceText =
      total === null || total === 0
        ? '还没验收'
        : `验收通过 ${passed ?? 0}/${total}`
    lines.push(`- ${inline(item.title, '未命名功能')}（${inline(item.statusLabel, '—')}）· ${acceptanceText}`)
  }
  lines.push('')
}

function acceptanceSection(detail, lines) {
  const acceptance = isObject(detail.acceptance) ? detail.acceptance : {}
  const passed = intOrNull(acceptance.passed)
  const failed = intOrNull(acceptance.failed)
  const blocked = intOrNull(acceptance.blocked)
  const stale = intOrNull(acceptance.stale)
  const total = intOrNull(acceptance.total)
  const withResult = intOrNull(acceptance.withResult)
  const pending =
    total !== null && withResult !== null && total >= withResult ? total - withResult : null

  const countText = (value) => (value === null ? '—' : String(value))
  lines.push('## 验收', '')
  lines.push(
    `- 通过：${countText(passed)}；失败：${countText(failed)}；卡住：${countText(blocked)}；` +
      `待确认：${countText(pending)}；需重验：${countText(stale)}`,
  )

  const failedItems = asArray(acceptance.items).filter((item) => {
    if (!isObject(item)) return false
    return item.result !== 'pass' || item.stale === true
  })
  if (failedItems.length === 0) {
    lines.push('- 未通过 / 待处理条目：无')
  } else {
    lines.push('- 未通过 / 待处理条目：')
    for (const item of failedItems.slice(0, MAX_ACCEPTANCE_LINES)) {
      const result = typeof item.result === 'string' ? RESULT_TEXT[item.result] ?? item.result : '待确认'
      const staleNote = item.stale === true ? '（需要重新确认）' : ''
      lines.push(`  - ${inline(item.title, '未命名验收项')}：${inline(result, '待确认')}${staleNote}`)
    }
    if (failedItems.length > MAX_ACCEPTANCE_LINES) {
      lines.push(`  - 另有 ${failedItems.length - MAX_ACCEPTANCE_LINES} 条未列出`)
    }
  }
  lines.push('')
}

function reviewConclusion(review) {
  if (!isObject(review) || review.available !== true) return '还没读到检查记录'
  const rounds = intOrNull(review.rounds)
  if (rounds === null) return '还没读到检查轮次'
  if (rounds === 0) return '还没有跑过检查'
  const blocking = intOrNull(review.blocking)
  if (blocking === null) return '最近一轮的问题数还没读到'
  return blocking > 0 ? `还有 ${blocking} 个问题待修` : '上一轮没有待修问题'
}

function reviewSection(detail, lines) {
  const review = isObject(detail.review) ? detail.review : {}
  const countText = (value) => (intOrNull(value) === null ? '—' : String(value))
  lines.push('## 代码检查', '')
  lines.push(`- 轮次：${countText(review.rounds)}`)
  lines.push(`- 待修问题：${countText(review.blocking)}`)
  lines.push(`- 已修：${countText(review.fixed)}`)
  lines.push(`- 最近结论：${inline(reviewConclusion(review), '—')}`)
  lines.push('')
}

function receiptsSection(detail, lines) {
  const ledger = isObject(detail.ledger) ? detail.ledger : {}
  const receipts = asArray(ledger.receipts).filter(isObject)
  lines.push('## 最近动态', '')
  if (receipts.length === 0) {
    lines.push('无')
    lines.push('')
    return
  }
  for (const receipt of receipts.slice(0, MAX_RECEIPT_LINES)) {
    const at = typeof receipt.at === 'string' ? Date.parse(receipt.at) : Number.NaN
    const when = Number.isFinite(at) ? utcStamp(at) : '—'
    const stage = isNonEmptyString(receipt.stageName) ? receipt.stageName.trim() : '这一步'
    const status = isNonEmptyString(receipt.status) ? STATUS_TEXT[receipt.status] ?? receipt.status : '—'
    lines.push(`- ${when} · ${inline(stage, '这一步')} · ${inline(status, '—')} · ${inline(receipt.summary, '（没有摘要）')}`)
  }
  lines.push('')
}

function nextStepSection(action, lines) {
  lines.push('## 下一步', '')
  lines.push(`- 标题：${inline(action.title, '暂时没有下一步建议')}`)
  lines.push(`- 理由：${inline(action.reason, '—')}`)
  const instruction = isNonEmptyString(action.instruction) ? action.instruction.trim() : ''
  if (instruction !== '') {
    // 指令里可能出现 ```，用更长的围栏兜住，避免提前结束代码块。
    const fence = instruction.includes('```') ? '````' : '```'
    lines.push('', '指令：', '', fence, instruction, fence)
  } else if (action.disabled === true && isNonEmptyString(action.disabledReason)) {
    lines.push(`- 暂时没有可执行指令：${inline(action.disabledReason)}`)
  } else {
    lines.push('- 暂时没有可执行指令。')
  }
  lines.push('')
}

/**
 * 生成周报 Markdown。
 *
 * `{ detail, metrics, days, now }`：
 * - detail 是 lib/model.js 的详情模型（可为空）；
 * - metrics 是 lib/metrics.js 的 computeMetrics 结果（可为 null）；
 * - days 只接受 7 / 14 / 30，其它值回退 7；
 * - now 决定标题里的日期范围与文件名日期。
 */
export function buildWeeklyReport({ detail, metrics, days, now } = {}) {
  const nowMs = toMillis(now)
  const windowDays = normalizeDays(days)
  const startMs = nowMs - windowDays * DAY_MS
  const safeDetail = isObject(detail) ? detail : {}
  const project = isObject(safeDetail.project) ? safeDetail.project : {}
  const action = isObject(safeDetail.nextAction) ? safeDetail.nextAction : {}
  const name = inline(project.name, '项目')

  const lines = [`# ${name} 项目周报（${utcDay(startMs)} ~ ${utcDay(nowMs)}）`, '']
  overviewSection(safeDetail, action, lines)
  metricsSection(metrics, lines)
  featuresSection(safeDetail, lines)
  acceptanceSection(safeDetail, lines)
  reviewSection(safeDetail, lines)
  receiptsSection(safeDetail, lines)
  nextStepSection(action, lines)

  return `${lines.join('\n')}\n`
}
