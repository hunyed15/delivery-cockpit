/**
 * 端到端：真实临时项目从"未初始化"一路走到"下一轮迭代"，每一步都必须给出唯一动作。
 *
 * 为什么要有这层：单模块测试各自绿，不代表串起来还是同一个故事。这条用例把
 * init → 回执 → prd → 原型批准 → 任务 → 验收表 → 发布 串成一次真实推进，
 * 断言状态机的每一步输出。它也是"面板四区数据够不够用"的最低证据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { approveDecision, approvePrototype } from '../lib/approvals.js'
import { addAcceptanceEvidence, setAcceptanceResult } from '../lib/acceptance.js'
import { readEvidence } from '../lib/evidence.js'
import { buildFeatureBoard, extractFeatures, readPrdText } from '../lib/features.js'
import { applyInit, planInit } from '../lib/init.js'
import { buildDetailModel, buildOverviewRow } from '../lib/model.js'
import { entryForStage, loadPlaybook, resolveCapabilities, STAGE_DEFS } from '../lib/playbook.js'
import { appendReceipt } from '../lib/receipts.js'
import { deriveDecision } from '../lib/state.js'

const PACKAGE_DIR = new URL('..', import.meta.url)
const BUILTIN_PLAYBOOK = await readFile(new URL('templates/playbook.json', PACKAGE_DIR), 'utf8')

async function makeProject() {
  const dir = await mkdtemp(join(tmpdir(), 'dc-int-'))
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'demo-app',
        packageManager: 'pnpm@9.12.0',
        dependencies: { next: '15.0.0', react: '19.0.0', 'react-dom': '19.0.0' },
        scripts: { dev: 'next dev', build: 'next build' },
      },
      null,
      2,
    ),
    'utf8',
  )
  return dir
}

/** 能力探测在测试里用确定的假集合，让"缺能力"与"读不到"都不掺进来。 */
function fakeServices(playbook) {
  return { skills: null, tools: new Set(), mcp: new Set(), missingHints: playbook?.missingHints ?? {} }
}

async function detailOf(projectPath) {
  const evidence = await readEvidence(projectPath)
  const loaded = await loadPlaybook(projectPath, BUILTIN_PLAYBOOK)
  const services = fakeServices(loaded.playbook)
  const stageCapabilities = {}
  for (const stage of STAGE_DEFS) {
    stageCapabilities[stage.id] = await resolveCapabilities(entryForStage(loaded.playbook, stage.id), services)
  }
  return buildDetailModel({ evidence, playbook: loaded.playbook, stageCapabilities, generatedAt: new Date().toISOString() })
}

