import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createAcceptanceResultHandler,
  createAcceptanceScreenshotHandler,
  createApproveHandler,
  createInitHandler,
  createRoutes,
  BASE,
} from '../lib/route.js'

const PROJECT = resolve(tmpdir(), 'delivery-cockpit-route-fixture')
const OTHER = resolve(tmpdir(), 'delivery-cockpit-not-registered')

function makeDeps(overrides = {}) {
  const calls = { detail: [], plan: [], apply: [], approve: [], acceptance: [], shot: [], screenshot: [] }
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

