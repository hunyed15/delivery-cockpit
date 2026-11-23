/**
 * 项目名片：<项目>/.dsh/plugin-state/project.json。
 *
 * 为什么单独成模块：名片里混着两类字段——机器探测的（stack/commands/detectedAt）
 * 和人填的（name/oneLiner）。混在一起最容易被"刷新"顺手覆盖掉人写的定位，
 * 所以合并规则集中在这里，且只有这一个地方能写这个文件。
 *
 * 原子写：先写同目录临时文件再 rename，避免面板读到半截 JSON；Windows 上 rename
 * 可能被句柄/安全软件短暂占用，失败时退化为直接写（能写进去 > 严格原子）。
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { stateDirOf } from './receipts.js'

export const CARD_SCHEMA_VERSION = 1

const CARD_FILE_NAME = 'project.json'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''
const asStringOrNull = (value) => (isNonEmptyString(value) ? value.trim() : null)
const describeError = (error) => error?.code ?? error?.message ?? '未知错误'

const cardPathOf = (projectPath) => join(stateDirOf(projectPath), CARD_FILE_NAME)

/** 与 init 计划里的 bytes 计算共用同一口径：2 空格缩进 + 结尾换行。 */
const serializeCard = (card) => `${JSON.stringify(card, null, 2)}\n`

