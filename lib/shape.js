/**
 * 项目形态判定：新项目 / 存量项目。
 *
 * 为什么要插件来判，而不是让 skill 自己扫：skill 起手时没有可靠的"阶段上下文"，
 * 让它猜就会出现「给存量项目补 brief」「给新项目补架构契约」这类错活。
 * 驾驶舱手里有证据（文件、回执、账本），所以形态由它判定，并把结论写进面板与指令。
 *
 * 判据只认**看得见的事实**，不猜：
 * - 有代码/工程文件（package.json、Cargo.toml、pyproject.toml、go.mod 等）或常见源码目录 ⇒ existing
 * - 已有 prd/文档产出（docs/prd.md、prd.md） ⇒ existing
 * - 已有任何执行回执（说明这一轮已经动过手） ⇒ existing
 * - 以上都没有 ⇒ new
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const MANIFESTS = ['package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'pom.xml', 'build.gradle']
const SOURCE_DIRS = ['src', 'app', 'lib', 'apps', 'packages']
const DOC_HINTS = ['docs/prd.md', 'prd.md', 'PRD.md']

async function isFile(path) {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

async function isDirWithEntries(path) {
  try {
    const info = await stat(path)
    if (!info.isDirectory()) return false
    const entries = await readdir(path)
    return entries.length > 0
  } catch {
    return false
  }
}

/**
 * @returns {Promise<{kind:'new'|'existing', reasons:string[]}>}
 * reasons 是人话：面板与指令直接引用，"为什么判成存量"必须可解释。
 */
export async function detectProjectShape(projectPath, options = {}) {
  const reasons = []
  if (typeof projectPath !== 'string' || projectPath.trim() === '') {
    return { kind: 'new', reasons: ['还没有项目目录，按新项目处理'] }
  }
  const root = projectPath.trim()

  for (const name of MANIFESTS) {
    if (await isFile(join(root, name))) reasons.push(`有工程文件 ${name}`)
  }
  for (const name of SOURCE_DIRS) {
    if (await isDirWithEntries(join(root, name))) reasons.push(`有源码目录 ${name}/`)
  }
  for (const name of DOC_HINTS) {
    if (await isFile(join(root, ...name.split('/')))) reasons.push(`已有需求文档 ${name}`)
  }
  const receipts = Number(options.receiptCount)
  if (Number.isInteger(receipts) && receipts > 0) reasons.push(`已有 ${receipts} 条执行回执`)

  if (reasons.length === 0) return { kind: 'new', reasons: ['没有工程文件、源码目录或需求文档，按新项目处理'] }
  return { kind: 'existing', reasons }
}
