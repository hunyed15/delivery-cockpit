import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

async function readSkill(name) {
  return readFile(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8')
}

test('自建纪律 skill：verify-claims 结构与关键规则', async () => {
  const text = await readSkill('verify-claims')
  assert.match(text, /^---\nname: verify-claims\ndescription: /, 'frontmatter 必须合法且 name 正确')
  assert.match(text, /没有证据，不得声称完成/, '必须写明核心纪律')
  for (const phrase of ['test-report.json', 'used_skill_or_mcp', '未验证', '验收']) {
    assert.ok(text.includes(phrase), `缺少关键规则：${phrase}`)
  }
  assert.ok(!/superpowers/i.test(text), '不得引用 superpowers')
})

test('自建纪律 skill：tdd-loop 结构与关键规则', async () => {
  const text = await readSkill('tdd-loop')
  assert.match(text, /^---\nname: tdd-loop\ndescription: "/, 'frontmatter 必须合法（description 带引号，避免 YAML 冒号问题）')
  for (const phrase of ['Red（写失败测试）', 'Green（最小实现）', 'Refactor（重构）', 'test-report.json', '回归测试']) {
    assert.ok(text.includes(phrase), `缺少关键规则：${phrase}`)
  }
  assert.ok(!/superpowers/i.test(text), '不得引用 superpowers')
})
