/**
 * HTTP 层：只做路由、授权、参数与错误码。
 *
 * 为什么不碰盘：所有业务都在注入的 deps 里，路由层保持可测（用假 deps 就能跑全部用例），
 * 也保证"我没授权就不读盘"这件事只有一处实现。
 *
 * 授权口径（唯一）：`path` 必须能被 `resolveWorkspace` 认出来 —— 也就是 DSH 自己登记过的工作区。
 * 面板是 root scope，客户端拿不到会话身份，只能从已登记工作区里选；这同时挡住了
 * "本机任意进程让面板去读/写任意目录"。
 *
 * 读接口走 resource 路由（DSH 只放行 GET/HEAD），写接口走 handler 路由（能拿到原始 req/res），
 * 两者共用同一道授权，写接口再加 content-type + 同源检查。
 */
import { isAbsolute, resolve } from 'node:path'

import { REPORT_DAYS } from './report.js'

export const BASE = '/delivery-cockpit/api'

const MAX_BODY_BYTES = 64 * 1024
const REPORT_DAYS_SET = new Set(REPORT_DAYS)

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function failure(error, status) {
  return json({ ok: false, error }, status)
}

/** 纯 ASCII 回退文件名：HTTP 头值必须是 ByteString，中文不能直接进 header。 */
function asciiFilename(filename) {
  const stripped = filename
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/^[-_.\s]+/, '')
    .trim()
  if (stripped === '' || stripped === '.md') return 'report.md'
  return stripped.toLowerCase().endsWith('.md') ? stripped : `${stripped}.md`
}

/**
 * `Content-Disposition`：附件名可能是中文（项目名），而 HTTP 头只能带 ByteString。
 * 按 RFC 5987 同时给两份：
 * - `filename*=UTF-8''<percent-encoded>`：现代浏览器据此落成中文文件名；
 * - `filename="<ascii>"`：老客户端至少拿到一个合法名字。
 * 纯 ASCII 项目名时两份一致（`filename="demo-weekly-YYYY-MM-DD.md"`）。
 */
