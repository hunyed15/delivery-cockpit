import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  CARD_SCHEMA_VERSION,
  buildDefaultCard,
  cardStatus,
  mergeDetected,
  readProjectCard,
  setWorkflow,
  writeProjectCard,
} from '../lib/project-card.js'

const cardPathOf = (dir) => join(dir, '.dsh', 'plugin-state', 'project.json')

const detectedNext = {
  id: 'next',
  label: 'Web / Next.js',
  packageManager: 'pnpm',
  commands: { dev: 'pnpm dev', build: 'pnpm build', previewUrl: null },
  evidence: [],
  notes: [],
}

const detectedUnknown = {
  id: 'unknown',
  label: '未检测到技术栈',
  packageManager: null,
  commands: { dev: null, build: null, previewUrl: null },
  evidence: [],
  notes: [],
}

async function makeProject(t, files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-card-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const [name, content] of Object.entries(files)) {
    const fullPath = join(dir, name)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, content, 'utf8')
  }
  return dir
}

test('没有名片：missing，不是 broken', async (t) => {
  const dir = await makeProject(t)
  const read = await readProjectCard(dir)
  assert.equal(read.card, null)
  assert.equal(read.broken, false)
  assert.equal(read.missing, true)
})

test('名片 JSON 坏了：broken，不伪造成 missing', async (t) => {
  const dir = await makeProject(t, { '.dsh/plugin-state/project.json': '{ not json' })
  const read = await readProjectCard(dir)
  assert.equal(read.card, null)
  assert.equal(read.broken, true)
  assert.equal(read.missing, false)
})

test('名片结构不是对象：同样 broken', async (t) => {
  const dir = await makeProject(t, { '.dsh/plugin-state/project.json': '[1,2,3]' })
  const read = await readProjectCard(dir)
  assert.equal(read.broken, true)
  assert.equal(read.missing, false)
})

test('buildDefaultCard：name 取目录名，oneLiner 留空，探测成功才写 detectedAt', async (t) => {
  const dir = await makeProject(t)
  const now = new Date('2026-11-20T14:00:00.000Z')

  const card = buildDefaultCard(dir, detectedNext, now)
  assert.equal(card.schemaVersion, CARD_SCHEMA_VERSION)
  assert.equal(card.name, basename(dir))
  assert.equal(card.oneLiner, '')
  assert.deepEqual(card.stack, { id: 'next', label: 'Web / Next.js' })
  assert.deepEqual(card.commands, { dev: 'pnpm dev', build: 'pnpm build', previewUrl: null })
  assert.equal(card.detectedAt, '2026-11-20T14:00:00.000Z')
  assert.equal(card.updatedAt, '2026-11-20T14:00:00.000Z')
})

test('buildDefaultCard：未检测到技术栈时 detectedAt 为 null（没探测成功就不记成功时间）', async (t) => {
  const dir = await makeProject(t)
  const card = buildDefaultCard(dir, detectedUnknown, new Date('2026-11-20T14:00:00.000Z'))
  assert.equal(card.stack.id, 'unknown')
  assert.equal(card.stack.label, '未检测到技术栈')
  assert.equal(card.detectedAt, null)
  assert.equal(card.updatedAt, '2026-11-20T14:00:00.000Z')
})

test('writeProjectCard + readProjectCard：原子写一个来回，落盘格式固定', async (t) => {
  const dir = await makeProject(t)
  const card = buildDefaultCard(dir, detectedNext, new Date('2026-11-20T14:00:00.000Z'))

  const written = await writeProjectCard(dir, card)
  assert.equal(written.ok, true)
  assert.equal(written.bytes > 0, true)

  const raw = await readFile(cardPathOf(dir), 'utf8')
  assert.equal(raw, `${JSON.stringify(card, null, 2)}\n`)

  const read = await readProjectCard(dir)
  assert.deepEqual(read.card, card)
  assert.equal(read.broken, false)
  assert.equal(read.missing, false)
})

test('writeProjectCard：覆盖已有名片，且不留下临时文件', async (t) => {
  const dir = await makeProject(t)
  const stateDir = join(dir, '.dsh', 'plugin-state')
  await writeProjectCard(dir, buildDefaultCard(dir, detectedUnknown))
  const next = buildDefaultCard(dir, detectedNext, new Date('2026-11-20T15:00:00.000Z'))
  await writeProjectCard(dir, next)

  const read = await readProjectCard(dir)
  assert.equal(read.card.stack.id, 'next')
  const names = await readdir(stateDir)
  assert.deepEqual(names, ['project.json'], '临时文件必须清理干净')
})

test('writeProjectCard：非对象直接拒绝（不写出半张名片）', async (t) => {
  const dir = await makeProject(t)
  await assert.rejects(() => writeProjectCard(dir, null), TypeError)
  const read = await readProjectCard(dir)
  assert.equal(read.missing, true)
})

