/**
 * 独立评审引擎的定位、命令行拼装与结果归一（从 @hunyed15/project-cockpit v3.0.0 迁入。
 *
 * 为什么不把审核逻辑改写成 JS：同一份引擎要服务三处——会话里的 claude_review 工具、
 * CLI 手动调用、pre-commit 门禁。只留一份 PowerShell 实现，三处结论才不会漂移。
 * 插件这层只做四件事：找引擎 → 拼参数 → spawn → 把 JSON 信封归一成工具结果。
 */
import { access, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 随包发布的引擎：插件被装到哪里，这里就指到哪里（scripts/ 已在 package.json files 里）。
export const BUNDLED_ENGINE = fileURLToPath(new URL('../../scripts/Invoke-ClaudeReview.ps1', import.meta.url))
export const BUNDLED_INSTALLER = fileURLToPath(new URL('../../scripts/install-git-hook.ps1', import.meta.url))

const WORKSPACE_ENGINE = join('tools', 'claude-review', 'Invoke-ClaudeReview.ps1')
const ALT_WORKSPACE_ENGINE = join('.dsh', 'claude-review', 'Invoke-ClaudeReview.ps1')

export const REVIEW_TIMEOUT_MS = 30 * 60 * 1000

// 引擎能力握手：文件头 `# claude-review-api: 3` 是静态标记，避免每次审核多 spawn 一次探测。
// 旧目标仓库（例如 tools/claude-review 里的旧脚本）没有这个标记，插件必须回退自带引擎，
// 否则新插件传 -Storage 会在旧脚本的参数绑定阶段直接失败。
export const ENGINE_API = 3
const ENGINE_API_RE = /#\s*claude-review-api:\s*(\d+)/
const engineApiCache = new Map()

// 子进程没有控制台时，PowerShell 会把中文按系统代码页（cp936）写成字节，宿主再按 UTF-8 解码
// 就变成乱码。这里在执行引擎前强制把控制台输出编码钉成 UTF-8（与引擎自身的 try/catch 一致）。
const PS_ENCODING_PROLOGUE =
  'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
  '$OutputEncoding = [Console]::OutputEncoding } catch { }; '

function attempt(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}

export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

export function buildCommandLine(engine, parts) {
  // 参数名不能加引号：PowerShell 会把 '-Mode' 当成值，绑定失败。只对值加引号。
  return PS_ENCODING_PROLOGUE + '& ' + psQuote(engine) + ' ' + parts.join(' ')
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function readEngineApi(engine) {
  let info
  try {
    info = await stat(engine)
  } catch {
    return 0
  }
  const key = `${engine}|${info.mtimeMs}|${info.size}`
  if (engineApiCache.has(key)) return engineApiCache.get(key)
  let api = 0
  try {
    const text = await readFile(engine, 'utf8')
    const match = text.slice(0, 4096).match(ENGINE_API_RE)
    if (match) api = Number(match[1])
  } catch {
    api = 0
  }
  engineApiCache.set(key, api)
  return api
}

const SOURCE_LABEL = {
  configured: '配置的',
  workspace: '目标仓库',
  'local-engine': '目标仓库 .dsh 的',
  bundled: '插件自带的',
}

/**
 * 引擎路径解析：显式配置 → 目标仓库 tools/claude-review → 目标仓库 .dsh/claude-review → 自带。
 * 探测顺序与旧插件逐字一致；接口版本不够的候选会被跳过并说明原因，而不是带病调用。
 */
export async function resolveEngine(cwd, settings = {}) {
  const configured = typeof settings.enginePath === 'string' ? settings.enginePath.trim() : ''
  const allowBundled = settings.allowBundledFallback !== false
  const candidates = []
  if (configured !== '') {
    candidates.push({ path: isAbsolute(configured) ? configured : resolve(cwd, configured), source: 'configured' })
    if (allowBundled) candidates.push({ path: BUNDLED_ENGINE, source: 'bundled' })
  } else {
    candidates.push({ path: join(cwd, WORKSPACE_ENGINE), source: 'workspace' })
    candidates.push({ path: join(cwd, ALT_WORKSPACE_ENGINE), source: 'local-engine' })
    if (allowBundled) candidates.push({ path: BUNDLED_ENGINE, source: 'bundled' })
  }

  let fallbackReason = ''
  let firstMissing = ''
  for (const candidate of candidates) {
    if (!(await exists(candidate.path))) {
      if (candidate.source === 'configured') {
        throw new Error(`claude_review: 配置的 enginePath 不存在：${candidate.path}`)
      }
      if (firstMissing === '') firstMissing = candidate.path
      continue
    }
    const api = await readEngineApi(candidate.path)
    if (api >= ENGINE_API) {
      const warning = fallbackReason
        ? `${fallbackReason}；已回退到${SOURCE_LABEL[candidate.source] ?? candidate.source}引擎 ${candidate.path}。`
        : ''
      return { path: candidate.path, source: candidate.source, warning }
    }
    const reason =
      `${candidate.path} 的接口版本为 ${api > 0 ? `v${api}` : '未知（没有 claude-review-api 标记）'}，` +
      `当前插件需要 v${ENGINE_API}`
    if (fallbackReason === '') fallbackReason = reason
    if (candidate.source === 'configured' && allowBundled === false) {
      throw new Error(`claude_review: ${reason}；allowBundledFallback=false，无法回退。请升级该引擎或修改 enginePath。`)
    }
  }

  const hint = firstMissing ? `（也找不到 ${firstMissing}）` : ''
  throw new Error(
    `claude_review: 找不到审核引擎${hint}。目标引擎接口过旧或缺失，且自带引擎不可用；` +
      '请升级目标仓库的 Invoke-ClaudeReview.ps1，或在插件配置里设置 enginePath。',
  )
}

/**
 * 取 subprocess 服务：本插件**不**把它声明为硬依赖（精简 profile / 非宿主环境里它可能不存在，
 * 硬依赖会让整个插件不激活、连 cockpit_report 都丢）。执行审核时缺服务则明确报错。
 */
export function getReviewSubprocess(ctx) {
  // 未解析的服务在 cordis Proxy 上可能抛错而不是返回 undefined，取服务必须包住。
  const subprocess = attempt(() => ctx?.get?.('subprocess'))
  const usable =
    subprocess && typeof subprocess.spawn === 'function' && typeof subprocess.resolveExecutable === 'function'
  if (!usable) {
    throw new Error(
      'claude_review: 缺少 subprocess 服务。本插件只把 tools 声明为硬依赖，subprocess 在部分 profile 里不可用；' +
        '请在能启动子进程的 DSH 会话里重试（或改用 CLI 直接调用 scripts/Invoke-ClaudeReview.ps1）。',
    )
  }
  return subprocess
}

export async function resolvePwsh(subprocess, toolName) {
  try {
    const pwsh = await subprocess.resolveExecutable('pwsh')
    if (typeof pwsh === 'string' && pwsh.trim() !== '') return pwsh
  } catch {
    // 落到下面统一报错：区分"服务缺失"和"pwsh 不可用"对使用者更有用。
  }
  throw new Error(`${toolName}: 找不到 pwsh（PowerShell 7+）。请安装 pwsh 后重试。`)
}

/**
 * 会话/显式 cwd 解析：与旧插件一致（显式 cwd → workingDirectory 服务 → session.header.cwd →
 * 宿主进程目录）。审核是只读的，回退到进程目录不会写坏目标仓库；这是旧插件的既有行为。
 */
export function resolveReviewCwd(ctx, exec, explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return resolve(explicit)
  const wd = attempt(() => ctx?.get?.('workingDirectory'))
  if (wd && typeof wd.get === 'function') {
    try {
      const fromSession = wd.get(exec?.agent)
      if (typeof fromSession === 'string' && fromSession !== '') return fromSession
    } catch {
      // 落到下面几个兜底来源
    }
  }
  const fromHeader = exec?.agent?.session?.header?.cwd
  if (typeof fromHeader === 'string' && fromHeader !== '') return fromHeader
  return process.cwd()
}

/**
 * 拼 PowerShell 参数实参串。数组型参数必须拼成 -Checks 'a','b' 这种单个数组实参：
 * PowerShell 不允许同一个命名参数出现多次（"多次指定了参数 'Checks'"）。
 */
export function buildReviewParts({ mode, cwd, settings, options = {}, sessionId = '' }) {
  const parts = [
    '-Mode',
    psQuote(mode),
    '-Storage',
    psQuote(settings.storage),
    '-Cwd',
    psQuote(cwd),
    '-Json',
    '-TimeoutSec',
    String(settings.timeoutSec),
  ]
  if (sessionId !== '') parts.push('-SessionId', psQuote(sessionId))
  const pushValue = (flag, value) => {
    parts.push(flag, psQuote(value))
  }
  const pushList = (flag, values) => {
    const list = (Array.isArray(values) ? values : []).filter((value) => typeof value === 'string' && value.trim() !== '')
    if (list.length === 0) return
    parts.push(flag, list.map(psQuote).join(','))
  }
  if (typeof options.description === 'string' && options.description.trim() !== '') {
    pushValue('-Description', options.description)
  }
  if (typeof options.focus === 'string' && options.focus.trim() !== '') {
    pushValue('-Focus', options.focus)
  }
  if (typeof options.taskDir === 'string' && options.taskDir.trim() !== '') {
    pushValue('-TaskDir', options.taskDir)
  }
  if (typeof options.base === 'string' && options.base.trim() !== '') {
    pushValue('-Base', options.base)
  }
  if (typeof options.head === 'string' && options.head.trim() !== '') {
    pushValue('-Head', options.head)
  }
  if (typeof options.profile === 'string' && options.profile.trim() !== '') {
    pushValue('-Profile', options.profile)
  }
  parts.push('-Transport', psQuote(settings.transport))
  if (typeof process.execPath === 'string' && process.execPath !== '') {
    // 用 DSH Host 自己的运行时，不要求用户 PATH 里有 node。
    parts.push('-NodeExe', psQuote(process.execPath))
  }
  if (process.versions && process.versions.electron) parts.push('-NodeRunAsNode')
  pushList('-Checks', options.checks)
  pushList('-Paths', options.paths)
  if (options.dryRun === true) parts.push('-DryRun')
  return parts
}

/** 引擎的 stdout 可能混着日志行：取最后一个能解析成 JSON 的行。 */
export function lastJsonLine(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('{'))
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index])
    } catch {
      // 继续向上找
    }
  }
  return undefined
}

