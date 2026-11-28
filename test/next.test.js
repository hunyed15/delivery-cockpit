/**
 * 「下一步」契约：cockpit_next 与 cockpit_report 返回值同形（prd.md FR-3）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { nextContract } from '../lib/next.js'

const detail = {
  nextAction: {
    stageId: 'testing',
    stageName: '测试验证',
    kind: 'testing',
    title: '补测试证据',
    reason: '还没有可用的测试证据',
    method: 'cockpit-flow',
    instruction: '按技能 .dsh/skills/cockpit-flow/SKILL.md 执行本阶段。',
    disabled: false,
  },
  stages: [
    {
      id: 'testing',
      name: '测试验证',
      plan: [
        { step: 'read-input', kind: 'step', label: '先读状态与上游产物' },
        { step: 'test-run', kind: 'builtin', role: 'test-run', label: '跑真实测试' },
        { step: 'e2e', kind: 'fallback', role: 'e2e', label: '端到端', fallback: '手工走查 + 截图' },
      ],
      needsHuman: [],
    },
  ],
  gates: { tests: { key: 'tests', ok: false, missing: ['test-report.json'], reason: 'missing' } },
}

test('nextContract：带技能、能力计划、门禁与阻塞原因', () => {
  const next = nextContract(detail)
  assert.equal(next.stageId, 'testing')
  assert.equal(next.skill, 'cockpit-flow')
  assert.equal(next.plan.length, 3)
  assert.deepEqual(next.needsHuman, [])
  assert.equal(next.gates.tests.ok, false)
  assert.ok(next.blockedBy.some((item) => item.includes('缺少首选能力')), '回退要进 blockedBy，别让人以为一切正常')
})

test('nextContract：没有下一步时给 null 字段而不是假动作', () => {
  const next = nextContract({})
  assert.equal(next.stageId, null)
  assert.equal(next.title, null)
  assert.equal(next.skill, 'cockpit-flow')
  assert.deepEqual(next.plan, [])
})
