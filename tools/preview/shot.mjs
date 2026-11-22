// 通过 CDP 截图并测量横向溢出，deviceScaleFactor 钉死为 1。
//
// 为什么不用 `chrome --screenshot`：在 125% DPI 的机器上 CLI 截图会缩放页面，
// 布局正确看起来也被裁掉，真正的溢出反而看着正常。用 Emulation.setDeviceMetricsOverride
// 才能拿到「精确 CSS 像素视口」。
//
// 用法：
//   node tools/preview/shot.mjs <url> <width> <height> <out.png> [full]
//   node tools/preview/shot.mjs <url> <width> --measure
//
// 浏览器探测顺序：CHROME_PATH -> Chrome -> Edge。都没有就报错，不偷偷装依赖。
import { spawn } from 'node:child_process'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const measureOnly = args.includes('--measure')
const fullPage = args.includes('full')
const positional = args.filter((arg) => !arg.startsWith('--') && arg !== 'full')

const url = positional[0] || 'http://127.0.0.1:4711/'
const width = Number(positional[1] || 1200)
const requestedHeight = Number(positional[2] || 900)
const outPath = measureOnly ? null : positional[3]
if (!measureOnly && !outPath) {
  console.error('用法: node tools/preview/shot.mjs <url> <width> <height> <out.png> [full]')
  process.exit(2)
}

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)
const CHROME = BROWSERS.find((candidate) => existsSync(candidate))
if (!CHROME) {
  console.error('没有找到可驱动的 Chrome/Edge（可用 CHROME_PATH 指定）。')
  process.exit(1)
}

const CDP_PORT = 9334 + Math.floor(Math.random() * 200)
const profile = await mkdtemp(join(tmpdir(), 'delivery-cockpit-shot-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

// 浏览器进程与临时 profile 都要收干净：之前每截一张就在 %TEMP% 留一个目录。
const stop = async () => {
  try {
    chrome.kill()
  } catch {
    // 已经退出
  }
  await rm(profile, { recursive: true, force: true }).catch(() => {})
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let wsUrl = null
for (let attempt = 0; attempt < 80; attempt++) {
  await sleep(200)
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    const page = list.find((target) => target.type === 'page')
    if (page && page.webSocketDebuggerUrl) {
      wsUrl = page.webSocketDebuggerUrl
      break
    }
  } catch {
    // 浏览器还没起来
  }
}
if (!wsUrl) {
  await stop()
  console.error('CDP target 未就绪')
  process.exit(1)
}

const ws = new WebSocket(wsUrl)
let nextId = 0
const pending = new Map()
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  }
})
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width,
  height: requestedHeight,
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Page.navigate', { url })

// 等 harness 把 title 置成 ready/timeout/fail：固定 sleep 会随机截到骨架屏。
let title = ''
for (let attempt = 0; attempt < 120; attempt++) {
  await sleep(100)
  try {
    const result = await send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    })
    title = String(result.result.value || '')
    if (title.startsWith('ready:') || title.startsWith('timeout:') || title.startsWith('fail:')) break
  } catch {
    // 页面还在导航
  }
}
if (!title.startsWith('ready:')) {
  console.error(`页面没有就绪（title=${title || '空'}）`)
}
await sleep(250)

const measureExpression = `(() => {
  const root = document.querySelector('.dc-root')
  const vw = innerWidth
  // 表格允许在自己的横向滚动容器里滚动；这类元素不算「页面溢出」。
  const insideXScroller = (el) => {
    let node = el.parentElement
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node)
      if (/(auto|scroll)/.test(style.overflowX)) return true
      node = node.parentElement
    }
    return false
  }
  const offenders = []
  for (const el of document.querySelectorAll('.dc-root *')) {
    const rect = el.getBoundingClientRect()
    if (rect.width > vw + 1 || rect.right > vw + 1) {
      if (insideXScroller(el)) continue
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.getAttribute('class') || '').slice(0, 48),
        w: Math.round(rect.width),
        right: Math.round(rect.right),
      })
    }
  }
  const scrollers = []
  for (const el of document.querySelectorAll('.dc-root *')) {
    const style = getComputedStyle(el)
    if (/(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1) {
      scrollers.push({ cls: (el.getAttribute('class') || '').slice(0, 48), scrollWidth: el.scrollWidth })
    }
  }
  // 滚一段，验证 sticky header/摘要条/右栏的叠层与对齐。
  if (root) root.scrollTop = Math.min(400, Math.max(0, root.scrollHeight - root.clientHeight))
  const rectOf = (selector) => {
    const el = document.querySelector(selector)
    if (!el) return null
    const box = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return { top: Math.round(box.top), height: Math.round(box.height), z: style.zIndex, position: style.position }
  }
  return JSON.stringify({
    title: document.title,
    viewport: vw,
    docScrollWidth: document.documentElement.scrollWidth,
    rootScrollWidth: root ? root.scrollWidth : null,
    rootClientHeight: root ? root.clientHeight : null,
    rootScrollHeight: root ? root.scrollHeight : null,
    sticky: { header: rectOf('.dc-head'), summary: rectOf('.dc-summary-bar'), rail: rectOf('.dc-rail') },
    xScrollers: scrollers.slice(0, 5),
    offenders: offenders.slice(0, 12),
  }, null, 2)
})()`
const probe = await send('Runtime.evaluate', { expression: measureExpression, returnByValue: true })
const metrics = JSON.parse(probe.result.value)
const overflow = metrics.docScrollWidth > width + 1 || (metrics.rootScrollWidth != null && metrics.rootScrollWidth > width + 1)

if (measureOnly) {
  console.log(probe.result.value)
  console.log(overflow ? `OVERFLOW: 横向溢出（viewport=${width}）` : `OK: 无横向溢出（viewport=${width}）`)
  ws.close()
  await stop()
  process.exit(overflow ? 1 : 0)
}

// 详情页的 .dc-root 是「固定高度 + 内部滚动」；full 模式把视口拉到内容真实高度，
// 这样一张图能看到全部四区，而不是只截到首屏。
let captureHeight = requestedHeight
if (fullPage && Number(metrics.rootScrollHeight) > captureHeight) {
  captureHeight = Math.ceil(Number(metrics.rootScrollHeight))
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height: captureHeight,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await sleep(200)
}

const shot = await send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: false,
})
await writeFile(outPath, Buffer.from(shot.data, 'base64'))
console.log(
  `saved ${outPath} viewport=${width}x${captureHeight} ` +
    `docScroll=${metrics.docScrollWidth} rootScroll=${metrics.rootScrollWidth} ` +
    `${overflow ? 'OVERFLOW' : 'no-overflow'}`,
)

ws.close()
await stop()
process.exit(title.startsWith('ready:') && !overflow ? 0 : title.startsWith('ready:') ? 3 : 4)