function assertHumanLine(decision) {
  assert.ok(typeof decision.title === 'string' && decision.title.length > 0, '必须有下一步标题')
  assert.ok([...decision.title].length <= 20, `标题要短（实际 ${[...decision.title].length} 字）：${decision.title}`)
  assert.ok([...decision.reason].length <= 40, `理由要短（实际 ${[...decision.reason].length} 字）：${decision.reason}`)
  assert.ok(!/`|\bconst\b|=>/.test(decision.title + decision.reason), '人话里不该出现代码片段')
}

async function decisionOf(projectPath) {
  const evidence = await readEvidence(projectPath)
  const decision = deriveDecision(evidence)
  assertHumanLine(decision)
  return { decision, evidence }
}

/** 9 阶段的技术门证据：架构契约、测试报告、发布清单。 */
async function writeArchitecture(project) {
  await mkdir(join(project, 'docs'), { recursive: true })
  await writeFile(
    join(project, 'docs', 'architecture.md'),
    '# 架构\n\n## 组件\nWeb 层 + 存储层\n\n## 数据模型\nCustomer\n\n## 接口清单\nGET /customers\n\n## 关键决策\n- 单体优先\n',
    'utf8',
  )
  await writeFile(join(project, 'docs', 'api.md'), '# API\n\nGET /customers\n', 'utf8')
}

async function writeTestReport(project) {
  await writeFile(
    join(project, '.dsh', 'plugin-state', 'test-report.json'),
    JSON.stringify({ command: 'node --test', passed: 10, failed: 0, skipped: 0, at: '2026-11-22T00:00:00.000Z' }),
    'utf8',
  )
}

async function writeReleaseManifest(project) {
  const artifact = join(project, 'dist', 'app.zip')
  await mkdir(join(project, 'dist'), { recursive: true })
  const content = 'build artifact'
  await writeFile(artifact, content, 'utf8')
  const sha256 = createHash('sha256').update(content).digest('hex')
  await writeFile(
    join(project, '.dsh', 'plugin-state', 'release.json'),
    JSON.stringify({
      version: 'v1.0',
      artifacts: [{ path: 'dist/app.zip', sha256 }],
      rollback: 'git revert v1.0',
      at: '2026-11-22T00:00:00.000Z',
    }),
    'utf8',
  )
}

test('从空项目到下一轮迭代：每一步都有唯一动作，且人不被卡住', async () => {
  const project = await makeProject()
  try {
    // 1) 未初始化 → 初始化
    let { decision } = await decisionOf(project)
    assert.equal(decision.kind, 'init')
    assert.equal(decision.stageId, 'bootstrap')

    // 2) 初始化之后（名片名字由目录名回退、定位留空等人填）→ 想清楚
    const plan = await planInit(project)
    assert.equal(plan.files.filter((file) => file.status === 'create').length, 4)
    const applied = await applyInit(project, plan)
    assert.equal(applied.applied, true)
    ;({ decision } = await decisionOf(project))
    assert.equal(decision.kind, 'brainstorm')
    assert.equal(decision.stageId, 'requirements')

    // 3) 迭代开始 + PRD 写出来 + 架构契约 → 先请人确认范围，再签架构，最后才看原型
    await appendReceipt(project, {
      iteration_id: 'v1.0',
      stage: 'requirements',
      status: 'completed',
      summary_for_human: '需求收敛成 prd.md',
      used_skill_or_mcp: 'trellis-brainstorm',
    })
    await writeFile(join(project, 'prd.md'), '# 客户管理\n\n## 目标用户\n小团队\n', 'utf8')
    await writeArchitecture(project)
    let evidence = (await decisionOf(project)).evidence
    assert.equal(evidence.iteration.current, 'v1.0')
    assert.equal(evidence.prd.found, true)
    assert.equal(evidence.approval.approved, false)
    assert.equal(evidence.approval.decisions.scope.approved, false, '新迭代的决策门默认全未签')
    ;({ decision } = await decisionOf(project))
    assert.equal(decision.kind, 'scope-approval')
    assert.equal(decision.stageId, 'requirements')

    // 4) 范围签核后停在架构签核（契约文件已齐才能签）
    const scopeSigned = await approveDecision(project, 'v1.0', 'scope')
    assert.equal(scopeSigned.ok, true)
    ;({ decision } = await decisionOf(project))
    assert.equal(decision.kind, 'architecture-approval')
    assert.equal(decision.stageId, 'architecture')
    const architectureSigned = await approveDecision(project, 'v1.0', 'architecture')
    assert.equal(architectureSigned.ok, true)

    // 5) 没有原型文件时批准要被拒绝；有了原型 → 人点通过 → 进写代码（还没有任务，先拆任务）
    ;({ decision } = await decisionOf(project))
    assert.equal(decision.kind, 'prototype')
    assert.equal(decision.stageId, 'prototype')
    assert.deepEqual(await approvePrototype(project, 'v1.0'), { ok: false, error: 'prototype-missing' })
    await writeFile(join(project, 'prototype.html'), '<!doctype html><title>prototype</title>', 'utf8')
    const approved = await approvePrototype(project, 'v1.0')
    assert.equal(approved.ok, true)
    ;({ decision } = await decisionOf(project))
    assert.equal(decision.kind, 'coding')
    assert.equal(decision.stageId, 'implementation')

    // 6) 建了任务 → 继续写代码
    await mkdir(join(project, '.trellis', 'tasks', 'T1'), { recursive: true })
    await writeFile(
      join(project, '.trellis', 'tasks', 'T1', 'task.json'),
      JSON.stringify({ id: 'T1', title: '客户列表', status: 'in_progress' }),
      'utf8',
    )
    ;({ decision, evidence } = await decisionOf(project))
    assert.equal(decision.kind, 'coding')
    assert.equal(evidence.tasks.open, 1)

    // 7) 任务做完、审核账本没有 → 不能假装"审核过了"，直接落到生成验收清单
    await writeFile(
      join(project, '.trellis', 'tasks', 'T1', 'task.json'),
      JSON.stringify({ id: 'T1', title: '客户列表', status: 'completed' }),
      'utf8',
    )
    await writeTestReport(project)
    ;({ decision, evidence } = await decisionOf(project))
    assert.equal(evidence.review.available, false)
    assert.equal(evidence.review.reason, 'no-ledger')
    assert.equal(decision.kind, 'acceptance-draft')

    // 8) 验收表为空不算通过；有条目但没结果 → 验效果
    assert.equal(evidence.acceptance.empty, true)
    await writeFile(
      join(project, '.dsh', 'plugin-state', 'acceptance.json'),
      JSON.stringify({ schemaVersion: 1, iteration_id: 'v1.0', items: [{ id: 'A1', title: '能添加客户', result: null, evidence: [] }] }),
      'utf8',
    )
    ;({ decision } = await decisionOf(project))
    assert.equal(decision.kind, 'verification')
    assert.equal(decision.stageId, 'acceptance')

    // 9) pass 必须带证据；只有 result 不算
    await writeFile(
      join(project, '.dsh', 'plugin-state', 'acceptance.json'),
      JSON.stringify({ schemaVersion: 1, iteration_id: 'v1.0', items: [{ id: 'A1', title: '能添加客户', result: 'pass', evidence: [] }] }),
      'utf8',
    )
    ;({ decision } = await decisionOf(project))
    assert.equal(decision.kind, 'verification', '没有证据的 pass 不能算通过')

    // 10) 有证据的 pass → 先请人签验收；发布清单还不齐时先提示补清单
    await writeFile(
      join(project, '.dsh', 'plugin-state', 'acceptance.json'),
      JSON.stringify({ schemaVersion: 1, iteration_id: 'v1.0', items: [{ id: 'A1', title: '能添加客户', result: 'pass', evidence: ['shots/add.png'] }] }),
      'utf8',
    )
    await mkdir(join(project, 'shots'), { recursive: true })
    await writeFile(join(project, 'shots', 'add.png'), 'png', 'utf8')
    ;({ decision } = await decisionOf(project))
    assert.equal(decision.kind, 'acceptance-approval')
    assert.equal(decision.stageId, 'acceptance')
    const acceptanceSigned = await approveDecision(project, 'v1.0', 'acceptance')
    assert.equal(acceptanceSigned.ok, true)
    ;({ decision } = await decisionOf(project))
    assert.equal(decision.kind, 'release')
    assert.equal(decision.priority, 12.5, '清单没写时先补发布清单')

    // 11) 清单齐全 → 请人批准发布；批准后才真正"发出去"
    await writeReleaseManifest(project)
    ;({ decision } = await decisionOf(project))
    assert.equal(decision.kind, 'release-approval')
    assert.equal(decision.stageId, 'release')
    const releaseSigned = await approveDecision(project, 'v1.0', 'release')
    assert.equal(releaseSigned.ok, true)
    ;({ decision } = await decisionOf(project))
    assert.equal(decision.kind, 'release')
    assert.equal(decision.priority, 13)

    // 12) 发布回执落盘 → 开启下一轮
    await appendReceipt(project, {
      iteration_id: 'v1.0',
      stage: 'release',
      status: 'completed',
      summary_for_human: 'v1.0 打出构建产物并记了链接',
    })
    ;({ decision } = await decisionOf(project))
    assert.equal(decision.kind, 'next-iteration')
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('待人工决策最高优：与 status 填什么无关', async () => {
  const project = await makeProject()
  try {
    const plan = await planInit(project)
    await applyInit(project, plan)
    await appendReceipt(project, {
      iteration_id: 'v1.0',
      stage: 'requirements',
      status: 'in_progress',
      summary_for_human: '登录方式需要你拍板',
      needs_human_decision: { title: '登录方式选哪种', options: ['手机号', '邮箱'], recommended: '手机号' },
    })
    const { decision, evidence } = await decisionOf(project)
    assert.equal(decision.kind, 'decide')
    assert.match(decision.title, /登录方式选哪种/)
    assert.ok(evidence.receipts.receipts.some((item) => item.needs_human_decision))
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('面板详情与总览来自同一份证据：金额/数字不跨源', async () => {
  const project = await makeProject()
  try {
    const plan = await planInit(project)
    await applyInit(project, plan)
    // 账本里写一行坏数据 + 一行好数据
    await mkdir(join(project, '.dsh', 'plugin-state'), { recursive: true })
    await writeFile(
      join(project, '.dsh', 'plugin-state', 'receipts.jsonl'),
      `{ this is not json\n${JSON.stringify({ id: 'r-1', at: '2026-01-01T00:00:00.000Z', iteration_id: 'bootstrap', stage: 'bootstrap', status: 'completed', summary_for_human: '建好了' })}\n`,
      'utf8',
    )
    const model = await detailOf(project)
    assert.equal(model.ledger.badLines, 1, '坏行要计数')
    assert.equal(model.ledger.total, 1, '好行照常读到')
    assert.equal(model.ledger.receipts[0].summary, '建好了')

    const evidence = await readEvidence(project)
    const row = buildOverviewRow({ id: 'w1', title: 'demo', path: project, evidence, generatedAt: new Date().toISOString() })
    assert.equal(row.initialized, true)
    assert.equal(row.nextKind, model.nextAction.kind)
    assert.equal(row.degraded, false)
    assert.equal(row.path, project)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('验收失效联动阶段门：通过 → 截图变化 → 回验效果 → 重新确认 → 放行', async () => {
  const project = await makeProject()
  try {
    const plan = await planInit(project)
    await applyInit(project, plan)
    // 迭代与前置阶段：prd + 原型批准 + 任务全部完成
    await appendReceipt(project, {
      iteration_id: 'v1.0',
      stage: 'requirements',
      status: 'completed',
      summary_for_human: '需求定了',
    })
    await writeFile(join(project, 'prd.md'), '# 客户管理\n\n## 4. 功能需求\n\n### FR-1 客户列表（P0）\n', 'utf8')
    await writeArchitecture(project)
    await writeFile(
      join(project, '.dsh', 'plugin-state', 'approvals.json'),
      JSON.stringify({
        'v1.0': {
          prototypeApprovedAt: '2026-11-20T10:00:00.000Z',
          prototype: 'prototype.html',
          // 四个决策门先按"已签"准备：这条用例验的是验收失效联动，不是签核流程本身。
          scopeApprovedAt: '2026-11-20T10:01:00.000Z',
          architectureApprovedAt: '2026-11-20T10:02:00.000Z',
          acceptanceApprovedAt: '2026-11-20T10:03:00.000Z',
          releaseApprovedAt: '2026-11-20T10:04:00.000Z',
        },
      }),
      'utf8',
    )
    await mkdir(join(project, '.trellis', 'tasks', 'T1'), { recursive: true })
    await writeFile(
      join(project, '.trellis', 'tasks', 'T1', 'task.json'),
      JSON.stringify({ id: 'T1', title: 'FR-1 客户列表', status: 'completed', relatedFiles: ['web/orders'] }),
      'utf8',
    )
    await appendReceipt(project, {
      iteration_id: 'v1.0',
      stage: 'implementation',
      status: 'completed',
      summary_for_human: '列表做完了',
      feature_ids: ['FR-1'],
      write_scope: ['web/orders/**'],
      task_ref: 'T1',
    })
    await mkdir(join(project, 'shots'), { recursive: true })
    await writeFile(join(project, 'shots', 'a1.png'), Buffer.from([1, 2, 3]))
    await writeFile(
      join(project, '.dsh', 'plugin-state', 'acceptance.json'),
      JSON.stringify({
        schemaVersion: 1,
        iteration_id: 'v1.0',
        items: [{ id: 'A1', feature_ref: 'FR-1', title: '能添加客户', result: null, evidence: [], at: null }],
      }),
      'utf8',
    )

    // 1) 人点通过：验收全绿 ⇒ 下一步是发出去
    await writeTestReport(project)
    await writeReleaseManifest(project)
    const passed = await setAcceptanceResult(project, { item_id: 'A1', result: 'pass', evidence: ['shots/a1.png'] })
    assert.equal(passed.item.stale, false)
    let evidence = await readEvidence(project)
    assert.equal(deriveDecision(evidence).kind, 'release')

    // 2) 页面改了，重新截图（changed）⇒ 该条通过自动失效，阶段门退回验效果
    await writeFile(join(project, 'shots', 'a2.png'), Buffer.from([9, 9, 9]))
    const shot = await addAcceptanceEvidence(project, {
      item_id: 'A1',
      evidence: ['shots/a2.png'],
      shotDiff: { verdict: 'changed', baseline: 'shots/a1.png', ratio: 0.03, changedPixels: 300, totalPixels: 10000 },
    })
    assert.equal(shot.invalidated, true)
    evidence = await readEvidence(project)
    assert.equal(evidence.acceptance.stale, 1)
    assert.equal(evidence.acceptance.passed, 0)
    const blockedDecision = deriveDecision(evidence)
    assert.equal(blockedDecision.kind, 'verification')
    assert.match(blockedDecision.reason, /截图变化失效/)

    // 3) 人重新确认通过 ⇒ 失效清除，阶段门重新放行
    const rePassed = await setAcceptanceResult(project, { item_id: 'A1', result: 'pass', evidence: ['shots/a2.png'] })
    assert.equal(rePassed.item.stale, false)
    evidence = await readEvidence(project)
    assert.equal(evidence.acceptance.stale, 0)
    assert.equal(evidence.acceptance.passed, 1)
    assert.equal(deriveDecision(evidence).kind, 'release')
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('功能账端到端：PRD 的 FR 标题 → 回执 → 验收，三路证据串成一张表', async () => {
  const project = await makeProject()
  try {
    const plan = await planInit(project)
    await applyInit(project, plan)
    await writeFile(
      join(project, 'prd.md'),
      ['# 客户管理', '', '## 4. 功能需求', '', '### FR-1 客户列表（P0）', '', '### FR-2 客户导入（P1）', ''].join('\n'),
      'utf8',
    )
    await appendReceipt(project, {
      iteration_id: 'v1.0',
      stage: 'implementation',
      status: 'completed',
      summary_for_human: '客户列表做完了',
      feature_ids: ['FR-1'],
      task_ref: 'T1',
      write_scope: ['web/orders/**'],
      artifacts: ['web/orders/list.ts'],
    })
    await appendReceipt(project, {
      iteration_id: 'v1.0',
      stage: 'implementation',
      status: 'completed',
      summary_for_human: '导入写完，等验收',
      feature_ids: ['FR-2'],
      task_ref: 'T2',
      write_scope: ['web/import/**'],
    })
    await writeFile(
      join(project, '.dsh', 'plugin-state', 'acceptance.json'),
      JSON.stringify({
        schemaVersion: 1,
        iteration_id: 'v1.0',
        items: [
          { id: 'A1', feature_ref: 'FR-1', title: '能添加客户', result: 'pass', evidence: ['shots/add.png'] },
          { id: 'A2', feature_ref: 'FR-2', title: '能导入 Excel', result: null, evidence: [] },
        ],
      }),
      'utf8',
    )

    const evidence = await readEvidence(project)
    assert.equal(evidence.prd.path, 'prd.md')
    const prdText = await readPrdText(project, evidence.prd.path)
    const board = buildFeatureBoard({
      extracted: extractFeatures(prdText.text),
      prd: { path: evidence.prd.path, missing: prdText.missing },
      receipts: evidence.receipts.receipts,
      acceptance: evidence.acceptance,
      review: evidence.review,
    })

    assert.equal(board.source, 'prd')
    assert.equal(board.counts.total, 2)
    const fr1 = board.items.find((item) => item.id === 'FR-1')
    const fr2 = board.items.find((item) => item.id === 'FR-2')
    assert.equal(fr1.status, 'done', '验收 pass + 证据 ⇒ 已完成')
    assert.equal(fr1.acceptance.passed, 1)
    assert.equal(fr2.status, 'pending-acceptance', '有验收条目但没人填结果 ⇒ 待验收')
    // 没有审核账本：bug 数不可知，必须 known=false（界面显示 —），不能显示 0
    assert.equal(fr1.bugs.known, false)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('技能读不到时是"无法检测"，不是"没装"', async () => {
  const project = await makeProject()
  try {
    const loaded = await loadPlaybook(project, BUILTIN_PLAYBOOK)
    const entry = entryForStage(loaded.playbook, 'prototype')
    const resolved = await resolveCapabilities(entry, {
      skills: null,
      tools: new Set(),
      mcp: new Set(),
      missingHints: loaded.playbook.missingHints,
    })
    const skills = resolved.filter((item) => item.kind === 'skill')
    assert.ok(skills.length > 0, 'prototype 阶段应当有技能能力')
    for (const item of skills) {
      assert.equal(item.present, 'unknown')
      assert.equal(item.missingMessage, null, '读不到不许生成缺失提示')
    }
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})
