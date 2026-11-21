/**
 * 面板模型：把一份只读证据装配成界面直接可渲染的两层数据（总览行 / 详情四区）。
 *
 * 为什么单独成模块：状态机只回答"下一步是什么"，但一屏四区还要回答"这一轮到哪了、
 * 账本里最近发生了什么、缺哪块数据"。这些投影必须与状态机走同一份证据，
 * 否则面板会出现"下一步说发出去、进度条却停在写代码"这类自相矛盾。
 *
 * 硬口径：
 * - 绝不造假：读不到就是 null / 空数组，不默认 0、不拿生成时间冒充更新时间；
 * - 当前阶段最多一个：非 completed 的回执优先于决策指向，避免进度条同时亮两格；
 * - 不下发注定失败的指令：指令为 null 且缺阻断能力 ⇒ 禁用，理由取第一条缺失说明。
 */

import { basename } from 'node:path'

import { entryForStage, missingCapabilities, renderPrompt, stageName, STAGE_DEFS } from './playbook.js'
import { FEATURE_STATUS_LABELS } from './features.js'
import { BOOTSTRAP_ITERATION, pendingDecision, receiptsForIteration, stageStates } from './receipts.js'
import { deriveDecision } from './state.js'

const MAX_LEDGER_RECEIPTS = 20
const MAX_TASK_ITEMS = 20
const MAX_WARNINGS = 20
const MAX_REVIEW_ISSUES = 3
const MAX_FEATURE_ITEMS = 200
const MAX_ACCEPTANCE_ITEMS = 100
const MAX_SHOT_DIFFS = 5

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const asArray = (value) => (Array.isArray(value) ? value : [])
const asText = (value) => (typeof value === 'string' ? value.trim() : '')
const stringOrNull = (value) => (typeof value === 'string' ? value : null)
const countOrNull = (value) => (Number.isInteger(value) ? value : null)

const COLD_START_STAGES = STAGE_DEFS.filter((stage) => stage.cycle !== true)
const CYCLE_STAGES = STAGE_DEFS.filter((stage) => stage.cycle === true)

/** 总览行：字段固定为契约那 11 个；宽和高由客户端决定，这里不掺展示逻辑。 */
export function buildOverviewRow(input = {}) {
  const { id, title, path, evidence } = isObject(input) ? input : {}
  const ev = isObject(evidence) ? evidence : {}
  const decision = deriveDecision(ev)
  const receipts = asArray(isObject(ev.receipts) ? ev.receipts.receipts : [])

  const resolvedPath = asText(path) !== '' ? path : stringOrNull(ev.projectPath)
  const resolvedId = asText(id) !== '' ? id : resolvedPath
  // 标题缺省用项目目录名（比 id 更像人话，且是确定性回退，不是编造）。
  const dirName = resolvedPath !== null ? basename(resolvedPath) : ''
  const resolvedTitle = asText(title) !== '' ? title : dirName !== '' ? dirName : asText(id) !== '' ? id : null

  return {
    id: resolvedId,
    title: resolvedTitle,
    path: resolvedPath,
    initialized: isObject(ev.trellis) && ev.trellis.initialized === true,
    stageId: decision.stageId,
    stageName: stageName(decision.stageId),
    nextKind: decision.kind,
    nextTitle: decision.title,
    degraded: isObject(ev.degraded) && ev.degraded.flag === true,
    hasDecision: pendingDecision(receipts) !== null,
    // 生成时刻不是项目更新时间；没有回执就老实显示"未知"（客户端渲染成 —）。
    updatedAt: isObject(ev.receipts) ? stringOrNull(ev.receipts.lastAt) : null,
  }
}

/**
 * 某一轨（冷启动 / 迭代环）的阶段进度。
 * `current` 最多一个：最近一条"还没完成"的回执优先；决策指向的阶段只在没有回执 current
 * 且自身还没完成时才标 current。整轮发布完成后一轨内没有 current，这是诚实的空态。
 */
