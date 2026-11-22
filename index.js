/**
 * Host 半：驾驶舱的写入口（两个强类型工具）+ 读入口（只读面板路由）。
 *
 * 三条硬约束（写在这里防以后忘）：
 * 1. 每个工具必须声明 `output: { schema, render }`。漏了不是"少个字段"，是整个插件激活失败。
 * 2. 插件自己只写 `.dsh/plugin-state/`（外加 init 建 `.trellis/` 空目录）；项目别的文件一律不碰。
 * 3. 读不到就说读不到：所有降级都由 lib/evidence.js 聚合，这里不补默认值。
 */
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { addAcceptanceEvidence, draftAcceptance, readAcceptanceFile, setAcceptanceResult } from './lib/acceptance.js'
import { approvePrototype } from './lib/approvals.js'
import { checkStageCapability } from './lib/capabilities.js'
import { readEvidence } from './lib/evidence.js'
import { buildFeatureBoard, extractFeatures, readPrdText } from './lib/features.js'
import { applyInit, planInit } from './lib/init.js'
import { buildDetailModel, buildOverviewRow } from './lib/model.js'
import { entryForStage, loadPlaybook, resolveCapabilities, STAGE_DEFS } from './lib/playbook.js'
import { readProjectCard } from './lib/project-card.js'
import { appendReceipt, STAGES } from './lib/receipts.js'
import { createAcceptanceResultHandler, createAcceptanceScreenshotHandler, createApproveHandler, createInitHandler, createRoutes } from './lib/route.js'
import { captureScreenshot, writeScreenshot } from './lib/screenshot.js'
import { compareScreenshots, pickBaselineEvidence, renderDiffPng } from './lib/visual-diff.js'

export const name = 'delivery-cockpit'

// 只有 tools 是硬依赖：面板路由、技能探测、MCP 探测在非 Web / 精简 profile 里都可能不存在，
// 声明成硬依赖会让插件在那些 profile 里直接不激活，连 cockpit_report 都丢。
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATES = join(HERE, 'templates')
const ROUTE_PREFIX = '/delivery-cockpit/api'

const DEFAULT_CONFIG = {
  panelRetryAttempts: 10,
  panelRetryMs: 500,
  panelWatchdogMs: 15_000,
  reviewStorage: 'auto',
  // 截图（面板「截图」按钮）：本机浏览器 + CDP；不填 browserPath 时自动探测 Chrome/Edge。
  browserPath: '',
  screenshotWidth: 1280,
  screenshotHeight: 900,
  screenshotTimeoutMs: 30_000,
  // 视觉回归：单通道差 ≤ tolerance 算同一像素；变化占比 ≤ maxRatio 视为"一致"。
  screenshotDiffTolerance: 8,
  screenshotDiffMaxRatio: 0.001,
  screenshotDiffMinChangedPixels: 24,
  // 截图发生视觉变化时，之前判过的"通过"自动失效（阶段门要求重新确认）。
  invalidateOnVisualChange: true,
  // 失效时往执行回执账本追加一条（可追溯是哪次截图让哪条验收失效）。
  receiptOnInvalidate: true,
}

// 与账本常量共用一份枚举：9 阶段迁移后不再手写第二份，避免工具 schema 与 lib 漂移。
const REPORT_STAGES = STAGES
const REPORT_STATUSES = ['in_progress', 'completed', 'blocked', 'failed', 'dropped']

const COCKPIT_REPORT = {
  name: 'cockpit_report',
  description:
    'Agent 向 Project Cockpit 上报当前阶段推进状态与回执。每完成（或卡住）一步就写一条：' +
    'summary_for_human 是一两句人话，写不出来说明这一步不算做完。回执只追加，不改历史。',
  parameters: {
    type: 'object',
    required: ['iteration_id', 'stage', 'status', 'summary_for_human'],
    properties: {
      iteration_id: { type: 'string', description: '迭代版本号；冷启动阶段固定传 "bootstrap"' },
      stage: { type: 'string', enum: REPORT_STAGES, description: 'canonical 9 阶段 id（旧 id 只在读取历史账本时归一，工具入口不接受）' },
      status: { type: 'string', enum: REPORT_STATUSES },
      summary_for_human: { type: 'string', description: '一两句人话：做完了什么 / 卡在哪' },
      used_skill_or_mcp: { type: 'string' },
      artifacts: { type: 'array', items: { type: 'string' } },
      task_ref: { type: 'string', description: '改代码时必填' },
      write_scope: { type: 'array', items: { type: 'string' }, description: '改代码时必填' },
      feature_ids: {
        type: 'array',
        items: { type: 'string' },
        description: '这条回执对应 PRD 里的功能编号（如 FR-3），用于把回执挂到「功能账」上；可省略',
      },
      event: {
        type: 'string',
        enum: ['acceptance-recheck'],
        description:
          '验收复核留痕：你亲自复核了某条验收就传 acceptance-recheck。此时 stage 必须是 acceptance、status 必须是 completed；' +
          'summary_for_human 写清复核了哪条（如 A1「能添加客户」）和结论（仍通过 / 发现的问题 / 已失效原因）。' +
          '这类回执只进流水账，**不改验收结果、不参与进度投影**——改结果仍要人在面板点。',
      },
      needs_human_decision: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          recommended: { type: 'string' },
        },
      },
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        receiptId: { type: 'string' },
        at: { type: 'string' },
        // 可选能力阶段用了回退方法时带出来：不阻断写入，只提醒这一阶段不是首选方法。
        capabilityWarning: { type: 'string' },
      },
      required: ['ok', 'receiptId'],
    },
    render(args, value) {
      const summary = typeof args?.summary_for_human === 'string' ? args.summary_for_human.trim() : ''
      const id = typeof value?.receiptId === 'string' ? value.receiptId : ''
      return [{ type: 'text', text: id ? `${summary}（回执 ${id}）` : summary || '已记录回执' }]
    },
  },
}

