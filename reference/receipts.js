/**
 * 执行回执账本：agent 通过 cockpit_report 工具上报，插件负责校验、追加写、容错读。
 *
 * 为什么要有它：宿主读不到 Agent Teams 任务板，"谁在做什么、做到哪一步"只能由回执自报。
 * 所以写入口必须强类型（工具参数校验），读取必须容错（坏行跳过，绝不伪造）。
 *
 * 存储：<项目>/.dsh/plugin-state/receipts.jsonl，追加写，永不改历史。
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const STAGES = [
  'init',
  'scaffold',
  'brainstorm',
  'prototype',
  'coding',
  'code_review',
  'verification',
  'release',
]

export const STATUSES = ['in_progress', 'completed', 'blocked', 'failed', 'dropped']

/** 冷启动阶段固定用这个 iteration_id（此时还没有 v1.0）。 */
export const BOOTSTRAP_ITERATION = 'bootstrap'

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
  if (!isNonEmptyString(raw.iteration_id)) problems.push('iteration_id 必填')
  if (!STAGES.includes(raw.stage)) problems.push(`stage 必须是 ${STAGES.join('/')}`)
  if (!STATUSES.includes(raw.status)) problems.push(`status 必须是 ${STATUSES.join('/')}`)
  if (!isNonEmptyString(raw.summary_for_human)) problems.push('summary_for_human 必填（写不出人话就等于没做完）')

  const isCodingStage = raw.stage === 'coding'
  if (isCodingStage) {
    if (!isNonEmptyString(raw.task_ref)) problems.push('coding 阶段的 task_ref 必填')
    if (!Array.isArray(raw.write_scope) || raw.write_scope.length === 0) {
      problems.push('coding 阶段的 write_scope 必填')
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

  if (problems.length > 0) return { ok: false, error: problems.join('；') }

  return {
    ok: true,
    value: {
      at: new Date().toISOString(),
      iteration_id: raw.iteration_id.trim(),
      stage: raw.stage,
      status: raw.status,
      summary_for_human: raw.summary_for_human.trim(),
      used_skill_or_mcp: isNonEmptyString(raw.used_skill_or_mcp) ? raw.used_skill_or_mcp.trim() : null,
      artifacts: Array.isArray(raw.artifacts) ? raw.artifacts.map(String) : [],
      task_ref: isNonEmptyString(raw.task_ref) ? raw.task_ref.trim() : null,
      write_scope: Array.isArray(raw.write_scope) ? raw.write_scope.map(String) : [],
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
 * 读账本。坏行跳过并计数——绝不让一行坏数据把整个面板打回"未知"，
 * 也绝不把跳过当成没发生（badLines 会显示在 UI 顶部）。
 */
export async function readReceipts(projectPath) {
  let text
  try {
    text = await readFile(receiptsPathOf(projectPath), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { receipts: [], badLines: 0, lastAt: null, missing: true }
    throw error
  }

  const receipts = []
  let badLines = 0
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || !STAGES.includes(parsed.stage)) {
        badLines += 1
        continue
      }
      receipts.push(parsed)
    } catch {
      badLines += 1
    }
  }

  const lastAt = receipts.length > 0 ? receipts[receipts.length - 1].at ?? null : null
  return { receipts, badLines, lastAt, missing: false }
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
    if (!receipt?.needs_human_decision) continue
    const later = receipts.slice(index + 1).some((item) => item.iteration_id === receipt.iteration_id)
    return later ? null : receipt
  }
  return null
}

/** 某迭代下每个阶段的最新状态。 */
export function stageStates(receipts, iterationId) {
  const states = new Map()
  for (const receipt of receipts) {
    if (receipt.iteration_id !== iterationId) continue
    states.set(receipt.stage, { status: receipt.status, at: receipt.at, summary: receipt.summary_for_human })
  }
  return states
}