function contentDisposition(filename) {
  const safe = String(filename ?? '').replace(/[\r\n"]/g, '').trim() || 'report.md'
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${asciiFilename(safe)}"; filename*=UTF-8''${encoded}`
}

/**
 * 授权：只认已登记工作区的绝对路径。
 * 返回 `{ path }`（已 resolve）或 `{ error }`。
 */
async function authorize(deps, rawPath) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') return { error: 'missing-path', status: 400 }
  const requested = rawPath.trim()
  // 相对路径不接受：root scope 没有"当前目录"这回事，相对路径只会变成猜测。
  if (!isAbsolute(requested)) return { error: 'path-not-absolute', status: 400 }
  const resolved = resolve(requested)
  let workspace
  try {
    workspace = await deps.resolveWorkspace(resolved)
  } catch {
    // 工作区服务对不存在路径可能抛 ENOENT（Windows realpath）：那是"未登记"，不是服务端故障。
    workspace = null
  }
  if (!workspace || typeof workspace.path !== 'string' || workspace.path === '') {
    return { error: 'workspace-not-allowed', status: 403 }
  }
  return { path: resolve(workspace.path) }
}

export function createRoutes(deps) {
  return {
    async handle(request) {
      let url
      try {
        url = new URL(request.url, 'http://127.0.0.1')
      } catch {
        return failure('bad-request', 400)
      }
      if (!url.pathname.startsWith(`${BASE}/`)) return new Response('not found', { status: 404 })
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const response = failure('method-not-allowed', 405)
        response.headers.set('allow', 'GET, HEAD')
        return response
      }
      try {
        const route = url.pathname.slice(BASE.length)
        if (route === '/workspaces') {
          const overview = await deps.readOverview()
          return json({
            ok: true,
            projects: Array.isArray(overview?.projects) ? overview.projects : [],
            generatedAt: overview?.generatedAt ?? new Date().toISOString(),
          })
        }
        if (route === '/panel') {
          const auth = await authorize(deps, url.searchParams.get('path'))
          if (auth.error) return failure(auth.error, auth.status)
          const panel = await deps.readDetail(auth.path)
          return json({ ok: true, panel })
        }
        if (route === '/report') {
          // 周报与 /panel 走同一道读授权；days 只接受 7/14/30（缺省 7），其它一律 400。
          const auth = await authorize(deps, url.searchParams.get('path'))
          if (auth.error) return failure(auth.error, auth.status)
          const rawDays = url.searchParams.get('days')
          // 缺省不在这里拍一个数：交给 deps.readReport 按配置 reportDays（默认 7）决定，
          // 否则配置覆盖就成了摆设。显式给了就必须是 7/14/30，其它一律 400。
          let days
          if (rawDays !== null && String(rawDays).trim() !== '') {
            // 只认十进制字面量：'7abc' / '7.5' / '0x7' 都不做"猜一个数字"。
            const text = String(rawDays).trim()
            if (!/^\d+$/.test(text)) return failure('bad-days', 400)
            const parsed = Number(text)
            if (!Number.isInteger(parsed) || !REPORT_DAYS_SET.has(parsed)) return failure('bad-days', 400)
            days = parsed
          }
          const report = await deps.readReport(auth.path, days === undefined ? {} : { days })
          const markdown = typeof report?.markdown === 'string' ? report.markdown : null
          if (markdown === null) return failure('report-unavailable', 500)
          return new Response(markdown, {
            status: 200,
            headers: {
              'content-type': 'text/markdown; charset=utf-8',
              'cache-control': 'no-store',
              'content-disposition': contentDisposition(report?.filename),
            },
          })
        }
        if (route === '/init-plan') {
          const auth = await authorize(deps, url.searchParams.get('path'))
          if (auth.error) return failure(auth.error, auth.status)
          const plan = await deps.planInit(auth.path)
          return json({ ok: true, plan })
        }
        if (route === '/shot') {
          // 证据图片：只读、只允许项目内的图片文件，避免变成任意文件下载器。
          const auth = await authorize(deps, url.searchParams.get('path'))
          if (auth.error) return failure(auth.error, auth.status)
          const shot = await deps.readShot(auth.path, url.searchParams.get('file'))
          if (!shot?.ok) {
            const status = shot?.error === 'file-too-large' ? 413 : shot?.error === 'not-image' ? 415 : 404
            return failure(shot?.error ?? 'shot-not-found', status)
          }
          return new Response(shot.bytes, {
            status: 200,
            headers: {
              'content-type': shot.contentType,
              'cache-control': 'no-store',
              'content-length': String(shot.bytes.length),
            },
          })
        }
        return new Response('not found', { status: 404 })
      } catch (error) {
        // 载体不能让异常冒出去变成连接中断：统一转成一个能读懂的 500。
        return failure(String(error?.message ?? error), 500)
      }
    },
  }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('payload-too-large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 同源检查：浏览器发 POST 时必带 Origin；带了就必须与 Host 一致（挡 CSRF）。 */
function sameOrigin(req) {
  const origin = req.headers?.origin
  if (typeof origin !== 'string' || origin === '') return true
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function jsonContentType(req) {
  const type = req.headers?.['content-type']
  return typeof type === 'string' && type.toLowerCase().startsWith('application/json')
}

/**
 * 写接口的公共闸门：方法、同源、JSON、body 解析。
 * 这几道必须放在一起，否则每新增一个写接口都是一次漏掉某一道的机会。
 * 返回解析后的 body；已经发过响应时返回 null。
 */
async function readWriteRequest(req, res) {
  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'method-not-allowed' })
    return null
  }
  if (!sameOrigin(req)) {
    send(res, 403, { ok: false, error: 'origin-not-allowed' })
    return null
  }
  if (!jsonContentType(req)) {
    send(res, 415, { ok: false, error: 'json-required' })
    return null
  }
  let payload
  try {
    const text = await readBody(req)
    payload = text.trim() === '' ? {} : JSON.parse(text)
  } catch (error) {
    const status = String(error?.message ?? error) === 'payload-too-large' ? 413 : 400
    send(res, status, { ok: false, error: 'bad-json' })
    return null
  }
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
}

