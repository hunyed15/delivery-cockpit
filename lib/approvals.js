/**
 * 人工签核（decision gate）：按 iteration_id 落盘。
 *
 * 为什么必须按迭代存：否则 v1.1 会读到 v1.0 的批准，直接跳过"看原型"进"写代码"。
 * 为什么批准要检查原型文件：设计的门禁是"人看过静态 HTML 才通过"，没有原型的批准
 * 等于给了一个没有依据的通行证 —— 那正是这个门禁要防的事。
 *
 * P1 起 approvals.json 里一次迭代不只存原型批准，还存四个决策门的签核时间：
 * scope（范围）/ architecture（架构）/ acceptance（验收）/ release（发布）。
 * 每个门都要先过自己的前置（PRD、契约文件、验收全绿、发布清单），
 * 不是"点一下就算"—— 声明变成真按钮、真门禁，前提都收在这里。
 *
 * 注意：本模块不 import evidence.js（evidence.js 要 import 本模块，否则成环）；
 * 技术门只读 gates.js，验收表只读 acceptance.js。
 */
import { readFile, stat, mkdir, writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { readAcceptanceFile } from './acceptance.js'
import { readGateEvidence } from './gates.js'
import { BOOTSTRAP_ITERATION, stateDirOf } from './receipts.js'

export const approvalsPathOf = (projectPath) => join(stateDirOf(projectPath), 'approvals.json')

// 只认这两个位置：写死在契约里，不做"猜文件名"。
const PROTOTYPE_CANDIDATES = ['prototype.html', join('docs', 'prototype.html')]
// 范围签核的前置：需求基线必须先存在。与 evidence 的 PRD 探测保持同一对候选路径。
const PRD_CANDIDATES = ['prd.md', join('docs', 'prd.md'), 'PRD.md']

/** 决策门 → approvals.json 里的时间字段。prototype 单独走 prototypeApprovedAt。 */
const DECISION_FIELDS = {
  scope: 'scopeApprovedAt',
  architecture: 'architectureApprovedAt',
  acceptance: 'acceptanceApprovedAt',
  release: 'releaseApprovedAt',
}

/** 允许签核的 gate 枚举；顺序与阶段一致。 */
export const DECISION_GATES = ['scope', 'architecture', 'prototype', 'acceptance', 'release']

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''
// 字段要么是有效字符串，要么是 null；空串按"没签"处理，不拿空字符串冒充已签。
const stringOrNull = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null)

/** 空指标形状：旧文件缺字段、bootstrap、条目不存在都用它，别让界面读 undefined。 */
function emptyDecisions() {
  return {
    scope: { approved: false, at: null },
    architecture: { approved: false, at: null },
    acceptance: { approved: false, at: null },
    release: { approved: false, at: null },
  }
}

export async function readApprovals(projectPath) {
  let text
  try {
    text = await readFile(approvalsPathOf(projectPath), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { map: {}, badJson: false, missing: true }
    throw error
  }
  try {
    const parsed = JSON.parse(text)
    if (!isObject(parsed)) {
      return { map: {}, badJson: true, missing: false }
    }
    const map = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!isObject(value)) continue
      // 旧文件没有这些字段：解析成 null（= 没签），不报错、不丢原型字段。
      map[key] = {
        prototypeApprovedAt: stringOrNull(value.prototypeApprovedAt),
        prototype: stringOrNull(value.prototype),
        scopeApprovedAt: stringOrNull(value.scopeApprovedAt),
        architectureApprovedAt: stringOrNull(value.architectureApprovedAt),
        acceptanceApprovedAt: stringOrNull(value.acceptanceApprovedAt),
        releaseApprovedAt: stringOrNull(value.releaseApprovedAt),
      }
    }
    return { map, badJson: false, missing: false }
  } catch {
    return { map: {}, badJson: true, missing: false }
  }
}

