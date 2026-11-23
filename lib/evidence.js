/**
 * 证据聚合：把散落在项目里的只读数据源读成一份"面板需要的证据"。
 *
 * 三条口径（IMPLEMENTATION §3.6 / §2.6）：
 * - 绝不造假：读不到就是 null / missing / unknown，不默认 0、不猜；
 * - 坏 JSON / 读失败 / 权限错才降级（degraded），账本坏行只进 badLines；
 * - ENOENT 一律视为"没有这个东西"，不告警；单文件读取上限 2 MiB。
 *
 * 这里只读、不写任何文件；审核账本是可选适配器：缺失（no-ledger）不等于故障（read-error）。
 */

import { open, readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { approvalFor, decisionsFor, readApprovals } from './approvals.js'
import { detectStack } from './detect.js'
import { readGateEvidence } from './gates.js'
import { cardStatus, readProjectCard } from './project-card.js'
import { BOOTSTRAP_ITERATION, currentIteration, readReceipts, stateDirOf } from './receipts.js'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_TASK_DIRS = 200
const MAX_TASK_ITEMS = 50
const MAX_TASK_RELATED_FILES = 50
const MAX_REVIEW_ISSUES = 3
// 功能账按路径归属 bug 需要全量 blocking；上限只是防病态账本把载荷撑爆。
const MAX_BLOCKING_ISSUES = 200

const PRD_CANDIDATES = ['prd.md', 'docs/prd.md', 'PRD.md']
const STATE_REL = '.dsh/plugin-state'
const RULES_REL = `${STATE_REL}/RULES.md`
const CARD_REL = `${STATE_REL}/project.json`
const APPROVALS_REL = `${STATE_REL}/approvals.json`
const ACCEPTANCE_REL = `${STATE_REL}/acceptance.json`
const LOCAL_REVIEW_REL = '.dsh/claude-review/ledger/review'
const TRELLIS_TASKS_REL = '.trellis/tasks'

const DEFAULT_FAIL_ON = ['critical', 'important']
const DISPOSED_STATUSES = new Set(['fixed', 'deferred', 'counter-evidence'])
const REVIEW_STORAGE_MODES = new Set(['auto', 'trellis', 'local'])

const REVIEW_REASON_NO_LEDGER = 'no-ledger'
const REVIEW_REASON_READ_ERROR = 'read-error'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''
const describeError = (error) => error?.code ?? error?.message ?? '未知错误'

/**
 * warnings 与 degraded 的收集器：fail = 既进 warnings 又进 degraded（读失败/坏 JSON/权限错），
 * warn 只进 warnings（截断这类"数据缺了一角"的提示）。两者元素形状统一 {source, message}。
 */
function createSink() {
  const warnings = []
  const reasons = []
  return {
    warnings,
    reasons,
    warn(source, message) {
      warnings.push({ source, message })
    },
    fail(source, message) {
      warnings.push({ source, message })
      reasons.push({ source, message })
    },
  }
}

async function statKind(path, sink, source) {
  try {
    const info = await stat(path)
    return { exists: true, isFile: info.isFile(), isDirectory: info.isDirectory() }
  } catch (error) {
    // ENOENT 是"没有"，不是故障；其余（权限/占用/路径类型）才是读失败。
    if (error?.code === 'ENOENT') return { exists: false, isFile: false, isDirectory: false }
    sink.fail(source, `读取失败（${describeError(error)}）`)
    return { exists: false, isFile: false, isDirectory: false }
  }
}

/**
 * 读文本文件，带上限与"没有/读失败"的区分：
 * - { text: null, missing: true }：文件不存在或不是普通文件；
 * - { text: null }：读失败（已由 sink 记 fail）；
 * - { text, truncated }：读到内容（超限时截断并 warn）。
 */
async function readTextCapped(path, sink, source) {
  let info
  try {
    info = await stat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return { text: null, missing: true, truncated: false }
    sink.fail(source, `读取失败（${describeError(error)}）`)
    return { text: null, missing: false, truncated: false }
  }
  // 目录等非普通文件一律当"没有这份数据"，不尝试读取。
  if (!info.isFile()) return { text: null, missing: true, truncated: false }

  let text
  // 超限文件只读前 MAX_BYTES 字节：不能先 readFile 全量读入再截断（病态大文件会顶爆内存）。
  if (info.size > MAX_BYTES) {
    let handle
    try {
      handle = await open(path, 'r')
      const buffer = Buffer.alloc(MAX_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, MAX_BYTES, 0)
      text = buffer.subarray(0, bytesRead).toString('utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { text: null, missing: true, truncated: false }
      sink.fail(source, `读取失败（${describeError(error)}）`)
      return { text: null, missing: false, truncated: false }
    } finally {
      if (handle) await handle.close().catch(() => {})
    }
    sink.warn(source, `超过 2 MiB（${info.size} 字节），已截断读取`)
    return { text, missing: false, truncated: true }
  }

  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { text: null, missing: true, truncated: false }
    sink.fail(source, `读取失败（${describeError(error)}）`)
    return { text: null, missing: false, truncated: false }
  }

  return { text, missing: false, truncated: false }
}

function emptyDetected() {
  return {
    id: 'unknown',
    label: '未检测到技术栈',
    packageManager: null,
    commands: { dev: null, build: null, previewUrl: null },
    evidence: [],
    notes: [],
  }
}

function noReview(reason) {
  return {
    available: false,
    reason,
    rounds: null,
    blocking: null,
    fixed: null,
    lastRound: null,
    issues: [],
    blockingIssues: [],
  }
}

/**
 * 路径不存在/不是目录/意外异常时的空结构：所有契约字段都在，但一个数都不编。
 * 技术门照样读一次（路径无效时三门都回 missing），保证 gates 字段在各个分支都存在。
 */
async function emptyEvidence(projectPath, workspaceExists, sink, generatedAt, options = {}) {
  const gates = await readGateEvidence(projectPath)
  return {
    ok: false,
    projectPath,
    workspace: { exists: workspaceExists },
    trellis: { exists: false, rules: false, initialized: false, partial: false },
    prd: { found: false, path: null },
    card: { card: null, status: 'missing', broken: false, missing: true },
    detected: emptyDetected(),
    receipts: { receipts: [], badLines: 0, missing: true, lastAt: null },
    iteration: {
      current: BOOTSTRAP_ITERATION,
      isBootstrap: true,
      approvals: { map: {}, badJson: false, missing: true },
    },
    // 空证据也要给完整的 decisions（全 false）：状态机据此启用决策门，而不是"字段缺失就跳过"。
    legacyProject: { active: false, reason: null },
    approval: {
      approved: false,
      at: null,
      file: null,
      decisions: decisionsFor({}, BOOTSTRAP_ITERATION),
    },
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
    tasks: { available: false, total: 0, open: 0, completed: 0, items: [] },
    review: noReview(REVIEW_REASON_NO_LEDGER),
    gates,
    workflow: { requireArchitectureGate: options?.requireArchitectureGate !== false },
    warnings: sink.warnings,
    dataGaps: [],
    degraded: { flag: sink.reasons.length > 0, reasons: sink.reasons },
    generatedAt,
  }
}

/** 验收条目有没有证据：数组非空或非空字符串才算（Phase 1 只做判定，不做截图）。 */
function hasEvidence(value) {
  if (Array.isArray(value)) return value.length > 0
  return isNonEmptyString(value)
}

/**
 * 人话验收表（§2.5）。
 * - items 空数组 = 未通过（空表不算通过）；
 * - pass 必须有 evidence 才算"有证据的通过"，pass 但没证据的单独计数（别丢信息）；
 * - iteration_id 为 null/缺失 = 对当前迭代有效；是字符串且 ≠ 当前迭代 = 过期，
 *   整表不参与通过判定（把 items 清空，防止 v1.1 误读 v1.0 的绿灯）。
 */
async function readAcceptance(root, iterationCurrent, sink, dataGaps) {
  const path = join(stateDirOf(root), 'acceptance.json')

  const emptyTable = (overrides = {}) => ({
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
    ...overrides,
  })

  const read = await readTextCapped(path, sink, ACCEPTANCE_REL)
  if (read.missing) return emptyTable()
  // 读失败（已记 fail）时不能声称"空表"，也不知道绑没绑迭代。
  if (read.text === null) return emptyTable({ empty: false, missing: false, appliesToCurrent: false })

  let parsed = null
  try {
    parsed = JSON.parse(read.text)
  } catch {
    parsed = null
  }
  if (!isObject(parsed) || !Array.isArray(parsed.items)) {
    sink.fail(ACCEPTANCE_REL, '不是合法 JSON 或结构不是对象/items 不是数组，已按坏表降级')
    return emptyTable({ badJson: true, missing: false, empty: false, appliesToCurrent: false })
  }

  let appliesToCurrent = true
  const rawIteration = parsed.iteration_id
  if (rawIteration !== undefined && rawIteration !== null) {
    if (typeof rawIteration !== 'string') {
      sink.fail(ACCEPTANCE_REL, 'iteration_id 既不是 null 也不是字符串，已按坏表降级')
      return emptyTable({ badJson: true, missing: false, empty: false, appliesToCurrent: false })
    }
    const bound = rawIteration.trim()
    if (bound !== '') appliesToCurrent = bound === iterationCurrent
    if (!appliesToCurrent) {
      dataGaps.push({
        source: 'acceptance',
        message: `验收表属于迭代 ${bound}，与当前迭代 ${iterationCurrent} 不匹配，已不参与通过判定`,
      })
    }
  }

  const items = appliesToCurrent ? parsed.items.filter(isObject) : []
  // 失效的 pass 不算"验过"：截图后来变了，阶段门必须要求人重新确认（旧 pass 仍留在条目里当历史）。
  const staleCount = items.filter((item) => item.result === 'pass' && item.stale === true).length
  const passed = items.filter((item) => item.result === 'pass' && hasEvidence(item.evidence) && item.stale !== true).length
  const passWithoutEvidence = items.filter(
    (item) => item.result === 'pass' && !hasEvidence(item.evidence) && item.stale !== true,
  ).length
  const failed = items.filter((item) => item.result === 'fail').length
  const blocked = items.filter((item) => item.result === 'blocked').length
  const withResult = passed + passWithoutEvidence + failed + blocked

  return {
    items,
    empty: appliesToCurrent && items.length === 0,
    badJson: false,
    missing: false,
    total: items.length,
    withResult,
    passed,
    failed,
    blocked,
    stale: staleCount,
    passWithoutEvidence,
    appliesToCurrent,
  }
}

/**
 * 任务表：只读 id/title/status；状态非 completed 即未完成。最多读 200 个目录，items 截断到 50。
 *
 * available 的口径是"任务服务可用"（trellis 已初始化），不是"已经有任务"：
 * 初始化后还没有 .trellis/tasks 目录时，状态机要能给出"拆任务"（§3.7 规则 7），
 * 所以这里 available=true、total=0；只有 .trellis 都不存在（未初始化）才说不可用。
 */
async function readTasks(root, sink, trellisExists) {
  const dir = join(root, '.trellis', 'tasks')
  const kind = await statKind(dir, sink, TRELLIS_TASKS_REL)
  const emptyTasks = { available: trellisExists, total: 0, open: 0, completed: 0, items: [] }
  if (!kind.exists || !kind.isDirectory) return { tasks: emptyTasks, dirNames: [] }

  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { tasks: emptyTasks, dirNames: [] }
    sink.fail(TRELLIS_TASKS_REL, `目录读取失败（${describeError(error)}）`)
    return { tasks: { ...emptyTasks, available: false }, dirNames: [] }
  }

  const dirNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))

  if (dirNames.length > MAX_TASK_DIRS) {
    sink.warn(TRELLIS_TASKS_REL, `任务目录超过 ${MAX_TASK_DIRS} 个，只读取前 ${MAX_TASK_DIRS} 个`)
  }
  const limited = dirNames.slice(0, MAX_TASK_DIRS)

  const tasks = []
  for (const name of limited) {
    const source = `${TRELLIS_TASKS_REL}/${name}/task.json`
    const read = await readTextCapped(join(dir, name, 'task.json'), sink, source)
    if (read.missing || read.text === null) continue

    let raw = null
    try {
      raw = JSON.parse(read.text)
    } catch {
      raw = null
    }
    if (!isObject(raw)) {
      sink.fail(source, '不是合法 JSON 或结构不是对象，已跳过该任务')
      continue
    }

    // 任务卡缺字段时用目录名兜底：目录名就是 trellis 里这条任务的确定性身份。
    const id = String(raw.id ?? raw.name ?? name)
    // relatedFiles 是任务自己声明的文件范围：功能账靠它把"没写 feature_ids 的回执"反向归属。
    const relatedFiles = Array.isArray(raw.relatedFiles)
      ? raw.relatedFiles.filter((item) => typeof item === 'string' && item.trim() !== '').slice(0, MAX_TASK_RELATED_FILES)
      : []
    tasks.push({
      id,
      title: String(raw.title ?? raw.name ?? id),
      status: raw.status == null ? 'unknown' : String(raw.status),
      relatedFiles,
    })
  }

  const completed = tasks.filter((task) => task.status === 'completed').length
  return {
    tasks: {
      available: true,
      total: tasks.length,
      open: tasks.length - completed,
      completed,
      items: tasks.slice(0, MAX_TASK_ITEMS),
    },
    dirNames: limited,
  }
}

