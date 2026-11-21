/**
 * 功能账：把 PRD 里的受控功能清单（`### FR-N 标题`）变成一张可读的进度表。
 *
 * 为什么不做 NLP：设计里写死了"不解析 PRD 自由文本算进度"——自由文本算不出来，
 * 硬算就是编数字。这里只认一种结构：`## 功能需求` 下的 `### FR-N 标题`；
 * 认不到就直说"没识别到功能清单"，绝不用启发式猜标题当功能。
 *
 * 状态是**三路证据推导**，不是自报：
 *   验收通过（acceptance pass + 证据） > 归属 bug（审核 blocking 按路径归属） > 回执（in_progress/completed）
 * 关联必须显式：回执写 feature_ids，验收条目写 feature_ref；没有关联证据的功能，
 * bug/验收列显示 —（bugs.known=false），不显示 0。
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const FR_HEADING = /^###\s+(FR-\d+)\b\s*(.*)$/i
const SECTION_HEADING = /^##\s+(.+)$/
const SECTION_KEYWORD = '功能需求'
const FENCE = /^\s*(```|~~~)/
// 优先级：括号里出现 P0-P3 就算，括号内还可能有补充说明（"（P0，核心差异化）"、"（P0 点播 / P1 全量）"）。
const PRIORITY = /[（(]\s*(P[0-3])\b/i
const PRIORITY_GROUP = /[（(]\s*P[0-3]\b[^）)]*[）)]/gi
const MAX_PRD_BYTES = 2 * 1024 * 1024
const MAX_FEATURES = 200
const MAX_BUGS_PER_FEATURE = 3

export const FEATURE_STATUS_LABELS = {
  done: '已完成',
  blocked: '有阻塞',
  'in-progress': '进行中',
  'pending-acceptance': '待验收',
  'not-started': '未开始',
  unknown: '—',
}

export const FEATURE_FORMAT_HINT =
  '在 prd.md 里写一节「## 功能需求」，其下每个功能一行标题，例如「### FR-1 信号采集（P0）」。' +
  '面板只认这个结构；没有它就无法把功能、验收和缺陷对上号。'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''

/** 只读 PRD 文本；ENOENT 是"没有这个文件"，不是错误。 */
export async function readPrdText(projectPath, prdRelPath) {
  if (!isNonEmptyString(projectPath) || !isNonEmptyString(prdRelPath)) {
    return { text: null, missing: true, error: null }
  }
  const path = join(projectPath, prdRelPath)
  let info
  try {
    info = await stat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return { text: null, missing: true, error: null }
    return { text: null, missing: false, error }
  }
  if (!info.isFile()) return { text: null, missing: true, error: null }
  try {
    const text = await readFile(path, 'utf8')
    if (info.size > MAX_PRD_BYTES) return { text: text.slice(0, MAX_PRD_BYTES), missing: false, error: null, truncated: true }
    return { text, missing: false, error: null }
  } catch (error) {
    return { text: null, missing: false, error }
  }
}

/** 标题里剥掉整段优先级括号（含括号内的补充说明）与首尾分隔符，剩下人话标题。 */
function cleanTitle(rest) {
  return String(rest ?? '')
    .replace(PRIORITY_GROUP, '')
    .replace(/^[\s:：·—-]+/, '')
    .replace(/[\s:：·—-]+$/, '')
    .trim()
}

function priorityOf(rest) {
  const match = String(rest ?? '').match(PRIORITY)
  return match ? match[1].toUpperCase() : null
}

/**
 * 提取功能清单。返回 `{strategy, sectionTitle, features, warnings}`。
 * strategy: fr-section（认到了「功能需求」节）/ fr-global（全文兜底）/ none。
 */
