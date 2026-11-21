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

import { BOOTSTRAP_ITERATION, appendReceipt, currentIteration, readReceipts, stateDirOf } from './receipts.js'

export const ACCEPTANCE_SCHEMA_VERSION = 1
export const MAX_DRAFT_ITEMS = 100
export const MAX_EVIDENCE = 20
export const MAX_SHOT_DIFFS = 20

const FEATURE_CODE = /^FR-\d+$/i
const RESULT_VALUES = new Set(['pass', 'fail', 'blocked'])
const URL_PATTERN = /^https?:\/\//i
/** 这两种视觉回归结论意味着"页面真的变了"，之前基于旧版给出的 pass 必须失效。 */
const VISUAL_CHANGE_VERDICTS = new Set(['changed', 'different-size'])

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
    // 验收失效：之前判了通过，但截图后来发生了视觉变化 ⇒ 阶段门必须要求重新确认。
    stale: item.stale === true,
    staleAt: isNonEmptyString(item.stale_at) ? item.stale_at : null,
    staleReason: isNonEmptyString(item.stale_reason) ? item.stale_reason : null,
    shotDiffs: Array.isArray(item.shot_diffs) ? item.shot_diffs.filter(isObject).slice(-MAX_SHOT_DIFFS).map(normalizeShotDiffView) : [],
  }
}

