import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

async function readSkill(name) {
  const text = await readFile(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8')
  return text.replace(/\r\n/g, '\n')
}

/** 解析 frontmatter（name/description），避免把字段顺序或行尾写死进断言。 */
function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(match, '必须存在 frontmatter 块')
  const fields = {}
  for (const line of match[1].split('\n')) {
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (pair) fields[pair[1]] = pair[2].trim()
  }
  return fields
}

test('自建纪律 skill：verify-claims 结构与关键规则', async () => {
  const text = await readSkill('verify-claims')
  const fields = parseFrontmatter(text)
  assert.equal(fields.name, 'verify-claims')
  assert.ok(fields.description.length > 20, 'description 必须非空')
  assert.match(text, /没有证据，不得声称完成/, '必须写明核心纪律')
  for (const phrase of ['test-report.json', 'used_skill_or_mcp', '未验证', '验收']) {
    assert.ok(text.includes(phrase), `缺少关键规则：${phrase}`)
  }
  assert.ok(!/superpowers/i.test(text), '不得引用 superpowers')
})

test('自建纪律 skill：tdd-loop 结构与关键规则', async () => {
  const text = await readSkill('tdd-loop')
  const fields = parseFrontmatter(text)
  assert.equal(fields.name, 'tdd-loop')
  assert.ok(fields.description.length > 20, 'description 必须非空')
  assert.match(fields.description, /^".*"$/, 'description 含冒号时必须用双引号包裹，避免 YAML 解析失败')
  for (const phrase of ['Red（写失败测试）', 'Green（最小实现）', 'Refactor（重构）', 'test-report.json', '回归测试']) {
    assert.ok(text.includes(phrase), `缺少关键规则：${phrase}`)
  }
  assert.ok(!/superpowers/i.test(text), '不得引用 superpowers')
})
