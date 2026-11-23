/**
 * 状态机单测：14 条优先级每条至少一个用例，外加"降级压过一切""待决策与 status 无关"
 * "有原型零任务给拆任务"这几条容易写错的边界。
 *
 * 全部用手写 evidence 夹具：状态机是纯函数，不需要真读盘；这样每条用例只变化
 * 影响判定的那一个字段，失败时能直接指向规则编号。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { deriveDecision } from '../lib/state.js'

const DECISION_KEYS = ['disabled', 'disabledReason', 'kind', 'notes', 'priority', 'reason', 'stageId', 'title']

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

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

/** 默认是"该做的都做了、只差发布"：这样每条用例只需覆盖触发规则的那一块。 */
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
      evidence: [],
      notes: [],
    },
    receipts: { receipts: [], badLines: 0, missing: false, lastAt: null },
    iteration: { current: 'v1.0', isBootstrap: false, approvals: { map: {}, badJson: false, missing: false } },
    approval: { approved: true, at: '2026-11-20T10:00:00.000Z', file: 'prototype.html' },
    acceptance: passAcceptance(),
    tasks: { available: true, total: 1, open: 0, completed: 1, items: [{ id: 'T1', title: '客户列表', status: 'completed' }] },
    review: { available: true, reason: null, rounds: 1, blocking: 0, fixed: 0, lastRound: 1, issues: [] },
    gates: {
      architecture: { available: true, ok: true, missing: [], gate: 'architecture' },
      tests: { available: true, ok: true, missing: [], gate: 'tests' },
      release: { available: true, ok: true, missing: [], gate: 'release' },
    },
    warnings: [],
    dataGaps: [],
    degraded: { flag: false, reasons: [] },
    generatedAt: '2026-11-20T10:00:00.000Z',
  }
}

/** 浅合并顶层 + 对固定几个对象字段做一层合并，让用例只写变化的那一段。 */
function evidence(patch = {}) {
  const base = baseEvidence()
  const merged = { ...base, ...patch }
  for (const key of ['trellis', 'prd', 'approval', 'tasks', 'review', 'acceptance', 'iteration', 'receipts', 'degraded']) {
    if (isObject(patch[key])) merged[key] = { ...base[key], ...patch[key] }
  }
  return merged
}

const receipt = (overrides = {}) => ({
  id: 'r-1',
  at: '2026-11-20T10:00:00.000Z',
  iteration_id: 'v1.0',
  stage: 'brainstorm',
  status: 'completed',
  summary_for_human: '需求收敛成 prd.md',
  ...overrides,
})

/** 四个决策门默认都签过；用例只改需要卡住的那一门。 */
const decisions = (overrides = {}) => ({
  scope: { approved: true, at: '2026-11-22T00:00:00.000Z' },
  architecture: { approved: true, at: '2026-11-22T00:00:00.000Z' },
  acceptance: { approved: true, at: '2026-11-22T00:00:00.000Z' },
  release: { approved: true, at: '2026-11-22T00:00:00.000Z' },
  ...overrides,
})
const unsigned = () => ({ approved: false, at: null })

