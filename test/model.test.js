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

import { buildDetailModel, buildOverviewRow } from '../lib/model.js'
import { STAGE_DEFS } from '../lib/playbook.js'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const DETAIL_KEYS = [
  'acceptance',
  'dataGaps',
  'degraded',
  'generatedAt',
  'iteration',
  'ledger',
  'nextAction',
  'ok',
  'progression',
  'project',
  'review',
  'tasks',
  'trellis',
  'warnings',
]

const ROW_KEYS = ['degraded', 'hasDecision', 'id', 'initialized', 'nextKind', 'nextTitle', 'path', 'stageId', 'stageName', 'title', 'updatedAt']

const LEDGER_RECEIPT_KEYS = [
  'artifacts',
  'at',
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
  })
}

const currentNodes = (model) => [...model.progression.coldStart, ...model.progression.cycle].filter((node) => node.state === 'current')

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
  assert.equal(row.stageName, '看原型')
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

test('progression：冷启动 2 + 迭代环 6，当前阶段恰好一个且是决策指向的写代码', () => {
  const model = build(
    evidence({
      receipts: {
        receipts: [
          receipt({ stage: 'brainstorm', status: 'completed', summary_for_human: '需求定了' }),
          receipt({ stage: 'prototype', status: 'completed', summary_for_human: '原型过了' }),
        ],
      },
      tasks: { available: true, total: 1, open: 1, completed: 0, items: [{ id: 'T1', title: '客户列表', status: 'in_progress' }] },
    }),
  )

  assert.equal(model.progression.coldStart.length, 2)
  assert.equal(model.progression.cycle.length, 6)
  assert.deepEqual(model.progression.coldStart.map((node) => node.stageId), ['init', 'scaffold'])
  assert.deepEqual(model.progression.cycle.map((node) => node.stageId), ['brainstorm', 'prototype', 'coding', 'code_review', 'verification', 'release'])
  assert.deepEqual(model.progression.coldStart.map((node) => node.name), ['初始化', '搭骨架'])
  for (const node of [...model.progression.coldStart, ...model.progression.cycle]) {
    assert.deepEqual(Object.keys(node).sort(), STAGE_NODE_KEYS)
  }

  const current = currentNodes(model)
  assert.equal(current.length, 1, `当前阶段必须恰好一个：${current.map((node) => node.stageId).join(',')}`)
  assert.equal(current[0].stageId, 'coding')

  const cycle = model.progression.cycle
  assert.equal(cycle[0].state, 'done')
  assert.equal(cycle[0].receipt.status, 'completed')
  assert.equal(cycle[1].state, 'done')
  assert.equal(cycle[2].state, 'current')
  assert.equal(cycle[2].receipt, null, '没有回执的阶段 receipt 必须是 null，不编造')
  assert.equal(cycle[3].state, 'pending')
})

test('progression：有非 completed 回执时，回执优先于决策指向，仍只有一个 current', () => {
  const model = build(
    evidence({
      receipts: { receipts: [receipt({ stage: 'code_review', status: 'in_progress' })] },
      review: { available: true, rounds: 1, blocking: 0, fixed: 0 },
    }),
  )

  assert.equal(model.nextAction.kind, 'release')
  assert.equal(model.nextAction.stageId, 'release')
  const current = currentNodes(model)
  assert.equal(current.length, 1)
  assert.equal(current[0].stageId, 'code_review', '回执说在挑毛病，决策指向发出去时以回执为准')
  assert.equal(model.progression.cycle.find((node) => node.stageId === 'release').state, 'pending')
})

test('progression：冷启动阶段有回执时按 bootstrap 迭代记账', () => {
  const model = build(
    evidence({
      trellis: { exists: true, rules: true, initialized: false, partial: false },
      iteration: { current: 'bootstrap', isBootstrap: true },
      receipts: {
        receipts: [
          receipt({ iteration_id: 'bootstrap', stage: 'init', status: 'completed' }),
          receipt({ iteration_id: 'bootstrap', stage: 'scaffold', status: 'in_progress' }),
        ],
      },
    }),
  )

  assert.equal(model.nextAction.kind, 'init')
  assert.equal(model.progression.coldStart[0].state, 'done')
  assert.equal(model.progression.coldStart[1].state, 'current')
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
    coding: [resolved('ponytail', { present: 'no', missingMessage }), resolved('tdd')],
  })
  const model = build(
    evidence({ tasks: { available: true, total: 1, open: 1, completed: 0 } }),
    { playbook: makePlaybook({ omit: ['coding'] }), stageCapabilities },
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
    coding: [resolved('ponytail', { present: 'no', missingMessage }), resolved('tdd')],
  })
  // playbook 完整（coding 有 promptTemplate），所以指令本可以渲染出来；
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
    playbook: makePlaybook({ omit: ['coding'] }),
    stageCapabilities: makeStageCapabilities({ coding: [] }),
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

test('nextAction 能力来自 stageCapabilities，指令由 playbook 模板渲染', () => {
  const stageCapabilities = makeStageCapabilities({
    release: [resolved('finishing-a-development-branch'), resolved('trellis-finish-work'), resolved('context7', { kind: 'mcp', present: 'unknown', missingMessage: null })],
  })
  const model = build(evidence(), { stageCapabilities })

  assert.equal(model.nextAction.kind, 'release')
  assert.equal(model.nextAction.stageName, '发出去')
  assert.deepEqual(model.nextAction.capabilities, stageCapabilities.release)
  assert.deepEqual(model.nextAction.missing, [], 'unknown 与 present=yes 都不算阻断')
  assert.match(model.nextAction.instruction, /finishing-a-development-branch/)
  assert.match(model.nextAction.instruction, /trellis-finish-work/)
  assert.doesNotMatch(model.nextAction.instruction, /context7/, 'present=unknown 不进指令')
})

test('ledger：倒序取 20 条，total 是全量，truncated 与二者一致，坏行原样上报', () => {
  const receipts = Array.from({ length: 25 }, (_, index) =>
    receipt({
      id: `r-${index + 1}`,
      at: new Date(Date.UTC(2026, 10, 20, 10, index, 0)).toISOString(),
      stage: index % 2 === 0 ? 'coding' : 'code_review',
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
  assert.equal(model.ledger.receipts[0].stageName, model.ledger.receipts[0].stage === 'coding' ? '写代码' : '挑毛病')
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
      trellis: { exists: true, rules: false, initialized: false, partial: true },
      acceptance: { total: null, withResult: null, passed: null, failed: null, blocked: null, empty: false, badJson: false },
    }),
  )
  assert.deepEqual(model.trellis, { exists: true, rules: false, initialized: false, partial: true })
  assert.equal(model.acceptance.total, null)
  assert.equal(model.acceptance.passed, null)
  assert.equal(model.acceptance.empty, false)
  assert.equal(model.acceptance.badJson, false)
})
