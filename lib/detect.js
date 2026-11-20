/**
 * 技术栈探测：只读给定目录，回答"这是什么项目、怎么启动"。
 *
 * 为什么单独成模块：名片（project-card）与冷启动（init）都要它，而探测规则必须
 * 集中一处，否则两边对"Vite + React 该叫什么"会给出不同答案。
 *
 * 三条自查规则（来自 IMPLEMENTATION §3.2 与"绝不造假"）：
 * - 只认读到的文件与字段，不猜框架、不猜端口、不猜启动命令；
 * - 任何读失败/坏 JSON 都记 notes 后继续探测别的生态，绝不抛出；
 * - 读不到就是 unknown / null，不默认 0、不默认 npm。
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''

/** 读文本；ENOENT 当作"没有这个文件"，其他错误留给调用方记 notes。 */
async function readTextIfExists(path) {
  try {
    return { text: await readFile(path, 'utf8'), error: null }
  } catch (error) {
    if (error?.code === 'ENOENT') return { text: null, error: null }
    return { text: null, error }
  }
}

/** 判断文件是否存在；权限错也当作"读不到"，交给调用方记 notes。 */
async function existsAt(path) {
  try {
    await stat(path)
    return { exists: true, error: null }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, error: null }
    return { exists: false, error }
  }
}

const describeError = (error) => error?.code ?? error?.message ?? '未知错误'

function emptyResult(notes) {
  return {
    id: 'unknown',
    label: '未检测到技术栈',
    packageManager: null,
    commands: { dev: null, build: null, previewUrl: null },
    evidence: [],
    notes,
  }
}

function simpleResult({ id, label, file, detail, dev, build, notes }) {
  return {
    id,
    label,
    packageManager: null,
    commands: { dev, build, previewUrl: null },
    evidence: [{ file, detail }],
    notes: notes ?? [],
  }
}

/**
 * Node 生态：先定包管理器（字段 > 锁文件），再按固定顺序定框架。
 * 顺序固定是为了同一份依赖总得到同一个答案，不受 JSON 键序影响。
 */
async function detectNode(root, pkg, notes) {
  const evidence = []
  const dependencies = {}
  // 依赖与开发依赖都算"装了"；生产依赖优先，用于 evidence 的 detail 前缀。
  for (const bucket of ['dependencies', 'devDependencies']) {
    const table = isObject(pkg[bucket]) ? pkg[bucket] : {}
    for (const name of Object.keys(table)) {
      if (!Object.hasOwn(dependencies, name)) dependencies[name] = bucket
    }
  }
  const hasDependency = (name) => Object.hasOwn(dependencies, name)

  // packageManager 字段优先于锁文件：字段是作者显式声明，锁文件只是副产物。
  let packageManager = null
  if (isNonEmptyString(pkg.packageManager)) {
    const declared = pkg.packageManager.trim()
    const at = declared.indexOf('@')
    const name = at > 0 ? declared.slice(0, at) : declared
    if (name !== '') {
      packageManager = name
      evidence.push({ file: 'package.json', detail: 'packageManager' })
    }
  }

  if (packageManager === null) {
    const lockCandidates = [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['bun.lockb', 'bun'],
      ['package-lock.json', 'npm'],
    ]
    for (const [file, name] of lockCandidates) {
      const probe = await existsAt(join(root, file))
      if (probe.error) notes.push(`${file} 读取失败（${describeError(probe.error)}），按不存在处理`)
      if (!probe.exists) continue
      packageManager = name
      evidence.push({ file, detail: 'lockfile' })
      break
    }
  }

  // 框架判定顺序照抄契约：先命中者为准。
  const frameworks = [
    ['next', 'next', 'Web / Next.js'],
    ['nuxt', 'nuxt', 'Web / Nuxt'],
    ['astro', 'astro', 'Web / Astro'],
    ['@sveltejs/kit', 'svelte', 'Web / SvelteKit'],
    ['vue', 'vue', 'Web / Vue'],
    ['react-dom', 'react', 'Web / React'],
    ['electron', 'electron', 'Desktop / Electron'],
  ]
  let id = 'node'
  let label = 'Node.js'
  for (const [dependency, stackId, stackLabel] of frameworks) {
    if (!hasDependency(dependency)) continue
    id = stackId
    label = stackLabel
    evidence.push({ file: 'package.json', detail: `${dependencies[dependency]}.${dependency}` })
    break
  }

  // 一个明确的事实：Vite 构建的 React 项目在 UI 上要能一眼看出来。
  if (id === 'react' && hasDependency('vite')) {
    label = 'Web / Vite + React'
    evidence.push({ file: 'package.json', detail: `${dependencies.vite}.vite` })
  }

  const scripts = isObject(pkg.scripts) ? pkg.scripts : {}
  const hasDev = isNonEmptyString(scripts.dev)
  const hasStart = isNonEmptyString(scripts.start)
  const hasBuild = isNonEmptyString(scripts.build)

  // 没有包管理器证据时不给命令：`npm dev` 之类的默认值是猜的，而猜命令会让用户
  // 复制到终端后直接失败（契约：不猜命令）。
  let dev = null
  let build = null
  if (packageManager !== null) {
    if (hasDev) dev = `${packageManager} dev`
    else if (hasStart) dev = `${packageManager} start`
    if (hasBuild) build = `${packageManager} build`
  } else if (hasDev || hasStart || hasBuild) {
    notes.push('未找到锁文件或 packageManager 字段，包管理器未知，未生成启动/构建命令')
  }

  if (evidence.length === 0) evidence.push({ file: 'package.json', detail: 'package.json' })

  return { id, label, packageManager, commands: { dev, build, previewUrl: null }, evidence, notes }
}