function buildTrack(evidence, iterationId, stages, decisionStageId) {
  const receipts = asArray(isObject(evidence.receipts) ? evidence.receipts.receipts : [])
  const states = stageStates(receipts, iterationId)
  const iterationReceipts = receiptsForIteration(receipts, iterationId)

  let latestOpenStageId = null
  for (let index = iterationReceipts.length - 1; index >= 0; index -= 1) {
    const stage = iterationReceipts[index]?.stage
    const state = states.get(stage)
    if (state && state.status !== 'completed') {
      latestOpenStageId = stage
      break
    }
  }

  const decisionState = decisionStageId !== null ? states.get(decisionStageId) : undefined
  const decisionInTrack = decisionStageId !== null && stages.some((stage) => stage.id === decisionStageId)
  const decisionCanBeCurrent =
    latestOpenStageId === null && decisionInTrack && (!decisionState || decisionState.status !== 'completed')

  return stages.map((stage) => {
    const state = states.get(stage.id)
    let nodeState = 'pending'
    if (state && state.status === 'completed') nodeState = 'done'
    else if (stage.id === latestOpenStageId) nodeState = 'current'
    else if (decisionCanBeCurrent && stage.id === decisionStageId) nodeState = 'current'

    return {
      stageId: stage.id,
      name: stage.name,
      state: nodeState,
      receipt: state
        ? { status: stringOrNull(state.status), at: stringOrNull(state.at), summary: stringOrNull(state.summary) }
        : null,
    }
  })
}

/** 两条轨都亮 current 时只保留一个：决策指向哪条轨就留哪条，指不到时留生命周期更靠后的迭代环。 */
function reconcileCurrents(coldStart, cycle, decisionStageId) {
  const coldCurrent = coldStart.find((node) => node.state === 'current')
  const cycleCurrent = cycle.find((node) => node.state === 'current')
  if (!coldCurrent || !cycleCurrent) return
  const decisionInColdStart = decisionStageId !== null && coldStart.some((node) => node.stageId === decisionStageId)
  if (decisionInColdStart) cycleCurrent.state = 'pending'
  else coldCurrent.state = 'pending'
}

function projectSection(evidence) {
  const card = isObject(evidence.card) ? evidence.card : {}
  const cardData = isObject(card.card) ? card.card : null
  const detected = isObject(evidence.detected) ? evidence.detected : {}
  const commands = isObject(detected.commands) ? detected.commands : {}
  const projectPath = stringOrNull(evidence.projectPath)

  const cardName = cardData ? asText(cardData.name) : ''
  // 没有名片时用证据里确定存在的目录名兜底；连路径都没有就是 null（不编一个名字）。
  const name = cardName !== '' ? cardName : projectPath !== null ? basename(projectPath) : null
  const oneLiner = cardData ? asText(cardData.oneLiner) : ''

  return {
    path: projectPath,
    name,
    oneLiner,
    cardStatus: stringOrNull(card.status) ?? 'missing',
    stack: {
      id: stringOrNull(detected.id) ?? 'unknown',
      label: stringOrNull(detected.label) ?? '未检测到技术栈',
    },
    commands: {
      dev: stringOrNull(commands.dev),
      build: stringOrNull(commands.build),
      previewUrl: stringOrNull(commands.previewUrl),
    },
    packageManager: stringOrNull(detected.packageManager),
    evidence: asArray(detected.evidence),
  }
}

