/**
 * 评审引擎合并后的工具契约与行为测试（不调用 Claude 模型、不联网）。
 *
 * 覆盖：三个工具的 schema/render、命令行拼装（UTF-8 前置段 / 参数引号 / 数组实参）、
 * 结论归一（fix / gate blocked / exit 2 / dry-run / cached）、subprocess 缺失时的明确错误、
 * dryRun 真实干跑（临时 git 仓库，确认不落 history/state/报告）、处置账本写入、hook 安装。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, createToolDefinitions, TOOL_DEFINITIONS } from '../index.js'
import {
  BUNDLED_ENGINE,
  BUNDLED_INSTALLER,
  ENGINE_API,
  createReviewToolDefinitions,
} from '../lib/review/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = dirname(HERE)
const REVIEW_TOOL_NAMES = ['claude_review', 'claude_review_disposition', 'claude_review_install_hook']

const fakeCtx = (services = {}) => ({ get: (name) => services[name], logger: { warn() {} } })
const execIn = (cwd, agentId) => ({ agent: { id: agentId, session: { header: { cwd } } } })

const exists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function cannedSubprocess(stdout, exitCode, collector) {
  return {
    async resolveExecutable(command) {
      return command
    },
    spawn(spec) {
      if (collector) collector.argv = spec.argv
      return {
        collected: {
          stdout: { readFrom: () => ({ text: stdout, nextOffset: 0 }) },
          stderr: { readFrom: () => ({ text: collector?.stderr ?? '', nextOffset: 0 }) },
        },
        done: Promise.resolve({ exitCode, signal: null }),
        terminate() {},
      }
    },
  }
}

// 真实 spawn：dryRun 干跑与 hook 安装要落真文件，必须走真进程。
function realSubprocess() {
  return {
    async resolveExecutable(command) {
      return command
    },
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, windowsHide: true })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8')
      })
      const done = new Promise((res) => {
        child.on('close', (code) => res({ exitCode: code, signal: null }))
      })
      return {
        collected: {
          stdout: { readFrom: () => ({ text: stdout, nextOffset: 0 }) },
          stderr: { readFrom: () => ({ text: stderr, nextOffset: 0 }) },
        },
        done,
        terminate() {
          child.kill()
        },
      }
    },
  }
}

const toolsWith = (subprocess, settings) =>
  createReviewToolDefinitions(fakeCtx(subprocess ? { subprocess } : {}), settings ? { settings } : {})

const getTool = (tools, name) => tools.find((tool) => tool.name === name)

const run = (command, args, cwd) => spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true })

const canRunRealPwsh = () => run('pwsh', ['-NoProfile', '-Command', 'exit 0'], PLUGIN_ROOT).status === 0
const canRunGit = () => run('git', ['--version'], PLUGIN_ROOT).status === 0

/** 临时 git 仓库 + 一个提交：引擎要求 git 工作区，dryRun 也要能解析 HEAD。 */
async function makeGitRepo(prefix, options = {}) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  assert.equal(run('git', ['init', '-q'], root).status, 0, 'git init 失败')
  await writeFile(join(root, 'README.md'), '# demo\n', 'utf8')
  assert.equal(run('git', ['add', '-A'], root).status, 0, 'git add 失败')
  const commit = run('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init'], root)
  assert.equal(commit.status, 0, `git commit 失败：${commit.stderr}`)
  // 引擎把「干净工作区」直接判成 nothing-to-review（在 dryRun 分支之前），
  // 要验证 dryRun 的组装语义，必须留下一处未提交改动。
  if (options.dirty === true) {
    await writeFile(join(root, 'README.md'), '# demo\nchanged line\n', 'utf8')
  }
  return root
}

/** 本地账本脚手架：与引擎跑过一次后的结构一致（task.json + review/history.jsonl）。 */
async function makeLocalLedger(project) {
  const ledger = join(project, '.dsh', 'claude-review', 'ledger')
  await mkdir(join(ledger, 'review'), { recursive: true })
  await writeFile(join(ledger, 'task.json'), JSON.stringify({ id: 'local', name: 'local', title: 'demo' }), 'utf8')
  await writeFile(
    join(ledger, 'review', 'history.jsonl'),
    `${JSON.stringify({ round: 1, mode: 'full', verdict: 'pass', critical: 0, important: 0, minor: 0 })}\n`,
    'utf8',
  )
  return ledger
}