function createJsonHandler(run) {
  return async function handler(req, res) {
    try {
      const body = await readWriteRequest(req, res)
      if (body === null) return
      await run(body, res)
    } catch (error) {
      // handler 抛错会变成连接中断；转成能读懂的 500。客户端可能已经断开，发送失败也不能再抛。
      try {
        send(res, 500, { ok: false, error: String(error?.message ?? error) })
      } catch {
        // 连接已断
      }
    }
  }
}

/**
 * `POST /delivery-cockpit/api/init`，body `{ path, confirm: true }`。
 * 默认拒绝（confirm 必须显式 true），避免误触把文件写进项目。
 */
export function createInitHandler(deps) {
  return createJsonHandler(async (body, res) => {
    if (body.confirm !== true) {
      send(res, 400, { ok: false, error: 'confirm-required' })
      return
    }
    const auth = await authorize(deps, body.path)
    if (auth.error) {
      send(res, auth.status, { ok: false, error: auth.error })
      return
    }
    const result = await deps.applyInit(auth.path)
    send(res, 200, {
      ok: true,
      applied: result?.applied === true,
      created: Array.isArray(result?.created) ? result.created : [],
      skipped: Array.isArray(result?.skipped) ? result.skipped : [],
      errors: Array.isArray(result?.errors) ? result.errors : [],
      gitignoreHint: result?.gitignoreHint ?? '',
    })
  })
}

/**
 * `POST /delivery-cockpit/api/workflow`，body `{ path, workflow: 'full'|'light' }`。
 * 只改项目名片的 workflow 字段；轻量模式会跳过架构契约与范围/架构签核。
 */
const WORKFLOW_STATUS = {
  'bad-workflow': 400,
  'project-card-missing': 409,
  'project-card-broken': 409,
}

export function createWorkflowHandler(deps) {
  return createJsonHandler(async (body, res) => {
    const auth = await authorize(deps, body.path)
    if (auth.error) {
      send(res, auth.status, { ok: false, error: auth.error })
      return
    }
    const result = await deps.setWorkflow(auth.path, body.workflow)
    if (!result?.ok) {
      const code = result?.error ?? 'workflow-failed'
      send(res, WORKFLOW_STATUS[code] ?? 400, { ok: false, error: code })
      return
    }
    send(res, 200, { ok: true, workflow: result.workflow, updatedAt: result.updatedAt ?? null })
  })
}

/**
 * `POST /delivery-cockpit/api/trellis-init`，body `{ path }`。
 * 显式把空 .trellis 升级成完整 Trellis 工程；缺 CLI/subprocess 时返回 skipped 而不是报错。
 */
export function createTrellisHandler(deps) {
  return createJsonHandler(async (body, res) => {
    const auth = await authorize(deps, body.path)
    if (auth.error) {
      send(res, auth.status, { ok: false, error: auth.error })
      return
    }
    const result = await deps.initializeTrellis(auth.path)
    const status = String(result?.status ?? 'failed')
    if (status === 'failed') {
      send(res, 409, { ok: false, error: 'trellis-init-failed', detail: result?.reason ?? null, exitCode: result?.exitCode ?? null })
      return
    }
    send(res, 200, {
      ok: true,
      status,
      reason: result?.reason ?? null,
      exitCode: result?.exitCode ?? null,
    })
  })
}

/**
 * `POST /delivery-cockpit/api/review-settings`，body `{ path, agent, model, agyProxy }`。
 * 项目级评审器切换：Claude Code / Gemini(Antigravity agy)；只写项目状态，不影响其他项目。
 */