const COCKPIT_INIT = {
  name: 'cockpit_init',
  description:
    '初始化项目驾驶舱状态：创建 .trellis/ 与 .dsh/plugin-state/，释放 RULES.md / project.json / playbook.json / acceptance.json。' +
    '幂等，已存在的文件不覆盖；dryRun 默认 true，只预览将写什么而不落盘。不修改 .gitignore，只给一行可复制提示。',
  parameters: {
    type: 'object',
    properties: {
      cwd: { type: 'string', description: '项目根目录，默认当前会话工作目录' },
      dryRun: { type: 'boolean', description: '默认 true；显式传 false 才真的写盘' },
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        dryRun: { type: 'boolean' },
        applied: { type: 'boolean' },
        projectPath: { type: 'string' },
        created: { type: 'array', items: { type: 'string' } },
        skipped: { type: 'array', items: { type: 'string' } },
        errors: { type: 'array', items: { type: 'string' } },
        gitignoreHint: { type: 'string' },
      },
      required: ['ok', 'dryRun', 'projectPath'],
    },
    render(_args, value) {
      const verb = value?.dryRun ? '将创建' : value?.applied ? '已创建' : '已存在'
      const names = Array.isArray(value?.created) && value.created.length > 0 ? value.created.join('、') : '无'
      return [{ type: 'text', text: `${verb}：${names}${value?.dryRun ? '（dry-run，未写盘）' : ''}` }]
    },
  },
}

/**
 * 工具定义与 ctx 绑定：形状常量保持纯数据（契约测试直接断言 schema/render），
 * execute 在工厂里闭包 ctx，避免模块级执行体引用一个不存在的 ctx。
 *
 * options.authorizeWrite：显式路径的写授权（与 HTTP 层共用同一口径）。默认原样放行，
 * 仅供契约测试使用；真正注册时由 apply 注入"必须是 DSH 已登记工作区"的实现。
 */
const COCKPIT_ACCEPTANCE = {
  name: 'cockpit_acceptance',
  description:
    '按 PRD 功能起草验收条目，写入 .dsh/plugin-state/acceptance.json。只追加：已有条目的 result/evidence 绝不覆盖，' +
    '那是人的判断与证据。feature_ref 指向 PRD 的 FR 编号（如 FR-3），面板据此把验收结果挂到功能上；' +
    'result 由人在验效果阶段填写，pass 必须附证据。',
  parameters: {
    type: 'object',
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['title'],
          properties: {
            feature_ref: { type: 'string', description: 'PRD 功能编号，如 FR-3；建议每条都填，否则验收结果挂不回功能' },
            title: { type: 'string', description: '人话验收点，例如「能添加客户」' },
            steps: { type: 'string', description: '人话操作步骤' },
            expect: { type: 'string', description: '期望结果' },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        added: { type: 'number' },
        skipped: { type: 'number' },
        total: { type: 'number' },
        iterationId: { type: 'string' },
      },
      required: ['ok', 'total'],
    },
    render(_args, value) {
      if (!value?.ok) return [{ type: 'text', text: '验收表起草失败' }]
      return [
        {
          type: 'text',
          text: `验收表已起草：新增 ${value.added} 条、跳过 ${value.skipped} 条（共 ${value.total} 条，迭代 ${value.iterationId}）`,
        },
      ]
    },
  },
}

