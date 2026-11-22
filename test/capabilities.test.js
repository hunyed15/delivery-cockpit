import test from 'node:test'
import assert from 'node:assert/strict'

import { capabilityTokens, checkStageCapability, stageCapabilityRequirement } from '../lib/capabilities.js'
import { entryForStage } from '../lib/playbook.js'

// 夹具按 templates/playbook.json 的真实形态裁剪：有必选 method、可选能力、constraint、无 method。
// 注意：implementation 的 claude_review 标了 substitute:true，仅用于验证 substitute 语义；真实模板里 substitute 标在 code-review 阶段。
const PLAYBOOK = {
  version: 2,
  stages: {
    需求定义: { goal: '没有声明 method 的阶段', capabilities: [{ kind: 'tool', name: 'cockpit_acceptance' }] },
    项目立项: {
      method: 'grilling',
      capabilities: [
        { kind: 'skill', name: 'grilling', mode: 'full', optional: true, note: '本机未安装' },
        { kind: 'inline', name: 'plugin-init', mode: 'inline' },
      ],
    },
    代码开发: {
      method: 'tdd-loop',
      constraint: 'ponytail',
      capabilities: [
        { kind: 'skill', name: 'tdd-loop', mode: 'full' },
        { kind: 'skill', name: 'ponytail', mode: 'full' },
        { kind: 'inline', name: 'task-loop', mode: 'inline' },
        { kind: 'mcp', name: 'context7', mode: 'full', optional: true },
        { kind: 'tool', name: 'claude_review', mode: 'full', substitute: true },
      ],
    },
  },
  missingHints: {},
}

test('capabilityTokens：空白/逗号/加号/斜杠/竖线切分，小写去空；非字符串返回空集合', () => {
  const tokens = capabilityTokens('TDD-Loop, Ponytail/context7 | grilling + verify-claims')
  assert.deepEqual([...tokens].sort(), ['context7', 'grilling', 'ponytail', 'tdd-loop', 'verify-claims'])
  assert.deepEqual([...capabilityTokens('  ') ], [])
  assert.deepEqual([...capabilityTokens('') ], [])
  assert.deepEqual([...capabilityTokens(null)], [])
  assert.deepEqual([...capabilityTokens(['tdd-loop'])], [], '数组不是字符串，不猜')
  assert.deepEqual([...capabilityTokens('tdd-loop tdd-loop')], ['tdd-loop'], '重复 token 只算一次')
})

test('stageCapabilityRequirement：required / optional / 无 method 三种（allowed 只收 method + optional，不收 constraint）', () => {
  const required = stageCapabilityRequirement(PLAYBOOK, 'implementation')
  assert.deepEqual(required, {
    ok: true,
    skipped: false,
    stageId: 'implementation',
    name: '代码开发',
    method: 'tdd-loop',
    optional: false,
    substitutes: ['claude_review'],
    allowed: ['tdd-loop', 'claude_review'],
  })
  assert.ok(!required.allowed.includes('ponytail'), 'constraint 不能冒充 method')
  assert.ok(!required.allowed.includes('task-loop'), '非 optional 的 inline 能力不在 allowed 里')

  const optional = stageCapabilityRequirement(PLAYBOOK, 'bootstrap')
  assert.equal(optional.method, 'grilling')
  assert.equal(optional.optional, true)
  assert.deepEqual(optional.allowed, ['grilling'])

  const noMethod = stageCapabilityRequirement(PLAYBOOK, 'requirements')
  assert.equal(noMethod.ok, true)
  assert.equal(noMethod.skipped, false)
  assert.equal(noMethod.method, '')
  assert.deepEqual(noMethod.allowed, [])
})

test('stageCapabilityRequirement：playbook 里没有该阶段 ⇒ skipped；旧 stage id 先归一', () => {
  assert.deepEqual(stageCapabilityRequirement(PLAYBOOK, 'code-review'), { ok: true, skipped: true })
  assert.deepEqual(stageCapabilityRequirement(PLAYBOOK, 'not-a-stage'), { ok: true, skipped: true })
  assert.deepEqual(stageCapabilityRequirement(null, 'implementation'), { ok: true, skipped: true })
  // 旧 id coding 归一后仍能查到自己声明的阶段
  assert.equal(stageCapabilityRequirement(PLAYBOOK, 'coding').stageId, 'implementation')
})

