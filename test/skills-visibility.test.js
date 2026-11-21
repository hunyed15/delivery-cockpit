/**
 * 技能可见性：面板（root context）只能看到 Host 全局层的技能，用户目录里装的技能属于
 * agent 作用域，从服务侧看不到。如果只信服务，会把"装着的能力"报成"缺失"，
 * 进而把下一步指令错误禁用。所以要补一层只读的目录扫描。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDiskSkillNames } from '../index.js'

async function writeSkill(root, name, declaredName) {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  if (declaredName) {
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${declaredName}\ndescription: demo\n---\n\n# body\n`, 'utf8')
  }
}

test('扫描用户与项目技能目录：目录名与 SKILL.md 声明的 name 都收', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dc-home-'))
  const project = await mkdtemp(join(tmpdir(), 'dc-proj-'))
  try {
    await writeSkill(join(home, '.dsh', 'skills'), 'ponytail', 'ponytail')
    await writeSkill(join(home, '.dsh', 'skills'), 'renamed-dir', 'verification-before-completion')
    await writeSkill(join(home, '.agents', 'skills'), 'gamma')
    await writeSkill(join(project, '.dsh', 'skills'), 'delta')
    await writeSkill(join(project, '.agents', 'skills'), 'epsilon')

    const result = await readDiskSkillNames(project, { dshHome: join(home, '.dsh') })
    assert.ok(result.readable >= 4, `至少 4 个目录可读，实际 ${result.readable}`)
    for (const name of ['ponytail', 'renamed-dir', 'verification-before-completion', 'gamma', 'delta', 'epsilon']) {
      assert.ok(result.names.has(name), `应识别技能名：${name}`)
    }
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
  }
})

test('目录不存在时不算可读，也不报错', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dc-home-'))
  const project = await mkdtemp(join(tmpdir(), 'dc-proj-'))
  try {
    const result = await readDiskSkillNames(project, { dshHome: join(home, '.dsh') })
    // 机器上可能还存在其它技能目录（如 ~/.agents/skills）：只断言"没读到东西也不报错"。
    assert.equal(typeof result.readable, 'number')
    assert.equal(result.names.size, 0)
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
  }
})

test('只有文件没有目录时不误报技能', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dc-home-'))
  try {
    const root = join(home, '.dsh', 'skills')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'README.md'), 'not a skill', 'utf8')
    const result = await readDiskSkillNames('', { dshHome: join(home, '.dsh') })
    assert.equal(result.names.size, 0)
    assert.ok(result.readable >= 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
