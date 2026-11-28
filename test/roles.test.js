/**
 * 角色化能力路由：节点 → 角色 → 能力（首选 / 替代 / 回退）。
 * 这是 prd.md FR-2 的核心：能力可换、可复用；节点不绑定具体技能。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveStagePlan, summarizePlan } from '../lib/roles.js'

const entry = {
  roles: [
    { id: 'design-method', label: '设计方法', primary: 'frontend-design', alternatives: ['ui-ux-pro-max'], fallback: '内置版式清单' },
    { id: 'visual-evidence', label: '视觉证据', primary: 'playwright', alternatives: [], fallback: '面板 CDP 截图' },
    { id: 'contract', label: '写契约', primary: null, alternatives: [], fallback: '内置架构模板' },
    { id: 'human-prototype-approval', label: '人点通过', primary: null, alternatives: [], fallback: null },
  ],
  sequence: ['read-input', 'design-method', 'visual-evidence', 'contract', 'human-prototype-approval', 'report'],
}

const caps = (rows) => rows.map(([name, present]) => ({ name, present }))

test('resolveStagePlan：首选可用就用首选，人点节点单独列出', () => {
  const plan = resolveStagePlan(entry, caps([['frontend-design', 'yes'], ['playwright', 'yes']]))
  const design = plan.items.find((item) => item.step === 'design-method')
  assert.equal(design.chosen, 'frontend-design')
  assert.equal(design.reason, 'primary')
  assert.deepEqual(plan.needsHuman, ['human-prototype-approval'])
  assert.equal(plan.items[0].kind, 'step')
  assert.equal(plan.items.at(-1).kind, 'report')
})

test('resolveStagePlan：首选缺失用替代，并说明 reason=alternative', () => {
  const plan = resolveStagePlan(entry, caps([['frontend-design', 'no'], ['ui-ux-pro-max', 'yes']]))
  const design = plan.items.find((item) => item.step === 'design-method')
  assert.equal(design.chosen, 'ui-ux-pro-max')
  assert.equal(design.reason, 'alternative')
})

test('resolveStagePlan：全缺就回退，保留 fallback 做法而不是空转', () => {
  const plan = resolveStagePlan(entry, caps([['frontend-design', 'no'], ['ui-ux-pro-max', 'no'], ['playwright', 'no']]))
  const design = plan.items.find((item) => item.step === 'design-method')
  assert.equal(design.kind, 'fallback')
  assert.equal(design.chosen, null)
  assert.equal(design.fallback, '内置版式清单')
  assert.deepEqual(design.tried, ['frontend-design', 'ui-ux-pro-max'])
  const capture = plan.items.find((item) => item.step === 'visual-evidence')
  assert.equal(capture.fallback, '面板 CDP 截图')
})

test('resolveStagePlan：unknown 不当缺失（避免误禁用），无 primary 的角色是内置做法', () => {
  const plan = resolveStagePlan(entry, [])
  const design = plan.items.find((item) => item.step === 'design-method')
  assert.equal(design.chosen, 'frontend-design')
  assert.equal(design.reason, 'primary-unverified')
  const builtin = plan.items.find((item) => item.step === 'contract')
  assert.equal(builtin.kind, 'builtin')
})

test('summarizePlan：给人看的一句话', () => {
  const plan = resolveStagePlan(entry, caps([['frontend-design', 'yes'], ['playwright', 'yes']]))
  const text = summarizePlan(plan)
  assert.match(text, /设计方法：frontend-design/)
  assert.match(text, /视觉证据：playwright/)
  assert.match(text, /人点通过（人）/)
})
