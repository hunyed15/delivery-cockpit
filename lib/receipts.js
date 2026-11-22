/**
 * 执行回执账本：agent 通过 cockpit_report 工具上报，插件负责校验、追加写、容错读。
 *
 * 为什么要有它：宿主读不到 Agent Teams 任务板，"谁在做什么、做到哪一步"只能由回执自报。
 * 所以写入口必须强类型（工具参数校验），读取必须容错（坏行跳过，绝不伪造）。
 *
 * 存储：<项目>/.dsh/plugin-state/receipts.jsonl，追加写，永不改历史。
 */

import { appendFile, mkdir, open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 9 阶段模型（docs/VISION.md §4）。顺序即面板进度轨顺序：
 * bootstrap 是冷启动（每项目一次），其余 8 个是迭代环。
 *
 * 注意 `testing` 与旧 `verification` **不同义**：旧「验效果」是人工验收，映射到 `acceptance`；
 * 新的 `testing` 是测试报告门禁。见 LEGACY_STAGE_ALIASES。
 */
export const STAGES = [
  'bootstrap',
  'requirements',
  'architecture',
  'prototype',
  'implementation',
  'testing',
  'code-review',
  'acceptance',
  'release',
]

/**
 * 旧账本 / 旧工具调用里的 stage → canonical。
 * 读取（readReceiptsFromText）与写入（validateReceipt）都先过 normalizeStage，
 * 这样历史账本不必迁移就能参与新阶段投影。
 */
export const LEGACY_STAGE_ALIASES = {
  init: 'bootstrap',
  scaffold: 'bootstrap',
  brainstorm: 'requirements',
  prototype: 'prototype',
  coding: 'implementation',
  code_review: 'code-review',
  verification: 'acceptance',
  release: 'release',
}

/**
 * 把任意输入规范成 canonical stage；认不出来返回 null（绝不猜）。
 * 已经是 canonical 的原样返回（trim 后）；别名按 LEGACY_STAGE_ALIASES 映射。
 */
export function normalizeStage(stage) {
  if (typeof stage !== 'string') return null
  const trimmed = stage.trim()
  if (STAGES.includes(trimmed)) return trimmed
  return LEGACY_STAGE_ALIASES[trimmed] ?? null
}

export const STATUSES = ['in_progress', 'completed', 'blocked', 'failed', 'dropped']

/** 冷启动阶段固定用这个 iteration_id（此时还没有 v1.0）。 */
export const BOOTSTRAP_ITERATION = 'bootstrap'

/**
 * 审计事件（不是进度）：例如验收失效留痕。
 * 它们要出现在流水账里，但**不能**参与阶段进度/功能状态投影——否则会让进度轨卡在
 * "验效果进行中"、功能显示"进行中"，与状态机给出的下一步自相矛盾。
 */
export const AUDIT_EVENTS = ['acceptance-stale', 'acceptance-recheck']

/**
 * 每个审计事件允许的 stage/status（写入口强制，别让"复核"回执看起来像进度）。
 * - acceptance-stale：插件内部写，验收确认阶段进行中；
 * - acceptance-recheck：Agent 主动写，验收确认阶段已完成。
 *
 * 旧账本里的 stage:"verification" 会先被 normalizeStage 映射成 acceptance，再走这张表。
 */
export const AUDIT_EVENT_RULES = {
  'acceptance-stale': { stage: 'acceptance', status: 'in_progress' },
  'acceptance-recheck': { stage: 'acceptance', status: 'completed' },
}

/** 是不是"审计事件"（不是进度）。与 validateReceipt 共用同一份白名单，避免两处口径漂移。 */
export const isAuditReceipt = (receipt) =>
  receipt !== null &&
  typeof receipt === 'object' &&
  typeof receipt.event === 'string' &&
  AUDIT_EVENTS.includes(receipt.event)

export const stateDirOf = (projectPath) => join(projectPath, '.dsh', 'plugin-state')
export const receiptsPathOf = (projectPath) => join(stateDirOf(projectPath), 'receipts.jsonl')

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''

/**
 * 校验一条回执。返回 { ok: true, value } 或 { ok: false, error }。
 * 工具层已经由 DSH 按 schema 校验过，这里再校一遍：schema 是契约，execute 是防线。
 */
export function validateReceipt(input) {
  const raw = input ?? {}
  const problems = []
  // 先归一：旧账本/旧调用里的 stage 别名（coding、verification …）落到 canonical 9 阶段再校验。
  const stage = normalizeStage(raw.stage)
  if (!isNonEmptyString(raw.iteration_id)) problems.push('iteration_id 必填')
  if (stage === null) {
    problems.push(`stage 必须是 ${STAGES.join('/')}（旧阶段名会按别名归一，如 coding→implementation）`)
  }
  if (!STATUSES.includes(raw.status)) problems.push(`status 必须是 ${STATUSES.join('/')}`)
  if (!isNonEmptyString(raw.summary_for_human)) problems.push('summary_for_human 必填（写不出人话就等于没做完）')

  const isImplementationStage = stage === 'implementation'
  if (isImplementationStage) {
    if (!isNonEmptyString(raw.task_ref)) problems.push('implementation 阶段的 task_ref 必填')
    if (!Array.isArray(raw.write_scope) || raw.write_scope.length === 0) {
      problems.push('implementation 阶段的 write_scope 必填')
    }
  }

  const decision = raw.needs_human_decision
  if (decision != null) {
    if (typeof decision !== 'object' || Array.isArray(decision)) {
      problems.push('needs_human_decision 必须是对象')
    } else if (!isNonEmptyString(decision.title)) {
      problems.push('needs_human_decision.title 必填')
    } else if (decision.options != null && !Array.isArray(decision.options)) {
      problems.push('needs_human_decision.options 必须是字符串数组')
    }
  }

  // 功能归属：可选，但给了就必须是干净的字符串数组（面板靠它把回执挂到 PRD 功能上）。
  const featureIds = raw.feature_ids
  if (featureIds != null) {
    if (!Array.isArray(featureIds)) problems.push('feature_ids 必须是字符串数组')
    else if (featureIds.some((item) => !isNonEmptyString(item))) problems.push('feature_ids 必须是字符串数组')
  }

  // 审计事件（插件内部写 / Agent 复核留痕）：可选字符串；只允许登记过的值，避免拼写错误变成"隐形的进度回执"。
  const event = raw.event
  if (event != null) {
    if (!isNonEmptyString(event)) problems.push('event 必须是非空字符串')
    else if (!AUDIT_EVENTS.includes(event)) problems.push(`event 只接受：${AUDIT_EVENTS.join('/')}`)
    else {
      const rule = AUDIT_EVENT_RULES[event]
      if (rule !== undefined && (stage !== rule.stage || raw.status !== rule.status)) {
        problems.push(`${event} 回执必须是 stage=${rule.stage} / status=${rule.status}`)
      }
      // 审计事件不是进度，也不能借它挂"待人工决策"（那会让决策弹窗顶出来源错误的卡）。
      if (raw.needs_human_decision != null) problems.push(`${event} 回执不能携带 needs_human_decision`)
    }
  }

  if (problems.length > 0) return { ok: false, error: problems.join('；') }

  return {
    ok: true,
    value: {
      at: new Date().toISOString(),
      iteration_id: raw.iteration_id.trim(),
      stage,
      status: raw.status,
      summary_for_human: raw.summary_for_human.trim(),
      used_skill_or_mcp: isNonEmptyString(raw.used_skill_or_mcp) ? raw.used_skill_or_mcp.trim() : null,
      artifacts: Array.isArray(raw.artifacts) ? raw.artifacts.map(String) : [],
      task_ref: isNonEmptyString(raw.task_ref) ? raw.task_ref.trim() : null,
      write_scope: Array.isArray(raw.write_scope) ? raw.write_scope.map(String) : [],
      feature_ids: Array.isArray(featureIds) ? featureIds.map((item) => item.trim().toUpperCase()) : [],
      event: isNonEmptyString(event) ? event.trim() : null,
      needs_human_decision: decision
        ? {
            title: String(decision.title),
            options: Array.isArray(decision.options) ? decision.options.map(String) : [],
            recommended: isNonEmptyString(decision.recommended) ? String(decision.recommended) : null,
          }
        : null,
    },
  }
}

/** 追加一条回执。写失败要抛，不能静默丢数据。 */
export async function appendReceipt(projectPath, input) {
  const checked = validateReceipt(input)
  if (!checked.ok) return { ok: false, error: checked.error }

  const dir = stateDirOf(projectPath)
  await mkdir(dir, { recursive: true })
  const receipt = { id: `r-${randomUUID().slice(0, 8)}`, ...checked.value }
  await appendFile(receiptsPathOf(projectPath), `${JSON.stringify(receipt)}\n`, 'utf8')
  return { ok: true, receipt }
}

/**
 * 纯函数解析：账本文本 -> 回执列表。
 * 抽出来的理由是 evidence 层要做"一次读盘、多个消费者"，若各层各自 split/parse，
 * 坏行的判定口径迟早会漂移；这里成为唯一口径。
 */
export function readReceiptsFromText(text) {
  // 调用方应传字符串；非字符串在语义上等于"没有内容"，不升级成故障，也不伪造数据。
  const source = typeof text === 'string' ? text : ''

  const receipts = []
  let badLines = 0
  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line)
      // 旧账本里的 stage 别名在这里归一，使旧数据也能参与新 9 阶段投影；
      // 认不出来的 stage 仍是坏行（不猜、不静默归到某个阶段）。
      const stage = parsed !== null && typeof parsed === 'object' ? normalizeStage(parsed.stage) : null
      if (stage === null) {
        badLines += 1
        continue
      }
      receipts.push({ ...parsed, stage })
    } catch {
      badLines += 1
    }
  }

  const lastAt = receipts.length > 0 ? receipts[receipts.length - 1].at ?? null : null
  return { receipts, badLines, lastAt }
}

