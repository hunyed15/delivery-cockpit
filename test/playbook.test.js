import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  STAGE_DEFS,
  entryForStage,
  loadPlaybook,
  mergePlaybook,
  missingCapabilities,
  renderPrompt,
  resolveCapabilities,
  stageDef,
  stageName,
} from '../lib/playbook.js'

// 用真实内置模板做夹具：playbook 的结构永远以产品实际下发的文件为准。
const builtinText = await readFile(new URL('../templates/playbook.json', import.meta.url), 'utf8')
const builtin = JSON.parse(builtinText)

async function withProject(run) {
  const project = await mkdtemp(join(tmpdir(), 'dc-playbook-'))
  try {
    await run(project)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

async function writeOverride(project, value) {
  const dir = join(project, '.dsh', 'plugin-state')
  await mkdir(dir, { recursive: true })
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  await writeFile(join(dir, 'playbook.json'), text, 'utf8')
}

const setOf = (...names) => new Set(names)

test('STAGE_DEFS：8 条，顺序与 receipt stage 对应，冷启动 2 条 + 迭代环 6 条', () => {
  assert.equal(STAGE_DEFS.length, 8)
  assert.deepEqual(
    STAGE_DEFS.map((def) => def.id),
    ['init', 'scaffold', 'brainstorm', 'prototype', 'coding', 'code_review', 'verification', 'release'],
  )
  assert.deepEqual(STAGE_DEFS.filter((def) => def.cycle === false).map((def) => def.id), ['init', 'scaffold'])
  assert.deepEqual(
    STAGE_DEFS.filter((def) => def.cycle === true).map((def) => def.id),
    ['brainstorm', 'prototype', 'coding', 'code_review', 'verification', 'release'],
  )
  const prototype = stageDef('prototype')
  assert.equal(prototype.name, '看原型')
  assert.equal(prototype.playbookKey, '定规格', 'prototype 的 playbook key 是「定规格」')
  assert.equal(stageDef('deploy'), null)
  assert.equal(stageDef(null), null)
})

test('stageDef / stageName：未知 id 原样返回，不编人话名', () => {
  assert.equal(stageName('prototype'), '看原型')
  assert.equal(stageName('deploy'), 'deploy')
  assert.equal(stageName(null), null)
  assert.equal(stageDef('init').name, '初始化')
})

test('内置模板覆盖全部 8 条 stage（模板与代码常量不漂移）', () => {
  for (const def of STAGE_DEFS) {
    const entry = entryForStage(builtin, def.id)
    assert.ok(entry, `${def.id} 在 templates/playbook.json 里应有条目（key=${def.playbookKey}）`)
    assert.equal(Array.isArray(entry.capabilities), true)
  }
})

test('loadPlaybook：没有项目覆盖时用内置，source=builtin，无 warning', async () => {
  await withProject(async (project) => {
    const loaded = await loadPlaybook(project, builtinText)
    assert.equal(loaded.source, 'builtin')
    assert.deepEqual(loaded.warnings, [])
    assert.deepEqual(loaded.playbook.stages, builtin.stages)
    assert.deepEqual(loaded.playbook.missingHints, builtin.missingHints)
  })
})

test('loadPlaybook：项目路径都不存在也只是没有覆盖，不算读失败', async () => {
  const missing = join(tmpdir(), `dc-playbook-missing-${Date.now()}`)
  const loaded = await loadPlaybook(missing, builtinText)
  assert.equal(loaded.source, 'builtin')
  assert.deepEqual(loaded.warnings, [])
})

test('项目覆盖：同名 stage 整体替换（不深合并），未提到的保留内置', async () => {
  const override = {
    stages: {
      写代码: {
        goal: '项目自己的写法',
        capabilities: [{ kind: 'skill', name: 'only-one', mode: 'full' }],
        promptTemplate: '用 {capabilities} 干这一条',
      },
    },
  }
  await withProject(async (project) => {
    await writeOverride(project, override)
    const loaded = await loadPlaybook(project, builtinText)
    assert.equal(loaded.source, 'project')
    assert.deepEqual(loaded.warnings, [])
    // 整体替换：内置的 exitGate / redLines 不应该残留下来形成"半覆盖"阶段。
    assert.deepEqual(loaded.playbook.stages['写代码'], override.stages['写代码'])
    assert.equal('exitGate' in loaded.playbook.stages['写代码'], false)
    assert.equal(loaded.playbook.stages['挑毛病'].goal, builtin.stages['挑毛病'].goal)
    assert.equal(loaded.playbook.stages['初始化'].promptTemplate, builtin.stages['初始化'].promptTemplate)
  })
})

test('missingHints：按 key 覆盖，未覆盖的 key 保留内置', async () => {
  const override = { missingHints: { skill: '缺技能 {name}，先装再上', tool: '缺工具 {name}' } }
  await withProject(async (project) => {
    await writeOverride(project, override)
    const loaded = await loadPlaybook(project, builtinText)
    assert.equal(loaded.source, 'project')
    assert.equal(loaded.playbook.missingHints.skill, '缺技能 {name}，先装再上')
    assert.equal(loaded.playbook.missingHints.tool, '缺工具 {name}')
    assert.equal(loaded.playbook.missingHints.mcp, builtin.missingHints.mcp)
    assert.deepEqual(loaded.playbook.stages, builtin.stages)
  })
})

test('坏 JSON 覆盖：忽略覆盖 + 一条 warning，回退内置（绝不半信半疑）', async () => {
  await withProject(async (project) => {
    await writeOverride(project, '{ 这不是 JSON')
    const loaded = await loadPlaybook(project, builtinText)
    assert.equal(loaded.source, 'builtin')
    assert.equal(loaded.warnings.length, 1)
    assert.equal(loaded.warnings[0].source, '.dsh/plugin-state/playbook.json')
    assert.match(loaded.warnings[0].message, /JSON/)
    assert.deepEqual(loaded.playbook.stages, builtin.stages)
    assert.deepEqual(loaded.playbook.missingHints, builtin.missingHints)
  })
})

test('结构不对的覆盖：顶层/ stages / 条目 / missingHints 四种都整份回退 + warning', async () => {
  const badValues = [
    [],
    { stages: [] },
    { stages: { 写代码: '不是对象' } },
    { missingHints: [] },
    { missingHints: { skill: 42 } },
  ]
  await withProject(async (project) => {
    for (const bad of badValues) {
      await writeOverride(project, bad)
      const loaded = await loadPlaybook(project, builtinText)
      assert.equal(loaded.source, 'builtin', `${JSON.stringify(bad)} 应回退内置`)
      assert.equal(loaded.warnings.length, 1, `${JSON.stringify(bad)} 应有一条 warning`)
      assert.equal(loaded.warnings[0].source, '.dsh/plugin-state/playbook.json')
      assert.deepEqual(loaded.playbook.stages, builtin.stages)
    }
  })
})

test('内置文本缺失/坏掉：空 playbook + warning，不抛错', async () => {
  await withProject(async (project) => {
    const loaded = await loadPlaybook(project, '')
    assert.deepEqual(loaded.playbook.stages, {})
    assert.deepEqual(loaded.playbook.missingHints, {})
    assert.equal(loaded.warnings[0].source, 'playbook')

    const broken = await loadPlaybook(project, '{ bad')
    assert.deepEqual(broken.playbook.stages, {})
    assert.equal(broken.warnings.length, 1)
  })
})

test('mergePlaybook：纯函数，不修改入参；无效 override 回退内置', () => {
  const override = { stages: { 初始化: { goal: '自定义初始化' } } }
  const merged = mergePlaybook(builtin, override)
  assert.deepEqual(merged.stages['初始化'], { goal: '自定义初始化' }, '同名 stage 整体替换')
  assert.equal(merged.stages['想清楚'].goal, builtin.stages['想清楚'].goal, '未提到的保留内置')
  assert.equal(builtin.stages['初始化'].goal !== '自定义初始化', true, '不修改入参')
  assert.equal(builtin.stages['初始化'].exitGate !== undefined, true)

  const invalid = mergePlaybook(builtin, [])
  assert.deepEqual(invalid.stages, builtin.stages)
  assert.deepEqual(mergePlaybook(null, {}), { version: 1, stages: {}, missingHints: {} })
  assert.deepEqual(mergePlaybook(null, { stages: { x: { goal: 'g' } } }).stages, { x: { goal: 'g' } })
})

test('entryForStage：未知 stage / 空 playbook 返回 null；stageId 字段可改变归属', () => {
  assert.equal(entryForStage(builtin, 'prototype').goal, builtin.stages['定规格'].goal)
  assert.equal(entryForStage(builtin, 'deploy'), null)
  assert.equal(entryForStage(builtin, null), null)
  assert.equal(entryForStage(null, 'init'), null)
  assert.equal(entryForStage({ stages: {} }, 'init'), null)

  // 项目覆盖可以把任意 key 用 stageId 挂到 receipt stage 上。
  const relabelled = mergePlaybook(
    { stages: {}, missingHints: {} },
    { stages: { 看原型: { stageId: 'prototype', goal: '项目自己的看原型' } } },
  )
  assert.equal(entryForStage(relabelled, 'prototype').goal, '项目自己的看原型')

  // 同名 key 自带 stageId 时以 stageId 为准：它不再属于原来那个阶段。
  const reassigned = {
    stages: {
      定规格: { stageId: 'brainstorm', goal: '被改名成想清楚' },
      想清楚: { goal: '内置想清楚' },
    },
  }
  assert.equal(entryForStage(reassigned, 'brainstorm').goal, '被改名成想清楚')
  assert.equal(entryForStage(reassigned, 'prototype'), null)
})

test('resolveCapabilities：entry 为 null 返回 []，条目形状齐全', async () => {
  assert.deepEqual(await resolveCapabilities(null, {}), [])
  const resolved = await resolveCapabilities(
    { capabilities: [{ kind: 'skill', name: 'a', mode: 'full' }, 'bad', { kind: 'skill' }] },
    { skills: setOf('a'), tools: new Set(), mcp: new Set(), missingHints: {} },
  )
  assert.equal(resolved.length, 1)
  assert.deepEqual(Object.keys(resolved[0]).sort(), [
    'kind',
    'missingMessage',
    'mode',
    'name',
    'note',
    'optional',
    'present',
  ])
  assert.equal(resolved[0].present, 'yes')
  assert.equal(resolved[0].missingMessage, null)
  assert.equal(resolved[0].note, null)
  assert.equal(resolved[0].optional, false)
})

test('resolveCapabilities：skill/tool/mcp 按 Set 判定，inline 恒 yes 且不需要检测', async () => {
  const entry = entryForStage(builtin, 'init')
  const allPresent = await resolveCapabilities(entry, {
    skills: setOf('trellis-start'),
    tools: new Set(),
    mcp: new Set(),
    missingHints: {},
  })
  const skill = allPresent.find((item) => item.name === 'trellis-start')
  const inline = allPresent.find((item) => item.name === 'plugin-init')
  assert.equal(skill.present, 'yes')
  assert.equal(inline.kind, 'inline')
  assert.equal(inline.present, 'yes')
  assert.equal(inline.missingMessage, null)
})

test('resolveCapabilities：读不到（null）= unknown，绝不谎报缺失', async () => {
  const entry = entryForStage(builtin, 'brainstorm')
  const resolved = await resolveCapabilities(entry, {
    skills: null,
    tools: null,
    mcp: null,
    missingHints: {},
  })
  for (const item of resolved) assert.equal(item.present, 'unknown')
  assert.deepEqual(missingCapabilities(resolved), [], 'unknown 不算缺失，不能阻断')
})

test('resolveCapabilities：缺失用 missingHints 的 {name} 替换；未给 hint 用中性兜底', async () => {
  const entry = entryForStage(builtin, 'prototype')
  const resolved = await resolveCapabilities(entry, {
    skills: setOf('frontend-design'),
    tools: new Set(),
    mcp: new Set(),
    missingHints: { skill: '缺技能：{name}（来自 missingHints）' },
  })
  const missing = resolved.find((item) => item.name === 'ui-ux-pro-max')
  assert.equal(missing.present, 'no')
  assert.equal(missing.missingMessage, '缺技能：ui-ux-pro-max（来自 missingHints）')
  assert.equal(missing.missingMessage.includes('{name}'), false)

  const noHint = await resolveCapabilities(
    { capabilities: [{ kind: 'tool', name: 'claude_review', mode: 'full' }] },
    { skills: new Set(), tools: new Set(), mcp: new Set(), missingHints: {} },
  )
  assert.equal(noHint[0].present, 'no')
  assert.equal(typeof noHint[0].missingMessage, 'string', '缺 tool 也要能说清缺什么')
  assert.match(noHint[0].missingMessage, /claude_review/)
})

test('resolveCapabilities：optional 缺失仍报 present=no，但不进 missingCapabilities', async () => {
  const entry = entryForStage(builtin, 'scaffold')
  const resolved = await resolveCapabilities(entry, {
    skills: setOf('trellis-before-dev'),
    tools: new Set(),
    mcp: new Set(), // context7 缺失但 optional
    missingHints: {},
  })
  const optional = resolved.find((item) => item.name === 'context7')
  assert.equal(optional.present, 'no')
  assert.equal(optional.optional, true)
  assert.deepEqual(missingCapabilities(resolved), [])
})

test('resolveCapabilities：未知 kind 无法检测 ⇒ unknown', async () => {
  const resolved = await resolveCapabilities(
    { capabilities: [{ kind: 'weird', name: 'x', mode: 'full' }] },
    { skills: new Set(), tools: new Set(), mcp: new Set() },
  )
  assert.equal(resolved[0].present, 'unknown')
})

test('missingCapabilities：只留 present=no 且非 optional', async () => {
  const resolved = [
    { kind: 'skill', name: 'a', mode: 'full', optional: false, present: 'no', missingMessage: '缺 a' },
    { kind: 'mcp', name: 'b', mode: 'full', optional: true, present: 'no', missingMessage: '缺 b' },
    { kind: 'skill', name: 'c', mode: 'full', optional: false, present: 'yes', missingMessage: null },
    { kind: 'skill', name: 'd', mode: 'full', optional: false, present: 'unknown', missingMessage: null },
  ]
  const missing = missingCapabilities(resolved)
  assert.deepEqual(missing.map((item) => item.name), ['a'])
  assert.deepEqual(missingCapabilities(null), [])
})

test('renderPrompt：只替换 {capabilities}，其他 {...} 原样保留', async () => {
  const entry = entryForStage(builtin, 'prototype')
  const services = {
    skills: setOf('ui-ux-pro-max', 'frontend-design', 'trellis-spec-bootstrap'),
    tools: new Set(),
    mcp: new Set(),
    missingHints: {},
  }
  const resolved = await resolveCapabilities(entry, services)
  const rendered = renderPrompt(entry, resolved)
  const expected = builtin.stages['定规格'].promptTemplate
    .split('{capabilities}')
    .join('ui-ux-pro-max, frontend-design, trellis-spec-bootstrap')
  assert.equal(rendered.text, expected)
  assert.equal(rendered.capabilitiesText, 'ui-ux-pro-max, frontend-design, trellis-spec-bootstrap')

  const custom = renderPrompt({ promptTemplate: '用 {capabilities} 做 {something}' }, resolved)
  assert.equal(custom.text, '用 ui-ux-pro-max, frontend-design, trellis-spec-bootstrap 做 {something}')
})

test('renderPrompt：参与替换的为空时给「按 RULES.md 自行完成」；inline 与缺失都不进文本', () => {
  const resolved = [
    { kind: 'inline', name: 'task-loop', mode: 'full', present: 'yes' },
    { kind: 'skill', name: 'ponytail', mode: 'full', present: 'yes' },
    { kind: 'skill', name: 'half', mode: 'inline', present: 'yes' },
    { kind: 'skill', name: 'missing', mode: 'full', present: 'no' },
    { kind: 'skill', name: 'unknown', mode: 'full', present: 'unknown' },
  ]
  const rendered = renderPrompt({ promptTemplate: '用 {capabilities} 干活' }, resolved)
  assert.equal(rendered.capabilitiesText, 'ponytail')
  assert.equal(rendered.text, '用 ponytail 干活')

  const empty = renderPrompt({ promptTemplate: '用 {capabilities} 干活' }, [])
  assert.equal(empty.capabilitiesText, '（按 RULES.md 自行完成）')
  assert.equal(empty.text, '用 （按 RULES.md 自行完成） 干活')
})

test('renderPrompt：模板缺失 ⇒ text:null，但 capabilitiesText 照算', async () => {
  const resolved = await resolveCapabilities(
    { capabilities: [{ kind: 'skill', name: 'a', mode: 'full' }] },
    { skills: setOf('a'), tools: new Set(), mcp: new Set(), missingHints: {} },
  )
  const rendered = renderPrompt(null, resolved)
  assert.equal(rendered.text, null)
  assert.equal(rendered.capabilitiesText, 'a')

  assert.equal(renderPrompt({ promptTemplate: 42 }, resolved).text, null)
  assert.equal(renderPrompt({ promptTemplate: '' }, resolved).text, null)
})
