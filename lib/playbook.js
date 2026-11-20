/**
 * Playbook：阶段 → 能力路由 + 可直接执行的指令模板。
 *
 * 为什么单独成模块：同一份阶段表要同时服务"面板展示能力"与"生成下一步指令"。
 * 能力存在性必须由调用方传 Set 进来（纯模块不 import DSH、不读环境），
 * 因为"读不到"和"没装"是两件不同的事 —— 读不到要报 unknown，不能谎报缺失。
 *
 * 合并规则（IMPLEMENTATION §2.3）：内置默认来自调用方传的 builtinText；项目覆盖在
 * <项目>/.dsh/plugin-state/playbook.json；同名 stage 整体替换（不做深合并），
 * 未提到的 stage 保留内置，missingHints 按 key 覆盖；坏 JSON/结构不对则整份忽略 + warning。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { stateDirOf } from './receipts.js'

/** 8 条 stage 的代码常量：receipt stage / playbook key / 人话名 的对应关系只写这一次。 */
export const STAGE_DEFS = [
  { id: 'init', name: '初始化', playbookKey: '初始化', cycle: false },
  { id: 'scaffold', name: '搭骨架', playbookKey: '搭骨架', cycle: false },
  { id: 'brainstorm', name: '想清楚', playbookKey: '想清楚', cycle: true },
  { id: 'prototype', name: '看原型', playbookKey: '定规格', cycle: true },
  { id: 'coding', name: '写代码', playbookKey: '写代码', cycle: true },
  { id: 'code_review', name: '挑毛病', playbookKey: '挑毛病', cycle: true },
  { id: 'verification', name: '验效果', playbookKey: '验效果', cycle: true },
  { id: 'release', name: '发出去', playbookKey: '发出去', cycle: true },
]

const MAX_BYTES = 2 * 1024 * 1024
const OVERRIDE_FILE_NAME = 'playbook.json'
const OVERRIDE_SOURCE = '.dsh/plugin-state/playbook.json'
const BUILTIN_SOURCE = 'playbook'
const EMPTY_CAPABILITIES_TEXT = '（按 RULES.md 自行完成）'

/**
 * 模板自带 skill / mcp 的缺失提示；tool 没有兜底文案，但缺 tool 也要能告诉人缺什么，
 * 所以这里补一条中性兜底（项目可用 missingHints 覆盖）。这是 UI 文案，不是编造数据。
 */