export function extractFeatures(prdText) {
  const warnings = []
  if (typeof prdText !== 'string' || prdText.trim() === '') {
    return { strategy: 'none', sectionTitle: null, features: [], warnings }
  }

  const lines = prdText.split(/\r?\n/)
  const inFence = new Array(lines.length).fill(false)
  let fenced = false
  for (let index = 0; index < lines.length; index += 1) {
    if (FENCE.test(lines[index])) {
      inFence[index] = true
      fenced = !fenced
      continue
    }
    inFence[index] = fenced
  }

  // 先找「## 功能需求」那一节的范围；找不到再看全文有没有 FR 标题兜底。
  let sectionTitle = null
  let start = -1
  let end = lines.length
  for (let index = 0; index < lines.length; index += 1) {
    if (inFence[index]) continue
    const match = lines[index].match(SECTION_HEADING)
    if (!match) continue
    if (start === -1) {
      if (match[1].includes(SECTION_KEYWORD)) {
        start = index
        sectionTitle = match[1].trim()
      }
    } else {
      end = index
      break
    }
  }

  const collect = (from, to) => {
    const found = []
    for (let index = from; index < to; index += 1) {
      if (inFence[index]) continue
      const match = lines[index].match(FR_HEADING)
      if (!match) continue
      const id = match[1].toUpperCase()
      found.push({
        id,
        title: cleanTitle(match[2]),
        priority: priorityOf(match[2]),
        line: index + 1,
      })
    }
    return found
  }

  let strategy = 'none'
  let raw = []
  if (start !== -1) {
    strategy = 'fr-section'
    raw = collect(start + 1, end)
  } else {
    const global = collect(0, lines.length)
    if (global.length > 0) {
      strategy = 'fr-global'
      raw = global
      warnings.push({
        source: 'prd',
        message: '没找到「## 功能需求」小节，按全文的「### FR-N」标题兜底提取（建议按约定整理）',
      })
    }
  }

  // 同 id 只取第一次出现：重复标题通常是复制粘贴，不是两个功能。
  const seen = new Set()
  const features = []
  for (const feature of raw) {
    if (seen.has(feature.id)) continue
    seen.add(feature.id)
    features.push(feature)
  }

  if (features.length > MAX_FEATURES) {
    warnings.push({ source: 'prd', message: `功能超过 ${MAX_FEATURES} 条，只取前 ${MAX_FEATURES} 条` })
    features.length = MAX_FEATURES
  }

  return { strategy, sectionTitle, features, warnings }
}

/** 路径归一：正斜杠、去 ./ 前缀、去尾部通配与斜杠，用于前缀匹配。 */
function normalizePath(value) {
  if (typeof value !== 'string') return ''
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/\*\*$/, '')
    .replace(/\/\*$/, '')
    .replace(/\/+$/, '')
}

function matchesPath(file, paths) {
  const target = normalizePath(file)
  if (target === '' || !Array.isArray(paths)) return false
  for (const raw of paths) {
    const path = normalizePath(raw)
    if (path === '') continue
    if (target === path || target.startsWith(`${path}/`)) return true
  }
  return false
}

const FR_CODE = /FR-(\d+)/gi

/** 从任务标题/目录名里认 FR 编号：`FR-3 转存`、`fr-12-import` 都算，认不到就是空。 */
function featureCodesInText(text) {
  const found = new Set()
  const source = String(text ?? '')
  FR_CODE.lastIndex = 0
  let match = FR_CODE.exec(source)
  while (match !== null) {
    found.add(`FR-${match[1]}`)
    match = FR_CODE.exec(source)
  }
  return found
}

