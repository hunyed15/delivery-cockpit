import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createAcceptanceResultHandler,
  createAcceptanceScreenshotHandler,
  createApproveHandler,
  createDecisionHandler,
  createInitHandler,
  createRoutes,
  BASE,
} from '../lib/route.js'

const PROJECT = resolve(tmpdir(), 'delivery-cockpit-route-fixture')
const OTHER = resolve(tmpdir(), 'delivery-cockpit-not-registered')

function makeDeps(overrides = {}) {
  const calls = { detail: [], plan: [], apply: [], approve: [], decision: [], acceptance: [], shot: [], screenshot: [], report: [] }
  const deps = {
    listWorkspaces: async () => [{ id: 'w1', title: 'demo', path: PROJECT }],
    resolveWorkspace: async (path) => (path === PROJECT ? { id: 'w1', title: 'demo', path: PROJECT } : null),
    readOverview: async () => ({
      projects: [{ id: 'w1', title: 'demo', path: PROJECT, initialized: true }],
      generatedAt: '2026-01-01T00:00:00.000Z',
    }),
    readDetail: async (path) => {
      calls.detail.push(path)
      return { ok: true, project: { path, name: 'demo' } }
    },
    // 周报：与 /panel 同一道读授权；返回 markdown + 下载文件名。
    readReport: async (path, options) => {
      calls.report.push([path, options])
      // 与真实 index.readReport 同语义：没给 days 时按配置默认 7 天。
      const days = options && options.days !== undefined ? options.days : 7
      return { markdown: `# demo 项目周报\n\n- days: ${days}\n`, filename: 'demo-weekly-2026-11-23.md' }
    },
    planInit: async (path) => {
      calls.plan.push(path)
      return { projectPath: path, dryRun: true, files: [], dirs: [] }
    },
    applyInit: async (path) => {
      calls.apply.push(path)
      return { applied: true, created: ['RULES.md'], skipped: [], errors: [], gitignoreHint: '.dsh/plugin-state/' }
    },
    approvePrototype: async (path, iterationId) => {
      calls.approve.push([path, iterationId])
      if (iterationId === '') return { ok: false, error: 'iteration-required' }
      if (iterationId === 'v9.9') return { ok: false, error: 'prototype-missing' }
      return { ok: true, approval: { iterationId, prototypeApprovedAt: '2026-01-01T00:00:00.000Z', prototype: 'prototype.html' } }
    },
    approveDecision: async (path, iterationId, gate) => {
      calls.decision.push([path, iterationId, gate])
      // 与真实 approveDecision 同语义：参数错 400 类，前置不满足 409 类。
      if (!['scope', 'architecture', 'prototype', 'acceptance', 'release'].includes(gate)) {
        return { ok: false, error: 'bad-gate' }
      }
      if (iterationId === '' || iterationId === 'bootstrap') return { ok: false, error: 'bad-iteration' }
      if (gate === 'prototype') {
        if (iterationId === 'v9.9') return { ok: false, error: 'prototype-missing' }
        return {
          ok: true,
          approval: { iterationId, prototypeApprovedAt: '2026-01-01T00:00:00.000Z', prototype: 'prototype.html' },
        }
      }
      if (iterationId === 'v-prd') return { ok: false, error: 'prd-missing' }
      if (iterationId === 'v-arch') return { ok: false, error: 'architecture-gate-not-ready', missing: ['docs/api.md'] }
      if (iterationId === 'v-accept') return { ok: false, error: 'acceptance-not-passing', missing: ['A1'] }
      if (iterationId === 'v-release') return { ok: false, error: 'release-gate-not-ready', missing: ['.dsh/plugin-state/release.json', 'acceptance'] }
      return { ok: true, gate, at: '2026-01-01T00:00:00.000Z', iteration_id: iterationId }
    },
    readShot: async (projectPath, file) => {
      calls.shot.push([projectPath, file])
      if (file === 'notes.txt') return { ok: false, error: 'not-image' }
      if (file === 'huge.png') return { ok: false, error: 'file-too-large' }
      if (file === 'gone.png') return { ok: false, error: 'shot-not-found' }
      return { ok: true, bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png' }
    },
    takeAcceptanceScreenshot: async (projectPath, input) => {
      calls.screenshot.push([projectPath, input])
      if (input.item_id === 'A9') return { ok: false, error: 'item-not-found' }
      if (!input.url && input.item_id === 'A-NOURL') return { ok: false, error: 'no-url' }
      if (input.url === 'http://example.com') return { ok: false, error: 'url-not-loopback', detail: 'example.com' }
      if (input.url === 'http://127.0.0.1:9/slow') return { ok: false, error: 'timeout' }
      if (input.url === 'http://127.0.0.1:9/abort') return { ok: false, error: 'aborted' }
      return {
        ok: true,
        added: 1,
        shot: { file: '.dsh/plugin-state/shots/A1-x.png', width: 1280, height: 900, url: input.url ?? 'http://127.0.0.1:3000' },
        item: { id: input.item_id, result: null, evidence: ['.dsh/plugin-state/shots/A1-x.png'] },
      }
    },
    setAcceptanceResult: async (projectPath, input) => {
      calls.acceptance.push([projectPath, input])
      // 与真实 setAcceptanceResult 同语义：字段缺失 ≠ 撤销。
      if (!Object.prototype.hasOwnProperty.call(input, 'result')) return { ok: false, error: 'bad-result' }
      if (input.item_id === 'A9') return { ok: false, error: 'item-not-found' }
      if (input.item_id === 'A-MISMATCH') return { ok: false, error: 'iteration-mismatch', iterationId: 'v0.9' }
      if (input.item_id === 'A-BROKEN') return { ok: false, error: 'acceptance-broken' }
      if (input.item_id === 'A-NOITER') return { ok: false, error: 'iteration-required' }
      if (input.result === 'pass' && !(Array.isArray(input.evidence) && input.evidence.length > 0)) {
        return { ok: false, error: 'evidence-required' }
      }
      if (Array.isArray(input.evidence) && input.evidence.includes('missing.png')) {
        return { ok: false, error: 'evidence-not-found', detail: 'missing.png' }
      }
      return {
        ok: true,
        item: {
          id: input.item_id,
          result: input.result ?? null,
          evidence: Array.isArray(input.evidence) ? input.evidence : [],
          at: input.result == null ? null : '2026-01-01T00:00:00.000Z',
        },
      }
    },
    ...overrides,
  }
  return { deps, calls }
}

function get(pathname, method = 'GET') {
  return new Request(`http://127.0.0.1:3080${pathname}`, { method })
}

function panelUrl(path) {
  return `${BASE}/panel?path=${encodeURIComponent(path)}`
}

test('GET /workspaces 透传工作区列表', async () => {
  const { deps } = makeDeps()
  const routes = createRoutes(deps)
  const response = await routes.handle(get(`${BASE}/workspaces`))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.projects.length, 1)
  assert.equal(body.projects[0].id, 'w1')
  assert.equal(body.generatedAt, '2026-01-01T00:00:00.000Z')
})

