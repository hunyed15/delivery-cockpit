/**
 * 验收表起草：Agent 按 PRD 功能写条目，人负责填结果与证据。
 *
 * 为什么必须有这一层：面板能展示"哪些功能没验过"，但让人手工拼 acceptance.json 既容易写坏
 * 也容易覆盖已有的 result/evidence。所以起草走强类型工具，写入规则收紧成一条：
 * **只追加，绝不覆盖已有条目**（result/evidence 是人的判断与证据，插件无权改）。
 */
import { readFile, mkdir, writeFile, rename, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { BOOTSTRAP_ITERATION, currentIteration, readReceipts, stateDirOf } from './receipts.js'

export const ACCEPTANCE_SCHEMA_VERSION = 1
export const MAX_DRAFT_ITEMS = 100
export const MAX_EVIDENCE = 20

const FEATURE_CODE = /^FR-\d+$/i
const RESULT_VALUES = new Set(['pass', 'fail', 'blocked'])
const URL_PATTERN = /^https?:\/\//i

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''
const describeError = (error) => error?.code ?? error?.message ?? '未知错误'

export const acceptancePathOf = (projectPath) => join(stateDirOf(projectPath), 'acceptance.json')

/** 读验收表。missing / badJson 分开表达：坏表绝不能被当成空表覆盖掉。 */
export async function readAcceptanceFile(projectPath) {
  let text
  try {
    text = await readFile(acceptancePathOf(projectPath), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { table: null, missing: true, badJson: false, error: null }
    return { table: null, missing: false, badJson: false, error }
  }
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  if (!isObject(parsed) || !Array.isArray(parsed.items)) {
    return { table: null, missing: false, badJson: true, error: null }
  }
  return { table: parsed, missing: false, badJson: false, error: null }
}

/** 校验并规整一条待起草条目；result/evidence 由人后续填写，起草时固定为空。 */
export function normalizeDraftItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return { ok: false, error: 'items 必须是数组且至少一条' }
  if (rawItems.length > MAX_DRAFT_ITEMS) return { ok: false, error: `一次最多起草 ${MAX_DRAFT_ITEMS} 条` }
  const items = []
  const problems = []
  rawItems.forEach((raw, index) => {
    if (!isObject(raw)) {
      problems.push(`第 ${index + 1} 条不是对象`)
      return
    }
    const title = isNonEmptyString(raw.title) ? raw.title.trim() : ''
    if (title === '') problems.push(`第 ${index + 1} 条缺 title`)
    const featureRaw = typeof raw.feature_ref === 'string' ? raw.feature_ref.trim() : ''
    if (featureRaw !== '' && !FEATURE_CODE.test(featureRaw)) {
      problems.push(`第 ${index + 1} 条 feature_ref 必须是 FR-<数字>（收到 ${featureRaw}）`)
    }
    items.push({
      feature_ref: featureRaw === '' ? null : featureRaw.toUpperCase(),
      title,
      steps: isNonEmptyString(raw.steps) ? raw.steps.trim() : '',
      expect: isNonEmptyString(raw.expect) ? raw.expect.trim() : '',
      result: null,
      evidence: [],
      at: null,
    })
  })
  if (problems.length > 0) return { ok: false, error: problems.join('；') }
  return { ok: true, items }
}

async function writeTable(projectPath, table) {
  const dir = stateDirOf(projectPath)
  await mkdir(dir, { recursive: true })
  const target = acceptancePathOf(projectPath)
  const temp = `${target}.tmp-${randomUUID().slice(0, 8)}`
  const text = `${JSON.stringify(table, null, 2)}\n`
  await writeFile(temp, text, 'utf8')
  try {
    await rename(temp, target)
  } catch {
    await writeFile(target, text, 'utf8')
  }
}

/**
 * 起草验收条目。错误码（调用方翻译成人话）：
 * - `iteration-required`：还没有迭代（bootstrap）——验收表属于迭代环
 * - `acceptance-broken`：现有 acceptance.json 坏了；不覆盖、不猜测
 * - `iteration-mismatch`：现有验收表属于别的迭代；不擅自改写
 */
export async function draftAcceptance(projectPath, rawItems) {
  const normalized = normalizeDraftItems(rawItems)
  if (!normalized.ok) return { ok: false, error: normalized.error }

  let current = BOOTSTRAP_ITERATION
  try {
    const read = await readReceipts(projectPath)
    current = currentIteration(read.receipts)
  } catch {
    current = BOOTSTRAP_ITERATION
  }
  if (current === BOOTSTRAP_ITERATION) return { ok: false, error: 'iteration-required' }

  const file = await readAcceptanceFile(projectPath)
  if (file.error) return { ok: false, error: `读取验收表失败：${describeError(file.error)}` }
  if (file.badJson) return { ok: false, error: 'acceptance-broken' }

  const table = file.table ?? { schemaVersion: ACCEPTANCE_SCHEMA_VERSION, iteration_id: current, items: [] }
  const bound = typeof table.iteration_id === 'string' && table.iteration_id.trim() !== '' ? table.iteration_id.trim() : null
  if (bound !== null && bound !== current) return { ok: false, error: 'iteration-mismatch', iterationId: bound }

  // 已有条目原样保留：只在末尾追加，绝不改 result / evidence / expect。
  const existing = Array.isArray(table.items) ? table.items.filter(isObject) : []
  const keys = new Set(existing.map((item) => `${typeof item.feature_ref === 'string' ? item.feature_ref.toUpperCase() : ''}|${String(item.title ?? '')}`))
  const appended = []
  const skipped = []
  for (const draft of normalized.items) {
    const key = `${draft.feature_ref ?? ''}|${draft.title}`
    if (keys.has(key)) {
      skipped.push({ title: draft.title, reason: 'exists' })
      continue
    }
    keys.add(key)
    appended.push({ ...draft })
  }

  if (appended.length > 0) {
    const used = new Set(existing.map((item) => String(item.id ?? '')).filter((id) => id !== ''))
    let next = 1
    for (const item of appended) {
      while (used.has(`A${next}`)) next += 1
      item.id = `A${next}`
      used.add(item.id)
    }
    const nextTable = {
      ...table,
      schemaVersion: Number.isInteger(table.schemaVersion) ? table.schemaVersion : ACCEPTANCE_SCHEMA_VERSION,
      iteration_id: current,
      items: [...existing, ...appended],
    }
    await writeTable(projectPath, nextTable)
  }

  return {
    ok: true,
    added: appended.length,
    skipped: skipped.length,
    skippedDetails: skipped,
    total: existing.length + appended.length,
    iterationId: current,
  }
}

/** 给界面用的验收条目形状（保持字段名稳定，避免前端跟着存储格式漂）。 */
export function toAcceptanceItemView(raw) {
  const item = isObject(raw) ? raw : {}
  return {
    id: String(item.id ?? ''),
    featureRef: typeof item.feature_ref === 'string' && item.feature_ref.trim() !== '' ? item.feature_ref.trim() : null,
    title: String(item.title ?? ''),
    steps: String(item.steps ?? ''),
    expect: String(item.expect ?? ''),
    result: RESULT_VALUES.has(String(item.result ?? '').toLowerCase()) ? String(item.result).toLowerCase() : null,
    evidence: Array.isArray(item.evidence) ? item.evidence.filter((entry) => isNonEmptyString(entry)).map(String) : [],
    at: typeof item.at === 'string' ? item.at : null,
  }
}

/**
 * 证据校验。`validate:false` 时只做规整（路径归一/URL 原样），不校验文件是否存在——
 * 用于 fail/blocked 这类"证据只是备注"的场景：旧证据文件删了不该让人连失败/撤销都点不动。
 * 越出项目的路径与非法类型一律拒绝（任何情况下都不接受项目外的路径）。
 */
export async function normalizeEvidence(projectPath, rawEvidence, options = {}) {
  const validate = options.validate !== false
  const entries = Array.isArray(rawEvidence) ? rawEvidence : rawEvidence == null ? [] : [rawEvidence]
  const root = resolve(projectPath)
  const evidence = []
  for (const raw of entries.slice(0, MAX_EVIDENCE)) {
    if (typeof raw !== 'string') return { ok: false, error: 'bad-evidence' }
    const value = raw.trim()
    if (value === '') continue
    if (URL_PATTERN.test(value)) {
      evidence.push(value)
      continue
    }
    const absolute = resolve(root, value)
    const rel = relative(root, absolute)
    // `..foo` 是合法文件名，只有真正的 `..` 前缀才是越界。
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return { ok: false, error: 'evidence-not-found', detail: value }
    }
    if (!validate) {
      evidence.push(rel.split(sep).join('/'))
      continue
    }
    let info
    try {
      info = await stat(absolute)
    } catch {
      return { ok: false, error: 'evidence-not-found', detail: value }
    }
    if (!info.isFile()) return { ok: false, error: 'evidence-not-found', detail: value }
    evidence.push(rel.split(sep).join('/'))
  }
  return { ok: true, evidence }
}