/** 下一步：在状态机结果上补阶段名、能力与可执行指令。 */
function nextActionSection(evidence, playbook, stageCapabilities) {
  const decision = deriveDecision(evidence)
  const stageId = decision.stageId
  const capabilities = stageId !== null && isObject(stageCapabilities) ? asArray(stageCapabilities[stageId]) : []
  const missing = missingCapabilities(capabilities).map((item) => ({
    name: item.name,
    kind: item.kind,
    message: stringOrNull(item.missingMessage),
  }))

  // 没有阶段（如"先确认数据"）就不生成指令；有阶段但 playbook 缺条目时 renderPrompt 会给 null。
  const entry = stageId !== null ? entryForStage(playbook, stageId) : null
  let instruction = stageId !== null ? stringOrNull(renderPrompt(entry, capabilities).text) : null

  let disabled = decision.disabled === true
  let disabledReason = decision.disabledReason
  // design §6.3：缺阻断能力时不下发注定失败的指令。指令原文必须一并置空——
  // 否则"复制""发送至对话"这类消费者会把它当成可执行的东西，正是这条要防的。
  if (missing.length > 0) {
    instruction = null
    disabled = true
    disabledReason = missing[0].message ?? disabledReason ?? '缺少必需能力，暂不下发指令'
  }

  return {
    priority: decision.priority,
    kind: decision.kind,
    stageId,
    stageName: stageName(stageId),
    title: decision.title,
    reason: decision.reason,
    instruction,
    capabilities,
    missing,
    disabled,
    disabledReason,
    notes: decision.notes,
    buttons: buttonsFor(decision.kind, disabled),
  }
}

/**
 * 写类按钮在没有可信数据/缺能力时一律收掉，只留复制（复制不产生副作用）。
 * 顺序按实现契约：初始化在前、原型批准在前，复制永远在最后。
 */
function buttonsFor(kind, disabled) {
  if (disabled) return kind === 'confirm-data' ? [] : ['copy']
  if (kind === 'init') return ['init', 'copy']
  if (kind === 'prototype') return ['approve', 'copy']
  return ['copy']
}

function ledgerSection(evidence) {
  const receiptsBox = isObject(evidence.receipts) ? evidence.receipts : {}
  const receipts = asArray(receiptsBox.receipts)
  const recent = receipts
    .slice()
    .reverse()
    .slice(0, MAX_LEDGER_RECEIPTS)
    .map((receipt) => {
      const row = isObject(receipt) ? receipt : {}
      return {
        id: stringOrNull(row.id),
        at: stringOrNull(row.at),
        iterationId: stringOrNull(row.iteration_id),
        stage: stringOrNull(row.stage),
        stageName: stageName(stringOrNull(row.stage)),
        status: stringOrNull(row.status),
        summary: stringOrNull(row.summary_for_human),
        artifacts: asArray(row.artifacts),
        usedSkill: stringOrNull(row.used_skill_or_mcp),
        // 待决策详情原样带给客户端（标题/选项/建议），由账本区置顶展示。
        needsDecision: isObject(row.needs_human_decision) ? row.needs_human_decision : null,
        taskRef: stringOrNull(row.task_ref),
        writeScope: asArray(row.write_scope),
      }
    })

  return {
    receipts: recent,
    total: receipts.length,
    truncated: receipts.length > recent.length,
    badLines: countOrNull(receiptsBox.badLines),
    missing: receiptsBox.missing === true,
    lastAt: stringOrNull(receiptsBox.lastAt),
  }
}

/** 视觉回归记录（最近 5 次）：给界面显示"与上一版一致 / 有变化 x%"与 diff 图链接。 */
function shotDiffRows(raw) {
  return asArray(raw)
    .slice(-MAX_SHOT_DIFFS)
    .map((entry) => {
      const record = isObject(entry) ? entry : {}
      const verdict = ['same', 'changed', 'different-size', 'uncomparable', 'new'].includes(record.verdict)
        ? record.verdict
        : 'uncomparable'
      return {
        at: stringOrNull(record.at),
        verdict,
        baseline: stringOrNull(record.baseline),
        diffFile: stringOrNull(record.diffFile),
        ratio: typeof record.ratio === 'number' && Number.isFinite(record.ratio) ? record.ratio : null,
        changedPixels: countOrNull(record.changedPixels),
        totalPixels: countOrNull(record.totalPixels),
        width: countOrNull(record.width),
        height: countOrNull(record.height),
        reason: stringOrNull(record.reason),
      }
    })
}

