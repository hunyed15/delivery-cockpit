/**
 * 面板模型单测：形状逐字对契约，重点是三处容易"看起来对、其实骗人"的地方：
 * - progression 当前阶段最多一个（回执优先于决策指向）；
 * - instruction 为 null 且缺阻断能力时必须禁用，理由取第一条缺失说明；
 * - review 不可用时数字保持 null，不许伪造成 0；ledger 截断后 total/truncated 必须自洽。
 *
 * 证据与能力集都手写：模型层不读盘，测试不依赖真实项目。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildDetailModel, buildOverviewRow, teamSection } from '../lib/model.js'
import { STAGE_DEFS } from '../lib/playbook.js'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const DETAIL_KEYS = [
  'acceptance',
  'dataGaps',
  'degraded',
  'features',
  'gates',
  'generatedAt',
  'iteration',
  'ledger',
  'metrics',
  'nextAction',
  'ok',
  'progression',
  'project',
  'review',
  'stages',
  'tasks',
  'team',
  'trellis',
  'warnings',
]

const ROW_KEYS = ['degraded', 'hasDecision', 'id', 'initialized', 'nextKind', 'nextTitle', 'path', 'stageId', 'stageName', 'title', 'updatedAt']

const LEDGER_RECEIPT_KEYS = [
  'artifacts',
  'at',
  'event',
  'featureIds',
  'id',
  'iterationId',
  'needsDecision',
  'stage',
  'stageName',
  'status',
  'summary',
  'taskRef',
  'usedSkill',
  'writeScope',
]

const STAGE_NODE_KEYS = ['name', 'receipt', 'stageId', 'state']

const passAcceptance = () => ({
  items: [{ id: 'A1', title: '能添加客户', result: 'pass', evidence: ['shots/add.png'] }],
  empty: false,
  badJson: false,
  missing: false,
  total: 1,
  withResult: 1,
  passed: 1,
  failed: 0,
  blocked: 0,
  passWithoutEvidence: 0,
  appliesToCurrent: true,
})

function baseEvidence() {
  return {
    ok: true,
    projectPath: 'C:\\demo\\shop',
    workspace: { exists: true },
    trellis: { exists: true, rules: true, initialized: true, partial: false },
    prd: { found: true, path: 'prd.md' },
    card: { card: null, status: 'missing', broken: false, missing: true },
    detected: {
      id: 'next',
      label: 'Web / Next.js',
      packageManager: 'pnpm',
      commands: { dev: 'pnpm dev', build: 'pnpm build', previewUrl: null },
      evidence: [{ file: 'package.json', detail: 'dependencies.next' }],
      notes: [],
    },
    receipts: { receipts: [], badLines: 0, missing: false, lastAt: null },
    iteration: { current: 'v1.0', isBootstrap: false, approvals: { map: {}, badJson: false, missing: false } },
    approval: { approved: true, at: '2026-11-20T10:00:00.000Z', file: 'prototype.html' },
    acceptance: passAcceptance(),
    tasks: { available: true, total: 1, open: 0, completed: 1, items: [{ id: 'T1', title: '客户列表', status: 'completed' }] },
    review: { available: true, reason: null, rounds: 1, blocking: 0, fixed: 0, lastRound: 1, issues: [] },
    warnings: [],
    dataGaps: [],
    degraded: { flag: false, reasons: [] },
    generatedAt: '2026-11-20T10:00:00.000Z',
  }
}

function evidence(patch = {}) {
  const base = baseEvidence()
  const merged = { ...base, ...patch }
  for (const key of ['trellis', 'prd', 'approval', 'tasks', 'review', 'acceptance', 'iteration', 'receipts', 'degraded']) {
    if (isObject(patch[key])) merged[key] = { ...base[key], ...patch[key] }
  }
  return merged
}

let receiptSeq = 0
const receipt = (overrides = {}) => {
  receiptSeq += 1
  return {
    id: `r-${receiptSeq}`,
    at: `2026-11-20T10:${String(receiptSeq % 60).padStart(2, '0')}:00.000Z`,
    iteration_id: 'v1.0',
    stage: 'brainstorm',
    status: 'completed',
    summary_for_human: '需求收敛成 prd.md',
    ...overrides,
  }
}

/** 只保留测试需要的 stage 条目；omit 里的阶段对应"playbook 没有这一条"。 */
function makePlaybook({ omit = [], prompts = {} } = {}) {
  const stages = {}
  for (const stage of STAGE_DEFS) {
    if (omit.includes(stage.id)) continue
    stages[stage.playbookKey] = {
      capabilities: [{ kind: 'skill', name: `skill-${stage.id}`, mode: 'full' }],
      promptTemplate: prompts[stage.id] ?? `执行【${stage.name}】：{capabilities}`,
    }
  }
  return { version: 1, stages, missingHints: {} }
}

function resolved(name, overrides = {}) {
  return {
    kind: 'skill',
    name,
    mode: 'full',
    optional: false,
    note: null,
    present: 'yes',
    missingMessage: null,
    ...overrides,
  }
}

function makeStageCapabilities(overrides = {}) {
  const map = {}
  for (const stage of STAGE_DEFS) map[stage.id] = [resolved(`skill-${stage.id}`)]
  return { ...map, ...overrides }
}

function build(ev, options = {}) {
  return buildDetailModel({
    evidence: ev,
    playbook: options.playbook ?? makePlaybook(),
    stageCapabilities: options.stageCapabilities ?? makeStageCapabilities(),
    generatedAt: '2026-11-20T12:00:00.000Z',
    features: options.features,
    team: options.team,
    metrics: options.metrics,
    reviewSettings: options.reviewSettings,
  })
}

const currentNodes = (model) => [...model.progression.coldStart, ...model.progression.cycle].filter((node) => node.state === 'current')

test('acceptance-draft：指令点名还缺验收的 FR，并指向 cockpit_acceptance', async () => {
  const { buildFeatureBoard, extractFeatures } = await import('../lib/features.js')
  const board = buildFeatureBoard({
    extracted: extractFeatures(['## 功能需求', '### FR-1 采集', '### FR-2 转存'].join('\n')),
    prd: { path: 'prd.md' },
    acceptance: {
      items: [{ id: 'A1', feature_ref: 'FR-2', title: '能转存', result: 'pass', evidence: ['shots/fr2.png'] }],
      appliesToCurrent: true,
      badJson: false,
      missing: false,
      empty: false,
      total: 1,
    },
    review: { available: true, rounds: 1, blocking: 0, fixed: 0, lastRound: 1, issues: [], blockingIssues: [] },
  })
  const emptyAcceptance = {
    items: [],
    empty: true,
    total: 0,
    withResult: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    passWithoutEvidence: 0,
    appliesToCurrent: true,
  }
  const model = build(evidence({ acceptance: emptyAcceptance }), { features: board })

  assert.equal(model.nextAction.kind, 'acceptance-draft')
  assert.match(model.nextAction.instruction, /FR-1/, '缺验收的功能要被点名')
  assert.doesNotMatch(model.nextAction.instruction, /FR-2/, '已有验收条目的功能不该列进"还缺"')
  assert.match(model.nextAction.instruction, /cockpit_acceptance/)
  assert.equal(model.nextAction.disabled, false)
  assert.deepEqual(model.nextAction.buttons, ['copy'])
})

