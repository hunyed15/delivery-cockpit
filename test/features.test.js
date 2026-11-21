/**
 * 功能账：PRD 受控功能清单提取 + 三路证据推导状态。
 *
 * 这一层的价值全在"不猜"：认不到 FR 结构就说没有；没有关联证据就显示未开始；
 * 归属不到 bug 时显示 — 而不是 0。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FEATURE_FORMAT_HINT, buildFeatureBoard, extractFeatures, readPrdText } from '../lib/features.js'

const PRD = [
  '# 演示产品',
  '',
  '## 1. 产品定义',
  '### FR-99 定义里不该被当成功能',
  '',
  '## 4. 功能需求',
  '',
  '### FR-1 信号采集（P0）',
  '说明',
  '',
  '### FR-2 检索与打分 (P1)',
  '说明',
  '',
  '### FR-3 转存',
  '',
  '## 5. 核心流程',
  '### FR-4 流程里的标题也不算',
  '',
].join('\n')

const receipt = (over = {}) => ({
  at: '2026-11-20T10:00:00.000Z',
  iteration_id: 'v1.0',
  stage: 'coding',
  status: 'completed',
  summary_for_human: '做完了',
  feature_ids: [],
  write_scope: [],
  artifacts: [],
  ...over,
})

const issue = (over = {}) => ({
  severity: 'critical',
  title: '提交按钮移动端失效',
  file: 'web/orders/list.ts',
  line: 12,
  ...over,
})

const acceptanceOf = (items) => ({
  items,
  appliesToCurrent: true,
  badJson: false,
  missing: false,
  empty: items.length === 0,
  total: items.length,
})

const passItem = (featureRef) => ({
  id: 'A1',
  feature_ref: featureRef,
  result: 'pass',
  evidence: ['shots/a1.png'],
})

const reviewOf = (blockingIssues, over = {}) => ({
  available: true,
  reason: null,
  rounds: 1,
  blocking: blockingIssues.length,
  fixed: 0,
  lastRound: 1,
  issues: blockingIssues.slice(0, 3),
  blockingIssues,
  ...over,
})

test('提取：只认「功能需求」小节里的 ### FR-N，其他小节的 FR 标题不算', () => {
  const result = extractFeatures(PRD)
  assert.equal(result.strategy, 'fr-section')
  assert.equal(result.sectionTitle, '4. 功能需求')
  assert.deepEqual(result.features.map((item) => item.id), ['FR-1', 'FR-2', 'FR-3'])
})

test('提取：优先级从标题里剥出来，标题保持人话', () => {
  const { features } = extractFeatures(PRD)
  assert.equal(features[0].priority, 'P0')
  assert.equal(features[0].title, '信号采集')
  assert.equal(features[1].priority, 'P1')
  assert.equal(features[1].title, '检索与打分')
  assert.equal(features[2].priority, null)
  assert.equal(features[2].title, '转存')
})

test('提取：括号里带补充说明的优先级也要认（真实 PRD 的写法）', () => {
  const text = [
    '## 功能需求',
    '### FR-1 缺集检测与补救（P0，核心差异化）',
    '### FR-2 企微交互（P0 点播 / P1 全量）',
    '### FR-3 运维与可观测（P0 基础）',
  ].join('\n')
  const { features } = extractFeatures(text)
  assert.equal(features[0].priority, 'P0')
  assert.equal(features[0].title, '缺集检测与补救')
  assert.equal(features[1].priority, 'P0')
  assert.equal(features[1].title, '企微交互')
  assert.equal(features[2].priority, 'P0')
  assert.equal(features[2].title, '运维与可观测')
})

test('提取：代码围栏里的 ### 不算标题（防止示例污染）', () => {
  const text = ['## 功能需求', '', '```md', '### FR-1 这是示例', '```', '', '### FR-2 真功能'].join('\n')
  const { features } = extractFeatures(text)
  assert.deepEqual(features.map((item) => item.id), ['FR-2'])
})

test('提取：没有「功能需求」小节时按全文 FR 兜底，并留一条建议', () => {
  const text = ['# 产品', '### FR-7 采集', '### FR-8 转存'].join('\n')
  const result = extractFeatures(text)
  assert.equal(result.strategy, 'fr-global')
  assert.deepEqual(result.features.map((item) => item.id), ['FR-7', 'FR-8'])
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0].message, /兜底/)
})

test('提取：完全没有 FR 结构就是 none，不猜标题', () => {
  const result = extractFeatures('# 产品\n\n## 功能\n- 登录\n- 支付\n')
  assert.equal(result.strategy, 'none')
  assert.deepEqual(result.features, [])
})

test('提取：重复的 FR 编号只取第一次出现', () => {
  const text = ['## 功能需求', '### FR-1 采集', '### FR-1 采集（重复粘贴）'].join('\n')
  const { features } = extractFeatures(text)
  assert.equal(features.length, 1)
  assert.equal(features[0].title, '采集')
})

test('readPrdText：文件不存在是 missing，不是错误', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dc-feature-'))
  try {
    const result = await readPrdText(project, 'prd.md')
    assert.equal(result.missing, true)
    assert.equal(result.text, null)
    assert.equal(result.error, null)
    await writeFile(join(project, 'prd.md'), '## 功能需求\n### FR-1 采集\n', 'utf8')
    const hit = await readPrdText(project, 'prd.md')
    assert.equal(hit.missing, false)
    assert.match(hit.text, /FR-1/)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('功能账：没有 PRD 时 source=prd-missing 并给下一步提示', () => {
  const board = buildFeatureBoard({ extracted: extractFeatures(''), prd: { path: null } })
  assert.equal(board.source, 'prd-missing')
  assert.equal(board.counts.total, 0)
  assert.ok(board.notes.some((note) => /prd\.md/.test(note)))
})

test('功能账：有 PRD 但没识别到 FR 结构时给格式提示，绝不用启发式猜功能', () => {
  const board = buildFeatureBoard({
    extracted: extractFeatures('# 产品\n## 功能\n- 登录\n'),
    prd: { path: 'docs/prd.md' },
  })
  assert.equal(board.source, 'prd-empty')
  assert.equal(board.formatHint, FEATURE_FORMAT_HINT)
  assert.equal(board.counts.total, 0)
})

test('状态：验收全部 pass 且有证据 ⇒ 已完成', () => {
  const board = buildFeatureBoard({
    extracted: extractFeatures(PRD),
    prd: { path: 'prd.md' },
    receipts: [],
    acceptance: acceptanceOf([passItem('FR-1')]),
    review: reviewOf([]),
  })
  const fr1 = board.items.find((item) => item.id === 'FR-1')
  assert.equal(fr1.status, 'done')
  assert.equal(fr1.statusLabel, '已完成')
  assert.equal(fr1.acceptance.total, 1)
  assert.equal(fr1.acceptance.passed, 1)
})

test('状态：验收 pass 但没有证据 ⇒ 不算通过，落回进行中', () => {
  const board = buildFeatureBoard({
    extracted: extractFeatures(PRD),
    prd: { path: 'prd.md' },
    acceptance: acceptanceOf([{ id: 'A1', feature_ref: 'FR-1', result: 'pass', evidence: [] }]),
    review: reviewOf([]),
  })
  const fr1 = board.items.find((item) => item.id === 'FR-1')
  assert.equal(fr1.status, 'in-progress')
  assert.equal(fr1.acceptance.missingEvidence, 1)
})

test('状态：bug 按回执 write_scope 归属到功能 ⇒ 有阻塞', () => {
  const board = buildFeatureBoard({
    extracted: extractFeatures(PRD),
    prd: { path: 'prd.md' },
    receipts: [receipt({ feature_ids: ['FR-2'], write_scope: ['web/orders/**'] })],
    acceptance: acceptanceOf([]),
    review: reviewOf([
      issue({ file: 'web/orders/list.ts' }),
      issue({ file: 'web/orders/detail.ts', severity: 'important', title: '详情页空值未处理' }),
    ]),
  })
  const fr2 = board.items.find((item) => item.id === 'FR-2')
  assert.equal(fr2.status, 'blocked')
  assert.equal(fr2.statusLabel, '有阻塞')
  assert.equal(fr2.bugs.blocking, 2)
  // 严重数按全量归属结果算，不能只数下发的前 3 条
  assert.equal(fr2.bugs.severe, 1)
  assert.equal(fr2.bugs.known, true)
  assert.equal(fr2.paths[0], 'web/orders')
})

test('状态：进行中回执 ⇒ 进行中；completed 但没验收 ⇒ 待验收', () => {
  const base = { extracted: extractFeatures(PRD), prd: { path: 'prd.md' }, review: reviewOf([]) }
  const running = buildFeatureBoard({
    ...base,
    receipts: [receipt({ feature_ids: ['FR-1'], status: 'in_progress' })],
  })
  assert.equal(running.items.find((item) => item.id === 'FR-1').status, 'in-progress')

  const reported = buildFeatureBoard({
    ...base,
    receipts: [receipt({ feature_ids: ['FR-3'], status: 'completed' })],
  })
  assert.equal(reported.items.find((item) => item.id === 'FR-3').status, 'pending-acceptance')
})

test('状态：验收草稿（没人填结果）不是证据 ⇒ 未开始；有进行中回执才是进行中', () => {
  const drafted = buildFeatureBoard({
    extracted: extractFeatures(PRD),
    prd: { path: 'prd.md' },
    acceptance: acceptanceOf([{ id: 'A1', feature_ref: 'FR-1', result: null, evidence: [] }]),
    review: reviewOf([]),
  })
  assert.equal(drafted.items.find((item) => item.id === 'FR-1').status, 'not-started')

  const working = buildFeatureBoard({
    extracted: extractFeatures(PRD),
    prd: { path: 'prd.md' },
    receipts: [receipt({ feature_ids: ['FR-1'], status: 'in_progress' })],
    acceptance: acceptanceOf([{ id: 'A1', feature_ref: 'FR-1', result: null, evidence: [] }]),
    review: reviewOf([]),
  })
  assert.equal(working.items.find((item) => item.id === 'FR-1').status, 'in-progress')
})

test('状态：没有任何证据 ⇒ 未开始；验收表坏了且无回执 ⇒ unknown（—）', () => {
  const clean = buildFeatureBoard({
    extracted: extractFeatures(PRD),
    prd: { path: 'prd.md' },
    acceptance: acceptanceOf([]),
    review: reviewOf([]),
  })
  assert.equal(clean.items.find((item) => item.id === 'FR-1').status, 'not-started')

  const broken = buildFeatureBoard({
    extracted: extractFeatures(PRD),
    prd: { path: 'prd.md' },
    acceptance: { ...acceptanceOf([]), badJson: true, items: [] },
    review: reviewOf([]),
  })
  assert.equal(broken.items.find((item) => item.id === 'FR-1').status, 'unknown')
  assert.equal(broken.items.find((item) => item.id === 'FR-1').statusLabel, '—')
})

test('bug 数不可知时显示 —（known=false），不显示 0', () => {
  const noLedger = buildFeatureBoard({
    extracted: extractFeatures(PRD),
    prd: { path: 'prd.md' },
    acceptance: acceptanceOf([]),
    review: { available: false, reason: 'no-ledger', rounds: null, blocking: null, fixed: null, lastRound: null, issues: [], blockingIssues: [] },
  })
  for (const item of noLedger.items) {
    assert.equal(item.bugs.known, false)
    assert.ok(noLedger.notes.some((note) => /待修 bug 数不可知/.test(note)))
  }

  // 账本里确实有 bug，但这个功能没有任何可归属路径 ⇒ 也是不可知，不是 0。
  const unattributable = buildFeatureBoard({
    extracted: extractFeatures(PRD),
    prd: { path: 'prd.md' },
    acceptance: acceptanceOf([]),
    review: reviewOf([issue({ file: 'src/unknown.ts' })]),
  })
  const fr1 = unattributable.items.find((item) => item.id === 'FR-1')
  assert.equal(fr1.bugs.known, false)
  assert.equal(unattributable.unattributed.blocking, 1)
  assert.equal(unattributable.unattributed.known, true)
})

test('路径归属：前缀匹配、反斜杠与 ./ 归一，未归属单列', () => {
  const board = buildFeatureBoard({
    extracted: extractFeatures(PRD),
    prd: { path: 'prd.md' },
    receipts: [receipt({ feature_ids: ['FR-2'], write_scope: ['./web\\orders\\'] })],
    acceptance: acceptanceOf([]),
    review: reviewOf([
      issue({ file: 'web/orders/list.ts' }),
      issue({ file: 'web/orders/', title: '目录问题' }),
      issue({ file: 'web/other.ts', title: '无关问题' }),
    ]),
  })
  const fr2 = board.items.find((item) => item.id === 'FR-2')
  assert.equal(fr2.bugs.blocking, 2)
  assert.equal(board.unattributed.blocking, 1)
  assert.equal(board.unattributed.issues[0].title, '无关问题')
})

test('验收表属于别的迭代时不参与状态推导', () => {
  const board = buildFeatureBoard({
    extracted: extractFeatures(PRD),
    prd: { path: 'prd.md' },
    acceptance: { ...acceptanceOf([passItem('FR-1')]), appliesToCurrent: false },
    review: reviewOf([]),
  })
  assert.equal(board.items.find((item) => item.id === 'FR-1').status, 'not-started')
})

test('汇总计数与每条功能的状态一致', () => {
  const board = buildFeatureBoard({
    extracted: extractFeatures(PRD),
    prd: { path: 'prd.md' },
    receipts: [
      receipt({ feature_ids: ['FR-2'], write_scope: ['web/orders/**'] }),
      receipt({ feature_ids: ['FR-3'], status: 'in_progress' }),
    ],
    acceptance: acceptanceOf([passItem('FR-1')]),
    review: reviewOf([issue({ file: 'web/orders/list.ts' })]),
  })
  assert.equal(board.counts.total, 3)
  assert.equal(board.counts.done, 1)
  assert.equal(board.counts.blocked, 1)
  assert.equal(board.counts.inProgress, 1)
  assert.equal(board.counts.notStarted, 0)
  const statuses = board.items.map((item) => item.status)
  assert.deepEqual(statuses, ['done', 'blocked', 'in-progress'])
})

test('自动归属：任务标题带 FR 编号时，relatedFiles 就是该功能的路径锚点', () => {
  const board = buildFeatureBoard({
    extracted: extractFeatures(PRD),
    prd: { path: 'prd.md' },
    tasks: {
      available: true,
      items: [{ id: 'T3', title: 'FR-2 检索打分：补候选打分', status: 'in_progress', relatedFiles: ['src/rank/**'] }],
    },
    review: reviewOf([issue({ file: 'src/rank/score.ts', title: '打分越界' })]),
  })
  const fr2 = board.items.find((item) => item.id === 'FR-2')
  assert.equal(fr2.anchors.tasks, 1)
  assert.deepEqual(fr2.paths, ['src/rank'], '尾部 /** 会被归一掉')
  assert.equal(fr2.status, 'blocked')
  assert.equal(fr2.bugs.blocking, 1)
})

test('自动归属：没写 feature_ids 的回执，按 write_scope / 任务 relatedFiles 与锚点重叠推断', () => {
  const board = buildFeatureBoard({
    extracted: extractFeatures(PRD),
    prd: { path: 'prd.md' },
    tasks: {
      available: true,
      items: [{ id: 'T3', title: 'FR-2 检索打分', status: 'in_progress', relatedFiles: ['src/rank'] }],
    },
    receipts: [
      // 这条没写 feature_ids，也没写 write_scope，但 task_ref 指向的任务有 relatedFiles
      receipt({ feature_ids: [], task_ref: 'T3', status: 'in_progress', write_scope: [] }),
    ],
    review: reviewOf([]),
  })
  const fr2 = board.items.find((item) => item.id === 'FR-2')
  assert.equal(fr2.receipts, 1)
  assert.equal(fr2.inferredReceipts, 1)
  assert.equal(fr2.status, 'in-progress')
  assert.ok(board.notes.some((note) => /自动归属/.test(note)))
})

test('自动归属：显式 feature_ids 永远优先，不会被路径推断重复归到别的功能', () => {
  const board = buildFeatureBoard({
    extracted: extractFeatures(PRD),
    prd: { path: 'prd.md' },
    tasks: {
      available: true,
      items: [{ id: 'T1', title: 'FR-1 采集', status: 'in_progress', relatedFiles: ['src/feed'] }],
    },
    receipts: [receipt({ feature_ids: ['FR-2'], write_scope: ['src/feed/**'], status: 'in_progress' })],
    review: reviewOf([]),
  })
  const fr1 = board.items.find((item) => item.id === 'FR-1')
  const fr2 = board.items.find((item) => item.id === 'FR-2')
  assert.equal(fr2.receipts, 1, '自报的归到 FR-2')
  assert.equal(fr1.receipts, 0, '不会被路径推断再算一次')
  assert.equal(fr2.inferredReceipts, 0)
})

test('一条锚点都没有时明确提示先写 feature_ids', () => {
  const board = buildFeatureBoard({
    extracted: extractFeatures(PRD),
    prd: { path: 'prd.md' },
    receipts: [receipt({ feature_ids: [], write_scope: ['src/whatever'] })],
    review: reviewOf([]),
  })
  assert.ok(board.notes.some((note) => /第一条 coding 回执请写上 feature_ids/.test(note)))
})

test('自动归属：一条覆盖多个功能的回执会多处归属，但 note 按唯一回执计数', () => {
  const board = buildFeatureBoard({
    extracted: extractFeatures(PRD),
    prd: { path: 'prd.md' },
    tasks: {
      available: true,
      items: [
        { id: 'T1', title: 'FR-1 采集', status: 'in_progress', relatedFiles: ['web/shared'] },
        { id: 'T2', title: 'FR-2 检索', status: 'in_progress', relatedFiles: ['web/shared'] },
      ],
    },
    receipts: [receipt({ feature_ids: [], write_scope: ['web/shared/**'], status: 'in_progress' })],
    review: reviewOf([]),
  })
  const fr1 = board.items.find((item) => item.id === 'FR-1')
  const fr2 = board.items.find((item) => item.id === 'FR-2')
  assert.equal(fr1.inferredReceipts, 1)
  assert.equal(fr2.inferredReceipts, 1, '同一份改动同时服务两条功能')
  const note = board.notes.find((item) => /自动归属/.test(item))
  assert.match(note, /有 1 条回执/, 'note 按唯一回执计数，不按配对次数')
})

test('自动归属：task_ref 指向不存在的任务时优雅降级（不推断、不报错）', () => {
  const board = buildFeatureBoard({
    extracted: extractFeatures(PRD),
    prd: { path: 'prd.md' },
    tasks: { available: true, items: [{ id: 'T1', title: 'FR-1 采集', status: 'in_progress', relatedFiles: ['src/feed'] }] },
    receipts: [receipt({ feature_ids: [], task_ref: 'T404', write_scope: [], status: 'in_progress' })],
    review: reviewOf([]),
  })
  const fr1 = board.items.find((item) => item.id === 'FR-1')
  assert.equal(fr1.receipts, 0)
  assert.equal(fr1.inferredReceipts, 0)
})

test('任务标题带 FR 但 relatedFiles 为空时不构成锚点（不能让界面显示"任务锚点"却无路径）', () => {
  const board = buildFeatureBoard({
    extracted: extractFeatures(PRD),
    prd: { path: 'prd.md' },
    tasks: { available: true, items: [{ id: 'T9', title: 'FR-3 转存收尾', status: 'in_progress', relatedFiles: [] }] },
    review: reviewOf([]),
  })
  const fr3 = board.items.find((item) => item.id === 'FR-3')
  assert.equal(fr3.anchors.tasks, 0)
  assert.deepEqual(fr3.paths, [])
})

test('功能账不抛错：缺参数时给空结构', () => {
  const board = buildFeatureBoard()
  assert.equal(board.source, 'prd-missing')
  assert.equal(board.counts.total, 0)
  assert.deepEqual(board.items, [])
  assert.equal(board.unattributed.blocking, 0)
})

test('blocking 被上限截断时留一条对账提示', () => {
  const many = Array.from({ length: 5 }, (_, index) => issue({ file: `src/x${index}.ts` }))
  const board = buildFeatureBoard({
    extracted: extractFeatures(PRD),
    prd: { path: 'prd.md' },
    acceptance: acceptanceOf([]),
    // 账本总数比下发的全量列表多（模拟 MAX_BLOCKING_ISSUES 截断）
    review: reviewOf(many, { blocking: 260 }),
  })
  assert.ok(board.notes.some((note) => /260 条未处置 blocking/.test(note)))
})