test('三个评审工具都注册在插件工具集里，且声明了 output.schema / output.render', () => {
  for (const definitions of [TOOL_DEFINITIONS, createToolDefinitions(fakeCtx())]) {
    for (const name of REVIEW_TOOL_NAMES) {
      assert.ok(definitions.some((tool) => tool.name === name), `缺少工具 ${name}`)
    }
  }

  const review = getTool(TOOL_DEFINITIONS, 'claude_review')
  assert.equal(typeof review.parameters, 'object')
  assert.equal(review.parameters.additionalProperties, false)
  assert.deepEqual(review.parameters.properties.mode.enum, ['incremental', 'full', 'gate', 'range'])
  assert.deepEqual(review.parameters.properties.profile.enum, ['quick', 'deep'])
  assert.deepEqual(review.output.schema.required, ['ok', 'mode', 'verdict', 'exitCode'])
  // 引擎回退信息是可选字段：旧调用不依赖它
  assert.equal(review.output.schema.properties.engineSource.type, 'string')
  const rendered = review.output.render({}, { ok: true, mode: 'full', verdict: 'pass', critical: 0, important: 0, minor: 0 })
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /verdict: pass/)

  const disposition = getTool(TOOL_DEFINITIONS, 'claude_review_disposition')
  assert.deepEqual(disposition.output.schema.required, ['ok', 'written'])
  assert.equal(disposition.parameters.properties.entries.items.properties.status.enum.length, 3)

  const install = getTool(TOOL_DEFINITIONS, 'claude_review_install_hook')
  assert.deepEqual(install.output.schema.required, ['ok', 'installed'])
  assert.ok(install.parameters.properties.force)
})

test('claude_review 命令行：-Command + UTF-8 前置段、参数名裸写、值带引号、数组实参、超时与会话透传', async () => {
  const collector = {}
  const tool = getTool(toolsWith(cannedSubprocess('{"ok":true,"mode":"gate","verdict":"gate-pass"}', 0, collector)), 'claude_review')
  // 不传 cwd：应从会话工作目录（exec.agent.session.header.cwd）解析
  const result = await tool.execute(
    { mode: 'gate', description: '带 中文 的描述', checks: ['a b', '第二项'] },
    execIn(PLUGIN_ROOT, 'session-abc'),
  )
  const line = (collector.argv ?? []).join(' ')

  assert.equal(collector.argv[0], 'pwsh')
  assert.ok(collector.argv.includes('-Command'))
  assert.match(line, /\[Console\]::OutputEncoding/)
  assert.ok(!line.includes("'-Mode'"), '参数名不能被引号包裹')
  assert.ok(line.includes("'gate'"))
  assert.ok(line.includes(`-Cwd '${PLUGIN_ROOT}'`), '默认取会话工作目录')
  assert.ok(line.includes("'带 中文 的描述'"))
  assert.ok(line.includes("-Checks 'a b','第二项'"), line.slice(0, 300))
  assert.ok(line.includes("-Storage 'auto'"), 'storage 必须取自 reviewStorage')
  assert.ok(line.includes('-TimeoutSec 1500'), line.slice(0, 300))
  assert.ok(line.includes("-SessionId 'session-abc'"), line.slice(0, 300))
  assert.ok(line.includes(`'${BUNDLED_ENGINE.replace(/'/g, "''")}'`), '引擎回退到插件自带 scripts/')
  assert.equal(result.enginePath, BUNDLED_ENGINE)
  assert.equal(result.engineSource, 'bundled')
})

test('apply 在没有 subprocess 服务时仍注册全部六个工具（subprocess 不是硬依赖）', async () => {
  const registered = new Map()
  const ctx = {
    effect(fn) {
      return fn()
    },
    get() {
      return undefined
    },
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => {}
      },
    },
    logger: { warn() {} },
  }
  apply(ctx, { panelRetryAttempts: 1, panelRetryMs: 5, panelWatchdogMs: 20 })
  for (const name of [
    'cockpit_report',
    'cockpit_init',
    'cockpit_acceptance',
    ...REVIEW_TOOL_NAMES,
  ]) {
    assert.ok(registered.has(name), `缺 subprocess 时也应注册 ${name}`)
  }
  assert.equal(registered.size, 6)
})

