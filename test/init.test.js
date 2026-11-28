import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GITIGNORE_HINT,
  INIT_FILE_NAMES,
  applyInit,
  planInit,
} from '../lib/init.js'

const templatesDir = fileURLToPath(new URL('../templates/', import.meta.url))
const templateBytes = (name) => readFile(join(templatesDir, name))

async function makeProject(t, files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-init-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const [name, content] of Object.entries(files)) {
    const fullPath = join(dir, name)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, content, 'utf8')
  }
  return dir
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

test('planInit：只读不写盘，计划描述两个目录 + 四个文件', async (t) => {
  const dir = await makeProject(t, { '.gitignore': 'node_modules/\n' })
  const plan = await planInit(dir)

  assert.equal(plan.projectPath, resolve(dir))
  assert.equal(plan.stateDir, join(dir, '.dsh', 'plugin-state'))
  assert.equal(plan.trellisDir, join(dir, '.trellis'))
  assert.equal(plan.gitignoreHint, GITIGNORE_HINT)
  assert.deepEqual(plan.dirs.map((item) => item.status), ['create', 'create', 'create'])
  const stateFiles = plan.files.filter((item) => item.source !== 'plugin-skill')
  assert.deepEqual(stateFiles.map((item) => item.name), INIT_FILE_NAMES)
  const skillFiles = plan.files.filter((item) => item.source === 'plugin-skill')
  assert.ok(skillFiles.length >= 1, `插件技能至少 1 个，实际 ${skillFiles.length}`)
  assert.ok(skillFiles.some((item) => item.name === 'skills/cockpit-flow/SKILL.md'), '编排技能要被释放')
  assert.ok(plan.files.every((item) => item.status === 'create'))
  assert.equal(plan.files.find((item) => item.name === 'RULES.md').bytes, (await templateBytes('RULES.md')).length)
  assert.equal(plan.files.find((item) => item.name === 'project.json').source, 'generated')
  assert.equal(plan.files.find((item) => item.name === 'RULES.md').source, 'template')
  assert.equal(plan.files.find((item) => item.name === 'project.json').bytes > 0, true)
  assert.deepEqual(plan.errors, [])
  assert.deepEqual(plan.notes, [])

  assert.equal(await exists(join(dir, '.trellis')), false, 'plan 绝不能建目录')
  assert.equal(await exists(join(dir, '.dsh')), false, 'plan 绝不能建目录')
  assert.equal(await readFile(join(dir, '.gitignore'), 'utf8'), 'node_modules/\n', 'plan 绝不能动 .gitignore')
})

test('applyInit：只释放四个文件与两个目录，内容来自包内模板', async (t) => {
  const dir = await makeProject(t, { '.gitignore': 'node_modules/\n' })
  const plan = await planInit(dir)
  const result = await applyInit(dir, plan)

  assert.equal(result.dryRun, false)
  assert.equal(result.applied, true)
  assert.deepEqual(result.errors, [])
  assert.ok(result.created.includes('.dsh/plugin-state/RULES.md'))
  assert.ok(result.created.includes('.dsh/plugin-state/playbook.json'))
  assert.ok(result.created.includes('.dsh/skills/cockpit-flow/SKILL.md'))
  assert.ok(result.created.some((item) => item.includes('.dsh/skills/cockpit-flow/')), '编排技能要被释放到项目里')
  assert.deepEqual(result.skipped, [], '全新项目不该有 skipped')

  for (const name of ['RULES.md', 'playbook.json', 'acceptance.json']) {
    assert.deepEqual(await readFile(join(dir, '.dsh', 'plugin-state', name)), await templateBytes(name), `${name} 必须和模板逐字节一致`)
  }

  const entries = (await readdir(join(dir, '.dsh', 'plugin-state'))).sort()
  assert.deepEqual(entries, ['RULES.md', 'acceptance.json', 'playbook.json', 'project.json'].sort(), '只写这四个文件')

  const card = JSON.parse(await readFile(join(dir, '.dsh', 'plugin-state', 'project.json'), 'utf8'))
  assert.equal(card.schemaVersion, 1)
  assert.equal(card.name, basename(dir))
  assert.equal(card.oneLiner, '')
  assert.equal(card.stack.id, 'unknown', '空目录是未检测到，不是猜一个')
  assert.deepEqual(card.commands, { dev: null, build: null, previewUrl: null })
  assert.equal(card.detectedAt, null)

  assert.equal(await readFile(join(dir, '.gitignore'), 'utf8'), 'node_modules/\n', '绝不动 .gitignore')
  assert.deepEqual((await readdir(dir)).sort(), ['.dsh', '.gitignore', '.trellis'])
})

