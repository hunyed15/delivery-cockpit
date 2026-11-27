/**
 * 冷启动初始化：把包内 templates 释放成项目里的四个文件 + 两个目录。
 *
 * 为什么拆成 plan/apply 两步：面板上要先让人看清"会写什么、哪些已存在"再点确认；
 * 所以 planInit 必须纯读（一个字节都不写），applyInit 只执行 plan 里 status=create 的项。
 *
 * 幂等是硬要求：第二次 init 不改任何字节，created 为空、applied:false。
 * 只写这四个文件，不动 .gitignore（只返回一行可复制的提示）。
 */

import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { detectStack } from './detect.js'
import { buildDefaultCard, writeProjectCard } from './project-card.js'
import { detectProjectShape } from './shape.js'

export const INIT_FILE_NAMES = ['RULES.md', 'playbook.json', 'project.json', 'acceptance.json']
export const GITIGNORE_HINT = '.dsh/plugin-state/'

/** 包内模板目录：lib/init.js 的兄弟目录 ../templates/。 */
const DEFAULT_TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url))
// 插件自带的工作流技能：随 init 释放到项目 .dsh/skills/，让阶段方法不再依赖第三方 skill。
const DEFAULT_SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))
const PROJECT_SKILLS_SEGMENTS = ['.dsh', 'skills']

const STATE_DIR_SEGMENTS = ['.dsh', 'plugin-state']
const TRELLIS_DIR_NAME = '.trellis'

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''
const describeError = (error) => error?.code ?? error?.message ?? '未知错误'

/** 计划里记相对路径（正斜杠），UI 展示与跨平台比较都不用关心分隔符。 */
const toRelative = (root, absolutePath) => {
  const rel = relative(root, absolutePath)
  return rel === '' ? '.' : rel.split(sep).join('/')
}

async function statIfExists(path) {
  try {
    return { exists: true, stats: await stat(path), error: null }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, stats: null, error: null }
    return { exists: false, stats: null, error }
  }
}

async function readTemplate(templatesDir, name) {
  const path = join(templatesDir, name)
  try {
    return { bytes: await readFile(path), path, error: null }
  } catch (error) {
    return { bytes: null, path, error }
  }
}

function skillsDirOf(options) {
  if (isNonEmptyString(options?.skillsDir)) return resolve(options.skillsDir.trim())
  return DEFAULT_SKILLS_DIR
}

function templatesDirOf(options) {
  if (isNonEmptyString(options?.templatesDir)) return resolve(options.templatesDir.trim())
  return DEFAULT_TEMPLATES_DIR
}

/** 与 writeProjectCard 的序列化口径保持一致（2 空格缩进 + 结尾换行），bytes 才对得上。 */
const serializeCard = (card) => `${JSON.stringify(card, null, 2)}\n`

function invalidPlan(projectPathRaw, errors) {
  return {
    projectPath: isNonEmptyString(projectPathRaw) ? resolve(projectPathRaw.trim()) : '',
    stateDir: '',
    trellisDir: '',
    dirs: [],
    files: [],
    gitignoreHint: GITIGNORE_HINT,
    notes: [],
    errors,
  }
}

/**
 * 只读计划。绝不写盘：所有"是否存在"用 stat，"要写多少字节"用模板/生成内容的长度。
 *
 * 计划里额外带 templatesDir：applyInit 只有 (projectPath, plan) 两个参数，
 * 不带上它就无法复现 planInit(options.templatesDir) 的自定义模板来源。
 */
