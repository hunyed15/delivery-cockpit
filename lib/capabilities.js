/**
 * 阶段能力校验：把 playbook 声明的"这一阶段唯一方法"（method）与回执里自报的
 * `used_skill_or_mcp` 对上，作为 `cockpit_report` 的写入前置校验。
 *
 * 为什么要有这一层（docs/CAPABILITIES.md §2.6）：阶段是否真的用了该用的方法，
 * 以前只能靠回执"声称"；把 method 与回执绑定后，"写了回执但没用方法"会当场被拒，
 * 而不是到门禁阶段才发现证据对不上。
 *
 * 三条口径：
 * - `constraint`（ponytail / impeccable 这类约束）**不能**冒充 method：它限制怎么做，
 *   不规定这一步的流程，所以不进 allowed；
 * - `optional: true` 的能力是"有就用、没有可回退"：回退时允许通过，但必须给出 warning
 *   让人知道这一阶段方法不是首选；缺 method 条目的能力一律视为 required（缺条目 = 没声明可选）；
 * - token 化只做**确定性切分**（空白 / 逗号 / 加号 / 斜杠 / 竖线），大小写不敏感；
 *   非字符串一律当"没记录"，不猜。
 */

import { entryForStage, stageDef } from './playbook.js'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''

const TOKEN_SEPARATORS = /[\s,+/|]+/

/**
 * `used_skill_or_mcp` -> 小写 token 集合。
 * 回执可能写成 `tdd-loop`、`TDD-Loop, ponytail`、`verify-claims / playwright` 等，
 * 这里统一切开，匹配时不再关心写法差异。非字符串返回空集合（= 没记录）。
 */
export function capabilityTokens(value) {
  const tokens = new Set()
  if (typeof value !== 'string') return tokens
  for (const raw of value.split(TOKEN_SEPARATORS)) {
    const token = raw.trim().toLowerCase()
    if (token !== '') tokens.add(token)
  }
  return tokens
}

function canonicalStageId(stageId) {
  const def = stageDef(stageId)
  if (def) return def.id
  return isNonEmptyString(stageId) ? stageId.trim() : null
}

function stageLabel(stageId) {
  const def = stageDef(stageId)
  if (def) return def.name
  const canonical = canonicalStageId(stageId)
  return canonical ?? '未知阶段'
}

/**
 * 取某阶段的 method 要求（纯函数，无 I/O）。
 *
 * 返回：
 * - `{ok:true, skipped:true}`：playbook 里没有这个阶段（或不是对象）⇒ 无从校验；
 * - `{ok:true, skipped:false, stageId, name, method, optional, allowed}`：拿到声明。
 *   `method` 为空字符串表示该阶段没声明唯一方法（同样跳过，不算缺失）。
 *
 * `allowed` = [method, ...substitute:true 的能力名] 去重去空。规则：
 * - `optional` 只表示"该方法缺失时允许回退"，**不等于 method 替代品**；
 * - 只有显式 `substitute:true` 的能力（如 claude_review 替代 claude-code-review）
 *   才能当方法证据；playwright / context7 / ui-ux-pro-max 这类证据或辅助能力不能静默顶替。
 * - constraint 不参与：它可能也列在 capabilities[] 里，但角色是"约束"，不是这一阶段的方法。
 */
export function stageCapabilityRequirement(playbook, stageId) {
  const entry = entryForStage(playbook, stageId)
  if (!isObject(entry)) return { ok: true, skipped: true }

  const method = isNonEmptyString(entry.method) ? entry.method.trim() : ''
  const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities : []
  const declared = capabilities.find(
    (capability) => isObject(capability) && isNonEmptyString(capability.name) && capability.name.trim() === method,
  )
  // 缺条目视为 required：没声明 optional 的能力不能靠"缺条目"绕过校验。
  const optional = method !== '' && declared?.optional === true

  const allowed = []
  const substitutes = []
  const pushAllowed = (name) => {
    if (!isNonEmptyString(name)) return
    const trimmed = name.trim()
    if (trimmed !== '' && !allowed.includes(trimmed)) allowed.push(trimmed)
  }
  pushAllowed(method)
  for (const capability of capabilities) {
    if (isObject(capability) && capability.substitute === true) {
      pushAllowed(capability.name)
      if (isNonEmptyString(capability.name)) substitutes.push(capability.name.trim())
    }
  }

  return {
    ok: true,
    skipped: false,
    stageId: canonicalStageId(stageId),
    name: stageLabel(stageId),
    method,
    optional,
    substitutes,
    allowed,
  }
}

/**
 * 校验某阶段回执是否满足能力要求（纯函数，无 I/O）。
 *
 * 返回：
 * - `{ok:true, skipped:true}`：阶段没有 method 声明（如需求定义）⇒ 不校验；
 * - `{ok:true, matched}`：命中 allowed 里的名字（大小写不敏感）；
 * - `{ok:true, fallback:true, warning}`：方法本身可选，用了回退能力或没记录；
 * - `{ok:false, error:'stage-capability-required', stageId, method, allowed, message}`：必须拒绝。
 */
export function checkStageCapability(playbook, stageId, usedValue) {
  const requirement = stageCapabilityRequirement(playbook, stageId)
  if (requirement.ok !== true || requirement.skipped === true || requirement.method === '') {
    return { ok: true, skipped: true }
  }

  const tokens = capabilityTokens(usedValue)
  const matched = requirement.allowed.find((name) => tokens.has(name.toLowerCase())) ?? null
  if (matched !== null) return { ok: true, matched }

  if (requirement.optional === true) {
    // 可选方法：用了别的能力（回退）或干脆没记录，都不阻断；但必须让人看见这一阶段不是首选方法。
    const recorded = isNonEmptyString(usedValue)
    return {
      ok: true,
      fallback: true,
      warning: recorded ? '该阶段方法为可选，已按回退能力记录' : '该阶段方法为可选，未记录 used_skill_or_mcp',
    }
  }

  return {
    ok: false,
    error: 'stage-capability-required',
    stageId: requirement.stageId,
    method: requirement.method,
    allowed: requirement.allowed,
    message:
      `本阶段（${requirement.name}）必须使用 ${requirement.method} 并写入 used_skill_or_mcp；` +
      `允许：${requirement.allowed.join('、')}。缺失时使用回退能力并在回执说明。`,
  }
}
