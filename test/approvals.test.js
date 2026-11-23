import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, access, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  approvalFor,
  approvalsPathOf,
  approveDecision,
  approvePrototype,
  decisionsFor,
  findPrototype,
  readApprovals,
} from '../lib/approvals.js'

const exists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function withProject(run) {
  const project = await mkdtemp(join(tmpdir(), 'dc-approve-'))
  try {
    await run(project)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

const noDecisions = () => ({
  scope: { approved: false, at: null },
  architecture: { approved: false, at: null },
  acceptance: { approved: false, at: null },
  release: { approved: false, at: null },
})

/** 各前置对应的最小夹具：只写让门通过所需的那几个文件。 */
async function writePrd(project) {
  await writeFile(join(project, 'prd.md'), '# 客户管理\n\n## 功能需求\n', 'utf8')
}

async function writeArchitecture(project) {
  await mkdir(join(project, 'docs'), { recursive: true })
  await writeFile(
    join(project, 'docs', 'architecture.md'),
    '# 架构\n\n## 组件\nWeb\n\n## 数据模型\nCustomer\n\n## 接口清单\nGET /customers\n\n## 关键决策\n单体优先\n',
    'utf8',
  )
  await writeFile(join(project, 'docs', 'api.md'), '# API\n\nGET /customers\n', 'utf8')
}

async function writeAcceptance(project, items) {
  await mkdir(join(project, '.dsh', 'plugin-state'), { recursive: true })
  await writeFile(
    join(project, '.dsh', 'plugin-state', 'acceptance.json'),
    JSON.stringify({ schemaVersion: 1, iteration_id: 'v1.0', items }),
    'utf8',
  )
}

const passItems = () => [{ id: 'A1', title: '能添加客户', result: 'pass', evidence: ['shots/add.png'] }]

async function writeRelease(project) {
  await mkdir(join(project, '.dsh', 'plugin-state'), { recursive: true })
  await writeFile(
    join(project, '.dsh', 'plugin-state', 'release.json'),
    JSON.stringify({ version: 'v1.0', artifacts: ['dist/app.zip'], rollback: 'git revert v1.0', at: '2026-11-22T00:00:00.000Z' }),
    'utf8',
  )
}

async function storedEntry(project, iterationId = 'v1.0') {
  const stored = JSON.parse(await readFile(approvalsPathOf(project), 'utf8'))
  return stored[iterationId]
}

test('没有 approvals.json 时是 missing，不是报错', async () => {
  await withProject(async (project) => {
    const read = await readApprovals(project)
    assert.deepEqual(read.map, {})
    assert.equal(read.missing, true)
    assert.equal(read.badJson, false)
  })
})

test('坏 JSON 标记 badJson，且不伪造任何批准', async () => {
  await withProject(async (project) => {
    await writeFile(join(project, 'prototype.html'), '<html></html>', 'utf8')
    await approvePrototype(project, 'v1.0')
    await writeFile(approvalsPathOf(project), '{ not json', 'utf8')
    const read = await readApprovals(project)
    assert.equal(read.badJson, true)
    assert.deepEqual(read.map, {})
    assert.equal(approvalFor(read.map, 'v1.0').approved, false)
  })
})

test('没有迭代号或 bootstrap 不能批准', async () => {
  await withProject(async (project) => {
    await writeFile(join(project, 'prototype.html'), '<html></html>', 'utf8')
    assert.deepEqual(await approvePrototype(project, ''), { ok: false, error: 'iteration-required' })
    assert.deepEqual(await approvePrototype(project, '  '), { ok: false, error: 'iteration-required' })
    assert.deepEqual(await approvePrototype(project, 'bootstrap'), { ok: false, error: 'iteration-required' })
    assert.equal(await exists(approvalsPathOf(project)), false)
  })
})

test('没有原型 HTML 时拒绝批准（没有依据的通行证不发）', async () => {
  await withProject(async (project) => {
    assert.deepEqual(await approvePrototype(project, 'v1.0'), { ok: false, error: 'prototype-missing' })
    assert.equal(await exists(approvalsPathOf(project)), false)
  })
})

test('批准按 iteration_id 落盘，v1.1 不会误读成已通过（设计里最容易踩的坑）', async () => {
  await withProject(async (project) => {
    await writeFile(join(project, 'prototype.html'), '<html></html>', 'utf8')
    const result = await approvePrototype(project, 'v1.0')
    assert.equal(result.ok, true)
    assert.equal(result.approval.iterationId, 'v1.0')
    assert.equal(result.approval.prototype, 'prototype.html')

    const stored = JSON.parse(await readFile(approvalsPathOf(project), 'utf8'))
    assert.equal(typeof stored['v1.0'].prototypeApprovedAt, 'string')
    assert.equal(stored['v1.0'].prototype, 'prototype.html')

    const read = await readApprovals(project)
    assert.deepEqual(approvalFor(read.map, 'v1.0'), {
      approved: true,
      at: stored['v1.0'].prototypeApprovedAt,
      file: 'prototype.html',
    })
    assert.deepEqual(approvalFor(read.map, 'v1.1'), { approved: false, at: null, file: null })
    assert.deepEqual(approvalFor(read.map, 'bootstrap'), { approved: false, at: null, file: null })
  })
})

test('docs/prototype.html 也算原型，且路径统一成正斜杠', async () => {
  await withProject(async (project) => {
    await mkdir(join(project, 'docs'), { recursive: true })
    await writeFile(join(project, 'docs', 'prototype.html'), '<html></html>', 'utf8')
    assert.equal(await findPrototype(project), 'docs/prototype.html')
    const result = await approvePrototype(project, 'v1.0')
    assert.equal(result.ok, true)
    assert.equal(result.approval.prototype, 'docs/prototype.html')
  })
})

test('重复批准同一迭代只更新时间，不产生第二份记录', async () => {
  await withProject(async (project) => {
    await writeFile(join(project, 'prototype.html'), '<html></html>', 'utf8')
    await approvePrototype(project, 'v1.0')
    const stored = JSON.parse(await readFile(approvalsPathOf(project), 'utf8'))
    assert.deepEqual(Object.keys(stored), ['v1.0'])
  })
})

// ---------- P1 决策门：decisionsFor / approveDecision ----------

test('decisionsFor：bootstrap / 空迭代 / 缺条目都给全 false，且形状固定', async () => {
  const map = {
    'v1.0': {
      prototypeApprovedAt: '2026-11-20T22:10:00+08:00',
      prototype: 'prototype.html',
      scopeApprovedAt: '2026-11-20T22:20:00+08:00',
    },
  }
  for (const iterationId of ['', 'bootstrap', 'v9.9', null, undefined]) {
    assert.deepEqual(decisionsFor(map, iterationId), noDecisions(), `迭代 ${iterationId} 应为全 false`)
  }
  assert.deepEqual(decisionsFor({}, 'v1.0'), noDecisions())
  assert.deepEqual(decisionsFor(null, 'v1.0'), noDecisions())
  // 条目存在：签了的门给 at，没签的门仍然是 false（不是 undefined）。
  assert.deepEqual(decisionsFor(map, 'v1.0'), {
    scope: { approved: true, at: '2026-11-20T22:20:00+08:00' },
    architecture: { approved: false, at: null },
    acceptance: { approved: false, at: null },
    release: { approved: false, at: null },
  })
})

test('approveDecision(scope)：有 PRD 才能签，成功写入 scopeApprovedAt 且不动原型字段', async () => {
  await withProject(async (project) => {
    await writeFile(join(project, 'prototype.html'), '<html></html>', 'utf8')
    const prototype = await approvePrototype(project, 'v1.0')
    await writePrd(project)
    const result = await approveDecision(project, 'v1.0', 'scope')
    assert.equal(result.ok, true)
    assert.equal(result.gate, 'scope')
    assert.equal(result.iteration_id, 'v1.0')
    assert.equal(typeof result.at, 'string')
    assert.equal(Number.isNaN(Date.parse(result.at)), false)

    const entry = await storedEntry(project)
    assert.equal(entry.scopeApprovedAt, result.at)
    assert.equal(entry.prototype, 'prototype.html', '原型字段不能被签核覆盖')
    assert.equal(entry.prototypeApprovedAt, prototype.approval.prototypeApprovedAt, '其它字段原样保留')
  })
})

test('approveDecision(scope)：没有 PRD 时 prd-missing，且一个字节都不写', async () => {
  await withProject(async (project) => {
    assert.deepEqual(await approveDecision(project, 'v1.0', 'scope'), { ok: false, error: 'prd-missing' })
    assert.equal(await exists(approvalsPathOf(project)), false)
  })
})

test('approveDecision(architecture)：契约文件不齐时 architecture-gate-not-ready 并带 missing；补齐后成功', async () => {
  await withProject(async (project) => {
    const blocked = await approveDecision(project, 'v1.0', 'architecture')
    assert.equal(blocked.ok, false)
    assert.equal(blocked.error, 'architecture-gate-not-ready')
    assert.ok(Array.isArray(blocked.missing) && blocked.missing.length > 0, '要告诉面板缺什么')
    assert.equal(await exists(approvalsPathOf(project)), false)

    await writeArchitecture(project)
    const ok = await approveDecision(project, 'v1.0', 'architecture')
    assert.equal(ok.ok, true)
    assert.equal(ok.gate, 'architecture')
    assert.equal((await storedEntry(project)).architectureApprovedAt, ok.at)
  })
})

test('approveDecision(acceptance)：空表 / 没填结果 / pass 没证据 / stale 都算没通过', async () => {
  await withProject(async (project) => {
    // 缺表也算 acceptance-not-passing（不是抛错）。
    assert.deepEqual(await approveDecision(project, 'v1.0', 'acceptance'), {
      ok: false,
      error: 'acceptance-not-passing',
      missing: ['acceptance.json'],
    })

    for (const items of [
      [],
      [{ id: 'A1', title: '能添加客户', result: null, evidence: [] }],
      [{ id: 'A1', title: '能添加客户', result: 'pass', evidence: [] }],
      [{ id: 'A1', title: '能添加客户', result: 'pass', evidence: ['shots/a.png'], stale: true }],
    ]) {
      await writeAcceptance(project, items)
      const result = await approveDecision(project, 'v1.0', 'acceptance')
      assert.equal(result.error, 'acceptance-not-passing', `items=${JSON.stringify(items)}`)
    }
    assert.equal(await exists(approvalsPathOf(project)), false, '前置不满足不许落盘')

    await writeAcceptance(project, passItems())
    const ok = await approveDecision(project, 'v1.0', 'acceptance')
    assert.equal(ok.ok, true)
    assert.equal(ok.gate, 'acceptance')
    assert.equal((await storedEntry(project)).acceptanceApprovedAt, ok.at)
  })
})

test('approveDecision(release)：发布清单与验收两个前置都要满足，缺一个都不放行', async () => {
  await withProject(async (project) => {
    // 两个都没有：报 release-gate-not-ready，missing 里能看出缺清单也缺验收。
    const none = await approveDecision(project, 'v1.0', 'release')
    assert.equal(none.error, 'release-gate-not-ready')
    assert.ok(none.missing.includes('acceptance'))

    // 只有清单：验收没过，仍不放行。
    await writeRelease(project)
    const releaseOnly = await approveDecision(project, 'v1.0', 'release')
    assert.equal(releaseOnly.error, 'release-gate-not-ready')
    assert.ok(releaseOnly.missing.includes('acceptance'))

    // 只有验收：清单不齐，仍不放行。
    await rm(join(project, '.dsh', 'plugin-state', 'release.json'), { force: true })
    await writeAcceptance(project, passItems())
    const acceptanceOnly = await approveDecision(project, 'v1.0', 'release')
    assert.equal(acceptanceOnly.error, 'release-gate-not-ready')

    await writeRelease(project)
    const ok = await approveDecision(project, 'v1.0', 'release')
    assert.equal(ok.ok, true)
    assert.equal(ok.gate, 'release')
    assert.equal((await storedEntry(project)).releaseApprovedAt, ok.at)
  })
})

test('approveDecision：bad-gate / bad-iteration 直接拒绝，不读盘也不写盘', async () => {
  await withProject(async (project) => {
    await writePrd(project)
    for (const gate of ['', 'nope', 'approve-scope']) {
      assert.deepEqual(await approveDecision(project, 'v1.0', gate), { ok: false, error: 'bad-gate' })
    }
    for (const iterationId of ['', '  ', 'bootstrap', null, undefined]) {
      assert.deepEqual(await approveDecision(project, iterationId, 'scope'), { ok: false, error: 'bad-iteration' })
    }
    assert.equal(await exists(approvalsPathOf(project)), false)
  })
})

test('approveDecision(prototype)：复用 approvePrototype 的原返回形状（不回归旧路由）', async () => {
  await withProject(async (project) => {
    assert.deepEqual(await approveDecision(project, 'v1.0', 'prototype'), { ok: false, error: 'prototype-missing' })
    await writeFile(join(project, 'prototype.html'), '<html></html>', 'utf8')
    const result = await approveDecision(project, 'v1.0', 'prototype')
    assert.equal(result.ok, true)
    assert.equal(result.approval.iterationId, 'v1.0')
    assert.equal(result.approval.prototype, 'prototype.html')
    assert.equal(typeof result.approval.prototypeApprovedAt, 'string')
  })
})

test('范围先签、原型后批：先签的范围记录不丢，且签范围本身不算"原型已通过"', async () => {
  await withProject(async (project) => {
    await writePrd(project)
    await writeFile(join(project, 'prototype.html'), '<html></html>', 'utf8')
    const scope = await approveDecision(project, 'v1.0', 'scope')
    assert.equal(scope.ok, true)

    // 条目存在 ≠ 原型批准：approvalFor 必须继续给 false。
    const read = await readApprovals(project)
    assert.deepEqual(approvalFor(read.map, 'v1.0'), { approved: false, at: null, file: null })

    const prototype = await approvePrototype(project, 'v1.0')
    assert.equal(prototype.ok, true)
    const entry = await storedEntry(project)
    assert.equal(entry.scopeApprovedAt, scope.at, '原型批准不能抹掉已签的范围')
    assert.equal(entry.prototype, 'prototype.html')
    assert.equal(approvalFor({ 'v1.0': entry }, 'v1.0').approved, true)
  })
})

test('原子写保留其他字段：四个门依次签核，前面签过的记录一个都不丢', async () => {
  await withProject(async (project) => {
    await writeFile(join(project, 'prototype.html'), '<html></html>', 'utf8')
    await writePrd(project)
    await writeArchitecture(project)
    await writeAcceptance(project, passItems())
    await writeRelease(project)

    await approvePrototype(project, 'v1.0')
    const scope = await approveDecision(project, 'v1.0', 'scope')
    const architecture = await approveDecision(project, 'v1.0', 'architecture')
    const acceptance = await approveDecision(project, 'v1.0', 'acceptance')
    const release = await approveDecision(project, 'v1.0', 'release')

    const entry = await storedEntry(project)
    assert.equal(entry.prototypeApprovedAt.length > 0, true)
    assert.equal(entry.scopeApprovedAt, scope.at)
    assert.equal(entry.architectureApprovedAt, architecture.at)
    assert.equal(entry.acceptanceApprovedAt, acceptance.at)
    assert.equal(entry.releaseApprovedAt, release.at)
    // 一次签核只写一条迭代记录，不按门分叉。
    const stored = JSON.parse(await readFile(approvalsPathOf(project), 'utf8'))
    assert.deepEqual(Object.keys(stored), ['v1.0'])
  })
})

test('范围签核：PRD.md（大写）也是合法需求基线，与 evidence 探测一致', async () => {
  await withProject(async (project) => {
    await writeFile(join(project, 'PRD.md'), '# 客户管理\n\n## 功能需求\n', 'utf8')
    const result = await approveDecision(project, 'v1.0', 'scope')
    assert.equal(result.ok, true)
  })
})

test('验收/发布签核：验收表必须属于本次迭代（iteration 绑定）', async () => {
  await withProject(async (project) => {
    await writeAcceptance(project, passItems())
    const acceptance = await approveDecision(project, 'v1.1', 'acceptance')
    assert.equal(acceptance.ok, false)
    assert.equal(acceptance.error, 'acceptance-not-passing')
    assert.deepEqual(acceptance.missing, ['acceptance.json#iteration'])

    await writeRelease(project)
    const release = await approveDecision(project, 'v1.1', 'release')
    assert.equal(release.ok, false)
    assert.equal(release.error, 'release-gate-not-ready')
    assert.ok(release.missing.includes('acceptance'))
  })
})

test('发布批准：清单齐全但验收没过时，missing 只报验收，不掺"必需文件"占位', async () => {
  await withProject(async (project) => {
    await writeAcceptance(project, [{ id: 'A1', title: '能添加客户', result: 'pass', evidence: [] }])
    await writeRelease(project)
    const release = await approveDecision(project, 'v1.0', 'release')
    assert.equal(release.ok, false)
    assert.deepEqual(release.missing, ['acceptance'])
  })
})
test('验收签核：result 大小写归一（手写 PASS 与状态机口径一致）', async () => {
  await withProject(async (project) => {
    await writeAcceptance(project, [{ id: 'A1', title: '能添加客户', result: 'PASS', evidence: ['shots/add.png'] }])
    const result = await approveDecision(project, 'v1.0', 'acceptance')
    assert.equal(result.ok, true)
  })
})
test('并发签核：原型 + 四门同时写，锁串行化后一个都不丢', async () => {
  await withProject(async (project) => {
    await writeFile(join(project, 'prototype.html'), '<html></html>', 'utf8')
    await writePrd(project)
    await writeArchitecture(project)
    await writeAcceptance(project, passItems())
    await writeRelease(project)

    const results = await Promise.all([
      approvePrototype(project, 'v1.0'),
      approveDecision(project, 'v1.0', 'scope'),
      approveDecision(project, 'v1.0', 'architecture'),
      approveDecision(project, 'v1.0', 'acceptance'),
      approveDecision(project, 'v1.0', 'release'),
    ])
    for (const result of results) assert.equal(result.ok, true, JSON.stringify(result))

    const entry = await storedEntry(project)
    for (const field of ['prototypeApprovedAt', 'scopeApprovedAt', 'architectureApprovedAt', 'acceptanceApprovedAt', 'releaseApprovedAt']) {
      assert.equal(typeof entry[field], 'string', '并发写丢了 ' + field)
      assert.ok(entry[field].length > 0)
    }
  })
})