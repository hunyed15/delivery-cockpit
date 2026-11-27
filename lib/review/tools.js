/**
 * 三个评审工具：claude_review / claude_review_disposition / claude_review_install_hook。
 *
 * 名字、参数、输出 schema 与错误语义都沿用 @hunyed15/project-cockpit v3.0.0：
 * 会话里已有的调用方式不用改，旧插件的面板/hook 也认同一套账本与引擎。
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  BUNDLED_ENGINE,
  BUNDLED_INSTALLER,
  buildCommandLine,
  buildReviewParts,
  firstLine,
  getReviewSubprocess,
  lastJsonLine,
  normalizeReviewResult,
  renderReviewSummary,
  resolveEngine,
  resolvePwsh,
  resolveReviewCwd,
} from './engine.js'
import { appendDispositions, resolveTaskDir } from './ledger.js'
import { mergeReviewProfile, readReviewProfile } from './profile.js'
import { normalizeReviewSettings } from './settings.js'

const REVIEW_MODES = ['incremental', 'full', 'gate', 'range']

const REVIEW_PARAMETERS = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: REVIEW_MODES,
      description:
        'incremental = changes since the previous review snapshot; full = all uncommitted changes vs HEAD ' +
        '(or vs base when provided); range = committed range base..head; gate = local submit-gate check without calling the model.',
    },
    base: {
      type: 'string',
      description: 'Optional git revision to use as diff base (e.g. HEAD~1). Required for range mode.',
    },
    head: {
      type: 'string',
      description: 'Optional git revision to use as range head (default HEAD). Only used by range mode.',
    },
    profile: {
      type: 'string',
      enum: ['quick', 'deep'],
      description: 'quick = low effort + 40k diff cap; deep = high effort + 200k diff cap. Explicit effort/maxDiffChars win.',
    },
    description: {
      type: 'string',
      description: 'What this round implemented. Strongly affects review quality; avoid vague text.',
    },
    checks: {
      type: 'array',
      items: { type: 'string' },
      description: 'Objective checks already run this round, e.g. "cargo test 12/12 passed".',
    },
    paths: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional git pathspecs to narrow the reviewed scope. Ignored by gate mode.',
    },
    focus: {
      type: 'string',
      description: 'Optional extra focus for the reviewer, e.g. "check Rust↔bindings contract drift".',
    },
    taskDir: {
      type: 'string',
      description:
        'Trellis task directory. Required when the session has no current Trellis task; the engine never guesses from history/in_progress.',
    },
    cwd: {
      type: 'string',
      description: 'Repository to review. Defaults to the current session working directory.',
    },
    dryRun: {
      type: 'boolean',
      description: 'Assemble the review input without calling the model. Useful to verify scope.',
    },
  },
  additionalProperties: false,
}

const REVIEW_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      mode: { type: 'string' },
      verdict: { type: 'string' },
      critical: { type: 'integer' },
      important: { type: 'integer' },
      minor: { type: 'integer' },
      summary: { type: 'string' },
      reportPath: { type: 'string' },
      markdownPath: { type: 'string' },
      storage: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      profile: { type: 'string' },
      transport: { type: 'string' },
      roleMode: { type: 'string' },
      transportWarning: { type: 'string' },
      truncated: { type: 'boolean' },
      scopeWarning: { type: 'string' },
      cached: { type: 'boolean' },
      costUsd: { type: 'number' },
      costKnown: { type: 'boolean' },
      exitCode: { type: 'integer' },
      dryRun: { type: 'boolean' },
      escalated: { type: 'string' },
      note: { type: 'string' },
      enginePath: { type: 'string' },
      engineSource: { type: 'string' },
      engineWarning: { type: 'string' },
    },
    required: ['ok', 'mode', 'verdict', 'exitCode'],
  },
  render(_args, value) {
    return [{ type: 'text', text: renderReviewSummary(value) }]
  },
}

const DISPOSITION_PARAMETERS = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          round: { type: 'integer', description: 'The review round the finding came from.' },
          key: { type: 'string', description: 'issues[].key from that round (preferred).' },
          index: { type: 'integer', description: 'issues[] index in that round (fallback when key is unknown).' },
          status: { type: 'string', enum: ['fixed', 'counter-evidence', 'deferred'] },
          note: { type: 'string', description: 'One line: what was changed, or why it is rejected/deferred.' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'Files or checks that prove it.' },
        },
        required: ['round', 'status'],
        additionalProperties: false,
      },
      description: 'Batch form: one row per finding.',
    },
    round: { type: 'integer', description: 'Single-entry form: review round.' },
    key: { type: 'string', description: 'Single-entry form: issues[].key.' },
    index: { type: 'integer', description: 'Single-entry form: issues[] index.' },
    status: { type: 'string', enum: ['fixed', 'counter-evidence', 'deferred'], description: 'Single-entry form.' },
    note: { type: 'string', description: 'Single-entry form.' },
    evidence: { type: 'array', items: { type: 'string' }, description: 'Single-entry form.' },
    taskDir: { type: 'string', description: 'Trellis task directory. Required for Trellis writes; no guessing from history/in_progress.' },
    cwd: { type: 'string', description: 'Project root. Defaults to the session working directory.' },
  },
  additionalProperties: false,
}

const DISPOSITION_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      written: { type: 'integer' },
      taskDir: { type: 'string' },
    },
    required: ['ok', 'written'],
  },
  render(_args, value) {
    return [
      {
        type: 'text',
        text: value?.ok ? `记录 ${value.written} 条处置 → ${value.taskDir}` : '处置记录未写入',
      },
    ]
  },
}

const INSTALL_HOOK_PARAMETERS = {
  type: 'object',
  properties: {
    cwd: { type: 'string', description: 'Git repository. Defaults to the session working directory.' },
    force: { type: 'boolean', description: 'Replace an existing pre-commit hook (backed up first).' },
    enginePath: { type: 'string', description: 'Optional engine path written into the hook; defaults to this plugin engine.' },
    taskDir: { type: 'string', description: 'Optional Trellis task dir baked into the hook as the default CLAUDE_REVIEW_TASKDIR.' },
  },
  additionalProperties: false,
}

const INSTALL_HOOK_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      installed: { type: 'boolean' },
      enginePath: { type: 'string' },
      taskDir: { type: 'string' },
      output: { type: 'string' },
    },
    required: ['ok', 'installed'],
  },
  render(_args, value) {
    return [{ type: 'text', text: value?.ok ? `hook 已安装：${value.enginePath}` : '未安装' }]
  },
}

function spawnAndCollect(subprocess, spec) {
  const handle = subprocess.spawn(spec)
  return Promise.resolve(handle.done).then((outcome) => ({
    outcome,
    stdout: handle.collected?.stdout?.readFrom(0)?.text ?? '',
    stderr: handle.collected?.stderr?.readFrom(0)?.text ?? '',
  }))
}

export function createReviewToolDefinitions(ctx, options = {}) {
  const settings = normalizeReviewSettings(options.settings ?? {})
  // 写授权：显式 cwd/taskDir 是模型可控参数，必须与 cockpit_init 同一口径（未登记工作区一律拒绝）。
  // 会话自身工作目录不经过这里；只有显式传参才需要证明归属。
  const authorizeWrite = typeof options.authorizeWrite === 'function' ? options.authorizeWrite : async (path) => path
  const resolveAuthorizedCwd = async (explicit, exec) => {
    const cwd = resolveReviewCwd(ctx, exec, explicit)
    if (typeof explicit === 'string' && explicit.trim() !== '') return authorizeWrite(cwd)
    return cwd
  }

  const reviewTool = {
    name: 'claude_review',
    description:
      'Run an independent, read-only code review of the current workspace with the local Claude Code CLI. ' +
      'Use it after each implementation round ("incremental"), before composing commits ("full"), for an already ' +
      'committed range ("range"), and for the local submit gate ("gate"). The reviewer cannot modify files; it ' +
      'returns graded findings (critical / important / minor) with file:line evidence, and the tool fails when the gate blocks.',
    parameters: REVIEW_PARAMETERS,
    output: REVIEW_OUTPUT,
    timeoutMs: settings.toolTimeoutMs,
    isConcurrencySafe() {
      return false
    },
    async execute(args, exec) {
      const toolOptions = args ?? {}
      const mode = REVIEW_MODES.includes(toolOptions.mode) ? toolOptions.mode : 'incremental'
      // 先做写授权再碰任何服务/引擎：显式 cwd 未登记时直接 fail-closed。
      const cwd = await resolveAuthorizedCwd(toolOptions.cwd, exec)
      // 项目级覆盖：面板可切 Claude/agy 和模型；读不到就用插件默认值。
      const profile = await readReviewProfile(cwd).catch(() => null)
      const effectiveSettings = mergeReviewProfile(settings, profile)
      // 再确认 subprocess 存在：缺服务时给的是"服务不可用"，不是误导性的"引擎找不到"。
      const subprocess = getReviewSubprocess(ctx)
      const engineInfo = await resolveEngine(cwd, settings)
      const engine = engineInfo.path
      const pwsh = await resolvePwsh(subprocess, 'claude_review')

      const parts = buildReviewParts({
        mode,
        cwd,
        settings: effectiveSettings,
        options: toolOptions,
        sessionId: typeof exec?.agent?.id === 'string' ? exec.agent.id : '',
      })
      const argv = [pwsh, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', buildCommandLine(engine, parts)]

      const { outcome, stdout, stderr } = await spawnAndCollect(subprocess, {
        argv,
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 4 * 1024 * 1024 },
          stderr: { maxBytes: 256 * 1024 },
        },
        graceMs: 5000,
        signal: exec?.signal,
      })
      const exitCode = typeof outcome?.exitCode === 'number' ? outcome.exitCode : -1
      if (stdout.includes('\uFFFD') || stderr.includes('\uFFFD')) {
        // 静默的编码损坏比失败更糟：宁可大声失败，也不要把乱码当成审核结论。
        throw new Error(
          'claude_review: 引擎输出编码异常（含替换字符 U+FFFD）。请确认 pwsh 控制台按 UTF-8 输出，或升级本插件。',
        )
      }
      const envelope = lastJsonLine(stdout)
      const enginePrefix = engineInfo.warning ? `${engineInfo.warning} ` : ''

      if (exitCode === 2) {
        const detail = envelope?.error || firstLine(stderr) || 'unknown failure'
        throw new Error(`claude_review: ${enginePrefix}审核未完成（exit 2）：${detail}`)
      }
      if (envelope === undefined && exitCode !== 0) {
        // 旧引擎的参数绑定错误会走这里：必须把 stderr 首行透出来，不能伪装成“模型输出坏了”。
        throw new Error(
          `claude_review: ${enginePrefix}引擎执行失败（exit ${exitCode}）：${firstLine(stderr) || firstLine(stdout) || '无输出'}`,
        )
      }
      if (exitCode !== 0 && exitCode !== 1) {
        throw new Error(`claude_review: ${enginePrefix}引擎异常退出（exit ${exitCode}）：${firstLine(stderr)}`)
      }
      if (envelope === undefined) {
        throw new Error(
          `claude_review: ${enginePrefix}引擎输出不可解析。stdout=${stdout.trim().slice(0, 400)} stderr=${stderr.trim().slice(0, 400)}`,
        )
      }

      const result = normalizeReviewResult(envelope, exitCode)
      result.enginePath = engineInfo.path
      result.engineSource = engineInfo.source
      result.engineWarning = engineInfo.warning
      if (engineInfo.warning) {
        result.note = result.note ? `${result.note} ${engineInfo.warning}` : engineInfo.warning
      }
      if (exitCode === 1) {
        // fix/reject 需要修；gate-blocked 的「同一模式」是 gate，重跑 gate 会再次阻断。
        if (result.verdict === 'gate-blocked') {
          const gateNote = '门禁阻断：按 reasons 处理后重跑 full（截断/自定义 Base/快照降级）；不要直接重跑 gate'
          result.note = result.note ? `${gateNote}。${result.note}` : gateNote
        } else {
          const fixNote = '必须先修，再重跑同一模式'
          result.note = result.note ? `${result.note}（${fixNote}）` : fixNote
        }
      }
      return result
    },
  }

  // 处置记录（方案 A）：主会话修完一轮后写一条，面板据此显示「已修 / 已反证 / 暂缓」。
  const dispositionTool = {
    name: 'claude_review_disposition',
    description:
      'Record how the main session handled review findings, so the 协同 panel can show "problem → resolution" per finding. ' +
      'Call it after fixing (or consciously deferring) issues from a review round. status: fixed | counter-evidence | deferred.',
    parameters: DISPOSITION_PARAMETERS,
    output: DISPOSITION_OUTPUT,
    timeoutMs: 30_000,
    async execute(args, exec) {
      const toolOptions = args ?? {}
      const cwd = await resolveAuthorizedCwd(toolOptions.cwd, exec)
      const batch = Array.isArray(toolOptions.entries) && toolOptions.entries.length > 0 ? toolOptions.entries : []
      const single =
        toolOptions.round !== undefined || toolOptions.key !== undefined || toolOptions.index !== undefined
          ? [
              {
                round: toolOptions.round,
                key: toolOptions.key,
                index: toolOptions.index,
                status: toolOptions.status,
                note: toolOptions.note,
                evidence: toolOptions.evidence,
              },
            ]
          : []
      const entries = batch.length > 0 ? batch : single
      if (entries.length === 0) throw new Error('claude_review_disposition: 需要 entries 数组或单条 round/key/status')
      let taskDir = await resolveTaskDir(cwd, toolOptions.taskDir, { storage: settings.storage })
      if (typeof toolOptions.taskDir === 'string' && toolOptions.taskDir.trim() !== '') {
        taskDir = await authorizeWrite(taskDir)
      }
      const written = await appendDispositions(taskDir, entries, String(exec?.agent?.id ?? ''))
      return { ok: true, written, taskDir }
    },
  }

  // A+：一键安装提交门禁 hook（显式调用，不在插件加载时自动写 .git/hooks）。
  const installHookTool = {
    name: 'claude_review_install_hook',
    description:
      'Install the claude-code-review pre-commit gate hook into a git repository. The hook runs -Mode gate (no model) ' +
      'and blocks commits unless the latest full/range review passed on the current snapshot. One-click install; never auto-installs.',
    parameters: INSTALL_HOOK_PARAMETERS,
    output: INSTALL_HOOK_OUTPUT,
    timeoutMs: settings.toolTimeoutMs,
    isConcurrencySafe() {
      return false
    },
    async execute(args, exec) {
      const toolOptions = args ?? {}
      const cwd = await resolveAuthorizedCwd(toolOptions.cwd, exec)
      const installer = BUNDLED_INSTALLER
      if (!existsSync(installer)) throw new Error(`claude_review_install_hook: 安装器不存在：${installer}`)
      let engine =
        typeof toolOptions.enginePath === 'string' && toolOptions.enginePath.trim() !== ''
          ? resolve(cwd, toolOptions.enginePath)
          : BUNDLED_ENGINE
      if (typeof toolOptions.enginePath === 'string' && toolOptions.enginePath.trim() !== '') {
        engine = await authorizeWrite(engine)
      }
      let taskDir =
        typeof toolOptions.taskDir === 'string' && toolOptions.taskDir.trim() !== '' ? resolve(cwd, toolOptions.taskDir) : ''
      if (taskDir !== '') taskDir = await authorizeWrite(taskDir)
      const subprocess = getReviewSubprocess(ctx)
      const pwsh = await resolvePwsh(subprocess, 'claude_review_install_hook')
      // 安装器是 .ps1，用 -File 调用（不是 -Command）：路径里有空格/引号也不会被二次解释。
      const argv = [pwsh, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer, '-Cwd', cwd, '-EnginePath', engine]
      if (taskDir !== '') argv.push('-TaskDir', taskDir)
      if (toolOptions.force === true) argv.push('-Force')
      const { outcome, stdout, stderr } = await spawnAndCollect(subprocess, {
        argv,
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 1024 * 1024 },
          stderr: { maxBytes: 256 * 1024 },
        },
        graceMs: 5000,
        signal: exec?.signal,
      })
      const exitCode = typeof outcome?.exitCode === 'number' ? outcome.exitCode : -1
      if (exitCode !== 0) {
        throw new Error(
          `claude_review_install_hook: 安装失败（exit ${exitCode}）：${firstLine(stderr) || firstLine(stdout) || '无输出'}`,
        )
      }
      return { ok: true, installed: true, enginePath: engine, taskDir, output: stdout.trim() }
    },
  }

  return [reviewTool, dispositionTool, installHookTool]
}