function reportIssues(report) {
  if (!isObject(report)) return []
  const nested = isObject(report.review) && Array.isArray(report.review.issues) ? report.review.issues : null
  const flat = Array.isArray(report.issues) ? report.issues : null
  return (nested ?? flat ?? []).filter(isObject)
}

function resolveReportFailOn(report) {
  const meta = isObject(report) && isObject(report.meta) ? report.meta : {}
  const list = Array.isArray(meta.failOn) ? meta.failOn.filter((item) => typeof item === 'string') : []
  return list.length > 0 ? list : DEFAULT_FAIL_ON
}

/** 处置必须轮次匹配：报告带 round 时只认同轮处置；报告不带 round 才认全部（口径照 count.js）。 */
function dispositionsForRound(report, dispositions) {
  const round = Number.isInteger(report?.meta?.round) ? report.meta.round : null
  return (Array.isArray(dispositions) ? dispositions : []).filter(
    (item) => isObject(item) && (round === null || item.round === round),
  )
}

function dispositionIndex(report, dispositions) {
  const byKey = new Map()
  const byIndex = new Map()
  for (const mark of dispositionsForRound(report, dispositions)) {
    if (typeof mark.key === 'string' && mark.key !== '') byKey.set(mark.key, mark)
    if (Number.isInteger(mark.index)) byIndex.set(mark.index, mark)
  }
  return { byKey, byIndex }
}

