/**
 * 技术门校验器（P0）：S3 架构契约 / S6 测试验证 / S9 部署发布三道硬门。
 *
 * 为什么单独成模块：门禁只认**文件与 schema**（docs/VISION.md §3 证据门禁），
 * 不认回执里的"完成了"。三个校验器都只读 `.dsh/plugin-state/` 与 docs/，
 * 不写盘、不抛错 —— 面板读取这条路径上任何异常都不许把界面打挂。
 *
 * 统一返回形状：
 *   { available, ok, gate, missing, detail?, reason? }
 * - `available`：门的**主证据文件**存在且能读（内容坏也算 available，便于区分"还没做"和"做了没过"）；
 * - `ok`：门通过；
 * - `missing`：缺什么（文件路径、`文件#小节`、字段名、`failed>0（N 个失败）`）；
 * - `reason`：`'missing' | 'bad-json' | 'wrong-shape' | 'failed'`，通过时为 undefined；
 * - `detail`：给人/给面板看的实际值（命令、版本、artifacts …），不参与通过判定。
 *
 * 文件不存在是"阶段还没做"，不是"读取故障"：这里不产生 warnings，也不进 evidence.degraded。
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

const ARCH_FILE = 'docs/architecture.md'
const API_MD = 'docs/api.md'
const API_JSON = 'docs/openapi.json'
const API_CANDIDATES = [API_MD, API_JSON]
// docs/VISION.md §S3：组件 / 数据模型 / 接口清单 / 关键决策（ADR）。
const REQUIRED_SECTIONS = ['组件', '数据模型', '接口清单', '关键决策']

const TEST_REPORT_REL = '.dsh/plugin-state/test-report.json'
// 非代码项目（纯文档/设计）的回退：人工检查单，schema 与测试报告不同（见 docs/VISION.md §S6 DoD）。
const MANUAL_CHECK_REL = '.dsh/plugin-state/manual-check.json'
const RELEASE_REL = '.dsh/plugin-state/release.json'

const TEST_REPORT_FIELDS = ['command', 'passed', 'failed', 'at']
const MANUAL_CHECK_FIELDS = ['checks', 'at']
const RELEASE_FIELDS = ['version', 'artifacts', 'rollback', 'at']
const SHA256_PATTERN = /^[a-f0-9]{64}$/i

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''
const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0
const describeError = (error) => String(error?.code ?? error?.message ?? error)

async function readRelText(projectPath, rel) {
  if (!isNonEmptyString(projectPath)) return { ok: false, text: null, error: null }
  try {
    return { ok: true, text: await readFile(join(projectPath.trim(), ...rel.split('/')), 'utf8'), error: null }
  } catch (error) {
    return { ok: false, text: null, error }
  }
}

function missingGate(gate, missing) {
  return { available: false, ok: false, gate, missing, reason: 'missing' }
}

function badJsonGate(gate, missing, detail) {
  return { available: true, ok: false, gate, missing, reason: 'bad-json', ...(detail ? { detail } : {}) }
}

function wrongShapeGate(gate, missing, detail) {
  return { available: true, ok: false, gate, missing, reason: 'wrong-shape', ...(detail ? { detail } : {}) }
}

/** 只认 `##` / `###` 标题行；`####` 及以下不算契约小节（防止正文小标题冒充）。 */
function headingsOf(text) {
  const headings = []
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s{0,3}#{2,3}\s+(.+?)\s*#*\s*$/)
    if (match) headings.push(match[1].trim())
  }
  return headings
}

function hasSection(headings, keyword) {
  const wanted = keyword.toLowerCase()
  return headings.some((heading) => {
    if (heading.toLowerCase().includes(wanted)) return true
    // 「关键决策（ADR）」也常写成 `## ADR`：ADR 字样同样算这一节。
    return keyword === '关键决策' && /adr/i.test(heading)
  })
}