/** 验收清单：给人点「通过/失败/阻塞」的那一份表；结果与证据永远原样透传。 */
function acceptanceSection(evidence) {
  const acceptance = isObject(evidence.acceptance) ? evidence.acceptance : {}
  const rawItems = asArray(acceptance.items)
  const items = rawItems.slice(0, MAX_ACCEPTANCE_ITEMS).map((raw) => {
    const item = isObject(raw) ? raw : {}
    const result = item.result === 'pass' || item.result === 'fail' || item.result === 'blocked' ? item.result : null
    return {
      id: String(item.id ?? ''),
      featureRef: asText(item.feature_ref) !== '' ? item.feature_ref : null,
      title: String(item.title ?? ''),
      steps: String(item.steps ?? ''),
      expect: String(item.expect ?? ''),
      result,
      evidence: asArray(item.evidence).filter((entry) => typeof entry === 'string' && entry.trim() !== '').map(String),
      at: stringOrNull(item.at),
      shotDiffs: shotDiffRows(item.shot_diffs),
    }
  })
  return {
    total: countOrNull(acceptance.total),
    withResult: countOrNull(acceptance.withResult),
    passed: countOrNull(acceptance.passed),
    failed: countOrNull(acceptance.failed),
    blocked: countOrNull(acceptance.blocked),
    empty: acceptance.empty === true,
    badJson: acceptance.badJson === true,
    items,
    truncated: rawItems.length > MAX_ACCEPTANCE_ITEMS,
  }
}

/** review 不可用时数字保持 null（不是 0）：0 会让界面误报"审核干净"。 */
function reviewSection(evidence) {
  const review = isObject(evidence.review) ? evidence.review : {}
  const issues = asArray(review.issues)
    .slice(0, MAX_REVIEW_ISSUES)
    .map((issue) => {
      const row = isObject(issue) ? issue : {}
      return {
        severity: stringOrNull(row.severity),
        title: stringOrNull(row.title),
        file: stringOrNull(row.file),
        line: countOrNull(row.line),
      }
    })

  return {
    available: review.available === true,
    reason: stringOrNull(review.reason),
    rounds: countOrNull(review.rounds),
    blocking: countOrNull(review.blocking),
    fixed: countOrNull(review.fixed),
    issues,
  }
}

function tasksSection(evidence) {
  const tasks = isObject(evidence.tasks) ? evidence.tasks : {}
  const items = asArray(tasks.items)
    .slice(0, MAX_TASK_ITEMS)
    .map((task) => {
      const row = isObject(task) ? task : {}
      return { id: stringOrNull(row.id), title: stringOrNull(row.title), status: stringOrNull(row.status) }
    })

  return {
    available: tasks.available === true,
    total: countOrNull(tasks.total),
    open: countOrNull(tasks.open),
    completed: countOrNull(tasks.completed),
    items,
  }
}

/** warnings 截断成"最近 N 条 + 一句还有多少"；最后一条自己也算在 20 条上限里。 */
function warningsSection(evidence) {
  const warnings = asArray(evidence.warnings)
  const kept = warnings.slice(0, MAX_WARNINGS)
  if (warnings.length <= MAX_WARNINGS) {
    return kept.map((warning) => {
      const row = isObject(warning) ? warning : {}
      return { source: stringOrNull(row.source), message: stringOrNull(row.message) }
    })
  }

  const shown = kept.slice(0, MAX_WARNINGS - 1).map((warning) => {
    const row = isObject(warning) ? warning : {}
    return { source: stringOrNull(row.source), message: stringOrNull(row.message) }
  })
  shown.push({ source: 'warnings', message: `还有 ${warnings.length - shown.length} 条读取提示未显示` })
  return shown
}