test('acceptance-draft：缺必需能力时不得被 hint 解禁（§6.3 优先）', async () => {
  const { buildFeatureBoard, extractFeatures } = await import('../lib/features.js')
  const board = buildFeatureBoard({
    extracted: extractFeatures(['## 功能需求', '### FR-1 采集'].join('\n')),
    prd: { path: 'prd.md' },
    acceptance: { items: [], appliesToCurrent: true, badJson: false, missing: false, empty: true, total: 0 },
  })
  const emptyAcceptance = {
    items: [],
    empty: true,
    total: 0,
    withResult: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    passWithoutEvidence: 0,
    appliesToCurrent: true,
  }
  const model = build(evidence({ acceptance: emptyAcceptance }), {
    features: board,
    stageCapabilities: makeStageCapabilities({
      acceptance: [resolved('verification-skill', { present: 'no', missingMessage: '该阶段需要的技能未安装：verification-skill。' })],
    }),
  })

  assert.equal(model.nextAction.kind, 'acceptance-draft')
  assert.equal(model.nextAction.disabled, true)
  assert.equal(model.nextAction.instruction, null, '缺能力时不能下发指令')
  assert.equal(model.nextAction.disabledReason, '该阶段需要的技能未安装：verification-skill。')
  assert.doesNotMatch(JSON.stringify(model.nextAction.notes), /cockpit_acceptance/, '没有被 hint 改写')
})

test('验收清单：stale 与计数随载荷下发（阶段门据此拦人）', () => {
  const items = [
    {
      id: 'A1',
      feature_ref: 'FR-1',
      title: '能添加客户',
      result: 'pass',
      evidence: ['shots/a1.png'],
      stale: true,
      stale_at: '2026-11-21T01:00:00.000Z',
      stale_reason: 'visual-change',
      shot_diffs: [{ at: '2026-11-21T01:00:00.000Z', verdict: 'changed', ratio: 0.02, changedPixels: 200, totalPixels: 10000 }],
    },
  ]
  const model = build(
    evidence({
      acceptance: {
        items,
        empty: false,
        badJson: false,
        total: 1,
        withResult: 0,
        passed: 0,
        failed: 0,
        blocked: 0,
        stale: 1,
        passWithoutEvidence: 0,
        appliesToCurrent: true,
      },
    }),
  )
  assert.equal(model.acceptance.stale, 1)
  const item = model.acceptance.items[0]
  assert.equal(item.stale, true)
  assert.equal(item.staleReason, 'visual-change')
  assert.equal(item.staleAt, '2026-11-21T01:00:00.000Z')
  assert.equal(item.shotDiffs[0].verdict, 'changed')
})

test('审计回执（失效留痕）不参与进度轨，但仍出现在流水账里', () => {
  const audit = receipt({
    stage: 'acceptance',
    status: 'in_progress',
    event: 'acceptance-stale',
    summary_for_human: '截图有变化，验收「能添加客户」已失效',
    at: '2026-11-21T05:00:00.000Z',
  })
  const model = build(
    evidence({
      receipts: {
        receipts: [receipt({ stage: 'implementation', status: 'completed' }), audit],
        lastAt: audit.at,
      },
    }),
  )
  const cycle = model.progression.cycle
  const acceptance = cycle.find((node) => node.stageId === 'acceptance')
  assert.notEqual(acceptance.state, 'current', '审计回执不能把「验收确认」标成进行中')
  // 流水账照常展示它（审计事件是给人看的痕迹，不是进度）
  assert.ok(model.ledger.receipts.some((row) => row.stage === 'acceptance' && /已失效/.test(row.summary)))
})

test('验收清单：条目字段原样映射，未知 result 归一成 null，超 100 条标 truncated', () => {
  const items = Array.from({ length: 101 }, (_, index) => ({
    id: `A${index + 1}`,
    feature_ref: 'FR-1',
    title: `验收 ${index + 1}`,
    steps: '点新增',
    expect: '列表出现',
    result: index === 0 ? 'pass' : index === 1 ? 'weird' : null,
    evidence: index === 0 ? ['shots/a1.png'] : [],
    at: index === 0 ? '2026-11-21T00:00:00.000Z' : null,
  }))
  const model = build(
    evidence({
      acceptance: {
        items,
        empty: false,
        badJson: false,
        total: 101,
        withResult: 1,
        passed: 1,
        failed: 0,
        blocked: 0,
        passWithoutEvidence: 0,
        appliesToCurrent: true,
      },
    }),
  )
  assert.equal(model.acceptance.items.length, 100, '最多下发 100 条')
  assert.equal(model.acceptance.truncated, true)
  assert.deepEqual(model.acceptance.items[0], {
    id: 'A1',
    featureRef: 'FR-1',
    title: '验收 1',
    steps: '点新增',
    expect: '列表出现',
    result: 'pass',
    evidence: ['shots/a1.png'],
    at: '2026-11-21T00:00:00.000Z',
    stale: false,
    staleAt: null,
    staleReason: null,
    shotDiffs: [],
  })
  assert.equal(model.acceptance.items[1].result, null, '未知 result 归一成 null（未验）')
})

test('验收清单：视觉回归记录随条目下发（最近 5 条，含 reason）', () => {
  const items = [
    {
      id: 'A1',
      feature_ref: 'FR-1',
      title: '能添加客户',
      result: null,
      evidence: ['shots/a1.png'],
      shot_diffs: Array.from({ length: 7 }, (_, index) => ({
        at: `2026-11-21T00:0${index}:00.000Z`,
        verdict: index === 6 ? 'changed' : 'same',
        baseline: 'shots/a0.png',
        diffFile: index === 6 ? 'shots/diff.png' : null,
        ratio: index === 6 ? 0.42 : 0,
        changedPixels: index === 6 ? 42 : 0,
        totalPixels: 100,
      })),
    },
  ]
  const model = build(
    evidence({
      acceptance: {
        items,
        empty: false,
        badJson: false,
        total: 1,
        withResult: 0,
        passed: 0,
        failed: 0,
        blocked: 0,
        passWithoutEvidence: 0,
        appliesToCurrent: true,
      },
    }),
  )
  const diffs = model.acceptance.items[0].shotDiffs
  assert.equal(diffs.length, 5, '只下发最近 5 条')
  const latest = diffs[diffs.length - 1]
  assert.equal(latest.verdict, 'changed')
  assert.equal(latest.diffFile, 'shots/diff.png')
  assert.equal(latest.ratio, 0.42)
  assert.equal(latest.reason, null)
})

