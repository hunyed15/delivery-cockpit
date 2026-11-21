// 预览用的假数据：形状逐字照 docs/IMPLEMENTATION.md §3.8（panel 模型）与 §3.9（响应包装）。
//
// 为什么不用 lib/ 真实计算：预览工具只为本机验证界面，不应该依赖并行开发的 Host 模块；
// 而且「降级 / 空态 / 错误」这些分支用假数据才容易稳定复现。
export const PROJECT_PATH = 'D:\\Coding\\demo\\客户管理'

const NOW = Date.now()
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString()

const STAGE = [
  { id: 'brainstorm', name: '想清楚' },
  { id: 'prototype', name: '看原型' },
  { id: 'coding', name: '写代码' },
  { id: 'code_review', name: '挑毛病' },
  { id: 'verification', name: '验效果' },
  { id: 'release', name: '发出去' },
]

function node(stageId, name, state, summary) {
  return {
    stageId,
    name,
    state,
    receipt: summary ? { status: 'completed', at: ago(180), summary } : null,
  }
}

const RECEIPTS = [
  {
    id: 'r-b4',
    at: ago(2),
    iterationId: 'v1.1',
    stage: 'prototype',
    stageName: '看原型',
    status: 'in_progress',
    summary: '原型 HTML 已生成，等你看过点通过',
    artifacts: ['prototype.html'],
    usedSkill: 'ui-ux-pro-max',
    needsDecision: null,
    taskRef: null,
    writeScope: [],
  },
  {
    id: 'r-b3',
    at: ago(35),
    iterationId: 'v1.1',
    stage: 'brainstorm',
    stageName: '想清楚',
    status: 'completed',
    summary: '本轮要加客户标签与批量导入，范围写进 prd.md',
    artifacts: ['prd.md'],
    usedSkill: 'trellis-brainstorm',
    needsDecision: null,
    taskRef: null,
    writeScope: [],
  },
  {
    id: 'r-b2',
    at: ago(190),
    iterationId: 'v1.0',
    stage: 'release',
    stageName: '发出去',
    status: 'completed',
    summary: 'v1.0 已构建并打 tag',
    artifacts: ['dist/'],
    usedSkill: 'finishing-a-development-branch',
    needsDecision: null,
    taskRef: null,
    writeScope: [],
  },
  {
    id: 'r-b1',
    at: ago(300),
    iterationId: 'v1.0',
    stage: 'verification',
    stageName: '验效果',
    status: 'completed',
    summary: '验收表 6 条全过，截图留证',
    artifacts: ['acceptance.json'],
    usedSkill: 'verification-before-completion',
    needsDecision: null,
    taskRef: null,
    writeScope: [],
  },
]