/** 视觉回归记录：只留展示需要的字段，比例截到 4 位小数。 */
export function normalizeShotDiffView(raw) {
  const record = isObject(raw) ? raw : {}
  const verdict = ['same', 'changed', 'different-size', 'uncomparable', 'new'].includes(record.verdict) ? record.verdict : 'uncomparable'
  return {
    at: isNonEmptyString(record.at) ? record.at : null,
    verdict,
    baseline: isNonEmptyString(record.baseline) ? record.baseline : null,
    diffFile: isNonEmptyString(record.diffFile) ? record.diffFile : null,
    ratio: typeof record.ratio === 'number' && Number.isFinite(record.ratio) ? Math.round(record.ratio * 10000) / 10000 : null,
    changedPixels: Number.isInteger(record.changedPixels) ? record.changedPixels : null,
    totalPixels: Number.isInteger(record.totalPixels) ? record.totalPixels : null,
    width: Number.isInteger(record.width) ? record.width : null,
    height: Number.isInteger(record.height) ? record.height : null,
    // uncomparable 时告诉人为什么（baseline-missing / baseline-url / unsupported …）。
    reason: isNonEmptyString(record.reason) ? record.reason : null,
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
 * 打开"可编辑的验收条目"：迭代/坏表/跨迭代/条目不存在 这些前置条件收敛成一处，
 * 免得两个写入口（填结果、加证据）各写一份口径。
 */
async function loadEditableItem(projectPath, itemId) {
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
  return { ok: true, table, current, items, index }
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

  const loaded = await loadEditableItem(projectPath, itemId)
  if (!loaded.ok) return loaded
  const { table, current, items, index } = loaded

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

  // 人重新做了判断：失效标记清掉（任何显式结果，包括撤销，都算重新确认过）。
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
    stale: false,
    stale_at: null,
    stale_reason: null,
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

/**
 * 往已有条目上追加一条证据（截图用），**不改结果**：
 * 截了图不等于验过了，通过仍要人点。这是"证据"与"判断"之间那条线。
 */
export async function addAcceptanceEvidence(projectPath, input = {}) {
  const raw = isObject(input) ? input : {}
  const itemId = typeof raw.item_id === 'string' ? raw.item_id.trim() : ''
  if (itemId === '') return { ok: false, error: 'item-required' }

  const loaded = await loadEditableItem(projectPath, itemId)
  if (!loaded.ok) return loaded
  const { table, current, items, index } = loaded

  // 证据是"刚截的图"：必须真实存在（同样不接受编造路径）。
  const evidenceCheck = await normalizeEvidence(projectPath, raw.evidence, { validate: true })
  if (!evidenceCheck.ok) return evidenceCheck
  if (evidenceCheck.evidence.length === 0) return { ok: false, error: 'evidence-required' }

  const existing = items[index]
  const currentEvidence = Array.isArray(existing.evidence) ? existing.evidence.map(String) : []
  const merged = [...currentEvidence]
  for (const entry of evidenceCheck.evidence) {
    if (!merged.includes(entry)) merged.push(entry)
  }
  const nextItem = { ...existing, evidence: merged.slice(0, MAX_EVIDENCE) }

  // 视觉回归结果：只追加，保留最近 MAX_SHOT_DIFFS 次（每次截图一条）。
  let shotRecord = null
  if (raw.shotDiff != null) {
    shotRecord = normalizeShotDiffView(raw.shotDiff)
    if (shotRecord.at === null) shotRecord.at = new Date().toISOString()
    const history = Array.isArray(existing.shot_diffs) ? existing.shot_diffs.filter(isObject) : []
    nextItem.shot_diffs = [...history, shotRecord].slice(-MAX_SHOT_DIFFS)
  }

  // 阶段门联动：之前判了 pass，但这次截图真的变了（changed/different-size）⇒ 该条验收失效。
  // 失效不等于改结果：原来的 pass 与证据都留着当历史，但阶段门不再认它，必须人重新确认。
  const previousResult = RESULT_VALUES.has(String(existing.result ?? '').toLowerCase())
    ? String(existing.result).toLowerCase()
    : null
  const invalidate =
    raw.invalidateOnVisualChange !== false &&
    previousResult === 'pass' &&
    shotRecord !== null &&
    VISUAL_CHANGE_VERDICTS.has(shotRecord.verdict)
  if (invalidate) {
    nextItem.stale = true
    nextItem.stale_at = shotRecord.at
    nextItem.stale_reason = 'visual-change'
  }

  const nextTable = {
    ...table,
    schemaVersion: Number.isInteger(table.schemaVersion) ? table.schemaVersion : ACCEPTANCE_SCHEMA_VERSION,
    iteration_id: current,
    items: [...items.slice(0, index), nextItem, ...items.slice(index + 1)],
  }
  await writeTable(projectPath, nextTable)

  // 失效必须留痕：往执行回执账本追加一条，让流水账能追溯"哪次截图让哪条验收失效"。
  // 写回执失败不算截图失败（截图与失效已落盘），但要如实把原因带回给界面。
  let receiptId = null
  let receiptWarning = null
  if (invalidate && raw.receiptOnInvalidate !== false) {
    const featureRef = typeof nextItem.feature_ref === 'string' && nextItem.feature_ref.trim() !== ''
      ? nextItem.feature_ref.trim().toUpperCase()
      : null
    try {
      const appended = await appendReceipt(projectPath, {
        iteration_id: current,
        stage: 'verification',
        status: 'in_progress',
        // 审计事件：会出现在流水账里，但不参与阶段进度/功能状态投影（见 receipts.isAuditReceipt）。
        event: 'acceptance-stale',
        summary_for_human:
          `截图有变化（${Math.round((shotRecord?.ratio ?? 0) * 10000) / 100}%），` +
          `验收「${nextItem.title}」已失效，需要你重新确认`,
        used_skill_or_mcp: null,
        artifacts: evidenceCheck.evidence,
        task_ref: null,
        write_scope: [],
        feature_ids: featureRef === null ? [] : [featureRef],
      })
      if (appended.ok) receiptId = appended.receipt.id
      else receiptWarning = appended.error
    } catch (error) {
      receiptWarning = String(error?.message ?? error)
    }
  }

  return {
    ok: true,
    item: toAcceptanceItemView(nextItem),
    added: merged.length - currentEvidence.length,
    shotDiff: shotRecord,
    invalidated: invalidate,
    receiptId,
    receiptWarning,
  }
}

