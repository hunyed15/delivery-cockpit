/**
 * 项目形态判定：新项目 / 存量项目。
 * 判据只认看得见的事实（工程文件、源码目录、需求文档、回执），不做启发式猜测。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { detectProjectShape } from '../lib/shape.js'

async function withProject(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dc-shape-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function touch(root, rel, text = 'x') {
  const path = join(root, ...rel.split('/'))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
}

test('空目录 ⇒ new，并说明依据', async () => {
  await withProject(async (dir) => {
    const shape = await detectProjectShape(dir)
    assert.equal(shape.kind, 'new')
    assert.ok(shape.reasons[0].includes('没有工程文件'))
  })
})

test('有工程文件 / 源码目录 / PRD / 回执 ⇒ existing，并列出依据', async () => {
  await withProject(async (dir) => {
    await touch(dir, 'package.json', '{}')
    const byManifest = await detectProjectShape(dir)
    assert.equal(byManifest.kind, 'existing')
    assert.ok(byManifest.reasons.some((r) => r.includes('package.json')))
  })

  await withProject(async (dir) => {
    await touch(dir, 'src/main.rs', 'fn main() {}')
    const bySource = await detectProjectShape(dir)
    assert.equal(bySource.kind, 'existing')
    assert.ok(bySource.reasons.some((r) => r.includes('src/')))
  })

  await withProject(async (dir) => {
    await touch(dir, 'docs/prd.md', '# 需求')
    const byPrd = await detectProjectShape(dir)
    assert.equal(byPrd.kind, 'existing')
    assert.ok(byPrd.reasons.some((r) => r.includes('docs/prd.md')))
  })

  await withProject(async (dir) => {
    const byReceipts = await detectProjectShape(dir, { receiptCount: 3 })
    assert.equal(byReceipts.kind, 'existing')
    assert.ok(byReceipts.reasons.some((r) => r.includes('3 条执行回执')))
  })
})

test('空目录不算源码目录：src/ 里没有文件时按 new 处理', async () => {
  await withProject(async (dir) => {
    await mkdir(join(dir, 'src'), { recursive: true })
    const shape = await detectProjectShape(dir)
    assert.equal(shape.kind, 'new')
  })
})