/** 探测入口：按契约顺序命中即返回；坏 JSON 只记 notes，继续看别的生态。 */
async function detectInner(projectPath) {
  const notes = []
  if (!isNonEmptyString(projectPath)) return emptyResult(notes)
  const root = projectPath.trim()

  // 1. package.json
  const pkgRead = await readTextIfExists(join(root, 'package.json'))
  if (pkgRead.error) notes.push(`package.json 读取失败（${describeError(pkgRead.error)}），按不存在处理`)
  if (pkgRead.text !== null) {
    let pkg = null
    try {
      pkg = JSON.parse(pkgRead.text)
    } catch {
      notes.push('package.json 不是合法 JSON，已跳过 Node 生态探测')
    }
    if (pkg !== null && !isObject(pkg)) {
      notes.push('package.json 结构不是对象，已跳过 Node 生态探测')
      pkg = null
    }
    if (pkg !== null) return detectNode(root, pkg, notes)
  }

  // 2. Rust
  const cargo = await readTextIfExists(join(root, 'Cargo.toml'))
  if (cargo.error) notes.push(`Cargo.toml 读取失败（${describeError(cargo.error)}），按不存在处理`)
  if (cargo.text !== null) {
    return simpleResult({ id: 'rust', label: 'Rust', file: 'Cargo.toml', detail: 'cargo', dev: 'cargo run', build: 'cargo build', notes })
  }

  // 3. Go
  const goMod = await readTextIfExists(join(root, 'go.mod'))
  if (goMod.error) notes.push(`go.mod 读取失败（${describeError(goMod.error)}），按不存在处理`)
  if (goMod.text !== null) {
    return simpleResult({ id: 'go', label: 'Go', file: 'go.mod', detail: 'go', dev: 'go run .', build: 'go build ./...', notes })
  }

  // 4. Flutter
  const pubspec = await readTextIfExists(join(root, 'pubspec.yaml'))
  if (pubspec.error) notes.push(`pubspec.yaml 读取失败（${describeError(pubspec.error)}），按不存在处理`)
  if (pubspec.text !== null) {
    return simpleResult({
      id: 'flutter',
      label: 'Flutter',
      file: 'pubspec.yaml',
      detail: 'flutter',
      dev: 'flutter run',
      build: 'flutter build',
      notes,
    })
  }

  // 5. Python：两个清单都认，但只在命中时记第一个；不猜 Django/Flask 的启动命令。
  for (const file of ['pyproject.toml', 'requirements.txt']) {
    const pythonManifest = await readTextIfExists(join(root, file))
    if (pythonManifest.error) notes.push(`${file} 读取失败（${describeError(pythonManifest.error)}），按不存在处理`)
    if (pythonManifest.text === null) continue
    notes.push('未识别到 Python 启动/构建命令，需在 project.json 里手动补充')
    return simpleResult({ id: 'python', label: 'Python', file, detail: file, dev: null, build: null, notes })
  }

  // 6. Java：spring-boot 依赖只影响"怎么跑"，不影响"能构建"。
  const pom = await readTextIfExists(join(root, 'pom.xml'))
  if (pom.error) notes.push(`pom.xml 读取失败（${describeError(pom.error)}），按不存在处理`)
  if (pom.text !== null) {
    // Maven 里 groupId 写作 org.springframework.boot，Gradle 插件 id 写作 spring-boot，两种都认。
    const springBoot = pom.text.includes('spring-boot') || pom.text.includes('org.springframework.boot')
    return {
      id: 'java',
      label: 'Java (Maven)',
      packageManager: null,
      commands: { dev: springBoot ? 'mvn spring-boot:run' : null, build: 'mvn package', previewUrl: null },
      evidence: [{ file: 'pom.xml', detail: springBoot ? 'spring-boot' : 'maven' }],
      notes,
    }
  }

  const gradle = await readTextIfExists(join(root, 'build.gradle'))
  if (gradle.error) notes.push(`build.gradle 读取失败（${describeError(gradle.error)}），按不存在处理`)
  if (gradle.text !== null) {
    const springBoot = gradle.text.includes('spring-boot') || gradle.text.includes('org.springframework.boot')
    return {
      id: 'java',
      label: 'Java (Gradle)',
      packageManager: null,
      commands: { dev: springBoot ? './gradlew bootRun' : null, build: './gradlew build', previewUrl: null },
      evidence: [{ file: 'build.gradle', detail: springBoot ? 'spring-boot' : 'gradle' }],
      notes,
    }
  }

  // 7. PHP
  const composer = await readTextIfExists(join(root, 'composer.json'))
  if (composer.error) notes.push(`composer.json 读取失败（${describeError(composer.error)}），按不存在处理`)
  if (composer.text !== null) {
    return simpleResult({ id: 'php', label: 'PHP', file: 'composer.json', detail: 'composer', dev: null, build: null, notes })
  }

  // 8. 什么都没读到：说"未检测到"，而不是编一个最像的。
  return emptyResult(notes)
}

export async function detectStack(projectPath) {
  try {
    return await detectInner(projectPath)
  } catch (error) {
    // 契约要求"绝不抛错"：探测失败最多让名片显示 unknown，不能把整个面板打挂。
    return emptyResult([`技术栈探测失败（${describeError(error)}），已按未检测到处理`])
  }
}
