import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BOOTSTRAP_ITERATION,
  appendReceipt,
  currentIteration,
  pendingDecision,
  readReceipts,
  receiptsPathOf,
  stageStates,
  stateDirOf,
  validateReceipt,
} from '../lib/cockpit/receipts.js'

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

test('校验：coding 阶段必须带 task_ref 与 write_scope', () => {
  const result = validateReceipt({ ...base, stage: 'coding' })
  assert.equal(result.ok, false)
  assert.match(result.error, /task_ref/)
  assert.match(result.error, /write_scope/)
  const ok = validateReceipt({ ...base, stage: 'coding', task_ref: 'T1', write_scope: ['web/**'] })
  assert.equal(ok.ok, true)
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
})

test('阶段状态只取指定迭代的最新值', () => {
  const states = stageStates(
    [
      { iteration_id: 'v1.0', stage: 'coding', status: 'in_progress', at: '1' },
      { iteration_id: 'v1.0', stage: 'coding', status: 'completed', at: '2' },
      { iteration_id: 'v1.1', stage: 'coding', status: 'in_progress', at: '3' },
    ],
    'v1.0',
  )
  assert.equal(states.get('coding').status, 'completed')
  assert.equal(states.size, 1)
})
