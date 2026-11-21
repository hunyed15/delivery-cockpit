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
  normalizeEvidence,
  readAcceptanceFile,
  setAcceptanceResult,
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

/** 写一张带一条待验条目的表，并可选地放一张真实截图。 */
async function seedTable(project, withShot = false) {
  await startIteration(project)
  await writeTable(project, {
    schemaVersion: 1,
    iteration_id: 'v1.0',
    items: [{ id: 'A1', feature_ref: 'FR-1', title: '能添加客户', steps: '点新增', expect: '列表出现', result: null, evidence: [], at: null }],
  })
  if (withShot) {
    await mkdir(join(project, 'shots'), { recursive: true })
    await writeFile(join(project, 'shots', 'a1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  }
}

test('撤销必须无条件成功：即使旧证据文件已经被删掉', async () => {
  await withProject(async (project) => {
    await seedTable(project, true)
    await setAcceptanceResult(project, { item_id: 'A1', result: 'pass', evidence: ['shots/a1.png'] })
    // 人删了截图/改了名——撤销不该被"证据文件不存在"拦死
    await rm(join(project, 'shots', 'a1.png'), { force: true })
    const cleared = await setAcceptanceResult(project, { item_id: 'A1', result: null, evidence: ['shots/a1.png'] })
    assert.equal(cleared.ok, true)
    assert.equal(cleared.item.result, null)
    assert.deepEqual(cleared.item.evidence, [])
    assert.equal(cleared.item.at, null)
  })
})

test('失败/阻塞的证据只是备注：旧文件被删也能改判（pass 仍严格要求存在）', async () => {
  await withProject(async (project) => {
    await seedTable(project, true)
    await setAcceptanceResult(project, { item_id: 'A1', result: 'pass', evidence: ['shots/a1.png'] })
    await rm(join(project, 'shots', 'a1.png'), { force: true })

    const failed = await setAcceptanceResult(project, { item_id: 'A1', result: 'fail', evidence: ['shots/a1.png'] })
    assert.equal(failed.ok, true, '改判为失败不该被旧证据文件卡住')
    assert.equal(failed.item.result, 'fail')

    // 但通过仍然要求证据真实存在
    const blocked = await setAcceptanceResult(project, { item_id: 'A1', result: 'pass', evidence: ['shots/a1.png'] })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.error, 'evidence-not-found')
  })
})

test('填结果：漏传 result 字段必须拒绝（≠ 撤销），不能静默擦掉已填结果', async () => {
  await withProject(async (project) => {
    await seedTable(project, true)
    await setAcceptanceResult(project, { item_id: 'A1', result: 'pass', evidence: ['shots/a1.png'] })
    const before = await readFile(acceptancePathOf(project), 'utf8')

    const missing = await setAcceptanceResult(project, { item_id: 'A1' })
    assert.deepEqual(missing, { ok: false, error: 'bad-result' })
    assert.equal(await readFile(acceptancePathOf(project), 'utf8'), before, '请求非法时一个字节都不许改')
  })
})

test('填结果：通过必须附证据，且证据文件必须真实存在', async () => {
  await withProject(async (project) => {
    await seedTable(project)
    assert.deepEqual(await setAcceptanceResult(project, { item_id: 'A1', result: 'pass' }), {
      ok: false,
      error: 'evidence-required',
    })
    const missing = await setAcceptanceResult(project, { item_id: 'A1', result: 'pass', evidence: ['shots/nope.png'] })
    assert.equal(missing.ok, false)
    assert.equal(missing.error, 'evidence-not-found')

    // 路径穿越也要拒绝：证据只能来自项目内
    const traversal = await setAcceptanceResult(project, { item_id: 'A1', result: 'pass', evidence: ['../outside.png'] })
    assert.equal(traversal.ok, false)
    assert.equal(traversal.error, 'evidence-not-found')
  })
})

test('填结果：通过 + 真实截图 ⇒ pass 落盘并归一化证据路径', async () => {
  await withProject(async (project) => {
    await seedTable(project, true)
    const result = await setAcceptanceResult(project, {
      item_id: 'A1',
      result: 'pass',
      evidence: [join('.', 'shots', 'a1.png')],
    })
    assert.equal(result.ok, true)
    assert.equal(result.item.result, 'pass')
    assert.deepEqual(result.item.evidence, ['shots/a1.png'])
    assert.equal(typeof result.item.at, 'string')

    const table = await readTable(project)
    assert.equal(table.items[0].result, 'pass')
    assert.deepEqual(table.items[0].evidence, ['shots/a1.png'])
  })
})

test('填结果：http(s) URL 可当证据（比如预览链接）', async () => {
  await withProject(async (project) => {
    await seedTable(project)
    const result = await setAcceptanceResult(project, {
      item_id: 'A1',
      result: 'pass',
      evidence: ['https://example.com/preview'],
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.item.evidence, ['https://example.com/preview'])
  })
})

test('填结果：失败/阻塞不强制证据；撤销会清空结果与证据', async () => {
  await withProject(async (project) => {
    await seedTable(project, true)
    const failed = await setAcceptanceResult(project, { item_id: 'A1', result: 'fail' })
    assert.equal(failed.ok, true)
    assert.equal(failed.item.result, 'fail')
    assert.deepEqual(failed.item.evidence, [])

    const passed = await setAcceptanceResult(project, { item_id: 'A1', result: 'pass', evidence: ['shots/a1.png'] })
    assert.equal(passed.ok, true)

    const cleared = await setAcceptanceResult(project, { item_id: 'A1', result: null })
    assert.equal(cleared.ok, true)
    assert.equal(cleared.item.result, null)
    assert.deepEqual(cleared.item.evidence, [], '撤销要连证据一起清掉，否则会出现"未验但有证据"的怪状态')
    assert.equal(cleared.item.at, null)

    const table = await readTable(project)
    assert.equal(table.items[0].result, null)
    assert.equal(table.items[0].title, '能添加客户', '撤销只动结果，不动条目本身')
  })
})

test('填结果：非法枚举、条目不存在、迭代不匹配、坏表都明确报错', async () => {
  await withProject(async (project) => {
    await seedTable(project)
    assert.deepEqual(await setAcceptanceResult(project, { item_id: 'A1', result: 'done' }), { ok: false, error: 'bad-result' })
    assert.deepEqual(await setAcceptanceResult(project, { item_id: '', result: 'fail' }), { ok: false, error: 'item-required' })
    assert.deepEqual(await setAcceptanceResult(project, { item_id: 'A9', result: 'fail' }), { ok: false, error: 'item-not-found' })

    await writeTable(project, { schemaVersion: 1, iteration_id: 'v0.9', items: [{ id: 'A1', title: 'x' }] })
    const mismatch = await setAcceptanceResult(project, { item_id: 'A1', result: 'fail' })
    assert.equal(mismatch.ok, false)
    assert.equal(mismatch.error, 'iteration-mismatch')

    await writeFile(acceptancePathOf(project), '{ broken', 'utf8')
    const broken = await setAcceptanceResult(project, { item_id: 'A1', result: 'fail' })
    assert.equal(broken.ok, false)
    assert.equal(broken.error, 'acceptance-broken')
  })
})

test('填结果：没有验收表时是 item-not-found；bootstrap 阶段拒绝', async () => {
  await withProject(async (project) => {
    await startIteration(project)
    await mkdir(stateDirOf(project), { recursive: true })
    const noTable = await setAcceptanceResult(project, { item_id: 'A1', result: 'fail' })
    assert.equal(noTable.ok, false)
    assert.equal(noTable.error, 'item-not-found')
  })
  await withProject(async (project) => {
    const result = await setAcceptanceResult(project, { item_id: 'A1', result: 'fail' })
    assert.deepEqual(result, { ok: false, error: 'iteration-required' })
  })
})

test('normalizeEvidence：空数组合法、非字符串拒绝、超过上限截断', async () => {
  await withProject(async (project) => {
    assert.deepEqual(await normalizeEvidence(project, []), { ok: true, evidence: [] })
    assert.deepEqual(await normalizeEvidence(project, ['  ']), { ok: true, evidence: [] })
    assert.equal((await normalizeEvidence(project, [42])).error, 'bad-evidence')

    const many = Array.from({ length: 25 }, (_, index) => `https://example.com/${index}`)
    const capped = await normalizeEvidence(project, many)
    assert.equal(capped.ok, true)
    assert.equal(capped.evidence.length, 20)
  })
})