test('幂等：第二次 init 不写任何字节，created 为空、applied:false', async (t) => {
  const dir = await makeProject(t)
  await applyInit(dir)

  const names = ['RULES.md', 'playbook.json', 'acceptance.json', 'project.json']
  const before = new Map()
  for (const name of names) before.set(name, await readFile(join(dir, '.dsh', 'plugin-state', name)))
  const gitignoreBefore = await readFile(join(dir, '.gitignore'), 'utf8').catch(() => null)

  const plan = await planInit(dir)
  assert.deepEqual(plan.dirs.map((item) => item.status), ['exists', 'exists', 'exists'])
  assert.ok(plan.files.every((item) => item.status === 'exists'))
  assert.deepEqual(plan.errors, [])

  const result = await applyInit(dir, plan)
  assert.equal(result.applied, false)
  assert.deepEqual(result.created, [])
  assert.deepEqual(result.skipped.slice(0, 3), ['.trellis', '.dsh/plugin-state', '.dsh/skills'])
  for (const name of names) assert.ok(result.skipped.includes(`.dsh/plugin-state/${name}`), `${name} 应为 skipped`)
  assert.ok(result.skipped.some((item) => item.includes('/skills/cockpit-flow/')), '技能已存在时应 skipped')

  for (const name of names) {
    assert.deepEqual(await readFile(join(dir, '.dsh', 'plugin-state', name)), before.get(name), `${name} 字节不能被改动`)
  }
  assert.equal(await readFile(join(dir, '.gitignore'), 'utf8').catch(() => null), gitignoreBefore)
})

test('已存在的 RULES.md 不被覆盖（plan 里是 exists）', async (t) => {
  const dir = await makeProject(t, { '.dsh/plugin-state/RULES.md': '# 我自己写的规则\n' })
  const plan = await planInit(dir)
  assert.equal(plan.files.find((item) => item.name === 'RULES.md').status, 'exists')
  assert.equal(plan.files.find((item) => item.name === 'RULES.md').bytes, Buffer.byteLength('# 我自己写的规则\n'))

  const result = await applyInit(dir, plan)
  assert.equal(await readFile(join(dir, '.dsh', 'plugin-state', 'RULES.md'), 'utf8'), '# 我自己写的规则\n')
  assert.equal(result.created.includes('.dsh/plugin-state/RULES.md'), false)
  assert.equal(result.skipped.includes('.dsh/plugin-state/RULES.md'), true)
  assert.equal(result.created.includes('.dsh/plugin-state/playbook.json'), true)
})

test('已存在的 project.json：人填 name/oneLiner 不被 init 覆盖', async (t) => {
  const humanCard = JSON.stringify({ schemaVersion: 1, name: '客户管理', oneLiner: '给小团队用' })
  const dir = await makeProject(t, { '.dsh/plugin-state/project.json': humanCard })
  const plan = await planInit(dir)
  assert.equal(plan.files.find((item) => item.name === 'project.json').status, 'exists')
  assert.equal(plan.files.find((item) => item.name === 'project.json').bytes, Buffer.byteLength(humanCard))

  const result = await applyInit(dir, plan)
  assert.equal(result.created.includes('.dsh/plugin-state/project.json'), false)
  assert.equal(await readFile(join(dir, '.dsh', 'plugin-state', 'project.json'), 'utf8'), humanCard)
})

