/**
 * 原型批准：按 iteration_id 落盘。
 *
 * 为什么必须按迭代存：否则 v1.1 会读到 v1.0 的批准，直接跳过"看原型"进"写代码"。
 * 为什么批准要检查原型文件：设计的门禁是"人看过静态 HTML 才通过"，没有原型的批准
 * 等于给了一个没有依据的通行证 —— 那正是这个门禁要防的事。
 */
import { readFile, stat, mkdir, writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BOOTSTRAP_ITERATION, stateDirOf } from './receipts.js'

export const approvalsPathOf = (projectPath) => join(stateDirOf(projectPath), 'approvals.json')

// 只认这两个位置：写死在契约里，不做"猜文件名"。
const PROTOTYPE_CANDIDATES = ['prototype.html', join('docs', 'prototype.html')]

export async function readApprovals(projectPath) {
  let text
  try {
    text = await readFile(approvalsPathOf(projectPath), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { map: {}, badJson: false, missing: true }
    throw error
  }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { map: {}, badJson: true, missing: false }
    }
    const map = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      map[key] = {
        prototypeApprovedAt:
          typeof value.prototypeApprovedAt === 'string' ? value.prototypeApprovedAt : null,
        prototype: typeof value.prototype === 'string' ? value.prototype : null,
      }
    }
    return { map, badJson: false, missing: false }
  } catch {
    return { map: {}, badJson: true, missing: false }
  }
}

/** 当前迭代的原型批准。bootstrap 永远不算任何迭代的批准。 */
export function approvalFor(map, iterationId) {
  if (typeof iterationId !== 'string' || iterationId === '' || iterationId === BOOTSTRAP_ITERATION) {
    return { approved: false, at: null, file: null }
  }
  const entry = map?.[iterationId]
  if (!entry || typeof entry !== 'object') return { approved: false, at: null, file: null }
  return {
    approved: true,
    at: typeof entry.prototypeApprovedAt === 'string' ? entry.prototypeApprovedAt : null,
    file: typeof entry.prototype === 'string' ? entry.prototype : null,
  }
}

export async function findPrototype(projectPath) {
  for (const relative of PROTOTYPE_CANDIDATES) {
    try {
      const info = await stat(join(projectPath, relative))
      if (info.isFile()) return relative.split('\\').join('/')
    } catch {
      // 继续看下一个候选位置
    }
  }
  return null
}

async function writeApprovals(projectPath, map) {
  const dir = stateDirOf(projectPath)
  await mkdir(dir, { recursive: true })
  const target = approvalsPathOf(projectPath)
  const temp = `${target}.tmp-${randomUUID().slice(0, 8)}`
  const text = `${JSON.stringify(map, null, 2)}\n`
  await writeFile(temp, text, 'utf8')
  try {
    await rename(temp, target)
  } catch {
    // 某些文件系统（或杀软占用）不让 rename 覆盖：退回直接写，至少不丢这次批准。
    await writeFile(target, text, 'utf8')
  }
}

/**
 * 批准当前迭代的原型。返回 `{ok:true, approval}` 或 `{ok:false, error}`；
 * 只有文件系统错误才抛 —— 那是真故障，不是"条件不满足"。
 */
export async function approvePrototype(projectPath, iterationId) {
  const id = typeof iterationId === 'string' ? iterationId.trim() : ''
  if (id === '' || id === BOOTSTRAP_ITERATION) return { ok: false, error: 'iteration-required' }
  const prototype = await findPrototype(projectPath)
  if (prototype === null) return { ok: false, error: 'prototype-missing' }
  const current = await readApprovals(projectPath)
  const map = { ...current.map }
  const entry = { prototypeApprovedAt: new Date().toISOString(), prototype }
  map[id] = entry
  await writeApprovals(projectPath, map)
  return { ok: true, approval: { iterationId: id, ...entry } }
}
