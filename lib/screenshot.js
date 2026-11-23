/**
 * 本机截图：用 Chrome/Edge 的 CDP 截一张真实页面，零依赖（和 tools/preview 同一套原理）。
 *
 * 为什么不是 Playwright：本机 profile 没有 Playwright MCP，而"点一下就出截图"必须由 Host 做。
 * 装了 Playwright 的机器上 Agent 仍可走 MCP；这里的引擎只依赖本机已有浏览器。
 *
 * 安全边界（写死，不给配置开口子）：
 * - 只允许 http(s) 的 **回环地址**（127.0.0.1 / localhost / [::1]）——这是"预览本机站点"的场景，
 *   不把它变成任意 URL 的抓取器（SSRF）；
 * - 每次截图用独立临时 profile，结束后删掉；浏览器子进程无论成败都 kill。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const SCREENSHOT_DEFAULTS = {
  width: 1280,
  height: 900,
  settleMs: 700,
  timeoutMs: 30_000,
  maxBytes: 10 * 1024 * 1024,
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** 只接受回环 http(s) URL；其他一律拒绝（返回原因，便于 UI 翻人话）。 */
export function parsePreviewUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, error: 'no-url' }
  let url
  try {
    url = new URL(value.trim())
  } catch {
    return { ok: false, error: 'invalid-url' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'invalid-url' }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    return { ok: false, error: 'url-not-loopback', detail: url.hostname }
  }
  return { ok: true, url: url.toString() }
}

/** 初始 URL 只接受回环 http(s)；页面内的每一跳请求也按同一口径再校验一次。 */
function isAllowedNetworkUrl(value) {
  if (typeof value !== 'string' || value === '') return true
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') return LOOPBACK_HOSTS.has(url.hostname)
  // data/blob/about 与页面自身 WebSocket 不涉及 HTTP 抓取；file/ftp 等一律拒绝。
  return new Set(['data:', 'blob:', 'about:', 'ws:', 'wss:']).has(url.protocol)
}

/** 浏览器探测顺序：显式配置 → CHROME_PATH → Chrome → Edge。都没有就返回 null（不偷偷装依赖）。 */
export function detectBrowser(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((candidate) => typeof candidate === 'string' && candidate.trim() !== '')
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // 继续看下一个
    }
  }
  return null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 杀浏览器**进程树**：Windows 上 child.kill() 只终止主进程，renderer/gpu 子进程会残留在
 * 临时 profile 上（进而导致目录删不掉、反复点截图累积僵尸进程）。所以 Windows 走 taskkill /T。
 */
function killTree(child) {
  if (!child) return
  try {
    if (child.exitCode !== null) return
  } catch {
    // 继续尝试
  }
  try {
    if (process.platform === 'win32' && Number.isInteger(child.pid)) {
      const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      if (result?.status === 0) return
    }
    child.kill('SIGKILL')
  } catch {
    try {
      child.kill()
    } catch {
      // 已经退出
    }
  }
}

/** 删临时 profile：失败延迟重试一次（Windows 文件锁常是瞬时占用），仍失败就如实返回 false。 */
async function removeDirBestEffort(dir) {
  if (!dir) return true
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true })
      return true
    } catch {
      if (attempt === 0) await sleep(250)
    }
  }
  return false
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function waitForTarget(port, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted === true) return null
    await sleep(150)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await response.json()
      const page = Array.isArray(list) ? list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl) : null
      if (page) return page.webSocketDebuggerUrl
    } catch {
      // 浏览器还没起来
    }
  }
  return null
}

function createCdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let nextId = 0
  const pending = new Map()
  const listeners = new Map()
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('websocket-error')), { once: true })
  })
  ws.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (!message?.id && typeof message?.method === 'string') {
      const handlers = listeners.get(message.method)
      if (handlers) for (const handler of handlers) handler(message.params ?? {})
      return
    }
    if (!message?.id || !pending.has(message.id)) return
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      try {
        ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        pending.delete(id)
        reject(error)
      }
    })
  const on = (method, handler) => {
    const handlers = listeners.get(method) ?? new Set()
    handlers.add(handler)
    listeners.set(method, handlers)
    return () => {
      handlers.delete(handler)
      if (handlers.size === 0) listeners.delete(method)
    }
  }
  return {
    ready,
    send,
    on,
    close() {
      try {
        ws.close()
      } catch {
        // 已经断了
      }
    },
  }
}

