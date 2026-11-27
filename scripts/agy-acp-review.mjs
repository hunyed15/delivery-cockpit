#!/usr/bin/env node
/**
 * Gemini(Antigravity agy) ACP bridge for claude-code-review.
 *
 * 与 acp-review.mjs 输出同一个 envelope，但启动的是 `agy acp`（不是 Claude adapter）。
 * 只读约束：会话切 plan 模式 + ACP 权限回调只允许 read/search；写/执行/联网一律拒绝。
 * 代理只注入 agy 子进程，不污染 DSH Host 其他网络请求。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { buildAgyProxyEnv } from '../lib/review/agy-env.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = dirname(HERE)

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const name = key.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) out[name] = true
    else {
      out[name] = value
      i += 1
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const promptFile = String(args.prompt ?? '')
const roleFile = String(args.role ?? '')
const cwd = String(args.cwd ?? process.cwd())
const textArg = (name, fallback = '') => (typeof args[name] === 'string' && args[name].trim() !== '' ? args[name] : fallback)
const agyPath = textArg('agy-path', process.env.AGY_PATH || 'agy')
const agyProxy = textArg('agy-proxy', '')
const model = textArg('model', '')
const effort = textArg('effort', '')
const timeoutMs = args['timeout-ms'] === true || args['timeout-ms'] === undefined ? 0 : Number(args['timeout-ms'])
const startupTimeoutMs = args['startup-timeout-ms'] === true || args['startup-timeout-ms'] === undefined ? 30000 : Number(args['startup-timeout-ms'])

function envelope(payload) {
  return JSON.stringify({ type: 'result', ...payload })
}
function finish(code, payload) {
  const text = envelope(payload) + '\n'
  if (code === 0) {
    const fallback = setTimeout(() => process.exit(0), 1000)
    fallback.unref?.()
    process.stdout.write(text, () => process.exit(0))
    return
  }
  try {
    writeSync(1, text)
  } catch {}
  process.exit(code)
}
function fail(code, message, extra = {}) {
  finish(code, { subtype: 'error', is_error: true, errors: [String(message)], agent: 'agy', ...extra })
}
function gitStatus(cwd) {
  try {
    const result = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', windowsHide: true })
    return result.status === 0 ? result.stdout : null
  } catch {
    return null
  }
}

function killTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        process.kill(pid, 'SIGKILL')
      }
    }
  } catch {}
}

/** 从长文本里取最后一个完整 JSON 对象（评审 prompt 要求返回 JSON）。 */
function extractLastJsonObject(text) {
  const source = String(text ?? '').trim()
  if (source === '') return null
  // 常见情况：整段就是 JSON，或包在 ```json 里。
  const cleaned = source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(cleaned)
  } catch {
    // 继续从混排文本中找最后一个顶层 JSON 对象。
  }

  let depth = 0
  let inString = false
  let escaped = false
  let start = -1
  let last = null
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (char !== '}') continue
    if (depth === 0) continue
    depth -= 1
    if (depth !== 0 || start < 0) continue
    try {
      last = JSON.parse(source.slice(start, index + 1))
    } catch {
      // 这个顶层块不是 JSON，继续看后面的块。
    }
    start = -1
  }
  return last
}

if (!promptFile || !existsSync(promptFile)) fail(3, `agy ACP prompt file missing: ${promptFile}`)
let sdk
try {
  sdk = await import('@agentclientprotocol/sdk')
} catch (error) {
  fail(3, `ACP SDK is not installed: ${String(error?.message ?? error)}`)
}
const { client, methods, ndJsonStream } = sdk

const promptText = readFileSync(promptFile, 'utf8')
let roleText = ''
if (roleFile && existsSync(roleFile)) roleText = readFileSync(roleFile, 'utf8').trim()
let fullPrompt = roleText ? `# Reviewer role (read-only)\n${roleText}\n\n---\n\n${promptText}` : promptText
let roleMode = roleText ? 'prompt' : 'none'

const env = buildAgyProxyEnv(agyProxy, process.env)

const workspaceBefore = gitStatus(cwd)
const child = spawn(agyPath, ['acp', '--sandbox', '--disable-telemetry'], {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env,
})
let childStderr = ''
child.stderr.on('data', (chunk) => {
  const text = String(chunk)
  childStderr += text
  if (childStderr.length > 64_000) childStderr = childStderr.slice(-64_000)
  process.stderr.write(text)
})

