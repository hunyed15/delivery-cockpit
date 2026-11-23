/**
 * 缺失能力的「替代 / 安装」建议：只测纯函数，不碰 DSH 服务。
 *
 * 重点是三件事：
 * - 已知能力给的是**已经验证过**的回退/地址，不是编出来的；
 * - 未知能力一律 null（宁可不说，也不猜）；
 * - 已装且必需的不要给安装建议。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { adviceFor } from '../lib/recommend.js'

const missingCap = (name, overrides = {}) => ({
  kind: 'mcp',
  name,
  present: 'no',
  optional: false,
  note: null,
  ...overrides,
})

/** install 项只允许三个字段：多出来的内部字段不能漏给界面。 */
function assertInstallShape(install) {
  assert.ok(Array.isArray(install) && install.length > 0, 'install 必须是非空数组')
  for (const target of install) {
    for (const key of Object.keys(target)) {
      assert.ok(['label', 'command', 'url'].includes(key), `install 出现契约外字段：${key}`)
    }
    assert.equal(typeof target.label, 'string')
    assert.ok(target.label.trim() !== '')
  }
}

test('adviceFor：Playwright / Context7 / grilling / webapp-testing 的替代与安装', () => {
  const playwright = adviceFor(missingCap('playwright'))
  assert.equal(playwright.fallback, '面板内置 CDP 截图（不需要 MCP）')
  assert.deepEqual(playwright.install, [{ label: 'Playwright MCP', url: 'https://github.com/microsoft/playwright-mcp' }])

  const context7 = adviceFor(missingCap('context7'))
  assert.equal(context7.fallback, 'web_search / dsh-doc 查文档')
  assert.deepEqual(context7.install, [{ label: 'Context7 MCP', url: 'https://github.com/upstash/context7' }])

  for (const name of ['grilling', 'grill-me']) {
    const advice = adviceFor(missingCap(name, { kind: 'skill' }))
    assert.equal(advice.fallback, '内置追问模板，产出 docs/brief.md', `${name} 的回退必须一致`)
    assert.deepEqual(advice.install, [
      { label: 'mattpocock/skills（含 grilling）', url: 'https://github.com/mattpocock/skills' },
    ])
  }

  const webapp = adviceFor(missingCap('webapp-testing', { kind: 'skill' }))
  assert.equal(webapp.fallback, '本机 Chrome + CDP 截图')
  assert.deepEqual(webapp.install, [
    { label: 'anthropics/skills（webapp-testing）', url: 'https://github.com/anthropics/skills' },
  ])
})

test('adviceFor：trellis-* 任意前缀统一给 Trellis 安装命令与地址', () => {
  for (const name of ['trellis-start', 'trellis-brainstorm', 'trellis-check', 'trellis-finish-work']) {
    const advice = adviceFor(missingCap(name, { kind: 'skill', optional: true }))
    assert.equal(advice.fallback, '内置模板 / 原生 git 收尾')
    assert.deepEqual(advice.install, [
      {
        label: 'Trellis',
        command: 'npm i -g @mindfoldhq/trellis',
        url: 'https://github.com/mindfold-ai/Trellis',
      },
    ])
  }
})

test('adviceFor：claude_review 只给标签，不编 URL / 命令', () => {
  const advice = adviceFor(missingCap('claude_review', { kind: 'tool' }))
  assert.equal(advice.fallback, '启用 claude-code-review 插件')
  assert.deepEqual(advice.install, [{ label: '@hunyed15/project-cockpit（review 引擎）' }])
  assertInstallShape(advice.install)
  assert.equal(advice.install[0].url, undefined)
  assert.equal(advice.install[0].command, undefined)
})

test('adviceFor：未知能力返回 null（不编造），非法入参也不抛', () => {
  assert.equal(adviceFor(missingCap('mystery-skill')), null)
  assert.equal(adviceFor(missingCap('trellis')), null, '只认 trellis- 前缀，不扩大匹配')
  assert.equal(adviceFor(null), null)
  assert.equal(adviceFor(undefined), null)
  assert.equal(adviceFor({}), null)
  assert.equal(adviceFor({ name: '   ', present: 'no' }), null)
})

test('adviceFor：present=yes 且必需不给建议；optional 才给', () => {
  assert.equal(adviceFor(missingCap('playwright', { present: 'yes' })), null)
  assert.equal(adviceFor(missingCap('claude_review', { present: 'yes' })), null)

  const optional = adviceFor(missingCap('grilling', { kind: 'skill', present: 'yes', optional: true }))
  assert.ok(optional, 'optional 能力即便是 yes 也给替代/说明')
  assert.match(optional.fallback, /内置追问模板/)
  assertInstallShape(optional.install)

  const unknownPresence = adviceFor(missingCap('playwright', { present: 'unknown' }))
  assert.ok(unknownPresence, '"无法检测"不是 yes，给建议')
})

test('adviceFor：能力名大小写不敏感，输出不共享引用', () => {
  const upper = adviceFor(missingCap('Playwright'))
  assert.equal(upper.fallback, '面板内置 CDP 截图（不需要 MCP）')

  // 调用方改返回值不能污染下一次调用（只读映射表）。
  const first = adviceFor(missingCap('context7'))
  first.install[0].label = '被改坏'
  assert.equal(adviceFor(missingCap('context7')).install[0].label, 'Context7 MCP')
})