export function createReviewSettingsHandler(deps) {
  return createJsonHandler(async (body, res) => {
    const auth = await authorize(deps, body.path)
    if (auth.error) {
      send(res, auth.status, { ok: false, error: auth.error })
      return
    }
    const patch = {}
    if (Object.prototype.hasOwnProperty.call(body, 'agent')) patch.agent = body.agent
    if (Object.prototype.hasOwnProperty.call(body, 'model')) patch.model = body.model
    if (Object.prototype.hasOwnProperty.call(body, 'agyProxy')) patch.agyProxy = body.agyProxy
    const result = await deps.writeReviewProfile(auth.path, patch)
    if (!result?.ok) {
      const code = result?.error ?? 'review-settings-failed'
      const status = ['bad-agent', 'bad-proxy', 'bad-profile', 'project-required'].includes(code) ? 400 : 500
      send(res, status, { ok: false, error: code })
      return
    }
    send(res, 200, {
      ok: true,
      agent: result.agent,
      model: result.model,
      agyProxy: result.agyProxy,
    })
  })
}

/**
 * `POST /delivery-cockpit/api/acceptance-result`，body `{ path, item_id, result, evidence? }`。
 * 这是人在面板上填验收结果的动作：result=null 表示撤销；pass 必须有证据（Host 会校验文件真实存在）。
 */
const ACCEPTANCE_RESULT_STATUS = {
  'item-required': 400,
  'bad-result': 400,
  'bad-evidence': 400,
  'evidence-required': 400,
  'item-not-found': 404,
  'evidence-not-found': 409,
  'acceptance-broken': 409,
  'iteration-mismatch': 409,
  'iteration-required': 409,
}

export function createAcceptanceResultHandler(deps) {
  return createJsonHandler(async (body, res) => {
    const auth = await authorize(deps, body.path)
    if (auth.error) {
      send(res, auth.status, { ok: false, error: auth.error })
      return
    }
    // 只透传"客户端真的给了"的字段：`result: undefined` 与"没给 result"必须可区分，
    // 否则漏字段会被下游当成"撤销"，静默清空人已经填好的结果。
    const payload = { item_id: body.item_id }
    if (Object.prototype.hasOwnProperty.call(body, 'result')) payload.result = body.result
    if (Object.prototype.hasOwnProperty.call(body, 'evidence')) payload.evidence = body.evidence
    const result = await deps.setAcceptanceResult(auth.path, payload)
    if (!result?.ok) {
      const code = result?.error ?? 'acceptance-result-failed'
      send(res, ACCEPTANCE_RESULT_STATUS[code] ?? 400, {
        ok: false,
        error: code,
        detail: result?.detail ?? null,
        iterationId: result?.iterationId ?? null,
      })
      return
    }
    send(res, 200, { ok: true, item: result.item })
  })
}

const SCREENSHOT_STATUS = {
  'item-required': 400,
  'no-url': 400,
  'invalid-url': 400,
  'url-not-loopback': 400,
  'bad-evidence': 400,
  'evidence-required': 400,
  'item-not-found': 404,
  'browser-not-found': 409,
  'evidence-not-found': 409,
  'bad-evidence': 400,
  'acceptance-broken': 409,
  'iteration-mismatch': 409,
  'iteration-required': 409,
  timeout: 504,
  aborted: 499,
  'browser-failed': 502,
  'capture-failed': 502,
}

/**
 * `POST /delivery-cockpit/api/acceptance-screenshot`，body `{ path, item_id, url? }`。
 * 用本机浏览器截一张真实页面，存进 `.dsh/plugin-state/shots/` 并挂到该条验收的证据上。
 * 注意：截图只挂证据，**不改变验收结果**——截了图不等于验过了，通过仍要人点。
 *
 * 客户端中途断开（换页/超时）要能中断截图：否则"客户端报超时、服务端其实已写盘挂证据"，
 * 用户一重试就多出一张重复截图。
 */