function assertHumanLine(decision) {
  assert.deepEqual(Object.keys(decision).sort(), DECISION_KEYS, '返回形状必须逐字符合契约')
  assert.equal(typeof decision.title, 'string')
  assert.ok([...decision.title].length > 0 && [...decision.title].length <= 20, `标题要短：${decision.title}`)
  assert.equal(typeof decision.reason, 'string')
  assert.ok([...decision.reason].length > 0 && [...decision.reason].length <= 40, `理由要短：${decision.reason}`)
  assert.ok(!/`|\bconst\b|=>/.test(decision.title + decision.reason), `人话里不该有代码：${decision.title}`)
  assert.ok(Array.isArray(decision.notes))
  assert.equal(typeof decision.disabled, 'boolean')
  assert.ok(decision.disabledReason === null || typeof decision.disabledReason === 'string')
}

function decide(patch) {
  const decision = deriveDecision(evidence(patch))
  assertHumanLine(decision)
  return decision
}

test('优先级 1：降级压过一切，给先确认数据并禁用主按钮', () => {
  const decision = decide({
    degraded: { flag: true, reasons: [{ source: 'card', message: '名片读取失败' }] },
    // 下面这些本来都会命中别的规则：待决策、未初始化、验收表为空 —— 都必须让位给降级。
    receipts: {
      receipts: [receipt({ stage: 'prototype', needs_human_decision: { title: '登录方式选哪种' } })],
    },
    trellis: { initialized: false },
    acceptance: { empty: true, items: [], total: 0, withResult: 0, passed: 0 },
  })

  assert.equal(decision.priority, 1)
  assert.equal(decision.kind, 'confirm-data')
  assert.equal(decision.stageId, null)
  assert.equal(decision.title, '先确认数据')
  assert.equal(decision.disabled, true)
  assert.match(decision.disabledReason, /名片读取失败/)
  assert.deepEqual(decision.notes, [])
})

test('优先级 2：待人工决策最高优，title 用回执里的标题与阶段', () => {
  const decision = decide({
    receipts: {
      receipts: [
        receipt({
          stage: 'prototype',
          needs_human_decision: { title: '登录方式选哪种', options: ['手机号', '邮箱'], recommended: '手机号' },
        }),
      ],
    },
    // 下面这些本来会命中"拆任务/验效果"，但待决策必须排在它们前面。
    tasks: { open: 0, total: 0, completed: 0, items: [] },
    acceptance: { empty: true, items: [], total: 0, withResult: 0, passed: 0 },
  })

  assert.equal(decision.priority, 2)
  assert.equal(decision.kind, 'decide')
  assert.equal(decision.stageId, 'prototype')
  assert.match(decision.title, /登录方式选哪种/)
  assert.equal(decision.disabled, false)
})

test('待决策与回执 status 无关：五种 status 都给出同一动作', () => {
  for (const status of ['in_progress', 'completed', 'blocked', 'failed', 'dropped']) {
    const decision = decide({
      receipts: { receipts: [receipt({ status, needs_human_decision: { title: '要不要先做导出' } })] },
    })
    assert.equal(decision.kind, 'decide', `status=${status} 时待决策仍应最高优`)
    assert.equal(decision.priority, 2)
    assert.equal(decision.stageId, 'requirements')
  }
})

test('待决策标题过长或带代码记号时收成人话', () => {
  const decision = decide({
    receipts: {
      receipts: [receipt({ needs_human_decision: { title: '`login` 到底选手机号还是邮箱登录最稳妥' } })],
    },
  })
  assert.equal(decision.kind, 'decide')
  assert.ok([...decision.title].length <= 20)
  assert.ok(!decision.title.includes('`'))
})

test('待决策的 stage 也归一：旧 code_review / coding 投影成 canonical id', () => {
  for (const [legacy, canonical] of [
    ['code_review', 'code-review'],
    ['coding', 'implementation'],
    ['verification', 'acceptance'],
  ]) {
    const decision = decide({
      receipts: { receipts: [receipt({ stage: legacy, needs_human_decision: { title: '要不要继续' } })] },
    })
    assert.equal(decision.stageId, canonical, `${legacy} 应投影为 ${canonical}`)
  }
})

test('优先级 3：未初始化给初始化；只初始化一半时把原因写进 notes', () => {
  for (const trellis of [
    { exists: false, rules: false, initialized: false, partial: false },
    { exists: true, rules: true, initialized: false, partial: true },
  ]) {
    const decision = decide({ trellis })
    assert.equal(decision.priority, 3)
    assert.equal(decision.kind, 'init')
    assert.equal(decision.stageId, 'bootstrap')
  }
  const partial = decide({ trellis: { initialized: false, partial: true } })
  assert.ok(partial.notes.some((note) => note.includes('只存在其中一个')))
})