test('claude_review 透传 range/profile 参数，并遵守 reviewStorage 配置', async () => {
  const collector = {}
  const tool = getTool(
    toolsWith(cannedSubprocess('{"ok":true,"dryRun":true,"mode":"range"}', 0, collector), { reviewStorage: 'trellis', timeoutSec: 60 }),
    'claude_review',
  )
  await tool.execute({ mode: 'range', cwd: PLUGIN_ROOT, base: 'HEAD~1', head: 'HEAD', profile: 'deep', dryRun: true }, execIn(PLUGIN_ROOT))
  const line = (collector.argv ?? []).join(' ')
  assert.ok(line.includes("-Mode 'range'"))
  assert.ok(line.includes("-Base 'HEAD~1'"))
  assert.ok(line.includes("-Head 'HEAD'"))
  assert.ok(line.includes("-Profile 'deep'"))
  assert.ok(line.includes("-Storage 'trellis'"))
  assert.ok(line.includes('-TimeoutSec 60'))
  assert.ok(line.includes('-DryRun'))
})

test('claude_review 结论归一：fix 必须 ok=false；gate blocked 必须 ok=false 且保留原因', async () => {
  const fixEnvelope = JSON.stringify({ ok: true, mode: 'full', verdict: 'fix', critical: 1, important: 0, minor: 0, summary: 'x', report: 'r.json' })
  const fix = await getTool(toolsWith(cannedSubprocess(fixEnvelope, 1)), 'claude_review').execute({ mode: 'full', cwd: PLUGIN_ROOT }, execIn(PLUGIN_ROOT))
  assert.equal(fix.ok, false)
  assert.equal(fix.critical, 1)
  assert.match(fix.note, /必须先修/)

  const gateEnvelope = JSON.stringify({ ok: false, gate: 'blocked', reasons: ['快照不一致'] })
  const gate = await getTool(toolsWith(cannedSubprocess(gateEnvelope, 1)), 'claude_review').execute({ mode: 'gate', cwd: PLUGIN_ROOT }, execIn(PLUGIN_ROOT))
  assert.equal(gate.ok, false)
  assert.equal(gate.verdict, 'gate-blocked')
  assert.match(gate.note, /快照不一致/)
  assert.match(gate.note, /不要直接重跑 gate/)
})

test('claude_review 结论归一：dryRun / cached 标记，exit 2 抛可诊断错误', async () => {
  const dry = await getTool(toolsWith(cannedSubprocess('{"ok":true,"dryRun":true,"mode":"full","files":3}', 0)), 'claude_review').execute(
    { mode: 'full', cwd: PLUGIN_ROOT, dryRun: true },
    execIn(PLUGIN_ROOT),
  )
  assert.equal(dry.dryRun, true)
  assert.equal(dry.verdict, 'dry-run')

  const cached = await getTool(
    toolsWith(cannedSubprocess(JSON.stringify({ ok: true, cached: true, verdict: 'pass', mode: 'full', cost_usd: 0 }), 0)),
    'claude_review',
  ).execute({ mode: 'full', cwd: PLUGIN_ROOT }, execIn(PLUGIN_ROOT))
  assert.equal(cached.cached, true)
  assert.equal(cached.costUsd, 0)

  await assert.rejects(
    () =>
      getTool(toolsWith(cannedSubprocess(JSON.stringify({ ok: false, error: '审核超时（>1500s）' }), 2)), 'claude_review').execute(
        { mode: 'full', cwd: PLUGIN_ROOT },
        execIn(PLUGIN_ROOT),
      ),
    /审核未完成（exit 2）：审核超时/,
  )
})