function dispositionFor(issue, index, byKey, byIndex) {
  return (typeof issue.key === 'string' && byKey.get(issue.key)) || byIndex.get(index) || null
}

/** blocking / fixed 口径与上游 count.js 一致（failOn 取报告 meta.failOn，缺失回退 critical/important）。 */
function countFindings(report, dispositions) {
  const issues = reportIssues(report)
  const failOn = resolveReportFailOn(report)
  const { byKey, byIndex } = dispositionIndex(report, dispositions)
  let blocking = 0
  let fixed = 0
  issues.forEach((issue, index) => {
    if (!failOn.includes(issue.severity)) return
    const mark = dispositionFor(issue, index, byKey, byIndex)
    if (mark && DISPOSED_STATUSES.has(mark.status)) {
      if (mark.status === 'fixed') fixed += 1
      return
    }
    blocking += 1
  })
  return { blocking, fixed }
}

/** 面板要能说清"卡在哪"，只回传展示所需的最小字段（最多 3 条）。 */
function summarizeBlocking(report, dispositions, limit) {
  const issues = reportIssues(report)
  const failOn = resolveReportFailOn(report)
  const { byKey, byIndex } = dispositionIndex(report, dispositions)
  const out = []
  issues.forEach((issue, index) => {
    if (!failOn.includes(issue.severity)) return
    const mark = dispositionFor(issue, index, byKey, byIndex)
    if (mark && DISPOSED_STATUSES.has(mark.status)) return
    out.push({
      severity: String(issue.severity),
      title: String(issue.issue ?? issue.title ?? issue.summary ?? '（未命名问题）'),
      file: typeof issue.file === 'string' ? issue.file : null,
      line: Number.isInteger(issue.line) ? issue.line : null,
    })
  })
  return out.slice(0, Math.max(0, limit))
}