test('优先级 4：没有 prd 先想清楚', () => {
  const decision = decide({ prd: { found: false, path: null } })
  assert.equal(decision.priority, 4)
  assert.equal(decision.kind, 'brainstorm')
  assert.equal(decision.stageId, 'requirements')
})

test('优先级 5：当前迭代没有原型批准，停在看原型', () => {
  const decision = decide({ approval: { approved: false, at: null, file: null } })
  assert.equal(decision.priority, 5)
  assert.equal(decision.kind, 'prototype')
  assert.equal(decision.stageId, 'prototype')
})

test('优先级 6：有未完成任务就继续写代码', () => {
  const decision = decide({ tasks: { available: true, open: 2, total: 2, completed: 0 } })
  assert.equal(decision.priority, 6)
  assert.equal(decision.kind, 'coding')
  assert.equal(decision.stageId, 'implementation')
  assert.match(decision.reason, /2 个/)
})

test('优先级 7：有原型但一条任务都没有 ⇒ 先拆任务（不是写代码）', () => {
  const decision = decide({
    approval: { approved: true },
    tasks: { available: true, total: 0, open: 0, completed: 0, items: [] },
    // 审核账本为空会命中"第一次审核"；任务规则必须排在它前面。
    review: { available: true, rounds: 0, blocking: 0, fixed: 0 },
  })
  assert.equal(decision.priority, 7)
  assert.equal(decision.kind, 'coding')
  assert.equal(decision.stageId, 'implementation')
  assert.match(decision.title, /拆任务/)
})

test('优先级 8：审核有未处置 blocking ⇒ 先修', () => {
  const decision = decide({ review: { available: true, blocking: 3, fixed: 1, rounds: 2 } })
  assert.equal(decision.priority, 8)
  assert.equal(decision.kind, 'fix-blocking')
  assert.equal(decision.stageId, 'code-review')
})

test('优先级 9：有已修问题待复检 ⇒ 复核', () => {
  const decision = decide({ review: { available: true, blocking: 0, fixed: 2, rounds: 2 } })
  assert.equal(decision.priority, 9)
  assert.equal(decision.kind, 'recheck')
  assert.equal(decision.stageId, 'code-review')
})

test('优先级 10：从未审核 ⇒ 第一次审核', () => {
  const decision = decide({ review: { available: true, rounds: 0, blocking: 0, fixed: 0 } })
  assert.equal(decision.priority, 10)
  assert.equal(decision.kind, 'first-review')
  assert.equal(decision.stageId, 'code-review')
})

test('审核账本不可用：跳过 8/9/10，并留下"跳过"的痕迹', () => {
  const decision = decide({
    review: { available: false, reason: 'no-ledger', rounds: null, blocking: null, fixed: null },
    acceptance: { empty: true, items: [], total: 0, withResult: 0, passed: 0 },
  })
  assert.equal(decision.kind, 'acceptance-draft')
  assert.ok(decision.notes.includes('未接审核账本，跳过挑毛病判定'))
  assert.equal(decision.disabled, false)

  const done = decide({
    review: { available: false, reason: 'no-ledger', rounds: null, blocking: null, fixed: null },
    receipts: { receipts: [receipt({ stage: 'release', status: 'completed' })] },
  })
  assert.equal(done.kind, 'next-iteration')
  // 已发布迭代直接开下一轮，不再进入审核判定，因此没有跳过审核的 note
})

test('优先级 11：验收表为空 ⇒ 生成验收清单', () => {
  const decision = decide({
    acceptance: {
      items: [],
      empty: true,
      total: 0,
      withResult: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      passWithoutEvidence: 0,
      appliesToCurrent: true,
    },
  })
  assert.equal(decision.priority, 11)
  assert.equal(decision.kind, 'acceptance-draft')
  assert.equal(decision.stageId, 'acceptance')
})

