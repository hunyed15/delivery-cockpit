// 预览用的假数据：形状逐字照 docs/IMPLEMENTATION.md §3.8（panel 模型）与 §3.9（响应包装）。
//
// 为什么不用 lib/ 真实计算：预览工具只为本机验证界面，不应该依赖并行开发的 Host 模块；
// 而且「降级 / 空态 / 错误」这些分支用假数据才容易稳定复现。
export const PROJECT_PATH = 'D:\\Coding\\demo\\客户管理'

const NOW = Date.now()
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString()

const STAGE = [
  { id: 'requirements', name: '需求定义' },
  { id: 'architecture', name: '架构契约' },
  { id: 'prototype', name: '原型设计' },
  { id: 'implementation', name: '代码开发' },
  { id: 'testing', name: '测试验证' },
  { id: 'code-review', name: '代码复核' },
  { id: 'acceptance', name: '验收确认' },
  { id: 'release', name: '部署发布' },
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
    stageName: '原型设计',
    status: 'in_progress',
    summary: '原型 HTML 已生成，等你看过点通过',
    artifacts: ['prototype.html'],
    usedSkill: 'frontend-design',
    needsDecision: null,
    taskRef: null,
    writeScope: [],
  },
  {
    id: 'r-b3',
    at: ago(35),
    iterationId: 'v1.1',
    stage: 'requirements',
    stageName: '需求定义',
    status: 'completed',
    summary: '本轮要加客户标签与批量导入，范围写进 prd.md',
    artifacts: ['prd.md'],
    usedSkill: 'grilling',
    needsDecision: null,
    taskRef: null,
    writeScope: [],
  },
  {
    id: 'r-b2',
    at: ago(190),
    iterationId: 'v1.0',
    stage: 'release',
    stageName: '部署发布',
    status: 'completed',
    summary: 'v1.0 已构建并打 tag',
    artifacts: ['dist/'],
    usedSkill: 'trellis-finish-work',
    needsDecision: null,
    taskRef: null,
    writeScope: [],
  },
  {
    id: 'r-b1',
    at: ago(300),
    iterationId: 'v1.0',
    stage: 'acceptance',
    stageName: '验收确认',
    status: 'completed',
    summary: '验收表 6 条全过，截图留证',
    artifacts: ['acceptance.json'],
    usedSkill: 'verify-claims',
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
      statusLabel: '有卡点',
      // A1 已失效：Host 的 passed 会排除失效条，所以这里 passed=0、missingEvidence=1。
      acceptance: { total: 2, passed: 0, failed: 1, blocked: 0, missingEvidence: 1 },
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
      // known:false 是「没有路径/动态关联，没法判断」：待修列必须显示 —，不能显示 0。
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
  notes: ['状态来自验收结果、待修问题和项目动态；没有信息时不显示 0'],
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
  notes: ['需求定义阶段会产出 prd.md'],
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
  stageName: '原型设计',
  title: '确认 UI 布局与交互契约',
  reason: '本轮原型还没人点过通过，不能开始代码开发。',
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
  notes: ['代码检查能读到：最近 2 轮都通过'],
  buttons: ['copy'],
}

// 验收清单（panel.acceptance.items）：面板内直接改结果，所以至少覆盖
// 通过（带证据，含 URL）/ 失败 / 卡点 / 未填 四种状态。
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
    // 最近一次截图有变化：result 仍是 pass（历史保留），但这条已失效、需要重新确认。
    stale: true,
    staleAt: ago(5),
    staleReason: 'visual-change',
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

