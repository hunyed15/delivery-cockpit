/**
 * 可选的线上 DORA 数据：`.dsh/plugin-state/dora.json`。
 *
 * 为什么用文件而不是内置监控客户端：不同项目的 CI/监控平台不一样，插件不绑死某一家；
 * 项目把自己的发布与事故记录按这个 schema 导出，面板/周报就能用真实数据替换代理指标。
 * 读不到/坏 JSON 只是"没接线上数据"，不降级、不报错给用户。
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const DORA_REL = '.dsh/plugin-state/dora.json'
const MAX_BYTES = 1024 * 1024

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const toTime = (value) => {
  if (typeof value !== 'string' || value.trim() === '') return null
  const ms = Date.parse(value.trim())
  return Number.isNaN(ms) ? null : ms
}

function normalizeDeployment(row) {
  if (!isObject(row)) return null
  const at = toTime(row.at)
  if (at === null) return null
  const lead = typeof row.leadTimeHours === 'number' && Number.isFinite(row.leadTimeHours) && row.leadTimeHours >= 0 ? row.leadTimeHours : null
  return {
    at,
    version: typeof row.version === 'string' && row.version.trim() !== '' ? row.version.trim() : null,
    success: row.success !== false,
    leadTimeHours: lead,
  }
}

function normalizeIncident(row) {
  if (!isObject(row)) return null
  const at = toTime(row.at)
  const resolvedAt = toTime(row.resolvedAt ?? row.resolved_at)
  if (at === null || resolvedAt === null || resolvedAt < at) return null
  return { at, resolvedAt }
}

/**
 * @returns {Promise<{available:boolean, deployments:Array, incidents:Array, invalid:number, error:string|null}>}
 */
export async function readDoraData(projectPath) {
  const empty = { available: false, deployments: [], incidents: [], invalid: 0, error: null }
  if (typeof projectPath !== 'string' || projectPath.trim() === '') return empty
  const path = join(projectPath, ...DORA_REL.split('/'))
  let info
  try {
    info = await stat(path)
  } catch (error) {
    return { ...empty, error: error?.code === 'ENOENT' ? null : 'read-error' }
  }
  if (!info.isFile()) return empty
  if (info.size > MAX_BYTES) return { ...empty, error: 'too-large' }

  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { ...empty, error: 'read-error' }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ...empty, error: 'bad-json' }
  }
  if (!isObject(parsed)) return { ...empty, error: 'wrong-shape' }

  const rawDeployments = Array.isArray(parsed.deployments) ? parsed.deployments : []
  const rawIncidents = Array.isArray(parsed.incidents) ? parsed.incidents : []
  const deployments = rawDeployments.map(normalizeDeployment).filter(Boolean)
  const incidents = rawIncidents.map(normalizeIncident).filter(Boolean)
  const invalid = rawDeployments.length + rawIncidents.length - deployments.length - incidents.length
  return { available: true, deployments, incidents, invalid, error: null }
}