function parseJsonl(text, source, sink) {
  const rows = []
  const lines = typeof text === 'string' ? text.split(/\r?\n/) : []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '') continue
    let parsed = null
    try {
      parsed = JSON.parse(line)
    } catch {
      parsed = null
    }
    if (!isObject(parsed)) {
      // 审核账本坏行不能只计数：账本没有 badLines 字段，读不懂就无法相信 blocking 口径。
      sink.fail(source, `第 ${index + 1} 行不是合法 JSON 对象，已按读失败降级`)
      return { ok: false, rows: [] }
    }
    rows.push(parsed)
  }
  return { ok: true, rows }
}

/**
 * 读一份审核账本目录（trellis 每任务一份 / 本地一份）。
 * 返回 {ok, rounds, lastRound, counts, issues}；坏 JSON 或读失败 ⇒ ok:false（由上层统一 read-error）。
 */
async function readLedger(root, dirRel, sink, dataGaps) {
  const historyRel = `${dirRel}/history.jsonl`
  const history = await readTextCapped(join(root, dirRel, 'history.jsonl'), sink, historyRel)
  if (history.missing) return { ok: true, rounds: 0, lastRound: null, counts: null, issues: [], blockingIssues: [] }
  if (history.text === null) return { ok: false }

  const parsedHistory = parseJsonl(history.text, historyRel, sink)
  if (!parsedHistory.ok) return { ok: false }

  const rows = parsedHistory.rows
  // 行内 round 优先；缺失时用行号（账本按轮次追加，行号就是轮次）。
  const roundNumbers = rows.map((row, index) => (Number.isInteger(row.round) ? row.round : index + 1))
  const lastRound = roundNumbers.length > 0 ? Math.max(...roundNumbers) : null

  const dispositionsRel = `${dirRel}/dispositions.jsonl`
  const dispositionsRead = await readTextCapped(join(root, dirRel, 'dispositions.jsonl'), sink, dispositionsRel)
  let dispositions = []
  if (!dispositionsRead.missing) {
    if (dispositionsRead.text === null) return { ok: false }
    const parsedDispositions = parseJsonl(dispositionsRead.text, dispositionsRel, sink)
    if (!parsedDispositions.ok) return { ok: false }
    dispositions = parsedDispositions.rows
  }

  let counts = null
  let issues = []
  let blockingIssues = []
  if (lastRound !== null) {
    const reportRel = `${dirRel}/review-${lastRound}.json`
    const reportRead = await readTextCapped(join(root, dirRel, `review-${lastRound}.json`), sink, reportRel)
    if (!reportRead.missing) {
      if (reportRead.text === null) return { ok: false }
      let report = null
      try {
        report = JSON.parse(reportRead.text)
      } catch {
        report = null
      }
      if (!isObject(report)) {
        sink.fail(reportRel, '不是合法 JSON 或结构不是对象，已按读失败降级')
        return { ok: false }
      }
      counts = countFindings(report, dispositions)
      issues = summarizeBlocking(report, dispositions, MAX_REVIEW_ISSUES)
      // 功能账要按文件路径把 bug 归属到 PRD 功能：需要全量 blocking，不能只有前 3 条。
      blockingIssues = summarizeBlocking(report, dispositions, MAX_BLOCKING_ISSUES)
    } else {
      // 有轮次记录却没有报告：不是故障（ENOENT），但计数会不完整，必须让人知道。
      dataGaps.push({ source: 'review', message: `${dirRel} 有 ${roundNumbers.length} 轮记录但缺少 review-${lastRound}.json` })
    }
  }

  return { ok: true, rounds: rows.length, lastRound, counts, issues, blockingIssues }
}

