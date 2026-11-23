import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { readGateEvidence, validateArchitecture, validateRelease, validateTestReport } from '../lib/gates.js'

async function withProject(run, prefix = 'dc-gates-') {
  const project = await mkdtemp(join(tmpdir(), prefix))
  try {
    await run(project)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

async function writeText(project, rel, text) {
  const path = join(project, ...rel.split('/'))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
  return path
}

const writeJson = (project, rel, value) => writeText(project, rel, JSON.stringify(value))

const COMPLETE_ARCH = [
  '# 架构契约',
  '',
  '## 组件',
  '- web：页面',
  '',
  '## 数据模型',
  '- customer(id, name)',
  '',
  '## 接口清单',
  '- GET /customers',
  '',
  '## 关键决策（ADR）',
  '- ADR-1 选 Next.js（chosen），拒绝 SPA（rejected）',
  '',
].join('\n')

test('架构门：文件缺全 ⇒ available/ok=false、reason=missing，missing 列出契约文件', async () => {
  await withProject(async (project) => {
    const gate = await validateArchitecture(project)
    assert.equal(gate.gate, 'architecture')
    assert.equal(gate.available, false)
    assert.equal(gate.ok, false)
    assert.equal(gate.reason, 'missing')
    assert.ok(gate.missing.includes('docs/architecture.md'))
    assert.ok(gate.missing.includes('docs/api.md'))
  })
})

test('架构门：契约文件在但缺小节 ⇒ missing 精确到「文件#小节」，api 缺失单列', async () => {
  await withProject(async (project) => {
    await writeText(project, 'docs/architecture.md', '# 架构\n\n## 组件\n- web\n\n## 关键决策\n- ADR-1\n')
    const gate = await validateArchitecture(project)
    assert.equal(gate.available, true, '主契约文件在，门可评估但没过')
    assert.equal(gate.ok, false)
    assert.equal(gate.reason, 'missing')
    assert.deepEqual(gate.missing, [
      'docs/architecture.md#数据模型',
      'docs/architecture.md#接口清单',
      'docs/api.md',
    ])
    assert.deepEqual(gate.detail.sections, ['组件', '关键决策'])
  })
})

test('架构门：四个小节齐全 + docs/api.md 非空 ⇒ 通过', async () => {
  await withProject(async (project) => {
    await writeText(project, 'docs/architecture.md', COMPLETE_ARCH)
    await writeText(project, 'docs/api.md', '# API\nGET /customers\n')
    const gate = await validateArchitecture(project)
    assert.equal(gate.ok, true)
    assert.equal(gate.available, true)
    assert.deepEqual(gate.missing, [])
    assert.equal(gate.detail.api, 'docs/api.md')
    assert.deepEqual(gate.detail.sections, ['组件', '数据模型', '接口清单', '关键决策'])
  })
})

test('架构门：docs/openapi.json 可替代 api.md；空 api.md 不算数', async () => {
  await withProject(async (project) => {
    await writeText(project, 'docs/architecture.md', COMPLETE_ARCH)
    await writeText(project, 'docs/api.md', '   \n')
    await writeJson(project, 'docs/openapi.json', { openapi: '3.0.0', paths: { '/customers': { get: {} } } })
    const gate = await validateArchitecture(project)
    assert.equal(gate.ok, true)
    assert.equal(gate.detail.api, 'docs/openapi.json')

    await rm(join(project, 'docs', 'openapi.json'))
    const again = await validateArchitecture(project)
    assert.equal(again.ok, false)
    assert.deepEqual(again.missing, ['docs/api.md'], '空白 api.md 不能算"有接口契约"')
  })
})

test('架构门：`## ADR` 与 `###` 级小节都能被认作关键决策', async () => {
  await withProject(async (project) => {
    await writeText(
      project,
      'docs/architecture.md',
      ['# 架构', '### 组件', '### 数据模型', '### 接口清单', '## ADR', '- ADR-1', ''].join('\n'),
    )
    await writeText(project, 'docs/api.md', 'GET /x\n')
    const gate = await validateArchitecture(project)
    assert.equal(gate.ok, true)
  })
})

test('架构门：路径指向一个文件（非目录）时也不抛错，按 missing 返回', async () => {
  await withProject(async (project) => {
    const file = await writeText(project, 'not-a-dir.txt', 'x')
    const gate = await validateArchitecture(file)
    assert.equal(gate.ok, false)
    assert.equal(gate.reason, 'missing')
    assert.ok(gate.missing.includes('docs/architecture.md'))
  })
})

test('测试门：文件缺失 ⇒ available/ok=false、reason=missing', async () => {
  await withProject(async (project) => {
    const gate = await validateTestReport(project)
    assert.equal(gate.gate, 'tests')
    assert.equal(gate.available, false)
    assert.equal(gate.ok, false)
    assert.equal(gate.reason, 'missing')
    assert.deepEqual(gate.missing, ['.dsh/plugin-state/test-report.json', '.dsh/plugin-state/manual-check.json'])
  })
})

test('测试门：坏 JSON ⇒ bad-json；结构不对 ⇒ wrong-shape + 缺字段', async () => {
  await withProject(async (project) => {
    await writeText(project, '.dsh/plugin-state/test-report.json', '{ 坏 JSON')
    let gate = await validateTestReport(project)
    assert.equal(gate.available, true)
    assert.equal(gate.ok, false)
    assert.equal(gate.reason, 'bad-json')

    await writeJson(project, '.dsh/plugin-state/test-report.json', { command: 'node --test' })
    gate = await validateTestReport(project)
    assert.equal(gate.ok, false)
    assert.equal(gate.reason, 'wrong-shape')
    assert.deepEqual(gate.missing, ['passed', 'failed', 'at'])

    // 字段类型不对同样算 wrong-shape（不是"没通过"）
    await writeJson(project, '.dsh/plugin-state/test-report.json', {
      command: 'node --test',
      passed: '12',
      failed: -1,
      at: '',
    })
    gate = await validateTestReport(project)
    assert.equal(gate.ok, false)
    assert.equal(gate.reason, 'wrong-shape')
    assert.deepEqual(gate.missing, ['passed', 'failed', 'at'])
  })
})

test('测试门：failed>0 不通过并在 missing 里说人话；全绿通过', async () => {
  await withProject(async (project) => {
    await writeJson(project, '.dsh/plugin-state/test-report.json', {
      command: 'node --test "test/*.test.js"',
      passed: 362,
      failed: 2,
      at: '2026-11-22T20:00:00.000Z',
    })
    let gate = await validateTestReport(project)
    assert.equal(gate.available, true)
    assert.equal(gate.ok, false)
    assert.deepEqual(gate.missing, ['failed>0（2 个失败）'])
    assert.equal(gate.detail.passed, 362)

    await writeJson(project, '.dsh/plugin-state/test-report.json', {
      command: 'node --test "test/*.test.js"',
      passed: 364,
      failed: 0,
      skipped: 1,
      at: '2026-11-22T20:00:00.000Z',
    })
    gate = await validateTestReport(project)
    assert.equal(gate.ok, true)
    assert.deepEqual(gate.missing, [])
    assert.equal(gate.detail.command, 'node --test "test/*.test.js"')
    assert.equal(gate.detail.failed, 0)
    assert.equal(gate.detail.skipped, 1)
  })
})

test('发布门：缺文件 / 坏 JSON / 缺字段三种不通过形态', async () => {
  await withProject(async (project) => {
    let gate = await validateRelease(project)
    assert.equal(gate.gate, 'release')
    assert.equal(gate.ok, false)
    assert.equal(gate.reason, 'missing')

    await writeText(project, '.dsh/plugin-state/release.json', '{ 坏 JSON')
    gate = await validateRelease(project)
    assert.equal(gate.ok, false)
    assert.equal(gate.reason, 'bad-json')

    await writeJson(project, '.dsh/plugin-state/release.json', { version: '1.0.0', artifacts: [] })
    gate = await validateRelease(project)
    assert.equal(gate.ok, false)
    assert.equal(gate.reason, 'wrong-shape')
    assert.deepEqual(gate.missing, ['artifacts', 'rollback', 'at'])
  })
})

test('发布门：artifacts 必须 {path, sha256}、文件存在且哈希匹配；url 可选', async () => {
  await withProject(async (project) => {
    const js = 'console.log(1)'
    const css = 'body{}'
    await writeText(project, 'dist/app.js', js)
    await writeText(project, 'dist/app.css', css)
    const sha = (text) => createHash('sha256').update(text).digest('hex')
    const artifacts = [
      { path: 'dist/app.js', sha256: sha(js) },
      { path: 'dist/app.css', sha256: sha(css) },
    ]
    await writeJson(project, '.dsh/plugin-state/release.json', {
      version: '1.0.0',
      artifacts,
      rollback: 'git revert 上一个 tag',
      at: '2026-11-22T20:00:00.000Z',
    })
    const gate = await validateRelease(project)
    assert.equal(gate.ok, true)
    assert.equal(gate.available, true)
    assert.equal(gate.detail.version, '1.0.0')
    assert.equal(gate.detail.artifacts.length, 2)
    assert.equal(gate.detail.url, null)

    // 缺文件 / 哈希不对 / 越界路径都必须拦下
    await rm(join(project, 'dist', 'app.css'))
    const missingFile = await validateRelease(project)
    assert.equal(missingFile.ok, false)
    assert.ok(missingFile.missing.some((item) => item.includes('文件不存在')))

    await writeText(project, 'dist/app.css', 'tampered')
    const badHash = await validateRelease(project)
    assert.equal(badHash.ok, false)
    assert.deepEqual(badHash.missing, ['artifacts[1].sha256'])

    await writeJson(project, '.dsh/plugin-state/release.json', {
      version: '1.0.1',
      artifacts: [{ path: '../outside.txt', sha256: 'a'.repeat(64) }],
      rollback: '回滚',
      at: '2026-11-22T21:00:00.000Z',
      url: 'https://example.com',
    })
    const outside = await validateRelease(project)
    assert.equal(outside.ok, false)
    assert.ok(outside.missing.some((item) => item.includes('越界')))
  })
})

test('发布门：artifacts 元素不是字符串或 {path} ⇒ wrong-shape', async () => {
  await withProject(async (project) => {
    await writeJson(project, '.dsh/plugin-state/release.json', {
      version: '1.0.0',
      artifacts: [42, { name: 'dist/app.js' }],
      rollback: 'x',
      at: '2026-11-22T20:00:00.000Z',
    })
    const gate = await validateRelease(project)
    assert.equal(gate.ok, false)
    assert.equal(gate.reason, 'wrong-shape')
    assert.deepEqual(gate.missing, ['artifacts'])
  })
})

test('readGateEvidence：三门互不影响，缺文件不抛错；单门通过不抬高其他门', async () => {
  await withProject(async (project) => {
    const empty = await readGateEvidence(project)
    assert.deepEqual(Object.keys(empty).sort(), ['architecture', 'release', 'tests'])
    for (const key of ['architecture', 'tests', 'release']) {
      assert.equal(empty[key].ok, false)
      assert.equal(empty[key].available, false)
      assert.equal(empty[key].reason, 'missing')
      assert.ok(Array.isArray(empty[key].missing))
    }

    await writeJson(project, '.dsh/plugin-state/test-report.json', {
      command: 'node --test',
      passed: 3,
      failed: 0,
      at: '2026-11-22T20:00:00.000Z',
    })
    const mixed = await readGateEvidence(project)
    assert.equal(mixed.tests.ok, true)
    assert.equal(mixed.architecture.ok, false)
    assert.equal(mixed.release.ok, false)
    assert.equal(mixed.architecture.gate, 'architecture')
    assert.equal(mixed.release.gate, 'release')
  })
})

test('readGateEvidence：非法项目路径也只回 missing，不抛', async () => {
  for (const value of [null, undefined, '', '   ']) {
    const gates = await readGateEvidence(value)
    assert.deepEqual(Object.keys(gates).sort(), ['architecture', 'release', 'tests'])
    for (const gate of Object.values(gates)) {
      assert.equal(gate.ok, false)
      assert.equal(gate.reason, 'missing')
    }
  }
})

test('tests 门：非代码项目可用 manual-check.json 回退（通过 / 失败 / 形状错误）', async () => {
  await withProject(async (project) => {
    await writeJson(project, '.dsh/plugin-state/manual-check.json', {
      at: '2026-11-22T20:00:00.000Z',
      checks: [
        { name: '页面能打开', result: 'pass' },
        { name: '文案对齐', result: 'pass' },
      ],
    })
    const passed = await validateTestReport(project)
    assert.equal(passed.ok, true)
    assert.equal(passed.available, true)
    assert.equal(passed.detail.source, '.dsh/plugin-state/manual-check.json')
    assert.equal(passed.detail.checks, 2)

    await writeJson(project, '.dsh/plugin-state/manual-check.json', {
      at: '2026-11-22T20:00:00.000Z',
      checks: [
        { name: '页面能打开', result: 'pass' },
        { name: '文案对齐', result: 'fail' },
      ],
    })
    const failed = await validateTestReport(project)
    assert.equal(failed.ok, false)
    assert.equal(failed.available, true)
    assert.match(failed.missing.join(' '), /人工检查未通过.*1 个失败/)

    await writeJson(project, '.dsh/plugin-state/manual-check.json', { at: '2026-11-22T20:00:00.000Z', checks: [] })
    const empty = await validateTestReport(project)
    assert.equal(empty.ok, false)
    assert.equal(empty.reason, 'wrong-shape')
    assert.deepEqual(empty.missing, ['checks'])
  })
})

test('tests 门：test-report.json 存在时优先于 manual-check.json（不静默改用回退）', async () => {
  await withProject(async (project) => {
    await writeJson(project, '.dsh/plugin-state/test-report.json', {
      command: 'node --test',
      passed: 1,
      failed: 2,
      at: '2026-11-22T20:00:00.000Z',
    })
    await writeJson(project, '.dsh/plugin-state/manual-check.json', {
      at: '2026-11-22T20:00:00.000Z',
      checks: [{ name: '页面能打开', result: 'pass' }],
    })
    const gate = await validateTestReport(project)
    assert.equal(gate.ok, false)
    assert.equal(gate.detail.source, '.dsh/plugin-state/test-report.json')
    assert.match(gate.missing.join(' '), /failed>0（2 个失败）/)
  })
})

test('架构门：关键决策标题下没内容 / api 文件没有 endpoint 都不通过', async () => {
  await withProject(async (project) => {
    await writeText(
      project,
      'docs/architecture.md',
      ['# 架构', '## 组件', 'Web', '## 数据模型', 'Customer', '## 接口清单', 'GET /x', '## 关键决策', ''].join('\n'),
    )
    await writeText(project, 'docs/api.md', '# API\n\n这个文件没有方法行\n')
    const gate = await validateArchitecture(project)
    assert.equal(gate.ok, false)
    assert.ok(gate.missing.some((item) => item.includes('关键决策（无内容）')))
    assert.ok(gate.missing.some((item) => item.includes('api.md#endpoint')))
  })
})
test('架构门：api.md 用 Markdown 表格写 endpoint 也认', async () => {
  await withProject(async (project) => {
    await writeText(
      project,
      'docs/architecture.md',
      ['# 架构', '## 组件', 'Web', '## 数据模型', 'Customer', '## 接口清单', '## 关键决策', '- 单体优先'].join('\n'),
    )
    await writeText(project, 'docs/api.md', ['# API', '', '| 方法 | 路径 |', '| --- | --- |', '| GET | /customers |'].join('\n'))
    const gate = await validateArchitecture(project)
    assert.equal(gate.ok, true)
  })
})