test('优先级 12：验收表非空未全绿 ⇒ 去验效果', () => {
  const decision = decide({
    acceptance: {
      items: [{ id: 'A1', title: '能添加客户', result: null, evidence: [] }],
      empty: false,
      total: 1,
      withResult: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      passWithoutEvidence: 0,
      appliesToCurrent: true,
    },
  })
  assert.equal(decision.priority, 12)
  assert.equal(decision.kind, 'verification')
  assert.equal(decision.stageId, 'acceptance')

  const failed = decide({
    acceptance: {
      items: [{ id: 'A1', title: '能添加客户', result: 'fail', evidence: ['shots/fail.png'] }],
      empty: false,
      total: 1,
      withResult: 1,
      passed: 0,
      failed: 1,
      blocked: 0,
      passWithoutEvidence: 0,
      appliesToCurrent: true,
    },
  })
  assert.equal(failed.priority, 12)
  assert.match(failed.reason, /没通过/)
})

test('pass 没证据不算通过：passWithoutEvidence > 0 时仍去验效果', () => {
  const decision = decide({
    acceptance: {
      // 条目层面看起来都有证据，但 evidence 层的 passWithoutEvidence 说有一条 pass 没证据；
      // 这种情况必须不通过（宁可多验一次，也不给假绿灯）。
      items: [{ id: 'A1', title: '能添加客户', result: 'pass', evidence: ['shots/a.png'] }],
      empty: false,
      total: 2,
      withResult: 2,
      passed: 2,
      failed: 0,
      blocked: 0,
      passWithoutEvidence: 1,
      appliesToCurrent: true,
    },
  })
  assert.equal(decision.priority, 12)
  assert.equal(decision.kind, 'verification')
  assert.match(decision.reason, /没证据/)
})

test('验收表属于别的迭代：不参与通过判定，也不给绿灯', () => {
  const decision = decide({
    acceptance: {
      items: [],
      empty: false,
      total: 0,
      withResult: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      passWithoutEvidence: 0,
      appliesToCurrent: false,
    },
  })
  assert.equal(decision.priority, 12)
  assert.equal(decision.kind, 'verification')
  assert.match(decision.reason, /别的迭代/)
})

test('优先级 12：截图变化让已通过的验收失效 ⇒ 回到验效果，并点名"失效"', () => {
  const decision = decide({
    acceptance: {
      items: [{ id: 'A1', title: '能添加客户', result: 'pass', evidence: ['shots/a1.png'], stale: true }],
      empty: false,
      badJson: false,
      missing: false,
      total: 1,
      withResult: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      stale: 1,
      passWithoutEvidence: 0,
      appliesToCurrent: true,
    },
  })
  assert.equal(decision.kind, 'verification')
  assert.equal(decision.stageId, 'acceptance')
  assert.match(decision.reason, /截图变化失效/)
})

test('验收全绿但条目带 stale（与汇总不一致的防御）：仍然不许发出去', () => {
  // 就算 counts 被误写成"全绿"，条目层有 stale 也不能放行——宁可多验一次，也不给假绿灯。
  const decision = decide({
    acceptance: {
      items: [{ id: 'A1', title: '能添加客户', result: 'pass', evidence: ['shots/a1.png'], stale: true }],
      empty: false,
      badJson: false,
      missing: false,
      total: 1,
      withResult: 1,
      passed: 1,
      failed: 0,
      blocked: 0,
      stale: 0,
      passWithoutEvidence: 0,
      appliesToCurrent: true,
    },
  })
  assert.equal(decision.kind, 'verification')
})

test('优先级 13：验收全绿但没发布 ⇒ 发出去', () => {
  const decision = decide({ receipts: { receipts: [receipt({ stage: 'release', status: 'in_progress' })] } })
  assert.equal(decision.priority, 13)
  assert.equal(decision.kind, 'release')
  assert.equal(decision.stageId, 'release')
})