/**
 * 人工在面板上填一条验收结果（这是"人的判断"，与起草完全分开）。
 * - `result=null` 表示撤销：清空 result/evidence/at，回到"未验"；
 * - `result='pass'` 必须有证据（文件真实存在或 http(s) URL）；证据永不伪造。
 */
export async function setAcceptanceResult(projectPath, input = {}) {
  const raw = isObject(input) ? input : {}
  const itemId = typeof raw.item_id === 'string' ? raw.item_id.trim() : ''
  if (itemId === '') return { ok: false, error: 'item-required' }

  // 必须显式给 result：字段缺失（含 undefined）≠ 撤销。缺失时当撤销会静默清空人已经填好的结果与证据。
  if (!Object.prototype.hasOwnProperty.call(raw, 'result') || raw.result === undefined) {
    return { ok: false, error: 'bad-result' }
  }
  // 大小写不敏感（'PASS' 也算通过），避免手工调用踩坑；存盘统一小写。
  const result = raw.result === null ? null : String(raw.result).trim().toLowerCase()
  if (result !== null && !RESULT_VALUES.has(result)) return { ok: false, error: 'bad-result' }

  let current = BOOTSTRAP_ITERATION
  try {
    const read = await readReceipts(projectPath)
    current = currentIteration(read.receipts)
  } catch {
    current = BOOTSTRAP_ITERATION
  }
  if (current === BOOTSTRAP_ITERATION) return { ok: false, error: 'iteration-required' }

  const file = await readAcceptanceFile(projectPath)
  if (file.error) return { ok: false, error: 'acceptance-broken', detail: describeError(file.error) }
  if (file.badJson) return { ok: false, error: 'acceptance-broken' }
  if (!isObject(file.table)) return { ok: false, error: 'item-not-found' }

  const table = file.table
  const bound = typeof table.iteration_id === 'string' && table.iteration_id.trim() !== '' ? table.iteration_id.trim() : null
  if (bound !== null && bound !== current) return { ok: false, error: 'iteration-mismatch', iterationId: bound }

  const items = Array.isArray(table.items) ? table.items.filter(isObject) : []
  const index = items.findIndex((item) => String(item.id ?? '') === itemId)
  if (index < 0) return { ok: false, error: 'item-not-found' }

  // 证据规则按结果区分：
  // - pass：必须至少一条且项目内文件必须真实存在（这是"通过"的门禁）；
  // - fail/blocked：证据是备注，旧文件被删也不该阻止改判；
  // - null（撤销）：无条件成功，直接清空证据与时间，不碰磁盘。
  let evidence = []
  if (result !== null) {
    const evidenceCheck = await normalizeEvidence(projectPath, raw.evidence, { validate: result === 'pass' })
    if (!evidenceCheck.ok) return evidenceCheck
    if (result === 'pass' && evidenceCheck.evidence.length === 0) return { ok: false, error: 'evidence-required' }
    evidence = evidenceCheck.evidence
  }

  const existing = items[index]
  const nextItem = {
    ...existing,
    id: existing.id,
    feature_ref: typeof existing.feature_ref === 'string' ? existing.feature_ref : null,
    title: String(existing.title ?? ''),
    steps: String(existing.steps ?? ''),
    expect: String(existing.expect ?? ''),
    result,
    evidence,
    at: result === null ? null : new Date().toISOString(),
  }
  const nextTable = {
    ...table,
    schemaVersion: Number.isInteger(table.schemaVersion) ? table.schemaVersion : ACCEPTANCE_SCHEMA_VERSION,
    iteration_id: current,
    items: [...items.slice(0, index), nextItem, ...items.slice(index + 1)],
  }
  await writeTable(projectPath, nextTable)
  return { ok: true, item: toAcceptanceItemView(nextItem) }
}
