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

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

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

/**
 * S3 架构契约门：
 * - `docs/architecture.md` 存在，且含三个必要小节（`##`/`###`，关键决策允许 ADR 写法）；
 * - `docs/api.md` 或 `docs/openapi.json` 至少一个存在且非空。
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
  }

  let api = null
  for (const candidate of API_CANDIDATES) {
    const read = await readRelText(projectPath, candidate)
    if (read.ok && isNonEmptyString(read.text)) {
      api = candidate
      break
    }
    if (read.error && read.error.code !== 'ENOENT') readErrors.push(`${candidate}（${describeError(read.error)}）`)
  }
  if (api === null) missing.push(API_MD)

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
  if (isNonEmptyString(entry)) return true
  return isObject(entry) && isNonEmptyString(entry.path)
}

/**
 * S9 部署发布门：`.dsh/plugin-state/release.json`
 * schema：`{version, artifacts, rollback, at}`，`url` 可选；artifacts 元素可为路径字符串或 `{path}`。
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

  return {
    available: true,
    ok: true,
    gate: 'release',
    missing: [],
    detail: {
      version: parsed.version,
      artifacts,
      rollback: parsed.rollback,
      at: parsed.at,
      url: isNonEmptyString(parsed.url) ? parsed.url : null,
    },
  }
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