test('features：载荷形状、功能进度、未知 bug 用 known=false 表示', async () => {
  const { buildFeatureBoard, extractFeatures } = await import('../lib/features.js')
  const board = buildFeatureBoard({
    extracted: extractFeatures(['## 功能需求', '### FR-1 采集（P0）', '### FR-2 转存'].join('\n')),
    prd: { path: 'prd.md' },
    receipts: [
      receipt({ stage: 'coding', status: 'completed', feature_ids: ['FR-1'], write_scope: ['web/orders/**'] }),
      receipt({ stage: 'coding', status: 'in_progress', feature_ids: ['FR-2'] }),
    ],
    acceptance: { items: [], appliesToCurrent: true, badJson: false, missing: true, empty: true, total: 0 },
    review: { available: true, rounds: 1, blocking: 1, fixed: 0, lastRound: 1, issues: [], blockingIssues: [{ severity: 'critical', title: '按钮失效', file: 'web/orders/list.ts', line: 3 }] },
  })
  const model = build(evidence(), { features: board })

  assert.deepEqual(model.features.progress, { done: 0, total: 2 })
  assert.equal(model.features.source, 'prd')
  assert.equal(model.features.items.length, 2)
  const first = model.features.items.find((item) => item.id === 'FR-1')
  assert.equal(first.status, 'blocked')
  assert.equal(first.statusLabel, '有阻塞')
  assert.equal(first.bugs.severe, 1, '严重数用 Host 的全量值')
  assert.deepEqual(first.bugs.issues[0], { severity: 'critical', title: '按钮失效', file: 'web/orders/list.ts', line: 3 })
  const second = model.features.items.find((item) => item.id === 'FR-2')
  assert.equal(second.status, 'in-progress')
  // 没有可归属路径的功能：bug 数不可知 ⇒ known=false，界面据此显示 —。
  assert.equal(second.bugs.known, false)
})

test('features：缺省时给 prd-missing 空结构，界面不会因字段缺失崩', () => {
  const model = build(evidence())
  assert.equal(model.features.source, 'prd-missing')
  assert.deepEqual(model.features.progress, { done: 0, total: 0 })
  assert.deepEqual(model.features.items, [])
  assert.equal(model.features.unattributed.known, false)
})

test('features：未知 status 归一成 unknown（显示 —），不冒充未开始', async () => {
  const board = {
    source: 'prd',
    prdPath: 'prd.md',
    strategy: 'fr-section',
    formatHint: null,
    counts: { total: 1, done: 0, blocked: 0, inProgress: 0, pendingAcceptance: 0, notStarted: 0 },
    items: [{ id: 'FR-1', title: '采集', status: 'wat', bugs: { blocking: 0, known: false, issues: [] } }],
    unattributed: { blocking: 0, known: false, issues: [] },
    notes: [],
    warnings: [],
  }
  const model = build(evidence(), { features: board })
  assert.equal(model.features.items[0].status, 'unknown')
  assert.equal(model.features.items[0].statusLabel, '—')
})

test('总览行：形状固定，阶段名是人话，待决策与上次回执来自同一份证据', () => {
  const ev = evidence({
    receipts: {
      receipts: [receipt({ at: '2026-11-20T11:00:00.000Z' }), receipt({ stage: 'prototype', needs_human_decision: { title: '登录方式选哪种' } })],
      lastAt: '2026-11-20T11:00:00.000Z',
    },
  })

  const row = buildOverviewRow({ id: 'w1', title: '客户管理', path: ev.projectPath, evidence: ev, generatedAt: '2026-11-20T12:00:00.000Z' })
  assert.deepEqual(Object.keys(row).sort(), ROW_KEYS)
  assert.equal(row.id, 'w1')
  assert.equal(row.title, '客户管理')
  assert.equal(row.path, ev.projectPath)
  assert.equal(row.initialized, true)
  assert.equal(row.stageId, 'prototype')
  assert.equal(row.stageName, '原型设计')
  assert.equal(row.nextKind, 'decide')
  assert.match(row.nextTitle, /登录方式选哪种/)
  assert.equal(row.degraded, false)
  assert.equal(row.hasDecision, true)
  assert.equal(row.updatedAt, '2026-11-20T11:00:00.000Z')

  // 决策之后又有同迭代回执 ⇒ 不再是待决策；没有回执 ⇒ 上次更新是 null，不拿生成时间冒充。
  const settled = evidence({ receipts: { receipts: [receipt({ needs_human_decision: { title: '先选数据库' } }), receipt({ id: 'after' })] } })
  const settledRow = buildOverviewRow({ id: 'w2', path: settled.projectPath, evidence: settled, generatedAt: '2026-11-20T12:00:00.000Z' })
  assert.equal(settledRow.hasDecision, false)
  assert.equal(settledRow.updatedAt, null)
  // 标题缺省用项目目录名（确定性回退）。
  assert.equal(settledRow.title, 'shop')
})

test('详情模型：顶层形状逐字符合契约，ok 恒为 true', () => {
  const model = build(evidence())
  assert.deepEqual(Object.keys(model).sort(), DETAIL_KEYS)
  assert.equal(model.ok, true)
  assert.equal(model.generatedAt, '2026-11-20T12:00:00.000Z')
  for (const key of DETAIL_KEYS) assert.ok(key in model, `缺少字段 ${key}`)
})

test('progression：冷启动 1 + 迭代环 8，当前阶段恰好一个且是决策指向的代码开发', () => {
  const model = build(
    evidence({
      receipts: {
        receipts: [
          receipt({ stage: 'requirements', status: 'completed', summary_for_human: '需求定了' }),
          receipt({ stage: 'prototype', status: 'completed', summary_for_human: '原型过了' }),
        ],
      },
      tasks: { available: true, total: 1, open: 1, completed: 0, items: [{ id: 'T1', title: '客户列表', status: 'in_progress' }] },
    }),
  )

  assert.equal(model.progression.coldStart.length, 1)
  assert.equal(model.progression.cycle.length, 8)
  assert.deepEqual(model.progression.coldStart.map((node) => node.stageId), ['bootstrap'])
  assert.deepEqual(model.progression.cycle.map((node) => node.stageId), [
    'requirements',
    'architecture',
    'prototype',
    'implementation',
    'testing',
    'code-review',
    'acceptance',
    'release',
  ])
  assert.deepEqual(model.progression.coldStart.map((node) => node.name), ['项目立项'])
  for (const node of [...model.progression.coldStart, ...model.progression.cycle]) {
    assert.deepEqual(Object.keys(node).sort(), STAGE_NODE_KEYS)
  }

  const current = currentNodes(model)
  assert.equal(current.length, 1, `当前阶段必须恰好一个：${current.map((node) => node.stageId).join(',')}`)
  assert.equal(current[0].stageId, 'implementation')

  const cycle = model.progression.cycle
  assert.equal(cycle[0].state, 'done')
  assert.equal(cycle[0].receipt.status, 'completed')
  assert.equal(cycle[1].state, 'pending', '架构契约没有回执 ⇒ 不是 done')
  assert.equal(cycle[2].state, 'done')
  assert.equal(cycle[3].state, 'current')
  assert.equal(cycle[3].receipt, null, '没有回执的阶段 receipt 必须是 null，不编造')
  assert.equal(cycle[4].state, 'pending')
})