/** 当前迭代的原型批准。bootstrap 永远不算任何迭代的批准。 */
export function approvalFor(map, iterationId) {
  if (typeof iterationId !== 'string' || iterationId === '' || iterationId === BOOTSTRAP_ITERATION) {
    return { approved: false, at: null, file: null }
  }
  const entry = map?.[iterationId]
  if (!isObject(entry)) return { approved: false, at: null, file: null }
  const at = stringOrNull(entry.prototypeApprovedAt)
  const file = stringOrNull(entry.prototype)
  // 条目存在 ≠ 原型已批准：P1 起先签范围/架构也会建条目，所以必须看原型字段本身。
  // 旧文件（只有 prototype 没有时间戳）仍按批准处理，保证向后兼容。
  return { approved: at !== null || file !== null, at, file }
}

/**
 * 四个决策门的签核状态。形状固定，缺什么都是 false：
 * bootstrap / 空迭代 / 条目不存在 / 某门没签 ⇒ 该门 `{approved:false, at:null}`。
 */
export function decisionsFor(map, iterationId) {
  const decisions = emptyDecisions()
  if (typeof iterationId !== 'string' || iterationId === '' || iterationId === BOOTSTRAP_ITERATION) {
    return decisions
  }
  const entry = map?.[iterationId]
  if (!isObject(entry)) return decisions
  for (const [gate, field] of Object.entries(DECISION_FIELDS)) {
    const at = stringOrNull(entry[field])
    decisions[gate] = { approved: at !== null, at }
  }
  return decisions
}

export async function findPrototype(projectPath) {
  for (const relative of PROTOTYPE_CANDIDATES) {
    try {
      const info = await stat(join(projectPath, relative))
      if (info.isFile()) return relative.split('\\').join('/')
    } catch {
      // 继续看下一个候选位置
    }
  }
  return null
}

async function prdExists(projectPath) {
  for (const relative of PRD_CANDIDATES) {
    try {
      const info = await stat(join(projectPath, relative))
      if (info.isFile()) return true
    } catch {
      // 继续看下一个候选位置
    }
  }
  return false
}

async function writeApprovals(projectPath, map) {
  const dir = stateDirOf(projectPath)
  await mkdir(dir, { recursive: true })
  const target = approvalsPathOf(projectPath)
  const temp = `${target}.tmp-${randomUUID().slice(0, 8)}`
  const text = `${JSON.stringify(map, null, 2)}\n`
  await writeFile(temp, text, 'utf8')
  try {
    await rename(temp, target)
  } catch {
    // 某些文件系统（或杀软占用）不让 rename 覆盖：退回直接写，至少不丢这次批准。
    await writeFile(target, text, 'utf8')
  }
}

/**
 * 批准当前迭代的原型。返回 `{ok:true, approval}` 或 `{ok:false, error}`；
 * 只有文件系统错误才抛 —— 那是真故障，不是"条件不满足"。
 *
 * 合并写：同一迭代里已经签过的范围/架构等字段必须保留，不能被这次批准抹掉。
 */
export async function approvePrototype(projectPath, iterationId) {
  const id = typeof iterationId === 'string' ? iterationId.trim() : ''
  if (id === '' || id === BOOTSTRAP_ITERATION) return { ok: false, error: 'iteration-required' }
  const prototype = await findPrototype(projectPath)
  if (prototype === null) return { ok: false, error: 'prototype-missing' }
  const current = await readApprovals(projectPath)
  const map = { ...current.map }
  const entry = isObject(map[id]) ? { ...map[id] } : {}
  entry.prototypeApprovedAt = new Date().toISOString()
  entry.prototype = prototype
  map[id] = entry
  await writeApprovals(projectPath, map)
  return { ok: true, approval: { iterationId: id, prototypeApprovedAt: entry.prototypeApprovedAt, prototype } }
}

/** 技术门 missing 原样透给面板；门对象缺失时给一句"必需文件"，不编路径。 */
function gateMissingOf(gate) {
  const missing = Array.isArray(gate?.missing) ? gate.missing.filter(isNonEmptyString) : []
  return missing.length > 0 ? missing : ['必需文件']
}

function hasEvidence(value) {
  if (Array.isArray(value)) return value.length > 0
  return isNonEmptyString(value)
}

/**
 * 验收签核的前置：验收表非空、每条都是 pass、每条都有证据、没有失效条目。
 * 坏表 / 读失败 / 缺文件一律算"没通过"（拿不到证据就不许签核），由面板说下一步。
 */
