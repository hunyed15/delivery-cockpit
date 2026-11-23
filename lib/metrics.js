/**
 * 交付指标（P3）：DORA 口径的**代理指标**。
 *
 * 为什么叫代理：面板只有项目本地的三个数据源（执行回执 / 审核账本 / 验收表），
 * 拿不到 CI、发布系统和线上监控。于是：
 * - 交付周期 = 迭代内首条回执 → 该迭代 release 回执的时间差（不是"提交到部署"）；
 * - 发布频率 = 近 7 天 release+completed 回执数（不是真实部署次数）；
 * - 变更返工率 = 近 30 天审核轮次里 fix/reject 的占比（不是线上故障率）；
 * - 修复时长 = 审核未通过 → 首次 fixed 处置的中位时长（不是线上修复时长）。
 *
 * 三条硬口径（与 lib/evidence.js 一致）：
 * 1. 绝不造假：样本不足就是 value=null，并在 unavailable 里写明原因；不补 0。
 * 2. 0 是合法值：近 7 天一次发布都没有 ⇒ value=0（"没有"本身就是结论），但 sample=0。
 * 3. 时间解析不出来的行直接跳过，不猜、不用生成时间兜底。
 *
 * 纯函数为主：readMetricLedger 是唯一读盘入口（容忍坏行/缺文件），computeMetrics 无 I/O。
 */

import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { BOOTSTRAP_ITERATION, normalizeStage } from './receipts.js'

/** 默认窗口（天）：30 天口径的指标（返工率）。7 天口径固定用于发布频率。 */
export const DEFAULT_WINDOW_DAYS = 30
export const DEPLOYMENT_WINDOW_DAYS = 7
const SUPPORTED_WINDOW_DAYS = new Set([7, 30])

/** 单个账本最多读这么多行（尾部优先：账本是追加写，最近的记录才影响指标）。 */
export const MAX_LEDGER_LINES = 2000
/** 单个账本文件读取上限：超过就只读尾部，置 truncated。 */
export const MAX_LEDGER_BYTES = 2 * 1024 * 1024
const MAX_TASK_DIRS = 200

const LOCAL_REVIEW_REL = join('.dsh', 'claude-review', 'ledger', 'review')
const TRELLIS_TASKS_REL = join('.trellis', 'tasks')
const REVIEW_STORAGE_MODES = new Set(['auto', 'trellis', 'local'])

const DAY_MS = 24 * 60 * 60 * 1000
const REVIEW_FAIL_VERDICTS = new Set(['fix', 'reject'])

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''

/** 时间字符串 → 毫秒；解析失败返回 null（调用方跳过该行，绝不拿生成时间冒充）。 */
function parseTime(value) {
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? ms : null
  }
  if (typeof value !== 'string' || value.trim() === '') return null
  const ms = Date.parse(value.trim())
  return Number.isFinite(ms) ? ms : null
}

function toMillis(value) {
  const parsed = parseTime(value)
  if (parsed !== null) return parsed
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return Date.now()
}

function intOrNull(value) {
  return Number.isInteger(value) ? value : null
}

