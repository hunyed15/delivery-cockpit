/**
 * 团队泳道：哪些会话正在这个项目里跑（含子代理），只读投影。
 *
 * 为什么按 **项目 cwd** 过滤，而不是"当前会话"：面板路由注册在 root scope，
 * 拿不到"用户此刻在看哪个会话"；硬猜会把别的项目里的子代理画到这张图上。
 * 会话 header 里的 cwd 是唯一能证明"它属于这个项目"的字段。
 *
 * 为什么全程不抛：这是右栏的一条附加信息，DSH 版本差异 / 服务未暴露时
 * 应该显示"读不到团队信息"，而不是让整个详情页 500。
 *
 * 行的形状：{id,name,parentName,depth,preset,origin,createdAt,running}。
 * name 优先问 `subagents.namesOf`（它知道 reviewer/checker 这类给人看的名字）；
 * 问不到就按 id 给确定性回退：没有 parent 的叫 lead，有 parent 的叫 subagent-<id 后 6 位>。
 */

import { resolve, sep } from 'node:path'

export const MAX_TEAM_AGENTS = 20

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''
const stringOrNull = (value) => (isNonEmptyString(value) ? value.trim() : null)

/** 服务在 cordis Proxy 上可能抛错而不是返回 undefined：取服务必须包住。 */
function getService(ctx, name) {
  try {
    if (!ctx || typeof ctx.get !== 'function') return null
    return ctx.get(name) ?? null
  } catch {
    return null
  }
}

function normalizePath(value) {
  if (!isNonEmptyString(value)) return null
  try {
    return resolve(value.trim())
  } catch {
    return null
  }
}

/** Windows 路径大小写不敏感：同一目录不能被判成两个项目。 */
function samePath(left, right) {
  if (left === null || right === null) return false
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** 会话在项目子目录里工作也算这个项目（worktree 仍是独立路径，需要额外映射）。 */
function insidePath(candidate, root) {
  if (candidate === null || root === null) return false
  const normalizedCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate
  const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep
  return normalizedCandidate.startsWith(prefix)
}

const tailOf = (id) => (id.length > 6 ? id.slice(-6) : id)

/** 排序：层级浅的在前；同层按创建时间（无时间排最后，不拿 0 冒充）。 */
function compareRows(left, right) {
  if (left.depth !== right.depth) return left.depth - right.depth
  if (left.createdAt === right.createdAt) return 0
  if (left.createdAt === null) return 1
  if (right.createdAt === null) return -1
  return left.createdAt < right.createdAt ? -1 : 1
}

/** namesOf 是可选服务，失败/缺字段都只当"没有名字"，不影响行本身。 */
async function namesOfAgent(subagents, agentLike) {
  if (!subagents || typeof subagents.namesOf !== 'function') return null
  try {
    const names = await subagents.namesOf(agentLike)
    if (!isObject(names)) return null
    return {
      self: stringOrNull(names.self),
      parent: stringOrNull(names.parent),
    }
  } catch {
    return null
  }
}

/**
 * @param {object} ctx  DSH context（只用到 get）
 * @param {string} projectPath 已登记工作区的绝对路径
 * @returns {Promise<{available:boolean,reason:string|null,agents:object[],truncated?:boolean}>}
 */
export async function readTeam(ctx, projectPath) {
  const agentsService = getService(ctx, 'agents')
  const sessionsService = getService(ctx, 'sessions')
  // 服务缺失 ≠ 出故障：DSH 版本没暴露时如实说"没有会话信息"，不编造 0 个成员。
  if (!agentsService || typeof agentsService.list !== 'function' || !sessionsService || typeof sessionsService.list !== 'function') {
    return { available: false, reason: 'service-missing', agents: [] }
  }

  const targetPath = normalizePath(projectPath)
  if (targetPath === null) return { available: false, reason: 'missing-project', agents: [] }

  let agentList
  let sessionList
  try {
    agentList = await agentsService.list()
    sessionList = await sessionsService.list()
  } catch {
    return { available: false, reason: 'read-error', agents: [] }
  }
  if (!Array.isArray(agentList) || !Array.isArray(sessionList)) {
    return { available: false, reason: 'read-error', agents: [] }
  }

  const onlineIds = new Set()
  const agentById = new Map()
  for (const agent of agentList) {
    const id = isObject(agent) && isNonEmptyString(agent.id) ? agent.id.trim() : ''
    if (id === '') continue
    onlineIds.add(id)
    agentById.set(id, agent)
  }

  const subagents = getService(ctx, 'subagents')
  const rows = []
  for (const session of sessionList) {
    if (!isObject(session)) continue
    const header = isObject(session.header) ? session.header : {}
    if (!samePath(normalizePath(header.cwd), targetPath) && !insidePath(normalizePath(header.cwd), targetPath)) continue

    const id = stringOrNull(header.id) ?? stringOrNull(session.id)
    if (id === null) continue
    const parentId = stringOrNull(header.parentSession)
    const names = await namesOfAgent(subagents, agentById.get(id) ?? { id })

    rows.push({
      id,
      name: names?.self ?? (parentId === null ? 'lead' : `subagent-${tailOf(id)}`),
      parentId,
      parentName: names?.parent ?? null,
      depth: Number.isInteger(header.delegationDepth) && header.delegationDepth >= 0 ? header.delegationDepth : 0,
      preset: stringOrNull(header.agentPreset),
      origin: stringOrNull(header.origin),
      createdAt: stringOrNull(header.createdAt),
      running: onlineIds.has(id),
    })
  }

  rows.sort(compareRows)
  // 父行可能被截断掉：先用全量算名字，再截断，避免 parentName 因截断凭空消失。
  const nameById = new Map(rows.map((row) => [row.id, row.name]))
  const truncated = rows.length > MAX_TEAM_AGENTS
  const kept = rows.slice(0, MAX_TEAM_AGENTS)
  return {
    available: true,
    reason: null,
    agents: kept.map((row) => ({
      id: row.id,
      name: row.name,
      parentName: row.parentName ?? (row.parentId !== null ? nameById.get(row.parentId) ?? null : null),
      depth: row.depth,
      preset: row.preset,
      origin: row.origin,
      createdAt: row.createdAt,
      running: row.running,
    })),
    truncated,
  }
}