/**
 * 读账本。坏行跳过并计数——绝不让一行坏数据把整个面板打回"未知"，
 * 也绝不把跳过当成没发生（badLines 会显示在 UI 顶部）。
 *
 * 大小上限：账本是只增不减的追加日志，8 秒轮询每次都全量读入会越来越慢。
 * 超过 2 MiB 时只读**尾部**（最新的回执），并置 truncated 让上层如实提示。
 */
export const MAX_RECEIPT_BYTES = 2 * 1024 * 1024

export async function readReceipts(projectPath) {
  const path = receiptsPathOf(projectPath)
  let text
  let truncated = false
  try {
    const info = await stat(path)
    if (info.size > MAX_RECEIPT_BYTES) {
      const handle = await open(path, 'r')
      try {
        const buffer = Buffer.alloc(MAX_RECEIPT_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, MAX_RECEIPT_BYTES, info.size - MAX_RECEIPT_BYTES)
        text = buffer.subarray(0, bytesRead).toString('utf8')
      } finally {
        await handle.close()
      }
      // 截断点可能落在半行上：丢掉第一行，宁可少一条，也不把半行算成坏行。
      const firstBreak = text.indexOf('\n')
      text = firstBreak >= 0 ? text.slice(firstBreak + 1) : ''
      truncated = true
    } else {
      text = await readFile(path, 'utf8')
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { receipts: [], badLines: 0, lastAt: null, missing: true, truncated: false }
    throw error
  }

  const { receipts, badLines, lastAt } = readReceiptsFromText(text)
  return { receipts, badLines, lastAt, missing: false, truncated }
}

/** 当前迭代：最新一条非 bootstrap 回执的 iteration_id；没有则是 bootstrap。 */
export function currentIteration(receipts) {
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const id = receipts[index]?.iteration_id
    if (isNonEmptyString(id) && id !== BOOTSTRAP_ITERATION) return id
  }
  return BOOTSTRAP_ITERATION
}