test('GET /panel 缺 path 时给 400，不是 500', async () => {
  const { deps, calls } = makeDeps()
  const response = await createRoutes(deps).handle(get(`${BASE}/panel`))
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { ok: false, error: 'missing-path' })
  assert.equal(calls.detail.length, 0, '未授权时不能读盘')
})

test('GET /panel 相对路径直接 400（root scope 没有当前目录）', async () => {
  const { deps } = makeDeps()
  const response = await createRoutes(deps).handle(get(`${BASE}/panel?path=demo`))
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { ok: false, error: 'path-not-absolute' })
})

test('GET /panel 未登记工作区 403，且不调用 readDetail', async () => {
  const { deps, calls } = makeDeps()
  const response = await createRoutes(deps).handle(get(panelUrl(OTHER)))
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { ok: false, error: 'workspace-not-allowed' })
  assert.equal(calls.detail.length, 0)
})

test('GET /panel 已登记工作区返回面板', async () => {
  const { deps, calls } = makeDeps()
  const response = await createRoutes(deps).handle(get(panelUrl(PROJECT)))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.panel.project.name, 'demo')
  assert.deepEqual(calls.detail, [PROJECT])
})

test('GET /report：200 + markdown 类型 + 附件下载头，days 透传', async () => {
  const { deps, calls } = makeDeps()
  const response = await createRoutes(deps).handle(get(`${BASE}/report?path=${encodeURIComponent(PROJECT)}&days=7`))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const disposition = response.headers.get('content-disposition')
  assert.match(disposition, /^attachment;/)
  assert.ok(disposition.includes('filename="demo-weekly-2026-11-23.md"'), `ASCII 文件名要逐字：${disposition}`)
  assert.ok(disposition.includes("filename*=UTF-8''demo-weekly-2026-11-23.md"), '同时给 RFC 5987 文件名')
  assert.match(await response.text(), /^# demo 项目周报/)
  assert.deepEqual(calls.report, [[PROJECT, { days: 7 }]])
  assert.equal(calls.detail.length, 0, '周报不重复走 /panel')
})

test('GET /report：days=14 生效，缺省 days 默认 7', async () => {
  const { deps, calls } = makeDeps()
  const routes = createRoutes(deps)
  const fortnight = await routes.handle(get(`${BASE}/report?path=${encodeURIComponent(PROJECT)}&days=14`))
  assert.equal(fortnight.status, 200)
  assert.match(await fortnight.text(), /days: 14/)
  const defaulted = await routes.handle(get(`${BASE}/report?path=${encodeURIComponent(PROJECT)}`))
  assert.equal(defaulted.status, 200)
  assert.match(await defaulted.text(), /days: 7/)
  assert.deepEqual(calls.report, [
    [PROJECT, { days: 14 }],
    [PROJECT, {}],
  ])
})

test('GET /report：days=3 直接 400，不读盘', async () => {
  const { deps, calls } = makeDeps()
  const routes = createRoutes(deps)
  const response = await routes.handle(get(`${BASE}/report?path=${encodeURIComponent(PROJECT)}&days=3`))
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { ok: false, error: 'bad-days' })
  // 非整数 / 带尾巴 / 进制写法的 days 也不做"猜一个数字"。
  for (const bad of ['7abc', '7.5', '-7', 'foo', '0x7', '0b111', ' 7 天']) {
    const denied = await routes.handle(get(`${BASE}/report?path=${encodeURIComponent(PROJECT)}&days=${bad}`))
    assert.equal(denied.status, 400, `days=${bad} 必须是 400`)
    assert.deepEqual(await denied.json(), { ok: false, error: 'bad-days' })
  }
  assert.equal(calls.report.length, 0, '参数不合法时不能读盘')
})

