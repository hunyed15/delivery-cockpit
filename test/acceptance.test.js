/**
 * 验收表起草：只追加、不覆盖；坏表不碰；迭代不对不写。
 *
 * 这是"人的判断"与"Agent 的草稿"之间的边界：Agent 只能写条目骨架，
 * result/evidence 永远留给人。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acceptancePathOf,
  draftAcceptance,
  normalizeDraftItems,
  readAcceptanceFile,
} from '../lib/acceptance.js'
import { appendReceipt, stateDirOf } from '../lib/receipts.js'

async function withProject(run) {
  const project = await mkdtemp(join(tmpdir(), 'dc-acc-'))
  try {
    await run(project)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

const startIteration = (project) =>
  appendReceipt(project, {
    iteration_id: 'v1.0',
    stage: 'brainstorm',
    status: 'completed',
    summary_for_human: '需求定了',
  })

async function writeTable(project, table) {
  await mkdir(stateDirOf(project), { recursive: true })
  await writeFile(acceptancePathOf(project), JSON.stringify(table, null, 2), 'utf8')
}

const readTable = async (project) => JSON.parse(await readFile(acceptancePathOf(project), 'utf8'))

test('读验收表：missing 与 badJson 分开表达', async () => {
  await withProject(async (project) => {
    const missing = await readAcceptanceFile(project)
    assert.equal(missing.missing, true)
    assert.equal(missing.badJson, false)

    await mkdir(stateDirOf(project), { recursive: true })
    await writeFile(acceptancePathOf(project), '{ oops', 'utf8')
    const broken = await readAcceptanceFile(project)
    assert.equal(broken.badJson, true)
    assert.equal(broken.missing, false)
  })
})

test('条目校验：title 必填，feature_ref 必须是 FR-<数字>', () => {
  assert.equal(normalizeDraftItems([]).ok, false)
  assert.equal(normalizeDraftItems([{ feature_ref: 'FR-1' }]).ok, false)
  assert.equal(normalizeDraftItems([{ title: '能添加客户' }]).ok, true)
  assert.equal(normalizeDraftItems([{ title: 'x', feature_ref: 'F-1' }]).ok, false)

  const normalized = normalizeDraftItems([{ title: ' 能添加客户 ', feature_ref: 'fr-3', steps: ' 点新增 ' }])
  assert.equal(normalized.ok, true)
  assert.deepEqual(normalized.items[0], {
    feature_ref: 'FR-3',
    title: '能添加客户',
    steps: '点新增',
    expect: '',
    result: null,
    evidence: [],
    at: null,
  })
})

test('还没有迭代（bootstrap）时拒绝起草', async () => {
  await withProject(async (project) => {
    const result = await draftAcceptance(project, [{ title: '能添加客户' }])
    assert.deepEqual(result, { ok: false, error: 'iteration-required' })
  })
})

test('起草：写入骨架，result/evidence 固定留空，并按 feature_ref 挂到功能', async () => {
  await withProject(async (project) => {
    await startIteration(project)
    const result = await draftAcceptance(project, [
      { feature_ref: 'FR-1', title: '能添加客户', steps: '打开列表→新增→保存', expect: '列表出现新客户' },
      { feature_ref: 'FR-2', title: '能导入 Excel' },
    ])
    assert.equal(result.ok, true)
    assert.equal(result.added, 2)
    assert.equal(result.total, 2)
    assert.equal(result.iterationId, 'v1.0')

    const table = await readTable(project)
    assert.equal(table.iteration_id, 'v1.0')
    assert.equal(table.items.length, 2)
    assert.equal(table.items[0].feature_ref, 'FR-1')
    assert.equal(table.items[0].result, null)
    assert.deepEqual(table.items[0].evidence, [])
    assert.equal(table.items[0].id, 'A1')
    assert.equal(table.items[1].id, 'A2')
  })
})

test('重复起草同一条（同 feature_ref + title）跳过，不重复追加', async () => {
  await withProject(async (project) => {
    await startIteration(project)
    await draftAcceptance(project, [{ feature_ref: 'FR-1', title: '能添加客户' }])
    const second = await draftAcceptance(project, [{ feature_ref: 'FR-1', title: '能添加客户' }])
    assert.equal(second.ok, true)
    assert.equal(second.added, 0)
    assert.equal(second.skipped, 1)
    assert.equal(second.total, 1)
  })
})

test('绝不覆盖人的结果与证据：已有 pass+截图 的条目原样保留', async () => {
  await withProject(async (project) => {
    await startIteration(project)
    await writeTable(project, {
      schemaVersion: 1,
      iteration_id: 'v1.0',
      items: [
        { id: 'A1', feature_ref: 'FR-1', title: '能添加客户', result: 'pass', evidence: ['shots/a1.png'], at: '2026-11-21T00:00:00.000Z' },
      ],
    })
    const result = await draftAcceptance(project, [
      { feature_ref: 'FR-1', title: '能添加客户' },
      { feature_ref: 'FR-2', title: '能导入 Excel' },
    ])
    assert.equal(result.added, 1)
    assert.equal(result.skipped, 1)

    const table = await readTable(project)
    const kept = table.items.find((item) => item.id === 'A1')
    assert.equal(kept.result, 'pass')
    assert.deepEqual(kept.evidence, ['shots/a1.png'])
    const added = table.items.find((item) => item.feature_ref === 'FR-2')
    assert.equal(added.id, 'A2')
    assert.equal(added.result, null)
  })
})

test('新条目 id 不与已有 id 冲突', async () => {
  await withProject(async (project) => {
    await startIteration(project)
    await writeTable(project, {
      schemaVersion: 1,
      iteration_id: 'v1.0',
      items: [{ id: 'A1', feature_ref: 'FR-1', title: '旧条目', result: 'fail', evidence: [] }],
    })
    await draftAcceptance(project, [
      { feature_ref: 'FR-2', title: '新条目一' },
      { feature_ref: 'FR-3', title: '新条目二' },
    ])
    const table = await readTable(project)
    const ids = table.items.map((item) => item.id)
    assert.deepEqual(ids, ['A1', 'A2', 'A3'])
  })
})

test('坏验收表拒绝起草（不覆盖、不猜）', async () => {
  await withProject(async (project) => {
    await startIteration(project)
    await mkdir(stateDirOf(project), { recursive: true })
    await writeFile(acceptancePathOf(project), '{ not json', 'utf8')
    const result = await draftAcceptance(project, [{ title: '能添加客户' }])
    assert.deepEqual(result, { ok: false, error: 'acceptance-broken' })
    assert.equal(await readFile(acceptancePathOf(project), 'utf8'), '{ not json')
  })
})

test('验收表属于别的迭代时拒绝起草', async () => {
  await withProject(async (project) => {
    await startIteration(project)
    await writeTable(project, { schemaVersion: 1, iteration_id: 'v0.9', items: [] })
    const result = await draftAcceptance(project, [{ title: '能添加客户' }])
    assert.equal(result.ok, false)
    assert.equal(result.error, 'iteration-mismatch')
    assert.equal(result.iterationId, 'v0.9')
  })
})

test('null 迭代的旧表会被绑定到当前迭代', async () => {
  await withProject(async (project) => {
    await startIteration(project)
    await writeTable(project, { schemaVersion: 1, iteration_id: null, items: [] })
    const result = await draftAcceptance(project, [{ title: '能添加客户' }])
    assert.equal(result.ok, true)
    const table = await readTable(project)
    assert.equal(table.iteration_id, 'v1.0')
  })
})