export function createAcceptanceScreenshotHandler(deps) {
  return createJsonHandler(async (body, res) => {
    const auth = await authorize(deps, body.path)
    if (auth.error) {
      send(res, auth.status, { ok: false, error: auth.error })
      return
    }
    const controller = new AbortController()
    try {
      res.once('close', () => controller.abort())
    } catch {
      // 拿不到 close 事件就退化为不中断
    }
    const result = await deps.takeAcceptanceScreenshot(auth.path, {
      item_id: body.item_id,
      url: body.url,
      signal: controller.signal,
    })
    if (!result?.ok) {
      const code = result?.error ?? 'capture-failed'
      try {
        send(res, SCREENSHOT_STATUS[code] ?? 500, {
          ok: false,
          error: code,
          detail: result?.detail ?? null,
          iterationId: result?.iterationId ?? null,
        })
      } catch {
        // 客户端已断开，没人在等这个响应
      }
      return
    }
    try {
      send(res, 200, { ok: true, item: result.item, shot: result.shot ?? null, added: result.added ?? 0 })
    } catch {
      // 客户端已断开
    }
  })
}

/**
 * `POST /delivery-cockpit/api/approve`，body `{ path, iteration_id, gate }`。
 * 人工签核一个决策门（scope / architecture / prototype / acceptance / release）。
 * 与写接口同一道授权 + 同源 + JSON 检查；前置不满足是 409（"现在还不能签"），
 * 参数不对是 400 —— 两者要分开，否则界面没法告诉人是"刷新重试"还是"先去补东西"。
 */
const DECISION_STATUS = {
  'bad-gate': 400,
  'bad-iteration': 400,
  'iteration-required': 400,
  'prd-missing': 409,
  'architecture-gate-not-ready': 409,
  'acceptance-not-passing': 409,
  'release-gate-not-ready': 409,
  'prototype-missing': 409,
}

export function createDecisionHandler(deps) {
  return createJsonHandler(async (body, res) => {
    const auth = await authorize(deps, body.path)
    if (auth.error) {
      send(res, auth.status, { ok: false, error: auth.error })
      return
    }
    const iterationId = typeof body.iteration_id === 'string' ? body.iteration_id.trim() : ''
    const gate = typeof body.gate === 'string' ? body.gate.trim() : ''
    const result = await deps.approveDecision(auth.path, iterationId, gate)
    if (!result?.ok) {
      const code = result?.error ?? 'approve-failed'
      const payload = { ok: false, error: code }
      // 前置没满足时带上缺什么：面板可以据此说"先补哪一块"，而不是只显示一个错误码。
      if (Array.isArray(result?.missing) && result.missing.length > 0) payload.missing = result.missing
      send(res, DECISION_STATUS[code] ?? 400, payload)
      return
    }
    // prototype 分支复用 approvePrototype 的原返回形状：把它的 iterationId/时间投影成统一成功字段。
    // 响应只给契约里的四个字段，不额外塞 approval（旧调用方仍走 /approve-prototype）。
    if (result.approval) {
      send(res, 200, {
        ok: true,
        gate,
        at: result.approval.prototypeApprovedAt ?? null,
        iteration_id: result.approval.iterationId ?? iterationId,
      })
      return
    }
    send(res, 200, {
      ok: true,
      gate: result.gate ?? gate,
      at: result.at ?? null,
      iteration_id: result.iteration_id ?? iterationId,
    })
  })
}

/**
 * `POST /delivery-cockpit/api/approve-prototype`，body `{ path, iteration_id }`。
 * 批准必须落在具体迭代上；找不到原型 HTML 时拒绝（没有原型的批准等于没依据）。
 * 保留旧路由向后兼容（内部仍是 approvePrototype，新客户端走 /approve）。
 */
export function createApproveHandler(deps) {
  return createJsonHandler(async (body, res) => {
    const auth = await authorize(deps, body.path)
    if (auth.error) {
      send(res, auth.status, { ok: false, error: auth.error })
      return
    }
    const iterationId = typeof body.iteration_id === 'string' ? body.iteration_id.trim() : ''
    const result = await deps.approvePrototype(auth.path, iterationId)
    if (!result?.ok) {
      const status = result?.error === 'prototype-missing' ? 409 : 400
      send(res, status, { ok: false, error: result?.error ?? 'approve-failed' })
      return
    }
    send(res, 200, { ok: true, approval: result.approval })
  })
}