test('GET /report：未登记 403、缺 path 400，且都不调用 readReport', async () => {
  const { deps, calls } = makeDeps()
  const routes = createRoutes(deps)
  const denied = await routes.handle(get(`${BASE}/report?path=${encodeURIComponent(OTHER)}&days=7`))
  assert.equal(denied.status, 403)
  assert.deepEqual(await denied.json(), { ok: false, error: 'workspace-not-allowed' })
  const missing = await routes.handle(get(`${BASE}/report?days=7`))
  assert.equal(missing.status, 400)
  assert.deepEqual(await missing.json(), { ok: false, error: 'missing-path' })
  assert.equal(calls.report.length, 0)
})

test('GET /report：中文项目名用 RFC 5987 编码，header 本身保持 ASCII', async () => {
  const { deps } = makeDeps({
    readReport: async () => ({ markdown: '# 客户管理 项目周报\n', filename: '客户管理-weekly-2026-11-23.md' }),
  })
  const response = await createRoutes(deps).handle(get(`${BASE}/report?path=${encodeURIComponent(PROJECT)}`))
  assert.equal(response.status, 200)
  const disposition = response.headers.get('content-disposition')
  assert.ok(
    disposition.includes("filename*=UTF-8''%E5%AE%A2%E6%88%B7%E7%AE%A1%E7%90%86-weekly-2026-11-23.md"),
    `中文文件名要按 RFC 5987 编码：${disposition}`,
  )
  assert.match(disposition, /filename="[^"]*weekly-2026-11-23\.md"/, '同时留纯 ASCII 回退名')
})