export function createToolDefinitions(ctx, options = {}) {
  const authorizeWrite = typeof options.authorizeWrite === 'function' ? options.authorizeWrite : async (path) => path
  return [
    {
      ...COCKPIT_REPORT,
      async execute(args, exec) {
        // 回执没有 cwd 参数：目标永远是会话自己的工作目录，模型无法凭空指定别的目录。
        const projectPath = requireCwd(agentCwd(ctx, exec), 'cockpit_report')
        // 写入前置校验：本阶段的 method 必须体现在 used_skill_or_mcp 里，否则"声称完成"没有证据。
        // 校验在 appendReceipt 之前 —— 被拒绝的回执一个字节都不许落盘。
        const loaded = await loadPlaybook(projectPath, await readBuiltinPlaybook())
        const check = checkStageCapability(loaded.playbook, args?.stage, args?.used_skill_or_mcp)
        // 错误码放进文案：调用方/日志要能程序化认出"能力校验失败"，人话说明紧随其后。
        if (check.ok !== true) throw new Error(`cockpit_report: ${check.message}（${check.error}）`)
        const result = await appendReceipt(projectPath, args)
        // 写失败必须让调用方看见：静默丢数据比报错更糟（面板会显示"没发生过"）。
        if (!result.ok) throw new Error(`cockpit_report: ${result.error}`)
        return {
          ok: true,
          receiptId: result.receipt.id,
          at: result.receipt.at,
          ...(typeof check.warning === 'string' && check.warning !== '' ? { capabilityWarning: check.warning } : {}),
        }
      },
    },
    {
      ...COCKPIT_INIT,
      async execute(args, exec) {
        const options = args ?? {}
        const explicit = typeof options.cwd === 'string' && options.cwd.trim() !== '' ? options.cwd : null
        const base = requireCwd(agentCwd(ctx, exec, explicit ?? undefined), 'cockpit_init')
        // 显式 cwd 是模型可控参数：必须过写授权，否则提示注入能把状态写去任意目录。
        const projectPath = explicit === null ? base : await authorizeWrite(base)
        const plan = await planInit(projectPath, { templatesDir: TEMPLATES })
        const fatal = (plan.errors ?? []).filter((item) => !String(item).includes('模板'))
        if (fatal.length > 0 && (plan.files ?? []).length === 0) {
          throw new Error(`cockpit_init: ${fatal.join('；')}`)
        }
        const dryRun = options.dryRun !== false
        if (dryRun) {
          return {
            ok: true,
            dryRun: true,
            applied: false,
            projectPath,
            created: (plan.files ?? []).filter((file) => file.status === 'create').map((file) => file.name),
            skipped: (plan.files ?? []).filter((file) => file.status === 'exists').map((file) => file.name),
            errors: plan.errors ?? [],
            gitignoreHint: plan.gitignoreHint ?? '',
          }
        }
        const applied = await applyInit(projectPath, plan)
        return {
          ok: (applied.errors ?? []).length === 0,
          dryRun: false,
          applied: applied.applied === true,
          projectPath,
          created: applied.created ?? [],
          skipped: applied.skipped ?? [],
          errors: applied.errors ?? [],
          gitignoreHint: applied.gitignoreHint ?? '',
        }
      },
    },
    {
      ...COCKPIT_ACCEPTANCE,
      async execute(args, exec) {
        // 验收表只写在会话自己的工作目录里（没有 cwd 参数，不存在"模型指定别处"的注入面）。
        const projectPath = requireCwd(agentCwd(ctx, exec), 'cockpit_acceptance')
        const result = await draftAcceptance(projectPath, args?.items)
        if (!result.ok) {
          const [code, ...rest] = String(result.error ?? '').split('：')
          const mapped =
            code === 'iteration-required'
              ? '还没有迭代：先写一条 iteration_id 为 v1.0 的回执（bootstrap 冷启动阶段不建验收表）'
              : code === 'acceptance-broken'
                ? 'acceptance.json 不是合法 JSON：插件不会覆盖坏文件，请先手工修好或删除它'
                : code === 'iteration-mismatch'
                  ? `验收表属于迭代 ${result.iterationId}，与当前迭代不一致：先归档或确认后再起草`
                  : String(result.error ?? '起草失败')
          throw new Error(`cockpit_acceptance: ${mapped}${rest.length > 0 ? `：${rest.join('：')}` : ''}`)
        }
        return {
          ok: true,
          added: result.added,
          skipped: result.skipped,
          total: result.total,
          iterationId: result.iterationId,
        }
      },
    },
  ]
}

// 供 test/tool-contract.test.js 断言形状；execute 不在这里调用，ctx 传 undefined 是安全的。
export const TOOL_DEFINITIONS = createToolDefinitions(undefined)

function attempt(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}

const isNonEmpty = (value) => typeof value === 'string' && value.trim() !== ''

function requireCwd(path, toolName) {
  // 不再回退 process.cwd()：把回执写到 DSH 进程启动目录，会让整块状态落到一个没人看的项目里。
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error(`${toolName}: 无法确定项目目录（会话没有工作目录，也没有显式 cwd）；请先确认工作目录`)
  }
  return path
}

function agentCwd(ctx, exec, explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return resolve(explicit)
  const wd = attempt(() => ctx.get('workingDirectory'))
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
  return null
}

// 内置 playbook 很小，读一次缓存住；读失败按空文本交给 loadPlaybook，它会如实降级。
let builtinPlaybookPromise
function readBuiltinPlaybook() {
  if (!builtinPlaybookPromise) {
    builtinPlaybookPromise = readFile(join(TEMPLATES, 'playbook.json'), 'utf8').catch(() => '')
  }
  return builtinPlaybookPromise
}