function normalizeReviewStorage(value) {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : 'auto'
  return REVIEW_STORAGE_MODES.has(mode) ? mode : 'auto'
}

/**
 * 审核账本可选适配器：缺失（no-ledger）≠ 故障（read-error）。
 * auto：优先 .trellis/tasks/<task>/review（有 history.jsonl 才算），否则本地账本，都没有则 no-ledger。
 */
async function readReview(root, taskDirNames, reviewStorage, sink, dataGaps) {
  const mode = normalizeReviewStorage(reviewStorage)
  const ledgerDirs = []

  if (mode === 'trellis' || mode === 'auto') {
    const trellisDirs = []
    for (const name of taskDirNames) {
      const dirRel = `${TRELLIS_TASKS_REL}/${name}/review`
      const source = `${dirRel}/history.jsonl`
      const kind = await statKind(join(root, dirRel, 'history.jsonl'), sink, source)
      if (kind.exists && kind.isFile) trellisDirs.push(dirRel)
    }
    if (trellisDirs.length > 0) ledgerDirs.push(...trellisDirs)
    else if (mode === 'trellis') return noReview(REVIEW_REASON_NO_LEDGER)
  }

  if (ledgerDirs.length === 0 && (mode === 'local' || mode === 'auto')) {
    const source = `${LOCAL_REVIEW_REL}/history.jsonl`
    const kind = await statKind(join(root, LOCAL_REVIEW_REL, 'history.jsonl'), sink, source)
    if (kind.exists && kind.isFile) ledgerDirs.push(LOCAL_REVIEW_REL)
  }

  if (ledgerDirs.length === 0) return noReview(REVIEW_REASON_NO_LEDGER)

  let rounds = 0
  let blocking = 0
  let fixed = 0
  let lastRound = null
  let readError = false
  const issues = []
  const blockingIssues = []

  for (const dirRel of ledgerDirs) {
    const ledger = await readLedger(root, dirRel, sink, dataGaps)
    if (!ledger.ok) {
      readError = true
      continue
    }
    rounds += ledger.rounds
    if (ledger.lastRound !== null && (lastRound === null || ledger.lastRound > lastRound)) lastRound = ledger.lastRound
    if (ledger.counts) {
      blocking += ledger.counts.blocking
      fixed += ledger.counts.fixed
    }
    issues.push(...ledger.issues)
    blockingIssues.push(...ledger.blockingIssues)
  }

  if (readError) return noReview(REVIEW_REASON_READ_ERROR)

  return {
    available: true,
    reason: null,
    rounds,
    blocking,
    fixed,
    lastRound,
    issues: issues.slice(0, MAX_REVIEW_ISSUES),
    blockingIssues: blockingIssues.slice(0, MAX_BLOCKING_ISSUES),
  }
}