let sessionHandle
let promptSent = false
let phase = 'initialize'
let finished = false
function done(code, payload) {
  if (finished) return
  finished = true
  try {
    sessionHandle?.dispose?.()
  } catch {}
  killTree(child.pid)
  finish(code, payload)
}

child.on('error', (error) => {
  done(3, { subtype: 'adapter_unavailable', is_error: true, agent: 'agy', errors: [`agy could not start: ${String(error?.message ?? error)}`] })
})

const READ_ONLY_TOOL_KINDS = new Set(['read', 'search'])
const ALLOW_OPTION_KINDS = new Set(['allow_once', 'allow_always'])
const REJECT_OPTION_KINDS = new Set(['reject_once', 'reject_always'])
const app = client({ name: 'dsh-agy-code-review' })
app.onRequest(methods.client.session.requestPermission, async (ctx) => {
  const kind = String(ctx.params?.toolCall?.kind ?? '')
  const options = Array.isArray(ctx.params?.options) ? ctx.params.options : []
  const allowed = READ_ONLY_TOOL_KINDS.has(kind)
  const wanted = allowed ? ALLOW_OPTION_KINDS : REJECT_OPTION_KINDS
  const picked = options.find((option) => wanted.has(String(option?.kind ?? '')))
  if (!picked?.optionId) return { outcome: { outcome: 'cancelled' } }
  return { outcome: { outcome: 'selected', optionId: picked.optionId } }
})
app.onRequest(methods.client.fs.readTextFile, async (ctx) => {
  const path = String(ctx.params?.path ?? '')
  try {
    // ACP fs 读取由桥接进程直接提供，不受 agy --sandbox/权限回调约束：必须自己限制在 cwd 内。
    const root = resolve(cwd)
    const absolute = resolve(root, path)
    const rel = relative(root, absolute)
    if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
      throw new Error('read outside workspace is denied')
    }
    let content = readFileSync(absolute, 'utf8')
    const line = Number(ctx.params?.line ?? 0)
    const limit = Number(ctx.params?.limit ?? 0)
    if (line > 0 || limit > 0) {
      const rows = content.split(/\r?\n/)
      const start = line > 0 ? line - 1 : 0
      const end = limit > 0 ? start + limit : rows.length
      content = rows.slice(start, end).join('\n')
    }
    return { content }
  } catch (error) {
    throw new Error(`read denied or unreadable: ${path}: ${String(error?.message ?? error)}`)
  }
})
app.onRequest(methods.client.fs.writeTextFile, async () => {
  throw new Error('agy code review is read-only: file writes are denied')
})

function optionValues(option) {
  const values = []
  const options = Array.isArray(option?.options) ? option.options : []
  for (const entry of options) {
    if (Array.isArray(entry?.options)) values.push(...entry.options)
    else values.push(entry)
  }
  return values
}

async function setSessionOption(ctx, handle, category, wanted) {
  if (!wanted) return null
  const configOptions = Array.isArray(handle?.newSessionResponse?.configOptions)
    ? handle.newSessionResponse.configOptions
    : []
  const option = configOptions.find((item) => {
    const cat = String(item?.category ?? '')
    return cat === category || (category === 'model' && String(item?.id ?? '').toLowerCase().includes('model'))
  })
  if (!option) {
    if (category === 'model') throw new Error('agy 当前会话没有模型选择项，无法应用指定模型')
    return null
  }
  const values = optionValues(option)
  const match = values.find((item) => String(item?.value ?? '') === wanted || String(item?.name ?? '') === wanted)
  if (!match) {
    const available = values.map((item) => item?.value).filter(Boolean).join(', ')
    throw new Error(`agy ${category} 不支持 "${wanted}"${available ? `；可选：${available}` : ''}`)
  }
  await ctx.request('session/set_config_option', {
    sessionId: handle.sessionId,
    configId: option.id,
    value: match.value,
  })
  return match.value
}