test('progression：有非 completed 回执时，回执优先于决策指向，仍只有一个 current', () => {
  const model = build(
    evidence({
      receipts: { receipts: [receipt({ stage: 'code-review', status: 'in_progress' })] },
      review: { available: true, rounds: 1, blocking: 0, fixed: 0 },
    }),
  )

  assert.equal(model.nextAction.kind, 'release')
  assert.equal(model.nextAction.stageId, 'release')
  const current = currentNodes(model)
  assert.equal(current.length, 1)
  assert.equal(current[0].stageId, 'code-review', '回执说在代码复核，决策指向部署发布时以回执为准')
  assert.equal(model.progression.cycle.find((node) => node.stageId === 'release').state, 'pending')
})

test('progression：冷启动阶段有回执时按 bootstrap 迭代记账（旧 init 回执也投影到 bootstrap）', () => {
  const model = build(
    evidence({
      trellis: { exists: true, rules: true, initialized: false, partial: false },
      iteration: { current: 'bootstrap', isBootstrap: true },
      receipts: {
        receipts: [
          receipt({ iteration_id: 'bootstrap', stage: 'init', status: 'in_progress', summary_for_human: '正在建' }),
        ],
      },
    }),
  )

  assert.equal(model.nextAction.kind, 'init')
  assert.equal(model.nextAction.stageId, 'bootstrap')
  assert.equal(model.progression.coldStart.length, 1)
  assert.equal(model.progression.coldStart[0].stageId, 'bootstrap')
  assert.equal(model.progression.coldStart[0].state, 'current')
  assert.equal(currentNodes(model).length, 1)
})

test('progression：整轮发布完成后 release 是 done，不会硬造第二个 current', () => {
  const model = build(evidence({ receipts: { receipts: [receipt({ stage: 'release', status: 'completed' })] } }))
  assert.equal(model.nextAction.kind, 'next-iteration')
  assert.equal(model.progression.cycle.find((node) => node.stageId === 'release').state, 'done')
  assert.ok(currentNodes(model).length <= 1, '任何情况下都不允许出现两个 current')
})

test('instruction 为 null 且缺阻断能力 ⇒ 禁用，disabledReason 取第一条 missing', () => {
  const missingMessage = '该阶段需要的技能未安装：ponytail。可以从技能市场安装，或跳过它用人工方式完成。'
  const stageCapabilities = makeStageCapabilities({
    implementation: [resolved('ponytail', { present: 'no', missingMessage }), resolved('tdd')],
  })
  const model = build(
    evidence({ tasks: { available: true, total: 1, open: 1, completed: 0 } }),
    { playbook: makePlaybook({ omit: ['implementation'] }), stageCapabilities },
  )

  assert.equal(model.nextAction.kind, 'coding')
  assert.equal(model.nextAction.instruction, null)
  assert.equal(model.nextAction.disabled, true)
  assert.equal(model.nextAction.disabledReason, missingMessage)
  assert.deepEqual(model.nextAction.missing, [{ name: 'ponytail', kind: 'skill', message: missingMessage }])
  assert.deepEqual(model.nextAction.buttons, ['copy'], '缺能力时去掉写类按钮，只留复制')
  // unknown 不是缺失，不进 missing。
  assert.equal(model.nextAction.capabilities.length, 2)
})

test('缺阻断能力时指令原文必须置空（模板存在也一样），否则复制/发送会下发注定失败的指令', () => {
  const missingMessage = '该阶段需要的技能未安装：ponytail。'
  const stageCapabilities = makeStageCapabilities({
    implementation: [resolved('ponytail', { present: 'no', missingMessage }), resolved('tdd')],
  })
  // playbook 完整（implementation 有 promptTemplate），所以指令本可以渲染出来；
  // 正因为能力缺失，它必须被压成 null。
  const model = build(evidence({ tasks: { available: true, total: 1, open: 1 } }), { stageCapabilities })

  assert.equal(model.nextAction.kind, 'coding')
  assert.equal(model.nextAction.instruction, null)
  assert.equal(model.nextAction.disabled, true)
  assert.equal(model.nextAction.disabledReason, missingMessage)
  assert.deepEqual(model.nextAction.buttons, ['copy'])
})

test('instruction 为 null 但没有缺失能力时，不误报禁用', () => {
  const model = build(evidence({ tasks: { available: true, total: 1, open: 1 } }), {
    playbook: makePlaybook({ omit: ['implementation'] }),
    stageCapabilities: makeStageCapabilities({ implementation: [] }),
  })
  assert.equal(model.nextAction.instruction, null)
  assert.equal(model.nextAction.missing.length, 0)
  assert.equal(model.nextAction.disabled, false)
})

test('buttons：复制 / 初始化 / 原型批准 / 降级时只留复制（先确认数据时为空）', () => {
  const release = build(evidence())
  assert.deepEqual(release.nextAction.buttons, ['copy'])

  const init = build(evidence({ trellis: { initialized: false } }))
  assert.equal(init.nextAction.kind, 'init')
  assert.deepEqual(init.nextAction.buttons, ['init', 'copy'])

  const prototype = build(evidence({ approval: { approved: false } }))
  assert.equal(prototype.nextAction.kind, 'prototype')
  assert.deepEqual(prototype.nextAction.buttons, ['approve', 'copy'])

  const degraded = build(evidence({ degraded: { flag: true, reasons: [{ source: 'card', message: '名片坏了' }] } }))
  assert.equal(degraded.nextAction.kind, 'confirm-data')
  assert.deepEqual(degraded.nextAction.buttons, [])
  assert.equal(degraded.nextAction.disabled, true)
  assert.equal(degraded.nextAction.instruction, null)
  assert.equal(degraded.nextAction.stageId, null)
  assert.equal(degraded.nextAction.stageName, null)
  assert.equal(degraded.nextAction.disabledReason, '名片坏了')
})