test('优先级 14：当前迭代发布完成 ⇒ 开启下一轮', () => {
  const decision = decide({
    receipts: { receipts: [receipt({ stage: 'release', status: 'completed' })] },
  })
  assert.equal(decision.priority, 14)
  assert.equal(decision.kind, 'next-iteration')
  assert.equal(decision.stageId, 'release')
})

test('released 只看当前迭代：别的迭代的 release 不算', () => {
  const decision = decide({
    receipts: { receipts: [receipt({ iteration_id: 'v0.9', stage: 'release', status: 'completed' })] },
  })
  assert.equal(decision.kind, 'release')
})

test('优先级 6.5 前置：任务服务不可用 ⇒ 跳过测试门（不拿未知当未完成）', () => {
  const evidence = baseEvidence()
  evidence.tasks = { available: false, total: null, open: null, completed: null, items: [] }
  evidence.gates.tests = { available: false, ok: false, missing: ['.dsh/plugin-state/test-report.json'], gate: 'tests', reason: 'missing' }
  const decision = deriveDecision(evidence)
  assert.notEqual(decision.kind, 'testing')
  assert.equal(decision.kind, 'release', '任务不可用时落到后续可判定环节')
  assert.ok(decision.notes.some((note) => note.includes('任务服务不可用')))
})
test('优先级 4.5：prd 有了但架构契约缺失 ⇒ 先定架构与契约（在原型之前）', () => {
  const evidence = baseEvidence()
  evidence.gates.architecture = { available: false, ok: false, missing: ['docs/architecture.md', 'docs/api.md'], gate: 'architecture', reason: 'missing' }
  const decision = deriveDecision(evidence)
  assert.equal(decision.kind, 'architecture')
  assert.equal(decision.stageId, 'architecture')
  assert.equal(decision.priority, 4.5)
  assert.match(decision.reason, /架构契约/)
})

test('优先级 6.5：任务做完但测试报告缺失 ⇒ 先补测试证据（在代码复核之前）', () => {
  const evidence = baseEvidence()
  evidence.gates.tests = { available: false, ok: false, missing: ['.dsh/plugin-state/test-report.json'], gate: 'tests', reason: 'missing' }
  const decision = deriveDecision(evidence)
  assert.equal(decision.kind, 'testing')
  assert.equal(decision.stageId, 'testing')
  assert.equal(decision.priority, 6.5)
  assert.match(decision.reason, /测试证据|test-report/)
})

test('优先级 6.5：测试报告有失败 ⇒ 先修失败再复核', () => {
  const evidence = baseEvidence()
  evidence.gates.tests = { available: true, ok: false, missing: ['failed>0（2 个失败）'], gate: 'tests', reason: 'wrong-shape', detail: { failed: 2 } }
  const decision = deriveDecision(evidence)
  assert.equal(decision.kind, 'testing')
  assert.match(decision.reason, /2 个失败/)
})

test('优先级 12.5：验收全绿但发布清单缺失 ⇒ 先准备发布清单（在发出去之前）', () => {
  const evidence = baseEvidence()
  evidence.gates.release = { available: false, ok: false, missing: ['.dsh/plugin-state/release.json'], gate: 'release', reason: 'missing' }
  const decision = deriveDecision(evidence)
  assert.equal(decision.kind, 'release')
  assert.equal(decision.stageId, 'release')
  assert.equal(decision.priority, 12.5)
  assert.match(decision.reason, /发布清单/)
})

test('旧证据没有 gates 字段 ⇒ 跳过门禁判定（向后兼容，不阻塞旧项目）', () => {
  const evidence = baseEvidence()
  delete evidence.gates
  const decision = deriveDecision(evidence)
  assert.equal(decision.kind, 'release', '没有 gates 时维持旧行为：验收全绿 → 发出去')
  assert.equal(decision.priority, 13)
})

// ---------- P1 决策门（人工签核） ----------

