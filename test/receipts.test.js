import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BOOTSTRAP_ITERATION,
  LEGACY_STAGE_ALIASES,
  MAX_RECEIPT_BYTES,
  appendReceipt,
  currentIteration,
  isAuditReceipt,
  normalizeStage,
  pendingDecision,
  readReceipts,
  readReceiptsFromText,
  receiptsForIteration,
  receiptsPathOf,
  stageStates,
  stateDirOf,
  validateReceipt,
} from '../lib/receipts.js'
import { deriveDecision } from '../lib/state.js'

const base = { iteration_id: 'v1.0', stage: 'brainstorm', status: 'completed', summary_for_human: '需求定了' }

test('校验：缺必填字段时逐条报出', () => {
  const result = validateReceipt({})
  assert.equal(result.ok, false)
  assert.match(result.error, /iteration_id/)
  assert.match(result.error, /summary_for_human/)
})

test('校验：stage / status 必须是枚举值', () => {
  assert.equal(validateReceipt({ ...base, stage: 'deploy' }).ok, false)
  assert.equal(validateReceipt({ ...base, status: 'done' }).ok, false)
})

test('normalizeStage / LEGACY_STAGE_ALIASES：旧 id 归一到 canonical，未知不猜', () => {
  const expected = {
    init: 'bootstrap',
    scaffold: 'bootstrap',
    brainstorm: 'requirements',
    prototype: 'prototype',
    coding: 'implementation',
    code_review: 'code-review',
    verification: 'acceptance',
    release: 'release',
  }
  assert.deepEqual(LEGACY_STAGE_ALIASES, expected)
  for (const [legacy, canonical] of Object.entries(expected)) {
    assert.equal(normalizeStage(legacy), canonical, `${legacy} 应归一为 ${canonical}`)
  }
  for (const canonical of ['bootstrap', 'requirements', 'architecture', 'prototype', 'implementation', 'testing', 'code-review', 'acceptance', 'release']) {
    assert.equal(normalizeStage(canonical), canonical, 'canonical id 原样返回')
  }
  assert.equal(normalizeStage('deploy'), null, '未知 stage 不猜')
  assert.equal(normalizeStage(null), null)
  assert.equal(normalizeStage(42), null)
})

test('校验：implementation 阶段必须带 task_ref 与 write_scope（旧 coding 别名同样）', () => {
  const result = validateReceipt({ ...base, stage: 'implementation' })
  assert.equal(result.ok, false)
  assert.match(result.error, /task_ref/)
  assert.match(result.error, /write_scope/)
  const ok = validateReceipt({ ...base, stage: 'implementation', task_ref: 'T1', write_scope: ['web/**'] })
  assert.equal(ok.ok, true)
  assert.equal(ok.value.stage, 'implementation')

  const legacy = validateReceipt({ ...base, stage: 'coding', task_ref: 'T1', write_scope: ['web/**'] })
  assert.equal(legacy.ok, true, '旧 coding 别名应归一后按 implementation 校验')
  assert.equal(legacy.value.stage, 'implementation')
})

test('校验：needs_human_decision 必须有 title', () => {
  const result = validateReceipt({ ...base, needs_human_decision: { options: ['A', 'B'] } })
  assert.equal(result.ok, false)
  assert.match(result.error, /title/)
})

test('校验：通过的条目被规整（补 at、规范空值）', () => {
  const result = validateReceipt(base)
  assert.equal(result.ok, true)
  assert.equal(result.value.task_ref, null)
  assert.deepEqual(result.value.write_scope, [])
  assert.equal(typeof result.value.at, 'string')
})

