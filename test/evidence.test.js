import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { readEvidence } from '../lib/evidence.js'

const CONTRACT_KEYS = [
  'ok',
  'projectPath',
  'workspace',
  'trellis',
  'prd',
  'card',
  'detected',
  'receipts',
  'iteration',
  'approval',
  'acceptance',
  'tasks',
  'review',
  'warnings',
  'degraded',
  'generatedAt',
]

async function withProject(run, prefix = 'dc-evidence-') {
  const project = await mkdtemp(join(tmpdir(), prefix))
  try {
    await run(project)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

async function writeText(project, rel, text) {
  const path = join(project, ...rel.split('/'))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
  return path
}

async function writeJson(project, rel, value) {
  return writeText(project, rel, JSON.stringify(value))
}

const writeState = (project, name, value) => writeJson(project, `.dsh/plugin-state/${name}`, value)
const writeStateText = (project, name, text) => writeText(project, `.dsh/plugin-state/${name}`, text)

const receiptLine = (overrides) =>
  JSON.stringify({
    iteration_id: 'v1.0',
    stage: 'brainstorm',
    status: 'completed',
    summary_for_human: '需求定了',
    at: '2026-11-20T00:00:00.000Z',
    ...overrides,
  })

const writeReceipts = (project, lines) => writeStateText(project, 'receipts.jsonl', `${lines.join('\n')}\n`)

const writeTask = (project, name, value) => writeJson(project, `.trellis/tasks/${name}/task.json`, value)

test('所有契约字段都在；路径是 resolve 后的绝对路径', async () => {
  await withProject(async (project) => {
    const evidence = await readEvidence(project)
    for (const key of CONTRACT_KEYS) assert.ok(key in evidence, `缺少字段 ${key}`)
    assert.equal(evidence.ok, true)
    assert.equal(evidence.projectPath, resolve(project))
    assert.equal(typeof evidence.generatedAt, 'string')
    assert.equal(Number.isNaN(Date.parse(evidence.generatedAt)), false)
  })
})

test('项目路径不存在：ok:false + 空结构 + 降级，不抛错', async () => {
  const missing = join(tmpdir(), `dc-evidence-missing-${Date.now()}`)
  const evidence = await readEvidence(missing)
  assert.equal(evidence.ok, false)
  assert.deepEqual(evidence.workspace, { exists: false })
  assert.equal(evidence.degraded.flag, true)
  assert.equal(evidence.degraded.reasons.length > 0, true)
  assert.deepEqual(evidence.trellis, { exists: false, rules: false, initialized: false, partial: false })
  assert.deepEqual(evidence.prd, { found: false, path: null })
  assert.equal(evidence.card.status, 'missing')
  assert.equal(evidence.receipts.missing, true)
  assert.equal(evidence.iteration.current, 'bootstrap')
  assert.equal(evidence.iteration.isBootstrap, true)
  assert.equal(evidence.approval.approved, false)
  assert.equal(evidence.tasks.available, false)
  assert.deepEqual(evidence.review, {
    available: false,
    reason: 'no-ledger',
    rounds: null,
    blocking: null,
    fixed: null,
    lastRound: null,
    issues: [],
    blockingIssues: [],
  })
  for (const key of CONTRACT_KEYS) assert.ok(key in evidence)
})

test('项目路径是文件不是目录：ok:false + 降级，不抛错', async () => {
  await withProject(async (project) => {
    const file = join(project, 'not-a-dir.txt')
    await writeFile(file, 'x', 'utf8')
    const evidence = await readEvidence(file)
    assert.equal(evidence.ok, false)
    assert.equal(evidence.workspace.exists, false)
    assert.equal(evidence.degraded.flag, true)
    assert.match(evidence.degraded.reasons[0].message, /不是目录/)
  })
})

test('空目录：workspace 存在、未初始化，但没有读失败 ⇒ 不降级', async () => {
  await withProject(async (project) => {
    const evidence = await readEvidence(project)
    assert.equal(evidence.ok, true)
    assert.deepEqual(evidence.workspace, { exists: true })
    assert.deepEqual(evidence.trellis, { exists: false, rules: false, initialized: false, partial: false })
    assert.equal(evidence.card.missing, true)
    assert.equal(evidence.card.status, 'missing')
    assert.equal(evidence.receipts.missing, true)
    assert.equal(evidence.acceptance.missing, true)
    assert.equal(evidence.acceptance.empty, true)
    assert.equal(evidence.degraded.flag, false, '没有文件不是故障')
    assert.deepEqual(evidence.warnings, [])
    assert.deepEqual(evidence.dataGaps, [])
  })
})

test('trellis 初始化：.trellis 与 RULES.md 齐备才 initialized，缺一半是 partial', async () => {
  await withProject(async (project) => {
    await mkdir(join(project, '.trellis'), { recursive: true })
    let evidence = await readEvidence(project)
    assert.deepEqual(evidence.trellis, { exists: true, rules: false, initialized: false, partial: true })

    await rm(join(project, '.trellis'), { recursive: true, force: true })
    await writeStateText(project, 'RULES.md', '# 规则\n')
    evidence = await readEvidence(project)
    assert.deepEqual(evidence.trellis, { exists: false, rules: true, initialized: false, partial: true })

    await mkdir(join(project, '.trellis'), { recursive: true })
    evidence = await readEvidence(project)
    assert.deepEqual(evidence.trellis, { exists: true, rules: true, initialized: true, partial: false })
    assert.equal(evidence.degraded.flag, false)
  })
})

test('prd：依次探测 prd.md / docs/prd.md / PRD.md，取第一个存在的', async () => {
  await withProject(async (project) => {
    assert.deepEqual((await readEvidence(project)).prd, { found: false, path: null })

    await writeText(project, 'docs/prd.md', '# 需求\n')
    assert.deepEqual((await readEvidence(project)).prd, { found: true, path: 'docs/prd.md' })

    await writeText(project, 'prd.md', '# 需求\n')
    assert.deepEqual((await readEvidence(project)).prd, { found: true, path: 'prd.md' }, '根目录优先')
  })

  // Windows 文件系统大小写不敏感：只放 PRD.md 时第一个候选 prd.md 就会命中同一份文件。
  await withProject(async (project) => {
    await writeText(project, 'PRD.md', '# 需求\n')
    const prd = (await readEvidence(project)).prd
    assert.equal(prd.found, true)
    assert.ok(['prd.md', 'PRD.md'].includes(prd.path), `实际路径 ${prd.path}`)
  })
})

test('回执：坏行只进 badLines 不算降级；currentIteration 忽略 bootstrap', async () => {
  await withProject(async (project) => {
    await writeReceipts(project, [
      receiptLine({ iteration_id: 'bootstrap', stage: 'init', summary_for_human: '初始化' }),
      receiptLine({ iteration_id: 'v1.0', stage: 'brainstorm' }),
      '{ 坏行',
      receiptLine({ iteration_id: 'v1.1', stage: 'brainstorm', at: '2026-11-20T01:00:00.000Z' }),
    ])
    const evidence = await readEvidence(project)
    assert.equal(evidence.receipts.missing, false)
    assert.equal(evidence.receipts.receipts.length, 3)
    assert.equal(evidence.receipts.badLines, 1)
    assert.equal(evidence.receipts.lastAt, '2026-11-20T01:00:00.000Z')
    assert.equal(evidence.degraded.flag, false, '账本坏行不算降级')
    assert.equal(evidence.iteration.current, 'v1.1')
    assert.equal(evidence.iteration.isBootstrap, false)
  })
})

test('只有 bootstrap 回执：current=bootstrap，approval 恒 false（bootstrap 不算迭代批准）', async () => {
  await withProject(async (project) => {
    await writeReceipts(project, [
      receiptLine({ iteration_id: 'bootstrap', stage: 'init', summary_for_human: '初始化' }),
    ])
    await writeState(project, 'approvals.json', {
      bootstrap: { prototypeApprovedAt: '2026-11-20T00:00:00.000Z', prototype: 'prototype.html' },
    })
    const evidence = await readEvidence(project)
    assert.equal(evidence.iteration.current, 'bootstrap')
    assert.equal(evidence.iteration.isBootstrap, true)
    assert.deepEqual(evidence.approval, { approved: false, at: null, file: null })
  })
})

test('原型批准按迭代：v1.0 的批准不会被 v1.1 误读', async () => {
  await withProject(async (project) => {
    await writeState(project, 'approvals.json', {
      'v1.0': { prototypeApprovedAt: '2026-11-20T22:10:00+08:00', prototype: 'prototype.html' },
    })
    await writeReceipts(project, [
      receiptLine({ iteration_id: 'v1.0', stage: 'brainstorm' }),
      receiptLine({ iteration_id: 'v1.1', stage: 'brainstorm' }),
    ])
    const evidence = await readEvidence(project)
    assert.equal(evidence.iteration.current, 'v1.1')
    assert.deepEqual(evidence.approval, { approved: false, at: null, file: null })
    assert.deepEqual(evidence.iteration.approvals, {
      map: { 'v1.0': { prototypeApprovedAt: '2026-11-20T22:10:00+08:00', prototype: 'prototype.html' } },
      badJson: false,
      missing: false,
    })
  })
})

test('原型批准命中当前迭代：approved/at/file 原样透出', async () => {
  await withProject(async (project) => {
    await writeState(project, 'approvals.json', {
      'v1.0': { prototypeApprovedAt: '2026-11-20T22:10:00+08:00', prototype: 'docs/prototype.html' },
    })
    await writeReceipts(project, [receiptLine({ iteration_id: 'v1.0', stage: 'brainstorm' })])
    const evidence = await readEvidence(project)
    assert.deepEqual(evidence.approval, {
      approved: true,
      at: '2026-11-20T22:10:00+08:00',
      file: 'docs/prototype.html',
    })
  })
})

test('approvals.json 坏 JSON：badJson + 降级，但不伪造批准', async () => {
  await withProject(async (project) => {
    await writeStateText(project, 'approvals.json', '{ 坏 JSON')
    const evidence = await readEvidence(project)
    assert.equal(evidence.iteration.approvals.badJson, true)
    assert.deepEqual(evidence.iteration.approvals.map, {})
    assert.equal(evidence.approval.approved, false)
    assert.equal(evidence.degraded.flag, true)
    assert.equal(evidence.warnings.some((item) => item.source === '.dsh/plugin-state/approvals.json'), true)
  })
})

test('名片坏 JSON：card.broken + status=broken + 降级', async () => {
  await withProject(async (project) => {
    await writeStateText(project, 'project.json', '{ 坏 JSON')
    const evidence = await readEvidence(project)
    assert.equal(evidence.card.broken, true)
    assert.equal(evidence.card.missing, false)
    assert.equal(evidence.card.card, null)
    assert.equal(evidence.card.status, 'broken')
    assert.equal(evidence.degraded.flag, true)
    assert.equal(evidence.warnings.some((item) => item.source === '.dsh/plugin-state/project.json'), true)
  })
})

test('验收失效：stale 的 pass 不算通过，也不计入"已验证"', async () => {
  await withProject(async (project) => {
    await writeState(project, 'acceptance.json', {
      schemaVersion: 1,
      iteration_id: null,
      items: [
        { id: 'A1', title: '截图变了导致失效', result: 'pass', evidence: ['shots/a1.png'], stale: true, stale_reason: 'visual-change' },
        { id: 'A2', title: '仍然有效', result: 'pass', evidence: ['shots/a2.png'] },
      ],
    })
    const evidence = await readEvidence(project)
    assert.equal(evidence.acceptance.total, 2)
    assert.equal(evidence.acceptance.passed, 1, '失效的 pass 不计入通过')
    assert.equal(evidence.acceptance.stale, 1)
    assert.equal(evidence.acceptance.withResult, 1, '失效不算"已验过"（否则功能状态会停在"进行中"）')
    assert.equal(evidence.degraded.flag, false, '失效不是数据故障')
  })
})

test('验收表缺失：missing=true，按空表处理（空表不算通过）', async () => {
  await withProject(async (project) => {
    const evidence = await readEvidence(project)
    assert.equal(evidence.acceptance.missing, true)
    assert.equal(evidence.acceptance.badJson, false)
    assert.equal(evidence.acceptance.empty, true)
    assert.equal(evidence.acceptance.total, 0)
    assert.equal(evidence.acceptance.appliesToCurrent, true)
    assert.equal(evidence.degraded.flag, false)
  })
})

test('验收表计数：pass 必须有 evidence，passWithoutEvidence 单独计数', async () => {
  await withProject(async (project) => {
    await writeState(project, 'acceptance.json', {
      schemaVersion: 1,
      iteration_id: null,
      items: [
        { id: 'A1', title: '有证据的通过', result: 'pass', evidence: ['shots/a1.png'] },
        { id: 'A2', title: '没证据的通过', result: 'pass', evidence: [] },
        { id: 'A3', title: '失败', result: 'fail', evidence: [] },
        { id: 'A4', title: '被阻塞', result: 'blocked', evidence: [] },
        { id: 'A5', title: '还没跑', result: null, evidence: [] },
      ],
    })
    const evidence = await readEvidence(project)
    assert.equal(evidence.acceptance.missing, false)
    assert.equal(evidence.acceptance.badJson, false)
    assert.equal(evidence.acceptance.appliesToCurrent, true)
    assert.equal(evidence.acceptance.total, 5)
    assert.equal(evidence.acceptance.withResult, 4)
    assert.equal(evidence.acceptance.passed, 1, '只有带证据的 pass 才算通过')
    assert.equal(evidence.acceptance.passWithoutEvidence, 1)
    assert.equal(evidence.acceptance.failed, 1)
    assert.equal(evidence.acceptance.blocked, 1)
    assert.equal(evidence.acceptance.empty, false)
    assert.equal(evidence.degraded.flag, false)
  })
})

test('验收表 iteration_id 匹配当前迭代时正常参与判定（null = 未绑定也算有效）', async () => {
  await withProject(async (project) => {
    await writeReceipts(project, [receiptLine({ iteration_id: 'v1.0', stage: 'verification' })])
    await writeState(project, 'acceptance.json', {
      schemaVersion: 1,
      iteration_id: 'v1.0',
      items: [{ id: 'A1', title: '能添加客户', result: 'pass', evidence: ['shots/a1.png'] }],
    })
    const evidence = await readEvidence(project)
    assert.equal(evidence.iteration.current, 'v1.0')
    assert.equal(evidence.acceptance.appliesToCurrent, true)
    assert.equal(evidence.acceptance.total, 1)
    assert.equal(evidence.acceptance.passed, 1)
    assert.equal(evidence.acceptance.empty, false)
  })
})

test('验收表过期：iteration_id 不匹配 ⇒ 不参与通过判定 + dataGap，不算降级', async () => {
  await withProject(async (project) => {
    await writeReceipts(project, [receiptLine({ iteration_id: 'v1.1', stage: 'verification' })])
    await writeState(project, 'acceptance.json', {
      schemaVersion: 1,
      iteration_id: 'v1.0',
      items: [{ id: 'A1', title: '旧迭代的通过', result: 'pass', evidence: ['shots/a1.png'] }],
    })
    const evidence = await readEvidence(project)
    assert.equal(evidence.acceptance.appliesToCurrent, false)
    assert.deepEqual(evidence.acceptance.items, [], '过期表格不参与通过判定')
    assert.equal(evidence.acceptance.total, 0)
    assert.equal(evidence.acceptance.passed, 0)
    assert.equal(evidence.acceptance.empty, false, '过期 ≠ 空表')
    assert.equal(evidence.degraded.flag, false)
    assert.equal(evidence.dataGaps.length, 1)
    assert.equal(evidence.dataGaps[0].source, 'acceptance')
    assert.match(evidence.dataGaps[0].message, /v1\.0/)
    assert.match(evidence.dataGaps[0].message, /v1\.1/)
  })
})

test('验收表坏 JSON / 结构不对：badJson + 降级，不声称空表', async () => {
  await withProject(async (project) => {
    await writeStateText(project, 'acceptance.json', '{ 坏 JSON')
    let evidence = await readEvidence(project)
    assert.equal(evidence.acceptance.badJson, true)
    assert.equal(evidence.acceptance.missing, false)
    assert.equal(evidence.acceptance.empty, false)
    assert.equal(evidence.degraded.flag, true)
    assert.equal(evidence.warnings.some((item) => item.source === '.dsh/plugin-state/acceptance.json'), true)

    await writeState(project, 'acceptance.json', { schemaVersion: 1, items: 'nope' })
    evidence = await readEvidence(project)
    assert.equal(evidence.acceptance.badJson, true)
    assert.equal(evidence.degraded.flag, true)
  })
})

test('验收表超过 2 MiB：截断并 warning（随后按坏表降级）', async () => {
  await withProject(async (project) => {
    const huge = `{"schemaVersion":1,"iteration_id":null,"items":[],"pad":"${'x'.repeat(2 * 1024 * 1024)}"}`
    const path = await writeStateText(project, 'acceptance.json', huge)
    const info = await stat(path)
    assert.equal(info.size > 2 * 1024 * 1024, true, '夹具确实超过 2 MiB')

    const evidence = await readEvidence(project)
    const warning = evidence.warnings.find(
      (item) => item.source === '.dsh/plugin-state/acceptance.json' && /2 MiB/.test(item.message),
    )
    assert.ok(warning, '超限要有一条可读 warning')
    assert.equal(evidence.acceptance.badJson, true)
  })
})

test('任务表：trellis 已初始化但还没有 tasks 目录 ⇒ available=true、total=0（要能给出「拆任务」）', async () => {
  await withProject(async (project) => {
    await mkdir(join(project, '.trellis'), { recursive: true })
    await writeStateText(project, 'RULES.md', '# 规则\n')
    const evidence = await readEvidence(project)
    assert.equal(evidence.trellis.initialized, true)
    assert.deepEqual(evidence.tasks, { available: true, total: 0, open: 0, completed: 0, items: [] })
    assert.equal(evidence.degraded.flag, false)
  })
})

test('任务表：只读 id/title/status；open = 非 completed；items 最多 50 条', async () => {
  await withProject(async (project) => {
    await writeTask(project, '01-a', { id: 'T1', title: '做完的', status: 'completed', hours: 3 })
    await writeTask(project, '02-b', { id: 'T2', title: '在做的', status: 'in_progress' })
    await writeTask(project, '03-c', { id: 'T3', title: '没状态的' })

    const evidence = await readEvidence(project)
    assert.equal(evidence.tasks.available, true)
    assert.equal(evidence.tasks.total, 3)
    assert.equal(evidence.tasks.completed, 1)
    assert.equal(evidence.tasks.open, 2)
    assert.deepEqual(evidence.tasks.items, [
      { id: 'T1', title: '做完的', status: 'completed', relatedFiles: [] },
      { id: 'T2', title: '在做的', status: 'in_progress', relatedFiles: [] },
      { id: 'T3', title: '没状态的', status: 'unknown', relatedFiles: [] },
    ])
    assert.equal(evidence.degraded.flag, false)
  })
})

test('任务表：items 截断到 50，但 total/open 仍是全量', async () => {
  await withProject(async (project) => {
    for (let index = 0; index < 55; index += 1) {
      const name = String(index + 1).padStart(3, '0')
      await writeTask(project, name, {
        id: `T${index + 1}`,
        title: `任务 ${index + 1}`,
        status: index < 5 ? 'completed' : 'pending',
      })
    }
    const evidence = await readEvidence(project)
    assert.equal(evidence.tasks.total, 55)
    assert.equal(evidence.tasks.completed, 5)
    assert.equal(evidence.tasks.open, 50)
    assert.equal(evidence.tasks.items.length, 50)
    assert.equal(evidence.tasks.items[49].id, 'T50')
  })
})

test('任务卡坏 JSON：跳过该任务 + 降级，其他任务照读', async () => {
  await withProject(async (project) => {
    await writeTask(project, '01-a', { id: 'T1', title: '好任务', status: 'completed' })
    await writeText(project, '.trellis/tasks/02-b/task.json', '{ 坏 JSON')
    const evidence = await readEvidence(project)
    assert.equal(evidence.tasks.available, true)
    assert.equal(evidence.tasks.total, 1)
    assert.equal(evidence.degraded.flag, true)
    assert.equal(evidence.warnings.some((item) => item.source === '.trellis/tasks/02-b/task.json'), true)
  })
})

test('审核账本缺失：available=false, reason=no-ledger，且不算降级', async () => {
  await withProject(async (project) => {
    const evidence = await readEvidence(project)
    assert.deepEqual(evidence.review, {
      available: false,
      reason: 'no-ledger',
      rounds: null,
      blocking: null,
      fixed: null,
      lastRound: null,
      issues: [],
      blockingIssues: [],
    })
    assert.equal(evidence.degraded.flag, false)
  })
})

const LOCAL_LEDGER = '.dsh/claude-review/ledger/review'

test('本地审核账本：failOn 取 meta.failOn，处置必须轮次匹配；blocking/fixed 口径照 count.js', async () => {
  await withProject(async (project) => {
    await writeText(
      project,
      `${LOCAL_LEDGER}/history.jsonl`,
      [
        JSON.stringify({ round: 1, verdict: 'block' }),
        JSON.stringify({ round: 2, verdict: 'block' }),
      ].join('\n'),
    )
    await writeJson(project, `${LOCAL_LEDGER}/review-2.json`, {
      meta: { round: 2, failOn: ['critical', 'important'] },
      review: {
        verdict: 'block',
        issues: [
          { severity: 'critical', key: 'k1', issue: '删除会丢数据', file: 'src/a.js', line: 12 },
          { severity: 'minor', issue: '命名不一致', file: 'src/b.js', line: 3 },
          { severity: 'important', issue: '缺少测试', file: 'src/c.js', line: 7 },
          { severity: 'critical', issue: '越权访问', file: 'src/d.js', line: 9 },
        ],
      },
    })
    await writeText(
      project,
      `${LOCAL_LEDGER}/dispositions.jsonl`,
      [
        JSON.stringify({ round: 2, index: 0, status: 'fixed' }),
        JSON.stringify({ round: 2, index: 2, status: 'counter-evidence' }),
        JSON.stringify({ round: 1, index: 3, status: 'fixed' }), // 轮次不匹配 ⇒ 不算处置
      ].join('\n'),
    )

    const evidence = await readEvidence(project)
    assert.equal(evidence.review.available, true)
    assert.equal(evidence.review.reason, null)
    assert.equal(evidence.review.rounds, 2)
    assert.equal(evidence.review.lastRound, 2)
    assert.equal(evidence.review.fixed, 1, '只有 fixed 计入 fixed')
    assert.equal(evidence.review.blocking, 1, '轮次不匹配的 fixed 不能消除 blocking')
    assert.deepEqual(evidence.review.issues, [
      { severity: 'critical', title: '越权访问', file: 'src/d.js', line: 9 },
    ])
    assert.equal(evidence.degraded.flag, false)
  })
})

test('审核账本 issues 最多 3 条', async () => {
  await withProject(async (project) => {
    await writeText(project, `${LOCAL_LEDGER}/history.jsonl`, JSON.stringify({ round: 1 }))
    await writeJson(project, `${LOCAL_LEDGER}/review-1.json`, {
      meta: { round: 1 },
      review: {
        issues: Array.from({ length: 5 }, (_, index) => ({
          severity: 'critical',
          issue: `问题 ${index + 1}`,
          file: 'src/a.js',
          line: index + 1,
        })),
      },
    })
    const evidence = await readEvidence(project)
    assert.equal(evidence.review.blocking, 5)
    assert.equal(evidence.review.issues.length, 3)
  })
})

test('trellis 审核账本：auto 优先 trellis；reviewStorage 可强制选择', async () => {
  await withProject(async (project) => {
    await writeTask(project, '01-a', { id: 'T1', title: '做功能', status: 'in_progress' })
    await writeText(project, '.trellis/tasks/01-a/review/history.jsonl', JSON.stringify({ round: 1 }))
    await writeJson(project, '.trellis/tasks/01-a/review/review-1.json', {
      meta: { round: 1 },
      review: { issues: [{ severity: 'critical', issue: 'trellis 账本里的阻塞', file: 'src/x.js', line: 2 }] },
    })
    // 本地账本也存在，但 auto 应该优先 trellis。
    await writeText(project, `${LOCAL_LEDGER}/history.jsonl`, '')
    await writeJson(project, `${LOCAL_LEDGER}/review-1.json`, { meta: { round: 1 }, review: { issues: [] } })

    const auto = await readEvidence(project)
    assert.equal(auto.review.available, true)
    assert.equal(auto.review.blocking, 1)
    assert.equal(auto.review.issues[0].title, 'trellis 账本里的阻塞')

    const local = await readEvidence(project, { reviewStorage: 'local' })
    assert.equal(local.review.available, true)
    assert.equal(local.review.rounds, 0)
    assert.equal(local.review.blocking, 0)

    const trellis = await readEvidence(project, { reviewStorage: 'trellis' })
    assert.equal(trellis.review.blocking, 1)
  })
})

test('reviewStorage 强制模式：指定的存储不存在 ⇒ no-ledger，不回退另一种', async () => {
  await withProject(async (project) => {
    await writeText(project, `${LOCAL_LEDGER}/history.jsonl`, JSON.stringify({ round: 1 }))
    const evidence = await readEvidence(project, { reviewStorage: 'trellis' })
    assert.equal(evidence.review.available, false)
    assert.equal(evidence.review.reason, 'no-ledger')
    assert.equal(evidence.degraded.flag, false)
  })
})

test('审核账本坏 JSON ⇒ read-error + 降级（与 no-ledger 区分）', async () => {
  await withProject(async (project) => {
    await writeText(project, `${LOCAL_LEDGER}/history.jsonl`, '{ 坏 JSON\n')
    const evidence = await readEvidence(project)
    assert.equal(evidence.review.available, false)
    assert.equal(evidence.review.reason, 'read-error')
    assert.equal(evidence.degraded.flag, true)
    assert.equal(evidence.warnings.some((item) => item.source === `${LOCAL_LEDGER}/history.jsonl`), true)
  })
})

test('审核报告坏 JSON ⇒ read-error + 降级', async () => {
  await withProject(async (project) => {
    await writeText(project, `${LOCAL_LEDGER}/history.jsonl`, JSON.stringify({ round: 1 }))
    await writeText(project, `${LOCAL_LEDGER}/review-1.json`, '{ 坏 JSON')
    const evidence = await readEvidence(project)
    assert.equal(evidence.review.available, false)
    assert.equal(evidence.review.reason, 'read-error')
    assert.equal(evidence.degraded.flag, true)
  })
})

test('warnings / degraded 元素形状统一 {source,message}；workspace 异常也只降级不抛错', async () => {
  await withProject(async (project) => {
    await writeStateText(project, 'project.json', '{ 坏 JSON')
    await writeStateText(project, 'approvals.json', '{ 坏 JSON')
    await writeStateText(project, 'acceptance.json', '{ 坏 JSON')
    const evidence = await readEvidence(project)
    assert.equal(evidence.degraded.flag, true)
    assert.equal(evidence.warnings.length >= 3, true)
    for (const item of evidence.warnings) {
      assert.deepEqual(Object.keys(item).sort(), ['message', 'source'])
      assert.equal(typeof item.source, 'string')
      assert.equal(typeof item.message, 'string')
    }
    for (const item of evidence.degraded.reasons) {
      assert.deepEqual(Object.keys(item).sort(), ['message', 'source'])
      assert.equal(typeof item.source, 'string')
      assert.equal(typeof item.message, 'string')
    }
    assert.equal(evidence.ok, true, '单个数据源坏掉不改变 workspace 结论')
  })
})
