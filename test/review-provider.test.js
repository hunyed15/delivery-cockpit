import test from 'node:test'
import assert from 'node:assert/strict'

import { buildReviewParts } from '../lib/review/engine.js'
import { normalizeReviewSettings } from '../lib/review/settings.js'
import { buildAgyProxyEnv } from '../lib/review/agy-env.js'
import { mergeReviewProfile } from '../lib/review/profile.js'

const baseSettings = {
  storage: 'auto',
  transport: 'auto',
  timeoutSec: 60,
  agent: 'claude',
  model: '',
  agyPath: '',
  agyProxy: 'http://127.0.0.1:10808',
}

function partsOf(settings) {
  return buildReviewParts({ mode: 'full', cwd: 'C:/demo', settings, options: {} })
}

test('评审参数：默认仍是 Claude，transport 不被改写', () => {
  const parts = partsOf(baseSettings)
  assert.ok(parts.includes('-Agent'))
  assert.equal(parts[parts.indexOf('-Agent') + 1], "'claude'")
  assert.equal(parts[parts.indexOf('-Transport') + 1], "'auto'")
  assert.equal(parts.includes('-Model'), false)
})

test('评审参数：agy 强制 ACP，并带模型/代理/agy 路径', () => {
  const parts = partsOf({
    ...baseSettings,
    agent: 'agy',
    model: 'gemini-4-hydrogen-high',
    agyPath: 'D:/Program Files/agy/agy.exe',
    agyProxy: 'http://127.0.0.1:10808',
  })
  assert.equal(parts[parts.indexOf('-Agent') + 1], "'agy'")
  assert.equal(parts[parts.indexOf('-Transport') + 1], "'acp'")
  assert.equal(parts[parts.indexOf('-Model') + 1], "'gemini-4-hydrogen-high'")
  assert.equal(parts[parts.indexOf('-AgyPath') + 1], "'D:/Program Files/agy/agy.exe'")
  assert.equal(parts[parts.indexOf('-AgyProxy') + 1], "'http://127.0.0.1:10808'")
})

test('配置规范化：reviewAgent/reviewModel 覆盖生效，非法 agent 回 Claude', () => {
  const agy = normalizeReviewSettings({ reviewAgent: 'agy', reviewModel: 'gemini-4-hydrogen-high', agyProxy: 'http://127.0.0.1:7890' })
  assert.equal(agy.agent, 'agy')
  assert.equal(agy.model, 'gemini-4-hydrogen-high')
  assert.equal(agy.agyProxy, 'http://127.0.0.1:7890')

  const fallback = normalizeReviewSettings({ reviewAgent: 'gemini' })
  assert.equal(fallback.agent, 'claude')
})

test('agy 代理环境：空代理不注入；非空注入大小写并补 NO_PROXY 回环', () => {
  const base = { PATH: 'x', NO_PROXY: 'example.com' }
  const empty = buildAgyProxyEnv('', base)
  assert.equal(empty.HTTP_PROXY, undefined)
  assert.equal(empty.PATH, 'x')

  const proxied = buildAgyProxyEnv('http://127.0.0.1:10808', base)
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    assert.equal(proxied[key], 'http://127.0.0.1:10808')
  }
  for (const item of ['example.com', '127.0.0.1', 'localhost', '::1']) {
    assert.ok(proxied.NO_PROXY.split(',').includes(item))
  }
  assert.equal(proxied.no_proxy, proxied.NO_PROXY)
})
test('mergeReviewProfile：别名统一 + 显式清空优先于全局默认', () => {
  const settings = { agent: 'agy', model: 'global-model', agyProxy: 'http://127.0.0.1:10808' }
  // 没有项目 profile：沿用插件配置（含旧别名）
  assert.equal(mergeReviewProfile(settings, null).agent, 'agy')
  assert.equal(mergeReviewProfile(settings, null).model, 'global-model')

  // 项目显式清空：空串优先，不回落到全局
  const cleared = mergeReviewProfile(settings, {
    exists: true,
    error: null,
    agent: 'agy',
    model: '',
    agyProxy: '',
    set: { agent: true, model: true, agyProxy: true },
  })
  assert.equal(cleared.agent, 'agy')
  assert.equal(cleared.model, '')
  assert.equal(cleared.agyProxy, '')

  // 项目只声明 agent：model 仍用全局
  const partial = mergeReviewProfile(settings, {
    exists: true,
    error: null,
    agent: 'claude',
    model: '',
    agyProxy: '',
    set: { agent: true, model: false, agyProxy: false },
  })
  assert.equal(partial.agent, 'claude')
  assert.equal(partial.model, 'global-model')
})