// 功能账（panel.features）：形状逐字照 IMPLEMENTATION §3.13。
// 三路证据的状态由 Host 推导，这里直接给结论；界面只负责如实呈现。
const FEATURES = {
  source: 'prd',
  prdPath: 'docs/prd.md',
  strategy: 'fr-section',
  formatHint: null,
  counts: { total: 5, done: 1, blocked: 1, inProgress: 1, pendingAcceptance: 1, notStarted: 1 },
  progress: { done: 1, total: 5 },
  items: [
    {
      id: 'FR-1',
      title: '信号采集',
      priority: 'P0',
      status: 'blocked',
      statusLabel: '有阻塞',
      acceptance: { total: 2, passed: 1, failed: 1, blocked: 0, missingEvidence: 0 },
      bugs: {
        blocking: 2,
        known: true,
        issues: [
          { severity: 'critical', title: '采集线程退出后不再重连', file: 'src/collector/run.ts', line: 42 },
          { severity: 'important', title: '断线时 UI 仍显示正常', file: 'src/ui/status.ts', line: 17 },
        ],
      },
      lastAt: ago(3),
      lastSummary: '修了采集重连，还剩一个并发 bug',
      receipts: 4,
      inferredReceipts: 1,
      anchors: { receipts: 3, tasks: 1 },
      paths: ['src/collector/**', 'src/ui/status.ts'],
    },
    {
      id: 'FR-2',
      title: '信号分析',
      priority: 'P1',
      status: 'done',
      statusLabel: '已完成',
      acceptance: { total: 1, passed: 1, failed: 0, blocked: 0, missingEvidence: 0 },
      bugs: { blocking: 0, known: true, issues: [] },
      lastAt: ago(120),
      lastSummary: '分析结果与验收表全部对过',
      receipts: 2,
      inferredReceipts: 0,
      anchors: { receipts: 2, tasks: 0 },
      paths: ['src/analyze/**'],
    },
    {
      id: 'FR-3',
      title: '报表导出',
      priority: 'P1',
      status: 'in-progress',
      statusLabel: '进行中',
      acceptance: { total: 1, passed: 0, failed: 0, blocked: 1, missingEvidence: 0 },
      bugs: { blocking: 0, known: true, issues: [] },
      lastAt: ago(40),
      lastSummary: 'Excel 导出跑通，PDF 还没开始',
      receipts: 2,
      inferredReceipts: 2,
      anchors: { receipts: 0, tasks: 1 },
      paths: ['src/export/**'],
    },
    {
      id: 'FR-4',
      title: '用户权限',
      priority: null,
      status: 'not-started',
      statusLabel: '未开始',
      acceptance: { total: 1, passed: 0, failed: 0, blocked: 0, missingEvidence: 1 },
      // known:false 是「没有路径/回执关联，没法判断」：待修列必须显示 —，不能显示 0。
      bugs: { blocking: 0, known: false, issues: [] },
      lastAt: null,
      lastSummary: null,
      receipts: 0,
      inferredReceipts: 0,
      anchors: { receipts: 0, tasks: 0 },
      paths: [],
    },
    {
      id: 'FR-5',
      title: '移动端适配',
      priority: 'P1',
      status: 'pending-acceptance',
      statusLabel: '待验收',
      acceptance: { total: 1, passed: 0, failed: 0, blocked: 0, missingEvidence: 1 },
      bugs: { blocking: 0, known: true, issues: [] },
      lastAt: ago(300),
      lastSummary: '页面都改完了，等验收表填结果',
      receipts: 1,
      inferredReceipts: 1,
      anchors: { receipts: 0, tasks: 0 },
      paths: ['src/app/**'],
    },
  ],
  unattributed: {
    blocking: 1,
    known: true,
    issues: [{ severity: 'important', title: '全局错误提示重复弹出', file: 'src/shared/toast.ts', line: 8 }],
  },
  notes: ['功能状态由验收、归属 bug、回执三路证据推导；没有证据的功能不显示 0'],
}

const FEATURES_PRD_MISSING = {
  source: 'prd-missing',
  prdPath: null,
  strategy: 'none',
  formatHint: null,
  counts: { total: 0, done: 0, blocked: 0, inProgress: 0, pendingAcceptance: 0, notStarted: 0 },
  progress: { done: 0, total: 0 },
  items: [],
  unattributed: { blocking: 0, known: false, issues: [] },
  notes: ['想清楚阶段会产出 prd.md'],
}

const FEATURES_NO_FR = {
  source: 'prd',
  prdPath: 'docs/prd.md',
  strategy: 'none',
  formatHint: '在 prd.md 里写「## 功能需求」，其下每行用「### FR-1 标题」列功能',
  counts: { total: 0, done: 0, blocked: 0, inProgress: 0, pendingAcceptance: 0, notStarted: 0 },
  progress: { done: 0, total: 0 },
  items: [],
  unattributed: { blocking: 0, known: false, issues: [] },
  notes: ['PRD 里有内容，但没找到「功能需求」节或 ### FR-N 结构'],
}