test('GET /report：读失败转 500 JSON，不是连接中断', async () => {
  const { deps } = makeDeps({
    readReport: async () => {
      throw new Error('boom')
    },
  })
  const response = await createRoutes(deps).handle(get(`${BASE}/report?path=${encodeURIComponent(PROJECT)}`))
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { ok: false, error: 'boom' })
})

test('GET /panel 的 /workspaces 失败要转成 500 JSON，不是抛给载体', async () => {
  const { deps } = makeDeps({
    readOverview: async () => {
      throw new Error('boom')
    },
  })
  const response = await createRoutes(deps).handle(get(`${BASE}/workspaces`))
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { ok: false, error: 'boom' })
})

test('GET /init-plan 走同一道授权', async () => {
  const { deps, calls } = makeDeps()
  const routes = createRoutes(deps)
  const denied = await routes.handle(get(`${BASE}/init-plan?path=${encodeURIComponent(OTHER)}`))
  assert.equal(denied.status, 403)
  const allowed = await routes.handle(get(`${BASE}/init-plan?path=${encodeURIComponent(PROJECT)}`))
  assert.equal(allowed.status, 200)
  const body = await allowed.json()
  assert.equal(body.plan.dryRun, true)
  assert.deepEqual(calls.plan, [PROJECT])
})

test('resource 路由拒绝非 GET/HEAD 并给 Allow 头', async () => {
  const { deps } = makeDeps()
  const response = await createRoutes(deps).handle(get(`${BASE}/workspaces`, 'POST'))
  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'GET, HEAD')
  assert.deepEqual(await response.json(), { ok: false, error: 'method-not-allowed' })
})

test('未知路由 404', async () => {
  const { deps } = makeDeps()
  const routes = createRoutes(deps)
  assert.equal((await routes.handle(get(`${BASE}/nope`))).status, 404)
  assert.equal((await routes.handle(get('/other/api/workspaces'))).status, 404)
})

function fakeRes() {
  const res = {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
    },
    end(body) {
      res.body = body ?? ''
    },
  }
  return res
}

function fakeReq({ method = 'POST', body = {}, contentType = 'application/json', origin, host = '127.0.0.1:3080', rawBody } = {}) {
  const text = rawBody ?? JSON.stringify(body)
  const req = Readable.from([Buffer.from(text, 'utf8')])
  req.method = method
  req.url = `${BASE}/init`
  req.headers = { host }
  if (contentType !== null) req.headers['content-type'] = contentType
  if (origin !== undefined) req.headers.origin = origin
  return req
}

test('POST /init 必须显式 confirm:true', async () => {
  const { deps } = makeDeps()
  const handler = createInitHandler(deps)
  const res = fakeRes()
  await handler(fakeReq({ body: { path: PROJECT } }), res)
  assert.equal(res.status, 400)
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'confirm-required' })
})

test('POST /init 只接 JSON', async () => {
  const { deps } = makeDeps()
  const res = fakeRes()
  await createInitHandler(deps)(fakeReq({ body: { path: PROJECT, confirm: true }, contentType: 'text/plain' }), res)
  assert.equal(res.status, 415)
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'json-required' })
})

test('POST /init 跨源拒绝（挡 CSRF）', async () => {
  const { deps } = makeDeps()
  const res = fakeRes()
  await createInitHandler(deps)(fakeReq({ body: { path: PROJECT, confirm: true }, origin: 'http://evil.example' }), res)
  assert.equal(res.status, 403)
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'origin-not-allowed' })
})