const FALLBACK_MISSING_HINTS = {
  skill: '该阶段需要的技能未安装：{name}。可以从技能市场安装，或跳过它用人工方式完成。',
  tool: '该阶段需要的工具不可用：{name}。装上或启用后刷新，或改用人工方式完成这一步。',
  mcp: '该阶段需要的 MCP 未安装：{name}。装上后重新检测，或先用人工方式完成这一步。',
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''
const describeError = (error) => error?.code ?? error?.message ?? '未知错误'

/** playbook 一定是 JSON 数据，用 JSON 往返克隆即可（不引第三方，也不会带出不可序列化的引用）。 */
function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function emptyPlaybook() {
  return { version: 1, stages: {}, missingHints: {} }
}

/** 内置文本 -> playbook；任何缺陷都降级为空 playbook + warning，绝不半信半疑。 */
function parseBuiltin(builtinText, warnings) {
  if (!isNonEmptyString(builtinText)) {
    warnings.push({ source: BUILTIN_SOURCE, message: '内置 playbook 缺失或为空，已按空 playbook 降级' })
    return emptyPlaybook()
  }
  let parsed = null
  try {
    parsed = JSON.parse(builtinText)
  } catch {
    parsed = null
  }
  if (!isObject(parsed) || !isObject(parsed.stages)) {
    warnings.push({ source: BUILTIN_SOURCE, message: '内置 playbook 不是合法 JSON 或缺少 stages 对象，已按空 playbook 降级' })
    return emptyPlaybook()
  }
  return {
    ...parsed,
    stages: deepClone(parsed.stages),
    missingHints: isObject(parsed.missingHints) ? { ...parsed.missingHints } : {},
  }
}

/**
 * 项目覆盖的结构校验：顶层是对象；给了 stages 就必须是对象且每个 stage 是对象；
 * 给了 missingHints 就必须是「字符串 -> 字符串」。一条不符就整份忽略（§2.3）。
 */
function validateOverride(value) {
  if (!isObject(value)) return { ok: false, reason: '顶层不是对象' }
  if (Object.hasOwn(value, 'stages')) {
    if (!isObject(value.stages)) return { ok: false, reason: 'stages 不是对象' }
    for (const [key, entry] of Object.entries(value.stages)) {
      if (!isObject(entry)) return { ok: false, reason: `stages.${key} 不是对象` }
    }
  }
  if (Object.hasOwn(value, 'missingHints')) {
    if (!isObject(value.missingHints)) return { ok: false, reason: 'missingHints 不是对象' }
    for (const [key, hint] of Object.entries(value.missingHints)) {
      if (typeof hint !== 'string') return { ok: false, reason: `missingHints.${key} 不是字符串` }
    }
  }
  return { ok: true }
}

export function stageDef(id) {
  return STAGE_DEFS.find((def) => def.id === id) ?? null
}

/** 人话阶段名；未知 id 原样返回（调用方可能传的是人话名或 null）。 */
export function stageName(id) {
  const def = stageDef(id)
  return def ? def.name : id
}

/**
 * 纯函数合并（IMPLEMENTATION §2.3）：
 * - stages 同名整体替换，未提到的保留内置；
 * - missingHints 按 key 覆盖；
 * - 无效输入（非对象/stage 条目不是对象）直接回退内置 —— loadPlaybook 负责报 warning。
 */
export function mergePlaybook(builtin, override) {
  const base = isObject(builtin) && isObject(builtin.stages)
    ? { ...deepClone(builtin), missingHints: isObject(builtin.missingHints) ? { ...builtin.missingHints } : {} }
    : emptyPlaybook()

  if (!isObject(override)) return base

  if (isObject(override.stages)) {
    for (const [key, entry] of Object.entries(override.stages)) {
      if (!isObject(entry)) continue
      base.stages[key] = deepClone(entry)
    }
  }
  if (isObject(override.missingHints)) {
    for (const [key, hint] of Object.entries(override.missingHints)) {
      if (typeof hint === 'string') base.missingHints[key] = hint
    }
  }
  return base
}

/**
 * 按 stage id 取 playbook 条目。
 * 条目自带 stageId 时以它为准（§2.3 留的口子）：先找显式声明，再按 playbookKey 兜底，
 * 这样项目可以把任意 key 改成指向某个 receipt stage，而不会同时被当成两个阶段。
 */
export function entryForStage(playbook, stageId) {
  const def = stageDef(stageId)
  if (!def) return null
  const stages = isObject(playbook) && isObject(playbook.stages) ? playbook.stages : null
  if (!stages) return null

  let declaredMatch = null
  let canonicalEntry = null
  for (const [key, entry] of Object.entries(stages)) {
    if (!isObject(entry)) continue
    const declared = isNonEmptyString(entry.stageId) ? entry.stageId.trim() : null
    const isCanonical = key === def.playbookKey
    if (isCanonical) canonicalEntry = entry
    if (declared !== null && declared === stageId) {
      if (isCanonical) return entry
      if (declaredMatch === null) declaredMatch = entry
    }
  }
  if (declaredMatch !== null) return declaredMatch
  if (canonicalEntry !== null) {
    const declared = isNonEmptyString(canonicalEntry.stageId) ? canonicalEntry.stageId.trim() : null
    if (declared === null || declared === stageId) return canonicalEntry
  }
  return null
}

const SET_BY_KIND = { skill: 'skills', tool: 'tools', mcp: 'mcp' }

/** 能力存在性：inline 恒 yes；Set 为 null = 读不到 = unknown，绝不谎报缺失。 */
function presenceOf(kind, name, services) {
  if (kind === 'inline') return 'yes'
  const setName = SET_BY_KIND[kind]
  if (!setName) return 'unknown'
  const collection = services?.[setName]
  if (collection == null) return 'unknown'
  if (typeof collection.has === 'function') return collection.has(name) ? 'yes' : 'no'
  // 契约是 Set；这里额外容忍数组，防止调用方传错类型时把"有"误判成"缺"。
  if (Array.isArray(collection)) return collection.includes(name) ? 'yes' : 'no'
  return 'unknown'
}

function missingMessageOf(kind, name, hints) {
  const hint = typeof hints?.[kind] === 'string' ? hints[kind] : FALLBACK_MISSING_HINTS[kind]
  if (typeof hint !== 'string') return null
  return hint.split('{name}').join(name)
}

/**
 * 解析某个阶段条目里的能力。entry 可为 null（→ []）。
 * services: { skills: Set<string>|null, tools: Set<string>|null, mcp: Set<string>|null, missingHints }
 */
export async function resolveCapabilities(entry, services) {
  const capabilities = Array.isArray(entry?.capabilities) ? entry.capabilities : []
  const hints = isObject(services?.missingHints) ? services.missingHints : {}
  const resolved = []

  for (const capability of capabilities) {
    if (!isObject(capability)) continue
    const name = isNonEmptyString(capability.name) ? capability.name.trim() : ''
    if (name === '') continue
    const kind = isNonEmptyString(capability.kind) ? capability.kind.trim() : 'unknown'
    const mode = isNonEmptyString(capability.mode) ? capability.mode.trim() : kind === 'inline' ? 'inline' : 'full'
    const optional = capability.optional === true
    const present = presenceOf(kind, name, services)
    resolved.push({
      kind,
      name,
      mode,
      optional,
      note: isNonEmptyString(capability.note) ? capability.note : null,
      present,
      missingMessage: present === 'no' ? missingMessageOf(kind, name, hints) : null,
    })
  }

  return resolved
}

/** 真正会阻断指令的能力：present==='no' 且非 optional。unknown 不是缺失，不阻断。 */
export function missingCapabilities(resolved) {
  const list = Array.isArray(resolved) ? resolved : []
  return list.filter((item) => item && item.present === 'no' && item.optional !== true)
}

/**
 * 渲染指令：只替换 `{capabilities}` 一个占位符，其他 `{...}` 原样保留（不猜变量）。
 * 参与替换的只有 present==='yes' 且 mode==='full' 的能力；inline 指向我们自己的规则，
 * 不是可调技能，永远不进这段文本。
 */
export function renderPrompt(entry, resolved) {
  const list = Array.isArray(resolved) ? resolved : []
  const names = []
  for (const item of list) {
    if (!item || item.present !== 'yes' || item.mode !== 'full') continue
    if (item.kind === 'inline') continue
    if (!isNonEmptyString(item.name)) continue
    names.push(item.name)
  }
  const capabilitiesText = names.length > 0 ? names.join(', ') : EMPTY_CAPABILITIES_TEXT
  const template = isNonEmptyString(entry?.promptTemplate) ? entry.promptTemplate : null
  if (template === null) return { text: null, capabilitiesText }
  return { text: template.split('{capabilities}').join(capabilitiesText), capabilitiesText }
}

/**
 * 读内置 + 项目覆盖。读不到覆盖文件是"没有覆盖"（不告警）；坏 JSON/结构不对告警并回退内置。
 * 返回的 warnings 元素统一 `{source, message}`，由调用方合并进 evidence.warnings。
 */
export async function loadPlaybook(projectPath, builtinText) {
  const warnings = []
  const builtin = parseBuiltin(builtinText, warnings)

  if (!isNonEmptyString(projectPath)) {
    return { playbook: builtin, source: 'builtin', warnings }
  }

  const overridePath = join(stateDirOf(projectPath.trim()), OVERRIDE_FILE_NAME)
  let text
  try {
    text = await readFile(overridePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { playbook: builtin, source: 'builtin', warnings }
    warnings.push({ source: OVERRIDE_SOURCE, message: `读取失败（${describeError(error)}），已回退内置 playbook` })
    return { playbook: builtin, source: 'builtin', warnings }
  }

  if (Buffer.byteLength(text) > MAX_BYTES) {
    warnings.push({ source: OVERRIDE_SOURCE, message: '超过 2 MiB，已截断读取' })
    text = text.slice(0, MAX_BYTES)
  }

  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  if (parsed === null) {
    warnings.push({ source: OVERRIDE_SOURCE, message: '不是合法 JSON，已忽略项目覆盖并回退内置 playbook' })
    return { playbook: builtin, source: 'builtin', warnings }
  }

  const checked = validateOverride(parsed)
  if (!checked.ok) {
    warnings.push({
      source: OVERRIDE_SOURCE,
      message: `结构不符合契约（${checked.reason}），已忽略项目覆盖并回退内置 playbook`,
    })
    return { playbook: builtin, source: 'builtin', warnings }
  }

  return { playbook: mergePlaybook(builtin, parsed), source: 'project', warnings }
}