// 视觉回归：每条验收项的最近几次像素对比（Host 语义：正序、最后一条最新、最多 5 条）。
// 覆盖 new / same / changed / different-size / uncomparable 五种结论。
const SHOT_DIFFS_BY_ITEM = {
  A1: [
    {
      at: ago(140),
      verdict: 'same',
      baseline: '.dsh/plugin-state/shots/a1.png',
      diffFile: null,
      ratio: 0,
      changedPixels: 0,
      totalPixels: 1152000,
      width: 1280,
      height: 900,
      reason: null,
    },
    {
      at: ago(20),
      verdict: 'changed',
      baseline: '.dsh/plugin-state/shots/a1.png',
      diffFile: '.dsh/plugin-state/shots/diff-A1-preview.png',
      ratio: 0.0031,
      changedPixels: 3535,
      totalPixels: 1152000,
      width: 1280,
      height: 900,
      reason: null,
    },
  ],
  A2: [
    { at: ago(90), verdict: 'new', baseline: null, diffFile: null, ratio: null, changedPixels: null, totalPixels: null, width: 1280, height: 900, reason: null },
    { at: ago(30), verdict: 'same', baseline: 'shots/dup.png', diffFile: null, ratio: 0, changedPixels: 0, totalPixels: 1152000, width: 1280, height: 900, reason: null },
  ],
  A4: [
    { at: ago(200), verdict: 'new', baseline: null, diffFile: null, ratio: null, changedPixels: null, totalPixels: null, width: 1280, height: 900, reason: null },
    { at: ago(60), verdict: 'uncomparable', baseline: 'https://ci.example.com/runs/42', diffFile: null, ratio: null, changedPixels: null, totalPixels: null, width: 1280, height: 900, reason: 'baseline-url' },
  ],
  A5: [
    { at: ago(150), verdict: 'new', baseline: null, diffFile: null, ratio: null, changedPixels: null, totalPixels: null, width: 1280, height: 900, reason: null },
    { at: ago(45), verdict: 'different-size', baseline: '.dsh/plugin-state/shots/a5.png', diffFile: null, ratio: null, changedPixels: null, totalPixels: null, width: 1280, height: 1320, reason: null },
  ],
  A6: [
    { at: ago(120), verdict: 'new', baseline: null, diffFile: null, ratio: null, changedPixels: null, totalPixels: null, width: 1280, height: 900, reason: null },
  ],
}

