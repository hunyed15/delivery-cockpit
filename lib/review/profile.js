/**
 * 项目级评审配置：Claude Code / Gemini(Antigravity agy) 切换 + 模型 + agy 代理。
 *
 * 为什么放在项目状态里而不是只放插件配置：不同项目可能想用不同评审器；
 * 面板切换只影响当前项目，插件默认值仍由 cordis 配置提供（Claude 为默认）。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const REVIEW_PROFILE_REL = '.dsh/plugin-state/review.json'
export const REVIEW_PROFILE_AGENTS = new Set(['claude', 'agy'])
const MAX_MODEL_LEN = 120
const MAX_PROXY_LEN = 300

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function normalizeAgent(value) {
  const agent = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return REVIEW_PROFILE_AGENTS.has(agent) ? agent : ''
}

function normalizeText(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text.length > max ? text.slice(0, max) : text
}

function normalizeProxy(value) {
  const proxy = normalizeText(value, MAX_PROXY_LEN)
  if (proxy === '') return ''
  try {
    const url = new URL(proxy)
    return url.protocol === 'http:' || url.protocol === 'https:' ? proxy : ''
  } catch {
    return ''
  }
}

function normalizeProfile(raw) {
  const value = isObject(raw) ? raw : {}
  return {
    agent: normalizeAgent(value.agent),
    model: normalizeText(value.model, MAX_MODEL_LEN),
    agyProxy: normalizeProxy(value.agyProxy),
  }
}

/** 读项目覆盖；缺文件/坏 JSON 都返回空覆盖，不阻断评审。 */
export async function readReviewProfile(projectPath) {
  const empty = { exists: false, error: null, agent: '', model: '', agyProxy: '', set: { agent: false, model: false, agyProxy: false } }
  if (typeof projectPath !== 'string' || projectPath.trim() === '') return empty
  const path = join(projectPath, ...REVIEW_PROFILE_REL.split('/'))
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return { ...empty, error: error?.code === 'ENOENT' ? null : 'read-error' }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ...empty, exists: true, error: 'bad-json' }
  }
  if (!isObject(parsed)) return { ...empty, exists: true, error: 'wrong-shape' }
  return {
    exists: true,
    error: null,
    ...normalizeProfile(parsed),
    set: {
      agent: Object.hasOwn(parsed, 'agent'),
      model: Object.hasOwn(parsed, 'model'),
      agyProxy: Object.hasOwn(parsed, 'agyProxy'),
    },
  }
}

/**
 * 写项目覆盖（与已有值合并）。只接受已知字段；agent 必须 claude/agy，
 * agyProxy 必须是 http(s) URL，model 留空表示用引擎默认。
 */
export async function writeReviewProfile(projectPath, patch) {
  if (typeof projectPath !== 'string' || projectPath.trim() === '') return { ok: false, error: 'project-required' }
  if (!isObject(patch)) return { ok: false, error: 'bad-profile' }
  const current = await readReviewProfile(projectPath)
  if (current.error === 'read-error') return { ok: false, error: 'profile-unreadable' }
  const next = {
    agent: Object.hasOwn(patch, 'agent') ? normalizeAgent(patch.agent) : current.agent,
    model: Object.hasOwn(patch, 'model') ? normalizeText(patch.model, MAX_MODEL_LEN) : current.model,
    agyProxy: Object.hasOwn(patch, 'agyProxy') ? normalizeProxy(patch.agyProxy) : current.agyProxy,
  }
  if (Object.hasOwn(patch, 'agent') && patch.agent !== '' && next.agent === '') return { ok: false, error: 'bad-agent' }
  if (Object.hasOwn(patch, 'agyProxy') && patch.agyProxy !== '' && next.agyProxy === '') return { ok: false, error: 'bad-proxy' }

  const path = join(projectPath, ...REVIEW_PROFILE_REL.split('/'))
  const dir = join(projectPath, '.dsh', 'plugin-state')
  await mkdir(dir, { recursive: true })
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`
  const text = `${JSON.stringify(next, null, 2)}\n`
  try {
    await writeFile(temp, text, 'utf8')
    await rename(temp, path)
  } catch {
    try {
      await writeFile(path, text, 'utf8')
    } catch {
      await rm(temp, { force: true }).catch(() => {})
      return { ok: false, error: 'write-failed' }
    }
    await rm(temp, { force: true }).catch(() => {})
  }
  return { ok: true, ...next, set: { agent: true, model: true, agyProxy: true } }
}

/**
 * 把项目 profile 合并到插件 settings（Claude/agy、模型、代理）。
 * 用 `set` 区分"显式清空"与"没有这个字段"：空串表示用户要的就是空。
 * index.js（面板投影）与 tools.js（评审执行）必须共用这一份，避免面板显示和实际执行不一致。
 */
export function mergeReviewProfile(settings, profile) {
  const base = isObject(settings) ? settings : {}
  if (!isObject(profile) || profile.error === 'read-error') return base
  const set = isObject(profile.set) ? profile.set : {}
  // 别名统一：配置里 agent/model（旧）与 reviewAgent/reviewModel（新）都认。
  const configuredAgent = base.agent === 'agy' || base.reviewAgent === 'agy' ? 'agy' : 'claude'
  const configuredModel =
    typeof base.model === 'string' && base.model.trim() !== ''
      ? base.model.trim()
      : typeof base.reviewModel === 'string'
        ? base.reviewModel.trim()
        : ''
  const configuredProxy = typeof base.agyProxy === 'string' ? base.agyProxy.trim() : ''
  return {
    ...base,
    agent: set.agent && (profile.agent === 'agy' || profile.agent === 'claude') ? profile.agent : configuredAgent,
    model: set.model ? profile.model : configuredModel,
    agyProxy: set.agyProxy ? profile.agyProxy : configuredProxy,
  }
}