const PROTOTYPE_ACTION = {  priority: 5,
  kind: 'prototype',
  stageId: 'prototype',
  stageName: '看原型',
  title: '确认 UI 布局与交互契约',
  reason: '本轮原型还没人点过通过，不能开始写代码。',
  instruction:
    '请用 `ui-ux-pro-max` 生成本轮原型，再用 `frontend-design` 自检：\n' +
    '1. 产出项目根目录 prototype.html（纯静态、假数据）\n' +
    '2. 把页面清单与交互写进 prd.md 的原型小节\n' +
    '完成后请人点「通过原型」。',
  capabilities: [
    {
      kind: 'skill',
      name: 'ui-ux-pro-max',
      mode: 'full',
      optional: false,
      note: '原型与页面结构',
      present: 'yes',
      missingMessage: null,
    },
    {
      kind: 'skill',
      name: 'frontend-design',
      mode: 'full',
      optional: false,
      note: '视觉与排版自检',
      present: 'yes',
      missingMessage: null,
    },
    {
      kind: 'mcp',
      name: 'Playwright',
      mode: 'full',
      optional: true,
      note: 'Phase 2 才用于截图留证',
      present: 'no',
      missingMessage: '该阶段需要的 MCP 未安装：Playwright',
    },
  ],
  missing: [],
  disabled: false,
  disabledReason: '',
  notes: ['审核账本可用：最近 2 轮已清'],
  buttons: ['copy'],
}

// 验收清单（panel.acceptance.items）：面板内直接改结果，所以至少覆盖
// 通过（带证据，含 URL）/ 失败 / 阻塞 / 未填 四种状态。
const ACCEPTANCE_ITEMS = [
  {
    id: 'A1',
    featureRef: 'FR-1',
    title: '能添加客户',
    steps: '打开客户列表 → 点新增 → 填名字 → 保存',
    expect: '列表出现新客户',
    result: 'pass',
    evidence: ['.dsh/plugin-state/shots/a1.png', 'shots/add.png', 'shots/add-2.png', 'https://ci.example.com/runs/42'],
    at: ago(20),
  },
  {
    id: 'A2',
    featureRef: 'FR-1',
    title: '重复客户会被拦下',
    steps: '新增同名客户两次',
    expect: '第二次提示已存在',
    result: 'fail',
    evidence: ['shots/dup.png'],
    at: ago(90),
  },
  {
    id: 'A3',
    featureRef: 'FR-3',
    title: '导出 Excel 含全部列',
    steps: '点导出 → 打开文件对照列表',
    expect: '字段与列表一致',
    result: 'blocked',
    evidence: [],
    at: ago(180),
  },
  {
    id: 'A4',
    featureRef: 'FR-4',
    title: '普通成员看不到管理入口',
    steps: '用成员账号登录',
    expect: '侧栏没有设置入口',
    result: null,
    evidence: [],
    at: null,
  },
  {
    id: 'A5',
    featureRef: 'FR-5',
    title: '手机上能完成新增',
    steps: '360px 宽度走一遍新增',
    expect: '按钮不遮挡、能保存',
    result: null,
    evidence: [],
    at: null,
  },
  {
    id: 'A6',
    featureRef: 'FR-2',
    title: '分析结果与标准样本一致',
    steps: '跑标准样本 → 对比结果',
    expect: '误差在阈值内',
    result: 'pass',
    evidence: ['shots/analyze.png', '.dsh/plugin-state/shots/a6.png'],
    at: ago(240),
  },
]

