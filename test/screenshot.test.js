/**
 * 截图引擎的纯逻辑部分：URL 白名单（只允许回环）与浏览器探测、落盘路径。
 *
 * 真正的浏览器截图不放进单测（要 spawn Chrome、慢且依赖机器），由 live 验证覆盖：
 * 起一个本地页面 → 调 /acceptance-screenshot → 检查 PNG 与证据挂接。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureScreenshot, detectBrowser, parsePreviewUrl, writeScreenshot } from '../lib/screenshot.js'

test('URL 白名单：只放行回环地址的 http(s)', () => {
  for (const url of ['http://127.0.0.1:3000', 'http://localhost:5173/app', 'https://[::1]:8443/x']) {
    assert.equal(parsePreviewUrl(url).ok, true, `应放行 ${url}`)
  }
  const external = parsePreviewUrl('http://192.168.1.10:3000')
  assert.equal(external.ok, false)
  assert.equal(external.error, 'url-not-loopback')

  assert.deepEqual(parsePreviewUrl(''), { ok: false, error: 'no-url' })
  assert.deepEqual(parsePreviewUrl('   '), { ok: false, error: 'no-url' })
  assert.deepEqual(parsePreviewUrl('file:///C:/x.html'), { ok: false, error: 'invalid-url' })
  assert.deepEqual(parsePreviewUrl('not a url'), { ok: false, error: 'invalid-url' })
})

test('浏览器探测：显式路径优先，不存在时回退系统 Chrome/Edge', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dc-shot-'))
  try {
    const fake = join(dir, 'chrome.exe')
    await writeFile(fake, 'x', 'utf8')
    assert.equal(detectBrowser(fake), fake, '显式配置要优先')

    // 不存在的显式路径 + 系统里有 Chrome/Edge ⇒ 回退到系统浏览器；都没有才是 null。
    const fallback = detectBrowser(join(dir, 'nope.exe'))
    assert.ok(fallback === null || typeof fallback === 'string')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('captureScreenshot：URL 不合法时立刻失败，不启动浏览器', async () => {
  const result = await captureScreenshot({ url: 'http://example.com' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'url-not-loopback')
  const bad = await captureScreenshot({ url: 'garbage' })
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'invalid-url')
})

test('captureScreenshot：客户端已断开（signal aborted）→ 直接放弃，不启动浏览器', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await captureScreenshot({ url: 'http://127.0.0.1:4789/', signal: controller.signal })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'aborted')
})

test('writeScreenshot：只写 .dsh/plugin-state/shots/，返回项目相对路径', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dc-shot-proj-'))
  try {
    const relativePath = await writeScreenshot(project, 'A1-2026.png', Buffer.from([1, 2, 3]))
    assert.equal(relativePath, '.dsh/plugin-state/shots/A1-2026.png')
    const bytes = await readFile(join(project, '.dsh', 'plugin-state', 'shots', 'A1-2026.png'))
    assert.deepEqual([...bytes], [1, 2, 3])

    // 目录已存在时也能再写
    await mkdir(join(project, '.dsh', 'plugin-state', 'shots'), { recursive: true })
    const again = await writeScreenshot(project, 'A1-2027.png', Buffer.from([4]))
    assert.equal(again, '.dsh/plugin-state/shots/A1-2027.png')
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('截图逐跳回环：本机 302 到外网时被拦截，不截外网内容', async (t) => {
  if (detectBrowser() === null) {
    t.skip('本机没有 Chrome/Edge，跳过浏览器用例')
    return
  }
  const { createServer } = await import('node:http')
  const server = createServer((request, response) => {
    response.writeHead(302, { Location: 'http://example.com/' })
    response.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const result = await captureScreenshot({ url: 'http://127.0.0.1:' + port + '/', timeoutMs: 20000 })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'url-not-loopback')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})