/**
 * 待人工决策：最新一条带 needs_human_decision 的回执，且之后没有同迭代的新回执。
 * 只要存在就最高优置顶——与 status 填什么无关（防止有 agent 传 in_progress 把弹窗埋掉）。
 */
export function pendingDecision(receipts) {
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const receipt = receipts[index]
    // 审计事件永远不是待决策来源（写入口也拦了，这里再兜一层，兼容手改过的账本）。
    if (isAuditReceipt(receipt)) continue
    if (!receipt?.needs_human_decision) continue
    // 只有"进度回执"才算把决策接走了；审计事件（如验收失效留痕）不能静默吞掉待决策。
    const later = receipts
      .slice(index + 1)
      .some((item) => item.iteration_id === receipt.iteration_id && !isAuditReceipt(item))
    return later ? null : receipt
  }
  return null
}

/** 某迭代下每个阶段的最新状态（审计事件不算进度，直接跳过）。 */
export function stageStates(receipts, iterationId) {
  const states = new Map()
  for (const receipt of receipts) {
    if (receipt.iteration_id !== iterationId) continue
    if (isAuditReceipt(receipt)) continue
    // 兼容直接传进来的旧回执（未经 readReceiptsFromText）：投影键一律是 canonical stage。
    const stage = normalizeStage(receipt.stage)
    if (stage === null) continue
    states.set(stage, { status: receipt.status, at: receipt.at, summary: receipt.summary_for_human })
  }
  return states
}

/**
 * 某迭代的全部回执，保持输入顺序（账本是追加写，输入顺序即时间顺序）。
 * 不排序的理由：调用方拿到的就是落盘顺序，重排会把"同毫秒内谁先谁后"这类信息丢掉。
 */
export function receiptsForIteration(receipts, iterationId) {
  if (typeof iterationId !== 'string' || iterationId === '') return []
  if (!Array.isArray(receipts)) return []
  return receipts.filter((receipt) => receipt?.iteration_id === iterationId)
}
