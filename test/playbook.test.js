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

test('STAGE_DEFS：9 条，顺序与 receipt stage 对应，bootstrap 冷启动 + 8 个迭代环', () => {
  assert.equal(STAGE_DEFS.length, 9)
  assert.deepEqual(
    STAGE_DEFS.map((def) => def.id),
    ['bootstrap', 'requirements', 'architecture', 'prototype', 'implementation', 'testing', 'code-review', 'acceptance', 'release'],
  )
  assert.deepEqual(STAGE_DEFS.filter((def) => def.cycle === false).map((def) => def.id), ['bootstrap'])
  assert.deepEqual(
    STAGE_DEFS.filter((def) => def.cycle === true).map((def) => def.id),
    ['requirements', 'architecture', 'prototype', 'implementation', 'testing', 'code-review', 'acceptance', 'release'],
  )
  const prototype = stageDef('prototype')
  assert.equal(prototype.name, '原型设计')
  assert.equal(prototype.playbookKey, '原型设计', '9 阶段后 playbook key 与 4 字中文名一致')
  assert.equal(stageDef('deploy'), null)
  assert.equal(stageDef(null), null)
})

test('9 阶段 STAGE_DEFS：每个 stage 的 4 字中文名唯一，且旧 id 能解析到同一阶段', () => {
  const names = STAGE_DEFS.map((def) => def.name)
  assert.equal(new Set(names).size, 9, `阶段名必须唯一：${names.join('、')}`)
  for (const name of names) assert.equal([...name].length, 4, `阶段名必须是 4 个汉字：${name}`)
  assert.deepEqual(
    ['init', 'scaffold', 'brainstorm', 'prototype', 'coding', 'code_review', 'verification', 'release'].map((id) => stageDef(id).id),
    ['bootstrap', 'bootstrap', 'requirements', 'prototype', 'implementation', 'code-review', 'acceptance', 'release'],
  )
})

test('stageDef / stageName：未知 id 原样返回，不编人话名；旧 id 兼容', () => {
  assert.equal(stageName('prototype'), '原型设计')
  assert.equal(stageName('deploy'), 'deploy')
  assert.equal(stageName(null), null)
  assert.equal(stageDef('bootstrap').name, '项目立项')
  // 旧 id 只做读取兼容：查到同一 canonical 阶段，不会返回 null。
  assert.equal(stageDef('init').name, '项目立项')
  assert.equal(stageDef('verification').name, '验收确认')
  assert.equal(stageName('code_review'), '代码复核')
})

test('内置模板覆盖全部 9 条 stage（模板与代码常量不漂移）', () => {
  for (const def of STAGE_DEFS) {
    const entry = entryForStage(builtin, def.id)
    assert.ok(entry, `${def.id} 在 templates/playbook.json 里应有条目（key=${def.playbookKey}）`)
    assert.equal(Array.isArray(entry.capabilities), true)
  }
})

test('内置模板：version 2；每阶段有 method/constraint/deliverables/technicalGate/decisionGate', () => {
  assert.equal(builtin.version, 2)
  const removedSuperpowers = [
    'test-driven-development',
    'writing-plans',
    'executing-plans',
    'verification-before-completion',
    'finishing-a-development-branch',
    'systematic-debugging',
    'using-git-worktrees',
    'requesting-code-review',
    'receiving-code-review',
  ]
  let decisionGates = 0
  for (const def of STAGE_DEFS) {
    const entry = entryForStage(builtin, def.id)
    assert.ok(entry, `${def.id} 缺少模板条目`)
    // method 可以为 null（如架构契约：门禁靠契约文件，不强制 skill）；非 null 时必须是非空字符串。
    assert.ok(
      entry.method === null || (typeof entry.method === 'string' && entry.method.length > 0),
      `${def.id}.method 必须是 null 或非空字符串`,
    )
    assert.ok(entry.constraint === null || typeof entry.constraint === 'string', `${def.id}.constraint 至多一个`)
    assert.equal(Array.isArray(entry.deliverables), true, `${def.id}.deliverables 必须是数组`)
    assert.ok(entry.deliverables.length > 0)
    for (const item of entry.deliverables) assert.equal(typeof item, 'string')
    assert.ok(entry.technicalGate === null || typeof entry.technicalGate === 'string', `${def.id}.technicalGate`)
    if (entry.decisionGate !== null) {
      decisionGates += 1
      assert.equal(typeof entry.decisionGate.title, 'string')
      assert.equal(typeof entry.decisionGate.approveAction, 'string')
    }
    assert.equal(typeof entry.promptTemplate, 'string')
    for (const capability of entry.capabilities) {
      assert.ok(['skill', 'mcp', 'tool', 'inline'].includes(capability.kind), `${def.id} 能力 kind 非法：${capability.kind}`)
      assert.equal(typeof capability.name, 'string')
      assert.ok(!removedSuperpowers.includes(capability.name), `${def.id} 不得引用已移除的 superpowers skill：${capability.name}`)
    }
  }
  // 5 个人工决策门：范围、架构、原型、验收、发布；其余阶段只有技术门。
  assert.equal(decisionGates, 5)
})