async function acceptanceReady(projectPath, iterationId) {
  let file
  try {
    file = await readAcceptanceFile(projectPath)
  } catch {
    return { ok: false, missing: ['acceptance.json'] }
  }
  if (file.error || file.badJson || !isObject(file.table)) {
    return { ok: false, missing: ['acceptance.json'] }
  }
  // 验收表必须属于本次签核的迭代：否则会拿 v1.0 的通过记录签 v1.1。
  const tableIteration = typeof file.table.iteration_id === 'string' ? file.table.iteration_id.trim() : ''
  if (tableIteration !== '' && tableIteration !== iterationId) {
    return { ok: false, missing: ['acceptance.json#iteration'] }
  }
  const items = Array.isArray(file.table.items) ? file.table.items.filter(isObject) : []
  if (items.length === 0) return { ok: false, missing: ['items'] }

  const missing = []
  items.forEach((item, index) => {
    const label = isNonEmptyString(item.id) ? item.id : `第 ${index + 1} 条`
    // result 归一（与状态机 acceptanceAllPass 同口径）：手写大写 PASS 也算通过。
    if (String(item.result ?? '').trim().toLowerCase() !== 'pass' || !hasEvidence(item.evidence) || item.stale === true) {
      missing.push(label)
    }
  })
  return missing.length === 0 ? { ok: true, missing: [] } : { ok: false, missing }
}

/**
 * 人工签核一个决策门。
 *
 * 返回：
 * - 成功（非原型）：`{ok:true, gate, at, iteration_id}`；
 * - 成功（prototype）：复用 `approvePrototype` 的原形状 `{ok:true, approval}`（既有调用方不变）；
 * - 前置不满足：`{ok:false, error:'prd-missing'|'architecture-gate-not-ready'|'acceptance-not-passing'|'release-gate-not-ready'|'prototype-missing', missing?}`；
 * - 参数不对：`{ok:false, error:'bad-gate'|'bad-iteration'}`。
 *
 * 只有文件系统错误才抛；"条件没满足"永远走返回值（路由层翻译成状态码）。
 */
export async function approveDecision(projectPath, iterationId, gate) {
  const wanted = typeof gate === 'string' ? gate.trim() : ''
  if (!DECISION_GATES.includes(wanted)) return { ok: false, error: 'bad-gate' }
  const id = typeof iterationId === 'string' ? iterationId.trim() : ''
  if (id === '' || id === BOOTSTRAP_ITERATION) return { ok: false, error: 'bad-iteration' }

  // 原型批准保持旧行为（含错误码），/approve-prototype 的调用方不需要改。
  if (wanted === 'prototype') return approvePrototype(projectPath, id)

  if (wanted === 'scope') {
    if (!(await prdExists(projectPath))) return { ok: false, error: 'prd-missing' }
  }

  if (wanted === 'architecture') {
    const gates = await readGateEvidence(projectPath)
    if (gates?.architecture?.ok !== true) {
      return { ok: false, error: 'architecture-gate-not-ready', missing: gateMissingOf(gates?.architecture) }
    }
  }

  if (wanted === 'acceptance') {
    const acceptance = await acceptanceReady(projectPath, id)
    if (!acceptance.ok) return { ok: false, error: 'acceptance-not-passing', missing: acceptance.missing }
  }

  if (wanted === 'release') {
    // 发布批准同时要求"清单齐"与"验收过"：只满足一个都不算能上线。
    const [gates, acceptance] = await Promise.all([readGateEvidence(projectPath), acceptanceReady(projectPath, id)])
    if (gates?.release?.ok !== true || !acceptance.ok) {
      const missing = []
      if (gates?.release?.ok !== true) missing.push(...gateMissingOf(gates?.release))
      if (!acceptance.ok) missing.push('acceptance')
      return { ok: false, error: 'release-gate-not-ready', missing }
    }
  }

  const at = new Date().toISOString()
  const current = await readApprovals(projectPath)
  const map = { ...current.map }
  // 只覆盖本次签核的时间字段：同一迭代其它门的签核与原型记录原样保留。
  const entry = isObject(map[id]) ? { ...map[id] } : {}
  entry[DECISION_FIELDS[wanted]] = at
  map[id] = entry
  await writeApprovals(projectPath, map)
  return { ok: true, gate: wanted, at, iteration_id: id }
}
