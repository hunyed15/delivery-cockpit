/**
 * 驾驶舱自维护任务表（prd.md 决策 3）：tasks.json 是驱动源，Trellis 只做一次性只读导入。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { addTask, claimTask, completeTask, importTrellisTasks, readCockpitTasks, readTaskStore } from '../lib/tasks.js'

async function withProject(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dc-tasks-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function writeTrellisTask(root, name, task) {
  const path = join(root, '.trellis', 'tasks', name, 'task.json')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(task), 'utf8')
}

test('任务表：没有 tasks.json 时退回 Trellis 只读投影；有表之后以表为准', async () => {
  await withProject(async (dir) => {
    await writeTrellisTask(dir, '01-a', { id: 'T1', title: '旧任务', status: 'in_progress' })
    const fallback = await readCockpitTasks(dir, {
      available: true,
      total: 1,
      open: 1,
      completed: 0,
      items: [{ id: 'T1', title: '旧任务', status: 'in_progress' }],
    })
    assert.equal(fallback.source, 'trellis')
    assert.equal(fallback.total, 1)

    await addTask(dir, { title: '新任务' })
    const own = await readCockpitTasks(dir, { available: true, total: 1, open: 1, completed: 0, items: [] })
    assert.equal(own.source, 'cockpit')
    assert.equal(own.total, 1)
    assert.equal(own.items[0].title, '新任务')
  })
})

test('任务表：add / claim / complete 的状态流转，重复 id 拒绝', async () => {
  await withProject(async (dir) => {
    const added = await addTask(dir, { id: 'T1', title: '写接口', scope: ['src/**'] })
    assert.equal(added.ok, true)
    assert.equal(added.task.status, 'pending')

    assert.equal((await addTask(dir, { id: 'T1', title: '重复' })).error, 'duplicate-id')

    const claimed = await claimTask(dir, { id: 'T1', owner: 'agent-1' })
    assert.equal(claimed.task.status, 'in_progress')
    assert.equal(claimed.task.owner, 'agent-1')

    const done = await completeTask(dir, { id: 'T1' })
    assert.equal(done.task.status, 'completed')
    assert.equal((await claimTask(dir, { id: 'T1' })).error, 'task-completed')

    const store = await readTaskStore(dir)
    assert.equal(store.exists, true)
    assert.equal(store.store.items.length, 1)
  })
})

test('任务表：从 Trellis 只读导入，重复导入不产生重复条目，且不修改 Trellis 文件', async () => {
  await withProject(async (dir) => {
    await writeTrellisTask(dir, '01-a', { id: 'T1', title: '分层收口', status: 'in_progress' })
    await writeTrellisTask(dir, '02-b', { id: 'T2', title: '已完成的', status: 'completed' })
    const before = await readFile(join(dir, '.trellis', 'tasks', '01-a', 'task.json'), 'utf8')

    const first = await importTrellisTasks(dir)
    assert.equal(first.ok, true)
    assert.equal(first.imported, 2)

    const second = await importTrellisTasks(dir)
    assert.equal(second.imported, 0)
    assert.equal(second.skipped, 2)

    const cockpit = await readCockpitTasks(dir)
    assert.equal(cockpit.source, 'cockpit')
    assert.equal(cockpit.total, 2)
    assert.equal(cockpit.completed, 1)
    assert.deepEqual(cockpit.items.map((item) => item.source), ['trellis', 'trellis'])

    assert.equal(await readFile(join(dir, '.trellis', 'tasks', '01-a', 'task.json'), 'utf8'), before)
  })
})