test('决策门 4.2：PRD 有了但范围没签 ⇒ 先确认这一轮范围（在架构门之前）', () => {
  const decision = decide({ approval: { decisions: decisions({ scope: unsigned() }) } })
  assert.equal(decision.priority, 4.2)
  assert.equal(decision.kind, 'scope-approval')
  assert.equal(decision.stageId, 'requirements')
  assert.equal(decision.title, '确认这一轮范围')
  assert.match(decision.reason, /范围/)
})

test('决策门 4.2 排在架构契约门 4.5 之前：两个都没满足时先让人签范围', () => {
  const evidence = baseEvidence()
  evidence.approval = { ...evidence.approval, decisions: decisions({ scope: unsigned() }) }
  evidence.gates.architecture = { available: false, ok: false, missing: ['docs/architecture.md'], gate: 'architecture', reason: 'missing' }
  const decision = deriveDecision(evidence)
  assert.equal(decision.priority, 4.2)
  assert.equal(decision.kind, 'scope-approval')
})

test('决策门 4.6：范围签了、契约门也过了，但架构没签 ⇒ 架构签核（在原型之前）', () => {
  const decision = decide({ approval: { decisions: decisions({ architecture: unsigned() }) } })
  assert.equal(decision.priority, 4.6)
  assert.equal(decision.kind, 'architecture-approval')
  assert.equal(decision.stageId, 'architecture')
  assert.equal(decision.title, '架构签核')
  assert.match(decision.reason, /契约/)
})

test('决策门 4.6 排在契约门 4.5 之后：契约文件不齐时先补文件，不给人签空白', () => {
  const evidence = baseEvidence()
  evidence.approval = { ...evidence.approval, decisions: decisions({ architecture: unsigned() }) }
  evidence.gates.architecture = { available: false, ok: false, missing: ['docs/api.md'], gate: 'architecture', reason: 'missing' }
  const decision = deriveDecision(evidence)
  assert.equal(decision.priority, 4.5)
  assert.equal(decision.kind, 'architecture')
})

test('决策门 12.2：验收全绿但没签 ⇒ 验收签核（在发布清单门 12.5 之前）', () => {
  const evidence = baseEvidence()
  evidence.approval = { ...evidence.approval, decisions: decisions({ acceptance: unsigned() }) }
  evidence.gates.release = { available: false, ok: false, missing: ['.dsh/plugin-state/release.json'], gate: 'release', reason: 'missing' }
  const decision = deriveDecision(evidence)
  assert.equal(decision.priority, 12.2)
  assert.equal(decision.kind, 'acceptance-approval')
  assert.equal(decision.stageId, 'acceptance')
  assert.equal(decision.title, '验收签核')
  assert.match(decision.reason, /验收/)
})

test('决策门 12.8：清单齐、验收签了但没批准 ⇒ 发布批准（在发出去 13 之前）', () => {
  const decision = decide({ approval: { decisions: decisions({ release: unsigned() }) } })
  assert.equal(decision.priority, 12.8)
  assert.equal(decision.kind, 'release-approval')
  assert.equal(decision.stageId, 'release')
  assert.equal(decision.title, '发布批准')
  assert.match(decision.reason, /批准|清单/)
})

test('决策门 12.8 排在发布清单门 12.5 之后：清单不齐时先补清单，不让人批空白', () => {
  const evidence = baseEvidence()
  evidence.approval = { ...evidence.approval, decisions: decisions({ release: unsigned() }) }
  evidence.gates.release = { available: false, ok: false, missing: ['.dsh/plugin-state/release.json'], gate: 'release', reason: 'missing' }
  const decision = deriveDecision(evidence)
  assert.equal(decision.priority, 12.5)
  assert.equal(decision.kind, 'release')
})