function iterationSection(evidence) {
  const iteration = isObject(evidence.iteration) ? evidence.iteration : {}
  const approval = isObject(evidence.approval) ? evidence.approval : {}
  const current = stringOrNull(iteration.current)

  return {
    current,
    isBootstrap: current === BOOTSTRAP_ITERATION,
    prototype: {
      approved: approval.approved === true,
      at: stringOrNull(approval.at),
      file: stringOrNull(approval.file),
    },
  }
}

/** 一条审核问题的展示形状（功能账与 review 区共用）。 */
function issueRow(raw) {
  const issue = isObject(raw) ? raw : {}
  return {
    severity: stringOrNull(issue.severity),
    title: stringOrNull(issue.title),
    file: stringOrNull(issue.file),
    line: countOrNull(issue.line),
  }
}

/**
 * 功能账：把 lib/features.js 的推导结果收成界面形状。
 * 不在这里重新判断状态——状态是推导结果，界面只负责显示；缺数据一律 unknown（—）。
 */
function featuresSection(board) {
  const box = isObject(board) ? board : {}
  const rawItems = asArray(box.items)
  const items = rawItems.slice(0, MAX_FEATURE_ITEMS).map((raw) => {
    const item = isObject(raw) ? raw : {}
    const status = typeof item.status === 'string' && FEATURE_STATUS_LABELS[item.status] ? item.status : 'unknown'
    const acceptance = isObject(item.acceptance) ? item.acceptance : {}
    const bugs = isObject(item.bugs) ? item.bugs : {}
    return {
      id: asText(item.id),
      title: asText(item.title),
      priority: stringOrNull(item.priority),
      status,
      statusLabel: FEATURE_STATUS_LABELS[status],
      acceptance: {
        total: countOrNull(acceptance.total) ?? 0,
        passed: countOrNull(acceptance.passed) ?? 0,
        failed: countOrNull(acceptance.failed) ?? 0,
        blocked: countOrNull(acceptance.blocked) ?? 0,
        missingEvidence: countOrNull(acceptance.missingEvidence) ?? 0,
      },
      bugs: {
        blocking: countOrNull(bugs.blocking) ?? 0,
        severe: countOrNull(bugs.severe) ?? 0,
        known: bugs.known === true,
        issues: asArray(bugs.issues).slice(0, MAX_REVIEW_ISSUES).map(issueRow),
      },
      lastAt: stringOrNull(item.lastAt),
      lastSummary: stringOrNull(item.lastSummary),
      receipts: countOrNull(item.receipts) ?? 0,
      inferredReceipts: countOrNull(item.inferredReceipts) ?? 0,
      anchors: {
        receipts: countOrNull(item.anchors?.receipts) ?? 0,
        tasks: countOrNull(item.anchors?.tasks) ?? 0,
      },
      paths: asArray(item.paths).map(String),
    }
  })

  const counts = isObject(box.counts) ? box.counts : {}
  const unattributed = isObject(box.unattributed) ? box.unattributed : {}
  const notes = asArray(box.notes).map(String)
  if (rawItems.length > MAX_FEATURE_ITEMS) notes.push(`功能超过 ${MAX_FEATURE_ITEMS} 条，只显示前 ${MAX_FEATURE_ITEMS} 条`)
  const total = countOrNull(counts.total) ?? items.length

  return {
    source: typeof box.source === 'string' ? box.source : 'prd-missing',
    prdPath: stringOrNull(box.prdPath),
    strategy: typeof box.strategy === 'string' ? box.strategy : 'none',
    sectionTitle: stringOrNull(box.sectionTitle),
    formatHint: stringOrNull(box.formatHint),
    counts: {
      total,
      done: countOrNull(counts.done) ?? 0,
      blocked: countOrNull(counts.blocked) ?? 0,
      inProgress: countOrNull(counts.inProgress) ?? 0,
      pendingAcceptance: countOrNull(counts.pendingAcceptance) ?? 0,
      notStarted: countOrNull(counts.notStarted) ?? 0,
    },
    // 区③ 顶部「功能进度 x/y」：总数来自 counts，避免与截断后的列表长度混淆。
    progress: { done: countOrNull(counts.done) ?? 0, total },
    items,
    unattributed: {
      blocking: countOrNull(unattributed.blocking) ?? 0,
      known: unattributed.known === true,
      issues: asArray(unattributed.issues).slice(0, MAX_REVIEW_ISSUES).map(issueRow),
    },
    notes: notes.slice(0, MAX_WARNINGS),
    warnings: asArray(box.warnings).slice(0, MAX_WARNINGS),
  }
}