function normalizePaths(list) {
  const paths = []
  const seen = new Set()
  for (const raw of Array.isArray(list) ? list : []) {
    const path = normalizePath(raw)
    if (path === '' || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

/** 回执自身声明的文件范围（write_scope + artifacts），外加它所属任务的 relatedFiles。 */
function receiptPaths(receipt, taskById) {
  const paths = [
    ...(Array.isArray(receipt?.write_scope) ? receipt.write_scope : []),
    ...(Array.isArray(receipt?.artifacts) ? receipt.artifacts : []),
  ]
  const taskRef = typeof receipt?.task_ref === 'string' ? receipt.task_ref : ''
  const task = taskRef !== '' ? taskById.get(taskRef) : null
  if (task) paths.push(...task.relatedFiles)
  return normalizePaths(paths)
}

/** 两条路径是否有交集：等于、或任一方是另一方的前缀目录。 */
function pathsOverlap(left, right) {
  for (const a of left) {
    for (const b of right) {
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true
    }
  }
  return false
}

function acceptanceStatsOf(featureId, acceptance) {
  const items = acceptance && acceptance.appliesToCurrent !== false && Array.isArray(acceptance.items) ? acceptance.items : []
  const related = items.filter((item) => item && item.feature_ref === featureId)
  let passed = 0
  let failed = 0
  let blocked = 0
  let missingEvidence = 0
  let stale = 0
  for (const item of related) {
    const hasEvidence = Array.isArray(item.evidence) ? item.evidence.filter((entry) => isNonEmptyString(entry)).length > 0 : false
    if (item.result === 'pass') {
      // 失效的 pass 不算完成：截图变了没重新确认，阶段门会拦，功能账就不能给绿灯。
      if (item.stale === true) stale += 1
      else if (hasEvidence) passed += 1
      else missingEvidence += 1
    } else if (item.result === 'fail') failed += 1
    else if (item.result === 'blocked') blocked += 1
  }
  return {
    total: related.length,
    passed,
    failed,
    blocked,
    missingEvidence,
    stale,
    // 失效不算"验过"：否则功能状态会停在"进行中"而不是"待验收"。
    withResult: passed + missingEvidence + failed + blocked,
  }
}

function statusOf({ bugs, acceptance, related, evidenceUsable }) {
  if (bugs > 0) return 'blocked'
  if (acceptance.total > 0 && acceptance.passed === acceptance.total && acceptance.passed > 0) return 'done'
  const statuses = related.map((receipt) => receipt?.status)
  // 正在干（回执说 in_progress/blocked）优先于"验收表草稿还没填"：
  // 草稿不是证据，回执才是"确实动过"的证据。
  if (statuses.includes('in_progress') || statuses.includes('blocked')) return 'in-progress'
  if (acceptance.withResult > 0) return 'in-progress'
  if (statuses.includes('completed')) return 'pending-acceptance'
  if (related.length === 0) return evidenceUsable ? 'not-started' : 'unknown'
  // 只剩 failed/dropped 这类"动过但没成"的状态：算进行中，不冒充完成。
  return 'in-progress'
}

/**
 * 生成功能账本。
 *
 * @param {object} input
 * @param {{strategy:string, sectionTitle:string|null, features:Array, warnings:Array}} input.extracted
 * @param {{path?:string|null, missing?:boolean, error?:unknown}} [input.prd]
 * @param {Array} [input.receipts]  全部迭代的回执（功能完成是累积事实，不按迭代清零）
 * @param {object} [input.acceptance]  evidence.acceptance（已按当前迭代过滤过）
 * @param {object} [input.review]      evidence.review（含 blockingIssues 全量）
 * @param {object} [input.tasks]       evidence.tasks（items[].relatedFiles 参与自动归属）
 */
export function buildFeatureBoard({ extracted, prd, receipts, acceptance, review, tasks } = {}) {
  const features = Array.isArray(extracted?.features) ? extracted.features : []
  const allReceipts = Array.isArray(receipts) ? receipts : []
  const acceptanceBox = isObject(acceptance) ? acceptance : {}
  const reviewBox = isObject(review) ? review : {}
  // 审核账本"没接"和"读失败"都意味着 bug 数不可知：known=false 让界面显示 —。
  const bugsKnown = reviewBox.available === true
  const blockingIssues = bugsKnown && Array.isArray(reviewBox.blockingIssues) ? reviewBox.blockingIssues.filter(isObject) : []
  // 验收表坏了时验收证据不可信，状态降级为 unknown 而不是"未开始"。
  const evidenceUsable = acceptanceBox.badJson !== true
  const notes = []

  if (prd?.truncated === true) notes.push('PRD 超过 2 MiB，只读了前一部分，功能清单可能不完整')
  if (prd?.error) notes.push(`PRD 读取失败（${prd.error?.code ?? prd.error?.message ?? prd.error}），功能清单不可用`)
  if (bugsKnown === false) {
    notes.push(
      reviewBox.reason === 'read-error'
        ? '审核账本读取失败：待修 bug 数不可知，显示为 —'
        : '没有审核账本：待修 bug 数不可知，显示为 —',
    )
  }
  if (acceptanceBox.badJson === true) notes.push('验收表不是合法 JSON：验收证据不可用，状态可能降级为 —')
  // 关联数据被上限截断时必须说出来，否则"各功能 blocking 之和"会对不上账本总数。
  if (bugsKnown && Number.isInteger(reviewBox.blocking) && reviewBox.blocking > blockingIssues.length) {
    notes.push(`审核账本有 ${reviewBox.blocking} 条未处置 blocking，只有前 ${blockingIssues.length} 条参与功能归属`)
  }

  const taskItems = Array.isArray(tasks?.items) ? tasks.items : Array.isArray(tasks) ? tasks : []
  const taskById = new Map()
  for (const raw of taskItems) {
    if (!isObject(raw)) continue
    const id = String(raw.id ?? '')
    if (id === '') continue
    taskById.set(id, {
      id,
      title: String(raw.title ?? id),
      relatedFiles: Array.isArray(raw.relatedFiles) ? raw.relatedFiles.filter((item) => isNonEmptyString(item)) : [],
    })
  }

  // 锚点 1：任务标题/目录名里写了 FR-N 的，它的 relatedFiles 就是该功能的路径范围。
  // 这是"任务属于哪个 FR"最直接、可解释的来源（一眼能看出为什么归属）。
  const taskAnchors = new Map()
  for (const task of taskById.values()) {
    const taskPaths = normalizePaths(task.relatedFiles)
    // 没有 relatedFiles 的任务不构成锚点：否则界面会显示"任务标题 1 个"却没有任何可归属路径。
    if (taskPaths.length === 0) continue
    for (const code of featureCodesInText(`${task.id} ${task.title}`)) {
      const entry = taskAnchors.get(code) ?? { paths: [], tasks: 0 }
      entry.paths = normalizePaths([...entry.paths, ...taskPaths])
      entry.tasks += 1
      taskAnchors.set(code, entry)
    }
  }

  // 锚点 2：回执自己声明了 feature_ids 的 write_scope/artifacts（最可信，优先级最高）。
  const explicitByFeature = new Map()
  for (const receipt of allReceipts) {
    const ids = Array.isArray(receipt?.feature_ids) ? receipt.feature_ids : []
    for (const code of ids) {
      const list = explicitByFeature.get(code) ?? []
      list.push(receipt)
      explicitByFeature.set(code, list)
    }
  }
  const anchorPathsOf = (featureId) => {
    const explicitPaths = (explicitByFeature.get(featureId) ?? []).flatMap((receipt) => [
      ...(Array.isArray(receipt?.write_scope) ? receipt.write_scope : []),
      ...(Array.isArray(receipt?.artifacts) ? receipt.artifacts : []),
    ])
    const taskPaths = taskAnchors.get(featureId)?.paths ?? []
    return normalizePaths([...explicitPaths, ...taskPaths])
  }

  // 推断：没写 feature_ids 的回执，按"自身路径（含所属任务 relatedFiles）"与功能锚点是否重叠来归属。
  // 显式声明永远优先（有 feature_ids 就不推断），推断结果只用于挂回执，不反过来扩大功能路径。
  const inferredByFeature = new Map()
  const inferredReceiptIds = new Set()
  for (const [receiptIndex, receipt] of allReceipts.entries()) {
    if (Array.isArray(receipt?.feature_ids) && receipt.feature_ids.length > 0) continue
    const receiptPathList = receiptPaths(receipt, taskById)
    if (receiptPathList.length === 0) continue
    for (const feature of features) {
      const anchors = anchorPathsOf(feature.id)
      if (anchors.length === 0) continue
      if (!pathsOverlap(receiptPathList, anchors)) continue
      const list = inferredByFeature.get(feature.id) ?? []
      list.push(receipt)
      inferredByFeature.set(feature.id, list)
      // 按"唯一回执"计数：一条回执的路径可能同时覆盖多个功能，那是多处归属，不是多条回执。
      inferredReceiptIds.add(receiptIndex)
    }
  }
  const inferredTotal = inferredReceiptIds.size

  const counts = { done: 0, blocked: 0, inProgress: 0, pendingAcceptance: 0, notStarted: 0, unknown: 0 }
  const matchedIssueIndexes = new Set()

  const items = features.map((feature) => {
    const explicit = explicitByFeature.get(feature.id) ?? []
    const inferred = inferredByFeature.get(feature.id) ?? []
    // 时间正序：最后一条代表"最近进展"。ISO 字符串可直接排，缺失的排最前。
    const related = [...explicit, ...inferred].sort((left, right) =>
      String(left?.at ?? '').localeCompare(String(right?.at ?? '')),
    )
    const paths = anchorPathsOf(feature.id)

    const bugIssues = blockingIssues
      .map((issue, index) => ({ issue, index }))
      .filter(({ issue }) => matchesPath(issue.file, paths))

    const acceptanceStats = acceptanceStatsOf(feature.id, acceptanceBox)
    const status = statusOf({ bugs: bugIssues.length, acceptance: acceptanceStats, related, evidenceUsable })
    if (status === 'done') counts.done += 1
    else if (status === 'blocked') counts.blocked += 1
    else if (status === 'in-progress') counts.inProgress += 1
    else if (status === 'pending-acceptance') counts.pendingAcceptance += 1
    else if (status === 'not-started') counts.notStarted += 1
    else counts.unknown += 1

    for (const { index } of bugIssues) matchedIssueIndexes.add(index)
    const last = related.length > 0 ? related[related.length - 1] : null
    // 这个功能没有任何可归属的路径、而账本里确实有 bug 时，"0 个 bug"是不可知的：
    // 显示 0 会让人以为"它没问题"，正是设计里禁止的那种假数据。
    const bugsAttributable = paths.length > 0 || blockingIssues.length === 0

    return {
      id: feature.id,
      title: feature.title,
      priority: feature.priority ?? null,
      status,
      statusLabel: FEATURE_STATUS_LABELS[status],
      acceptance: acceptanceStats,
      bugs: {
        blocking: bugIssues.length,
        // 严重数按"全量归属结果"算，不能从下发时截断到 3 条的 issues 里统计：
        // 否则 blocking=10 却只报"严重 1"，那个 1 只是前 3 条里的数量。
        severe: bugIssues.filter(({ issue }) => String(issue.severity ?? '').toLowerCase() === 'critical').length,
        known: bugsKnown && bugsAttributable,
        issues: bugIssues.slice(0, MAX_BUGS_PER_FEATURE).map(({ issue }) => issue),
      },
      lastAt: isNonEmptyString(last?.at) ? last.at : null,
      lastSummary: isNonEmptyString(last?.summary_for_human) ? last.summary_for_human : null,
      receipts: related.length,
      // 可解释性：这些回执里有几条是"没写 feature_ids、按路径推断"来的。
      inferredReceipts: inferred.length,
      anchors: { receipts: explicit.length, tasks: taskAnchors.get(feature.id)?.tasks ?? 0 },
      paths,
    }
  })

  const unattributedIssues = blockingIssues
    .map((issue, index) => ({ issue, index }))
    .filter(({ index }) => !matchedIssueIndexes.has(index))
    .map(({ issue }) => issue)

  // 自动归属必须"可解释"：推断了几条要说出来，一条锚点都没有时要告诉人去写 feature_ids。
  if (inferredTotal > 0) {
    notes.push(
      `有 ${inferredTotal} 条回执没写 feature_ids，已按任务 relatedFiles / 写作用域自动归属` +
        '（可解释，写了就以自报为准；一条回执覆盖多个功能时会同时挂到多个功能）',
    )
  } else if (features.length > 0) {
    const anyAnchor = features.some((feature) => anchorPathsOf(feature.id).length > 0)
    if (!anyAnchor) {
      notes.push('还没有任何回执声明 feature_ids，也没有任务标题带 FR 编号：无法自动归属回执，第一条 coding 回执请写上 feature_ids')
    }
  }

  const source = features.length > 0 ? 'prd' : prd?.path ? 'prd-empty' : 'prd-missing'
  const formatHint = source === 'prd' ? null : extracted?.strategy === 'none' ? FEATURE_FORMAT_HINT : null

  if (features.length === 0) {
    notes.push(
      source === 'prd-missing'
        ? '还没有 prd.md：想清楚阶段会产出它，面板才能按功能展示进度'
        : 'prd.md 里没识别到「### FR-N」功能条目，功能账为空',
    )
  } else {
    notes.push('状态按「验收通过 / 归属 bug / 回执」三路证据推导；没有记录的功能显示「未开始」，不代表一定没做')
  }

  return {
    source,
    prdPath: isNonEmptyString(prd?.path) ? prd.path : null,
    strategy: extracted?.strategy ?? 'none',
    sectionTitle: extracted?.sectionTitle ?? null,
    formatHint,
    counts: {
      total: items.length,
      ...counts,
    },
    items,
    unattributed: { blocking: unattributedIssues.length, known: bugsKnown, issues: unattributedIssues.slice(0, MAX_BUGS_PER_FEATURE) },
    notes,
    warnings: Array.isArray(extracted?.warnings) ? extracted.warnings : [],
  }
}