test('带回退的能力标记 optional：缺失有替代方案，不阻断指令', async () => {
  const fallbackNames = new Set(['grilling', 'trellis-brainstorm', 'trellis-finish-work', 'context7', 'playwright'])
  for (const def of STAGE_DEFS) {
    const entry = entryForStage(builtin, def.id)
    for (const capability of entry.capabilities) {
      if (!fallbackNames.has(capability.name)) continue
      assert.equal(capability.optional, true, `${def.id}.${capability.name} 有回退，必须标 optional:true`)
      assert.equal(typeof capability.note, 'string', `${def.id}.${capability.name} 的 note 要写清回退方案`)
    }
  }
  // 本机没装 grilling：bootstrap 仍应下发指令，而不是被"缺能力"禁用。
  const entry = entryForStage(builtin, 'bootstrap')
  const resolved = await resolveCapabilities(entry, {
    skills: new Set(),
    tools: new Set(),
    mcp: new Set(),
    missingHints: {},
  })
  assert.deepEqual(missingCapabilities(resolved).map((item) => item.name), [])
  assert.notEqual(renderPrompt(entry, resolved).text, null)
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
      代码开发: {
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
    assert.deepEqual(loaded.playbook.stages['代码开发'], override.stages['代码开发'])
    assert.equal('exitGate' in loaded.playbook.stages['代码开发'], false)
    assert.equal(loaded.playbook.stages['代码复核'].goal, builtin.stages['代码复核'].goal)
    assert.equal(loaded.playbook.stages['项目立项'].promptTemplate, builtin.stages['项目立项'].promptTemplate)
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
  const override = { stages: { 项目立项: { goal: '自定义立项' } } }
  const merged = mergePlaybook(builtin, override)
  assert.deepEqual(merged.stages['项目立项'], { goal: '自定义立项' }, '同名 stage 整体替换')
  assert.equal(merged.stages['需求定义'].goal, builtin.stages['需求定义'].goal, '未提到的保留内置')
  assert.equal(builtin.stages['项目立项'].goal !== '自定义立项', true, '不修改入参')
  assert.equal(builtin.stages['项目立项'].exitGate !== undefined, true)

  const invalid = mergePlaybook(builtin, [])
  assert.deepEqual(invalid.stages, builtin.stages)
  assert.deepEqual(mergePlaybook(null, {}), { version: 2, stages: {}, missingHints: {} })
  assert.deepEqual(mergePlaybook(null, { stages: { x: { goal: 'g' } } }).stages, { x: { goal: 'g' } })
})

test('mergePlaybook：覆盖 version 与内置不一致 ⇒ 忽略 stages，保留内置 9 阶段 + warning', async () => {
  const legacyStages = {
    初始化: { goal: '旧初始化' },
    搭骨架: { goal: '旧搭骨架' },
    想清楚: { goal: '旧想清楚' },
    定规格: { goal: '旧定规格' },
    写代码: { goal: '旧写代码' },
    挑毛病: { goal: '旧挑毛病' },
    验效果: { goal: '旧验效果' },
    发出去: { goal: '旧发出去' },
  }
  const override = { version: 1, stages: legacyStages, missingHints: { skill: '旧版本提示 {name}' } }
  await withProject(async (project) => {
    await writeOverride(project, override)
    const loaded = await loadPlaybook(project, builtinText)
    assert.equal(loaded.source, 'project')
    assert.equal(loaded.warnings.length, 1, '版本不一致必须有且只有一条 warning')
    assert.equal(loaded.warnings[0].source, '.dsh/plugin-state/playbook.json')
    assert.match(loaded.warnings[0].message, /版本不一致/)
    assert.match(loaded.warnings[0].message, /v1/)
    assert.match(loaded.warnings[0].message, /v2/)
    // 保留内置 9 阶段，不能被旧 8 个中文 key 合并出 17 个阶段。
    assert.deepEqual(loaded.playbook.stages, builtin.stages)
    assert.equal(Object.keys(loaded.playbook.stages).length, 9)
    for (const key of Object.keys(legacyStages)) assert.equal(key in loaded.playbook.stages, false, `旧 key 不应出现：${key}`)
    // 非 stages 字段仍可覆盖
    assert.equal(loaded.playbook.missingHints.skill, '旧版本提示 {name}')
    assert.equal(loaded.playbook.missingHints.mcp, builtin.missingHints.mcp)
  })
})

test('entryForStage：未知 stage / 空 playbook 返回 null；stageId 字段可改变归属', () => {
  assert.equal(entryForStage(builtin, 'prototype').goal, builtin.stages['原型设计'].goal)
  assert.equal(entryForStage(builtin, 'deploy'), null)
  assert.equal(entryForStage(builtin, null), null)
  assert.equal(entryForStage(null, 'init'), null)
  assert.equal(entryForStage({ stages: {} }, 'init'), null)
  // 旧 id 映射到 canonical 条目：读取兼容，不返回 null。
  assert.equal(entryForStage(builtin, 'verification').goal, builtin.stages['验收确认'].goal)
  assert.equal(entryForStage(builtin, 'code_review').goal, builtin.stages['代码复核'].goal)

  // 项目覆盖可以把任意 key 用 stageId 挂到 receipt stage 上。
  const relabelled = mergePlaybook(
    { stages: {}, missingHints: {} },
    { stages: { 原型条目: { stageId: 'prototype', goal: '项目自己的原型' } } },
  )
  assert.equal(entryForStage(relabelled, 'prototype').goal, '项目自己的原型')

  // 同名 key 自带 stageId 时以 stageId 为准：它不再属于原来那个阶段。
  const reassigned = {
    stages: {
      原型设计: { stageId: 'requirements', goal: '被改名成需求' },
      需求定义: { goal: '内置需求' },
    },
  }
  assert.equal(entryForStage(reassigned, 'requirements').goal, '被改名成需求')
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
  const entry = entryForStage(builtin, 'bootstrap')
  const allPresent = await resolveCapabilities(entry, {
    skills: setOf('grilling'),
    tools: new Set(),
    mcp: new Set(),
    missingHints: {},
  })
  const skill = allPresent.find((item) => item.name === 'grilling')
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
  const entry = entryForStage(builtin, 'architecture')
  const resolved = await resolveCapabilities(entry, {
    skills: setOf('ponytail'),
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

test('验收确认阶段：提示 Agent 用 event=acceptance-recheck 写验收复核回执', () => {
  const entry = entryForStage(builtin, 'acceptance')
  assert.match(entry.promptTemplate, /acceptance-recheck/, '验收确认指令必须告诉 Agent 复核留痕怎么写')
  assert.match(entry.promptTemplate, /cockpit_report/, '要给具体工具名')
  assert.match(entry.promptTemplate, /stage:"acceptance"/, '复核回执的 stage 必须是 acceptance')
  assert.match(entry.exitGate, /stale|失效/, '出口条件要包含失效条目不算通过')
})

test('renderPrompt：只替换 {capabilities}，其他 {...} 原样保留', async () => {
  const entry = entryForStage(builtin, 'prototype')
  const services = {
    skills: setOf('ui-ux-pro-max', 'frontend-design', 'impeccable'),
    tools: new Set(),
    mcp: new Set(),
    missingHints: {},
  }
  const resolved = await resolveCapabilities(entry, services)
  const rendered = renderPrompt(entry, resolved)
  const expected = builtin.stages['原型设计'].promptTemplate
    .split('{capabilities}')
    .join('frontend-design, ui-ux-pro-max, impeccable')
  assert.equal(rendered.text, expected)
  assert.equal(rendered.capabilitiesText, 'frontend-design, ui-ux-pro-max, impeccable')

  const custom = renderPrompt({ promptTemplate: '用 {capabilities} 做 {something}' }, resolved)
  assert.equal(custom.text, '用 frontend-design, ui-ux-pro-max, impeccable 做 {something}')
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