/**
 * 生成验收清单这一步（design §7 第 11 条）的指令要按 PRD 功能来说话：
 * 泛泛的"起草验收条目"没有可执行性，得点名还缺哪几条 FR，并指向 cockpit_acceptance。
 * 只在这一个 kind 上覆盖，别的阶段仍然完全由 playbook 模板决定。
 */
function applyAcceptanceDraftHint(action, board) {
  if (!isObject(action) || action.kind !== 'acceptance-draft') return
  // 尊重"缺必需能力不下发指令"：这种情况 nextActionSection 已经置空 instruction 并禁用，
  // 这里只该在本来可执行时把指令换成按功能清单的具体说法，绝不解禁。
  if (action.disabled === true) return
  if (!isObject(board) || board.counts.total === 0) return
  const missing = board.items.filter((item) => item.acceptance.total === 0).map((item) => item.id)
  const scope = missing.length > 0 ? `还缺 ${missing.join('、')}` : '功能都已有验收条目（补充或确认即可）'
  action.instruction =
    `按 PRD 功能逐条起草验收条目（${scope}）：调用 cockpit_acceptance 一次写入，` +
    '每条给 feature_ref / title / steps / expect，result 留空；写完在面板里逐条验，pass 必须附证据。'
  action.buttons = ['copy']
  action.notes = [
    ...asArray(action.notes),
    '验收条目由 Agent 用 cockpit_acceptance 起草（只追加，不覆盖已有 result/evidence）',
  ]
}

/**
 * 详情模型：§3.8 的逐字形状。
 * stageCapabilities 由调用方先 await resolveCapabilities 得到（纯模块不 import DSH 服务）。
 */
export function buildDetailModel(input = {}) {
  const { evidence, playbook, stageCapabilities, generatedAt, features } = isObject(input) ? input : {}
  const ev = isObject(evidence) ? evidence : {}
  const decision = deriveDecision(ev)
  const iteration = iterationSection(ev)
  const featureBoard = featuresSection(features)
  const action = nextActionSection(ev, playbook, stageCapabilities)
  applyAcceptanceDraftHint(action, featureBoard)

  const coldStart = buildTrack(ev, BOOTSTRAP_ITERATION, COLD_START_STAGES, decision.stageId)
  const cycle = buildTrack(ev, iteration.current, CYCLE_STAGES, decision.stageId)
  reconcileCurrents(coldStart, cycle, decision.stageId)

  const degraded = isObject(ev.degraded) ? ev.degraded : {}
  const generated = stringOrNull(generatedAt) ?? stringOrNull(ev.generatedAt)

  return {
    ok: true,
    generatedAt: generated,
    project: projectSection(ev),
    trellis: {
      exists: isObject(ev.trellis) && ev.trellis.exists === true,
      rules: isObject(ev.trellis) && ev.trellis.rules === true,
      initialized: isObject(ev.trellis) && ev.trellis.initialized === true,
      partial: isObject(ev.trellis) && ev.trellis.partial === true,
    },
    iteration,
    nextAction: action,
    progression: { coldStart, cycle },
    features: featureBoard,
    ledger: ledgerSection(ev),
    acceptance: acceptanceSection(ev),
    review: reviewSection(ev),
    tasks: tasksSection(ev),
    warnings: warningsSection(ev),
    dataGaps: asArray(ev.dataGaps),
    degraded: { flag: degraded.flag === true, reasons: asArray(degraded.reasons) },
  }
}