test('readProjectCard：手写的残缺名片被补齐字段，人填值原样保留', async (t) => {
  const dir = await makeProject(t, {
    '.dsh/plugin-state/project.json': JSON.stringify({ name: '客户管理', oneLiner: '给小团队用' }),
  })
  const read = await readProjectCard(dir)
  assert.equal(read.card.name, '客户管理')
  assert.equal(read.card.oneLiner, '给小团队用')
  assert.equal(read.card.schemaVersion, CARD_SCHEMA_VERSION)
  assert.deepEqual(read.card.stack, { id: 'unknown', label: '未检测到技术栈' })
  assert.deepEqual(read.card.commands, { dev: null, build: null, previewUrl: null })
  assert.equal(read.card.detectedAt, null)
  assert.equal(read.card.updatedAt, null)
})

test('mergeDetected：永不覆盖人填的 name / oneLiner，探测字段照常刷新', async (t) => {
  const dir = await makeProject(t)
  const original = {
    ...buildDefaultCard(dir, detectedUnknown, new Date('2026-11-20T10:00:00.000Z')),
    name: '客户管理',
    oneLiner: '给小团队的客户跟进工具',
  }
  const merged = mergeDetected(original, detectedNext, new Date('2026-11-20T11:00:00.000Z'))

  assert.equal(merged.name, '客户管理')
  assert.equal(merged.oneLiner, '给小团队的客户跟进工具')
  assert.deepEqual(merged.stack, { id: 'next', label: 'Web / Next.js' })
  assert.equal(merged.commands.dev, 'pnpm dev')
  assert.equal(merged.detectedAt, '2026-11-20T11:00:00.000Z')
  assert.equal(merged.updatedAt, '2026-11-20T11:00:00.000Z')
  assert.equal(original.stack.id, 'unknown', 'mergeDetected 不能改原对象')
})

test('mergeDetected：探测失败时保留上次确认的信息，但更新 updatedAt', async (t) => {
  const dir = await makeProject(t)
  const known = mergeDetected(buildDefaultCard(dir, detectedUnknown), detectedNext, new Date('2026-11-20T11:00:00.000Z'))
  const merged = mergeDetected(known, detectedUnknown, new Date('2026-11-20T12:00:00.000Z'))

  assert.equal(merged.stack.id, 'next', '没检测到 ≠ 没有技术栈，别抹掉上次事实')
  assert.equal(merged.detectedAt, known.detectedAt)
  assert.equal(merged.updatedAt, '2026-11-20T12:00:00.000Z')
  assert.equal(merged.oneLiner, '', 'oneLiner 空就保持空，不替人写定位')
})

test('cardStatus：filled / needs-human / missing / broken 四种都能表达', async (t) => {
  assert.equal(cardStatus({ oneLiner: '给小团队用' }), 'filled')
  assert.equal(cardStatus({ oneLiner: '' }), 'needs-human')
  assert.equal(cardStatus({ oneLiner: '   ' }), 'needs-human')
  assert.equal(cardStatus(null), 'missing')
  assert.equal(cardStatus({ card: null, broken: true, missing: false }), 'broken')
  assert.equal(cardStatus({ card: null, broken: false, missing: true }), 'missing')
  assert.equal(cardStatus({ card: { oneLiner: '一句话' }, broken: false, missing: false }), 'filled')

  const dir = await makeProject(t)
  assert.equal(cardStatus(await readProjectCard(dir)), 'missing', '也接受 readProjectCard 的整个结果')
})

test('setWorkflow：切换 full/light 保留其它字段；非法值与缺名片拒绝', async (t) => {
  const dir = await makeProject(t)
  const card = buildDefaultCard(dir, detectedNext, new Date('2026-11-20T14:00:00.000Z'))
  card.oneLiner = '给自己做的工具'
  await writeProjectCard(dir, card)

  const light = await setWorkflow(dir, 'light')
  assert.equal(light.ok, true)
  assert.equal(light.workflow, 'light')
  const read = await readProjectCard(dir)
  assert.equal(read.card.workflow, 'light')
  assert.equal(read.card.oneLiner, '给自己做的工具')
  assert.equal(read.card.name, card.name)

  const full = await setWorkflow(dir, 'full')
  assert.equal(full.ok, true)
  assert.equal((await readProjectCard(dir)).card.workflow, 'full')

  assert.deepEqual(await setWorkflow(dir, 'turbo'), { ok: false, error: 'bad-workflow' })

  const empty = await mkdtemp(join(tmpdir(), 'dc-card-workflow-'))
  try {
    assert.deepEqual(await setWorkflow(empty, 'light'), { ok: false, error: 'project-card-missing' })
  } finally {
    await rm(empty, { recursive: true, force: true })
  }
})