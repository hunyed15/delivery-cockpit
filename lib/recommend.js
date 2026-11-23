/**
 * 缺失能力的「替代 / 安装」建议。
 *
 * 为什么单独成模块：面板要回答的不只是"缺什么"，还有"那我怎么办"。
 * 但建议必须是**可信的**——只对已知能力给已知出路，未知能力一律返回 null，
 * 绝不编一个看起来像真的命令或仓库地址。所以这里只有一张写死的映射表，无 I/O。
 *
 * 口径：
 * - 只对「缺的（present !== 'yes'）或可选的（optional === true）」能力给建议；
 *   已装且必需的能力不需要建议。
 * - 没有安装信息时只给 fallback + note，不硬凑 install。
 * - install 只是**展示**（链接 / 可复制命令），不执行、不自动安装。
 */

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const PLAYWRIGHT_URL = 'https://github.com/microsoft/playwright-mcp'
const CONTEXT7_URL = 'https://github.com/upstash/context7'
const MATTPOCOCK_URL = 'https://github.com/mattpocock/skills'
const TRELLIS_URL = 'https://github.com/mindfold-ai/Trellis'
const ANTHROPIC_SKILLS_URL = 'https://github.com/anthropics/skills'

/**
 * 名字 → 建议。键统一小写（能力名大小写不敏感）。
 * 这里的每条 fallback 都对应 docs/CAPABILITIES.md 里已经实现的回退，不是新承诺。
 */
const ADVICE_RULES = {
  playwright: {
    fallback: '面板内置 CDP 截图（不需要 MCP）',
    install: [{ label: 'Playwright MCP', url: PLAYWRIGHT_URL }],
  },
  context7: {
    fallback: 'web_search / dsh-doc 查文档',
    install: [{ label: 'Context7 MCP', url: CONTEXT7_URL }],
  },
  grilling: {
    fallback: '内置追问模板，产出 docs/brief.md',
    install: [{ label: 'mattpocock/skills（含 grilling）', url: MATTPOCOCK_URL }],
  },
  'grill-me': {
    fallback: '内置追问模板，产出 docs/brief.md',
    install: [{ label: 'mattpocock/skills（含 grilling）', url: MATTPOCOCK_URL }],
  },
  'webapp-testing': {
    fallback: '本机 Chrome + CDP 截图',
    install: [{ label: 'anthropics/skills（webapp-testing）', url: ANTHROPIC_SKILLS_URL }],
  },
  claude_review: {
    fallback: '启用 claude-code-review 插件',
    // 没有公开的安装地址/命令：只给标签，不编 URL。
    install: [{ label: '@hunyed15/project-cockpit（review 引擎）' }],
  },
  'ui-ux-pro-max': {
    fallback: '用 frontend-design（官方设计方法）替代',
    note: '同一角色只选一个：frontend-design 是官方精炼版',
  },
  'frontend-design': {
    fallback: '用 ui-ux-pro-max 或 impeccable 顶替',
    install: [{ label: 'anthropics/skills（frontend-design）', url: ANTHROPIC_SKILLS_URL }],
  },
  impeccable: {
    fallback: '用 frontend-design 自带的可读性检查',
    note: 'impeccable 是审计/打磨角色，不是方法替代',
  },
  ponytail: {
    fallback: '人工守住最小改动（YAGNI）',
    note: '约束类能力缺失不阻断门禁',
  },
  'tdd-loop': {
    fallback: '手写失败测试 → 最小实现 → 通过 → 重构',
    note: '本仓库 skills/tdd-loop 可直接复制到技能目录',
  },
  'verify-claims': {
    fallback: '跑命令并附原始输出作为证据',
    note: '本仓库 skills/verify-claims 可直接复制到技能目录',
  },
}

/** trellis-* 系列（trellis-start / check / finish-work …）统一给同一份替代与安装信息。 */
const TRELLIS_RULE = {
  fallback: '内置模板 / 原生 git 收尾',
  install: [{ label: 'Trellis', command: 'npm i -g @mindfoldhq/trellis', url: TRELLIS_URL }],
}

function ruleFor(name) {
  const key = name.toLowerCase()
  if (Object.hasOwn(ADVICE_RULES, key)) return ADVICE_RULES[key]
  if (key.startsWith('trellis-')) return TRELLIS_RULE
  return null
}

/** 只保留契约里的三个字段；install 逐项只留 label/command/url，避免把内部字段漏给界面。 */
function normalizeInstall(raw) {
  if (!isObject(raw)) return null
  const label = typeof raw.label === 'string' ? raw.label.trim() : ''
  if (label === '') return null
  const install = { label }
  if (typeof raw.command === 'string' && raw.command.trim() !== '') install.command = raw.command.trim()
  if (typeof raw.url === 'string' && raw.url.trim() !== '') install.url = raw.url.trim()
  return install
}

/**
 * @param {{kind?:string,name?:string,present?:string,note?:string,optional?:boolean}|null} capability
 * @returns {{fallback?:string,install?:{label:string,command?:string,url?:string}[],note?:string}|null}
 *   未知能力或不需要建议时返回 null（不编造）。
 */
export function adviceFor(capability) {
  if (!isObject(capability)) return null
  const name = typeof capability.name === 'string' ? capability.name.trim() : ''
  if (name === '') return null

  const present = capability.present === 'yes' ? 'yes' : capability.present === 'no' ? 'no' : 'unknown'
  const optional = capability.optional === true
  // 已装且必要时不需要"怎么替代/怎么装"。
  if (present === 'yes' && !optional) return null

  const rule = ruleFor(name)
  if (rule === null) return null

  const advice = {}
  if (typeof rule.fallback === 'string' && rule.fallback.trim() !== '') advice.fallback = rule.fallback
  if (Array.isArray(rule.install)) {
    const install = rule.install.map(normalizeInstall).filter(Boolean)
    if (install.length > 0) advice.install = install
  }
  if (typeof rule.note === 'string' && rule.note.trim() !== '') advice.note = rule.note
  return Object.keys(advice).length > 0 ? advice : null
}