/**
 * 能力存在性：读不到返回 null（= 未知），绝不返回空集合。
 * 空集合会让界面说"没装这个技能"，而"读不到"和"没装"是两件不同的事。
 */
/**
 * 技能目录的磁盘扫描：`~/.dsh/skills`、`~/.agents/skills`、项目的 `.dsh/skills` / `.agents/skills`。
 *
 * 为什么要扫描磁盘：Host 的 skills 服务在 root context 下只能看到 global 层（实测这里只有 5 个），
 * 而用户装在 `~/.dsh/skills` 的技能（ponytail / TDD / verification-before-completion …）属于
 * agent 作用域，插件从面板侧看不到。只信服务会把"装着的能力"报成"缺失"，进而把下一步指令错误禁用。
 * 扫描是只读的，名字取目录名 + SKILL.md 里声明的 name（两者都收，宁可多认不可误报缺失）。
 */
export async function readDiskSkillNames(cwd, options = {}) {
  // DSH 的 home 不一定等于操作系统 home（本机就是 D:\Users\Admin\.dsh）：
  // 优先用 DSH_HOME，其次 OS home 下的 .dsh。
  const dshHome = isNonEmpty(options.dshHome)
    ? options.dshHome
    : isNonEmpty(process.env.DSH_HOME)
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh')
  const userHome = dirname(dshHome)
  // 去重：未设 DSH_HOME 时 userHome 就是 OS home，两个 .agents 路径会指向同一目录。
  const roots = [
    ...new Set([
      join(dshHome, 'skills'),
      join(homedir(), '.agents', 'skills'),
      join(userHome, '.agents', 'skills'),
      ...(isNonEmpty(cwd) ? [join(cwd, '.dsh', 'skills'), join(cwd, '.agents', 'skills')] : []),
    ]),
  ]
  const names = new Set()
  let readable = 0
  for (const root of roots) {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    readable += 1
    for (const entry of entries) {
      // 用户技能目录里的条目常常是指向别处的符号链接（DSH 自己就是这样挂的）：
      // Dirent 对符号链接 isDirectory() 为 false，必须跟随一次才知道它是不是目录。
      let isDirectory = entry.isDirectory()
      if (!isDirectory && entry.isSymbolicLink()) {
        try {
          isDirectory = (await stat(join(root, entry.name))).isDirectory()
        } catch {
          isDirectory = false
        }
      }
      if (!isDirectory) continue
      names.add(entry.name)
      // SKILL.md 里声明的 name 可能与目录名不同：两个都收，避免因改名而漏认。
      try {
        const text = await readFile(join(root, entry.name, 'SKILL.md'), 'utf8')
        const declared = text.match(/^---[\s\S]*?^name:\s*["']?([^"'\r\n]+)["']?\s*$/m)
        if (declared && declared[1].trim() !== '') names.add(declared[1].trim())
      } catch {
        // 没有 SKILL.md 或读不到：目录名已经记下了，不影响
      }
    }
  }
  return { names, readable }
}

async function readSkillNames(ctx, cwd) {
  const skills = attempt(() => ctx.get('skills'))
  let serviceNames = null
  if (skills && typeof skills.list === 'function') {
    try {
      const list = await skills.list({ cwd })
      serviceNames = new Set((Array.isArray(list) ? list : []).map((item) => String(item?.name ?? '')).filter(Boolean))
    } catch {
      serviceNames = null
    }
  }
  const disk = await readDiskSkillNames(cwd).catch(() => ({ names: new Set(), readable: 0 }))
  // 两边都读不到才算"无法检测"；只要有一边读得到，就以并集为准（避免把装着的技能报成缺失）。
  if (serviceNames === null && disk.readable === 0) return null
  return new Set([...(serviceNames ?? []), ...disk.names])
}

function readToolNames(ctx) {
  const tools = attempt(() => ctx.get('tools'))
  if (!tools || typeof tools.definitions !== 'function') return null
  try {
    return new Set(tools.definitions().map((definition) => String(definition?.name ?? '')).filter(Boolean))
  } catch {
    return null
  }
}

function readMcpNames(ctx) {
  const mcp = attempt(() => ctx.get('mcpManager'))
  if (!mcp || typeof mcp.list !== 'function') return null
  try {
    // present = "装了这个 MCP"（配置里存在），不把"当前连接状态"混进存在性：
    // 一个正在重连的 MCP 仍然是装着的，界面该显示它、由状态字段说明可用性。
    return new Set(mcp.list().map((server) => String(server?.name ?? '')).filter(Boolean))
  } catch {
    return null
  }
}

const samePath = (left, right) => {
  try {
    const a = resolve(String(left))
    const b = resolve(String(right))
    // Windows 路径大小写不敏感：直接比较会把同一目录判成两个。
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  } catch {
    return false
  }
}

const toWorkspace = (item) => ({
  id: String(item?.id ?? item?.path ?? ''),
  title: String(item?.title ?? item?.path ?? ''),
  path: String(item?.path ?? ''),
})