/** 四舍五入到指定小数位：指标是给人看的，保留 2 位就够，且避免浮点尾巴。 */
function round(value, digits) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** 中位数：偶数个取中间两个的平均；空集返回 null（不是 0）。 */
function median(values) {
  const sorted = values.filter((item) => Number.isFinite(item)).sort((left, right) => left - right)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function normalizeStorageMode(value) {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : 'auto'
  return REVIEW_STORAGE_MODES.has(mode) ? mode : 'auto'
}

async function statKind(path) {
  try {
    const info = await stat(path)
    return { exists: true, isFile: info.isFile(), size: info.size }
  } catch {
    // 缺文件（ENOENT）/ 权限错 / 路径类型异常都按"没有这份数据"处理：指标少样本，不编造。
    return { exists: false, isFile: false, size: 0 }
  }
}

/**
 * 读一个 jsonl 账本文件：坏行跳过并计数，缺文件/读失败返回空数组。
 * 行数上限 MAX_LEDGER_LINES（取尾部）；字节超限只读尾部并置 truncated。
 */
async function readLedgerFile(path) {
  const kind = await statKind(path)
  if (!kind.exists || !kind.isFile) return { rows: [], badLines: 0, truncated: false, present: false }

  let text = null
  let truncated = false
  try {
    if (kind.size > MAX_LEDGER_BYTES) {
      const handle = await open(path, 'r')
      try {
        const buffer = Buffer.alloc(MAX_LEDGER_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, MAX_LEDGER_BYTES, kind.size - MAX_LEDGER_BYTES)
        text = buffer.subarray(0, bytesRead).toString('utf8')
      } finally {
        await handle.close()
      }
      // 截断点可能落在半行：丢掉第一行，宁可少一条，也不把半行算成坏行。
      const firstBreak = text.indexOf('\n')
      text = firstBreak >= 0 ? text.slice(firstBreak + 1) : ''
      truncated = true
    } else {
      text = await readFile(path, 'utf8')
    }
  } catch {
    // 读失败不等于"账本是空的"，但指标层只有"空数组"这个诚实出口：不猜、不抛。
    return { rows: [], badLines: 0, truncated: false, present: true }
  }

  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  const kept = lines.length > MAX_LEDGER_LINES ? lines.slice(lines.length - MAX_LEDGER_LINES) : lines
  if (kept.length < lines.length) truncated = true

  const rows = []
  let badLines = 0
  for (const line of kept) {
    let parsed = null
    try {
      parsed = JSON.parse(line)
    } catch {
      parsed = null
    }
    if (!isObject(parsed)) {
      badLines += 1
      continue
    }
    rows.push(parsed)
  }
  return { rows, badLines, truncated, present: true }
}

/** 读一份审核账本目录（history + dispositions），行上打 ledger 标签避免跨任务错配。 */
async function readLedgerDir(root, dirRel) {
  const history = await readLedgerFile(join(root, dirRel, 'history.jsonl'))
  const dispositions = await readLedgerFile(join(root, dirRel, 'dispositions.jsonl'))
  const tag = (row) => ({ ...row, ledger: dirRel })
  return {
    dir: dirRel,
    history: history.rows.map(tag),
    dispositions: dispositions.rows.map(tag),
    badLines: history.badLines + dispositions.badLines,
    truncated: history.truncated || dispositions.truncated,
    present: history.present || dispositions.present,
  }
}

/** Trellis 每任务一份账本：扫 .trellis/tasks/<task>/review，最多 200 个任务目录。 */
async function listTrellisLedgerDirs(root) {
  const tasksDir = join(root, TRELLIS_TASKS_REL)
  const kind = await statKind(tasksDir)
  if (!kind.exists) return []
  let entries
  try {
    entries = await readdir(tasksDir, { withFileTypes: true })
  } catch {
    return []
  }
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_TASK_DIRS)

  const dirs = []
  for (const name of names) {
    const dirRel = join(TRELLIS_TASKS_REL, name, 'review')
    const hasHistory = await statKind(join(root, dirRel, 'history.jsonl'))
    const hasDispositions = hasHistory.exists ? false : (await statKind(join(root, dirRel, 'dispositions.jsonl'))).exists
    if (hasHistory.exists || hasDispositions) dirs.push(dirRel)
  }
  return dirs
}

/**
 * 读交付指标用的审核账本（只读，容忍坏行/缺文件）。
 *
 * 返回 `{ history, dispositions, dirs, badLines, truncated }`：
 * - history / dispositions 是解析成功的行（行上带 `ledger` 目录标签）；
 * - 定位不到账本 ⇒ 两个空数组（不猜目录、不扫其它位置）；
 * - reviewStorage 口径与 lib/evidence.js 一致：trellis 优先，没有再回退本地账本。
 *
 * 返回的是**对象**而不是数组：computeMetrics 需要 history 与 dispositions 两份数据配对。
 */