export function firstLine(text) {
  return (
    String(text ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  )
}

/** 把引擎 JSON 信封归一成工具输出（字段名、ok 语义与旧插件逐字一致）。 */
export function normalizeReviewResult(envelope, exitCode) {
  const base = {
    ok: envelope?.ok !== false,
    mode: String(envelope?.mode ?? ''),
    verdict: String(envelope?.verdict ?? ''),
    critical: Number(envelope?.critical ?? 0),
    important: Number(envelope?.important ?? 0),
    minor: Number(envelope?.minor ?? 0),
    summary: String(envelope?.summary ?? ''),
    reportPath: String(envelope?.report ?? ''),
    markdownPath: String(envelope?.markdown ?? ''),
    storage: String(envelope?.storage ?? ''),
    base: String(envelope?.base ?? ''),
    head: String(envelope?.head ?? ''),
    profile: String(envelope?.profile ?? ''),
    transport: String(envelope?.transport ?? ''),
    roleMode: String(envelope?.roleMode ?? ''),
    transportWarning: String(envelope?.transportWarning ?? ''),
    truncated: envelope?.truncated === true,
    scopeWarning: String(envelope?.scopeWarning ?? ''),
    cached: envelope?.cached === true,
    costUsd: typeof envelope?.cost_usd === 'number' ? envelope.cost_usd : 0,
    costKnown: typeof envelope?.cost_usd === 'number',
    exitCode,
    dryRun: envelope?.dryRun === true,
    escalated: String(envelope?.escalate ?? ''),
    note: String(envelope?.note ?? ''),
  }
  if (base.dryRun) {
    base.verdict = 'dry-run'
    base.note = '只组装了审核输入，未调用模型。'
    return base
  }
  if (envelope?.nothingToReview) {
    base.verdict = 'nothing-to-review'
    base.note = '该范围内没有改动；nothing-to-review 不等于 pass。'
  } else if (envelope?.gate) {
    base.verdict = envelope.gate === 'pass' ? 'gate-pass' : 'gate-blocked'
    base.ok = envelope.gate === 'pass'
    const reasons = Array.isArray(envelope.reasons) ? envelope.reasons.join('；') : String(envelope.reason ?? '')
    base.note = reasons
  } else if (typeof envelope?.error === 'string') {
    base.ok = false
    base.note = envelope.error
  }
  // ok 是调用方判断「可否继续/可否提交」的主信号：结论不通过时必须为 false，
  // 不能只靠 note 的文字提醒（否则门禁在工具层就被绕过了）。
  if (exitCode === 1 || base.verdict === 'fix' || base.verdict === 'reject') base.ok = false
  if (base.transportWarning) {
    base.note = base.note ? `${base.note} ${base.transportWarning}` : base.transportWarning
  }
  return base
}

export function renderReviewSummary(value) {
  const result = value ?? {}
  const verdict = typeof result.verdict === 'string' ? result.verdict : ''
  const lines = []
  if (result.mode === 'gate' || verdict.startsWith('gate-')) {
    lines.push(`gate: ${result.ok === false ? 'blocked' : 'pass'}`)
    if (result.note) lines.push(`reason: ${result.note}`)
  } else {
    lines.push(`verdict: ${verdict || 'unknown'}`)
    lines.push(`issues: critical=${result.critical ?? 0} important=${result.important ?? 0} minor=${result.minor ?? 0}`)
    if (result.summary) lines.push(`summary: ${result.summary}`)
    if (result.note) lines.push(`note: ${result.note}`)
    if (result.reportPath) lines.push(`report: ${result.reportPath}`)
  }
  if (result.truncated) lines.push('truncated: diff 已截断，结论不完整；gate 不会通过')
  if (result.cached) lines.push('cached: 复用与上次完全相同的 diff/输入，未调用模型')
  if (result.scopeWarning) lines.push(`scope: ${result.scopeWarning}`)
  if (result.escalated) lines.push(`escalate: ${result.escalated}`)
  return lines.join('\n')
}