/** 小节必须有真实内容（跳过标题行、空行），否则“有标题没决策”不算 ADR。 */
function sectionHasContent(text, keyword) {
  const lines = String(text).split(/\r?\n/)
  const wanted = keyword.toLowerCase()
  let inSection = false
  let sectionLevel = 0
  for (const line of lines) {
    const heading = line.match(/^\s{0,3}(#{2,3})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      const level = heading[1].length
      const title = heading[2]
      if (!inSection && (title.toLowerCase().includes(wanted) || (keyword === '关键决策' && /adr/i.test(title)))) {
        inSection = true
        sectionLevel = level
        continue
      }
      if (inSection && level <= sectionLevel) return false
      continue
    }
    if (inSection && line.trim() !== '') return true
  }
  return false
}

function markdownHasEndpoint(text) {
  const value = String(text)
  const method = '(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)'
  // 支持内联 `GET /users` 与 Markdown 表格 `| GET | /users |` 两种常见写法。
  return new RegExp(`\\b${method}\\s+/\\S*`, 'i').test(value) || new RegExp(`\\|\\s*${method}\\s*\\|\\s*/\\S*`, 'i').test(value)
}

function openapiHasPaths(text) {
  try {
    const parsed = JSON.parse(text)
    return isObject(parsed) && isObject(parsed.paths) && Object.keys(parsed.paths).length > 0
  } catch {
    return false
  }
}

/**
 * S3 架构契约门：
 * - `docs/architecture.md` 存在，且含三个必要小节（`##`/`###`，关键决策允许 ADR 写法），关键决策必须至少有内容；
 * - `docs/api.md`（至少一条 `METHOD /path`）或 `docs/openapi.json`（`paths` 非空）至少一个；
 * - 对应 VISION §S3 的"接口数 ≥1 / ADR ≥1"。
 */
export async function validateArchitecture(projectPath) {
  const missing = []
  const readErrors = []
  let available = false
  let sections = []

  const arch = await readRelText(projectPath, ARCH_FILE)
  if (!arch.ok || arch.text === null) {
    // ENOENT 之外（ENOTDIR/权限/占用）也是"这份契约读不到"：门不过，但不编造坏 JSON。
    missing.push(ARCH_FILE)
    if (arch.error && arch.error.code !== 'ENOENT') readErrors.push(`${ARCH_FILE}（${describeError(arch.error)}）`)
  } else {
    available = true
    const headings = headingsOf(arch.text)
    sections = REQUIRED_SECTIONS.filter((section) => hasSection(headings, section))
    for (const section of REQUIRED_SECTIONS) {
      if (!sections.includes(section)) missing.push(`${ARCH_FILE}#${section}`)
    }
    if (sections.includes('关键决策') && !sectionHasContent(arch.text, '关键决策')) {
      missing.push(`${ARCH_FILE}#关键决策（无内容）`)
    }
  }

  let api = null
  let apiHasEndpoint = false
  for (const candidate of API_CANDIDATES) {
    const read = await readRelText(projectPath, candidate)
    if (read.ok && isNonEmptyString(read.text)) {
      api = candidate
      apiHasEndpoint = candidate === API_JSON ? openapiHasPaths(read.text) : markdownHasEndpoint(read.text)
      if (apiHasEndpoint) break
    } else if (read.error && read.error.code !== 'ENOENT') {
      readErrors.push(`${candidate}（${describeError(read.error)}）`)
    }
  }
  if (api === null) missing.push(API_MD)
  else if (!apiHasEndpoint) missing.push(`${api}#endpoint`)

  const detail = { sections, api, ...(readErrors.length > 0 ? { readErrors } : {}) }
  if (missing.length > 0) return { available, ok: false, gate: 'architecture', missing, reason: 'missing', detail }
  return { available: true, ok: true, gate: 'architecture', missing: [], detail }
}

/**
 * S6 测试验证门：`.dsh/plugin-state/test-report.json`
 * schema：`{command, passed, failed, at}`（`passed`/`failed` 非负整数，`failed` 必须为 0）。
 */
export async function validateTestReport(projectPath) {
  const read = await readRelText(projectPath, TEST_REPORT_REL)
  if (read.ok && read.text !== null) {
    return parseTestReport(read.text)
  }

  // 测试报告不存在：允许非代码项目用人工检查单替代（VISION §S6 DoD），但 schema 必须合法。
  const manualRead = await readRelText(projectPath, MANUAL_CHECK_REL)
  if (!manualRead.ok || manualRead.text === null) {
    return missingGate('tests', [TEST_REPORT_REL, MANUAL_CHECK_REL])
  }
  return parseManualCheck(manualRead.text)
}

function parseTestReport(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return badJsonGate('tests', [TEST_REPORT_REL])
  }
  if (!isObject(parsed)) return wrongShapeGate('tests', TEST_REPORT_FIELDS, { value: parsed })

  const missing = []
  if (!isNonEmptyString(parsed.command)) missing.push('command')
  if (!isNonNegativeInteger(parsed.passed)) missing.push('passed')
  if (!isNonNegativeInteger(parsed.failed)) missing.push('failed')
  if (!isNonEmptyString(parsed.at)) missing.push('at')
  if (missing.length > 0) return wrongShapeGate('tests', missing)

  const detail = {
    source: TEST_REPORT_REL,
    command: parsed.command,
    passed: parsed.passed,
    failed: parsed.failed,
    skipped: Number.isInteger(parsed.skipped) ? parsed.skipped : null,
    at: parsed.at,
  }
  if (parsed.failed > 0) {
    return { available: true, ok: false, gate: 'tests', missing: [`failed>0（${parsed.failed} 个失败）`], detail }
  }
  return { available: true, ok: true, gate: 'tests', missing: [], detail }
}