export async function readMetricLedger(projectPath, options = {}) {
  const emptyLedger = () => ({ history: [], dispositions: [], dirs: [], badLines: 0, truncated: false })
  if (!isNonEmptyString(projectPath)) return emptyLedger()
  let root = null
  try {
    root = resolve(projectPath.trim())
  } catch {
    return emptyLedger()
  }
  const workspace = await statKind(root)
  if (!workspace.exists || workspace.isFile) return emptyLedger()

  const mode = normalizeStorageMode(options?.reviewStorage)
  let dirs = []
  if (mode === 'trellis' || mode === 'auto') {
    dirs = await listTrellisLedgerDirs(root)
  }
  if (dirs.length === 0 && (mode === 'local' || mode === 'auto')) {
    const hasHistory = (await statKind(join(root, LOCAL_REVIEW_REL, 'history.jsonl'))).exists
    const hasDispositions = hasHistory ? false : (await statKind(join(root, LOCAL_REVIEW_REL, 'dispositions.jsonl'))).exists
    if (hasHistory || hasDispositions) dirs = [LOCAL_REVIEW_REL]
  }
  if (dirs.length === 0) return emptyLedger()

  const history = []
  const dispositions = []
  const loadedDirs = []
  let badLines = 0
  let truncated = false
  for (const dirRel of dirs) {
    const ledger = await readLedgerDir(root, dirRel)
    if (!ledger.present) continue
    history.push(...ledger.history)
    dispositions.push(...ledger.dispositions)
    loadedDirs.push(dirRel)
    badLines += ledger.badLines
    truncated = truncated || ledger.truncated
  }

  return { history, dispositions, dirs: loadedDirs, badLines, truncated }
}

/** 迭代 → 首条回执时间 + 该迭代 release 回执时间（排除 bootstrap 与审计事件）。 */
function collectIterationSpans(receipts) {
  const spans = new Map()
  for (const receipt of receipts) {
    if (!isObject(receipt)) continue
    // 审计事件（验收失效留痕等）不是进度，也不该参与交付周期。
    if (isNonEmptyString(receipt.event)) continue
    if (!isNonEmptyString(receipt.iteration_id)) continue
    const iterationId = receipt.iteration_id.trim()
    if (iterationId === BOOTSTRAP_ITERATION) continue
    const stage = normalizeStage(receipt.stage)
    if (stage === null) continue
    const at = parseTime(receipt.at)
    if (at === null) continue

    const span = spans.get(iterationId) ?? { firstAt: null, releaseAt: null }
    if (span.firstAt === null || at < span.firstAt) span.firstAt = at
    // 同一迭代可能有多条 release 回执：取最后一条 completed 作为"真的发出去了"的时刻。
    if (stage === 'release' && receipt.status === 'completed' && (span.releaseAt === null || at > span.releaseAt)) {
      span.releaseAt = at
    }
    spans.set(iterationId, span)
  }
  return spans
}

/**
 * 计算交付指标。纯函数，无 I/O。
 *
 * 入参：`{ evidence, history, dispositions, now, windowDays }`
 * - evidence 是 lib/evidence.js 的输出（只用到 receipts / review / acceptance）；
 * - history / dispositions 是 readMetricLedger 的两份数组（可空）；
 * - now 可以是 Date / 时间字符串 / 毫秒；解析失败回退当前时间；
 * - windowDays 只接受 7 / 30，默认 30（影响返工率窗口）。
 */
