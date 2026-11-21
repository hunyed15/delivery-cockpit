// 本地预览服务：用真实 React + 真实 CSS 渲染 client.js，数据来自 mock-data.mjs（形状同契约）。
//
// 为什么需要它：DSH 的 Web GUI 需要鉴权 token，agent 打不开；只看代码猜 CSS 会漏掉
// 溢出、换行、层级这类只有渲染才暴露的问题。这里绕开鉴权，在 localhost 用 CDP 截图核对。
//
// 用法：
//   node tools/preview/server.mjs            # 默认 4711，然后打开 http://127.0.0.1:4711/
//   PORT=4712 node tools/preview/server.mjs
//
// 场景（?scenario=）：normal | degraded | approved | pending | badlines | missing | init | overview | empty | error
// 说明：normal/degraded/... 自动进详情（预置 localStorage 上次项目）；overview/empty 停在总览。
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROJECT_PATH,
  workspacesFor,
  panelFor,
  initPlan,
  initResult,
  approveResult,
} from './mock-data.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '../..')
const PORT = Number(process.env.PORT || 4711)

const IS_WINDOWS = process.platform === 'win32'
const REACT_DIRS = IS_WINDOWS
  ? [join(HERE, 'node_modules'), 'D:/Coding/dsh-plugins/claude-code-review/tools/preview/node_modules']
  : [join(HERE, 'node_modules')]

async function findReactFile(relative) {
  for (const dir of REACT_DIRS) {
    const file = join(dir, relative)
    try {
      await stat(file)
      return file
    } catch {
      // 继续找下一个
    }
  }
  return null
}

// 近似的 DSH 浅色主题变量：只用于本地预览排版。
// 颜色对比度结论必须在真机上用真实 token 复核（这也是 README 里写明的限制）。
const TOKENS_CSS = `:root{
--dsw-alias-bg-base:#ffffff;
--dsw-alias-bg-layer-1:#fbfbfc;
--dsw-alias-bg-layer-2:#f2f3f5;
--dsw-alias-border-l1:#e3e5e8;
--dsw-alias-border-l2:#cfd3d8;
--dsw-alias-label-primary:#1b1d21;
--dsw-alias-label-secondary:#6b7280;
--dsw-alias-brand-primary:#2f6fed;
--dsw-alias-state-success-primary:#17864a;
--dsw-alias-state-warn-primary:#a86a00;
--dsw-alias-state-error-primary:#c9302c;
--dsw-alias-state-idle-primary:#9aa0a6;
}`