test('POST /init 同源 Origin 放行', async () => {
  const { deps } = makeDeps()
  const res = fakeRes()
  await createInitHandler(deps)(fakeReq({ body: { path: PROJECT, confirm: true }, origin: 'http://127.0.0.1:3080' }), res)
  assert.equal(res.status, 200)
})

test('POST /init 坏 JSON 给 400，不是 500', async () => {
  const { deps } = makeDeps()
  const res = fakeRes()
  await createInitHandler(deps)(fakeReq({ rawBody: '{oops' }), res)
  assert.equal(res.status, 400)
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'bad-json' })
})

test('POST /init 超大 body 给 413', async () => {
  const { deps } = makeDeps()
  const res = fakeRes()
  const huge = JSON.stringify({ path: PROJECT, confirm: true, pad: 'x'.repeat(70 * 1024) })
  await createInitHandler(deps)(fakeReq({ rawBody: huge }), res)
  assert.equal(res.status, 413)
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'bad-json' })
})

test('POST /init 未登记工作区 403，且不写盘', async () => {
  const { deps, calls } = makeDeps()
  const res = fakeRes()
  await createInitHandler(deps)(fakeReq({ body: { path: OTHER, confirm: true } }), res)
  assert.equal(res.status, 403)
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'workspace-not-allowed' })
  assert.equal(calls.apply.length, 0)
})

test('POST /init 成功返回 applied/created/skipped/gitignoreHint', async () => {
  const { deps, calls } = makeDeps()
  const res = fakeRes()
  await createInitHandler(deps)(fakeReq({ body: { path: PROJECT, confirm: true } }), res)
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    applied: true,
    created: ['RULES.md'],
    skipped: [],
    errors: [],
    gitignoreHint: '.dsh/plugin-state/',
  })
  assert.deepEqual(calls.apply, [PROJECT])
})

test('POST /init 用 GET 打过来给 405', async () => {
  const { deps } = makeDeps()
  const res = fakeRes()
  await createInitHandler(deps)(fakeReq({ method: 'GET' }), res)
  assert.equal(res.status, 405)
})

test('POST /approve-prototype 缺 iteration_id 给 400', async () => {
  const { deps, calls } = makeDeps()
  const res = fakeRes()
  await createApproveHandler(deps)(fakeReq({ body: { path: PROJECT } }), res)
  assert.equal(res.status, 400)
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'iteration-required' })
  assert.equal(calls.approve.length, 1)
})

test('POST /approve-prototype 找不到原型给 409（没有依据的批准不放行）', async () => {
  const { deps } = makeDeps()
  const res = fakeRes()
  await createApproveHandler(deps)(fakeReq({ body: { path: PROJECT, iteration_id: 'v9.9' } }), res)
  assert.equal(res.status, 409)
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'prototype-missing' })
})

test('POST /approve-prototype 未登记工作区 403，且不写批准', async () => {
  const { deps, calls } = makeDeps()
  const res = fakeRes()
  await createApproveHandler(deps)(fakeReq({ body: { path: OTHER, iteration_id: 'v1.0' } }), res)
  assert.equal(res.status, 403)
  assert.equal(calls.approve.length, 0)
})

test('POST /approve-prototype 成功返回按迭代的批准记录', async () => {
  const { deps, calls } = makeDeps()
  const res = fakeRes()
  await createApproveHandler(deps)(fakeReq({ body: { path: PROJECT, iteration_id: 'v1.0' } }), res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.approval.iterationId, 'v1.0')
  assert.equal(body.approval.prototype, 'prototype.html')
  assert.deepEqual(calls.approve, [[PROJECT, 'v1.0']])
})

test('POST /approve-prototype 用 GET 打过来给 405', async () => {
  const { deps } = makeDeps()
  const res = fakeRes()
  await createApproveHandler(deps)(fakeReq({ method: 'GET' }), res)
  assert.equal(res.status, 405)
})

// ---------- P1 决策门：POST /approve ----------

