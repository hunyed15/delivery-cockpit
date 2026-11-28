/**
 * 角色化能力路由：节点不绑定具体技能，只声明"这一步需要哪些角色"，
 * 由这里按"装没装"把角色解析成具体能力（首选 → 替代 → 回退）。
 *
 * 为什么要有这一层（prd.md FR-2）：
 * - 9 个节点是流程，能力是会换、会复用、会缺的东西；
 * - 同一能力可被多个节点复用（verify-claims 服务测试与验收），
 *   所以"节点 → 技能"不能 1:1，必须经过角色。
 *
 * 口径：
 * - presence='yes' / 'unknown' 都认为可用（unknown 不当缺失，避免误禁用）；
 * - presence='no' 才换下一个；
 * - 首选/替代都不可用时落到 fallback（一段人话做法，不是技能名）；
 * - 角色没有 primary 的是"内置做法"（如写 PRD、人点节点），不需要外部能力。
 */

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const asArray = (value) => (Array.isArray(value) ? value : [])
const text = (value) => (typeof value === 'string' ? value.trim() : '')

/** 能力名 → kind（用于展示与存在性检测）。 */
export function kindOf(name) {
  if (name === 'context7' || name === 'playwright') return 'mcp'
  if (name === 'claude_review' || name === 'claude_review_disposition' || name === 'cockpit_init' || name === 'cockpit_acceptance' || name === 'cockpit_task' || name === 'cockpit_next' || name === 'cockpit_report') {
    return 'tool'
  }
  if (name.startsWith('human-')) return 'human'
  return 'skill'
}

function presenceLookup(stageCapabilities) {
  const map = new Map()
  for (const row of asArray(stageCapabilities)) {
    if (!isObject(row)) continue
    const name = text(row.name)
    if (name === '') continue
    map.set(name, row.present === 'no' ? 'no' : row.present === 'yes' ? 'yes' : 'unknown')
  }
  return (name) => map.get(name) ?? 'unknown'
}

/**
 * 把一个阶段的 roles + sequence 解析成可执行计划。
 * @returns {{stage:[], items:Array, needsHuman:string[]}}
 */
export function resolveStagePlan(entry, stageCapabilities = []) {
  const presence = presenceLookup(stageCapabilities)
  const roles = new Map()
  for (const role of asArray(entry?.roles)) {
    if (!isObject(role)) continue
    const id = text(role.id)
    if (id !== '') roles.set(id, role)
  }

  const items = []
  const needsHuman = []
  for (const step of asArray(entry?.sequence)) {
    const id = text(step)
    if (id === '') continue

    // 非角色步骤：read-input / report 这类固定动作
    if (!roles.has(id)) {
      const label = id === 'read-input' ? '先读状态与上游产物' : id === 'report' ? '写执行回执' : id
      items.push({ step: id, kind: id === 'report' ? 'report' : 'step', label })
      continue
    }

    const role = roles.get(id)
    const label = text(role.label) || id
    const primary = text(role.primary)
    const alternatives = asArray(role.alternatives).map(text).filter(Boolean)
    const fallback = text(role.fallback)

    if (kindOf(id) === 'human' || id.startsWith('human-')) {
      needsHuman.push(id)
      items.push({ step: id, kind: 'human', role: id, label, chosen: null, chosenKind: 'human', reason: 'human-required' })
      continue
    }

    if (primary === '') {
      // 内置做法：不需要外部能力，fallback 是做法说明
      items.push({
        step: id,
        kind: 'builtin',
        role: id,
        label,
        chosen: null,
        chosenKind: 'builtin',
        fallback: fallback || null,
        reason: 'builtin',
      })
      continue
    }

    const candidates = [primary, ...alternatives]
    let chosen = ''
    let reason = ''
    for (let index = 0; index < candidates.length; index += 1) {
      const name = candidates[index]
      if (presence(name) === 'no') continue
      chosen = name
      reason = index === 0 ? (presence(name) === 'yes' ? 'primary' : 'primary-unverified') : 'alternative'
      break
    }

    if (chosen === '') {
      items.push({
        step: id,
        kind: 'fallback',
        role: id,
        label,
        chosen: null,
        chosenKind: 'fallback',
        tried: candidates,
        fallback: fallback || '按技能里的「失败与回退」自行处理，并在回执说明',
        reason: 'fallback',
      })
      continue
    }

    items.push({
      step: id,
      kind: 'capability',
      role: id,
      label,
      chosen,
      chosenKind: kindOf(chosen),
      reason,
    })
  }

  return { items, needsHuman }
}

/** 一句话摘要，给面板与指令用（例如「设计方法：frontend-design → 视觉证据：playwright」）。 */
export function summarizePlan(plan) {
  const parts = []
  for (const item of asArray(plan?.items)) {
    if (item.kind === 'capability') parts.push(`${item.label}：${item.chosen}`)
    else if (item.kind === 'fallback') parts.push(`${item.label}：回退做法`)
    else if (item.kind === 'human') parts.push(`${item.label}（人）`)
  }
  return parts.join(' · ')
}