/** agy models 的 id 带推理档位后缀（gemini-4-hydrogen-high），会话配置拆成 model + thought_level。 */
async function applyModel(ctx, handle, wanted) {
  const text = wanted.trim()
  if (text === '') return null
  const suffix = text.match(/^(.*)-(low|medium|high|xhigh|max)$/i)
  if (suffix) {
    try {
      const base = await setSessionOption(ctx, handle, 'model', suffix[1])
      const effortValue = await setSessionOption(ctx, handle, 'thought_level', suffix[2].toLowerCase())
      return { model: base, effort: effortValue }
    } catch {
      // 后缀不是推理档位（或该模型没有档位）时，按完整 id 再试一次。
    }
  }
  return { model: await setSessionOption(ctx, handle, 'model', text), effort: null }
}

let timer
let startupTimer
try {
  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
  await app.connectWith(stream, async (ctx) => {
    if (startupTimeoutMs > 0) {
      startupTimer = setTimeout(() => {
        if (!promptSent) done(3, { subtype: 'acp_startup_timeout', is_error: true, agent: 'agy', phase, errors: [`agy ACP startup timed out after ${startupTimeoutMs}ms during ${phase}`] })
      }, startupTimeoutMs)
      startupTimer.unref?.()
    }
    const init = await ctx.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
    })
    if (!init || init.protocolVersion !== 1) throw new Error(`agy ACP initialize failed: ${JSON.stringify(init).slice(0, 500)}`)
    phase = 'session'

    const caps = init?.agentCapabilities ?? {}
    const systemPromptSupported = Boolean(
      caps?.sessionCapabilities?.systemPrompt || caps?._meta?.antigravity?.systemPrompt?.append,
    )
    const sessionRequest = { cwd, mcpServers: [] }
    if (roleText && systemPromptSupported) {
      sessionRequest.systemPrompt = { mode: 'append', content: [{ type: 'text', text: roleText }] }
      fullPrompt = promptText
      roleMode = 'system'
    }
    sessionHandle = await ctx.buildSession(sessionRequest).start()
    phase = 'mode'
    try {
      await ctx.request(methods.agent.session.setMode, { sessionId: sessionHandle.sessionId, modeId: 'plan' })
    } catch (error) {
      throw new Error(`agy ACP 无法切到 plan 只读模式：${String(error?.message ?? error)}`)
    }
    phase = 'model'
    const appliedModel = await applyModel(ctx, sessionHandle, model)
    if (effort.trim() !== '') await setSessionOption(ctx, sessionHandle, 'thought_level', effort.trim())
    phase = 'prompt'
    if (startupTimer) {
      clearTimeout(startupTimer)
      startupTimer = null
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => done(1, { subtype: 'acp_timeout', is_error: true, agent: 'agy', phase, errors: [`agy review timed out after ${timeoutMs}ms`] }), timeoutMs)
      timer.unref?.()
    }
    const textPromise = sessionHandle.readText()
    promptSent = true
    const response = await sessionHandle.prompt(fullPrompt)
    const text = await textPromise
    if (timer) { clearTimeout(timer); timer = null }
    const workspaceAfter = gitStatus(cwd)
    if (workspaceBefore !== null && workspaceAfter !== null && workspaceBefore !== workspaceAfter) {
      done(1, {
        subtype: 'workspace-mutated',
        is_error: true,
        agent: 'agy',
        errors: ['agy 评审期间修改了工作区（plan 模式/只读权限失效）。已中止，请检查 git status。'],
      })
    }
    const reviewJson = extractLastJsonObject(text)
    done(0, {
      subtype: 'success',
      is_error: false,
      result: reviewJson || text,
      stopReason: response?.stopReason ?? '',
      total_cost_usd: null,
      transport: 'acp',
      agent: 'agy',
      model: model.trim() || 'default',
      roleMode,
    })
  })
} catch (error) {
  const message = `agy ACP review failed${phase ? ` during ${phase}` : ''}: ${String(error?.message ?? error)}`
  const details = childStderr.trim() ? childStderr.trim().slice(-2000) : ''
  if (!promptSent) done(3, { subtype: 'acp_startup_failed', is_error: true, agent: 'agy', phase, errors: details ? [message, details] : [message] })
  else done(1, { subtype: 'acp_failed', is_error: true, agent: 'agy', phase, errors: details ? [message, details] : [message] })
}