function makePanel(overrides = {}) {
  const base = {
    ok: true,
    generatedAt: new Date().toISOString(),
    project: {
      path: PROJECT_PATH,
      name: '客户管理',
      oneLiner: '给小团队用的客户跟进工具',
      cardStatus: 'filled',
      stack: { id: 'next', label: 'Web / Next.js' },
      commands: { dev: 'pnpm dev', build: 'pnpm build', previewUrl: null },
      packageManager: 'pnpm',
      evidence: [{ file: 'package.json', detail: 'dependencies.next' }],
    },
    trellis: { exists: true, rules: true, initialized: true, partial: false },
    iteration: {
      current: 'v1.1',
      isBootstrap: false,
      prototype: { approved: false, at: null, file: null },
    },
    nextAction: PROTOTYPE_ACTION,
    progression: {
      coldStart: [
        node('init', '初始化', 'done', '初始化 .trellis 与 .dsh/plugin-state'),
        node('scaffold', '搭骨架', 'done', '探测到 Next.js，空壳能 pnpm dev 启动'),
      ],
      cycle: [
        node('brainstorm', '想清楚', 'done', '本轮范围写进 prd.md'),
        node('prototype', '看原型', 'current', null),
        node('coding', '写代码', 'pending', null),
        node('code_review', '挑毛病', 'pending', null),
        node('verification', '验效果', 'pending', null),
        node('release', '发出去', 'pending', null),
      ],
    },
    ledger: {
      receipts: RECEIPTS,
      total: RECEIPTS.length,
      truncated: false,
      badLines: 0,
      missing: false,
      lastAt: RECEIPTS[0].at,
    },
    acceptance: {
      total: 6,
      withResult: 4,
      passed: 2,
      failed: 1,
      blocked: 1,
      empty: false,
      badJson: false,
      truncated: false,
      items: ACCEPTANCE_ITEMS,
    },
    review: { available: true, reason: null, rounds: 2, blocking: 0, fixed: 0, issues: [] },
    tasks: {
      available: true,
      total: 5,
      open: 2,
      completed: 3,
      items: [
        { id: 'T1', title: '客户列表接口', status: 'in_progress' },
        { id: 'T2', title: '客户标签编辑', status: 'in_progress' },
        { id: 'T3', title: '批量导入', status: 'completed' },
      ],
    },
    warnings: [],
    features: FEATURES,
    dataGaps: [{ source: 'tasks', message: '任务状态来自回执自报，不是 Agent Teams 实时读取' }],
    degraded: { flag: false, reasons: [] },
  }
  return { ...base, ...overrides }
}

