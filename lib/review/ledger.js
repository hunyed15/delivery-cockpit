/**
 * 处置记录（账本写入）：从 @hunyed15/project-cockpit v3.0.0 的 panel.js 迁入的**纯逻辑**。
 *
 * 只迁写入侧：resolveTaskDir（写到哪个账本）+ appendDispositions（追加一行 JSON）。
 * 旧插件的面板投影（loadPanel / derive* / UI）不在这里——驾驶舱的「代码检查」模块
 * 已经用本插件的 lib/evidence.js 读同一份账本，迁过来只会变成第二套口径。
 *
 * 账本位置（与引擎写的位置、lib/evidence.js 读的位置是同一处）：
 *   - Trellis: <project>/.trellis/tasks/<task>/review/
 *   - Local:   <project>/.dsh/claude-review/ledger/review/
 */
import { appendFile, mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { normalizeStorage } from './settings.js'

export const LOCAL_LEDGER = join('.dsh', 'claude-review', 'ledger')
export const DISPOSITION_STATUSES = new Set(['fixed', 'counter-evidence', 'deferred'])

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 解析要写入处置记录的任务目录：显式指定优先；本地模式取 `.dsh/claude-review/ledger`；
 * Trellis 下没有显式 taskDir 直接报错，不会按 history/in_progress 猜任务
 * （猜错会把处置写进别的任务，和误审一样糟）。
 */
export async function resolveTaskDir(projectRoot, explicit, options = {}) {
  const root = String(projectRoot ?? '').trim()
  if (root === '') throw new Error('cwd 为空')
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const dir = isAbsolute(explicit) ? explicit : join(root, explicit)
    if ((await exists(join(dir, 'task.json'))) || (await exists(join(dir, 'review')))) return dir
    throw new Error(`任务目录不存在或不是审核任务：${dir}`)
  }

  const configured = normalizeStorage(options.storage)
  const storage = configured === 'auto' ? ((await exists(join(root, '.trellis'))) ? 'trellis' : 'local') : configured
  if (storage === 'local') {
    const dir = join(root, LOCAL_LEDGER)
    if ((await exists(join(dir, 'task.json'))) || (await exists(join(dir, 'review')))) return dir
    throw new Error('还没有本地审核账本；先跑一次 claude_review 再记录处置。')
  }

  // 写入类操作不允许猜任务：面板不持有 DSH 会话身份，Trellis 下必须显式传 taskDir。
  throw new Error(
    '无法确定 Trellis 任务：请显式传 taskDir（例如 .trellis/tasks/<task>），或改用 storage=local；' +
      '不会按 review/history 或 in_progress 状态猜任务。',
  )
}

/** 追加处置记录，返回写入后的条数（坏数据在 appendFile 之前抛错：一个字节都不落盘）。 */
export async function appendDispositions(taskDir, entries, sessionId) {
  const reviewDir = join(taskDir, 'review')
  const rows = Array.isArray(entries) ? entries : [entries]
  const lines = []
  for (const entry of rows) {
    const status = String(entry?.status ?? '')
    if (!DISPOSITION_STATUSES.has(status)) {
      throw new Error(`status 必须是 fixed / counter-evidence / deferred，收到：${status || '(空)'}`)
    }
    const round = Number(entry?.round)
    if (!Number.isFinite(round)) throw new Error('round 必须是数字')
    const record = {
      at: new Date().toISOString(),
      round,
      key: entry?.key ? String(entry.key) : '',
      index: Number.isFinite(Number(entry?.index)) ? Number(entry.index) : null,
      status,
      note: String(entry?.note ?? ''),
      evidence: Array.isArray(entry?.evidence) ? entry.evidence.map(String) : [],
      sessionId: String(sessionId ?? ''),
    }
    if (record.key === '' && record.index === null) throw new Error('key 与 index 至少要给一个')
    lines.push(JSON.stringify(record))
  }
  if (lines.length === 0) return 0
  await mkdir(reviewDir, { recursive: true })
  await appendFile(join(reviewDir, 'dispositions.jsonl'), `${lines.join('\n')}\n`, 'utf8')
  return lines.length
}