test('POST /approve：成功返回 gate/at/iteration_id，授权路径交给 approveDecision', async () => {
  const { deps, calls } = makeDeps()
  const res = fakeRes()
  await createDecisionHandler(deps)(fakeReq({ body: { path: PROJECT, iteration_id: 'v1.0', gate: 'scope' } }), res)
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    gate: 'scope',
    at: '2026-01-01T00:00:00.000Z',
    iteration_id: 'v1.0',
  })
  assert.deepEqual(calls.decision, [[PROJECT, 'v1.0', 'scope']])
})

test('POST /approve：bad-gate / bad-iteration 是 400（先区分"参数错"与"前置不满足"）', async () => {
  const { deps, calls } = makeDeps()
  const cases = [
    [{ path: PROJECT, iteration_id: 'v1.0', gate: 'nope' }, 'bad-gate'],
    [{ path: PROJECT, iteration_id: '', gate: 'scope' }, 'bad-iteration'],
    [{ path: PROJECT, iteration_id: 'bootstrap', gate: 'scope' }, 'bad-iteration'],
  ]
  for (const [payload, expected] of cases) {
    const res = fakeRes()
    await createDecisionHandler(deps)(fakeReq({ body: payload }), res)
    assert.equal(res.status, 400, `${expected} 应是 400`)
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: expected })
  }
  assert.equal(calls.decision.length, 3, '参数错也交给 approveDecision 判定（路由层不复制规则）')
})

test('POST /approve：前置不满足映射 409，并把 missing 带给面板', async () => {
  const { deps } = makeDeps()
  const cases = [
    ['v-prd', 'scope', 'prd-missing', undefined],
    ['v-arch', 'architecture', 'architecture-gate-not-ready', ['docs/api.md']],
    ['v-accept', 'acceptance', 'acceptance-not-passing', ['A1']],
    ['v-release', 'release', 'release-gate-not-ready', ['.dsh/plugin-state/release.json', 'acceptance']],
  ]
  for (const [iterationId, gate, expected, missing] of cases) {
    const res = fakeRes()
    await createDecisionHandler(deps)(fakeReq({ body: { path: PROJECT, iteration_id: iterationId, gate } }), res)
    assert.equal(res.status, 409, `${expected} 应是 409`)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, false)
    assert.equal(body.error, expected)
    if (missing) assert.deepEqual(body.missing, missing)
  }
})

test('POST /approve：prototype 分支兼容旧形状（映射成统一成功字段）且 prototype-missing 409', async () => {
  const { deps } = makeDeps()
  const ok = fakeRes()
  await createDecisionHandler(deps)(fakeReq({ body: { path: PROJECT, iteration_id: 'v1.0', gate: 'prototype' } }), ok)
  assert.equal(ok.status, 200)
  const body = JSON.parse(ok.body)
  assert.deepEqual(body, {
    ok: true,
    gate: 'prototype',
    at: '2026-01-01T00:00:00.000Z',
    iteration_id: 'v1.0',
  })
  assert.equal(body.approval, undefined, '响应只给契约里的四个字段')

  const missing = fakeRes()
  await createDecisionHandler(deps)(fakeReq({ body: { path: PROJECT, iteration_id: 'v9.9', gate: 'prototype' } }), missing)
  assert.equal(missing.status, 409)
  assert.deepEqual(JSON.parse(missing.body), { ok: false, error: 'prototype-missing' })
})

test('POST /approve：未登记工作区 403 且不写签核；跨源 403；GET 405', async () => {
  const { deps, calls } = makeDeps()
  const denied = fakeRes()
  await createDecisionHandler(deps)(fakeReq({ body: { path: OTHER, iteration_id: 'v1.0', gate: 'scope' } }), denied)
  assert.equal(denied.status, 403)
  assert.deepEqual(JSON.parse(denied.body), { ok: false, error: 'workspace-not-allowed' })
  assert.equal(calls.decision.length, 0, '未授权时不写签核记录')

  const cross = fakeRes()
  await createDecisionHandler(deps)(
    fakeReq({ body: { path: PROJECT, iteration_id: 'v1.0', gate: 'scope' }, origin: 'http://evil.example' }),
    cross,
  )
  assert.equal(cross.status, 403)
  assert.equal(JSON.parse(cross.body).error, 'origin-not-allowed')

  const get = fakeRes()
  await createDecisionHandler(deps)(fakeReq({ method: 'GET' }), get)
  assert.equal(get.status, 405)
})