export function panelFor(scenario) {
  switch (scenario) {
    case 'degraded':
      return makePanel({
        nextAction: {
          priority: 1,
          kind: 'confirm-data',
          stageId: null,
          stageName: '先确认数据',
          title: '先确认数据，再按下一步',
          reason: '账本与验收表读取失败，现在给出的结论不可信。',
          instruction: null,
          capabilities: [],
          missing: [],
          disabled: true,
          disabledReason: '账本不可信：先确认数据来源，再行动。',
          notes: ['receipts.jsonl 有 2 行损坏', 'acceptance.json 不是合法 JSON'],
          buttons: [],
        },
        ledger: {
          receipts: RECEIPTS.slice(0, 2),
          total: 4,
          truncated: true,
          badLines: 2,
          missing: false,
          lastAt: RECEIPTS[0].at,
        },
        acceptance: { total: 0, withResult: 0, passed: 0, failed: 0, blocked: 0, empty: false, badJson: true },
        review: { available: false, reason: 'read-failed', rounds: 0, blocking: 0, fixed: 0, issues: [] },
        warnings: [
          { source: 'receipts', message: 'receipts.jsonl 第 7 行不是合法 JSON，已跳过' },
          { source: 'acceptance', message: 'acceptance.json 解析失败，已按未填写处理' },
        ],
        degraded: {
          flag: true,
          reasons: [
            { source: 'receipts', message: 'receipts.jsonl 读取失败：EACCES（权限不足）' },
            { source: 'acceptance', message: 'acceptance.json 不是合法 JSON' },
          ],
        },
      })
    case 'approved':
      // 批准已落盘、但模型还没重算的一瞬间：按钮必须是只读状态，不能再点第二次。
      return makePanel({
        iteration: {
          current: 'v1.1',
          isBootstrap: false,
          prototype: { approved: true, at: ago(15), file: 'prototype.html' },
        },
      })
    case 'pending':
      return makePanel({
        nextAction: {
          priority: 2,
          kind: 'decide',
          stageId: 'prototype',
          stageName: '看原型',
          title: '客户标签要不要支持批量打标？',
          reason: '这条回执标了需要你拍板，处理完才能继续。',
          instruction: '请先确认：客户标签这轮只做单个打标，还是直接做批量打标？',
          capabilities: [],
          missing: [],
          disabled: false,
          disabledReason: '',
          notes: [],
          buttons: ['copy'],
        },
        ledger: {
          ...makePanel().ledger,
          receipts: RECEIPTS.map((receipt, index) =>
            index === 0
              ? {
                  ...receipt,
                  needsDecision: {
                    title: '客户标签要不要支持批量打标？',
                    options: ['先做单个打标', '直接做批量打标'],
                    recommended: '先做单个打标，批量放到下一轮',
                  },
                }
              : receipt,
          ),
        },
      })
    case 'badlines':
      return makePanel({
        ledger: { ...makePanel().ledger, badLines: 3 },
        warnings: [{ source: 'receipts', message: 'receipts.jsonl 第 4、8、11 行不是合法 JSON，已跳过' }],
      })
    case 'missing':
      return makePanel({
        nextAction: {
          ...PROTOTYPE_ACTION,
          instruction: null,
          capabilities: [
            {
              kind: 'mcp',
              name: 'Playwright',
              mode: 'full',
              optional: false,
              note: '真实浏览器跑通',
              present: 'no',
              missingMessage: '该阶段需要的 MCP 未安装：Playwright',
            },
            {
              kind: 'skill',
              name: 'frontend-design',
              mode: 'full',
              optional: false,
              note: null,
              present: 'unknown',
              missingMessage: null,
            },
          ],
          missing: [{ name: 'Playwright', kind: 'mcp', message: '该阶段需要的 MCP 未安装：Playwright' }],
          disabled: true,
          disabledReason: '该阶段需要的 MCP 未安装：Playwright',
        },
      })
    case 'init':
    case 'initdone':
      return makePanel({
        trellis: { exists: false, rules: false, initialized: false, partial: false },
        iteration: { current: 'bootstrap', isBootstrap: true, prototype: { approved: false, at: null, file: null } },
        nextAction: {
          priority: 3,
          kind: 'init',
          stageId: 'init',
          stageName: '初始化',
          title: '初始化这个项目',
          reason: '还没有 .trellis 与 RULES.md，先建好规则与账本。',
          instruction: null,
          capabilities: [],
          missing: [],
          disabled: false,
          disabledReason: '',
          notes: [],
          buttons: ['init'],
        },
        progression: {
          coldStart: [node('init', '初始化', 'current', null), node('scaffold', '搭骨架', 'pending', null)],
          cycle: STAGE.map((stage) => node(stage.id, stage.name, 'pending', null)),
        },
        ledger: { receipts: [], total: 0, truncated: false, badLines: 0, missing: true, lastAt: null },
        acceptance: { total: 0, withResult: 0, passed: 0, failed: 0, blocked: 0, empty: true, badJson: false },
        review: { available: false, reason: 'no-ledger', rounds: 0, blocking: 0, fixed: 0, issues: [] },
        tasks: { available: false, total: 0, open: 0, completed: 0, items: [] },
        warnings: [],
        dataGaps: [{ source: 'trellis', message: '项目还没初始化' }],
        features: FEATURES_PRD_MISSING,
      })
    case 'features-prd-missing':
      return makePanel({
        features: FEATURES_PRD_MISSING,
        dataGaps: [{ source: 'prd', message: '项目里还没有 prd.md' }],
      })
    case 'features-no-fr':
      return makePanel({
        features: FEATURES_NO_FR,
        dataGaps: [{ source: 'prd', message: 'PRD 里没找到「### FR-N 标题」结构' }],
      })
    case 'acceptance-truncated': {
      // 只下发 2 条可见条目，但全局 passed/total 是完整账本的：验证摘要用 Host 真值。
      const base = makePanel()
      return {
        ...base,
        acceptance: {
          ...base.acceptance,
          total: 40,
          withResult: 33,
          passed: 5,
          failed: 3,
          blocked: 1,
          truncated: true,
          items: base.acceptance.items.slice(0, 2),
        },
      }
    }
    case 'acceptance-empty': {
      const base = makePanel()
      return {
        ...base,
        acceptance: {
          total: 0,
          withResult: 0,
          passed: 0,
          failed: 0,
          blocked: 0,
          empty: true,
          badJson: false,
          truncated: false,
          items: [],
        },
        nextAction: {
          ...base.nextAction,
          kind: 'acceptance-draft',
          stageId: 'verification',
          stageName: '验效果',
          title: '生成验收清单',
          reason: '验收表还是空的，先让 Agent 起草第一版。',
          instruction: '请用 `cockpit_acceptance` 起草人话验收清单：每条写清步骤与期望，放进 .dsh/plugin-state/acceptance.json。',
          buttons: ['copy'],
        },
      }
    }
    default:
      return makePanel()
  }
}