const isoOf = (now) => {
  const date = now instanceof Date ? now : new Date()
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

/** 把磁盘上可能半旧/手改过的名片补齐到"所有字段都存在"的形状，读侧就不用到处判空。 */
function normalizeCard(raw) {
  const card = { ...raw }
  card.schemaVersion = Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : CARD_SCHEMA_VERSION
  card.name = typeof raw.name === 'string' ? raw.name : ''
  card.oneLiner = typeof raw.oneLiner === 'string' ? raw.oneLiner : ''

  const stack = isObject(raw.stack) ? raw.stack : {}
  card.stack = {
    ...stack,
    id: isNonEmptyString(stack.id) ? stack.id : 'unknown',
    label: isNonEmptyString(stack.label) ? stack.label : '未检测到技术栈',
  }

  const commands = isObject(raw.commands) ? raw.commands : {}
  card.commands = {
    ...commands,
    dev: asStringOrNull(commands.dev),
    build: asStringOrNull(commands.build),
    previewUrl: asStringOrNull(commands.previewUrl),
  }

  // 工作流模式：full（默认）/ light（小改动轻量模式，状态机跳过架构契约与范围/架构签核）。
  card.workflow = raw.workflow === 'light' ? 'light' : 'full'
  card.detectedAt = asStringOrNull(raw.detectedAt)
  card.updatedAt = asStringOrNull(raw.updatedAt)
  return card
}

/**
 * 读名片。三种状态分开表达：
 * - missing：文件不存在（还没 init）——不是错误；
 * - broken：文件在但 JSON 坏了/结构不是对象/读不出来——UI 要提示，不能装作没数据；
 * - 其他：card 已补齐字段。
 */
export async function readProjectCard(projectPath) {
  let text
  try {
    text = await readFile(cardPathOf(projectPath), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { card: null, broken: false, missing: true }
    // 有文件但读不出来（权限/占用）也归入 broken：此时"没有名片"是假的。
    return { card: null, broken: true, missing: false }
  }

  try {
    const parsed = JSON.parse(text)
    if (!isObject(parsed)) return { card: null, broken: true, missing: false }
    return { card: normalizeCard(parsed), broken: false, missing: false }
  } catch {
    return { card: null, broken: true, missing: false }
  }
}

/**
 * 冷启动时生成默认名片。name 取目录名是确定性回退（不是编造），
 * oneLiner 留空——它是人填字段，机器不替人写定位。
 */
export function buildDefaultCard(projectPath, detected, now = new Date()) {
  const iso = isoOf(now)
  const stackId = isNonEmptyString(detected?.id) ? detected.id.trim() : 'unknown'
  const stackLabel = isNonEmptyString(detected?.label) ? detected.label.trim() : '未检测到技术栈'
  const commands = isObject(detected?.commands) ? detected.commands : {}

  return {
    schemaVersion: CARD_SCHEMA_VERSION,
    name: isNonEmptyString(projectPath) ? basename(resolve(projectPath)) : '',
    oneLiner: '',
    stack: { id: stackId, label: stackLabel },
    commands: {
      dev: asStringOrNull(commands.dev),
      build: asStringOrNull(commands.build),
      // Phase 1 不编造端口；detect 给了也不写，预览地址由人填。
      previewUrl: null,
    },
    // 未检测到技术栈不算"探测成功"，所以不写 detectedAt（与 §2.2 一致）。
    detectedAt: stackId === 'unknown' ? null : iso,
    updatedAt: iso,
    workflow: 'full',
  }
}

/**
 * 探测结果合并进名片：
 * - name/oneLiner 是人填字段，永不被探测覆盖；空就保持空（空 oneLiner ⇒ needs-human）；
 * - 探测成功才更新 stack/commands/detectedAt；
 * - 探测失败（unknown）保留上一次确认过的信息——"没检测到"不等于"没有技术栈"，
 *   直接把名片清成 unknown 反而丢掉了人已经确认过的事实。
 */
export function mergeDetected(card, detected, now = new Date()) {
  const iso = isoOf(now)
  const base = isObject(card) ? normalizeCard(card) : normalizeCard({})
  const known = isNonEmptyString(detected?.id) && detected.id.trim() !== 'unknown'

  const merged = {
    ...base,
    schemaVersion: CARD_SCHEMA_VERSION,
    updatedAt: iso,
  }

  if (known) {
    const commands = isObject(detected?.commands) ? detected.commands : {}
    merged.stack = {
      id: detected.id.trim(),
      label: isNonEmptyString(detected?.label) ? detected.label.trim() : '未检测到技术栈',
    }
    merged.commands = {
      dev: asStringOrNull(commands.dev),
      build: asStringOrNull(commands.build),
      previewUrl: null,
    }
    merged.detectedAt = iso
  }

  return merged
}

/**
 * 写名片：同目录临时文件 + rename。rename 失败回退直接写。
 * 写失败要抛，让 init 把原因记进 errors——名片写不进去不能被当成"做完了"。
 */
export async function writeProjectCard(projectPath, card) {
  if (!isObject(card)) throw new TypeError('项目名片必须是对象')

  const filePath = cardPathOf(projectPath)
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })

  const text = serializeCard(card)
  const tempPath = join(dir, `.${CARD_FILE_NAME}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`)

  try {
    await writeFile(tempPath, text, 'utf8')
    await rename(tempPath, filePath)
  } catch (error) {
    // 清理临时文件失败不影响结论；真正要关心的是下面直接写能不能成功。
    try {
      await unlink(tempPath)
    } catch {
      /* 临时文件可能根本没写出来，忽略 */
    }
    await writeFile(filePath, text, 'utf8')
    return { ok: true, path: filePath, bytes: Buffer.byteLength(text), fallbackReason: describeError(error) }
  }

  return { ok: true, path: filePath, bytes: Buffer.byteLength(text) }
}

const statusOfCard = (card) => (isNonEmptyString(card.oneLiner) ? 'filled' : 'needs-human')

/**
 * 名片状态。契约只给了一个参数，但调用方手里可能只有名片对象，也可能有
 * readProjectCard 的整个结果；两种写法都接受，避免 B 层为了 broken 再写一遍判断。
 */
export function cardStatus(card) {
  if (!isObject(card)) return 'missing'

  const looksLikeReadResult = Object.hasOwn(card, 'card') || Object.hasOwn(card, 'broken') || Object.hasOwn(card, 'missing')
  if (looksLikeReadResult) {
    if (card.broken === true) return 'broken'
    if (card.missing === true || !isObject(card.card)) return 'missing'
    return statusOfCard(card.card)
  }

  return statusOfCard(card)
}