test('buttons：决策门四个 kind 各给对应动作 token（复制永远在最后）', () => {
  const unsigned = { approved: false, at: null }
  // 四门都签过（除了被测的那一门）：这样状态机才会停在对应的决策门。
  const decisions = (overrides = {}) => ({
    scope: { approved: true, at: '2026-11-22T00:00:00.000Z' },
    architecture: { approved: true, at: '2026-11-22T00:00:00.000Z' },
    acceptance: { approved: true, at: '2026-11-22T00:00:00.000Z' },
    release: { approved: true, at: '2026-11-22T00:00:00.000Z' },
    ...overrides,
  })

  const scope = build(evidence({ approval: { decisions: decisions({ scope: unsigned }) } }))
  assert.equal(scope.nextAction.kind, 'scope-approval')
  assert.deepEqual(scope.nextAction.buttons, ['approve-scope', 'copy'])

  const architecture = build(evidence({ approval: { decisions: decisions({ architecture: unsigned }) } }))
  assert.equal(architecture.nextAction.kind, 'architecture-approval')
  assert.deepEqual(architecture.nextAction.buttons, ['approve-architecture', 'copy'])

  const acceptance = build(evidence({ approval: { decisions: decisions({ acceptance: unsigned }) } }))
  assert.equal(acceptance.nextAction.kind, 'acceptance-approval')
  assert.deepEqual(acceptance.nextAction.buttons, ['approve-acceptance', 'copy'])

  const release = build(evidence({ approval: { decisions: decisions({ release: unsigned }) } }))
  assert.equal(release.nextAction.kind, 'release-approval')
  assert.deepEqual(release.nextAction.buttons, ['approve-release', 'copy'])

  // 缺能力/降级时写类按钮一律收掉：决策门按钮也不能绕过这条。
  const missingMessage = '该阶段需要的技能未安装：skill-requirements。'
  const stageCapabilities = makeStageCapabilities({ requirements: [resolved('skill-requirements', { present: 'no', missingMessage })] })
  const blocked = build(evidence({ approval: { decisions: decisions({ scope: unsigned }) } }), { stageCapabilities })
  assert.equal(blocked.nextAction.kind, 'scope-approval')
  assert.deepEqual(blocked.nextAction.buttons, ['copy'])
  assert.equal(blocked.nextAction.disabled, true)
})

test('nextAction 能力来自 stageCapabilities，指令由 playbook 模板渲染', () => {
  const stageCapabilities = makeStageCapabilities({
    release: [resolved('trellis-finish-work'), resolved('context7', { kind: 'mcp', present: 'unknown', missingMessage: null })],
  })
  const model = build(evidence(), { stageCapabilities })

  assert.equal(model.nextAction.kind, 'release')
  assert.equal(model.nextAction.stageName, '部署发布')
  // 每项在原能力字段之外多一个 advice（不覆盖原字段）；可用的必需能力 advice 为 null。
  assert.equal(model.nextAction.capabilities.length, 2)
  for (const [index, capability] of model.nextAction.capabilities.entries()) {
    const { advice, ...rest } = capability
    assert.deepEqual(rest, stageCapabilities.release[index])
    assert.ok('advice' in capability)
  }
  assert.equal(model.nextAction.capabilities[0].advice, null, 'trellis-finish-work 是 trellis-*，但 present=yes 且必需 ⇒ 不硬凑建议')
  assert.ok(model.nextAction.capabilities[1].advice, 'present=unknown 属于"不是 yes"，要给建议')
  assert.match(model.nextAction.capabilities[1].advice.fallback, /web_search/)
  assert.deepEqual(model.nextAction.missing, [], 'unknown 与 present=yes 都不算阻断')
  assert.match(model.nextAction.instruction, /trellis-finish-work/)
  assert.doesNotMatch(model.nextAction.instruction, /context7/, 'present=unknown 不进指令')
})

test('nextAction 原样透传 9 阶段元信息：method / constraint / deliverables / technicalGate / decisionGate', () => {
  const stageCapabilities = makeStageCapabilities()
  const playbook = {
    version: 2,
    stages: {
      部署发布: {
        capabilities: [{ kind: 'skill', name: 'skill-release', mode: 'full' }],
        promptTemplate: '执行【部署发布】：{capabilities}',
        method: 'trellis-finish-work',
        constraint: 'ponytail',
        deliverables: ['.dsh/plugin-state/release.json', 'dist/'],
        technicalGate: 'validateRelease',
        decisionGate: { title: '发布批准', approveAction: 'approve-release' },
      },
    },
    missingHints: {},
  }
  const model = build(evidence(), { playbook, stageCapabilities })

  assert.equal(model.nextAction.stageId, 'release')
  assert.equal(model.nextAction.method, 'trellis-finish-work')
  assert.equal(model.nextAction.constraint, 'ponytail')
  assert.deepEqual(model.nextAction.deliverables, ['.dsh/plugin-state/release.json', 'dist/'])
  assert.equal(model.nextAction.technicalGate, 'validateRelease')
  // 决策门不只透传声明，还带签核状态：没有 decisions 时 approved=false / at=null（不冒充已签）。
  assert.deepEqual(model.nextAction.decisionGate, {
    title: '发布批准',
    approveAction: 'approve-release',
    approved: false,
    at: null,
  })

  // 没有阶段/条目的动作：元信息为 null / []，不编造。
  const degraded = build(evidence({ degraded: { flag: true, reasons: [{ source: 'card', message: '坏了' }] } }))
  assert.equal(degraded.nextAction.method, null)
  assert.equal(degraded.nextAction.constraint, null)
  assert.deepEqual(degraded.nextAction.deliverables, [])
  assert.equal(degraded.nextAction.technicalGate, null)
  assert.equal(degraded.nextAction.decisionGate, null)
})

test('ledger：倒序取 20 条，total 是全量，truncated 与二者一致，坏行原样上报', () => {
  const receipts = Array.from({ length: 25 }, (_, index) =>
    receipt({
      id: `r-${index + 1}`,
      at: new Date(Date.UTC(2026, 10, 20, 10, index, 0)).toISOString(),
      stage: index % 2 === 0 ? 'implementation' : 'code-review',
      status: 'completed',
      summary_for_human: `第 ${index + 1} 条`,
      artifacts: ['a.ts'],
      used_skill_or_mcp: 'ponytail',
      task_ref: 'T1',
      write_scope: ['web/**'],
    }),
  )
  const model = build(evidence({ receipts: { receipts, badLines: 2, missing: false, lastAt: receipts[receipts.length - 1].at } }))

  assert.equal(model.ledger.receipts.length, 20)
  assert.equal(model.ledger.total, 25)
  assert.equal(model.ledger.truncated, true)
  assert.equal(model.ledger.truncated, model.ledger.total > model.ledger.receipts.length)
  assert.equal(model.ledger.badLines, 2, '坏行原样上报，不吞掉')
  assert.deepEqual(Object.keys(model.ledger.receipts[0]).sort(), LEDGER_RECEIPT_KEYS)
  assert.equal(model.ledger.receipts[0].id, 'r-25', '必须最新在上')
  assert.equal(model.ledger.receipts[19].id, 'r-6')
  assert.equal(model.ledger.receipts[0].stageName, model.ledger.receipts[0].stage === 'implementation' ? '代码开发' : '代码复核')
  assert.equal(model.ledger.receipts[0].iterationId, 'v1.0')
  assert.equal(model.ledger.receipts[0].summary, '第 25 条')
  assert.equal(model.ledger.receipts[0].usedSkill, 'ponytail')
  assert.equal(model.ledger.receipts[0].taskRef, 'T1')
  assert.deepEqual(model.ledger.receipts[0].writeScope, ['web/**'])
  assert.equal(model.ledger.receipts[0].needsDecision, null)
  for (let index = 1; index < model.ledger.receipts.length; index += 1) {
    assert.ok(model.ledger.receipts[index - 1].at >= model.ledger.receipts[index].at, '时间是倒序')
  }

  const small = build(evidence({ receipts: { receipts: [receipt({ id: 'only' })] } }))
  assert.equal(small.ledger.receipts.length, 1)
  assert.equal(small.ledger.total, 1)
  assert.equal(small.ledger.truncated, false)
})

