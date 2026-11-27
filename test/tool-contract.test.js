import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, readdir, access, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolDefinitions, TOOL_DEFINITIONS } from '../index.js'
import { appendReceipt, STAGES, STATUSES } from '../lib/receipts.js'

const fakeCtx = { get: () => undefined, logger: { warn() {} } }
const execIn = (cwd) => ({ agent: { session: { header: { cwd } } } })

const exists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

test('每个工具都声明 output.schema 与 output.render（漏了会让整个插件激活失败）', () => {
  assert.ok(Array.isArray(TOOL_DEFINITIONS) && TOOL_DEFINITIONS.length >= 2)
  for (const definition of TOOL_DEFINITIONS) {
    assert.equal(typeof definition.name, 'string')
    assert.equal(typeof definition.description, 'string')
    assert.equal(typeof definition.parameters, 'object')
    assert.equal(typeof definition.execute, 'function', `${definition.name} 缺 execute`)
    assert.equal(typeof definition.output, 'object', `${definition.name} 缺 output —— 整个插件会激活失败`)
    assert.equal(typeof definition.output.schema, 'object', `${definition.name} 缺 output.schema`)
    assert.equal(typeof definition.output.render, 'function', `${definition.name} 缺 output.render`)
    const blocks = definition.output.render({}, { ok: true })
    assert.ok(Array.isArray(blocks) && blocks.length > 0, `${definition.name} render 必须返回非空 ContentBlock[]`)
    assert.equal(blocks[0].type, 'text')
    assert.equal(typeof blocks[0].text, 'string')
  }
})

test('cockpit_report 的必填与枚举与账本常量一致', () => {
  const report = TOOL_DEFINITIONS.find((item) => item.name === 'cockpit_report')
  assert.ok(report)
  assert.deepEqual(report.parameters.required, ['iteration_id', 'stage', 'status', 'summary_for_human'])
  assert.deepEqual(report.parameters.properties.stage.enum, STAGES)
  assert.deepEqual(report.parameters.properties.status.enum, STATUSES)
  assert.equal(report.parameters.additionalProperties, false)
  assert.deepEqual(report.parameters.properties.needs_human_decision.required, ['title'])
  // task_ref / write_scope 即使 V1 不做并发防撞也要留在签名里，后面迭代不用改接口
  assert.ok(report.parameters.properties.task_ref)
  assert.ok(report.parameters.properties.write_scope)
  // feature_ids 可选：功能账靠它把回执挂到 PRD 的 FR 编号上
  assert.ok(report.parameters.properties.feature_ids)
  assert.ok(!report.parameters.required.includes('feature_ids'), 'feature_ids 必须可选，否则旧调用全挂')
  // 验收复核留痕：Agent 主动写 event，但只允许登记过的值，且不能带别的 stage/status 组合
  assert.deepEqual(report.parameters.properties.event.enum, ['acceptance-recheck'])
  assert.ok(!report.parameters.required.includes('event'), 'event 必须可选，否则普通回执全挂')
  assert.deepEqual(report.output.schema.required, ['ok', 'receiptId'])
  // 可选能力回退时带 warning；它是可选字段，不影响旧调用与 render
  assert.equal(report.output.schema.properties.capabilityWarning.type, 'string')
  assert.ok(!report.output.schema.required.includes('capabilityWarning'))
})

test('cockpit_report 的 render 把 summary_for_human 作为一行文本返回', () => {
  const report = TOOL_DEFINITIONS.find((item) => item.name === 'cockpit_report')
  const blocks = report.output.render({ summary_for_human: '下单主流程跑通' }, { ok: true, receiptId: 'r-1' })
  assert.equal(blocks.length, 1)
  assert.match(blocks[0].text, /下单主流程跑通/)
})