const HTML = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>delivery-cockpit-preview</title>
<link rel="stylesheet" href="/tokens.css">
<style>
html, body { margin:0; background:var(--dsw-alias-bg-base); }
#root { min-height:100vh; }
</style>
</head><body>
<div id="root"></div>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
<script src="/harness.js"></script>
<script src="/client.js"></script>
<script>window.__harness.boot()</script>
</body></html>`

const HARNESS = `(function () {
  var PROJECT_PATH = ${JSON.stringify(PROJECT_PATH)}
  var LAST_PROJECT_KEY = 'delivery-cockpit:last-project'
  var scenario = new URLSearchParams(location.search).get('scenario') || 'normal'

  // 预置「上次项目」让截图走真实分支：详情 vs 总览。
  try {
    if (scenario === 'overview' || scenario === 'empty' || scenario === 'nav') {
      localStorage.removeItem(LAST_PROJECT_KEY)
    } else {
      localStorage.setItem(LAST_PROJECT_KEY, PROJECT_PATH)
    }
  } catch (e) {}

  var captured = null
  window.__ModuleLoader__ = { load: function (def) { captured = def } }
  var regs = []
  var slots = {
    inject: function (name, cb) { cb(); return function () {} },
    register: function (opts, Comp) { regs.push({ opts: opts, Comp: Comp }); return function () {} },
  }

  function findByText(text) {
    var all = document.querySelectorAll('.dc-btn, .dc-btn-primary')
    for (var i = 0; i < all.length; i++) {
      if ((all[i].textContent || '').indexOf(text) >= 0) return all[i]
    }
    return null
  }

  function waitReady(callback, attempt) {
    attempt = attempt || 0
    var root = document.querySelector('.dc-root')
    var skeleton = document.querySelector('.dc-skeleton')
    if (root && !skeleton) { callback(); return }
    if (attempt > 120) { document.title = 'timeout:' + scenario; return }
    setTimeout(function () { waitReady(callback, attempt + 1) }, 100)
  }

  function waitFor(selector, callback, attempt) {
    attempt = attempt || 0
    if (document.querySelector(selector)) { callback(); return }
    if (attempt > 80) { document.title = 'timeout:' + selector; return }
    setTimeout(function () { waitFor(selector, callback, attempt + 1) }, 100)
  }

  function rowFor(id) {
    return document.querySelector('[data-acceptance-id="' + id + '"]')
  }

  function clickInRow(id, text) {
    var row = rowFor(id)
    if (!row) return false
    var buttons = row.querySelectorAll('button')
    for (var i = 0; i < buttons.length; i++) {
      if ((buttons[i].textContent || '').indexOf(text) >= 0) { buttons[i].click(); return true }
    }
    return false
  }

  // React 受控 input 必须用原生 setter + input 事件，直接改 .value 不会触发 onChange。
  function setReactInput(input, value) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function waitForRowText(id, text, callback, attempt) {
    attempt = attempt || 0
    var row = rowFor(id)
    if (row && (row.textContent || '').indexOf(text) >= 0) { callback(); return }
    if (attempt > 80) { document.title = 'timeout:row-' + id; return }
    setTimeout(function () { waitForRowText(id, text, callback, attempt + 1) }, 100)
  }

  window.__harness = {
    boot: function () {
      var ctx = {
        slots: slots,
        get: function () { return undefined },
        logger: { warn: function () {} },
        effect: function (fn) { return fn() },
      }
      if (!captured) { document.title = 'fail:no-module'; return }
      var mod = captured.factory(function (id) {
        if (id === 'react') return window.React
        throw new Error('unknown module ' + id)
      })
      mod.apply(ctx)
      function find(name) {
        return regs.filter(function (r) { return r.opts.name === name })[0]
      }
      var main = find('main')
      if (!main) { document.title = 'fail:no-main-slot'; return }
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(main.Comp, {}))

      waitReady(function () {
        // init 场景自动点一次「初始化此项目」，把两步写入流程也渲染出来；
        // initdone 再多点一次确认，验证 POST /init 与成功横幅。
        if (scenario === 'init' || scenario === 'initdone') {
          var button = findByText('初始化此项目')
          if (button) {
            button.click()
            waitFor('.dc-plan', function () {
              if (scenario === 'initdone') {
                var confirm = findByText('确认写入并初始化')
                if (confirm) {
                  confirm.click()
                  waitFor('.dc-banner-ok', function () { document.title = 'ready:' + scenario })
                  return
                }
              }
              document.title = 'ready:' + scenario
            })
            return
          }
        }
        // approve-action：点一次「通过原型」，验证 POST 成功后刷新成只读状态。
        if (scenario === 'approve-action') {
          var approveButton = findByText('通过原型')
          if (approveButton) {
            approveButton.click()
            waitFor('.dc-hint-ok', function () { document.title = 'ready:' + scenario })
            return
          }
        }
        // nav：从总览点一张工作区卡片进详情，验证两级导航与「记住上次项目」。
        if (scenario === 'nav') {
          var card = document.querySelector('.dc-ws-card')
          if (card) {
            card.click()
            waitFor('.dc-card', function () { document.title = 'ready:' + scenario })
            return
          }
        }
        // features-expanded：展开第一行，验证 bug 明细与关联路径的渲染。
        if (scenario === 'features-expanded') {
          var toggle = document.querySelector('.dc-row-toggle')
          if (toggle) {
            toggle.click()
            waitFor('.dc-feature-detail-row', function () { document.title = 'ready:' + scenario })
            return
          }
        }
        // acceptance-edit：点开一条验收项的证据输入框。
        if (scenario === 'acceptance-edit') {
          if (clickInRow('A4', '编辑')) {
            waitFor('.dc-evidence-input', function () { document.title = 'ready:' + scenario })
            return
          }
        }
        // acceptance-save：撤销 A1 的通过结果，验证 POST /acceptance-result 成功后刷新。
        if (scenario === 'acceptance-save') {
          if (clickInRow('A1', '撤销')) {
            waitForRowText('A1', '未验', function () { document.title = 'ready:' + scenario })
            return
          }
        }
        // acceptance-error：给未验项填一个不存在的证据路径，验证 409 错误翻成人话。
        if (scenario === 'acceptance-error') {
          if (clickInRow('A4', '编辑')) {
            waitFor('.dc-evidence-input', function () {
              var input = document.querySelector('.dc-evidence-input')
              if (input) setReactInput(input, 'shots/missing-evidence.png')
              clickInRow('A4', '通过')
              waitFor('.dc-acc-error', function () { document.title = 'ready:' + scenario })
            })
            return
          }
        }
        document.title = 'ready:' + scenario
      })
    },
    slots: function () { return regs.map(function (r) { return r.opts.name }) },
  }
})()`

let currentScenario = 'normal'
// 只在 approve-action 场景使用：POST 成功后，后续 /panel 必须返回「已批准」，
// 这样截图验证的是「点通过 → 刷新成只读」这条真实链路，而不是静态假状态。
let approved = false
// 验收结果写操作的内存覆盖：模拟 Host 落盘后 /panel 的变化（截图才能看到刷新后的结果）。
let acceptanceOverrides = new Map()

function scenarioOf(url) {
  return url.searchParams.get('scenario') || currentScenario
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const server = createServer(async (req, res) => {
  // 不复用缓存：同一 user-data-dir 下改了 client.js 还截到旧页面是踩过的坑。
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate')
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/') currentScenario = url.searchParams.get('scenario') || 'normal'
  if (url.pathname === '/') approved = false
  if (url.pathname === '/') acceptanceOverrides = new Map()
  const scenario = scenarioOf(url)

  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(HTML)
    }
    if (url.pathname === '/harness.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      return res.end(HARNESS)
    }
    if (url.pathname === '/tokens.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' })
      return res.end(TOKENS_CSS)
    }
    if (url.pathname === '/client.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      return res.end(await readFile(join(PKG, 'client.js'), 'utf8'))
    }
    if (url.pathname === '/react.js' || url.pathname === '/react-dom.js') {
      const relative = url.pathname === '/react.js'
        ? 'react/umd/react.production.min.js'
        : 'react-dom/umd/react-dom.production.min.js'
      const file = await findReactFile(relative)
      if (!file) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end(
          `缺少 React 预览依赖：${relative}\n` +
            '可执行 npm --prefix tools/preview install，或把 React 18 的 UMD 文件放到 ' +
            'tools/preview/node_modules/<react|react-dom>/umd/ 下（本仓库不提交 node_modules）。\n',
        )
      }
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      return res.end(await readFile(file, 'utf8'))
    }

    // ---- 契约里的四个读接口 + 原型批准写接口 ----
    if (url.pathname === '/delivery-cockpit/api/workspaces') {
      return sendJson(res, 200, workspacesFor(scenario))
    }

    if (url.pathname === '/delivery-cockpit/api/panel') {
      if (scenario === 'error') {
        return sendJson(res, 500, { ok: false, error: 'workspace-not-allowed' })
      }
      const projectPath = url.searchParams.get('path')
      if (!projectPath) return sendJson(res, 400, { ok: false, error: 'missing-path' })
      const panelScenario = scenario === 'approve-action' && approved ? 'approved' : scenario
      const panel = panelFor(panelScenario)
      // 把验收结果的写操作结果反映到下一次 /panel，模拟真实 Host 的落盘再读。
      if (acceptanceOverrides.size > 0 && panel.acceptance && Array.isArray(panel.acceptance.items)) {
        const items = panel.acceptance.items.map((item) =>
          acceptanceOverrides.has(item.id) ? { ...item, ...acceptanceOverrides.get(item.id) } : item,
        )
        panel.acceptance = {
          ...panel.acceptance,
          items,
          total: items.length,
          withResult: items.filter((item) => item.result !== null && item.result !== undefined).length,
          passed: items.filter((item) => item.result === 'pass').length,
          failed: items.filter((item) => item.result === 'fail').length,
          blocked: items.filter((item) => item.result === 'blocked').length,
        }
        // 预览里同步功能账的验收汇总，避免「撤销后 区③ 1/6、功能表仍 1/2」的自相矛盾。
        if (panel.features && Array.isArray(panel.features.items)) {
          const byFeature = new Map()
          for (const item of items) {
            if (!item.featureRef) continue
            const list = byFeature.get(item.featureRef) || []
            list.push(item)
            byFeature.set(item.featureRef, list)
          }
          panel.features = {
            ...panel.features,
            items: panel.features.items.map((feature) => {
              const refs = byFeature.get(feature.id)
              if (!refs || refs.length === 0) return feature
              return {
                ...feature,
                acceptance: {
                  total: refs.length,
                  passed: refs.filter((item) => item.result === 'pass').length,
                  failed: refs.filter((item) => item.result === 'fail').length,
                  blocked: refs.filter((item) => item.result === 'blocked').length,
                  missingEvidence: refs.filter((item) => item.result === null).length,
                },
              }
            }),
          }
        }
      }
      return sendJson(res, 200, { ok: true, panel })
    }

    if (url.pathname === '/delivery-cockpit/api/init-plan') {
      const projectPath = url.searchParams.get('path')
      if (!projectPath) return sendJson(res, 400, { ok: false, error: 'missing-path' })
      return sendJson(res, 200, { ok: true, plan: initPlan(projectPath) })
    }

    if (url.pathname === '/delivery-cockpit/api/init' && req.method === 'POST') {
      const body = await readBody(req)
      if (!body || body.confirm !== true) {
        return sendJson(res, 400, { ok: false, error: 'confirm-required' })
      }
      return sendJson(res, 200, initResult(body.path || PROJECT_PATH))
    }

    if (url.pathname === '/delivery-cockpit/api/approve-prototype' && req.method === 'POST') {
      const body = await readBody(req)
      if (scenario === 'error') {
        return sendJson(res, 500, { ok: false, error: 'workspace-not-allowed' })
      }
      if (!body || !body.iteration_id) {
        return sendJson(res, 400, { ok: false, error: 'iteration-required' })
      }
      approved = true
      return sendJson(res, 200, approveResult(body.iteration_id))
    }

    if (url.pathname === '/delivery-cockpit/api/acceptance-result' && req.method === 'POST') {
      const body = await readBody(req)
      if (!body || !body.item_id) {
        return sendJson(res, 400, { ok: false, error: 'item-required' })
      }
      const allowed = [null, 'pass', 'fail', 'blocked']
      if (!Object.prototype.hasOwnProperty.call(body, 'result') || allowed.indexOf(body.result) < 0) {
        return sendJson(res, 400, { ok: false, error: 'bad-result' })
      }
      const evidence = Array.isArray(body.evidence) ? body.evidence.filter((item) => typeof item === 'string') : []
      if (body.result === 'pass' && evidence.length === 0) {
        return sendJson(res, 400, { ok: false, error: 'evidence-required' })
      }
      const base = panelFor(scenario === 'acceptance-empty' ? 'acceptance-empty' : scenario)
      const items = base && base.acceptance && Array.isArray(base.acceptance.items) ? base.acceptance.items : []
      const item = items.find((candidate) => candidate.id === body.item_id)
      if (!item) return sendJson(res, 404, { ok: false, error: 'item-not-found' })
      // 预览用「文件不存在」的模拟：路径里带 missing/notfound 就按 409 处理。
      if (evidence.some((value) => /missing|notfound/i.test(value))) {
        return sendJson(res, 409, { ok: false, error: 'evidence-not-found' })
      }
      const patch =
        body.result === null
          ? { result: null, evidence: [], at: null }
          : { result: body.result, evidence, at: new Date().toISOString() }
      acceptanceOverrides.set(item.id, patch)
      return sendJson(res, 200, { ok: true, item: { ...item, ...patch } })
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  } catch (error) {
    sendJson(res, 502, { ok: false, error: String(error && error.message ? error.message : error) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`preview: http://127.0.0.1:${PORT}/   scenario=${currentScenario}`)
})
