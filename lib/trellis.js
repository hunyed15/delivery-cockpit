/**
 * 把空 `.trellis/` 升级成完整 Trellis 工程（可选动作，默认由人在面板点）。
 *
 * 为什么放在 lib 而不是工具闭包：HTTP 路由与 `cockpit_init` 都要用同一份实现，
 * 否则两处的 CLI 参数/失败语义会漂移。这里只做一件事：能跑就跑，跑不了如实返回状态，
 * 绝不因为 Trellis 失败而让驾驶舱状态初始化失败。
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

const READY_SCRIPT = join('.trellis', 'scripts', 'get_context.py')

async function alreadyInitialized(projectPath) {
  return stat(join(projectPath, READY_SCRIPT))
    .then((info) => info.isFile())
    .catch(() => false)
}

/**
 * @param {{get: Function}} ctx DSH ctx（取 subprocess 可选服务）
 * @param {string} projectPath 项目根目录
 * @param {object} [exec] 工具/请求执行上下文（透传 abort signal）
 * @returns {Promise<{status:'already-initialized'|'done'|'failed'|'skipped', reason?:string, exitCode?:number}>}
 */
export async function initializeTrellis(ctx, projectPath, exec) {
  if (await alreadyInitialized(projectPath)) return { status: 'already-initialized' }

  let subprocess = null
  try {
    subprocess = ctx?.get?.('subprocess') ?? null
  } catch {
    subprocess = null
  }
  if (!subprocess || typeof subprocess.spawn !== 'function' || typeof subprocess.resolveExecutable !== 'function') {
    return { status: 'skipped', reason: 'subprocess-missing' }
  }

  let executable = null
  for (const candidate of process.platform === 'win32' ? ['trellis.cmd', 'trellis'] : ['trellis']) {
    try {
      const resolved = await subprocess.resolveExecutable(candidate)
      if (typeof resolved === 'string' && resolved.trim() !== '') {
        executable = resolved
        break
      }
    } catch {
      executable = null
    }
  }
  if (executable === null) return { status: 'skipped', reason: 'cli-missing' }

  const username = process.env.USERNAME || process.env.USER || 'ai'
  let argv = [executable, 'init', '--dsh', '-y', '-s', '-u', username]
  if (/\.ps1$/i.test(executable)) {
    let pwsh = null
    try {
      pwsh = await subprocess.resolveExecutable('pwsh')
    } catch {
      pwsh = null
    }
    if (pwsh === null) return { status: 'skipped', reason: 'pwsh-missing' }
    argv = [pwsh, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', executable, 'init', '--dsh', '-y', '-s', '-u', username]
  }

  try {
    const handle = subprocess.spawn({
      argv,
      cwd: projectPath,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 1024 * 1024 },
        stderr: { maxBytes: 256 * 1024 },
      },
      graceMs: 5000,
      signal: exec?.signal,
    })
    const outcome = await Promise.resolve(handle.done)
    const exitCode = typeof outcome?.exitCode === 'number' ? outcome.exitCode : -1
    return { status: exitCode === 0 ? 'done' : 'failed', exitCode }
  } catch (error) {
    return { status: 'failed', reason: String(error?.message ?? error) }
  }
}
