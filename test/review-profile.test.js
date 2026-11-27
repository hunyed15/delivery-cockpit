import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readReviewProfile, writeReviewProfile } from '../lib/review/profile.js'

async function withProject(run) {
  const project = await mkdtemp(join(tmpdir(), 'dc-review-profile-'))
  try {
    await run(project)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

test('review profile：缺文件返回空覆盖；写后读回并保留未提交字段', async () => {
  await withProject(async (project) => {
    const missing = await readReviewProfile(project)
    assert.equal(missing.exists, false)
    assert.equal(missing.agent, '')

    const written = await writeReviewProfile(project, {
      agent: 'agy',
      model: 'gemini-4-hydrogen-high',
      agyProxy: 'http://127.0.0.1:10808',
    })
    assert.equal(written.ok, true)
    const read = await readReviewProfile(project)
    assert.equal(read.agent, 'agy')
    assert.equal(read.model, 'gemini-4-hydrogen-high')
    assert.equal(read.agyProxy, 'http://127.0.0.1:10808')

    // 只改 model，不把 agent/proxy 清掉
    await writeReviewProfile(project, { model: '' })
    const updated = await readReviewProfile(project)
    assert.equal(updated.agent, 'agy')
    assert.equal(updated.model, '')
    assert.equal(updated.agyProxy, 'http://127.0.0.1:10808')
  })
})

test('review profile：非法 agent/proxy 拒绝；坏 JSON 可读但标记 bad-json', async () => {
  await withProject(async (project) => {
    const badAgent = await writeReviewProfile(project, { agent: 'gemini' })
    assert.equal(badAgent.ok, false)
    assert.equal(badAgent.error, 'bad-agent')

    const badProxy = await writeReviewProfile(project, { agyProxy: 'ftp://127.0.0.1:10808' })
    assert.equal(badProxy.ok, false)
    assert.equal(badProxy.error, 'bad-proxy')

    await mkdir(join(project, '.dsh', 'plugin-state'), { recursive: true })
    await writeFile(join(project, '.dsh', 'plugin-state', 'review.json'), '{ bad', 'utf8')
    const read = await readReviewProfile(project)
    assert.equal(read.exists, true)
    assert.equal(read.error, 'bad-json')
    assert.equal(read.agent, '')
  })
})

test('review profile：写盘是原子替换，不留下临时文件', async () => {
  await withProject(async (project) => {
    await writeReviewProfile(project, { agent: 'claude', model: 'opus' })
    const dir = join(project, '.dsh', 'plugin-state')
    const { readdir } = await import('node:fs/promises')
    const names = await readdir(dir)
    assert.deepEqual(names, ['review.json'])
    const raw = JSON.parse(await readFile(join(dir, 'review.json'), 'utf8'))
    assert.equal(raw.agent, 'claude')
  })
})