test('缺 subprocess 时工具给明确错误，而不是让整个插件激活失败', async () => {
  const ctxWithout = fakeCtx()
  const tools = createReviewToolDefinitions(ctxWithout)
  for (const name of ['claude_review', 'claude_review_install_hook']) {
    await assert.rejects(() => getTool(tools, name).execute({ cwd: PLUGIN_ROOT }, execIn(PLUGIN_ROOT)), /缺少 subprocess 服务/)
  }
  // 工具仍然注册成功（契约断言不依赖服务存在）
  assert.equal(tools.length, 3)
})

test('旧目标引擎（无 claude-review-api 标记）回退插件自带引擎，并带可见 warning', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dc-review-old-engine-'))
  try {
    const engineDir = join(project, 'tools', 'claude-review')
    await mkdir(engineDir, { recursive: true })
    await writeFile(join(engineDir, 'Invoke-ClaudeReview.ps1'), "param([string]$Mode = 'full')\n", 'utf8')
    const envelope = JSON.stringify({ ok: true, dryRun: true, mode: 'full', storage: 'local' })
    const result = await getTool(toolsWith(cannedSubprocess(envelope, 0)), 'claude_review').execute(
      { mode: 'full', cwd: project, dryRun: true },
      execIn(project),
    )
    assert.equal(result.engineSource, 'bundled')
    assert.equal(result.enginePath, BUNDLED_ENGINE)
    assert.match(String(result.note), /回退/)
    // 自带的引擎必须带接口握手标记，否则这里会一直回退
    const head = await readFile(BUNDLED_ENGINE, 'utf8')
    assert.match(head.slice(0, 200), new RegExp(`claude-review-api:\\s*${ENGINE_API}`))
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('配置的 enginePath 不存在时明确报错', async () => {
  const tool = getTool(toolsWith(cannedSubprocess('{}', 0), { enginePath: 'nope/Invoke-ClaudeReview.ps1' }), 'claude_review')
  await assert.rejects(() => tool.execute({ mode: 'gate', cwd: PLUGIN_ROOT }, execIn(PLUGIN_ROOT)), /配置的 enginePath 不存在/)
})

test('claude_review dryRun 真实干跑：临时 git 仓库返回 ok:true/dryRun:true，不落报告/快照', async (t) => {
  if (!canRunRealPwsh() || !canRunGit()) {
    t.skip('pwsh / git 不可用，跳过真实干跑')
    return
  }
  const project = await makeGitRepo('dc-review-dryrun-', { dirty: true })
  try {
    const tool = getTool(createReviewToolDefinitions(fakeCtx({ subprocess: realSubprocess() })), 'claude_review')
    const value = await tool.execute({ mode: 'full', cwd: project, dryRun: true }, execIn(project))

    assert.equal(value.ok, true)
    assert.equal(value.dryRun, true)
    assert.equal(value.verdict, 'dry-run')
    assert.equal(value.exitCode, 0)
    assert.equal(value.enginePath, BUNDLED_ENGINE)
    assert.equal(value.engineSource, 'bundled')

    // dryRun 只组装输入：绝不能写出报告、快照或一轮历史（那会让 gate/缓存误判"已审过"）。
    const ledger = join(project, '.dsh', 'claude-review', 'ledger')
    const reviewDir = join(ledger, 'review')
    assert.equal(await exists(join(reviewDir, 'history.jsonl')), false, 'dryRun 不能写 history.jsonl')
    assert.equal(await exists(join(reviewDir, 'state.json')), false, 'dryRun 不能写 state.json（快照）')
    assert.equal(await exists(join(reviewDir, 'review-1.json')), false, 'dryRun 不能写报告')
    // 本地账本脚手架与组装出来的 prompt/role 是正常的：dryRun 的产物就是"可检查的审核输入"
    assert.equal(await exists(join(ledger, 'task.json')), true)
    const assembled = (await readdir(reviewDir)).filter((name) => /^prompt-\d+\.md$/.test(name))
    assert.ok(assembled.length >= 1, `应组装出 prompt 文件：${(await readdir(reviewDir)).join(',')}`)
    const prompt = await readFile(join(reviewDir, assembled[0]), 'utf8')
    assert.match(prompt, /README\.md/, 'dryRun 的 prompt 应包含本轮 diff')
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('claude_review_disposition 写本地账本 .dsh/claude-review/ledger，坏参数一个字节都不落盘', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dc-review-disp-'))
  try {
    const ledger = await makeLocalLedger(project)
    const tool = getTool(createReviewToolDefinitions(fakeCtx()), 'claude_review_disposition')

    const batch = await tool.execute(
      {
        cwd: project,
        entries: [
          { round: 3, key: 'aaa1', status: 'fixed', note: '已修空指针' },
          { round: 3, index: 2, status: 'deferred', note: '设计如此，下一版再说' },
        ],
      },
      execIn(project, 'session-abc'),
    )
    assert.equal(batch.ok, true)
    assert.equal(batch.written, 2)
    assert.equal(batch.taskDir, ledger)

    const file = join(ledger, 'review', 'dispositions.jsonl')
    let rows = (await readFile(file, 'utf8')).trim().split(/\r?\n/)
    assert.equal(rows.length, 2)
    assert.equal(JSON.parse(rows[0]).status, 'fixed')
    assert.equal(JSON.parse(rows[0]).sessionId, 'session-abc')

    const single = await tool.execute({ cwd: project, round: 3, key: 'bbb2', status: 'counter-evidence' }, execIn(project))
    assert.equal(single.written, 1)
    rows = (await readFile(file, 'utf8')).trim().split(/\r?\n/)
    assert.equal(rows.length, 3)

    // 坏参数：status / round / key+index 都必须在写盘前拒绝
    await assert.rejects(() => tool.execute({ cwd: project, entries: [] }, execIn(project)), /需要 entries/)
    await assert.rejects(
      () => tool.execute({ cwd: project, entries: [{ round: 1, key: 'x', status: 'bogus' }] }, execIn(project)),
      /status 必须是 fixed/,
    )
    await assert.rejects(() => tool.execute({ cwd: project, key: 'x', status: 'fixed' }, execIn(project)), /round 必须是数字/)
    await assert.rejects(
      () => tool.execute({ cwd: project, entries: [{ round: 1, status: 'fixed' }] }, execIn(project)),
      /key 与 index 至少要给一个/,
    )
    assert.equal((await readFile(file, 'utf8')).trim().split(/\r?\n/).length, 3, '被拒绝的批次不能留下半行')
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('claude_review_disposition：Trellis 下显式 taskDir 才写，不猜任务', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dc-review-trellis-'))
  try {
    const taskDir = join(project, '.trellis', 'tasks', '11-12-demo')
    await mkdir(join(taskDir, 'review'), { recursive: true })
    await writeFile(join(taskDir, 'task.json'), JSON.stringify({ id: 'demo', title: '演示' }), 'utf8')
    const tool = getTool(createReviewToolDefinitions(fakeCtx()), 'claude_review_disposition')

    const value = await tool.execute({ cwd: project, taskDir, round: 1, key: 'k1', status: 'fixed' }, execIn(project))
    assert.equal(value.written, 1)
    assert.equal(value.taskDir, taskDir)
    const rows = (await readFile(join(taskDir, 'review', 'dispositions.jsonl'), 'utf8')).trim().split(/\r?\n/)
    assert.equal(rows.length, 1)

    await assert.rejects(() => tool.execute({ cwd: project, round: 1, key: 'k2', status: 'fixed' }, execIn(project)), /请显式传 taskDir/)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('claude_review_install_hook：-File 调用安装器，透传 force / taskDir；失败带原因', async () => {
  const collector = {}
  const tool = getTool(toolsWith(cannedSubprocess('已安装：hook', 0, collector)), 'claude_review_install_hook')
  const taskDirRel = join('.trellis', 'tasks', 'demo')
  const result = await tool.execute(
    { cwd: PLUGIN_ROOT, enginePath: 'tools/claude-review/Invoke-ClaudeReview.ps1', taskDir: taskDirRel, force: true },
    execIn(PLUGIN_ROOT),
  )
  const argv = collector.argv ?? []
  assert.deepEqual(argv.slice(0, 6), ['pwsh', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BUNDLED_INSTALLER])
  assert.ok(argv.includes('-Cwd') && argv.includes(PLUGIN_ROOT))
  assert.ok(argv.includes('-EnginePath') && argv.includes(join(PLUGIN_ROOT, 'tools', 'claude-review', 'Invoke-ClaudeReview.ps1')))
  assert.ok(argv.includes('-TaskDir') && argv.includes(join(PLUGIN_ROOT, taskDirRel)))
  assert.ok(argv.includes('-Force'))
  assert.equal(result.ok, true)
  assert.equal(result.installed, true)
  assert.equal(result.enginePath, join(PLUGIN_ROOT, 'tools', 'claude-review', 'Invoke-ClaudeReview.ps1'))

  const failing = getTool(toolsWith(cannedSubprocess('', 1)), 'claude_review_install_hook')
  await assert.rejects(() => failing.execute({ cwd: PLUGIN_ROOT }, execIn(PLUGIN_ROOT)), /安装失败（exit 1）：无输出/)
})

test('claude_review_install_hook 真实安装：写入 pre-commit；已存在时拒绝，-Force 先备份', async (t) => {
  if (!canRunRealPwsh() || !canRunGit()) {
    t.skip('pwsh / git 不可用，跳过真实 hook 安装')
    return
  }
  const project = await makeGitRepo('dc-review-hook-')
  try {
    const tool = getTool(createReviewToolDefinitions(fakeCtx({ subprocess: realSubprocess() })), 'claude_review_install_hook')
    const first = await tool.execute({ cwd: project }, execIn(project))
    assert.equal(first.ok, true)
    assert.equal(first.installed, true)
    assert.equal(first.enginePath, BUNDLED_ENGINE)

    const hooksDir = join(project, '.git', 'hooks')
    const hookPath = join(hooksDir, 'pre-commit')
    const content = await readFile(hookPath, 'utf8')
    assert.match(content, /^#!\/bin\/sh/)
    assert.match(content, /claude-code-review pre-commit gate/)
    assert.match(content, /Invoke-ClaudeReview\.ps1/)
    assert.ok(!content.includes('__ENGINE__'), '模板占位符必须被替换')

    // 不覆盖用户已有的 hook：第二次直接失败（安装器 throw，工具只透出 stderr 首行 —— 旧行为），原文件保持不动
    await assert.rejects(() => tool.execute({ cwd: project }, execIn(project)), /安装失败（exit 1）：/)
    assert.equal(await readFile(hookPath, 'utf8'), content)

    const forced = await tool.execute({ cwd: project, force: true }, execIn(project))
    assert.equal(forced.ok, true)
    assert.match(forced.output, /已备份/)
    const backups = (await readdir(hooksDir)).filter((name) => name.startsWith('pre-commit.bak-'))
    assert.equal(backups.length, 1, `应留下一个备份：${backups.join(',')}`)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('写授权：显式 cwd/taskDir/enginePath 未登记时拒绝（fail-closed）', async () => {
  const deny = async () => {
    throw new Error('拒绝写盘：不在任何 DSH 已登记工作区内')
  }
  const tools = createReviewToolDefinitions(fakeCtx(), { authorizeWrite: deny })
  const exec = execIn('C:\\\\outside\\\\demo', 'session-x')

  await assert.rejects(
    () => getTool(tools, 'claude_review').execute({ mode: 'full', cwd: 'C:\\\\outside\\\\demo', dryRun: true }, exec),
    /拒绝写盘/,
  )
  await assert.rejects(
    () =>
      getTool(tools, 'claude_review_disposition').execute(
        { cwd: 'C:\\\\outside\\\\demo', entries: [{ round: 1, key: 'abc', status: 'fixed', note: 'x' }] },
        exec,
      ),
    /拒绝写盘/,
  )
  await assert.rejects(
    () => getTool(tools, 'claude_review_install_hook').execute({ cwd: 'C:\\\\outside\\\\demo' }, exec),
    /拒绝写盘/,
  )
  await assert.rejects(
    () =>
      getTool(tools, 'claude_review_install_hook').execute(
        { cwd: 'C:\\\\outside\\\\demo', enginePath: 'C:\\\\outside\\\\evil.ps1' },
        exec,
      ),
    /拒绝写盘/,
  )
})