test('ledger：待决策回执保留决策详情（标题/选项/建议）供账本置顶展示', () => {
  const decision = { title: '登录方式选哪种', options: ['手机号', '邮箱'], recommended: '手机号' }
  const model = build(evidence({ receipts: { receipts: [receipt({ needs_human_decision: decision })] } }))
  assert.deepEqual(model.ledger.receipts[0].needsDecision, decision)
})

test('review：不可用时数字保持 null（不伪造成 0），可用时 issues 最多 3 条', () => {
  const unavailable = build(
    evidence({ review: { available: false, reason: 'no-ledger', rounds: null, blocking: null, fixed: null, lastRound: null, issues: [] } }),
  )
  assert.equal(unavailable.review.available, false)
  assert.equal(unavailable.review.reason, 'no-ledger')
  assert.equal(unavailable.review.rounds, null)
  assert.equal(unavailable.review.blocking, null)
  assert.equal(unavailable.review.fixed, null)

  const issues = Array.from({ length: 5 }, (_, index) => ({ severity: 'important', title: `问题 ${index}`, file: 'a.js', line: index + 1 }))
  const available = build(evidence({ review: { available: true, reason: null, rounds: 2, blocking: 1, fixed: 1, lastRound: 2, issues } }))
  assert.equal(available.review.issues.length, 3)
  assert.equal(available.review.blocking, 1)
})

test('tasks：items 最多 20 条，总数如实保留', () => {
  const items = Array.from({ length: 25 }, (_, index) => ({ id: `T${index + 1}`, title: `任务 ${index + 1}`, status: 'completed' }))
  const model = build(evidence({ tasks: { available: true, total: 25, open: 0, completed: 25, items } }))
  assert.equal(model.tasks.items.length, 20)
  assert.equal(model.tasks.total, 25)
  assert.equal(model.tasks.completed, 25)
})

test('warnings：最多 20 条，超出部分记一句"还有 N 条"', () => {
  const warnings = Array.from({ length: 25 }, (_, index) => ({ source: `s${index}`, message: `提示 ${index}` }))
  const model = build(evidence({ warnings }))
  assert.equal(model.warnings.length, 20)
  assert.equal(model.warnings[19].source, 'warnings')
  assert.match(model.warnings[19].message, /还有 6 条/)
  assert.equal(model.warnings[0].message, '提示 0')

  const few = [{ source: 'a', message: '一' }, { source: 'b', message: '二' }]
  assert.deepEqual(build(evidence({ warnings: few })).warnings, few)
})

test('project：名片缺省用目录名，技术栈/命令/探测证据来自 evidence', () => {
  const withCard = build(
    evidence({
      card: {
        card: { name: '客户管理', oneLiner: '给小团队用的客户跟进工具' },
        status: 'filled',
        broken: false,
        missing: false,
      },
    }),
  )
  assert.equal(withCard.project.name, '客户管理')
  assert.equal(withCard.project.oneLiner, '给小团队用的客户跟进工具')
  assert.equal(withCard.project.cardStatus, 'filled')
  assert.equal(withCard.project.stack.id, 'next')
  assert.equal(withCard.project.stack.label, 'Web / Next.js')
  assert.deepEqual(withCard.project.commands, { dev: 'pnpm dev', build: 'pnpm build', previewUrl: null })
  assert.equal(withCard.project.packageManager, 'pnpm')
  assert.deepEqual(withCard.project.evidence, [{ file: 'package.json', detail: 'dependencies.next' }])
  assert.equal(withCard.project.path, 'C:\\demo\\shop')

  const noCard = build(evidence())
  assert.equal(noCard.project.name, 'shop')
  assert.equal(noCard.project.oneLiner, '')
  assert.equal(noCard.project.cardStatus, 'missing')
})

test('iteration / dataGaps / degraded 原样透传，原型批准来自当前迭代', () => {
  const reasons = [{ source: 'card', message: '名片 JSON 坏了' }]
  const dataGaps = [{ source: 'acceptance', message: '验收表属于别的迭代' }]
  const model = build(
    evidence({
      approval: { approved: true, at: '2026-11-19T22:10:00+08:00', file: 'prototype.html' },
      dataGaps,
      degraded: { flag: true, reasons },
    }),
  )

  assert.deepEqual(model.iteration.prototype, { approved: true, at: '2026-11-19T22:10:00+08:00', file: 'prototype.html' })
  assert.equal(model.iteration.current, 'v1.0')
  assert.equal(model.iteration.isBootstrap, false)
  assert.deepEqual(model.dataGaps, dataGaps)
  assert.deepEqual(model.degraded, { flag: true, reasons })
})

test('trellis 与 acceptance 计数如实投影，不把 null 变成 0', () => {
  const model = build(
    evidence({
      trellis: { exists: true, rules: false, initialized: false, ready: false, partial: true },
      acceptance: { total: null, withResult: null, passed: null, failed: null, blocked: null, empty: false, badJson: false },
    }),
  )
  assert.deepEqual(model.trellis, { exists: true, rules: false, initialized: false, ready: false, partial: true })
  assert.equal(model.acceptance.total, null)
  assert.equal(model.acceptance.passed, null)
  assert.equal(model.acceptance.empty, false)
  assert.equal(model.acceptance.badJson, false)
})

