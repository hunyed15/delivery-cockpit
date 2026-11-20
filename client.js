/**
 * 交付驾驶舱 — Client half（只读）。
 *
 * 面板只消费自己 Host 半的路由 `/delivery-cockpit/api/*`：总览与详情都由宿主算好再下发，
 * 这里不读磁盘、不猜状态、不碰别的插件 DOM。样式只引用 host 主题 token `--dsw-alias-*`，
 * 所有选择器以 `.dc-` 前缀隔离，避免污染宿主页面。
 *
 * 界面是两级：总览（工作区卡片）→ 详情（一屏四区，design §4）。
 * 记住上次项目（localStorage `delivery-cockpit:last-project`）是为了少点一次，不是缓存数据：
 * 每次进入详情都重新拉 `/panel`，读不到就降级显示，绝不拿旧数据冒充最新。
 */
window.__ModuleLoader__.load({
  id: '@hunyed15/delivery-cockpit',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // 左栏入口 id 与中央面板 key 必须严格同名，否则 selectPanel 会抛错。
    const PANEL_ID = 'delivery-cockpit'
    const API = '/delivery-cockpit/api'
    const LAST_PROJECT_KEY = 'delivery-cockpit:last-project'
    const POLL_MS = 8000
    const REQUEST_TIMEOUT_MS = 10000

    // ---------- 文案映射：契约里的英文枚举在界面上必须说人话 ----------

    const STAGE_TEXT = {
      init: '初始化',
      scaffold: '搭骨架',
      brainstorm: '想清楚',
      prototype: '看原型',
      coding: '写代码',
      code_review: '挑毛病',
      verification: '验效果',
      release: '发出去',
    }

    const STATUS_TEXT = {
      in_progress: '进行中',
      completed: '已完成',
      blocked: '被卡住',
      failed: '失败',
      dropped: '已放弃',
    }

    // 只有 blocked/failed 值得红，dropped 是「主动放弃」，不该被看成故障。
    const STATUS_TONE = {
      in_progress: 'brand',
      completed: 'ok',
      blocked: 'bad',
      failed: 'bad',
      dropped: 'unknown',
    }

    const PRESENCE_TEXT = {
      yes: { text: '可用', tone: 'ok' },
      no: { text: '缺失', tone: 'bad' },
      unknown: { text: '无法检测', tone: 'unknown' },
    }

    // 后端错误码对用户没有意义；翻成人话，原文留在 title 里供排查。
    const ERROR_TEXT = {
      'workspace-not-allowed': '这个工作区不在已登记列表里。在某个项目目录里打开会话后回到这里，或点重试。',
      'missing-path': '请求缺少项目路径，刷新后重试。',
      'confirm-required': '初始化必须显式确认，操作已取消。',
      'method-not-allowed': '请求方式不被支持。',
      'not found': '接口不存在，可能插件版本不匹配。',
    }

    function explainError(raw) {
      const message = String(raw == null ? '' : raw)
      for (const [code, text] of Object.entries(ERROR_TEXT)) {
        if (message.indexOf(code) >= 0) return text
      }
      if (/请求超时/.test(message)) return '请求超时，检查 DSH 是否还在运行。'
      if (/不是 JSON/.test(message)) return message
      if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return '连不上 DSH，确认它还在运行。'
      return message || '未知错误'
    }

    // 原型批准失败码也要翻成人话：用户要知道「我现在该做什么」，而不是看到 error code。
    const APPROVE_ERROR_TEXT = {
      'prototype-missing': '先把原型 HTML 放到项目根目录 prototype.html，再点通过。',
      'iteration-required': '当前迭代还没确定，先让 Agent 上报一次回执。',
      'workspace-not-allowed': '这个工作区不在已登记列表里，无法写入批准标记。',
    }

    function explainApproveError(raw) {
      const message = String(raw == null ? '' : raw)
      for (const [code, text] of Object.entries(APPROVE_ERROR_TEXT)) {
        if (message.indexOf(code) >= 0) return text
      }
      return explainError(message)
    }

    const messageOf = (failure) =>
      String(failure && failure.message ? failure.message : failure || '未知错误')

    // ---------- 时间与路径工具 ----------

    const pad2 = (value) => String(value).padStart(2, '0')

    function formatTime(value) {
      const date = value instanceof Date ? value : new Date(value)
      if (Number.isNaN(date.getTime())) return '—'
      // 固定 24 小时制：否则部分 locale 会出 "10:41:03 PM"，宽度和别处对不上。
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    }

    function formatRelative(value) {
      if (value == null || value === '') return '—'
      const date = value instanceof Date ? value : new Date(value)
      if (Number.isNaN(date.getTime())) return '—'
      const diff = Date.now() - date.getTime()
      if (diff < 60_000) return '刚刚'
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
      return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${formatTime(date).slice(0, 5)}`
    }

    const baseName = (value) => {
      const parts = String(value == null ? '' : value).split(/[\\/]/).filter(Boolean)
      return parts.length > 0 ? parts[parts.length - 1] : String(value == null ? '' : value)
    }

    const samePath = (left, right) => {
      const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      return norm(left) !== '' && norm(left) === norm(right)
    }

    const asArray = (value) => (Array.isArray(value) ? value : [])

    // 指令里混着中英文标识符（`claude_review(mode:"gate")`）。不区分字体会让人读串行、抄错命令。
    function renderInstruction(text) {
      const parts = String(text == null ? '' : text).split('`')
      return parts.map((part, index) =>
        index % 2 === 1
          ? h('code', { key: index, className: 'dc-code' }, part)
          : h(React.Fragment, { key: index }, part),
      )
    }

    // ---------- 本地记忆：只记「上次看哪个项目」，不缓存面板数据 ----------

    function readLastProject() {
      try {
        return window.localStorage.getItem(LAST_PROJECT_KEY) || ''
      } catch {
        return ''
      }
    }

    function saveLastProject(path) {
      if (!path) return
      try {
        window.localStorage.setItem(LAST_PROJECT_KEY, path)
      } catch {
        // 隐私模式/配额满：记住失败不影响使用
      }
    }

    // ---------- 网络：只走自己的 Host 路由 ----------

    async function requestJson(url, options) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null
      try {
        const response = await fetch(url, {
          credentials: 'same-origin',
          ...(options || {}),
          ...(controller ? { signal: controller.signal } : {}),
        })
        const text = await response.text()
        let body = null
        try {
          body = text === '' ? null : JSON.parse(text)
        } catch {
          body = null
        }
        if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`)
        // 200 + 非 JSON（登录页拦截、代理改写）必须报错，否则界面会永远停在「加载中」。
        if (body === null) throw new Error('响应不是 JSON，可能被登录页或代理拦截')
        if (body.ok === false) throw new Error(body.error || '请求失败')
        return body
      } catch (error) {
        if (error && error.name === 'AbortError') throw new Error('请求超时')
        throw error
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    async function postJson(url, payload) {
      return requestJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      })
    }

    // ---------- 样式（全局只注入一次；面板/详情是同一个挂载点） ----------

    const CSS = `
.dc-root { height:100%; overflow:auto; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base);
  font-family:ui-sans-serif,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  font-size:13px; line-height:1.55; -webkit-font-smoothing:antialiased; }
.dc-root *, .dc-root *::before, .dc-root *::after { box-sizing:border-box; }
.dc-sr { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }
.dc-head { position:sticky; top:0; z-index:3; background:var(--dsw-alias-bg-base); border-bottom:1px solid var(--dsw-alias-border-l1); }
.dc-head-inner { max-width:1120px; margin:0 auto; padding:10px 24px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dc-head-inner > * { min-width:0; }
h1.dc-title { margin:0; font-size:17px; line-height:1.3; font-weight:620; letter-spacing:-.01em; overflow-wrap:anywhere; }
.dc-sub { color:var(--dsw-alias-label-secondary); font-size:12px; min-width:0; overflow-wrap:anywhere; }
.dc-spacer { flex:1 1 auto; }
.dc-time { font-variant-numeric:tabular-nums; }
.dc-body { max-width:1120px; margin:0 auto; padding:12px 24px 16px; display:flex; flex-direction:column; gap:8px; }
.dc-card { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); padding:10px 14px; min-width:0; }
.dc-card-title { margin:0 0 8px; font-size:12px; font-weight:600; color:var(--dsw-alias-label-secondary); padding-left:8px; border-left:2px solid var(--dsw-alias-border-l2); line-height:1.4; }
.dc-chip { display:inline-flex; align-items:center; gap:4px; border:1px solid currentColor; border-radius:999px; padding:1px 8px; font-size:11.5px; font-weight:600; white-space:nowrap; max-width:100%; }
.dc-chip-ok { color:var(--dsw-alias-state-success-primary); }
.dc-chip-warn { color:var(--dsw-alias-state-warn-primary); }
.dc-chip-bad { color:var(--dsw-alias-state-error-primary); }
.dc-chip-unknown { color:var(--dsw-alias-label-secondary); border-style:dashed; }
.dc-chip-brand { color:var(--dsw-alias-brand-primary); }
.dc-chip-idle { color:var(--dsw-alias-state-idle-primary); }
.dc-banner { display:flex; flex-direction:column; gap:4px; padding:9px 14px; border-radius:8px; font-size:12px;
  border:1px solid var(--dsw-alias-state-warn-primary); color:var(--dsw-alias-state-warn-primary); }
.dc-banner-error { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }
.dc-banner-ok { border-color:var(--dsw-alias-state-success-primary); color:var(--dsw-alias-state-success-primary); }
.dc-banner-title { font-weight:600; }
.dc-banner-list { margin:0; padding-left:18px; display:flex; flex-direction:column; gap:2px; overflow-wrap:anywhere; }
.dc-banner-row { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
.dc-btn { appearance:none; border:1px solid var(--dsw-alias-border-l2); background:transparent; color:var(--dsw-alias-label-primary);
  border-radius:7px; padding:5px 12px; font:inherit; font-size:12px; cursor:pointer; }
.dc-btn:hover:not(:disabled) { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
.dc-btn:disabled { opacity:.55; cursor:default; }
.dc-btn-primary { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-bg-base); font-weight:600; }
.dc-btn-primary:hover:not(:disabled) { color:var(--dsw-alias-bg-base); border-color:var(--dsw-alias-brand-primary); }
.dc-btn-ghost { border-color:transparent; color:var(--dsw-alias-label-secondary); padding-left:6px; padding-right:6px; }
.dc-btn-ghost:hover:not(:disabled) { color:var(--dsw-alias-brand-primary); border-color:transparent; }
.dc-btn:focus-visible, .dc-btn-ghost:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.dc-name-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
h2.dc-name { margin:0; font-size:16px; font-weight:650; line-height:1.3; letter-spacing:-.01em; overflow-wrap:anywhere; }
.dc-one-liner { margin:4px 0 0; font-size:12.5px; overflow-wrap:anywhere; }
.dc-one-liner-empty { color:var(--dsw-alias-state-warn-primary); }
.dc-meta-line { margin-top:6px; display:flex; align-items:baseline; gap:6px; flex-wrap:wrap; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.dc-meta-value { color:var(--dsw-alias-label-primary); overflow-wrap:anywhere; min-width:0; }
.dc-code { font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace; font-size:12px;
  background:var(--dsw-alias-bg-layer-2); border-radius:4px; padding:1px 5px; overflow-wrap:anywhere; word-break:break-word; }
.dc-iter-row { margin-top:8px; padding-top:7px; border-top:1px dashed var(--dsw-alias-border-l1);
  display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.dc-iter-value { color:var(--dsw-alias-label-primary); font-weight:600; }
.dc-action-eyebrow { font-size:14px; font-weight:650; color:var(--dsw-alias-brand-primary); overflow-wrap:anywhere; }
.dc-action-title { margin:2px 0 0; font-size:15px; font-weight:600; line-height:1.4; overflow-wrap:anywhere; }
.dc-action-reason { margin:4px 0 0; font-size:12.5px; color:var(--dsw-alias-label-secondary); max-width:46em; overflow-wrap:anywhere; }
.dc-caps { margin-top:8px; display:flex; flex-direction:column; gap:4px; }
.dc-caps-label { font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.dc-caps-row { display:flex; gap:6px; flex-wrap:wrap; }
.dc-cap { display:inline-flex; align-items:center; gap:5px; border:1px solid var(--dsw-alias-border-l2);
  border-radius:6px; padding:2px 7px; font-size:11.5px; max-width:100%; }
.dc-cap-name { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; overflow-wrap:anywhere; }
.dc-cap-optional { color:var(--dsw-alias-label-secondary); }
.dc-missing { margin-top:8px; padding:8px 10px; border:1px solid var(--dsw-alias-state-warn-primary);
  border-radius:8px; color:var(--dsw-alias-state-warn-primary); font-size:12px; overflow-wrap:anywhere; }
.dc-missing ul { margin:4px 0 0; padding-left:18px; display:flex; flex-direction:column; gap:2px; overflow-wrap:anywhere; }
.dc-instruction-box { margin-top:8px; }
.dc-instruction-label { font-size:11.5px; color:var(--dsw-alias-label-secondary); margin-bottom:2px; }
.dc-instruction { margin:0; padding:7px 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px;
  background:var(--dsw-alias-bg-base); font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
  font-size:11.5px; line-height:1.55; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; max-width:100%; }
.dc-action-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px; }
.dc-action-row > * { min-width:0; }
.dc-action-row > .dc-missing { flex:1 0 100%; }
.dc-hint { font-size:11.5px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.dc-hint-bad { color:var(--dsw-alias-state-error-primary); }
.dc-hint-ok { color:var(--dsw-alias-state-success-primary); }
.dc-approve { display:inline-flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0; }
.dc-notes { margin:6px 0 0; padding-left:18px; font-size:11.5px; color:var(--dsw-alias-label-secondary);
  display:flex; flex-direction:column; gap:2px; overflow-wrap:anywhere; }
.dc-plan { flex:1 0 100%; margin-top:0; border:1px dashed var(--dsw-alias-border-l2); border-radius:8px;
  padding:10px 12px; display:flex; flex-direction:column; gap:8px; font-size:12px; }
.dc-plan-title { font-weight:600; }
.dc-plan-list { margin:0; padding-left:18px; display:flex; flex-direction:column; gap:2px; overflow-wrap:anywhere; }
.dc-plan-list li { min-width:0; overflow-wrap:anywhere; }
.dc-plan-item-exists { color:var(--dsw-alias-label-secondary); }
.dc-plan-item-create { color:var(--dsw-alias-state-success-primary); }
.dc-track-label { margin:8px 0 4px; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.dc-track { display:grid; grid-template-columns:repeat(auto-fit,minmax(104px,1fr)); gap:6px; margin:0; padding:0; list-style:none; }
.dc-stage { display:flex; align-items:center; gap:6px; flex-wrap:wrap; min-width:0; padding:4px 8px;
  border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-base); }
.dc-stage-name { font-size:12px; font-weight:600; overflow-wrap:anywhere; }
.dc-stage-state { font-size:10.5px; color:var(--dsw-alias-label-secondary); display:inline-flex; align-items:center; gap:4px; flex:none; }
.dc-stage-dot { width:6px; height:6px; border-radius:999px; background:currentColor; flex:none; }
.dc-stage-done { border-color:var(--dsw-alias-state-success-primary); }
.dc-stage-done .dc-stage-state { color:var(--dsw-alias-state-success-primary); }
.dc-stage-current { border-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-2); }
.dc-stage-current .dc-stage-name { color:var(--dsw-alias-brand-primary); }
.dc-stage-current .dc-stage-state { color:var(--dsw-alias-brand-primary); font-weight:600; }
.dc-stage-pending { opacity:.74; }
.dc-facts { margin-top:8px; display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:6px 14px; }
.dc-fact { min-width:0; }
.dc-fact-label { font-size:11px; color:var(--dsw-alias-label-secondary); }
.dc-fact-value { font-size:12.5px; font-weight:500; overflow-wrap:anywhere; }
.dc-decision { margin-bottom:8px; padding:8px 10px; border:1px solid var(--dsw-alias-state-warn-primary); border-radius:8px; }
.dc-decision-title { font-weight:600; color:var(--dsw-alias-state-warn-primary); overflow-wrap:anywhere; }
.dc-decision-options { margin:4px 0 0; padding-left:18px; font-size:12px; display:flex; flex-direction:column; gap:2px; overflow-wrap:anywhere; }
.dc-decision-reco { margin-top:4px; font-size:12px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.dc-ledger-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px;
  /* 回执最多 20 条；给账本一个自己的滚动区，四区才不会互相挤成一长条。 */
  max-height:300px; overflow-y:auto; scrollbar-width:thin; }
.dc-ledger-item { min-width:0; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:6px 9px; background:var(--dsw-alias-bg-base); }
.dc-ledger-head { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.dc-ledger-stage { font-weight:600; font-size:12.5px; }
.dc-ledger-when { color:var(--dsw-alias-label-secondary); font-size:11.5px; font-variant-numeric:tabular-nums; }
.dc-ledger-summary { margin:3px 0 0; font-size:12px; overflow-wrap:anywhere; }
.dc-ledger-meta { margin-top:2px; font-size:10.5px; color:var(--dsw-alias-label-secondary);
  display:flex; gap:8px; flex-wrap:wrap; overflow-wrap:anywhere; }
.dc-empty-line { margin:0; font-size:12px; color:var(--dsw-alias-label-secondary); }
.dc-details { margin-top:8px; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.dc-details summary { cursor:pointer; }
.dc-details ul { margin:6px 0 0; padding-left:18px; display:flex; flex-direction:column; gap:2px; overflow-wrap:anywhere; }
.dc-foot { border-top:1px solid var(--dsw-alias-border-l1); padding:8px 2px 2px;
  display:flex; align-items:center; gap:12px; flex-wrap:wrap; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.dc-foot-item { display:inline-flex; align-items:center; gap:5px; }
.dc-foot-value { color:var(--dsw-alias-label-primary); font-weight:600; }
.dc-foot .dc-btn { margin-left:auto; }
.dc-cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:12px; }
.dc-ws-card { appearance:none; text-align:left; font:inherit; color:inherit; display:flex; flex-direction:column; gap:6px;
  min-width:0; border:1px solid var(--dsw-alias-border-l1); border-radius:10px;
  background:var(--dsw-alias-bg-layer-1); padding:14px; cursor:pointer; }
.dc-ws-card:hover { border-color:var(--dsw-alias-brand-primary); }
.dc-ws-card:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.dc-ws-top { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dc-ws-title { font-size:14px; font-weight:600; overflow-wrap:anywhere; }
.dc-ws-next { font-size:12px; overflow-wrap:anywhere; }
.dc-ws-meta { font-size:11.5px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.dc-ws-path { font-size:11px; color:var(--dsw-alias-label-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.dc-ws-foot { margin-top:2px; display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:11px; color:var(--dsw-alias-label-secondary); }
.dc-state { max-width:560px; margin:48px auto; padding:20px 22px; border:1px solid var(--dsw-alias-border-l1);
  border-radius:10px; background:var(--dsw-alias-bg-layer-1); text-align:center; }
h2.dc-state-title { margin:0 0 6px; font-size:15px; font-weight:600; }
.dc-state-body { margin:0 0 14px; font-size:12.5px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.dc-skeleton { display:flex; flex-direction:column; gap:12px; }
.dc-skel { background:var(--dsw-alias-bg-layer-2); border-radius:8px; }
.dc-skel-line { height:12px; }
.dc-skel-card { height:92px; }
.dc-skel-rail { height:48px; }
@media (max-width:640px) {
  .dc-head-inner, .dc-body { padding-left:14px; padding-right:14px; }
  .dc-card { padding:9px 11px; }
  h1.dc-title { font-size:15px; }
  .dc-cards { grid-template-columns:1fr; }
  /* 窄屏下把账本的自由滚动让给页面本身：局部滚动+隐藏滚动条看起来像内容被截断。 */
  .dc-ledger-list { max-height:none; overflow:visible; }
}
`

    // CSS 必须全局注入一次：总览与详情是同一挂载点，但侧栏图标也需要它。
    const STYLE_ID = 'delivery-cockpit-style'
    function ensureStyles() {
      if (typeof document === 'undefined' || !document || !document.head) return
      if (document.getElementById(STYLE_ID)) return
      const element = document.createElement('style')
      element.id = STYLE_ID
      element.textContent = CSS
      document.head.appendChild(element)
    }

    // ---------- 侧栏图标：纯 SVG，颜色只用 currentColor ----------

    function Icon(props) {
      const size = props && Number(props.size) ? Number(props.size) : 18
      const active = Boolean(props && props.active)
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 20 20',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
          'data-active': active ? 'true' : 'false',
        },
        h('rect', {
          x: 2.5,
          y: 3.5,
          width: 15,
          height: 13,
          rx: 2.5,
          stroke: 'currentColor',
          strokeWidth: active ? 1.7 : 1.4,
        }),
        h('path', {
          d: 'M2.5 7.5h15',
          stroke: 'currentColor',
          strokeWidth: active ? 1.7 : 1.4,
        }),
        h('path', {
          d: 'M6 11.5h3.5',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('circle', {
          cx: 13.5,
          cy: 11.5,
          r: 1.6,
          fill: 'currentColor',
        }),
      )
    }

    // ---------- 小部件 ----------

    function Chip(props) {
      const tone = props.tone || 'unknown'
      return h('span', { className: `dc-chip dc-chip-${tone}`, title: props.title || undefined }, props.children)
    }

    function Banner(props) {
      const tone = props.tone === 'error' ? 'dc-banner dc-banner-error' : props.tone === 'ok' ? 'dc-banner dc-banner-ok' : 'dc-banner'
      return h(
        'section',
        { className: tone, role: props.role || 'status' },
        props.title ? h('div', { className: 'dc-banner-title' }, props.title) : null,
        props.children,
        props.action
          ? h('div', { className: 'dc-banner-row' }, h('span', { className: 'dc-hint' }, props.actionHint || ''), props.action)
          : null,
      )
    }

    function StatePage(props) {
      return h(
        'div',
        { className: 'dc-root' },
        h(
          'header',
          { className: 'dc-head' },
          h(
            'div',
            { className: 'dc-head-inner' },
            h('h1', { className: 'dc-title' }, '交付驾驶舱'),
            h('span', { className: 'dc-sub' }, '只读面板 · 数据来自本机项目目录'),
            h('span', { className: 'dc-spacer' }),
            props.onBack
              ? h('button', { type: 'button', className: 'dc-btn dc-btn-ghost', onClick: props.onBack }, '← 全部项目')
              : null,
          ),
        ),
        h(
          'main',
          { className: 'dc-body' },
          h(
            'div',
            { className: 'dc-state', role: 'alert' },
            h('h2', { className: 'dc-state-title' }, props.title),
            h('p', { className: 'dc-state-body' }, props.body),
            props.onRetry
              ? h(
                  'button',
                  { type: 'button', className: 'dc-btn dc-btn-primary', onClick: props.onRetry, disabled: props.loading },
                  props.loading ? '重试中…' : '重试',
                )
              : null,
          ),
        ),
      )
    }

    function SkeletonPage() {
      return h(
        'div',
        { className: 'dc-root' },
        h(
          'header',
          { className: 'dc-head' },
          h(
            'div',
            { className: 'dc-head-inner' },
            h('h1', { className: 'dc-title' }, '交付驾驶舱'),
            h('span', { className: 'dc-sub' }, '加载中…'),
          ),
        ),
        h(
          'main',
          { className: 'dc-body' },
          h(
            'div',
            { className: 'dc-skeleton', role: 'status', 'aria-label': '正在加载' },
            h('div', { className: 'dc-skel dc-skel-rail' }),
            h('div', { className: 'dc-skel dc-skel-card' }),
            h('div', { className: 'dc-skel dc-skel-card' }),
          ),
        ),
      )
    }

    // ---------- 数据层：总览 + 详情，各自独立失败、各自可重试 ----------

    function useCockpit() {
      const [projects, setProjects] = React.useState([])
      const [overviewAt, setOverviewAt] = React.useState(null)
      const [overviewLoading, setOverviewLoading] = React.useState(true)
      const [overviewError, setOverviewError] = React.useState('')
      const [view, setView] = React.useState('overview')
      const [selectedPath, setSelectedPath] = React.useState('')
      const [panel, setPanel] = React.useState(null)
      const [panelLoading, setPanelLoading] = React.useState(false)
      const [panelError, setPanelError] = React.useState('')
      const [goodAt, setGoodAt] = React.useState(0)
      const seq = React.useRef({ overview: 0, panel: 0 })
      // 只在第一次成功拉列表时决定「进总览还是回到上次项目」，之后的轮询不再改视图。
      const booted = React.useRef(false)

      const loadOverview = React.useCallback(async (silent) => {
        const mine = ++seq.current.overview
        if (!silent) setOverviewLoading(true)
        try {
          const body = await requestJson(`${API}/workspaces`)
          if (mine !== seq.current.overview) return
          const rows = asArray(body && body.projects)
          setProjects(rows)
          setOverviewAt((body && body.generatedAt) || new Date().toISOString())
          setOverviewError('')
          if (!booted.current) {
            booted.current = true
            const remembered = readLastProject()
            const hit = rows.find((item) => item && samePath(item.path, remembered))
            if (hit && hit.path) {
              setSelectedPath(hit.path)
              setView('detail')
            }
          }
        } catch (failure) {
          if (mine !== seq.current.overview) return
          setOverviewError(messageOf(failure))
        } finally {
          if (mine === seq.current.overview) setOverviewLoading(false)
        }
      }, [])

      const loadPanel = React.useCallback(async (path, silent) => {
        if (!path) return
        const mine = ++seq.current.panel
        if (!silent) setPanelLoading(true)
        try {
          const body = await requestJson(`${API}/panel?path=${encodeURIComponent(path)}`)
          if (mine !== seq.current.panel) return
          const next = body && body.panel
          if (!next || typeof next !== 'object') throw new Error('响应缺少 panel')
          setPanel(next)
          setPanelError('')
          setGoodAt(Date.now())
        } catch (failure) {
          if (mine !== seq.current.panel) return
          setPanelError(messageOf(failure))
        } finally {
          if (mine === seq.current.panel) setPanelLoading(false)
        }
      }, [])

      React.useEffect(() => {
        loadOverview(false)
      }, [loadOverview])

      // 详情跟着选中的项目走；轮询只为刷新同一路径，不换项目。
      React.useEffect(() => {
        if (!selectedPath) return undefined
        let alive = true
        setPanel(null)
        loadPanel(selectedPath, false)
        const timer = setInterval(() => {
          if (alive && !document.hidden) loadPanel(selectedPath, true)
        }, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [selectedPath, loadPanel])

      // 总览页也轮询：多项目时首页状态会变（比如 Agent 刚写完一条回执）。
      React.useEffect(() => {
        if (view !== 'overview') return undefined
        const timer = setInterval(() => {
          if (!document.hidden) loadOverview(true)
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [view, loadOverview])

      const openProject = React.useCallback((path) => {
        if (!path) return
        setSelectedPath(path)
        setView('detail')
        saveLastProject(path)
      }, [])

      const backToOverview = React.useCallback(() => {
        setView('overview')
        setPanel(null)
        setPanelError('')
        // 清掉选中的路径：否则再点回同一个项目时 selectedPath 没变化，详情不会重新拉取。
        setSelectedPath('')
        loadOverview(true)
      }, [loadOverview])

      const refresh = React.useCallback(() => {
        if (view === 'detail' && selectedPath) {
          loadPanel(selectedPath, false)
        } else {
          loadOverview(false)
        }
      }, [view, selectedPath, loadPanel, loadOverview])

      return {
        projects,
        overviewAt,
        overviewLoading,
        overviewError,
        view,
        selectedPath,
        panel,
        panelLoading,
        panelError,
        goodAt,
        openProject,
        backToOverview,
        refresh,
      }
    }

    // ---------- 总览 ----------

    function WorkspaceCard(props) {
      const item = props.item || {}
      const title = item.title || baseName(item.path) || '未命名项目'
      const initialized = item.initialized === true
      const degraded = item.degraded === true
      const hasDecision = item.hasDecision === true
      const stageName = item.stageName || STAGE_TEXT[item.stageId] || ''
      const nextTitle = item.nextTitle || ''
      return h(
        'button',
        {
          type: 'button',
          className: 'dc-ws-card',
          onClick: () => props.onOpen(item.path),
          'aria-label': `打开项目 ${title}`,
        },
        h(
          'div',
          { className: 'dc-ws-top' },
          h('span', { className: 'dc-ws-title' }, title),
          degraded
            ? h(Chip, { tone: 'unknown', title: '读取有异常，数字可能偏低' }, '数据待确认')
            : null,
          hasDecision ? h(Chip, { tone: 'warn' }, '待决策') : null,
          initialized ? null : h(Chip, { tone: 'warn' }, '未初始化'),
        ),
        h(
          'div',
          { className: 'dc-ws-meta' },
          stageName ? `当前阶段：${stageName}` : '当前阶段：—',
        ),
        h('div', { className: 'dc-ws-next' }, nextTitle ? `下一步：${nextTitle}` : '下一步：—'),
        h('div', { className: 'dc-ws-path', title: item.path || '' }, item.path || ''),
        h(
          'div',
          { className: 'dc-ws-foot' },
          h('span', null, `上次更新 ${formatRelative(item.updatedAt)}`),
          entryGlyph(),
        ),
      )
    }

    // 卡片右下角的「进去看看」提示：纯装饰，读屏走 aria-label。
    function entryGlyph() {
      return h('span', { className: 'dc-hint', 'aria-hidden': 'true' }, '进入 →')
    }

    function OverviewPage(props) {
      const { projects, overviewAt, overviewLoading, overviewError, openProject, refresh } = props
      const hasProjects = projects.length > 0
      const header = h(
        'header',
        { className: 'dc-head' },
        h(
          'div',
          { className: 'dc-head-inner' },
          h('h1', { className: 'dc-title' }, '交付驾驶舱'),
          h('span', { className: 'dc-sub' }, '只读面板 · 按项目看真实进度'),
          h('span', { className: 'dc-spacer' }),
          overviewAt ? h('span', { className: 'dc-sub dc-time' }, `更新于 ${formatTime(overviewAt)}`) : null,
          h(
            'button',
            {
              type: 'button',
              className: 'dc-btn',
              onClick: refresh,
              disabled: overviewLoading,
              'aria-busy': overviewLoading ? 'true' : 'false',
            },
            overviewLoading ? '刷新中…' : '刷新',
          ),
        ),
      )

      let content = null
      if (overviewLoading && !hasProjects) {
        content = h(
          'div',
          { className: 'dc-skeleton', role: 'status', 'aria-label': '正在加载' },
          h('div', { className: 'dc-skel dc-skel-rail' }),
          h('div', { className: 'dc-skel dc-skel-card' }),
          h('div', { className: 'dc-skel dc-skel-card' }),
        )
      } else if (overviewError && !hasProjects) {
        content = h(
          'div',
          { className: 'dc-state', role: 'alert' },
          h('h2', { className: 'dc-state-title' }, '读取工作区失败'),
          h('p', { className: 'dc-state-body' }, explainError(overviewError)),
          h(
            'button',
            { type: 'button', className: 'dc-btn dc-btn-primary', onClick: refresh, disabled: overviewLoading },
            overviewLoading ? '重试中…' : '重试',
          ),
        )
      } else if (!hasProjects) {
        content = h(
          'div',
          { className: 'dc-state' },
          h('h2', { className: 'dc-state-title' }, '还没有项目工作区'),
          h(
            'p',
            { className: 'dc-state-body' },
            '在任意目录里打开一个会话后，这里会自动出现该项目；空目录也算项目，会显示「未初始化」。',
          ),
          h('button', { type: 'button', className: 'dc-btn', onClick: refresh }, '重新检测'),
        )
      } else {
        content = h(
          React.Fragment,
          null,
          overviewError
            ? h(
                Banner,
                {
                  tone: 'error',
                  role: 'alert',
                  title: '刷新失败，下面是上一次的数据',
                  action: h(
                    'button',
                    { type: 'button', className: 'dc-btn', onClick: refresh, disabled: overviewLoading },
                    '重试',
                  ),
                },
                h('div', { className: 'dc-hint' }, explainError(overviewError)),
              )
            : null,
          h(
            'div',
            { className: 'dc-cards' },
            projects.map((item) =>
              h(WorkspaceCard, {
                key: item.id || item.path,
                item,
                onOpen: openProject,
              }),
            ),
          ),
          h(
            'footer',
            { className: 'dc-foot' },
            h('span', { className: 'dc-foot-item' }, '共 ', h('span', { className: 'dc-foot-value' }, String(projects.length)), ' 个项目'),
            h('span', { className: 'dc-foot-item' }, '引擎正常'),
            h('span', { className: 'dc-spacer' }),
            h(
              'button',
              { type: 'button', className: 'dc-btn', onClick: refresh, disabled: overviewLoading },
              '刷新',
            ),
          ),
        )
      }

      return h(
        'div',
        { className: 'dc-root' },
        header,
        h('main', { className: 'dc-body' }, content),
      )
    }

    // ---------- 详情 · ① 项目名片 & 迭代头 ----------

    function ProjectSection(props) {
      const project = props.project || {}
      const trellis = props.trellis || {}
      const iteration = props.iteration || {}
      const ledger = props.ledger || {}
      const action = props.action || {}
      const stack = project.stack || {}
      const commands = project.commands || {}
      const oneLiner = String(project.oneLiner || '').trim()
      const stackLabel = stack.label || (stack.id === 'unknown' ? '未检测到技术栈' : '') || '未检测到技术栈'
      const dev = commands.dev || ''

      let health = { text: '账本健康', tone: 'ok' }
      if (props.degraded) health = { text: '数据待确认', tone: 'unknown' }
      else if (action.kind === 'decide') health = { text: '待决策', tone: 'warn' }
      else if (Number(ledger.badLines) > 0) health = { text: '账本有坏行', tone: 'warn' }

      return h(
        'section',
        { className: 'dc-card' },
        h('h2', { className: 'dc-card-title' }, '① 项目名片 & 迭代头'),
        h(
          'div',
          { className: 'dc-name-row' },
          h('h3', { className: 'dc-name' }, project.name || baseName(project.path) || '未命名项目'),
          h(Chip, { tone: health.tone }, health.text),
          trellis.initialized === false ? h(Chip, { tone: 'warn' }, 'Trellis 未初始化') : null,
          trellis.initialized === true && trellis.partial === true
            ? h(Chip, { tone: 'warn' }, 'Trellis 不完整')
            : null,
          project.cardStatus === 'needs-human' ? h(Chip, { tone: 'warn' }, '名片待补') : null,
          project.cardStatus === 'missing' ? h(Chip, { tone: 'warn' }, '名片缺失') : null,
          project.cardStatus === 'broken' ? h(Chip, { tone: 'bad' }, '名片损坏') : null,
        ),
        h(
          'p',
          { className: oneLiner ? 'dc-one-liner' : 'dc-one-liner dc-one-liner-empty' },
          oneLiner || '还没有一句话定位：补上它，驾驶舱才能说人话。',
        ),
        h(
          'div',
          { className: 'dc-meta-line' },
          h('span', null, '技术栈'),
          h('span', { className: 'dc-meta-value' }, stackLabel),
          h('span', { className: 'dc-sub' }, '·'),
          h('span', null, '本地预览命令'),
          dev
            ? h('code', { className: 'dc-code' }, dev)
            : h('span', { className: 'dc-meta-value' }, '未检测到'),
          commands.previewUrl
            ? h('a', { className: 'dc-btn', href: commands.previewUrl, target: '_blank', rel: 'noreferrer' }, '打开预览')
            : null,
        ),
        h(
          'div',
          { className: 'dc-iter-row' },
          h('span', null, '当前迭代'),
          h('span', { className: 'dc-iter-value' }, iteration.current || 'bootstrap'),
          h('span', null, iteration.isBootstrap ? '冷启动' : '功能迭代环'),
          h('span', { className: 'dc-sub' }, '·'),
          h('span', { className: 'dc-sub dc-ws-path', title: project.path || '' }, project.path || ''),
        ),
      )
    }

    // ---------- 详情 · ② 唯一下一步 ----------

    function InitPanel(props) {
      const [state, setState] = React.useState({ step: 'idle', plan: null, result: null, error: '' })
      const mounted = React.useRef(true)
      React.useEffect(
        () => () => {
          mounted.current = false
        },
        [],
      )

      const loadPlan = async () => {
        setState({ step: 'planning', plan: null, result: null, error: '' })
        try {
          const body = await requestJson(`${API}/init-plan?path=${encodeURIComponent(props.projectPath)}`)
          if (!mounted.current) return
          if (!body || !body.plan) throw new Error('响应缺少 plan')
          setState({ step: 'plan', plan: body.plan, result: null, error: '' })
        } catch (failure) {
          if (!mounted.current) return
          setState({ step: 'error', plan: null, result: null, error: explainError(messageOf(failure)) })
        }
      }

      const applyPlan = async () => {
        setState((previous) => ({ ...previous, step: 'applying', error: '' }))
        try {
          // confirm:true 是契约的一部分：不显式确认就绝不写盘。
          const body = await postJson(`${API}/init`, { path: props.projectPath, confirm: true })
          if (!mounted.current) return
          setState({ step: 'done', plan: null, result: body, error: '' })
          if (props.onApplied) props.onApplied(body)
        } catch (failure) {
          if (!mounted.current) return
          setState((previous) => ({ ...previous, step: 'plan', error: explainError(messageOf(failure)) }))
        }
      }

      if (state.step === 'idle') {
        return h(
          'div',
          { className: 'dc-action-row' },
          h(
            'button',
            {
              type: 'button',
              className: 'dc-btn dc-btn-primary',
              onClick: loadPlan,
              disabled: props.disabled,
            },
            '初始化此项目',
          ),
          h('span', { className: 'dc-hint' }, '先预览会写哪些文件，确认后才落盘。'),
        )
      }

      if (state.step === 'planning' || state.step === 'applying') {
        return h(
          'div',
          { className: 'dc-plan', role: 'status' },
          h('div', { className: 'dc-plan-title' }, state.step === 'applying' ? '正在初始化…' : '正在生成初始化计划…'),
          h('div', { className: 'dc-hint' }, '只读检查中，不会写入任何文件。'),
        )
      }

      if (state.step === 'error') {
        return h(
          'div',
          { className: 'dc-missing', role: 'alert' },
          h('div', null, '初始化计划生成失败：', state.error),
          h(
            'div',
            { className: 'dc-action-row' },
            h('button', { type: 'button', className: 'dc-btn dc-btn-primary', onClick: loadPlan }, '重试'),
            h(
              'button',
              { type: 'button', className: 'dc-btn', onClick: () => setState({ step: 'idle', plan: null, result: null, error: '' }) },
              '取消',
            ),
          ),
        )
      }

      if (state.step === 'done') {
        // 细节（创建/跳过清单）由父级成功横幅展示；这里只留一句状态，避免同屏两遍。
        const result = state.result || {}
        return h(
          'span',
          { className: result.applied ? 'dc-hint dc-hint-ok' : 'dc-hint' },
          result.applied ? '初始化完成，已刷新面板。' : '项目已经是初始化状态，无需重复写入。',
        )
      }

      const plan = state.plan || {}
      return h(
        'div',
        { className: 'dc-plan' },
        h('div', { className: 'dc-plan-title' }, '初始化计划（确认前不会写入）'),
        h(
          'ul',
          { className: 'dc-plan-list' },
          asArray(plan.dirs).map((dir, index) =>
            h(
              'li',
              { key: `dir${index}`, className: dir && dir.status === 'create' ? 'dc-plan-item-create' : 'dc-plan-item-exists' },
              `${dir && dir.path ? dir.path : '（目录）'} — ${dir && dir.status === 'create' ? '将创建' : '已存在'}`,
            ),
          ),
        ),
        h(
          'ul',
          { className: 'dc-plan-list' },
          asArray(plan.files).map((file, index) =>
            h(
              'li',
              { key: `file${index}`, className: file && file.status === 'create' ? 'dc-plan-item-create' : 'dc-plan-item-exists' },
              `${file && file.name ? file.name : '（文件）'} — ${file && file.status === 'create' ? '将创建' : '已存在'}` +
                (file && file.source ? `（${file.source === 'template' ? '模板' : '生成'}）` : ''),
            ),
          ),
        ),
        plan.gitignoreHint
          ? h(
              'div',
              null,
              '建议加进 .gitignore：',
              h('code', { className: 'dc-code' }, plan.gitignoreHint),
            )
          : null,
        asArray(plan.notes).length > 0
          ? h('ul', { className: 'dc-plan-list' }, asArray(plan.notes).map((line, index) => h('li', { key: `note${index}` }, line)))
          : null,
        asArray(plan.errors).length > 0
          ? h(
              'ul',
              { className: 'dc-plan-list' },
              asArray(plan.errors).map((line, index) => h('li', { key: `err${index}`, className: 'dc-hint-bad' }, line)),
            )
          : null,
        state.error ? h('div', { className: 'dc-hint-bad' }, state.error) : null,
        h(
          'div',
          { className: 'dc-action-row' },
          h(
            'button',
            { type: 'button', className: 'dc-btn dc-btn-primary', onClick: applyPlan, disabled: props.disabled },
            '确认写入并初始化',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dc-btn',
              onClick: () => setState({ step: 'idle', plan: null, result: null, error: '' }),
            },
            '取消',
          ),
        ),
      )
    }

    // 原型批准：design §5.3 的门禁落点。批准标记由 Host 按 iteration_id 写盘，
    // 客户端只发「我确认过了」；成功后面板刷新，按钮自然变成只读状态。
    function ApprovePrototype(props) {
      const [state, setState] = React.useState({ step: 'idle', error: '' })
      if (props.approved) {
        return h(
          'span',
          { className: 'dc-hint dc-hint-ok', title: props.at ? new Date(props.at).toLocaleString() : '' },
          `已于 ${props.at ? formatRelative(props.at) : '—'} 通过原型`,
        )
      }
      if (state.step === 'done') {
        return h('span', { className: 'dc-hint dc-hint-ok' }, '已通过原型，正在刷新…')
      }
      const approve = async () => {
        setState({ step: 'saving', error: '' })
        try {
          const body = await postJson(`${API}/approve-prototype`, {
            path: props.projectPath,
            iteration_id: props.iterationId,
          })
          if (!body || body.ok !== true) throw new Error('approval-failed')
          setState({ step: 'done', error: '' })
          if (props.onApproved) props.onApproved(body.approval)
        } catch (failure) {
          setState({ step: 'idle', error: explainApproveError(messageOf(failure)) })
        }
      }
      return h(
        'span',
        { className: 'dc-approve' },
        h(
          'button',
          {
            type: 'button',
            className: 'dc-btn dc-btn-primary',
            onClick: approve,
            disabled: props.disabled === true || state.step === 'saving',
          },
          state.step === 'saving' ? '提交中…' : '通过原型',
        ),
        state.error ? h('span', { className: 'dc-hint dc-hint-bad' }, state.error) : null,
      )
    }

    function NextActionSection(props) {
      const action = props.action || {}
      const iteration = props.iteration || {}
      const prototype = iteration.prototype || {}
      const iterationId = iteration.current || ''
      const stageText =
        action.stageName || STAGE_TEXT[action.stageId] || (action.kind === 'init' ? '初始化' : '下一步')
      const missing = asArray(action.missing)
      const caps = asArray(action.capabilities)
      const notes = asArray(action.notes)
      const buttons = asArray(action.buttons)
      const instruction = typeof action.instruction === 'string' ? action.instruction.trim() : ''
      const wantsInit = buttons.indexOf('init') >= 0 || action.kind === 'init'
      const wantsApprove = action.kind === 'prototype'
      const wantsCopy = instruction !== '' && (buttons.length === 0 || buttons.indexOf('copy') >= 0)
      const missingBlocks = missing.length > 0
      const disabled = props.degraded === true || action.disabled === true || missingBlocks
      const disabledReason = props.degraded
        ? '数据不可信：先处理上面的原因再行动。'
        : action.disabledReason || (missingBlocks ? missing[0].message || '缺少能力，暂不下发指令。' : '')
      const [copyState, setCopyState] = React.useState('idle')
      const copyTimer = React.useRef(null)
      React.useEffect(
        () => () => {
          clearTimeout(copyTimer.current)
        },
        [],
      )

      const copyInstruction = () => {
        const clipboard = navigator.clipboard
        if (!clipboard || typeof clipboard.writeText !== 'function') {
          setCopyState('fail')
          return
        }
        clipboard.writeText(instruction).then(
          () => {
            setCopyState('done')
            clearTimeout(copyTimer.current)
            copyTimer.current = setTimeout(() => setCopyState('idle'), 1600)
          },
          () => {
            setCopyState('fail')
            clearTimeout(copyTimer.current)
            copyTimer.current = setTimeout(() => setCopyState('idle'), 4000)
          },
        )
      }

      return h(
        'section',
        { className: 'dc-card' },
        h('h2', { className: 'dc-card-title' }, '② 唯一下一步'),
        h('div', { className: 'dc-action-eyebrow' }, `👉【${stageText}】`),
        h('h3', { className: 'dc-action-title' }, action.title || '暂无建议'),
        h(
          'p',
          { className: 'dc-action-reason' },
          action.reason || '服务端没有返回下一步，可能是插件版本不匹配。',
        ),
        caps.length > 0
          ? h(
              'div',
              { className: 'dc-caps' },
              h('div', { className: 'dc-caps-label' }, '推荐能力'),
              h(
                'div',
                { className: 'dc-caps-row' },
                caps.map((capability, index) => {
                  const presence = PRESENCE_TEXT[capability && capability.present] || PRESENCE_TEXT.unknown
                  return h(
                    'span',
                    {
                      key: `${capability && capability.name ? capability.name : 'cap'}${index}`,
                      className: 'dc-cap',
                      title: capability && capability.note ? capability.note : undefined,
                    },
                    h('span', { className: 'dc-cap-name' }, (capability && capability.name) || '未命名能力'),
                    h(Chip, { tone: presence.tone }, presence.text),
                    capability && capability.optional === true ? h('span', { className: 'dc-cap-optional' }, '（可选）') : null,
                  )
                }),
              ),
            )
          : null,
        missingBlocks
          ? h(
              'div',
              { className: 'dc-missing', role: 'status' },
              h('div', null, '缺少这些能力，暂不下发指令：'),
              h(
                'ul',
                null,
                missing.map((item, index) =>
                  h(
                    'li',
                    { key: `missing${index}` },
                    `${(item && item.name) || '能力'}（${(item && item.kind) || '未知'}）：${(item && item.message) || '不可用'}`,
                  ),
                ),
              ),
            )
          : instruction
            ? h(
                'div',
                { className: 'dc-instruction-box' },
                h('div', { className: 'dc-instruction-label' }, '指令原文（可直接复制执行）'),
                h('div', { className: 'dc-instruction' }, renderInstruction(instruction)),
              )
            : null,
        h(
          'div',
          { className: 'dc-action-row' },
          wantsCopy
            ? h(
                'button',
                {
                  type: 'button',
                  className: wantsApprove || wantsInit ? 'dc-btn' : 'dc-btn dc-btn-primary',
                  onClick: copyInstruction,
                  disabled: disabled,
                  title: disabled ? disabledReason : '复制指令',
                },
                copyState === 'done' ? '已复制' : copyState === 'fail' ? '复制失败，请手动选择' : '复制指令',
              )
            : null,
          wantsInit
            ? h(InitPanel, {
                projectPath: props.projectPath,
                disabled: props.degraded === true || action.disabled === true,
                onApplied: props.onApplied,
              })
            : null,
          wantsApprove
            ? h(ApprovePrototype, {
                projectPath: props.projectPath,
                iterationId,
                approved: prototype.approved === true,
                at: prototype.at || null,
                disabled: props.degraded === true || action.disabled === true,
                onApproved: props.onApproved,
              })
            : null,
          disabled && disabledReason
            ? h('span', { className: 'dc-hint dc-hint-bad' }, disabledReason)
            : null,
        ),
        notes.length > 0
          ? h(
              'ul',
              { className: 'dc-notes' },
              notes.slice(0, 6).map((note, index) => h('li', { key: `note${index}` }, note)),
            )
          : null,
      )
    }

    // ---------- 详情 · ③ 迭代进度 ----------

    function StageNode(props) {
      const node = props.node || {}
      const state = node.state === 'done' || node.state === 'current' ? node.state : 'pending'
      const highlighted = state === 'current' && props.highlight
      const stateText = state === 'done' ? '已完成' : state === 'current' ? '当前' : '未开始'
      const summary = node.receipt && node.receipt.summary
      return h(
        'li',
        {
          className: `dc-stage dc-stage-${highlighted ? 'current' : state === 'current' ? 'pending' : state}`,
          'aria-current': highlighted ? 'step' : undefined,
          // 阶段卡片只保留一行；回执摘要放在 title 里，避免一屏四区被进度条挤满。
          title: summary ? `${stateText}：${summary}` : `${(node.name || node.stageId || '')}：${stateText}`,
        },
        h(
          'span',
          { className: 'dc-stage-state' },
          h('span', { className: 'dc-stage-dot', 'aria-hidden': 'true' }),
          stateText,
        ),
        h('span', { className: 'dc-stage-name' }, node.name || STAGE_TEXT[node.stageId] || node.stageId || '阶段'),
      )
    }

    function ProgressionSection(props) {
      const progression = props.progression || {}
      const cold = asArray(progression.coldStart)
      const cycle = asArray(progression.cycle)
      const iteration = props.iteration || {}
      const action = props.action || {}
      const acceptance = props.acceptance || {}
      const review = props.review || {}
      const tasks = props.tasks || {}
      const prototype = iteration.prototype || {}

      // 契约保证只有一个 current；万一模型给多了，只强高亮决策指向的那个，避免「两个当前」。
      const firstCurrent = cold.concat(cycle).find((node) => node && node.state === 'current')
      const highlightId = action.stageId || (firstCurrent && firstCurrent.stageId) || ''

      // 0/0 看起来像「全过」，但坏 JSON 时那是没读到，不是没失败。必须分开说。
      const acceptanceText = acceptance.badJson
        ? '解析失败'
        : acceptance.empty
          ? '未生成'
          : `${Number(acceptance.passed) || 0}/${Number(acceptance.total) || 0} 条通过`
      const reviewText =
        review.available === false
          ? review.reason === 'no-ledger'
            ? '未接审核账本'
            : '读取失败'
          : Number(review.blocking) > 0
            ? `阻塞 ${review.blocking}`
            : Number(review.fixed) > 0
              ? `待复检 ${review.fixed}`
              : Number(review.rounds) > 0
                ? `${review.rounds} 轮已清`
                : '未开始'
      const tasksText = tasks.available === false
        ? '不可用'
        : `${Number(tasks.open) || 0} 个未完成 / 共 ${Number(tasks.total) || 0} 个`
      const prototypeText = prototype.approved
        ? `已通过${prototype.file ? ` · ${prototype.file}` : ''}`
        : '未通过'

      return h(
        'section',
        { className: 'dc-card' },
        h('h2', { className: 'dc-card-title' }, '③ 迭代进度'),
        h('div', { className: 'dc-track-label' }, '冷启动（每项目一次）'),
        h(
          'ol',
          { className: 'dc-track' },
          cold.map((node, index) =>
            h(StageNode, {
              key: `cold${index}`,
              node,
              highlight: node && node.stageId === highlightId,
            }),
          ),
        ),
        h('div', { className: 'dc-track-label' }, `迭代环 · ${iteration.current || 'bootstrap'}`),
        h(
          'ol',
          { className: 'dc-track' },
          cycle.map((node, index) =>
            h(StageNode, {
              key: `cycle${index}`,
              node,
              highlight: node && node.stageId === highlightId,
            }),
          ),
        ),
        h(
          'div',
          { className: 'dc-facts' },
          h(Fact, { label: '原型批准', value: prototypeText }),
          h(Fact, { label: '人话验收表', value: acceptanceText }),
          h(Fact, { label: '审核账本', value: reviewText }),
          h(Fact, { label: '任务', value: tasksText }),
        ),
      )
    }

    function Fact(props) {
      return h(
        'div',
        { className: 'dc-fact' },
        h('div', { className: 'dc-fact-label' }, props.label),
        h('div', { className: 'dc-fact-value' }, props.value),
      )
    }

    // ---------- 详情 · ④ 人话账本 ----------

    function LedgerSection(props) {
      const ledger = props.ledger || {}
      const receipts = asArray(ledger.receipts)
      const warnings = asArray(props.warnings)
      const dataGaps = asArray(props.dataGaps)
      // 待决策置顶：needs_human_decision 非空即最高优，与 status 无关（design §7）。
      const decisionReceipt = receipts.find((receipt) => receipt && receipt.needsDecision) || null
      const decision = decisionReceipt && decisionReceipt.needsDecision
      const total = Number(ledger.total) || receipts.length

      return h(
        'section',
        { className: 'dc-card' },
        h('h2', { className: 'dc-card-title' }, '④ 人话账本'),
        decision
          ? h(
              'div',
              { className: 'dc-decision', role: 'status' },
              h('div', { className: 'dc-decision-title' }, `待你决策：${decision.title || '需要人工判断'}`),
              asArray(decision.options).length > 0
                ? h(
                    'ul',
                    { className: 'dc-decision-options' },
                    asArray(decision.options).map((option, index) => h('li', { key: `option${index}` }, option)),
                  )
                : null,
              decision.recommended
                ? h('div', { className: 'dc-decision-reco' }, `建议：${decision.recommended}`)
                : null,
            )
          : null,
        receipts.length === 0
          ? h('p', { className: 'dc-empty-line' }, '还没有回执。Agent 每完成一步会写一条，这里按时间倒序显示。')
          : h(
              'ol',
              { className: 'dc-ledger-list' },
              receipts.map((receipt, index) =>
                h(LedgerRow, { key: (receipt && receipt.id) || `receipt${index}`, receipt }),
              ),
            ),
        total > receipts.length
          ? h('p', { className: 'dc-hint' }, `只显示最近 ${receipts.length} 条，共 ${total} 条回执。`)
          : null,
        warnings.length > 0 || dataGaps.length > 0
          ? h(
              'details',
              { className: 'dc-details' },
              h('summary', null, `数据提示 ${warnings.length + dataGaps.length} 条`),
              h(
                'ul',
                null,
                warnings.map((item, index) =>
                  h('li', { key: `warning${index}` }, `读取异常：${(item && item.message) || item}`),
                ),
                dataGaps.map((item, index) =>
                  h('li', { key: `gap${index}` }, `数据缺口：${(item && item.message) || item}`),
                ),
              ),
            )
          : null,
      )
    }

    function LedgerRow(props) {
      const receipt = props.receipt || {}
      const statusKey = receipt.status || 'unknown'
      const tone = STATUS_TONE[statusKey] || 'unknown'
      const statusText = STATUS_TEXT[statusKey] || statusKey
      const stageName = receipt.stageName || STAGE_TEXT[receipt.stage] || receipt.stage || '未知阶段'
      const artifacts = asArray(receipt.artifacts)
      const meta = []
      if (receipt.iterationId) meta.push(receipt.iterationId)
      if (receipt.usedSkill) meta.push(`用了 ${receipt.usedSkill}`)
      if (receipt.taskRef) meta.push(`任务 ${receipt.taskRef}`)
      if (artifacts.length > 0) meta.push(`${artifacts.length} 个产物`)
      return h(
        'li',
        { className: 'dc-ledger-item' },
        h(
          'div',
          { className: 'dc-ledger-head' },
          h('span', { className: 'dc-ledger-stage' }, stageName),
          h(Chip, { tone }, statusText),
          receipt.needsDecision ? h(Chip, { tone: 'warn' }, '待决策') : null,
          h('span', { className: 'dc-ledger-when', title: receipt.at ? new Date(receipt.at).toLocaleString() : '' }, formatRelative(receipt.at)),
        ),
        h('p', { className: 'dc-ledger-summary' }, receipt.summary || '（这条回执没写人话摘要）'),
        meta.length > 0 ? h('div', { className: 'dc-ledger-meta' }, meta.join(' · ')) : null,
      )
    }

    // ---------- 详情页 ----------

    function DetailPage(props) {
      const panel = props.panel || {}
      const project = panel.project || {}
      const ledger = panel.ledger || {}
      const action = panel.nextAction || {}
      const degraded = Boolean(panel.degraded && panel.degraded.flag)
      const degradedReasons = asArray(panel.degraded && panel.degraded.reasons)
      const badLines = Number(ledger.badLines) || 0
      const [initResult, setInitResult] = React.useState(null)

      const lastAt = ledger.lastAt || (asArray(ledger.receipts)[0] && asArray(ledger.receipts)[0].at) || null
      const engineText = degraded || props.panelError ? '数据待确认' : '引擎正常'
      const engineTone = degraded || props.panelError ? 'unknown' : 'ok'

      const header = h(
        'header',
        { className: 'dc-head' },
        h(
          'div',
          { className: 'dc-head-inner' },
          h(
            'button',
            { type: 'button', className: 'dc-btn dc-btn-ghost', onClick: props.backToOverview },
            '← 全部项目',
          ),
          h('h1', { className: 'dc-title' }, project.name || baseName(project.path) || '项目'),
          h(Chip, { tone: engineTone }, engineText),
          action.kind === 'decide' ? h(Chip, { tone: 'warn' }, '待决策') : null,
          h(
            'span',
            { className: 'dc-sub' },
            `${(project.stack && project.stack.label) || '未检测到技术栈'} · ${panel.iteration && panel.iteration.current ? panel.iteration.current : '未开始迭代'}`,
          ),
          h('span', { className: 'dc-spacer' }),
          panel.generatedAt
            ? h('span', { className: 'dc-sub dc-time' }, `更新于 ${formatTime(panel.generatedAt)}`)
            : null,
          props.panelLoading ? h('span', { className: 'dc-sr', role: 'status' }, '正在刷新') : null,
          h(
            'button',
            {
              type: 'button',
              className: 'dc-btn',
              onClick: props.refresh,
              disabled: props.panelLoading,
              'aria-busy': props.panelLoading ? 'true' : 'false',
            },
            props.panelLoading ? '刷新中…' : '刷新',
          ),
        ),
      )

      const stale = props.panelError
        ? h(
            Banner,
            {
              tone: 'error',
              role: 'alert',
              title: props.goodAt
                ? `刷新失败，下面是 ${formatTime(props.goodAt)} 的数据`
                : '读取面板失败',
              action: h('button', { type: 'button', className: 'dc-btn', onClick: props.refresh }, '重试'),
            },
            h('div', { className: 'dc-hint' }, explainError(props.panelError)),
          )
        : null

      const initBanner = initResult
        ? h(
            Banner,
            { tone: 'ok', title: initResult.applied ? '初始化完成' : '已经初始化过，没有写入新文件' },
            h(
              'div',
              null,
              asArray(initResult.created).length > 0
                ? `创建 ${asArray(initResult.created).length} 项：${asArray(initResult.created).join('、')}`
                : '没有新建文件。',
              asArray(initResult.skipped).length > 0
                ? ` 跳过 ${asArray(initResult.skipped).length} 项（已存在）。`
                : '',
            ),
            initResult.gitignoreHint
              ? h('div', null, '建议加进 .gitignore：', h('code', { className: 'dc-code' }, initResult.gitignoreHint))
              : null,
          )
        : null

      return h(
        'div',
        { className: 'dc-root' },
        header,
        h(
          'main',
          { className: 'dc-body', 'aria-busy': props.panelLoading ? 'true' : 'false' },
          stale,
          initBanner,
          badLines > 0
            ? h(
                'section',
                { className: 'dc-banner', role: 'status' },
                h(
                  'div',
                  { className: 'dc-banner-title' },
                  '账本存在损坏行（已降级显示）',
                ),
                h('div', { className: 'dc-hint' }, `有 ${badLines} 行不是合法回执，已跳过；下面的统计可能偏低。`),
              )
            : null,
          degraded
            ? h(
                Banner,
                {
                  tone: 'error',
                  role: 'alert',
                  title: '数据待确认：读取有异常，先别按下一步行动',
                },
                h(
                  'ul',
                  { className: 'dc-banner-list' },
                  degradedReasons.length > 0
                    ? degradedReasons.map((reason, index) =>
                        h(
                          'li',
                          { key: `reason${index}` },
                          `${(reason && reason.source) || '未知来源'}：${(reason && reason.message) || '读取失败'}`,
                        ),
                      )
                    : h('li', null, '服务端报告降级，但没有给出原因。'),
                ),
              )
            : null,
          h(ProjectSection, {
            project,
            trellis: panel.trellis,
            iteration: panel.iteration,
            ledger,
            action,
            degraded,
          }),
          h(NextActionSection, {
            action,
            degraded,
            iteration: panel.iteration,
            projectPath: project.path || props.selectedPath,
            onApplied: (result) => {
              setInitResult(result)
              props.refresh()
            },
            onApproved: () => props.refresh(),
          }),
          h(ProgressionSection, {
            progression: panel.progression,
            iteration: panel.iteration,
            action,
            acceptance: panel.acceptance,
            review: panel.review,
            tasks: panel.tasks,
          }),
          h(LedgerSection, {
            ledger,
            warnings: panel.warnings,
            dataGaps: panel.dataGaps,
          }),
          h(
            'footer',
            { className: 'dc-foot' },
            h('span', { className: 'dc-foot-item' }, '主会话活跃 ', h('span', { className: 'dc-foot-value' }, '—')),
            h('span', { className: 'dc-foot-item' }, '引擎 ', h('span', { className: 'dc-foot-value' }, engineText)),
            h(
              'span',
              { className: 'dc-foot-item' },
              '上次回执 ',
              h('span', { className: 'dc-foot-value' }, lastAt ? formatRelative(lastAt) : '—'),
            ),
            h(
              'button',
              { type: 'button', className: 'dc-btn', onClick: props.refresh, disabled: props.panelLoading },
              '刷新',
            ),
          ),
        ),
      )
    }

    // ---------- 入口：错误兜底 + 视图切换 ----------

    function Page() {
      const cockpit = useCockpit()
      React.useEffect(() => {
        ensureStyles()
      }, [])

      if (cockpit.view === 'detail') {
        if (!cockpit.panel) {
          if (cockpit.panelError) {
            return h(StatePage, {
              title: '读取项目失败',
              body: explainError(cockpit.panelError),
              onRetry: cockpit.refresh,
              onBack: cockpit.backToOverview,
              loading: cockpit.panelLoading,
            })
          }
          return h(SkeletonPage)
        }
        return h(DetailPage, {
          panel: cockpit.panel,
          selectedPath: cockpit.selectedPath,
          panelLoading: cockpit.panelLoading,
          panelError: cockpit.panelError,
          goodAt: cockpit.goodAt,
          refresh: cockpit.refresh,
          backToOverview: cockpit.backToOverview,
        })
      }

      return h(OverviewPage, {
        projects: cockpit.projects,
        overviewAt: cockpit.overviewAt,
        overviewLoading: cockpit.overviewLoading,
        overviewError: cockpit.overviewError,
        openProject: cockpit.openProject,
        refresh: cockpit.refresh,
      })
    }

    // 渲染期异常（服务端字段缺失等）不能让面板白屏：兜住并给一句可读原因。
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        if (this.state.error) {
          const message = messageOf(this.state.error)
          return h(
            'div',
            { className: 'dc-root' },
            h(
              'div',
              { className: 'dc-banner dc-banner-error', role: 'alert' },
              h('span', null, `面板渲染失败：${message}`),
              h(
                'button',
                { type: 'button', className: 'dc-btn', onClick: () => this.setState({ error: null }) },
                '重试',
              ),
            ),
          )
        }
        return this.props.children
      }
    }

    function PanelRoot() {
      return h(Boundary, null, h(Page))
    }

    return {
      // `styles` 是模块级 builtin，不是 cordis 服务：写进 inject 会让整个插件激活失败。
      inject: ['slots'],
      apply(ctx) {
        ensureStyles()
        // 槽声明由宿主条目稍后就绪，且声明收拢/恢复时会重建：
        // 用 slots.inject 在声明可用时注册、收拢时自动释放；直接 register 有时序注册不上的风险。
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, PanelRoot))
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => '交付' },
            Icon,
          ),
        )
      },
    }
  },
})