const isInsidePath = (child, parent) => {
  try {
    const rel = relative(resolve(parent), resolve(child))
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  } catch {
    return false
  }
}

/**
 * 显式路径的写授权（fail-closed）。
 *
 * 为什么必须有：工具参数是模型可控的，没有这道校验时一句提示注入就能把
 * `.dsh/plugin-state/` 与一个 `.trellis/` 建到任意目录。会话自身的工作目录不经过这里
 * （它不是模型参数）；只有显式传进来的 cwd 才需要证明"它属于某个已登记项目"。
 *
 * 为什么 fail-closed：空登记、读不到、服务不可用都不是"已确认合法"，而是"无法确认"。
 * 写操作在无法确认归属时必须拒绝。
 *
 * 与 HTTP 层（route.js 的 authorize）的差别：写层额外允许"工作区里的子目录"（会话可能
 * 就在子目录里工作），读层只认精确登记路径。两道闸门都只放行已登记工作区范围内的路径。
 */
export function createAuthorizeWrite({ resolveWorkspace, listWorkspaces }) {
  return async function authorizeWrite(projectPath) {
    const resolved = resolve(projectPath)
    const deny = (reason) => {
      throw new Error(`拒绝写盘：${resolved} 不在任何 DSH 已登记工作区内（${reason}）`)
    }

    let workspace = null
    try {
      workspace = await resolveWorkspace(resolved)
    } catch {
      workspace = null
    }
    if (workspace && typeof workspace.path === 'string' && workspace.path !== '') {
      // resolveByPath 说"认这个路径"还不够：必须确认解析结果真的落在它返回的工作区里，
      // 否则两分支的归属判定就不同语义，一个奇怪的解析实现就成了旁路。
      if (samePath(workspace.path, resolved) || isInsidePath(resolved, workspace.path)) return resolved
    }

    let list = null
    try {
      list = await listWorkspaces()
    } catch {
      list = null
    }
    if (!Array.isArray(list)) deny('无法读取已登记工作区列表')
    const roots = list.map((item) => String(item?.path ?? '')).filter((path) => path !== '')
    if (roots.length === 0) deny('还没有任何已登记工作区')
    if (!roots.some((root) => samePath(root, resolved) || isInsidePath(resolved, root))) {
      deny('不在任何已登记工作区内')
    }
    return resolved
  }
}