test('gates：技术门只读投影（ok/missing/reason/detail），无 gates 时为 null', () => {
  const model = build(
    evidence({
      gates: {
        architecture: { available: false, ok: false, missing: ['docs/architecture.md'], reason: 'missing' },
        tests: { available: true, ok: false, missing: ['failed>0（2 个失败）'], reason: 'failed', detail: { failed: 2 } },
        release: null,
      },
    }),
  )
  assert.deepEqual(model.gates.architecture, {
    available: false,
    ok: false,
    missing: ['docs/architecture.md'],
    reason: 'missing',
    detail: null,
  })
  assert.equal(model.gates.tests.ok, false)
  assert.equal(model.gates.tests.detail.failed, 2)
  assert.equal(model.gates.release, null)

  const noGates = build(evidence())
  assert.equal(noGates.gates, null, '没有 gates 时返回 null，客户端不渲染门禁块')
})
test('stages：9 阶段只读详情（元信息/门禁/能力/最近记录），不回写状态机', async () => {
  const gates = {
    architecture: { available: false, ok: false, missing: ['docs/architecture.md'], reason: 'missing' },
    tests: { available: true, ok: true, missing: [], reason: null, detail: { command: 'node --test', passed: 1, failed: 0, at: '2026-11-22T00:00:00.000Z' } },
    release: { available: false, ok: false, missing: ['.dsh/plugin-state/release.json'], reason: 'missing' },
  }
  const { readFile } = await import('node:fs/promises')
  const builtin = JSON.parse(await readFile(new URL('../templates/playbook.json', import.meta.url), 'utf8'))
  const model = build(
    evidence({
      gates,
      receipts: { receipts: [receipt({ stage: 'coding', used_skill_or_mcp: 'tdd-loop', task_ref: 'T1' })], badLines: 0, missing: false, lastAt: null },
    }),
    { playbook: builtin },
  )
  assert.equal(model.stages.length, 9)
  const architecture = model.stages.find((stage) => stage.id === 'architecture')
  assert.equal(architecture.name, '架构契约')
  assert.equal(architecture.cycle, true)
  assert.equal(architecture.method, null)
  assert.equal(architecture.constraint, 'ponytail')
  assert.deepEqual(architecture.deliverables, ['docs/architecture.md', 'docs/api.md'])
  assert.equal(architecture.technicalGate, 'validateArchitecture')
  assert.equal(architecture.gate.ok, false)
  assert.deepEqual(architecture.gate.missing, ['docs/architecture.md'])
  assert.equal(architecture.decisionGate.title, '架构签核')
  assert.equal(architecture.decisionGate.approved, false, '没有 decisions 时按未签处理')
  assert.equal(architecture.decisionGate.at, null)

  const testing = model.stages.find((stage) => stage.id === 'testing')
  assert.equal(testing.gate.ok, true)

  const implementation = model.stages.find((stage) => stage.id === 'implementation')
  assert.equal(implementation.receipts.count, 1, '旧 stage coding 归一到 implementation')
  assert.equal(implementation.receipts.items[0].usedSkill, 'tdd-loop')

  const bootstrap = model.stages.find((stage) => stage.id === 'bootstrap')
  assert.equal(bootstrap.cycle, false)
  assert.equal(bootstrap.capabilities[0].present, 'yes')
  // 合成能力 present=yes 且非 optional：不给建议（advice=null），不硬凑安装指路。
  assert.equal(bootstrap.capabilities[0].advice, null)
  assert.equal(model.stages.find((stage) => stage.id === 'implementation').capabilities[0].present, 'yes')
  // 能力存在性透传 yes/no/unknown，不能折成 unknown
})

test('签核状态：阶段详情与 hero 的 decisionGate 带 approved/at（来源 decisions / 原型批准）', () => {
  const playbook = {
    version: 2,
    stages: {
      需求定义: { decisionGate: { title: '范围签核', approveAction: 'approve-scope' } },
      架构契约: { decisionGate: { title: '架构签核', approveAction: 'approve-architecture' } },
      原型设计: { decisionGate: { title: '原型通过', approveAction: 'approve-prototype' } },
      验收确认: { decisionGate: { title: '验收签核', approveAction: 'approve-acceptance' } },
      部署发布: { decisionGate: { title: '发布批准', approveAction: 'approve-release' } },
    },
    missingHints: {},
  }
  const decisions = {
    scope: { approved: true, at: '2026-11-20T22:20:00+08:00' },
    architecture: { approved: true, at: '2026-11-20T22:30:00+08:00' },
    acceptance: { approved: true, at: '2026-11-21T10:00:00+08:00' },
    release: { approved: true, at: '2026-11-21T18:00:00+08:00' },
  }
  const ev = evidence({
    approval: { approved: true, at: '2026-11-20T22:10:00+08:00', file: 'prototype.html', decisions },
    receipts: { receipts: [receipt({ stage: 'release', status: 'completed', summary_for_human: '发布完成' })] },
  })
  const model = build(ev, { playbook })
  const stage = (id) => model.stages.find((item) => item.id === id)

  assert.deepEqual(stage('requirements').decisionGate, {
    title: '范围签核',
    approveAction: 'approve-scope',
    approved: true,
    at: '2026-11-20T22:20:00+08:00',
  })
  // 原型批准不在 decisions 里：必须读 approval 自身，不能因为 decisions 没 prototype 键就报"未签"。
  assert.deepEqual(stage('prototype').decisionGate, {
    title: '原型通过',
    approveAction: 'approve-prototype',
    approved: true,
    at: '2026-11-20T22:10:00+08:00',
  })
  assert.equal(stage('architecture').decisionGate.approved, true)
  assert.equal(stage('architecture').decisionGate.at, '2026-11-20T22:30:00+08:00')
  assert.equal(stage('acceptance').decisionGate.at, '2026-11-21T10:00:00+08:00')

  // decisions 明确说这一门没签：不能被"条目存在"冒充成已签。
  const unsignedArchitecture = build(
    evidence({ approval: { decisions: { ...decisions, architecture: { approved: false, at: null } } } }),
    { playbook },
  )
  assert.equal(unsignedArchitecture.stages.find((item) => item.id === 'architecture').decisionGate.approved, false)

  // 整轮已发布：hero 停在部署发布，此时发布门已签 ⇒ hero 的 decisionGate 也是已签。
  assert.equal(model.nextAction.stageId, 'release')
  assert.equal(model.nextAction.decisionGate.approved, true)
  assert.equal(model.nextAction.decisionGate.at, '2026-11-21T18:00:00+08:00')

  // decisions 整体缺失（旧数据 / 手写夹具）：每门 approved=false、at=null，不冒充已签。
  const legacy = build(evidence({ approval: { decisions: null } }), { playbook })
  assert.deepEqual(legacy.stages.find((item) => item.id === 'requirements').decisionGate, {
    title: '范围签核',
    approveAction: 'approve-scope',
    approved: false,
    at: null,
  })
})

test('stages：能力附 advice（缺失/可选才给，未知能力不编造）', async () => {
  const { readFile } = await import('node:fs/promises')
  const builtin = JSON.parse(await readFile(new URL('../templates/playbook.json', import.meta.url), 'utf8'))
  const stageCapabilities = makeStageCapabilities({
    architecture: [
      resolved('ponytail'),
      resolved('context7', { kind: 'mcp', optional: true, present: 'no' }),
    ],
    prototype: [
      resolved('frontend-design', { present: 'no' }),
      resolved('playwright', { kind: 'mcp', optional: true, present: 'yes' }),
      resolved('mystery-skill', { present: 'no' }),
    ],
  })
  const model = build(evidence(), { playbook: builtin, stageCapabilities })

  const architecture = model.stages.find((stage) => stage.id === 'architecture')
  assert.equal(architecture.capabilities[0].advice, null, '已装且必需：不需要建议')
  assert.match(architecture.capabilities[1].advice.fallback, /web_search/)
  assert.deepEqual(architecture.capabilities[1].advice.install, [
    { label: 'Context7 MCP', url: 'https://github.com/upstash/context7' },
  ])

  const prototype = model.stages.find((stage) => stage.id === 'prototype')
  assert.ok(prototype.capabilities[0].advice.install, '缺失的已知能力给安装建议')
  assert.ok(prototype.capabilities[1].advice, 'optional 即便 present=yes 也给替代/说明')
  assert.equal(prototype.capabilities[2].advice, null, '未知能力不编造')
})

