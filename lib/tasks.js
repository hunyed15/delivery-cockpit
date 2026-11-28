/**
 * 任务表归驾驶舱自己维护（prd.md 决策 3）：`.dsh/plugin-state/tasks.json`。
 *
 * 为什么不再直接读 `.trellis/tasks`：
 * - 状态机需要"可认领、可完成"的任务，而 Trellis 的任务状态只能人去改；
 * - 但存量项目里已经有一批 Trellis 任务，所以提供**一次性只读导入**，
 *   之后由驾驶舱自己的表驱动；Trellis 侧永远不被写。
 *
 * 状态只有三个：pending / in_progress / completed（与回执语义对齐）。
 */
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const TASKS_REL = '.dsh/plugin-state/tasks.json'
const TRELLIS_TASKS_REL = '.trellis/tasks'
const MAX_ITEMS = 200

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value) => (typeof value === 'string' ? value.trim() : '')
const STATUSES = new Set(['pending', 'in_progress', 'completed'])

const tasksPathOf = (projectPath) => join(projectPath, ...TASKS_REL.split('/'))

function normalizeItem(raw) {
  if (!isObject(raw)) return null
  const title = text(raw.title)
  if (title === '') return null
  const status = STATUSES.has(text(raw.status)) ? text(raw.status) : 'pending'
  return {
    id: text(raw.id) || `T${Math.random().toString(36).slice(2, 7)}`,
    title,
    status,
    scope: Array.isArray(raw.scope) ? raw.scope.map(text).filter(Boolean) : [],
    owner: text(raw.owner) || null,
    source: raw.source === 'trellis' ? 'trellis' : 'cockpit',
    trellisId: text(raw.trellisId) || null,
    createdAt: text(raw.createdAt) || new Date().toISOString(),
    updatedAt: text(raw.updatedAt) || new Date().toISOString(),
  }
}

function normalizeStore(raw) {
  const items = []
  const seen = new Set()
  for (const entry of Array.isArray(raw?.items) ? raw.items : []) {
    const item = normalizeItem(entry)
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
    if (items.length >= MAX_ITEMS) break
  }
  return {
    schemaVersion: 1,
    updatedAt: text(raw?.updatedAt) || new Date().toISOString(),
    importedFrom: raw?.importedFrom === 'trellis' ? 'trellis' : null,
    items,
  }
}

/** 读驾驶舱任务表：缺文件 = 还没建表（不报错），坏 JSON = error。 */
export async function readTaskStore(projectPath) {
  if (typeof projectPath !== 'string' || projectPath.trim() === '') {
    return { exists: false, error: null, store: { schemaVersion: 1, updatedAt: null, importedFrom: null, items: [] } }
  }
  let raw
  try {
    raw = await readFile(tasksPathOf(projectPath), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { exists: false, error: null, store: { schemaVersion: 1, updatedAt: null, importedFrom: null, items: [] } }
    }
    return { exists: false, error: 'read-error', store: { schemaVersion: 1, updatedAt: null, importedFrom: null, items: [] } }
  }
  try {
    return { exists: true, error: null, store: normalizeStore(JSON.parse(raw)) }
  } catch {
    return { exists: true, error: 'bad-json', store: { schemaVersion: 1, updatedAt: null, importedFrom: null, items: [] } }
  }
}

