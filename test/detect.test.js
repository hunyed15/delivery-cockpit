import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { detectStack } from '../lib/detect.js'

/** 建一个临时项目目录并写入给定文件；内容为字符串时原样写，否则 JSON 化。 */
async function makeProject(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-detect-'))
  for (const [name, content] of Object.entries(files)) {
    const fullPath = join(dir, name)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8')
  }
  return dir
}

const pkgWith = (extra = {}) => ({
  name: 'demo',
  ...extra,
})

test('空目录：unknown，不猜技术栈也不给命令', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-detect-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const detected = await detectStack(dir)
  assert.equal(detected.id, 'unknown')
  assert.equal(detected.label, '未检测到技术栈')
  assert.equal(detected.packageManager, null)
  assert.deepEqual(detected.commands, { dev: null, build: null, previewUrl: null })
  assert.deepEqual(detected.evidence, [])
  assert.deepEqual(detected.notes, [])
})

test('目录不存在：同样 unknown，绝不抛错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-detect-'))
  try {
    const detected = await detectStack(join(dir, 'not-created-yet'))
    assert.equal(detected.id, 'unknown')
    assert.equal(detected.commands.dev, null)
    assert.equal(detected.commands.build, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('package.json + next + pnpm 锁：Web / Next.js，命令用 pnpm', async (t) => {
  const dir = await makeProject({
    'package.json': pkgWith({ dependencies: { next: '15.0.0' }, scripts: { dev: 'next dev', build: 'next build' } }),
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
  })
  t.after(() => rm(dir, { recursive: true, force: true }))

  const detected = await detectStack(dir)
  assert.equal(detected.id, 'next')
  assert.equal(detected.label, 'Web / Next.js')
  assert.equal(detected.packageManager, 'pnpm')
  assert.equal(detected.commands.dev, 'pnpm dev')
  assert.equal(detected.commands.build, 'pnpm build')
  assert.equal(detected.commands.previewUrl, null, 'Phase 1 不编造预览端口')
  assert.deepEqual(
    detected.evidence.map((item) => `${item.file}:${item.detail}`).sort(),
    ['package.json:dependencies.next', 'pnpm-lock.yaml:lockfile'],
  )
})

test('package.json + vite + react：id 仍是 react，label 标出 Vite', async (t) => {
  const dir = await makeProject({
    'package.json': pkgWith({
      dependencies: { react: '19.0.0', 'react-dom': '19.0.0' },
      devDependencies: { vite: '6.0.0' },
      scripts: { dev: 'vite', build: 'vite build' },
    }),
    'package-lock.json': '{}\n',
  })
  t.after(() => rm(dir, { recursive: true, force: true }))

  const detected = await detectStack(dir)
  assert.equal(detected.id, 'react')
  assert.equal(detected.label, 'Web / Vite + React')
  assert.equal(detected.packageManager, 'npm')
  assert.equal(detected.commands.dev, 'npm dev')
  assert.equal(detected.commands.build, 'npm build')
  assert.ok(detected.evidence.some((item) => item.detail === 'devDependencies.vite'))
  assert.ok(detected.evidence.some((item) => item.detail === 'dependencies.react-dom'))
})

test('packageManager 字段优先于锁文件', async (t) => {
  const dir = await makeProject({
    'package.json': pkgWith({ packageManager: 'yarn@4.1.0', scripts: { dev: 'vite' } }),
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
  })
  t.after(() => rm(dir, { recursive: true, force: true }))

  const detected = await detectStack(dir)
  assert.equal(detected.packageManager, 'yarn')
  assert.equal(detected.commands.dev, 'yarn dev')
  assert.ok(detected.evidence.some((item) => item.file === 'package.json' && item.detail === 'packageManager'))
})

test('没有 scripts.dev 时退回 scripts.start；没有 build 就是 null', async (t) => {
  const dir = await makeProject({
    'package.json': pkgWith({ scripts: { start: 'node server.js' } }),
    'package-lock.json': '{}\n',
  })
  t.after(() => rm(dir, { recursive: true, force: true }))

  const detected = await detectStack(dir)
  assert.equal(detected.commands.dev, 'npm start')
  assert.equal(detected.commands.build, null)
})

test('包管理器未知且无锁文件：不给命令，只留说明（不猜 npm）', async (t) => {
  const dir = await makeProject({
    'package.json': pkgWith({ scripts: { dev: 'vite', build: 'vite build' } }),
  })
  t.after(() => rm(dir, { recursive: true, force: true }))

  const detected = await detectStack(dir)
  assert.equal(detected.id, 'node')
  assert.equal(detected.packageManager, null)
  assert.equal(detected.commands.dev, null)
  assert.equal(detected.commands.build, null)
  assert.ok(detected.notes.some((note) => note.includes('包管理器未知')))
})

test('package.json 坏 JSON：继续探测别的生态，并记一条 notes', async (t) => {
  const dir = await makeProject({
    'package.json': '{ this is not json',
    'Cargo.toml': '[package]\nname = "demo"\n',
  })
  t.after(() => rm(dir, { recursive: true, force: true }))

  const detected = await detectStack(dir)
  assert.equal(detected.id, 'rust')
  assert.equal(detected.label, 'Rust')
  assert.equal(detected.commands.dev, 'cargo run')
  assert.equal(detected.commands.build, 'cargo build')
  assert.equal(detected.notes.length, 1)
  assert.match(detected.notes[0], /package\.json/)
  assert.deepEqual(detected.evidence, [{ file: 'Cargo.toml', detail: 'cargo' }])
})

test('package.json 结构不是对象且没有其他生态：unknown + notes，不假装是 Node', async (t) => {
  const dir = await makeProject({ 'package.json': JSON.stringify([1, 2, 3]) })
  t.after(() => rm(dir, { recursive: true, force: true }))

  const detected = await detectStack(dir)
  assert.equal(detected.id, 'unknown')
  assert.equal(detected.notes.length, 1)
  assert.match(detected.notes[0], /结构不是对象/)
})

test('go.mod：Go，规范命令', async (t) => {
  const dir = await makeProject({ 'go.mod': 'module demo\n\ngo 1.23\n' })
  t.after(() => rm(dir, { recursive: true, force: true }))

  const detected = await detectStack(dir)
  assert.equal(detected.id, 'go')
  assert.equal(detected.label, 'Go')
  assert.deepEqual(detected.commands, { dev: 'go run .', build: 'go build ./...', previewUrl: null })
  assert.deepEqual(detected.evidence, [{ file: 'go.mod', detail: 'go' }])
})

test('pubspec.yaml：Flutter', async (t) => {
  const dir = await makeProject({ 'pubspec.yaml': 'name: demo\n' })
  t.after(() => rm(dir, { recursive: true, force: true }))

  const detected = await detectStack(dir)
  assert.equal(detected.id, 'flutter')
  assert.equal(detected.label, 'Flutter')
  assert.equal(detected.commands.dev, 'flutter run')
  assert.equal(detected.commands.build, 'flutter build')
})

test('pyproject.toml：Python，但不猜启动命令', async (t) => {
  const dir = await makeProject({ 'pyproject.toml': '[project]\nname = "demo"\n' })
  t.after(() => rm(dir, { recursive: true, force: true }))

  const detected = await detectStack(dir)
  assert.equal(detected.id, 'python')
  assert.equal(detected.label, 'Python')
  assert.equal(detected.commands.dev, null)
  assert.equal(detected.commands.build, null)
  assert.ok(detected.notes.some((note) => note.includes('未识别到 Python')))
  assert.deepEqual(detected.evidence, [{ file: 'pyproject.toml', detail: 'pyproject.toml' }])
})

test('只有 requirements.txt 时也认 Python', async (t) => {
  const dir = await makeProject({ 'requirements.txt': 'flask\n' })
  t.after(() => rm(dir, { recursive: true, force: true }))

  const detected = await detectStack(dir)
  assert.equal(detected.id, 'python')
  assert.equal(detected.packageManager, null)
  assert.deepEqual(detected.evidence, [{ file: 'requirements.txt', detail: 'requirements.txt' }])
})

test('pom.xml：Java (Maven)，只有 spring-boot 依赖才给 run 命令', async (t) => {
  const withBoot = await makeProject({
    'pom.xml': '<project><dependency>org.springframework.boot</dependency></project>',
  })
  const plain = await makeProject({ 'pom.xml': '<project><artifactId>demo</artifactId></project>' })
  t.after(() => rm(withBoot, { recursive: true, force: true }))
  t.after(() => rm(plain, { recursive: true, force: true }))

  const boot = await detectStack(withBoot)
  assert.equal(boot.id, 'java')
  assert.equal(boot.label, 'Java (Maven)')
  assert.equal(boot.commands.dev, 'mvn spring-boot:run')
  assert.equal(boot.commands.build, 'mvn package')

  const noBoot = await detectStack(plain)
  assert.equal(noBoot.commands.dev, null, '没有 spring-boot 就不猜 run 命令')
  assert.equal(noBoot.commands.build, 'mvn package')
})

test('build.gradle：Java (Gradle)，spring-boot 依赖给 bootRun', async (t) => {
  const dir = await makeProject({
    'build.gradle': "plugins { id 'org.springframework.boot' version '3.4.0' }",
  })
  t.after(() => rm(dir, { recursive: true, force: true }))

  const detected = await detectStack(dir)
  assert.equal(detected.id, 'java')
  assert.equal(detected.label, 'Java (Gradle)')
  assert.equal(detected.commands.dev, './gradlew bootRun')
  assert.equal(detected.commands.build, './gradlew build')
})

test('composer.json：PHP，启动命令留空', async (t) => {
  const dir = await makeProject({ 'composer.json': { name: 'demo/app' } })
  t.after(() => rm(dir, { recursive: true, force: true }))

  const detected = await detectStack(dir)
  assert.equal(detected.id, 'php')
  assert.equal(detected.label, 'PHP')
  assert.equal(detected.commands.dev, null)
  assert.equal(detected.commands.build, null)
})

test('package.json 命中顺序固定：next 优先于 react', async (t) => {
  const dir = await makeProject({
    'package.json': pkgWith({ dependencies: { next: '15', 'react-dom': '19', react: '19' } }),
    'package-lock.json': '{}\n',
  })
  t.after(() => rm(dir, { recursive: true, force: true }))

  const detected = await detectStack(dir)
  assert.equal(detected.id, 'next')
  assert.ok(detected.evidence.some((item) => item.detail === 'dependencies.next'))
})