/**
 * 聚合面板所需的全部只读证据。承诺：任何情况下都不抛错；路径不存在/不是目录 ⇒ ok:false + 空结构。
 */
export async function readEvidence(projectPath, options = {}) {
  const sink = createSink()
  const generatedAt = new Date().toISOString()

  let root = null
  if (isNonEmptyString(projectPath)) {
    try {
      root = resolve(projectPath.trim())
    } catch {
      root = null
    }
  }
  if (root === null) {
    sink.fail('workspace', '没有给出可用的项目路径')
    return await emptyEvidence(null, false, sink, generatedAt, options)
  }

  let workspaceInfo = null
  try {
    workspaceInfo = await stat(root)
  } catch (error) {
    const reason = error?.code === 'ENOENT' ? '项目路径不存在' : `项目路径读取失败（${describeError(error)}）`
    sink.fail('workspace', reason)
    return await emptyEvidence(root, false, sink, generatedAt, options)
  }
  if (!workspaceInfo.isDirectory()) {
    sink.fail('workspace', '项目路径不是目录')
    return await emptyEvidence(root, false, sink, generatedAt, options)
  }

  try {
    // ---- trellis：.trellis 目录 && .dsh/plugin-state/RULES.md 都存在才算初始化 ----
    const trellisDir = join(root, '.trellis')
    const trellisKind = await statKind(trellisDir, sink, '.trellis')
    const trellisExists = trellisKind.exists && trellisKind.isDirectory
    const rulesKind = await statKind(join(stateDirOf(root), 'RULES.md'), sink, RULES_REL)
    const rulesExists = rulesKind.exists && rulesKind.isFile
    const initialized = trellisExists && rulesExists

    // ---- prd：固定三个候选，先命中先返回 ----
    let prd = { found: false, path: null }
    for (const candidate of PRD_CANDIDATES) {
      const kind = await statKind(join(root, candidate), sink, candidate)
      if (kind.exists && kind.isFile) {
        prd = { found: true, path: candidate }
        break
      }
    }

    // ---- 项目名片 ----
    let cardRead = { card: null, broken: false, missing: true }
    try {
      cardRead = await readProjectCard(root)
    } catch (error) {
      sink.fail(CARD_REL, `读取失败（${describeError(error)}）`)
    }
    if (cardRead.broken === true) {
      sink.fail(CARD_REL, '不是合法 JSON 或读取失败，已按缺失处理')
    }
    const card = {
      card: cardRead.card ?? null,
      status: cardStatus(cardRead),
      broken: cardRead.broken === true,
      missing: cardRead.missing === true,
    }

    // ---- 技术栈探测（A 层保证不抛错；它的 notes 原样透出，不在这里二次解释） ----
    const detected = await detectStack(root)

    // ---- 执行回执：坏行只计数（badLines），不算降级 ----
    let receiptsRead
    try {
      receiptsRead = await readReceipts(root)
    } catch (error) {
      sink.fail('receipts', `读取失败（${describeError(error)}），已按空账本降级`)
      receiptsRead = { receipts: [], badLines: 0, lastAt: null, missing: false, truncated: false }
    }
    // 账本只增不减：超限时只读了尾部。不降级（坏行/截断都不是数据被伪造），但必须说出来。
    if (receiptsRead.truncated === true) {
      sink.warn('receipts', '账本超过 2 MiB，只读了最近的一部分回执（更早的回执未参与本次展示与判定）')
    }
    const receipts = Array.isArray(receiptsRead.receipts) ? receiptsRead.receipts : []

    // ---- 迭代与原型批准 ----
    const iterationCurrent = currentIteration(receipts)
    let approvalsRead
    try {
      approvalsRead = await readApprovals(root)
    } catch (error) {
      sink.fail('approvals', `读取失败（${describeError(error)}），已按没有批准降级`)
      approvalsRead = { map: {}, badJson: false, missing: false }
    }
    if (approvalsRead.badJson === true) {
      sink.fail(APPROVALS_REL, '不是合法 JSON，已按没有批准处理')
    }
    const approvals = {
      map: isObject(approvalsRead.map) ? approvalsRead.map : {},
      badJson: approvalsRead.badJson === true,
      missing: approvalsRead.missing === true,
    }
    // bootstrap 恒无批准：approvalFor / decisionsFor 内已守这条，不在这里重复猜。
    const approval = {
      ...approvalFor(approvals.map, iterationCurrent),
      // 四个决策门的签核状态（P1）：旧文件缺字段 ⇒ 对应门 false，不报错。
      decisions: decisionsFor(approvals.map, iterationCurrent),
    }
    // 升级前的老项目：没有 approvals.json，且当前迭代仍带旧 stage（coding/verification…）。
    // 只对"当前迭代"判断：一旦进入已发布后的新迭代，会写 canonical 回执并启用新门禁。
    const legacyReceipt = receipts.some(
      (receipt) => receipt.iteration_id === iterationCurrent && typeof receipt.legacyStage === 'string',
    )
    const legacyProject = {
      active: approvals.missing === true && iterationCurrent !== BOOTSTRAP_ITERATION && legacyReceipt,
      reason:
        approvals.missing === true && iterationCurrent !== BOOTSTRAP_ITERATION && legacyReceipt
          ? 'old-receipts-without-approvals'
          : null,
    }

    const dataGaps = []
    const acceptance = await readAcceptance(root, iterationCurrent, sink, dataGaps)
    const { tasks, dirNames: taskDirNames } = await readTasks(root, sink, trellisExists)
    const review = await readReview(root, taskDirNames, options?.reviewStorage, sink, dataGaps)
    // 三道技术门是只读证据：文件不存在 = 阶段还没做，不记 warning、不改 degraded。
    const gates = await readGateEvidence(root)

    return {
      ok: true,
      projectPath: root,
      workspace: { exists: true },
      trellis: {
        exists: trellisExists,
        rules: rulesExists,
        initialized,
        partial: (trellisExists || rulesExists) && !initialized,
      },
      prd,
      card,
      detected,
      receipts: {
        receipts,
        badLines: Number.isInteger(receiptsRead.badLines) ? receiptsRead.badLines : 0,
        missing: receiptsRead.missing === true,
        lastAt: receiptsRead.lastAt ?? null,
      },
      iteration: {
        current: iterationCurrent,
        isBootstrap: iterationCurrent === BOOTSTRAP_ITERATION,
        approvals,
      },
      approval,
      legacyProject,
      acceptance,
      tasks,
      review,
      gates,
      workflow: { requireArchitectureGate: options?.requireArchitectureGate !== false },
      warnings: sink.warnings,
      dataGaps,
      degraded: { flag: sink.reasons.length > 0, reasons: sink.reasons },
      generatedAt,
    }
  } catch (error) {
    // 兜底：任何没料到的读盘异常都不许把面板打挂，但要如实降级。
    sink.fail('workspace', `读取项目证据失败（${describeError(error)}），已降级为空数据`)
    return await emptyEvidence(root, true, sink, generatedAt, options)
  }
}