function parseManualCheck(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return badJsonGate('tests', [MANUAL_CHECK_REL])
  }
  if (!isObject(parsed)) return wrongShapeGate('tests', MANUAL_CHECK_FIELDS, { value: parsed })

  const missing = []
  if (!Array.isArray(parsed.checks) || parsed.checks.length === 0) missing.push('checks')
  if (!isNonEmptyString(parsed.at)) missing.push('at')
  if (missing.length > 0) return wrongShapeGate('tests', missing)

  const checks = parsed.checks.filter(isObject)
  const failed = checks.filter((item) => item.result === 'fail' || item.result === 'failed').length
  const blocked = checks.filter((item) => item.result === 'blocked').length
  const detail = {
    source: MANUAL_CHECK_REL,
    checks: checks.length,
    failed,
    blocked,
    at: parsed.at,
  }
  if (failed > 0 || blocked > 0) {
    const parts = []
    if (failed > 0) parts.push(`${failed} 个失败`)
    if (blocked > 0) parts.push(`${blocked} 个阻塞`)
    return { available: true, ok: false, gate: 'tests', missing: [`人工检查未通过（${parts.join('、')}）`], detail }
  }
  return { available: true, ok: true, gate: 'tests', missing: [], detail }
}

function isArtifactEntry(entry) {
  return isObject(entry) && isNonEmptyString(entry.path) && isNonEmptyString(entry.sha256) && SHA256_PATTERN.test(entry.sha256.trim())
}

/** 只允许项目内文件：绝对/相对路径解析后必须仍在项目根下（Windows 大小写不敏感）。 */
function resolveInsideProject(projectPath, relative) {
  const base = resolve(projectPath)
  const target = resolve(base, relative)
  const baseWithSep = base.toLowerCase().endsWith(sep) ? base.toLowerCase() : base.toLowerCase() + sep
  return target.toLowerCase() === base.toLowerCase() || target.toLowerCase().startsWith(baseWithSep) ? target : null
}

function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

/**
 * S9 部署发布门：`.dsh/plugin-state/release.json`
 * schema：`{version, artifacts:[{path, sha256}], rollback, at}`，`url` 可选。
 * 必须逐个产物校验：文件存在、在项目内、sha256 匹配（VISION §S9 DoD）。
 */
export async function validateRelease(projectPath) {
  const read = await readRelText(projectPath, RELEASE_REL)
  if (!read.ok || read.text === null) return missingGate('release', [RELEASE_REL])

  let parsed
  let bad = false
  try {
    parsed = JSON.parse(read.text)
  } catch {
    bad = true
  }
  if (bad) return badJsonGate('release', [RELEASE_REL])
  if (!isObject(parsed)) return wrongShapeGate('release', RELEASE_FIELDS, { value: parsed })

  const artifacts = Array.isArray(parsed.artifacts) ? parsed.artifacts : null
  const artifactsValid = artifacts !== null && artifacts.length > 0 && artifacts.every(isArtifactEntry)

  const missing = []
  if (!isNonEmptyString(parsed.version)) missing.push('version')
  if (!artifactsValid) missing.push('artifacts')
  if (!isNonEmptyString(parsed.rollback)) missing.push('rollback')
  if (!isNonEmptyString(parsed.at)) missing.push('at')
  if (missing.length > 0) return wrongShapeGate('release', missing)

  const verified = []
  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = artifacts[index]
    const relative = artifact.path.trim()
    const absolute = resolveInsideProject(projectPath, relative)
    if (absolute === null) {
      missing.push(`artifacts[${index}].path（越界）`)
      continue
    }
    let digest
    try {
      digest = await sha256File(absolute)
    } catch {
      missing.push(`artifacts[${index}]（文件不存在或不可读）`)
      continue
    }
    if (digest.toLowerCase() !== artifact.sha256.trim().toLowerCase()) {
      missing.push(`artifacts[${index}].sha256`)
      continue
    }
    verified.push({ path: relative, sha256: digest })
  }

  const detail = {
    version: parsed.version,
    artifacts: verified,
    rollback: parsed.rollback,
    at: parsed.at,
    url: isNonEmptyString(parsed.url) ? parsed.url : null,
  }
  if (missing.length > 0) {
    return { available: true, ok: false, gate: 'release', missing, reason: 'missing', detail }
  }
  return { available: true, ok: true, gate: 'release', missing: [], detail }
}

/**
 * 读三道技术门的证据。三道门互相独立：任何一门读挂/抛错只影响自己，
 * 统一回 `{ok:false, reason:'missing'|'bad-json'}`，绝不把异常抛给调用方。
 */
export async function readGateEvidence(projectPath) {
  const guard = async (gate, validate, fallbackMissing) => {
    try {
      return await validate(projectPath)
    } catch (error) {
      // 理论上 validate* 自己已兜住所有读盘异常；这里再兜一次，防以后改坏。
      return {
        available: false,
        ok: false,
        gate,
        missing: fallbackMissing,
        reason: 'missing',
        detail: { error: describeError(error) },
      }
    }
  }

  const [architecture, tests, release] = await Promise.all([
    guard('architecture', validateArchitecture, [ARCH_FILE, API_MD]),
    guard('tests', validateTestReport, [TEST_REPORT_REL]),
    guard('release', validateRelease, [RELEASE_REL]),
  ])
  return { architecture, tests, release }
}