test('cockpit_report execute 真的把回执追加进会话工作目录的账本', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dc-tool-'))
  try {
    const tools = createToolDefinitions(fakeCtx)
    const report = tools.find((item) => item.name === 'cockpit_report')
    const value = await report.execute(
      {
        iteration_id: 'bootstrap',
        stage: 'bootstrap',
        status: 'completed',
        summary_for_human: '工作区建好了',
        used_skill_or_mcp: 'cockpit-bootstrap',
      },
      execIn(project),
    )
    assert.equal(value.ok, true)
    assert.match(value.receiptId, /^r-/)
    const text = await readFile(join(project, '.dsh', 'plugin-state', 'receipts.jsonl'), 'utf8')
    const lines = text.trim().split(/\r?\n/)
    assert.equal(lines.length, 1)
    const row = JSON.parse(lines[0])
    assert.equal(row.summary_for_human, '工作区建好了')
    assert.equal(row.stage, 'bootstrap')
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('cockpit_report 支持验收复核留痕（event=acceptance-recheck），且拒绝错误组合', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dc-tool-'))
  try {
    const report = createToolDefinitions(fakeCtx).find((item) => item.name === 'cockpit_report')
    const value = await report.execute(
      {
        iteration_id: 'v1.0',
        stage: 'acceptance',
        status: 'completed',
        summary_for_human: '复核 A1「能添加客户」：按步骤重走一遍，仍通过',
        feature_ids: ['FR-1'],
        event: 'acceptance-recheck',
        used_skill_or_mcp: 'cockpit-acceptance',
      },
      execIn(project),
    )
    assert.equal(value.ok, true)
    assert.match(value.receiptId, /^r-/)
    const text = await readFile(join(project, '.dsh', 'plugin-state', 'receipts.jsonl'), 'utf8')
    const row = JSON.parse(text.trim().split(/\r?\n/)[0])
    assert.equal(row.event, 'acceptance-recheck')
    assert.equal(row.stage, 'acceptance')
    assert.equal(row.status, 'completed')
    assert.deepEqual(row.feature_ids, ['FR-1'])

    // 审计事件必须配对正确的 stage/status，不能伪装成别的阶段进度
    await assert.rejects(() =>
      report.execute(
        { iteration_id: 'v1.0', stage: 'implementation', status: 'completed', summary_for_human: 'x', event: 'acceptance-recheck' },
        execIn(project),
      ),
    )
    // 普通回执不带 event 时保持原行为
    await report.execute(
      {
        iteration_id: 'v1.0',
        stage: 'acceptance',
        status: 'in_progress',
        summary_for_human: '开始验收',
        used_skill_or_mcp: 'cockpit-acceptance',
      },
      execIn(project),
    )
    const rows = (await readFile(join(project, '.dsh', 'plugin-state', 'receipts.jsonl'), 'utf8')).trim().split(/\r?\n/)
    assert.equal(JSON.parse(rows[1]).event, null)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('cockpit_report execute 对非法参数必须抛错（不能静默写坏数据）', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dc-tool-'))
  try {
    const report = createToolDefinitions(fakeCtx).find((item) => item.name === 'cockpit_report')
    await assert.rejects(() => report.execute({ iteration_id: 'v1.0', stage: 'implementation', status: 'completed' }, execIn(project)))
    assert.equal(await exists(join(project, '.dsh', 'plugin-state', 'receipts.jsonl')), false)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('cockpit_init 默认 dry-run：只预览，不写盘', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dc-init-'))
  try {
    const init = createToolDefinitions(fakeCtx).find((item) => item.name === 'cockpit_init')
    const value = await init.execute({ cwd: project }, execIn(project))
    assert.equal(value.ok, true)
    assert.equal(value.dryRun, true)
    assert.equal(value.applied, false)
    assert.ok(value.created.includes('RULES.md'))
    assert.equal(await exists(join(project, '.dsh')), false)
    assert.equal(await exists(join(project, '.trellis')), false)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('cockpit_init 显式 dryRun:false 才写四个文件，二次执行不覆盖', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dc-init-'))
  try {
    const init = createToolDefinitions(fakeCtx).find((item) => item.name === 'cockpit_init')
    const first = await init.execute({ cwd: project, dryRun: false }, execIn(project))
    assert.equal(first.ok, true)
    assert.equal(first.applied, true)
    const stateDir = join(project, '.dsh', 'plugin-state')
    assert.deepEqual((await readdir(stateDir)).sort(), ['RULES.md', 'acceptance.json', 'playbook.json', 'project.json'].sort())
    assert.equal(await exists(join(project, '.trellis')), true)

    // 人在 project.json 里填了名片：第二次 init 不能把它改回去
    const cardPath = join(stateDir, 'project.json')
    const card = JSON.parse(await readFile(cardPath, 'utf8'))
    card.oneLiner = '给自己做的记账工具'
    await writeFile(cardPath, JSON.stringify(card, null, 2), 'utf8')
    const editedBytes = await readFile(cardPath, 'utf8')

    const second = await init.execute({ cwd: project, dryRun: false }, execIn(project))
    assert.equal(second.applied, false)
    assert.deepEqual(second.created, [])
    assert.equal(await readFile(cardPath, 'utf8'), editedBytes)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('显式 cwd 必须过写授权：未登记目录一律拒绝写盘', async () => {
  const calls = []
  const tools = createToolDefinitions(fakeCtx, {
    authorizeWrite: async (path) => {
      calls.push(path)
      throw new Error(`拒绝写盘：${path} 不是 DSH 已登记的工作区或其中的目录`)
    },
  })
  const init = tools.find((item) => item.name === 'cockpit_init')
  await assert.rejects(() => init.execute({ cwd: 'C:\\definitely-not-registered', dryRun: false }), /拒绝写盘/)
  assert.equal(calls.length, 1, '显式 cwd 必须真的走一次授权')
})

test('没有显式 cwd 时用会话工作目录，且不触发写授权（不是模型可控参数）', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dc-init-'))
  try {
    const tools = createToolDefinitions(fakeCtx, {
      authorizeWrite: async () => {
        throw new Error('会话工作目录不该走写授权')
      },
    })
    const init = tools.find((item) => item.name === 'cockpit_init')
    const value = await init.execute({}, execIn(project))
    assert.equal(value.ok, true)
    assert.equal(value.dryRun, true)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('取不到工作目录时直接报错，不回退到进程启动目录', async () => {
  const tools = createToolDefinitions(undefined)
  const report = tools.find((item) => item.name === 'cockpit_report')
  await assert.rejects(
    () =>
      report.execute(
        { iteration_id: 'bootstrap', stage: 'bootstrap', status: 'completed', summary_for_human: '不该写进去' },
        {},
      ),
    /无法确定项目目录/,
  )
  const init = tools.find((item) => item.name === 'cockpit_init')
  await assert.rejects(() => init.execute({}, {}), /无法确定项目目录/)
})

test('cockpit_acceptance：声明 output、items 必填、只追加不覆盖', async () => {
  const acceptance = TOOL_DEFINITIONS.find((item) => item.name === 'cockpit_acceptance')
  assert.ok(acceptance, '功能账依赖这个工具起草验收条目')
  assert.equal(typeof acceptance.output?.schema, 'object')
  assert.equal(typeof acceptance.output?.render, 'function')
  assert.deepEqual(acceptance.parameters.required, ['items'])
  assert.deepEqual(acceptance.parameters.properties.items.items.required, ['title'])
  assert.ok(acceptance.parameters.properties.items.items.properties.feature_ref)

  const project = await mkdtemp(join(tmpdir(), 'dc-acc-tool-'))
  try {
    // 验收表属于迭代环：先有一条 v1.0 的回执
    await appendReceipt(project, {
      iteration_id: 'v1.0',
      stage: 'requirements',
      status: 'completed',
      summary_for_human: '需求定了',
    })
    const tool = createToolDefinitions(fakeCtx).find((item) => item.name === 'cockpit_acceptance')
    const first = await tool.execute(
      { items: [{ feature_ref: 'FR-1', title: '能添加客户', steps: '点新增', expect: '列表出现' }] },
      execIn(project),
    )
    assert.equal(first.ok, true)
    assert.equal(first.added, 1)
    assert.equal(first.iterationId, 'v1.0')

    const tablePath = join(project, '.dsh', 'plugin-state', 'acceptance.json')
    const table = JSON.parse(await readFile(tablePath, 'utf8'))
    assert.equal(table.items[0].feature_ref, 'FR-1')
    assert.equal(table.items[0].result, null)

    const again = await tool.execute({ items: [{ feature_ref: 'FR-1', title: '能添加客户' }] }, execIn(project))
    assert.equal(again.added, 0)
    assert.equal(again.skipped, 1)
    assert.equal(JSON.parse(await readFile(tablePath, 'utf8')).items.length, 1)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('cockpit_acceptance：跨迭代或坏表时明确报错，不写盘', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dc-acc-tool-'))
  try {
    const tool = createToolDefinitions(fakeCtx).find((item) => item.name === 'cockpit_acceptance')
    // 只有 bootstrap 回执：没有迭代，拒绝起草
    await assert.rejects(
      () => tool.execute({ items: [{ title: '能添加客户' }] }, execIn(project)),
      /还没有迭代/,
    )
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('cockpit_report 写入前校验阶段能力：implementation 缺 tdd-loop ⇒ 拒绝且不落盘', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dc-cap-tool-'))
  try {
    const report = createToolDefinitions(fakeCtx).find((item) => item.name === 'cockpit_report')
    await assert.rejects(
      () =>
        report.execute(
          {
            iteration_id: 'v1.0',
            stage: 'implementation',
            status: 'completed',
            summary_for_human: '任务 T1 做完了',
            task_ref: 'T1',
            write_scope: ['src/**'],
          },
          execIn(project),
        ),
      (error) => {
        assert.match(error.message, /^cockpit_report: /)
        assert.match(error.message, /本阶段（代码开发）/)
        assert.match(error.message, /必须使用 cockpit-implementation/)
        assert.match(error.message, /stage-capability-required/)
        return true
      },
    )
    assert.equal(await exists(join(project, '.dsh', 'plugin-state', 'receipts.jsonl')), false, '被拒绝的回执不能落盘')

    const value = await report.execute(
      {
        iteration_id: 'v1.0',
        stage: 'implementation',
        status: 'completed',
        summary_for_human: '任务 T1 做完了',
        used_skill_or_mcp: 'cockpit-implementation, tdd-loop',
        task_ref: 'T1',
        write_scope: ['src/**'],
      },
      execIn(project),
    )
    assert.equal(value.ok, true)
    assert.equal(value.capabilityWarning, undefined, '命中 method 时没有 warning')
    const row = JSON.parse((await readFile(join(project, '.dsh', 'plugin-state', 'receipts.jsonl'), 'utf8')).trim())
    assert.equal(row.used_skill_or_mcp, 'cockpit-implementation, tdd-loop')
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('cockpit_report 阶段能力：testing 要 verify-claims；acceptance 不接受 claude_review', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dc-cap-tool-'))
  try {
    const report = createToolDefinitions(fakeCtx).find((item) => item.name === 'cockpit_report')
    await assert.rejects(
      () =>
        report.execute(
          { iteration_id: 'v1.0', stage: 'testing', status: 'completed', summary_for_human: '测试跑完了' },
          execIn(project),
        ),
      /本阶段（测试验证）必须使用 cockpit-testing.*stage-capability-required/,
    )
    const tested = await report.execute(
      {
        iteration_id: 'v1.0',
        stage: 'testing',
        status: 'completed',
        summary_for_human: '测试全绿',
        used_skill_or_mcp: 'cockpit-testing',
      },
      execIn(project),
    )
    assert.equal(tested.ok, true)

    // acceptance 的 method 是 verify-claims；claude_review 属于代码开发，不能拿来冒充
    await assert.rejects(
      () =>
        report.execute(
          {
            iteration_id: 'v1.0',
            stage: 'acceptance',
            status: 'completed',
            summary_for_human: '验收过了',
            used_skill_or_mcp: 'claude_review',
          },
          execIn(project),
        ),
      /本阶段（验收确认）必须使用 cockpit-acceptance.*stage-capability-required/,
    )
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('cockpit_report 阶段能力：bootstrap 也要求记录工作流技能', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dc-cap-tool-'))
  try {
    const report = createToolDefinitions(fakeCtx).find((item) => item.name === 'cockpit_report')
    // 少了 used_skill_or_mcp ⇒ 拒绝（阶段方法现在由插件自带技能承担）
    await assert.rejects(
      () =>
        report.execute(
          { iteration_id: 'bootstrap', stage: 'bootstrap', status: 'completed', summary_for_human: '工作区建好了' },
          execIn(project),
        ),
      /本阶段（项目立项）必须使用 cockpit-bootstrap.*stage-capability-required/,
    )

    const value = await report.execute(
      {
        iteration_id: 'bootstrap',
        stage: 'bootstrap',
        status: 'completed',
        summary_for_human: '工作区建好了',
        used_skill_or_mcp: 'cockpit-bootstrap',
      },
      execIn(project),
    )
    assert.equal(value.ok, true)
    assert.equal(value.capabilityWarning, undefined, '命中方法时不该有 warning')
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('cockpit_report 阶段能力：constraint 不能冒充 method；optional 能力在 allowed 里可命中', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dc-cap-tool-'))
  try {
    const report = createToolDefinitions(fakeCtx).find((item) => item.name === 'cockpit_report')
    // 代码开发的 constraint=ponytail，method=tdd-loop ⇒ ponytail 不能当方法证据
    await assert.rejects(
      () =>
        report.execute(
          {
            iteration_id: 'v1.0',
            stage: 'implementation',
            status: 'completed',
            summary_for_human: '代码写好了',
            task_ref: 'T1',
            write_scope: ['src/**'],
            used_skill_or_mcp: 'ponytail',
          },
          execIn(project),
        ),
      /本阶段（代码开发）必须使用 cockpit-implementation.*stage-capability-required/,
    )
    // method 命中即可写回执
    const value = await report.execute(
      {
        iteration_id: 'v1.0',
        stage: 'implementation',
        status: 'completed',
        summary_for_human: '代码写好了',
        task_ref: 'T1',
        write_scope: ['src/**'],
        used_skill_or_mcp: 'cockpit-implementation, tdd-loop',
      },
      execIn(project),
    )
    assert.equal(value.ok, true)

    // 可选能力（prototype 的 ui-ux-pro-max）在 allowed 里：可以作为方法证据
    const optional = await report.execute(
      {
        iteration_id: 'v1.0',
        stage: 'prototype',
        status: 'completed',
        summary_for_human: '原型定稿',
        used_skill_or_mcp: 'ui-ux-pro-max',
      },
      execIn(project),
    )
    assert.equal(optional.ok, true)

    // 证据能力（playwright）不能冒充当阶段 method：测试验证必须 verify-claims
    await assert.rejects(
      () =>
        report.execute(
          {
            iteration_id: 'v1.0',
            stage: 'testing',
            status: 'completed',
            summary_for_human: '跑过页面了',
            used_skill_or_mcp: 'playwright',
          },
          execIn(project),
        ),
      /本阶段（测试验证）必须使用 cockpit-testing.*stage-capability-required/,
    )
    // 架构契约的方法现在是 cockpit-architecture：constraint（ponytail）不能冒充
    await assert.rejects(
      () =>
        report.execute(
          {
            iteration_id: 'v1.0',
            stage: 'architecture',
            status: 'completed',
            summary_for_human: '契约写好了',
            used_skill_or_mcp: 'ponytail',
          },
          execIn(project),
        ),
      /本阶段（架构契约）必须使用 cockpit-architecture.*stage-capability-required/,
    )
    const architecture = await report.execute(
      {
        iteration_id: 'v1.0',
        stage: 'architecture',
        status: 'completed',
        summary_for_human: '契约写好了',
        used_skill_or_mcp: 'cockpit-architecture',
      },
      execIn(project),
    )
    assert.equal(architecture.ok, true)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})


test('cockpit_init trellisInit:true 在无 subprocess 的 profile 里安全跳过，不阻断 init', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dc-init-trellis-'))
  try {
    const init = createToolDefinitions(fakeCtx).find((item) => item.name === 'cockpit_init')
    const result = await init.execute({ cwd: project, dryRun: false, trellisInit: true }, execIn(project))
    assert.equal(result.ok, true)
    assert.equal(result.applied, true)
    assert.equal(result.trellisInit.status, 'skipped')
    assert.equal(result.trellisInit.reason, 'subprocess-missing')
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})
test('cockpit_init trellisInit:true 对已初始化项目也生效（applied=false 不阻断升级）', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dc-init-trellis-main-'))
  const spawnCalls = []
  const subprocess = {
    async resolveExecutable(name) {
      if (name === 'pwsh') return 'pwsh'
      return 'trellis.cmd'
    },
    spawn(spec) {
      spawnCalls.push(spec)
      return {
        done: Promise.resolve({ exitCode: 0 }),
        collected: {
          stdout: { readFrom: () => ({ text: '' }) },
          stderr: { readFrom: () => ({ text: '' }) },
        },
      }
    },
  }
  try {
    const ctx = { get: (name) => (name === 'subprocess' ? subprocess : undefined), logger: { warn() {} } }
    const init = createToolDefinitions(ctx).find((item) => item.name === 'cockpit_init')
    const first = await init.execute({ cwd: project, dryRun: false }, execIn(project))
    assert.equal(first.applied, true)

    const upgraded = await init.execute({ cwd: project, dryRun: false, trellisInit: true }, execIn(project))
    assert.equal(upgraded.applied, false, '第二次 init 本身不再创建文件')
    assert.equal(upgraded.trellisInit.status, 'done')
    assert.equal(spawnCalls.length, 1, 'even when applied=false, trellis init must run')
    assert.ok(spawnCalls[0].argv.includes('--dsh'))
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})