test('POST /approve-prototype 仍可用（向后兼容，不受新接口影响）', async () => {
  const { deps, calls } = makeDeps()
  const res = fakeRes()
  await createApproveHandler(deps)(fakeReq({ body: { path: PROJECT, iteration_id: 'v1.0' } }), res)
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).approval.prototype, 'prototype.html')
  assert.deepEqual(calls.approve, [[PROJECT, 'v1.0']])
})

test('POST /acceptance-result：通过必须带证据，缺证据 400 且不落盘', async () => {
  const { deps, calls } = makeDeps()
  const res = fakeRes()
  await createAcceptanceResultHandler(deps)(
    fakeReq({ body: { path: PROJECT, item_id: 'A1', result: 'pass' } }),
    res,
  )
  assert.equal(res.status, 400)
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'evidence-required', detail: null, iterationId: null })
  assert.equal(calls.acceptance.length, 1, '参数校验交给 setAcceptanceResult，路由层只做授权与状态码')
})

test('POST /acceptance-result：证据文件不存在 409，并回传是哪一张', async () => {
  const { deps } = makeDeps()
  const res = fakeRes()
  await createAcceptanceResultHandler(deps)(
    fakeReq({ body: { path: PROJECT, item_id: 'A1', result: 'pass', evidence: ['missing.png'] } }),
    res,
  )
  assert.equal(res.status, 409)
  const body = JSON.parse(res.body)
  assert.equal(body.error, 'evidence-not-found')
  assert.equal(body.detail, 'missing.png')
})

test('POST /acceptance-result：条目不存在 404，未授权工作区 403 且不写', async () => {
  const { deps, calls } = makeDeps()
  const notFound = fakeRes()
  await createAcceptanceResultHandler(deps)(fakeReq({ body: { path: PROJECT, item_id: 'A9', result: 'fail' } }), notFound)
  assert.equal(notFound.status, 404)

  const denied = fakeRes()
  await createAcceptanceResultHandler(deps)(fakeReq({ body: { path: OTHER, item_id: 'A1', result: 'fail' } }), denied)
  assert.equal(denied.status, 403)
  assert.equal(calls.acceptance.length, 1)
})

test('POST /acceptance-result：成功返回条目；撤销 result:null 也走同一接口', async () => {
  const { deps, calls } = makeDeps()
  const passed = fakeRes()
  await createAcceptanceResultHandler(deps)(
    fakeReq({ body: { path: PROJECT, item_id: 'A1', result: 'pass', evidence: ['shots/a1.png'] } }),
    passed,
  )
  assert.equal(passed.status, 200)
  const body = JSON.parse(passed.body)
  assert.equal(body.ok, true)
  assert.equal(body.item.result, 'pass')

  const cleared = fakeRes()
  await createAcceptanceResultHandler(deps)(fakeReq({ body: { path: PROJECT, item_id: 'A1', result: null } }), cleared)
  assert.equal(cleared.status, 200)
  assert.equal(JSON.parse(cleared.body).item.result, null)

  assert.equal(calls.acceptance.length, 2)
})

test('POST /acceptance-result：漏传 result 400 bad-result（≠ 撤销），不写盘', async () => {
  const { deps, calls } = makeDeps()
  const res = fakeRes()
  await createAcceptanceResultHandler(deps)(fakeReq({ body: { path: PROJECT, item_id: 'A1' } }), res)
  assert.equal(res.status, 400)
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'bad-result', detail: null, iterationId: null })
  assert.equal(calls.acceptance.length, 1)
})