export async function planInit(projectPath, options = {}) {
  const errors = []
  if (!isNonEmptyString(projectPath)) return invalidPlan('', ['不是目录'])
  const root = resolve(projectPath.trim())

  const rootProbe = await statIfExists(root)
  if (!rootProbe.exists || !rootProbe.stats?.isDirectory()) {
    return invalidPlan(root, ['不是目录'])
  }

  const templatesDir = templatesDirOf(options)
  const skillsDir = skillsDirOf(options)
  const trellisDir = join(root, TRELLIS_DIR_NAME)
  const stateDir = join(root, ...STATE_DIR_SEGMENTS)
  const projectSkillsDir = join(root, ...PROJECT_SKILLS_SEGMENTS)

  const dirs = []
  for (const dirPath of [trellisDir, stateDir, projectSkillsDir]) {
    const rel = toRelative(root, dirPath)
    const probe = await statIfExists(dirPath)
    if (probe.error) errors.push(`无法确认目录是否存在：${rel}（${describeError(probe.error)}）`)
    if (probe.exists && !probe.stats?.isDirectory()) {
      errors.push(`路径已存在但不是目录：${rel}`)
    }
    dirs.push({ path: dirPath, status: probe.exists ? 'exists' : 'create' })
  }

  const files = []
  for (const name of INIT_FILE_NAMES) {
    const filePath = join(stateDir, name)
    const rel = toRelative(root, filePath)
    const probe = await statIfExists(filePath)
    if (probe.error) errors.push(`无法确认文件是否存在：${rel}（${describeError(probe.error)}）`)

    if (name === 'project.json') {
      // 名片由探测 + 默认值生成（不是模板拷贝），已存在则保留人填字段、不覆盖。
      let bytes = probe.exists ? probe.stats.size : null
      if (!probe.exists) {
        const detected = await detectStack(root)
        bytes = Buffer.byteLength(serializeCard(buildDefaultCard(root, detected)))
      }
      files.push({ name, path: filePath, status: probe.exists ? 'exists' : 'create', source: 'generated', bytes })
      continue
    }

    if (probe.exists) {
      // 目标已存在：不需要再读模板，bytes 用现有文件大小（计划描述的是"磁盘现状"）。
      files.push({ name, path: filePath, status: 'exists', source: 'template', bytes: probe.stats.size })
      continue
    }

    const template = await readTemplate(templatesDir, name)
    if (template.error) {
      // 不静默跳过：模板缺失必须让人看见，否则 apply 时才发现就晚了。
      const detail = template.error?.code === 'ENOENT' ? '模板缺失' : '模板读取失败'
      errors.push(`${detail}：${name}（${describeError(template.error)}）`)
      continue
    }
    files.push({ name, path: filePath, status: 'create', source: 'template', bytes: template.bytes.length })
  }

  // 工作流技能：插件 skills/ 下每个目录的 SKILL.md 都要释放成项目技能。
  const skillNames = []
  try {
    for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const sourcePath = join(skillsDir, entry.name, 'SKILL.md')
      const probe = await statIfExists(sourcePath)
      if (!probe.exists) continue
      skillNames.push({ name: entry.name, sourcePath, bytes: probe.stats?.size ?? 0 })
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') errors.push(`读取插件技能目录失败（${describeError(error)}）`)
  }
  for (const skill of skillNames.sort((left, right) => left.name.localeCompare(right.name))) {
    const filePath = join(projectSkillsDir, skill.name, 'SKILL.md')
    const rel = toRelative(root, filePath)
    const probe = await statIfExists(filePath)
    if (probe.error) errors.push(`无法确认技能是否存在：${rel}（${describeError(probe.error)}）`)
    files.push({
      name: `skills/${skill.name}/SKILL.md`,
      path: filePath,
      status: probe.exists ? 'exists' : 'create',
      source: 'plugin-skill',
      sourcePath: skill.sourcePath,
      bytes: probe.exists ? probe.stats.size : skill.bytes,
    })
  }

  return {
    projectPath: root,
    stateDir,
    trellisDir,
    dirs,
    files,
    gitignoreHint: GITIGNORE_HINT,
    templatesDir,
    skillsDir,
    notes: [],
    errors,
  }
}