export const OVERVIEW_ROWS = [
  {
    id: 'w1',
    title: '客户管理',
    path: PROJECT_PATH,
    initialized: true,
    stageId: 'prototype',
    stageName: '看原型',
    nextKind: 'prototype',
    nextTitle: '确认 UI 布局与交互契约',
    degraded: false,
    hasDecision: false,
    updatedAt: ago(2),
  },
  {
    id: 'w2',
    title: '官网改版',
    path: 'D:\\Coding\\demo\\官网改版',
    initialized: true,
    stageId: 'code_review',
    stageName: '挑毛病',
    nextKind: 'decide',
    nextTitle: '首页首屏文案选哪版？',
    degraded: true,
    hasDecision: true,
    updatedAt: ago(50),
  },
  {
    id: 'w3',
    title: '新项目',
    path: 'D:\\Coding\\demo\\新项目',
    initialized: false,
    stageId: null,
    stageName: null,
    nextKind: 'init',
    nextTitle: '初始化这个项目',
    degraded: false,
    hasDecision: false,
    updatedAt: ago(600),
  },
]

export function workspacesFor(scenario) {
  return {
    ok: true,
    projects: scenario === 'empty' ? [] : scenario === 'overview' ? OVERVIEW_ROWS : [OVERVIEW_ROWS[0]],
    generatedAt: new Date().toISOString(),
  }
}

export function initPlan(path) {
  const root = String(path)
  return {
    projectPath: root,
    stateDir: `${root}\\.dsh\\plugin-state`,
    trellisDir: `${root}\\.trellis`,
    dirs: [
      { path: `${root}\\.trellis`, status: 'create' },
      { path: `${root}\\.dsh\\plugin-state`, status: 'exists' },
    ],
    files: [
      { name: 'RULES.md', path: `${root}\\RULES.md`, status: 'create', source: 'template', bytes: 3118 },
      { name: 'playbook.json', path: `${root}\\.dsh\\plugin-state\\playbook.json`, status: 'exists', source: 'template', bytes: 7150 },
      { name: 'project.json', path: `${root}\\.dsh\\plugin-state\\project.json`, status: 'create', source: 'generated', bytes: 240 },
      { name: 'acceptance.json', path: `${root}\\.dsh\\plugin-state\\acceptance.json`, status: 'create', source: 'template', bytes: 64 },
    ],
    gitignoreHint: '.dsh/plugin-state/',
    notes: ['已有 playbook.json，不覆盖'],
    errors: [],
  }
}

export function initResult(path) {
  const plan = initPlan(path)
  return {
    ok: true,
    dryRun: false,
    applied: true,
    projectPath: plan.projectPath,
    created: [plan.dirs[0].path, `${plan.projectPath}\\RULES.md`, `${plan.projectPath}\\.dsh\\plugin-state\\project.json`],
    skipped: [`${plan.projectPath}\\.dsh\\plugin-state\\playbook.json`, `${plan.projectPath}\\.dsh\\plugin-state\\acceptance.json`],
    errors: [],
    gitignoreHint: '.dsh/plugin-state/',
  }
}

export function approveResult(iterationId) {
  return {
    ok: true,
    approval: {
      iterationId,
      prototypeApprovedAt: new Date().toISOString(),
      prototype: 'prototype.html',
    },
  }
}