export function computeMetrics({ evidence, history, dispositions, now, windowDays } = {}) {
  const nowMs = toMillis(now)
  const generatedAt = new Date(nowMs).toISOString()
  const requestedWindow = Number(windowDays)
  const window = SUPPORTED_WINDOW_DAYS.has(requestedWindow) ? requestedWindow : DEFAULT_WINDOW_DAYS

  const ev = isObject(evidence) ? evidence : {}
  const receiptList = Array.isArray(ev.receipts?.receipts) ? ev.receipts.receipts : []
  const historyRows = Array.isArray(history) ? history : []
  const dispositionRows = Array.isArray(dispositions) ? dispositions : []
  const review = isObject(ev.review) ? ev.review : {}
  const acceptance = isObject(ev.acceptance) ? ev.acceptance : {}

  // ---- 交付周期：已发布迭代（首条回执 → release completed）的中位小时数 ----
  const durations = []
  for (const span of collectIterationSpans(receiptList).values()) {
    if (span.firstAt === null || span.releaseAt === null) continue
    const hours = (span.releaseAt - span.firstAt) / 3_600_000
    // 发布不可能早于首条回执：负数只可能来自坏数据，跳过而不是算出负周期。
    if (Number.isFinite(hours) && hours >= 0) durations.push(hours)
  }
  const leadTimeMedian = median(durations)

  // ---- 近 7 天发布：窗口闭合区间 [now-7d, now]，0 是合法值 ----
  const deployStart = nowMs - DEPLOYMENT_WINDOW_DAYS * DAY_MS
  let deploymentCount = 0
  for (const receipt of receiptList) {
    if (!isObject(receipt)) continue
    if (normalizeStage(receipt.stage) !== 'release' || receipt.status !== 'completed') continue
    const at = parseTime(receipt.at)
    if (at === null || at < deployStart || at > nowMs) continue
    deploymentCount += 1
  }

  // ---- 近 N 天审核轮次：verdict 为 fix/reject 的占比（代理） ----
  const failureStart = nowMs - window * DAY_MS
  let reviewSamples = 0
  let failedRounds = 0
  for (const row of historyRows) {
    if (!isObject(row)) continue
    const at = parseTime(row.at)
    if (at === null || at < failureStart || at > nowMs) continue
    const verdict = isNonEmptyString(row.verdict) ? row.verdict.trim().toLowerCase() : ''
    if (verdict === '') continue
    reviewSamples += 1
    if (REVIEW_FAIL_VERDICTS.has(verdict)) failedRounds += 1
  }

  // ---- 修复时长：未通过轮次 → 该轮最早 fixed 处置，只算能配上的 ----
  const fixedByRound = new Map()
  for (const row of dispositionRows) {
    if (!isObject(row) || row.status !== 'fixed') continue
    const at = parseTime(row.at)
    const round = intOrNull(row.round)
    if (at === null || round === null) continue
    const list = fixedByRound.get(round) ?? []
    list.push({ at, ledger: isNonEmptyString(row.ledger) ? row.ledger : null })
    fixedByRound.set(round, list)
  }
  const fixDurations = []
  for (const row of historyRows) {
    if (!isObject(row)) continue
    const verdict = isNonEmptyString(row.verdict) ? row.verdict.trim().toLowerCase() : ''
    if (!REVIEW_FAIL_VERDICTS.has(verdict)) continue
    const reviewAt = parseTime(row.at)
    const round = intOrNull(row.round)
    if (reviewAt === null || round === null) continue
    const historyLedger = isNonEmptyString(row.ledger) ? row.ledger : null
    const candidates = (fixedByRound.get(round) ?? []).filter(
      // 账本目录不同的同轮次不算配对，否则会把 A 任务的处置安到 B 任务头上。
      (item) => historyLedger === null || item.ledger === null || item.ledger === historyLedger,
    )
    if (candidates.length === 0) continue
    const fixedAt = Math.min(...candidates.map((item) => item.at))
    const hours = (fixedAt - reviewAt) / 3_600_000
    // 负数只可能来自时钟回拨/坏数据：跳过，不伪造"负修复时长"。
    if (Number.isFinite(hours) && hours >= 0) fixDurations.push(hours)
  }
  const fixMedian = median(fixDurations)

  // ---- 验收通过率：pass / (pass+fail+blocked+stale)；stale 有结果但不算通过 ----
  const passed = intOrNull(acceptance.passed) ?? 0
  const failed = intOrNull(acceptance.failed) ?? 0
  const blocked = intOrNull(acceptance.blocked) ?? 0
  const stale = intOrNull(acceptance.stale) ?? 0
  const acceptanceSamples = passed + failed + blocked + stale
  const acceptanceRate = acceptanceSamples === 0 ? null : passed / acceptanceSamples

  // ---- 待修问题库存：未处置检查问题 + 验收没通过/卡住 ----
  // 不能用计数字段判「数据是否已到」：生产空证据里 failed/blocked 是 0（不是 null）。
  // 只有明确的可信标志才算已知；全部不可知时库存是 null（数据不足），不是 0 项。
  const reviewKnown = isObject(review) && review.available === true
  const acceptanceKnown =
    isObject(acceptance) &&
    acceptance.missing !== true &&
    acceptance.appliesToCurrent !== false &&
    (Number.isInteger(acceptance.passed) || Number.isInteger(acceptance.failed) || Number.isInteger(acceptance.blocked) || Array.isArray(acceptance.items))
  const inventoryParts = [
    reviewKnown ? intOrNull(review.blocking) : null,
    acceptanceKnown ? intOrNull(acceptance.failed) : null,
    acceptanceKnown ? intOrNull(acceptance.blocked) : null,
  ]
  const inventorySample = [reviewKnown, acceptanceKnown].filter(Boolean).length
  const blockingInventory =
    inventorySample === 0 ? null : inventoryParts.reduce((sum, value) => sum + (value ?? 0), 0)

  /** 统一指标形状：definition 里只用面板词表认可的人话，不出现技术路径。 */
  const metric = (value, unit, sample, definition, source) => ({ value, unit, sample, definition, source })

  const leadTime = durations.length === 0 ? null : round(leadTimeMedian, 2)
  const changeFailureRate = reviewSamples === 0 ? null : round(failedRounds / reviewSamples, 4)
  const reviewFix = fixDurations.length === 0 ? null : round(fixMedian, 2)
  const acceptanceRatio = acceptanceRate === null ? null : round(acceptanceRate, 4)

  const unavailable = []
  if (leadTime === null) unavailable.push({ metric: 'leadTimeHours', reason: '还没有已发布迭代的可比时间' })
  if (changeFailureRate === null) unavailable.push({ metric: 'changeFailureRate', reason: `近 ${window} 天没有可判定的检查轮次` })
  if (reviewFix === null) unavailable.push({ metric: 'reviewFixHours', reason: '还没有能配对的检查处置记录' })
  if (acceptanceRatio === null) unavailable.push({ metric: 'acceptanceRate', reason: '本轮还没有验收结果' })
  if (inventorySample === 0) unavailable.push({ metric: 'blockingInventory', reason: '检查与验收都还没读到' })

  return {
    generatedAt,
    windowDays: window,
    metrics: {
      leadTimeHours: metric(leadTime, 'hours', durations.length, '已发布迭代从首条动态到发布的中位时长（代理）', 'receipts'),
      deploymentFrequency7d: metric(deploymentCount, 'releases', deploymentCount, '近 7 天完成的发布记录数（代理）', 'receipts'),
      changeFailureRate: metric(changeFailureRate, 'ratio', reviewSamples, `近 ${window} 天检查轮次未通过的占比（代理）`, 'review-history'),
      reviewFixHours: metric(reviewFix, 'hours', fixDurations.length, '检查未通过到首次修复处置的中位时长（代理）', 'review-history+dispositions'),
      acceptanceRate: metric(acceptanceRatio, 'ratio', acceptanceSamples, '通过（含证据）/（通过+没通过+卡住+需重新确认）', 'acceptance'),
      blockingInventory: metric(blockingInventory, 'items', inventorySample, '未处置检查问题 + 验收没通过/卡住', 'review+acceptance'),
    },
    unavailable,
  }
}

