import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createApproveHandler, createInitHandler, createRoutes, BASE } from '../lib/route.js'

const PROJECT = resolve(tmpdir(), 'delivery-cockpit-route-fixture')
const OTHER = resolve(tmpdir(), 'delivery-cockpit-not-registered')

function makeDeps(overrides = {}) {
  const calls = { detail: [], plan: [], apply: [], approve: [] }
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