for (const item of ACCEPTANCE_ITEMS) {
  if (SHOT_DIFFS_BY_ITEM[item.id]) item.shotDiffs = SHOT_DIFFS_BY_ITEM[item.id]
}

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
        node('bootstrap', '项目立项', 'done', '初始化 .trellis 与 .dsh/plugin-state'),
      ],
      cycle: [
        node('requirements', '需求定义', 'done', '本轮范围写进 prd.md'),
        node('architecture', '架构契约', 'done', '契约与 ADR 已冻结并签核'),
        node('prototype', '原型设计', 'current', null),
        node('implementation', '代码开发', 'pending', null),
        node('testing', '测试验证', 'pending', null),
        node('code-review', '代码复核', 'pending', null),
        node('acceptance', '验收确认', 'pending', null),
        node('release', '部署发布', 'pending', null),
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
      // A1 虽然 result=pass，但已失效（截图有变化），Host 的通过计数把它排除。
      passed: 1,
      failed: 1,
      blocked: 1,
      stale: 1,
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
    dataGaps: [{ source: 'tasks', message: '任务状态来自 AI 自报，不是实时读取' }],
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
          reason: '动态记录和验收清单没读全，现在给出的结论不可信。',
          instruction: null,
          capabilities: [],
          missing: [],
          disabled: true,
          disabledReason: '数据没读全：先确认数据来源，再行动。',
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
          stageName: '原型设计',
          title: '客户标签要不要支持批量打标？',
          reason: '这条动态标了需要你拍板，处理完才能继续。',
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
          stageId: 'bootstrap',
          stageName: '项目立项',
          title: '初始化这个项目',
          reason: '还没有 .trellis 与 RULES.md，先建好项目规则和记录。',
          instruction: null,
          capabilities: [],
          missing: [],
          disabled: false,
          disabledReason: '',
          notes: [],
          buttons: ['init'],
        },
        progression: {
          coldStart: [node('bootstrap', '项目立项', 'current', null)],
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
      // 只下发 2 条可见条目，但全局 passed/total 是完整动态记录的：验证摘要用 Host 真值。
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
          stageId: 'acceptance',
          stageName: '验收确认',
          title: '起草验收清单',
          reason: '验收清单还是空的，先让 AI 起草第一版。',
          instruction: '请按 PRD 起草一份人话验收清单：每条写清操作步骤和期望结果，存进项目的验收清单文件。',
          buttons: ['copy'],
        },
      }
    }
    case 'accent-features': {
      // 三种进度条形态：0/2、1/1、没有验收条目（不渲染进度条）。
      const base = makePanel()
      return {
        ...base,
        features: {
          ...base.features,
          items: base.features.items.map((item, index) =>
            index === 3
              ? {
                  ...item,
                  acceptance: { total: 0, passed: 0, failed: 0, blocked: 0, missingEvidence: 0 },
                }
              : item,
          ),
        },
      }
    }
    case 'goal-gates': {
      const base = makePanel()
      return {
        ...base,
        nextAction: {
          priority: 4.5,
          kind: 'architecture',
          stageId: 'architecture',
          stageName: '架构契约',
          title: '先定架构与契约',
          reason: '还缺架构契约：docs/architecture.md、docs/api.md',
          instruction: '写 docs/architecture.md（组件/数据模型/接口清单/关键决策）与 docs/api.md，然后写回执。',
          capabilities: [
            { kind: 'skill', name: 'ponytail', mode: 'full', optional: false, present: 'present', note: null, missingMessage: null },
            { kind: 'inline', name: 'architecture-template', mode: 'inline', optional: false, present: 'present', note: null, missingMessage: null },
          ],
          missing: [],
          disabled: false,
          disabledReason: '',
          notes: [],
          buttons: ['copy'],
          method: null,
          constraint: 'ponytail',
          deliverables: ['docs/architecture.md', 'docs/api.md'],
          technicalGate: 'validateArchitecture',
          decisionGate: { title: '架构签核', approveAction: 'approve-architecture' },
        },
        gates: {
          architecture: { available: false, ok: false, missing: ['docs/architecture.md', 'docs/api.md'], reason: 'missing', detail: null },
          tests: { available: false, ok: false, missing: ['.dsh/plugin-state/test-report.json'], reason: 'missing', detail: null },
          release: { available: false, ok: false, missing: ['.dsh/plugin-state/release.json'], reason: 'missing', detail: null },
        },
        progression: {
          coldStart: [node('bootstrap', '项目立项', 'done', '初始化 .trellis 与 .dsh/plugin-state')],
          cycle: [
            node('requirements', '需求定义', 'done', '本轮范围写进 prd.md'),
            node('architecture', '架构契约', 'current', null),
            node('prototype', '原型设计', 'pending', null),
            node('implementation', '代码开发', 'pending', null),
            node('testing', '测试验证', 'pending', null),
            node('code-review', '代码复核', 'pending', null),
            node('acceptance', '验收确认', 'pending', null),
            node('release', '部署发布', 'pending', null),
          ],
        },
      }
    }    case 'goal-empty-prd':
      return panelFor('features-prd-missing')
    case 'goal-empty-acc':
      return panelFor('acceptance-empty')
    case 'goal-empty-receipts': {
      const base = makePanel()
      return {
        ...base,
        ledger: { ...base.ledger, receipts: [], total: 0, lastAt: null, missing: true },
      }
    }
    case 'goal-timeline': {
      const base = makePanel()
      const receipts = RECEIPTS.slice(0, 3).map((receipt, index) => ({
        ...receipt,
        id: `r-goal-${index}`,
        at: [ago(30), ago(2 * 24 * 60), ago(20 * 24 * 60)][index],
      }))
      return {
        ...base,
        ledger: { ...base.ledger, receipts, total: receipts.length, lastAt: receipts[0].at },
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
    stageName: '原型设计',
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
    stageId: 'code-review',
    stageName: '代码复核',
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