test('写入与读取：一个来回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'readme-'))
  try {
    const written = await appendReceipt(dir, base)
    assert.equal(written.ok, true)
    assert.match(written.receipt.id, /^r-/)

    const read = await readReceipts(dir)
    assert.equal(read.receipts.length, 1)
    assert.equal(read.badLines, 0)
    assert.equal(read.receipts[0].summary_for_human, '需求定了')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('坏行被跳过并计数，不影响好行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'readme-'))
  try {
    await appendReceipt(dir, base)
    const path = receiptsPathOf(dir)
    const good = await readFile(path, 'utf8')
    await writeFile(path, `${good}{ this is not json\n${good}`, 'utf8')

    const read = await readReceipts(dir)
    assert.equal(read.badLines, 1)
    assert.equal(read.receipts.length, 2, '两行好数据都要读到')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('没有账本时返回 missing，而不是抛错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'readme-'))
  try {
    const read = await readReceipts(dir)
    assert.equal(read.missing, true)
    assert.deepEqual(read.receipts, [])
    assert.equal(stateDirOf(dir).endsWith(join('.dsh', 'plugin-state')), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('当前迭代忽略 bootstrap', () => {
  const receipts = [
    { iteration_id: BOOTSTRAP_ITERATION, stage: 'init', status: 'completed' },
    { iteration_id: 'v1.0', stage: 'brainstorm', status: 'completed' },
  ]
  assert.equal(currentIteration(receipts), 'v1.0')
  assert.equal(currentIteration([receipts[0]]), BOOTSTRAP_ITERATION)
})

test('待人工决策：最新一条且之后没有同迭代回执才算未解决', () => {
  const decision = {
    iteration_id: 'v1.0',
    stage: 'brainstorm',
    status: 'in_progress',
    summary_for_human: 'A 还是 B？',
    needs_human_decision: { title: '登录方式', options: ['手机号', '邮箱'] },
  }
  assert.equal(pendingDecision([decision])?.summary_for_human, 'A 还是 B？')

  const resolved = [decision, { iteration_id: 'v1.0', stage: 'brainstorm', status: 'completed', summary_for_human: '选了手机号' }]
  assert.equal(pendingDecision(resolved), null, '同迭代有新回执视为已处理')

  const otherIteration = [decision, { iteration_id: 'v1.1', stage: 'brainstorm', status: 'in_progress', summary_for_human: '新一轮' }]
  assert.ok(pendingDecision(otherIteration), '别的迭代不该把待决策冲掉')

  // 审计事件（验收失效留痕）不能把待决策静默吞掉：它不是有人处理了决策。
  const auditAfterDecision = [
    decision,
    { iteration_id: 'v1.0', stage: 'verification', status: 'in_progress', event: 'acceptance-stale', summary_for_human: '验收失效' },
  ]
  assert.equal(pendingDecision(auditAfterDecision)?.summary_for_human, 'A 还是 B？', '审计回执不该清掉待决策')

  // 审计回执之后再出现真正的进度回执，才算决策被接走
  const progressAfterAudit = [
    decision,
    { iteration_id: 'v1.0', stage: 'verification', status: 'in_progress', event: 'acceptance-stale', summary_for_human: '验收失效' },
    { iteration_id: 'v1.0', stage: 'brainstorm', status: 'completed', summary_for_human: '选了手机号' },
  ]
  assert.equal(pendingDecision(progressAfterAudit), null)
})

test('阶段状态只取指定迭代的最新值；旧 stage 也落在 canonical 键上', () => {
  const states = stageStates(
    [
      { iteration_id: 'v1.0', stage: 'coding', status: 'in_progress', at: '1' },
      { iteration_id: 'v1.0', stage: 'coding', status: 'completed', at: '2' },
      { iteration_id: 'v1.1', stage: 'coding', status: 'in_progress', at: '3' },
      { iteration_id: 'v1.0', stage: 'verification', status: 'completed', at: '4' },
    ],
    'v1.0',
  )
  // 旧 coding 归一为 implementation、旧 verification 归一为 acceptance：不再各占一个新键。
  assert.equal(states.get('implementation').status, 'completed')
  assert.equal(states.get('acceptance').status, 'completed')
  assert.equal(states.has('coding'), false)
  assert.equal(states.has('verification'), false)
  assert.equal(states.size, 2)
})

test('readReceiptsFromText：与 readReceipts 的解析口径完全一致', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'readme-'))
  try {
    await appendReceipt(dir, base)
    await appendReceipt(dir, { ...base, stage: 'coding', task_ref: 'T1', write_scope: ['web/**'] })
    const path = receiptsPathOf(dir)
    const text = await readFile(path, 'utf8')
    await writeFile(path, `${text}{ broken\n`, 'utf8')

    const fromText = readReceiptsFromText(await readFile(path, 'utf8'))
    const fromFile = await readReceipts(dir)
    assert.equal(fromText.badLines, fromFile.badLines)
    assert.deepEqual(fromText.receipts, fromFile.receipts)
    assert.equal(fromText.lastAt, fromFile.lastAt)
    assert.equal(fromText.lastAt, fromText.receipts.at(-1).at)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readReceiptsFromText：认 CRLF 跳过空行，坏 JSON 计数', () => {
  const good = JSON.stringify({ iteration_id: 'v1.0', stage: 'release', status: 'completed', at: '2026-11-20T00:00:00.000Z' })
  const parsed = readReceiptsFromText(`\r\n${good}\r\n\r\nnot-json\r\n${good}\r\n`)
  assert.equal(parsed.receipts.length, 2)
  assert.equal(parsed.badLines, 1)
  assert.equal(parsed.lastAt, '2026-11-20T00:00:00.000Z')
  assert.deepEqual(readReceiptsFromText(''), { receipts: [], badLines: 0, lastAt: null })
})

test('receiptsForIteration：只取该迭代的全部回执，且保持输入顺序', () => {
  const receipts = [
    { iteration_id: 'v1.0', stage: 'brainstorm', at: '1' },
    { iteration_id: 'v1.1', stage: 'brainstorm', at: '2' },
    { iteration_id: 'v1.0', stage: 'coding', at: '3' },
    { iteration_id: 'v1.0', stage: 'release', at: '4' },
  ]
  const picked = receiptsForIteration(receipts, 'v1.0')
  assert.equal(picked.length, 3)
  assert.deepEqual(picked.map((item) => item.at), ['1', '3', '4'])
  assert.deepEqual(receiptsForIteration(receipts, 'v2.0'), [])
  assert.deepEqual(receiptsForIteration(receipts, ''), [], '空迭代号不匹配任何回执，不猜')
})

test('账本超过 2 MiB 时只读尾部：截断的半行不算坏行，最新回执仍在', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'readme-'))
  try {
    const lines = []
    let size = 0
    while (size <= MAX_RECEIPT_BYTES + 4096) {
      const line = JSON.stringify({
        id: `r-${lines.length}`,
        at: '2026-11-20T10:00:00.000Z',
        iteration_id: 'v1.0',
        stage: 'coding',
        status: 'completed',
        summary_for_human: `第 ${lines.length} 条`,
        task_ref: 'T1',
        write_scope: ['web/**'],
      })
      lines.push(line)
      size += Buffer.byteLength(line) + 1
    }
    await mkdir(stateDirOf(dir), { recursive: true })
    await writeFile(receiptsPathOf(dir), `${lines.join('\n')}\n`, 'utf8')

    const read = await readReceipts(dir)
    assert.equal(read.truncated, true, '超限必须如实标记 truncated')
    assert.equal(read.missing, false)
    assert.ok(read.receipts.length > 0)
    assert.ok(read.receipts.length < lines.length, '确实只读了一部分')
    assert.equal(read.badLines, 0, '截断点丢掉的半行不能算坏行')
    assert.equal(read.receipts[read.receipts.length - 1].summary_for_human, `第 ${lines.length - 1} 条`, '最新回执必须读到')

    // 纯函数解析同一份文本时不截断，证明差异来自"读尾部"而不是解析口径变了
    const full = readReceiptsFromText(lines.join('\n'))
    assert.equal(full.receipts.length, lines.length)
    assert.equal(full.badLines, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('没超限时 truncated=false，读取口径不变', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'readme-'))
  try {
    await appendReceipt(dir, base)
    const read = await readReceipts(dir)
    assert.equal(read.truncated, false)
    assert.equal(read.receipts.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('event：只接受登记过的审计事件；普通回执 event 为 null；旧 verification 归一到 acceptance', () => {
  assert.equal(
    validateReceipt({
      iteration_id: 'v1.0',
      stage: 'acceptance',
      status: 'in_progress',
      summary_for_human: 'x',
      event: 'acceptance-stale',
    }).value.event,
    'acceptance-stale',
  )
  // 旧账本里的 verification 经 normalize 后同样是 acceptance，写入仍兼容。
  const legacy = validateReceipt({
    iteration_id: 'v1.0',
    stage: 'verification',
    status: 'in_progress',
    summary_for_human: 'x',
    event: 'acceptance-stale',
  })
  assert.equal(legacy.ok, true)
  assert.equal(legacy.value.stage, 'acceptance')
  assert.equal(validateReceipt(base).value.event, null)
  assert.equal(validateReceipt({ ...base, event: 'typo-event' }).ok, false)
  assert.equal(validateReceipt({ ...base, event: '' }).ok, false)
  assert.equal(validateReceipt({ ...base, event: 42 }).ok, false)
})

test('验收复核（acceptance-recheck）：必须 stage=acceptance / status=completed', () => {
  const recheck = { iteration_id: 'v1.0', stage: 'acceptance', status: 'completed', summary_for_human: '复核 A1：仍通过', event: 'acceptance-recheck' }
  assert.equal(validateReceipt(recheck).ok, true)
  assert.equal(validateReceipt(recheck).value.event, 'acceptance-recheck')

  // 旧 verification 仍接受，但落盘归一成 acceptance（不制造第二套阶段键）。
  const legacy = validateReceipt({ ...recheck, stage: 'verification' })
  assert.equal(legacy.ok, true)
  assert.equal(legacy.value.stage, 'acceptance')

  // 错误组合必须拒绝（防止伪装成别的阶段进度）
  assert.equal(validateReceipt({ ...recheck, stage: 'implementation' }).ok, false)
  assert.equal(validateReceipt({ ...recheck, status: 'in_progress' }).ok, false)
  // 失效留痕的配对也锁死
  assert.equal(validateReceipt({ ...recheck, event: 'acceptance-stale' }).ok, false)
  assert.equal(
    validateReceipt({ ...recheck, status: 'in_progress' }).error,
    'acceptance-recheck 回执必须是 stage=acceptance / status=completed',
  )

  // 审计回执自己也不能挂待决策（写入口拦截 + 判定兜底）
  assert.equal(
    validateReceipt({
      iteration_id: 'v1.0',
      stage: 'acceptance',
      status: 'completed',
      summary_for_human: 'x',
      event: 'acceptance-recheck',
      needs_human_decision: { title: '要不要重做？' },
    }).ok,
    false,
  )
  assert.equal(
    pendingDecision([
      {
        iteration_id: 'v1.0',
        stage: 'acceptance',
        status: 'completed',
        event: 'acceptance-recheck',
        summary_for_human: '手改账本',
        needs_human_decision: { title: '假决策' },
      },
    ]),
    null,
  )
})

test('审计事件不参与阶段进度投影（stageStates 跳过）', () => {
  const receipts = [
    { iteration_id: 'v1.0', stage: 'acceptance', status: 'completed', at: '1' },
    { iteration_id: 'v1.0', stage: 'acceptance', status: 'in_progress', at: '2', event: 'acceptance-stale' },
    // 旧账本里的 verification 审计回执：归一到 acceptance 后同样必须跳过。
    { iteration_id: 'v1.0', stage: 'verification', status: 'in_progress', at: '3', event: 'acceptance-stale' },
  ]
  const states = stageStates(receipts, 'v1.0')
  assert.equal(states.get('acceptance').status, 'completed', '审计回执不能把阶段打回进行中')
  assert.equal(states.has('verification'), false, '旧 id 不新建阶段键')
  assert.equal(isAuditReceipt(receipts[1]), true)
  assert.equal(isAuditReceipt(receipts[0]), false)
  // 与写入口共用白名单：手改进来的未知 event 不算审计（validateReceipt 本来也会拒绝写入它）
  assert.equal(isAuditReceipt({ event: 'typo-event' }), false)
  assert.equal(isAuditReceipt({ event: 42 }), false)
})

test('旧账本兼容：旧 stage 写入/读取都投影为 canonical，released 仍成立', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'readme-legacy-'))
  try {
    await mkdir(stateDirOf(dir), { recursive: true })
    const legacyLines = [
      { id: 'r-1', at: '2026-11-20T10:00:00.000Z', iteration_id: 'bootstrap', stage: 'init', status: 'completed', summary_for_human: '建好了' },
      { id: 'r-2', at: '2026-11-20T10:01:00.000Z', iteration_id: 'v1.0', stage: 'coding', status: 'completed', summary_for_human: '写完了', task_ref: 'T1', write_scope: ['web/**'] },
      { id: 'r-3', at: '2026-11-20T10:02:00.000Z', iteration_id: 'v1.0', stage: 'verification', status: 'completed', summary_for_human: '验过了' },
      { id: 'r-4', at: '2026-11-20T10:03:00.000Z', iteration_id: 'v1.0', stage: 'release', status: 'completed', summary_for_human: '发了' },
    ]
    await writeFile(receiptsPathOf(dir), `${legacyLines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')

    const read = await readReceipts(dir)
    assert.equal(read.badLines, 0, '旧阶段名不是坏行')
    assert.deepEqual(read.receipts.map((item) => item.stage), ['bootstrap', 'implementation', 'acceptance', 'release'])

    const states = stageStates(read.receipts, 'v1.0')
    assert.equal(states.get('implementation').status, 'completed')
    assert.equal(states.get('acceptance').status, 'completed')

    // 旧账本喂给状态机：当前迭代已有 release completed ⇒ 仍认作"已发布"。
    const decision = deriveDecision({
      iteration: { current: 'v1.0' },
      receipts: { receipts: read.receipts },
      trellis: { initialized: true },
      prd: { found: true },
      approval: { approved: true },
      tasks: { available: true, total: 1, open: 0 },
      review: { available: true, rounds: 1, blocking: 0, fixed: 0 },
      acceptance: {
        items: [{ id: 'A1', result: 'pass', evidence: ['shots/a1.png'] }],
        empty: false,
        total: 1,
        withResult: 1,
        passed: 1,
        failed: 0,
        blocked: 0,
        passWithoutEvidence: 0,
        stale: 0,
        appliesToCurrent: true,
      },
    })
    assert.equal(decision.kind, 'next-iteration', 'released() 应仍认旧账本里的 release 回执')
    assert.equal(decision.stageId, 'release')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('feature_ids：可选，给了必须是字符串数组，落盘统一大写去空格', () => {
  const ok = validateReceipt({ ...base, feature_ids: [' fr-1 ', 'FR-2'] })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.value.feature_ids, ['FR-1', 'FR-2'])

  // 可选：不传就是空数组（不是 undefined），下游不用到处判空
  assert.deepEqual(validateReceipt(base).value.feature_ids, [])

  // 给了就必须干净：字符串、非空、数组
  assert.equal(validateReceipt({ ...base, feature_ids: 'FR-1' }).ok, false)
  assert.equal(validateReceipt({ ...base, feature_ids: [1] }).ok, false)
  assert.equal(validateReceipt({ ...base, feature_ids: [''] }).ok, false)
})