test('POST /acceptance-result：迭代不匹配 / 坏表 / 无迭代都映射到 409', async () => {
  const { deps } = makeDeps()
  for (const [itemId, expectedError] of [
    ['A-MISMATCH', 'iteration-mismatch'],
    ['A-BROKEN', 'acceptance-broken'],
    ['A-NOITER', 'iteration-required'],
  ]) {
    const res = fakeRes()
    await createAcceptanceResultHandler(deps)(fakeReq({ body: { path: PROJECT, item_id: itemId, result: 'fail' } }), res)
    assert.equal(res.status, 409, `${expectedError} 应是 409`)
    assert.equal(JSON.parse(res.body).error, expectedError)
  }
})

test('POST /acceptance-result：GET 打过来给 405', async () => {
  const { deps } = makeDeps()
  const res = fakeRes()
  await createAcceptanceResultHandler(deps)(fakeReq({ method: 'GET' }), res)
  assert.equal(res.status, 405)
})

test('GET /shot：只回图片；非图片 415、过大 413、缺失 404、未授权 403', async () => {
  const { deps, calls } = makeDeps()
  const routes = createRoutes(deps)
  const shotUrl = (path, file) => `${BASE}/shot?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}`

  const ok = await routes.handle(get(shotUrl(PROJECT, '.dsh/plugin-state/shots/a1.png')))
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type'), 'image/png')
  assert.equal(ok.headers.get('cache-control'), 'no-store')
  assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47])

  assert.equal((await routes.handle(get(shotUrl(PROJECT, 'notes.txt')))).status, 415)
  assert.equal((await routes.handle(get(shotUrl(PROJECT, 'huge.png')))).status, 413)
  assert.equal((await routes.handle(get(shotUrl(PROJECT, 'gone.png')))).status, 404)
  assert.equal((await routes.handle(get(shotUrl(OTHER, 'a.png')))).status, 403)
  assert.equal(calls.shot.length, 4, '未授权时不读文件')
})

test('POST /acceptance-screenshot：成功返回条目与截图；错误码映射', async () => {
  const { deps, calls } = makeDeps()
  const handler = createAcceptanceScreenshotHandler(deps)

  const ok = fakeRes()
  await handler(
    fakeReq({ body: { path: PROJECT, item_id: 'A1', url: 'http://127.0.0.1:3000' } }),
    ok,
  )
  assert.equal(ok.status, 200)
  const body = JSON.parse(ok.body)
  assert.equal(body.ok, true)
  assert.equal(body.shot.file, '.dsh/plugin-state/shots/A1-x.png')
  assert.equal(body.added, 1)

  const cases = [
    [{ path: PROJECT, item_id: 'A9', url: 'http://127.0.0.1:3000' }, 404, 'item-not-found'],
    [{ path: PROJECT, item_id: 'A-NOURL' }, 400, 'no-url'],
    [{ path: PROJECT, item_id: 'A1', url: 'http://example.com' }, 400, 'url-not-loopback'],
    [{ path: PROJECT, item_id: 'A1', url: 'http://127.0.0.1:9/slow' }, 504, 'timeout'],
    [{ path: PROJECT, item_id: 'A1', url: 'http://127.0.0.1:9/abort' }, 499, 'aborted'],
  ]
  for (const [payload, status, error] of cases) {
    const res = fakeRes()
    await handler(fakeReq({ body: payload }), res)
    assert.equal(res.status, status, `${error} 的状态码`)
    assert.equal(JSON.parse(res.body).error, error)
  }

  const denied = fakeRes()
  await handler(fakeReq({ body: { path: OTHER, item_id: 'A1' } }), denied)
  assert.equal(denied.status, 403)
  assert.equal(calls.screenshot.length, 6, '未授权时不触发截图')
  assert.ok(calls.screenshot[0][1].signal, '截图必须能收到中断信号（客户端断开时提前收手）')
})

test('POST /acceptance-screenshot：GET 打过来给 405', async () => {
  const { deps } = makeDeps()
  const res = fakeRes()
  await createAcceptanceScreenshotHandler(deps)(fakeReq({ method: 'GET' }), res)
  assert.equal(res.status, 405)
})