test('模板缺失：该文件进 errors，其余照常写，不静默跳过', async (t) => {
  const dir = await makeProject(t)
  const emptyTemplates = await mkdtemp(join(tmpdir(), 'cockpit-templates-'))
  t.after(() => rm(emptyTemplates, { recursive: true, force: true }))

  const plan = await planInit(dir, { templatesDir: emptyTemplates })
  assert.equal(plan.errors.length, 3)
  for (const name of ['RULES.md', 'playbook.json', 'acceptance.json']) {
    assert.ok(plan.errors.some((message) => message.includes(name)), `${name} 缺失必须被报出来`)
  }
  assert.deepEqual(
    plan.files.filter((item) => item.source !== 'plugin-skill').map((item) => item.name),
    ['project.json'],
    '拿不到模板的文件不进 files',
  )
  assert.ok(plan.files.some((item) => item.source === 'plugin-skill'), '技能不依赖 templatesDir，仍要进计划')

  const result = await applyInit(dir, plan)
  assert.equal(result.errors.length, 3, 'plan 里的错误要带进结果')
  assert.equal(result.applied, true, 'project.json 与目录仍要创建')
  assert.equal(await exists(join(dir, '.dsh', 'plugin-state', 'project.json')), true)
  assert.equal(await exists(join(dir, '.dsh', 'plugin-state', 'RULES.md')), false)
})

test('自定义 templatesDir 在 apply 时被沿用（plan 记住来源）', async (t) => {
  const dir = await makeProject(t)
  const customTemplates = await mkdtemp(join(tmpdir(), 'cockpit-templates-'))
  t.after(() => rm(customTemplates, { recursive: true, force: true }))
  await writeFile(join(customTemplates, 'RULES.md'), '# 自定义规则\n', 'utf8')

  const plan = await planInit(dir, { templatesDir: customTemplates })
  assert.equal(plan.templatesDir, customTemplates)
  assert.equal(plan.errors.length, 2, '另外两个模板缺失照常报错')

  const result = await applyInit(dir, plan)
  assert.equal(await readFile(join(dir, '.dsh', 'plugin-state', 'RULES.md'), 'utf8'), '# 自定义规则\n')
  assert.equal(result.created.includes('.dsh/plugin-state/RULES.md'), true)
})

test('init 复用 detectStack：project.json 带上探测到的技术栈与命令', async (t) => {
  const dir = await makeProject(t, {
    'package.json': JSON.stringify({
      name: 'demo',
      dependencies: { next: '15.0.0' },
      scripts: { dev: 'next dev', build: 'next build' },
    }),
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
  })
  await applyInit(dir)

  const card = JSON.parse(await readFile(join(dir, '.dsh', 'plugin-state', 'project.json'), 'utf8'))
  assert.equal(card.stack.id, 'next')
  assert.equal(card.commands.dev, 'pnpm dev')
  assert.equal(card.commands.build, 'pnpm build')
  assert.equal(typeof card.detectedAt, 'string')
})

test('项目路径不存在 / 不是目录：errors:[\'不是目录\'] 且一个字节都不写', async (t) => {
  const parent = await makeProject(t)
  const missing = join(parent, 'not-created-yet')

  const missingPlan = await planInit(missing)
  assert.deepEqual(missingPlan.errors, ['不是目录'])
  assert.deepEqual(missingPlan.dirs, [])
  assert.deepEqual(missingPlan.files, [])
  assert.equal(await exists(missing), false, 'plan 不能把项目目录建出来')

  const missingApply = await applyInit(missing)
  assert.deepEqual(missingApply.errors, ['不是目录'])
  assert.equal(missingApply.applied, false)
  assert.deepEqual(missingApply.created, [])
  assert.equal(await exists(missing), false, 'apply 也不能把项目目录建出来')

  const filePath = join(parent, 'a-file.txt')
  await writeFile(filePath, 'keep me\n', 'utf8')
  const filePlan = await planInit(filePath)
  assert.deepEqual(filePlan.errors, ['不是目录'])
  const fileApply = await applyInit(filePath)
  assert.equal(fileApply.applied, false)
  assert.deepEqual(fileApply.errors, ['不是目录'])
  assert.equal(await readFile(filePath, 'utf8'), 'keep me\n')
})