test('决策门向后兼容：证据里没有 approval.decisions ⇒ 四个门全部跳过（旧证据/手工夹具）', () => {
  const evidence = baseEvidence()
  // baseEvidence 的 approval 本来就没有 decisions；验收全绿、发布回执已有 ⇒ 直接到 14。
  evidence.receipts = { receipts: [receipt({ stage: 'release', status: 'completed' })] }
  const decision = deriveDecision(evidence)
  assert.equal(decision.priority, 14)
  assert.equal(decision.kind, 'next-iteration')
  for (const kind of ['scope-approval', 'architecture-approval', 'acceptance-approval', 'release-approval']) {
    assert.notEqual(decision.kind, kind)
  }
})

test('决策门签核后状态机继续推进：四门全签 ⇒ 回到原有 13/14 判定', () => {
  const notReleased = decide({ approval: { decisions: decisions() } })
  assert.equal(notReleased.priority, 13)
  assert.equal(notReleased.kind, 'release')

  const released = decide({
    approval: { decisions: decisions() },
    receipts: { receipts: [receipt({ stage: 'release', status: 'completed' })] },
  })
  assert.equal(released.priority, 14)
  assert.equal(released.kind, 'next-iteration')
})
test('每条优先级的人话文案都满足长度与无代码约束（汇总核对）', () => {
  const fixtures = [
    { degraded: { flag: true, reasons: [{ source: 'x', message: '读失败' }] } },
    { receipts: { receipts: [receipt({ needs_human_decision: { title: '要不要先上导出' } })] } },
    { trellis: { initialized: false } },
    { prd: { found: false } },
    { approval: { approved: false } },
    { tasks: { available: true, open: 1, total: 1 } },
    { tasks: { available: true, total: 0, open: 0 } },
    { review: { available: true, blocking: 1, fixed: 0, rounds: 1 } },
    { review: { available: true, blocking: 0, fixed: 1, rounds: 1 } },
    { review: { available: true, blocking: 0, fixed: 0, rounds: 0 } },
    { acceptance: { empty: true, items: [], total: 0, withResult: 0, passed: 0 } },
    { acceptance: { empty: false, items: [{ result: null, evidence: [] }], total: 1, withResult: 0, passed: 0 } },
    { receipts: { receipts: [receipt({ stage: 'release', status: 'in_progress' })] } },
    { receipts: { receipts: [receipt({ stage: 'release', status: 'completed' })] } },
  ]

  const priorities = []
  const kinds = []
  for (const fixture of fixtures) {
    const decision = deriveDecision(evidence(fixture))
    assertHumanLine(decision)
    priorities.push(decision.priority)
    kinds.push(decision.kind)
  }
  assert.deepEqual(priorities, Array.from({ length: 14 }, (_, index) => index + 1), `14 条规则应依次命中：${priorities.join(',')}`)
  // 规则 6/7 都归"写代码"，所以动作只有 13 种；拆任务靠标题区分。
  assert.equal(new Set(kinds).size, 13, `动作种类：${kinds.join(',')}`)
})

test('残缺证据不抛错：缺字段时按"未初始化"给出唯一动作', () => {
  for (const input of [undefined, null, {}, { ok: false }]) {
    const decision = deriveDecision(input)
    assertHumanLine(decision)
    assert.equal(decision.kind, 'init')
  }
})

test('已发布迭代：缺发布清单 / 空任务 / 旧签核都不再阻断，直接开下一轮', () => {
  const evidence = baseEvidence()
  evidence.receipts = {
    receipts: [{ id: 'r1', at: '2026-11-01T00:00:00.000Z', iteration_id: 'v1.0', stage: 'release', status: 'completed' }],
    badLines: 0,
    missing: false,
    lastAt: '2026-11-01T00:00:00.000Z',
  }
  evidence.tasks = { available: true, total: 0, open: 0, completed: 0, items: [] }
  evidence.gates.release = { available: false, ok: false, missing: ['.dsh/plugin-state/release.json'], gate: 'release', reason: 'missing' }
  const decision = deriveDecision(evidence)
  assert.equal(decision.kind, 'next-iteration')
  assert.equal(decision.priority, 14)
})