/**
 * 截一张图。
 * 成功：`{ ok:true, png: Buffer, width, height, url }`
 * 失败：`{ ok:false, error:'browser-not-found'|'invalid-url'|'url-not-loopback'|'browser-failed'|'timeout'|'capture-failed', detail }`
 */
export async function captureScreenshot(input = {}) {
  const parsed = parsePreviewUrl(input.url)
  if (!parsed.ok) return parsed
  const browser = detectBrowser(input.browserPath)
  if (browser === null) return { ok: false, error: 'browser-not-found' }

  const width = Number.isFinite(input.width) && input.width > 0 ? Math.trunc(input.width) : SCREENSHOT_DEFAULTS.width
  const height = Number.isFinite(input.height) && input.height > 0 ? Math.trunc(input.height) : SCREENSHOT_DEFAULTS.height
  const settleMs = Number.isFinite(input.settleMs) && input.settleMs >= 0 ? Math.trunc(input.settleMs) : SCREENSHOT_DEFAULTS.settleMs
  const timeoutMs = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? Math.trunc(input.timeoutMs) : SCREENSHOT_DEFAULTS.timeoutMs
  const signal = input.signal
  // 单一 deadline 贯穿全程：每一步都用"剩余预算"，不会出现 4 段各自 30s 的最坏 100s+。
  const deadline = Date.now() + timeoutMs
  const remaining = () => Math.max(0, deadline - Date.now())
  const aborted = () => signal?.aborted === true
  const abortError = () => Object.assign(new Error('aborted'), { aborted: true })
  const sleepOrAbort = async (ms) => {
    const budget = Math.min(ms, remaining())
    if (budget <= 0) throw Object.assign(new Error('timeout'), { timeout: true })
    await sleep(budget)
    if (aborted()) throw abortError()
  }
  if (aborted()) return { ok: false, error: 'aborted' }

  let port
  try {
    port = await freePort()
  } catch {
    port = 9400 + Math.floor(Math.random() * 400)
  }
  let profileDir = null
  let child = null
  let cdp = null
  let profileCleaned = true
  const cleanup = async () => {
    try {
      cdp?.close()
    } catch {
      // 忽略
    }
    killTree(child)
    profileCleaned = await removeDirBestEffort(profileDir)
  }

  try {
    profileDir = await mkdtemp(join(tmpdir(), 'delivery-cockpit-shot-'))
    child = spawn(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: true },
    )
    child.on('error', () => {})

    const wsUrl = await waitForTarget(port, Math.min(remaining(), 15_000), signal)
    if (wsUrl === null) {
      return { ok: false, error: aborted() ? 'aborted' : 'browser-failed', detail: 'CDP target 未就绪' }
    }
    if (aborted()) return { ok: false, error: 'aborted' }

    cdp = createCdp(wsUrl)
    // 三个等待源：CDP 就绪 / 客户端断开 / 总 deadline 到点。
    const abortRejection = new Promise((_, reject) => {
      if (!signal) return
      if (signal.aborted) {
        reject(abortError())
        return
      }
      signal.addEventListener('abort', () => reject(abortError()), { once: true })
    })
    const withDeadline = (promise) =>
      Promise.race([
        promise,
        abortRejection,
        sleep(remaining()).then(() => Promise.reject(Object.assign(new Error('timeout'), { timeout: true }))),
      ])
    await withDeadline(cdp.ready)
    await withDeadline(cdp.send('Page.enable'))
    await withDeadline(
      cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      }),
    )

    // 逐跳拦截页面请求：初始 URL 是回环，但页面可以 302/资源请求到内网。
    // 非回环 http(s) 请求直接 fail，并记录原因；data/blob/about 放行。
    let blockedRequestUrl = null
    cdp.on('Fetch.requestPaused', (params) => {
      const requestId = params?.requestId
      if (typeof requestId !== 'string' || requestId === '') return
      const requestUrl = params?.request?.url
      if (isAllowedNetworkUrl(requestUrl)) {
        void cdp.send('Fetch.continueRequest', { requestId }).catch(() => {})
        return
      }
      if (blockedRequestUrl === null) blockedRequestUrl = String(requestUrl ?? '')
      void cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {})
    })
    await withDeadline(cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }))
    await withDeadline(cdp.send('Page.navigate', { url: parsed.url }))
    if (blockedRequestUrl !== null) {
      return { ok: false, error: 'url-not-loopback', detail: blockedRequestUrl }
    }

    // 等页面真正加载完：poll readyState（同样吃同一个 deadline），再留一小段 settle 给首屏渲染。
    while (remaining() > 0) {
      if (blockedRequestUrl !== null) return { ok: false, error: 'url-not-loopback', detail: blockedRequestUrl }
      await sleepOrAbort(120)
      try {
        const state = await withDeadline(cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }))
        if (state?.result?.value === 'complete') break
      } catch (error) {
        if (error?.timeout || error?.aborted) throw error
        // 还在导航
      }
    }
    await sleepOrAbort(settleMs)
    if (aborted()) return { ok: false, error: 'aborted' }
    if (blockedRequestUrl !== null) return { ok: false, error: 'url-not-loopback', detail: blockedRequestUrl }

    // 最后再查一次最终 document URL：防止导航历史/重定向留下非回环地址。
    try {
      const finalUrl = await withDeadline(cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }))
      const href = typeof finalUrl?.result?.value === 'string' ? finalUrl.result.value : ''
      if (/^https?:/i.test(href) && !isAllowedNetworkUrl(href)) {
        return { ok: false, error: 'url-not-loopback', detail: href }
      }
    } catch (error) {
      if (error?.timeout || error?.aborted) throw error
    }

    const shot = await withDeadline(cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }))
    // 客户端在截图期间断开：不写盘、不挂证据（否则"客户端报超时、服务端其实已成功"）。
    if (aborted()) return { ok: false, error: 'aborted' }
    if (!shot?.data) return { ok: false, error: 'capture-failed', detail: 'CDP 没有返回图片数据' }
    const png = Buffer.from(shot.data, 'base64')
    const maxBytes = Number.isFinite(input.maxBytes) ? input.maxBytes : SCREENSHOT_DEFAULTS.maxBytes
    if (png.length === 0) return { ok: false, error: 'capture-failed', detail: '截图是空文件' }
    if (png.length > maxBytes) return { ok: false, error: 'capture-failed', detail: `截图超过 ${Math.round(maxBytes / 1024)} KiB` }
    return { ok: true, png, width, height, url: parsed.url }
  } catch (error) {
    if (error?.aborted) return { ok: false, error: 'aborted' }
    const message = String(error?.message ?? error)
    return { ok: false, error: error?.timeout || message === 'timeout' ? 'timeout' : 'capture-failed', detail: message }
  } finally {
    await cleanup()
    // 临时 profile 删不掉不是功能失败，但必须能看出来（不静默吞）。
    if (!profileCleaned) {
      // 用 stderr 提示：这是 Host 进程日志，不会污染面板数据。
      try {
        console.warn(`[delivery-cockpit] 截图临时 profile 未能删除：${profileDir}`)
      } catch {
        // 忽略
      }
    }
  }
}

/** 把截图写到项目的 `.dsh/plugin-state/shots/`（插件只写自己的状态目录）。返回项目相对路径。 */
export async function writeScreenshot(projectPath, fileName, png) {
  const dir = join(projectPath, '.dsh', 'plugin-state', 'shots')
  await mkdir(dir, { recursive: true })
  const target = join(dir, fileName)
  await writeFile(target, png)
  return `.dsh/plugin-state/shots/${fileName}`
}
