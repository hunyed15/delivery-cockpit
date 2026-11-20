import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, access, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  approvalFor,
  approvalsPathOf,
  approvePrototype,
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