export function apply(ctx, config = {}) {
  const settings = { ...DEFAULT_CONFIG }
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (config[key] !== undefined) settings[key] = config[key]
  }

  const logWarn = (message) => {
    try {
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(`[delivery-cockpit] ${message}`)
      else console.warn(`[delivery-cockpit] ${message}`)
    } catch {
      // 日志永远不能影响插件
    }
  }

  const service = (serviceName) => {
    // 未解析的服务在 cordis Proxy 上可能抛错而不是返回 undefined，取服务必须包住。
    try {
      return ctx.get(serviceName)
    } catch {
      return undefined
    }
  }

  const listWorkspaces = async () => {
    const registry = service('workspaceRegistry')
    if (!registry || typeof registry.list !== 'function') return []
    const list = await registry.list()
    return (Array.isArray(list) ? list : []).map(toWorkspace).filter((item) => item.path !== '')
  }

  const resolveWorkspace = async (path) => {
    const registry = service('workspaceRegistry')
    if (!registry) return null
    if (typeof registry.resolveByPath === 'function') {
      const hit = await registry.resolveByPath(String(path))
      if (hit) return toWorkspace(hit)
    }
    if (typeof registry.list === 'function') {
      const all = await registry.list()
      const hit = (Array.isArray(all) ? all : []).find((item) => samePath(item?.path, path))
      if (hit) return toWorkspace(hit)
    }
    return null
  }

  /**
   * 显式路径的写授权：与 HTTP 层同一口径 —— 只能写在 DSH 已登记的工作区（或其子目录）里。
   * 实现见模块级 createAuthorizeWrite：fail-closed，无法确认归属就拒绝。
   */
  const authorizeWrite = createAuthorizeWrite({ resolveWorkspace, listWorkspaces })

  const capabilityServices = async (projectPath, playbook) => ({
    skills: await readSkillNames(ctx, projectPath),
    tools: readToolNames(ctx),
    mcp: readMcpNames(ctx),
    missingHints: playbook?.missingHints ?? {},
  })

  const readDetail = async (projectPath) => {
    const evidence = await readEvidence(projectPath, { reviewStorage: settings.reviewStorage })
    const loaded = await loadPlaybook(projectPath, await readBuiltinPlaybook())
    // 覆盖文件坏了也要让人看见：合并进 evidence 的 warnings，由模型统一上报。
    for (const warning of loaded.warnings ?? []) {
      evidence.warnings = Array.isArray(evidence.warnings) ? evidence.warnings : []
      evidence.warnings.push(warning)
    }
    const services = await capabilityServices(projectPath, loaded.playbook)
    const stageCapabilities = {}
    for (const stage of STAGE_DEFS) {
      stageCapabilities[stage.id] = await resolveCapabilities(entryForStage(loaded.playbook, stage.id), services)
    }

    // 功能账：PRD 只认受控结构（### FR-N），认不到就空着并给格式提示，绝不猜。
    const prdText = await readPrdText(projectPath, evidence.prd?.path)
    const extracted = extractFeatures(prdText.text)
    const features = buildFeatureBoard({
      extracted,
      prd: { path: evidence.prd?.path, missing: prdText.missing, error: prdText.error, truncated: prdText.truncated },
      receipts: evidence.receipts?.receipts,
      acceptance: evidence.acceptance,
      review: evidence.review,
      tasks: evidence.tasks,
    })
    for (const warning of features.warnings ?? []) {
      evidence.warnings = Array.isArray(evidence.warnings) ? evidence.warnings : []
      evidence.warnings.push(warning)
    }

    const generatedAt = new Date().toISOString()
    return buildDetailModel({ evidence, playbook: loaded.playbook, stageCapabilities, generatedAt, features })
  }

  const readOverview = async () => {
    const generatedAt = new Date().toISOString()
    const workspaces = await listWorkspaces()
    const projects = await Promise.all(
      workspaces.map(async (workspace) => {
        try {
          const evidence = await readEvidence(workspace.path, { reviewStorage: settings.reviewStorage })
          return buildOverviewRow({ ...workspace, evidence, generatedAt })
        } catch (error) {
          // 一个项目读挂了不能拖垮整张总览：给它一行明说"读不到"的降级行。
          return {
            id: workspace.id,
            title: workspace.title,
            path: workspace.path,
            initialized: false,
            stageId: null,
            stageName: '—',
            nextKind: 'confirm-data',
            nextTitle: '读取失败，先确认数据',
            degraded: true,
            hasDecision: false,
            updatedAt: null,
            error: String(error?.message ?? error),
          }
        }
      }),
    )
    return { projects, generatedAt }
  }

  // ---- 工具 ----
  for (const definition of createToolDefinitions(ctx, { authorizeWrite })) {
    ctx.effect(() => ctx.tools.register(definition))
  }

  // ---- 面板路由（可选能力，失败不影响工具）----
  /**
   * 面板「截图」：用本机浏览器截一张真实页面 → 存进 .dsh/plugin-state/shots/ → 挂到该条验收的证据上。
   * 截图只挂证据，不改 result：截了图不等于验过了。
   */
  const takeAcceptanceScreenshot = async (projectPath, input = {}) => {
    const itemId = typeof input?.item_id === 'string' ? input.item_id.trim() : ''
    if (itemId === '') return { ok: false, error: 'item-required' }

    // 先确认条目存在：不要为了一个不存在的条目白启动一次浏览器。
    const table = await readAcceptanceFile(projectPath)
    if (table.error) return { ok: false, error: 'acceptance-broken', detail: String(table.error?.code ?? table.error) }
    if (table.badJson) return { ok: false, error: 'acceptance-broken' }
    const items = Array.isArray(table.table?.items) ? table.table.items : []
    const targetItem = items.find((item) => String(item?.id ?? '') === itemId) ?? null
    if (targetItem === null) return { ok: false, error: 'item-not-found' }

    let url = typeof input?.url === 'string' && input.url.trim() !== '' ? input.url.trim() : ''
    if (url === '') {
      const card = await readProjectCard(projectPath)
      const configured = card?.card?.commands?.previewUrl
      url = typeof configured === 'string' ? configured.trim() : ''
    }
    if (url === '') return { ok: false, error: 'no-url' }

    const captured = await captureScreenshot({
      url,
      width: settings.screenshotWidth,
      height: settings.screenshotHeight,
      timeoutMs: settings.screenshotTimeoutMs,
      browserPath: settings.browserPath === '' ? undefined : settings.browserPath,
      signal: input?.signal,
    })
    if (!captured.ok) return captured
    // 截图刚好完成时客户端才断开：不再写盘、不挂证据（与文档"断开不产生副作用"一致）。
    if (input?.signal?.aborted === true) return { ok: false, error: 'aborted' }

    const safeId = itemId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32) || 'item'
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')

    // 视觉回归：和该条证据里"上一张图"比像素（本次截图还没挂上去，所以最后一张就是基线）。
    const comparison = await compareWithBaseline(projectPath, targetItem, captured.png)
    let diffFile = null
    if (comparison.verdict === 'changed' && Buffer.isBuffer(comparison.mask)) {
      const diff = renderDiffPng(captured.png, comparison.mask)
      if (diff.ok) {
        diffFile = await writeScreenshot(projectPath, `diff-${safeId}-${stamp}.png`, diff.png)
      }
    }
    const differentSize = comparison.verdict === 'different-size'
    const shotRecord = {
      at: new Date().toISOString(),
      verdict: comparison.verdict,
      baseline: comparison.baseline ?? null,
      diffFile,
      // 尺寸不同时比例没有意义（否则会显示"变化 100%"），只留宽高差异。
      ratio: differentSize ? null : typeof comparison.ratio === 'number' ? comparison.ratio : null,
      changedPixels: !differentSize && Number.isInteger(comparison.changedPixels) ? comparison.changedPixels : null,
      totalPixels: !differentSize && Number.isInteger(comparison.totalPixels) ? comparison.totalPixels : null,
      width: captured.width,
      height: captured.height,
      reason: comparison.reason ?? null,
    }

    const file = await writeScreenshot(projectPath, `${safeId}-${stamp}.png`, captured.png)
    const attached = await addAcceptanceEvidence(projectPath, {
      item_id: itemId,
      evidence: [file],
      shotDiff: shotRecord,
      invalidateOnVisualChange: settings.invalidateOnVisualChange !== false,
      receiptOnInvalidate: settings.receiptOnInvalidate !== false,
    })
    if (!attached.ok) {
      // 挂不上去就别留孤儿文件（比如条目在截图期间被删掉了）。
      await rm(join(projectPath, file), { force: true }).catch(() => {})
      if (diffFile !== null) await rm(join(projectPath, diffFile), { force: true }).catch(() => {})
      return attached
    }
    return {
      ok: true,
      item: attached.item,
      added: attached.added,
      shot: {
        file,
        width: captured.width,
        height: captured.height,
        url: captured.url,
        comparison: attached.shotDiff ?? shotRecord,
        // 之前判过通过、这次截图又变了 ⇒ 该条验收已失效，界面要提示重新确认。
        invalidated: attached.invalidated === true,
        // 失效留痕：回执 id（写失败时给 warning，不阻断截图）。
        receiptId: attached.receiptId ?? null,
        receiptWarning: attached.receiptWarning ?? null,
      },
    }
  }

  /**
   * 找该条验收项上一张截图并与本次对比。
   * 基线来源只认证据列表里的 PNG（截图与 diff 都是 PNG，顺序 = 截图顺序，最后一张就是上一版）；
   * 基线是 URL / 文件没了 / 太大 / 不是 PNG / 解析失败时给 `uncomparable` + 明确 reason。
   */
  const compareWithBaseline = async (projectPath, item, currentPng) => {
    const baseline = pickBaselineEvidence(item?.evidence)
    if (baseline.kind === 'new') return { verdict: 'new', baseline: null }
    // URL 先于 .png 判定：带查询串的 .png URL（?v=2）也算 URL 证据。
    if (baseline.kind === 'url') return { verdict: 'uncomparable', baseline: baseline.entry, reason: 'baseline-url' }
    if (baseline.kind === 'non-png') return { verdict: 'uncomparable', baseline: baseline.entry, reason: 'baseline-not-png' }
    const imageEntry = baseline.entry

    const root = resolve(projectPath)
    const absolute = resolve(root, imageEntry)
    const rel = relative(root, absolute)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return { verdict: 'uncomparable', baseline: imageEntry, reason: 'baseline-outside-project' }
    }
    let info
    try {
      info = await stat(absolute)
    } catch {
      return { verdict: 'uncomparable', baseline: imageEntry, reason: 'baseline-missing' }
    }
    if (!info.isFile()) return { verdict: 'uncomparable', baseline: imageEntry, reason: 'baseline-missing' }
    // 与 /shot 端点同一道体积上限：不把超大文件读进内存。
    if (info.size > 10 * 1024 * 1024) return { verdict: 'uncomparable', baseline: imageEntry, reason: 'baseline-too-large' }

    let baselineBytes
    try {
      baselineBytes = await readFile(absolute)
    } catch {
      return { verdict: 'uncomparable', baseline: imageEntry, reason: 'baseline-missing' }
    }
    const result = compareScreenshots(baselineBytes, currentPng, {
      tolerance: settings.screenshotDiffTolerance,
      maxRatio: settings.screenshotDiffMaxRatio,
      minChangedPixels: settings.screenshotDiffMinChangedPixels,
    })
    if (!result.ok) {
      return {
        verdict: 'uncomparable',
        baseline: imageEntry,
        reason: result.reason?.includes('bad-crc') || result.reason?.includes('unsupported') ? 'baseline-bad-png' : 'baseline-unreadable',
      }
    }
    return { ...result, baseline: imageEntry }
  }

  /** 证据图片读取：只允许项目内的图片文件，且限制体积（避免变成任意文件下载器）。 */
  const readShot = async (projectPath, file) => {
    if (typeof file !== 'string' || file.trim() === '') return { ok: false, error: 'shot-not-found' }
    const root = resolve(projectPath)
    const absolute = resolve(root, file.trim())
    const rel = relative(root, absolute)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return { ok: false, error: 'shot-not-found' }
    }
    const contentType = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
    }[extname(absolute).toLowerCase()]
    if (!contentType) return { ok: false, error: 'not-image' }
    let info
    try {
      info = await stat(absolute)
    } catch {
      return { ok: false, error: 'shot-not-found' }
    }
    if (!info.isFile()) return { ok: false, error: 'shot-not-found' }
    if (info.size > 10 * 1024 * 1024) return { ok: false, error: 'file-too-large' }
    const bytes = await readFile(absolute)
    return { ok: true, bytes, contentType }
  }

  const routes = createRoutes({
    listWorkspaces,
    resolveWorkspace,
    readOverview,
    readDetail,
    readShot,
    planInit: (projectPath) => planInit(projectPath, { templatesDir: TEMPLATES }),
    applyInit: async (projectPath) => applyInit(projectPath, await planInit(projectPath, { templatesDir: TEMPLATES })),
  })
  const writeDeps = {
    listWorkspaces,
    resolveWorkspace,
    readOverview,
    readDetail,
    readShot,
    planInit: (projectPath) => planInit(projectPath, { templatesDir: TEMPLATES }),
    applyInit: async (projectPath) => applyInit(projectPath, await planInit(projectPath, { templatesDir: TEMPLATES })),
    approvePrototype: (projectPath, iterationId) => approvePrototype(projectPath, iterationId),
    setAcceptanceResult: (projectPath, input) => setAcceptanceResult(projectPath, input),
    takeAcceptanceScreenshot: (projectPath, input) => takeAcceptanceScreenshot(projectPath, input),
  }
  const initHandler = createInitHandler(writeDeps)
  const approveHandler = createApproveHandler(writeDeps)
  const acceptanceResultHandler = createAcceptanceResultHandler(writeDeps)
  const acceptanceScreenshotHandler = createAcceptanceScreenshotHandler(writeDeps)

  const retryAttempts = Number.isFinite(settings.panelRetryAttempts) ? Math.max(1, Math.trunc(settings.panelRetryAttempts)) : 10
  const retryMs = Number.isFinite(settings.panelRetryMs) ? Math.max(1, Math.trunc(settings.panelRetryMs)) : 500
  const watchdogMs = Number.isFinite(settings.panelWatchdogMs) ? Math.max(1, Math.trunc(settings.panelWatchdogMs)) : 15_000

  let panelReady = false
  const watchdog = setTimeout(() => {
    if (!panelReady) logWarn(`${watchdogMs}ms 内未注册面板路由（webServer 未就绪），本次不启用面板；cockpit_report 不受影响`)
  }, watchdogMs)
  if (typeof watchdog?.unref === 'function') watchdog.unref()
  ctx.effect(() => () => clearTimeout(watchdog))

  const registerPanel = (scope) => {
    const webServer = attempt(() => scope.webServer ?? scope.get?.('webServer'))
    if (!webServer || typeof webServer.register !== 'function') return false
    scope.effect(() =>
      webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        resource: (request) => routes.handle(request),
      }),
    )
    // 写接口必须用 handler 路由：resource 路由在 DSH 里只放行 GET/HEAD。
    scope.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/init`,
        handler: initHandler,
      }),
    )
    scope.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/approve-prototype`,
        handler: approveHandler,
      }),
    )
    scope.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/acceptance-result`,
        handler: acceptanceResultHandler,
      }),
    )
    scope.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/acceptance-screenshot`,
        handler: acceptanceScreenshotHandler,
      }),
    )
    return true
  }

  const installPanel = (scope, attempt) => {
    try {
      if (registerPanel(scope)) {
        panelReady = true
        if (attempt > 1) logWarn(`面板路由第 ${attempt} 次尝试注册成功（webServer 晚于插件就绪）`)
        return true
      }
    } catch (error) {
      const message = String(error?.message ?? error)
      if (/duplicate|already|collision|exists/i.test(message)) {
        panelReady = true
        logWarn(`面板路由已存在，沿用现有注册：${message}`)
        return true
      }
      logWarn(`面板路由注册异常（第 ${attempt} 次，已忽略）：${message}`)
    }
    if (attempt >= retryAttempts) {
      logWarn(`webServer 在 ${attempt} 次尝试内仍不可用，本次不启用面板（cockpit_report 不受影响）`)
      return false
    }
    const timer = setTimeout(() => installPanel(scope, attempt + 1), retryMs)
    if (typeof timer?.unref === 'function') timer.unref()
    ctx.effect(() => () => clearTimeout(timer))
    return false
  }

  const startPanel = () => {
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['webServer'], (scope) => {
          try {
            installPanel(scope ?? ctx, 1)
          } catch (error) {
            logWarn(`面板路由注册异常（已忽略）：${String(error?.message ?? error)}`)
          }
        })
        return
      } catch (error) {
        logWarn(`ctx.inject 不可用，改用轮询注册面板：${String(error?.message ?? error)}`)
      }
    }
    installPanel(ctx, 1)
  }

  try {
    startPanel()
  } catch (error) {
    logWarn(`面板启动失败（已忽略）：${String(error?.message ?? error)}`)
  }
}