test('team：只读投影（无输入 not-read / 服务缺失 / 正常 / 截断）', () => {
  assert.deepEqual(teamSection(), { available: false, reason: 'not-read', agents: [] })
  assert.deepEqual(teamSection(null), { available: false, reason: 'not-read', agents: [] })
  assert.deepEqual(teamSection({ available: false, reason: 'service-missing', agents: [] }), {
    available: false,
    reason: 'service-missing',
    agents: [],
  })

  const model = build(evidence(), {
    team: {
      available: true,
      reason: null,
      truncated: false,
      agents: [
        { id: 's1', name: 'lead', parentName: null, depth: 0, preset: null, origin: 'root', createdAt: '2026-11-20T10:00:00.000Z', running: true },
        { id: 's2', name: 'reviewer', parentName: 'lead', depth: 1, preset: 'review', origin: 'subagent', createdAt: '2026-11-20T10:01:00.000Z', running: false, extra: 'x' },
      ],
    },
  })
  assert.deepEqual(model.team, {
    available: true,
    reason: null,
    truncated: false,
    agents: [
      { id: 's1', name: 'lead', parentName: null, depth: 0, preset: null, origin: 'root', createdAt: '2026-11-20T10:00:00.000Z', running: true },
      { id: 's2', name: 'reviewer', parentName: 'lead', depth: 1, preset: 'review', origin: 'subagent', createdAt: '2026-11-20T10:01:00.000Z', running: false },
    ],
  })

  // 没传 team（旧 Host / 服务没接线）：详情里是 not-read，不崩。
  assert.deepEqual(build(evidence()).team, { available: false, reason: 'not-read', agents: [] })

  const many = {
    available: true,
    reason: null,
    agents: Array.from({ length: 25 }, (_, index) => ({ id: `s${index}`, name: `n${index}`, depth: 0, running: false })),
  }
  const capped = teamSection(many)
  assert.equal(capped.agents.length, 20)
  assert.equal(capped.truncated, true)
})

test('交付指标（P3）：metrics 透传；缺省为 null；0 与 null 严格区分', () => {
  const none = build(evidence())
  assert.equal(none.metrics, null, 'Host 没算指标时为 null，客户端据此不渲染指标模块')

  const metrics = {
    generatedAt: '2026-11-20T12:00:00.000Z',
    windowDays: 30,
    metrics: {
      leadTimeHours: { value: 6.5, unit: 'hours', sample: 2, definition: '口径', source: 'receipts' },
      deploymentFrequency7d: { value: 0, unit: 'releases', sample: 0, definition: '口径', source: 'receipts' },
      changeFailureRate: { value: null, unit: 'ratio', sample: 0, definition: '口径', source: 'review-history' },
      reviewFixHours: { value: 3, unit: 'hours', sample: 1, definition: '口径', source: 'review-history+dispositions' },
      acceptanceRate: { value: 0.5, unit: 'ratio', sample: 2, definition: '口径', source: 'acceptance' },
      blockingInventory: { value: 2, unit: 'items', sample: 2, definition: '口径', source: 'review+acceptance' },
    },
    unavailable: [{ metric: 'changeFailureRate', reason: '近 30 天没有可判定的检查轮次' }],
  }
  const model = build(evidence(), { metrics })
  assert.equal(model.metrics.windowDays, 30)
  assert.equal(model.metrics.generatedAt, '2026-11-20T12:00:00.000Z')
  assert.equal(model.metrics.metrics.leadTimeHours.value, 6.5)
  assert.equal(model.metrics.metrics.deploymentFrequency7d.value, 0, '0 是合法值，不能抹成 null')
  assert.equal(model.metrics.metrics.changeFailureRate.value, null, '数据不足保持 null')
  assert.equal(model.metrics.metrics.leadTimeHours.definition, '口径')
  assert.equal(model.metrics.metrics.leadTimeHours.sample, 2)
  assert.deepEqual(model.metrics.unavailable, [
    { metric: 'changeFailureRate', reason: '近 30 天没有可判定的检查轮次' },
  ])
  assert.deepEqual(Object.keys(model.metrics.metrics), [
    'leadTimeHours',
    'deploymentFrequency7d',
    'changeFailureRate',
    'reviewFixHours',
    'acceptanceRate',
    'blockingInventory',
    'mttrHours',
  ])

  // 缺项给 null；库存类即使 value=null 也按 0（与 metrics.js 一致：0 是合法值）。
  const partial = build(evidence(), {
    metrics: {
      windowDays: 7,
      metrics: { blockingInventory: { value: null, unit: 'items', sample: 0 } },
      unavailable: [{ metric: 'blockingInventory', reason: '检查与验收都还没读到' }],
    },
  })
  assert.equal(partial.metrics.windowDays, 7)
  assert.equal(partial.metrics.metrics.blockingInventory.value, null, 'model 不再把库存 null 强转 0')
  assert.equal(partial.metrics.metrics.leadTimeHours, null)
  assert.deepEqual(partial.metrics.unavailable, [{ metric: 'blockingInventory', reason: '检查与验收都还没读到' }])
})

test('总览行也尊重 workflow.requireArchitectureGate=false（不能详情跳过、总览还挡）', () => {
  const ev = evidence({
    workflow: { requireArchitectureGate: false },
    gates: {
      architecture: { available: false, ok: false, missing: ['docs/architecture.md'], gate: 'architecture', reason: 'missing' },
      tests: { available: true, ok: true, missing: [], gate: 'tests' },
      release: { available: false, ok: false, missing: ['.dsh/plugin-state/release.json'], gate: 'release', reason: 'missing' },
    },
    tasks: { available: true, total: 1, open: 0, completed: 1, items: [{ id: 'T1', title: 'x', status: 'completed' }] },
    review: { available: false, reason: 'no-ledger', rounds: null, blocking: null, fixed: null, lastRound: null, issues: [] },
    acceptance: { items: [], empty: true, total: 0, withResult: 0, passed: 0, failed: 0, blocked: 0, stale: 0, passWithoutEvidence: 0, appliesToCurrent: true },
  })
  const row = buildOverviewRow({ id: 'w', title: 'demo', path: 'C:/demo', evidence: ev })
  assert.notEqual(row.nextKind, 'architecture')
})
test('评审器投影：旧别名 agent/model 与坏 profile 的 source 口径', () => {
  const legacy = build(evidence(), { reviewSettings: { agent: 'agy', model: 'gemini-4-hydrogen-high', agyProxy: '', source: 'config' } })
  assert.equal(legacy.review.settings.agent, 'agy')
  assert.equal(legacy.review.settings.model, 'gemini-4-hydrogen-high')

  const untouched = build(evidence())
  assert.equal(untouched.review.settings.agent, 'claude')
  assert.equal(untouched.review.settings.source, 'config')
})