async function writeTaskStore(projectPath, store) {
  const dir = join(projectPath, '.dsh', 'plugin-state')
  await mkdir(dir, { recursive: true })
  const target = tasksPathOf(projectPath)
  const payload = { ...normalizeStore(store), updatedAt: new Date().toISOString() }
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`
  const body = `${JSON.stringify(payload, null, 2)}\n`
  await writeFile(temp, payload === null ? '' : body, 'utf8')
  try {
    await rename(temp, target)
  } catch {
    await writeFile(target, body, 'utf8')
  }
  return payload
}

/** 只读导入 Trellis 任务：已存在同 trellisId 的跳过；Trellis 文件永不修改。 */
export async function importTrellisTasks(projectPath) {
  const base = join(projectPath, ...TRELLIS_TASKS_REL.split('/'))
  let entries = []
  try {
    entries = await readdir(base)
  } catch {
    return { ok: true, imported: 0, skipped: 0, reason: 'no-trellis-tasks' }
  }

  const current = await readTaskStore(projectPath)
  const store = current.store
  const known = new Set(store.items.map((item) => item.trellisId).filter(Boolean))
  let imported = 0
  let skipped = 0

  for (const name of entries) {
    if (name === 'archive') continue
    const taskFile = join(base, name, 'task.json')
    let info
    try {
      info = await stat(taskFile)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    let raw
    try {
      raw = JSON.parse(await readFile(taskFile, 'utf8'))
    } catch {
      skipped += 1
      continue
    }
    const trellisId = text(raw?.id) || name
    if (known.has(trellisId)) {
      skipped += 1
      continue
    }
    const title = text(raw?.title) || text(raw?.name) || trellisId
    const rawStatus = text(raw?.status)
    const status = rawStatus === 'completed' ? 'completed' : rawStatus === 'in_progress' ? 'in_progress' : 'pending'
    store.items.push(
      normalizeItem({
        id: trellisId,
        title,
        status,
        source: 'trellis',
        trellisId,
        createdAt: text(raw?.createdAt) || new Date().toISOString(),
      }),
    )
    known.add(trellisId)
    imported += 1
  }

  if (imported > 0) {
    store.importedFrom = 'trellis'
    await writeTaskStore(projectPath, store)
  }
  return { ok: true, imported, skipped }
}

export async function addTask(projectPath, input = {}) {
  const title = text(input.title)
  if (title === '') return { ok: false, error: 'title-required' }
  const current = await readTaskStore(projectPath)
  if (current.error === 'bad-json') return { ok: false, error: 'tasks-broken' }
  const store = current.store
  const id = text(input.id) || `T${store.items.length + 1}`
  if (store.items.some((item) => item.id === id)) return { ok: false, error: 'duplicate-id' }
  const item = normalizeItem({ id, title, status: 'pending', scope: input.scope, source: 'cockpit' })
  store.items.push(item)
  await writeTaskStore(projectPath, store)
  return { ok: true, task: item }
}

export async function claimTask(projectPath, input = {}) {
  const id = text(input.id)
  if (id === '') return { ok: false, error: 'id-required' }
  const current = await readTaskStore(projectPath)
  if (current.error === 'bad-json') return { ok: false, error: 'tasks-broken' }
  const store = current.store
  const item = store.items.find((row) => row.id === id)
  if (!item) return { ok: false, error: 'task-not-found' }
  if (item.status === 'completed') return { ok: false, error: 'task-completed' }
  item.status = 'in_progress'
  item.owner = text(input.owner) || item.owner
  item.updatedAt = new Date().toISOString()
  await writeTaskStore(projectPath, store)
  return { ok: true, task: item }
}

export async function completeTask(projectPath, input = {}) {
  const id = text(input.id)
  if (id === '') return { ok: false, error: 'id-required' }
  const current = await readTaskStore(projectPath)
  if (current.error === 'bad-json') return { ok: false, error: 'tasks-broken' }
  const store = current.store
  const item = store.items.find((row) => row.id === id)
  if (!item) return { ok: false, error: 'task-not-found' }
  item.status = 'completed'
  item.updatedAt = new Date().toISOString()
  await writeTaskStore(projectPath, store)
  return { ok: true, task: item }
}

/** 证据层口径：驾驶舱任务表优先；表不存在且项目有 Trellis 任务时，退回只读投影。 */
export async function readCockpitTasks(projectPath, trellisFallback = null) {
  const current = await readTaskStore(projectPath)
  if (current.error === 'bad-json') {
    return { available: false, total: 0, open: 0, completed: 0, items: [], source: 'cockpit', error: 'bad-json' }
  }
  if (current.exists) {
    const items = current.store.items.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      owner: item.owner,
      source: item.source,
    }))
    return {
      available: true,
      total: items.length,
      open: items.filter((item) => item.status !== 'completed').length,
      completed: items.filter((item) => item.status === 'completed').length,
      items,
      source: 'cockpit',
      error: null,
    }
  }
  // 还没有驾驶舱任务表：用 Trellis 的只读投影兜底（不改它）
  if (isObject(trellisFallback) && trellisFallback.available === true) {
    return { ...trellisFallback, source: 'trellis' }
  }
  return { available: false, total: 0, open: 0, completed: 0, items: [], source: 'none', error: null }
}