/**
 * 执行计划：只写 plan 里 status=create 的项。
 * - 计划生成到执行之间目标可能已经存在（并发 init / 用户手建），写入前再确认一次，
 *   存在就记 skipped，绝不覆盖；
 * - 单个文件写失败记 errors 并继续；已写成功的不回滚，如实报告；
 * - 不传 plan 时按当前状态现做一次计划（route 层的 applyInit 只需要 projectPath）。
 */
export async function applyInit(projectPath, plan) {
  const effectivePlan = plan && typeof plan === 'object' ? plan : await planInit(projectPath)
  const root = isNonEmptyString(projectPath) ? resolve(projectPath.trim()) : effectivePlan.projectPath

  const errors = [...(Array.isArray(effectivePlan.errors) ? effectivePlan.errors : [])]
  const created = []
  const skipped = []

  const result = {
    ...effectivePlan,
    projectPath: root || effectivePlan.projectPath,
    dryRun: false,
    applied: false,
    created,
    skipped,
    errors,
  }

  // 防呆：递归 mkdir 会把不存在的"项目目录"建出来，所以必须先确认根目录真实存在。
  const rootProbe = isNonEmptyString(root) ? await statIfExists(root) : { exists: false, stats: null, error: null }
  if (!rootProbe.exists || !rootProbe.stats?.isDirectory()) {
    if (!errors.includes('不是目录')) errors.push('不是目录')
    return result
  }

  const templatesDir = isNonEmptyString(effectivePlan.templatesDir)
    ? effectivePlan.templatesDir
    : DEFAULT_TEMPLATES_DIR

  for (const dir of Array.isArray(effectivePlan.dirs) ? effectivePlan.dirs : []) {
    if (!isNonEmptyString(dir?.path)) {
      errors.push('计划里的目录项缺少 path')
      continue
    }
    const rel = toRelative(root, dir.path)
    if (dir.status !== 'create') {
      skipped.push(rel)
      continue
    }
    try {
      await mkdir(dir.path, { recursive: true })
      created.push(rel)
    } catch (error) {
      errors.push(`创建目录失败：${rel}（${describeError(error)}）`)
    }
  }

  for (const file of Array.isArray(effectivePlan.files) ? effectivePlan.files : []) {
    if (!isNonEmptyString(file?.name) || !isNonEmptyString(file?.path)) {
      errors.push('计划里的文件项缺少 name/path')
      continue
    }
    const rel = toRelative(root, file.path)
    if (file.status !== 'create') {
      skipped.push(rel)
      continue
    }

    // 二次确认：计划里是 create，但真正写之前目标可能已经出现。
    const probe = await statIfExists(file.path)
    if (probe.error) {
      errors.push(`检查文件失败：${rel}（${describeError(probe.error)}）`)
      continue
    }
    if (probe.exists) {
      skipped.push(rel)
      continue
    }

    try {
      if (file.name === 'project.json') {
        const detected = await detectStack(root)
        const card = buildDefaultCard(root, detected)
        // 形态在首次 init 时固定：新项目不会被后续阶段误判成存量。
        const shape = await detectProjectShape(root).catch(() => null)
        card.shape = shape?.kind === 'existing' ? 'existing' : 'new'
        await writeProjectCard(root, card)
      } else if (isNonEmptyString(file.sourcePath)) {
        const bytes = await readFile(file.sourcePath)
        // 技能文件落在 .dsh/skills/<name>/ 下：父目录要先建出来。
        await mkdir(dirname(file.path), { recursive: true })
        await writeFile(file.path, bytes)
      } else {
        const template = await readTemplate(templatesDir, file.name)
        if (template.error) {
          errors.push(`写入失败：${rel}（模板读取失败：${describeError(template.error)}）`)
          continue
        }
        await writeFile(file.path, template.bytes)
      }
      created.push(rel)
    } catch (error) {
      errors.push(`写入失败：${rel}（${describeError(error)}）`)
    }
  }

  result.applied = created.length > 0
  return result
}