test('checkStageCapability：命中 method（大小写不敏感），allowed 里的 optional 能力也算命中', () => {
  assert.deepEqual(checkStageCapability(PLAYBOOK, 'implementation', 'tdd-loop'), { ok: true, matched: 'tdd-loop' })
  assert.deepEqual(checkStageCapability(PLAYBOOK, 'implementation', 'TDD-LOOP'), { ok: true, matched: 'tdd-loop' })
  assert.deepEqual(checkStageCapability(PLAYBOOK, 'implementation', 'claude_review'), { ok: true, matched: 'claude_review' })
  assert.equal(checkStageCapability(PLAYBOOK, 'implementation', 'context7').ok, false, 'optional 但非 substitute 不能当方法证据')
  assert.deepEqual(
    checkStageCapability(PLAYBOOK, 'implementation', 'task-loop, tdd-loop'),
    { ok: true, matched: 'tdd-loop' },
    '多个 token 命中任意 allowed 即可',
  )
})

test('checkStageCapability：required 缺失报 stage-capability-required，message 含中文名与 allowed', () => {
  for (const used of [undefined, '', '   ', 'ponytail', 'context7']) {
    const check = checkStageCapability(PLAYBOOK, 'implementation', used)
    assert.equal(check.ok, false, `used=${JSON.stringify(used)} 应被拒绝`)
    assert.equal(check.error, 'stage-capability-required')
    assert.equal(check.stageId, 'implementation')
    assert.equal(check.method, 'tdd-loop')
    assert.deepEqual(check.allowed, ['tdd-loop', 'claude_review'])
    assert.match(check.message, /代码开发/)
    assert.match(check.message, /tdd-loop/)
    assert.match(check.message, /claude_review/)
    assert.match(check.message, /used_skill_or_mcp/)
  }
  assert.ok(!checkStageCapability(PLAYBOOK, 'implementation', 'ponytail').message.includes('允许：ponytail'))
})

test('checkStageCapability：optional 阶段用回退不阻断（有记录 / 无记录两种 warning）', () => {
  const fallback = checkStageCapability(PLAYBOOK, 'bootstrap', 'ponytail')
  assert.deepEqual(fallback, { ok: true, fallback: true, warning: '该阶段方法为可选，已按回退能力记录' })
  const empty = checkStageCapability(PLAYBOOK, 'bootstrap', '')
  assert.deepEqual(empty, { ok: true, fallback: true, warning: '该阶段方法为可选，未记录 used_skill_or_mcp' })
  assert.equal(checkStageCapability(PLAYBOOK, 'bootstrap', undefined).ok, true)
  // 命中可选方法本身时是 matched，不是 fallback
  assert.deepEqual(checkStageCapability(PLAYBOOK, 'bootstrap', 'grilling'), { ok: true, matched: 'grilling' })
})

test('checkStageCapability：没有 method 声明或阶段不存在 ⇒ skipped，不阻断', () => {
  assert.deepEqual(checkStageCapability(PLAYBOOK, 'requirements', undefined), { ok: true, skipped: true })
  assert.deepEqual(checkStageCapability(PLAYBOOK, 'release', undefined), { ok: true, skipped: true })
})

test('内置模板：每个声明了 method 的 canonical 阶段都能被校验，且 constraint 不进 allowed', async () => {
  const { readFile } = await import('node:fs/promises')
  const builtin = JSON.parse(
    await readFile(new URL('../templates/playbook.json', import.meta.url), 'utf8'),
  )
  const stagesWithMethod = []
  for (const stageId of ['bootstrap', 'requirements', 'architecture', 'prototype', 'implementation', 'testing', 'code-review', 'acceptance', 'release']) {
    const entry = entryForStage(builtin, stageId)
    assert.ok(entry, `${stageId} 必须有 playbook 条目`)
    const requirement = stageCapabilityRequirement(builtin, stageId)
    if (requirement.method === '') continue
    stagesWithMethod.push(stageId)
    // 只有 method 与 substitute:true 的能力进 allowed；optional（证据/辅助）不进。
    const allowedNames = requirement.allowed
    for (const capability of entry.capabilities ?? []) {
      if (!capability?.name) continue
      if (capability.name === requirement.method) continue
      if (capability.substitute === true) {
        assert.ok(allowedNames.includes(capability.name), `${stageId}: substitute ${capability.name} 必须在 allowed`)
      } else {
        assert.ok(!allowedNames.includes(capability.name), `${stageId}: 非 substitute 能力 ${capability.name} 不得进 allowed`)
      }
    }
    assert.ok(requirement.allowed.includes(requirement.method), `${stageId} 的 method 必须在 allowed 里`)
    if (typeof entry.constraint === 'string' && entry.constraint !== '') {
      assert.ok(!requirement.allowed.includes(entry.constraint), `${stageId} 的 constraint 不能进 allowed`)
    }
  }
  assert.ok(stagesWithMethod.length >= 5, '内置模板应有多数阶段声明 method')
})
