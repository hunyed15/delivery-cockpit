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

    // 功能状态是 Host 三路证据推导的结果：界面只把 status/statusLabel 如实画出来，不自己推断。
    const FEATURE_STATUS_TEXT = {
      done: '已完成',
      blocked: '有阻塞',
      'in-progress': '进行中',
      'pending-acceptance': '待验收',
      'not-started': '未开始',
      unknown: '—',
    }
    const FEATURE_STATUS_TONE = {
      done: 'ok',
      blocked: 'bad',
      'in-progress': 'brand',
      'pending-acceptance': 'warn',
      'not-started': 'idle',
      unknown: 'unknown',
    }
    const SEVERITY_TEXT = { critical: '严重', important: '重要', minor: '次要' }
    const STRATEGY_TEXT = { 'fr-section': '功能需求节', 'fr-global': '全文扫描', none: '未识别' }

    // 验收结果：面板内可直接点（写动作走 POST /acceptance-result）。
    const ACCEPTANCE_RESULT_TEXT = { pass: '通过', fail: '失败', blocked: '阻塞' }
    const ACCEPTANCE_RESULT_TONE = { pass: 'ok', fail: 'bad', blocked: 'warn' }
    const ACCEPTANCE_ERROR_TEXT = {
      'item-required': '缺少验收项 ID，刷新面板再试。',
      'bad-result': '结果只能是 通过 / 失败 / 阻塞 / 撤销。',
      'evidence-required': '通过必须附证据。',
      'evidence-not-found': '证据文件不存在：先确认路径。',
      'acceptance-broken': '验收表不是合法 JSON，先修好。',
      'iteration-mismatch': '验收表属于别的迭代。',
      'iteration-required': '当前迭代还没确定。',
      'item-not-found': '这条验收项已不存在，刷新面板。',
      'workspace-not-allowed': '这个工作区不在已登记列表里。',
    }

    function explainAcceptanceError(raw) {
      const message = String(raw == null ? '' : raw)
      for (const [code, text] of Object.entries(ACCEPTANCE_ERROR_TEXT)) {
        if (message.indexOf(code) >= 0) return text
      }
      return explainError(message)
    }

    // 浏览器截图：只挂证据、不改 result（截了图 ≠ 验过了）。
    const SHOT_ERROR_TEXT = {
      'item-required': '缺少验收项 ID，刷新面板再试。',
      'no-url': '先填预览地址（或把 previewUrl 写进 .dsh/plugin-state/project.json）',
      'invalid-url': '预览地址格式不对，检查一下（要带 http:// 或 https://）。',
      'url-not-loopback': '只允许截本机地址（127.0.0.1 / localhost）',
      'browser-not-found': '本机没找到 Chrome/Edge，截图需要本机浏览器；也可手工把图放进项目再点「编辑」填路径',
      timeout: '截图超时：页面太慢或浏览器没起来',
      'acceptance-broken': '验收表不是合法 JSON，先修好。',
      'iteration-mismatch': '验收表属于别的迭代。',
      'iteration-required': '当前迭代还没确定。',
      'item-not-found': '这条验收项已不存在，刷新面板。',
      'workspace-not-allowed': '这个工作区不在已登记列表里。',
    }

    function explainShotError(raw) {
      const message = String(raw == null ? '' : raw)
      for (const [code, text] of Object.entries(SHOT_ERROR_TEXT)) {
        if (message.indexOf(code) >= 0) return text
      }
      // capture-failed / browser-failed 的可读原因在 detail 里（requestJson 已拼进 message）。
      if (/capture-failed|browser-failed/.test(message)) {
        const detail = message.replace(/^(?:capture-failed|browser-failed):?\s*/, '')
        return `截图失败：${detail && detail.indexOf('capture-failed') < 0 && detail.indexOf('browser-failed') < 0 ? detail : '浏览器执行出错，稍后重试'}`
      }
      return explainAcceptanceError(message)
    }

    // 视觉回归：Host 每次截图都会与「该验收项的上一张截图」做像素对比。
    // 界面只如实呈现 verdict / ratio / reason，绝不把 different-size 说成「没变化」。
    const DIFF_VERDICT_TEXT = {
      new: '新增基线',
      same: '与上一版一致',
      changed: '有变化',
      'different-size': '尺寸变了',
      uncomparable: '无法对比',
    }
    const DIFF_VERDICT_TONE = {
      new: 'unknown',
      same: 'ok',
      changed: 'warn',
      'different-size': 'warn',
      uncomparable: 'unknown',
    }
    const DIFF_REASON_TEXT = {
      'baseline-missing': '上一张截图文件已不在',
      'baseline-url': '上一版是 URL 证据，不能像素对比',
      'baseline-outside-project': '上一版截图在项目外，不能像素对比',
      'baseline-not-png': '上一版不是 PNG 截图（只支持 PNG 像素对比）',
      'baseline-bad-png': '上一版截图文件损坏或格式不支持',
      'baseline-too-large': '上一版截图超过 10 MiB，不做像素对比',
      'baseline-unreadable': '上一版截图读不出来',
    }

    function explainDiffReason(reason) {
      const message = String(reason == null ? '' : reason)
      if (message === '') return '没有给出原因'
      for (const [code, text] of Object.entries(DIFF_REASON_TEXT)) {
        if (message.indexOf(code) >= 0) return text
      }
      return `解析失败（${message}）`
    }

    function diffPercent(ratio) {
      const value = Number(ratio)
      if (!Number.isFinite(value)) return '—'
      return `${(value * 100).toFixed(2)}%`
    }

    function diffVerdictText(diff) {
      const verdict = diff && diff.verdict
      if (verdict === 'changed') return `有变化 ${diffPercent(diff.ratio)}`
      if (verdict === 'different-size') {
        const size = diff.width && diff.height ? `（${diff.width}×${diff.height}）` : ''
        return `尺寸变了${size}`
      }
      return DIFF_VERDICT_TEXT[verdict] || '无法对比'
    }

    function diffTitle(diff) {
      if (!diff) return ''
      const parts = []
      if (diff.at) parts.push(`时间：${new Date(diff.at).toLocaleString()}`)
      if (diff.reason) parts.push(`原因：${explainDiffReason(diff.reason)}`)
      if (diff.changedPixels != null && diff.totalPixels) {
        parts.push(`变化像素：${diff.changedPixels}/${diff.totalPixels}`)
      }
      return parts.join('\n')
    }

    // 截图返回的 shot.comparison 直接变成行内提示，不需要再等刷新。
    function comparisonMessage(comparison) {
      if (!comparison || !comparison.verdict) return '已截图并附到证据'
      const verdict = comparison.verdict
      if (verdict === 'changed') return `已截图 · 与上一版有变化 ${diffPercent(comparison.ratio)}`
      if (verdict === 'same') return '已截图 · 与上一版一致'
      if (verdict === 'new') return '已截图 · 已建立基线'
      if (verdict === 'different-size') return '已截图 · 尺寸变了'
      return `已截图 · 无法对比（${explainDiffReason(comparison.reason)}）`
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

    async function requestJson(url, options, timeoutMs) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), Number(timeoutMs) || REQUEST_TIMEOUT_MS) : null
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
        if (!response.ok) {
          // Host 失败时可能带 detail（截图/浏览器类错误）：保留它，界面才能显示可排查的原因。
          const code = (body && body.error) || `HTTP ${response.status}`
          const detail = body && body.detail
          throw new Error(detail ? `${code}: ${detail}` : String(code))
        }
        // 200 + 非 JSON（登录页拦截、代理改写）必须报错，否则界面会永远停在「加载中」。
        if (body === null) throw new Error('响应不是 JSON，可能被登录页或代理拦截')
        if (body.ok === false) {
          const detail = body.detail
          throw new Error(detail ? `${body.error || '请求失败'}: ${detail}` : body.error || '请求失败')
        }
        return body
      } catch (error) {
        if (error && error.name === 'AbortError') throw new Error('请求超时')
        throw error
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    async function postJson(url, payload, timeoutMs) {
      return requestJson(
        url,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload),
        },
        timeoutMs,
      )
    }

    // ---------- 样式（全局只注入一次；面板/详情是同一个挂载点） ----------

    const CSS = `
/* ==========================================================================
   交付驾驶舱 · 安静的仪表盘工艺
   - 单栏 1040px；区之间 24px 留白 + hairline，不再卡片套卡片
   - 字体层级 20 / 15 / 13 / 12 / 11；正文 13/1.6
   - 颜色只用 host token；语义色只给状态
   - 所有交互件统一 30px 高、focus ring、150ms ease-out
   ========================================================================== */

.dc-root {
  height:100%; overflow:auto;
  color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base);
  font-family:ui-sans-serif,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  font-size:13px; line-height:1.6; -webkit-font-smoothing:antialiased;
  scrollbar-width:thin; scrollbar-color:var(--dsw-alias-border-l2) transparent;
  container-type:inline-size;
}
.dc-root *, .dc-root *::before, .dc-root *::after { box-sizing:border-box; }
.dc-root ::selection { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 24%, transparent); }
.dc-root::-webkit-scrollbar { width:10px; height:10px; }
.dc-root::-webkit-scrollbar-thumb { background:var(--dsw-alias-border-l2); border-radius:999px; border:3px solid transparent; background-clip:content-box; }
.dc-root::-webkit-scrollbar-track { background:transparent; }
.dc-sr { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }

/* ---------- 顶栏 ---------- */
.dc-head {
  position:sticky; top:0; z-index:5;
  /* 不用 backdrop-filter：粘性顶栏用不透明底色即可，玻璃质感在 Operate 里是装饰。 */
  background:var(--dsw-alias-bg-base);
  border-bottom:1px solid var(--dsw-alias-border-l1);
}
.dc-head-inner {
  max-width:1180px; margin:0 auto; padding:14px 20px;
  display:flex; align-items:center; gap:10px; flex-wrap:wrap; min-width:0;
}
.dc-head-inner > * { min-width:0; }
h1.dc-title { margin:0; font-size:15px; line-height:1.35; font-weight:600; letter-spacing:-.01em; overflow-wrap:anywhere; }
.dc-sub { color:var(--dsw-alias-label-secondary); font-size:12px; min-width:0; overflow-wrap:anywhere; }
.dc-time { font-variant-numeric:tabular-nums; font-feature-settings:"tnum"; }
.dc-spacer { flex:1 1 auto; }

/* ---------- 页面骨架 ---------- */
.dc-body { max-width:1180px; margin:0 auto; padding:24px 20px 48px; display:flex; flex-direction:column; }
.dc-card {
  min-width:0; margin:0; padding:28px 0 20px;
  border:0; border-top:1px solid var(--dsw-alias-border-l1); border-radius:0; background:transparent;
}
.dc-body > .dc-card:first-of-type { padding-top:0; border-top:0; }
.dc-card:last-of-type { padding-bottom:8px; border-bottom:0; }
.dc-card-title { margin:0 0 12px; font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); }
.dc-section-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; flex-wrap:wrap; margin:0 0 12px; }
/* ② 是整页唯一的焦点面（surface）：浅色一层底 + 1px 边 + 12 圆角。 */
.dc-hero {
  margin-top:28px !important; padding:20px !important;
  border:1px solid var(--dsw-alias-border-l1) !important; border-radius:12px;
  background:var(--dsw-alias-bg-layer-1);
}
.dc-hero .dc-section-head { margin-bottom:10px; }
.dc-section-title { margin:0; font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); letter-spacing:-.005em; }
.dc-section-meta { font-size:11.5px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; font-feature-settings:"tnum"; }

/* ---------- 按钮体系：30px / radius 8 / 13·600 ---------- */
.dc-btn {
  appearance:none; display:inline-flex; align-items:center; justify-content:center; gap:6px;
  height:30px; padding:0 12px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2);
  background:transparent; color:var(--dsw-alias-label-primary);
  font:inherit; font-size:13px; font-weight:600; line-height:1; cursor:pointer; white-space:nowrap;
  transition:background-color .15s ease-out, border-color .15s ease-out, color .15s ease-out, transform .12s ease-out;
}
.dc-btn:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-1); border-color:var(--dsw-alias-label-secondary); }
.dc-btn:active:not(:disabled) { transform:translateY(1px); }
.dc-btn:disabled { opacity:.5; cursor:not-allowed; }
.dc-btn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.dc-btn-primary { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-bg-base); }
.dc-btn-primary:hover:not(:disabled) { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-bg-base); filter:brightness(1.08); }
.dc-btn-ghost { border-color:transparent; background:transparent; color:var(--dsw-alias-label-secondary); padding:0 8px; }
.dc-btn-ghost:hover:not(:disabled) { color:var(--dsw-alias-brand-primary); border-color:transparent; background:transparent; }
.dc-btn-danger { border-color:transparent; background:transparent; color:var(--dsw-alias-state-error-primary); padding:0 8px; }
.dc-btn-danger:hover:not(:disabled) { background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); border-color:transparent; color:var(--dsw-alias-state-error-primary); }
.dc-btn-sm { height:26px; padding:0 10px; font-size:12px; border-radius:7px; }
.dc-diff-link, .dc-btn-link {
  appearance:none; border:0; background:transparent; padding:0; font:inherit; font-size:12px;
  color:var(--dsw-alias-brand-primary); text-decoration:underline; text-underline-offset:3px; cursor:pointer;
}
.dc-diff-link:focus-visible, .dc-btn-link:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; border-radius:3px; }

/* ---------- 状态 chip / 优先级 / 失效标记 ---------- */
.dc-chip {
  display:inline-flex; align-items:center; gap:5px; height:22px; padding:0 8px;
  border:1px solid var(--dsw-alias-border-l1); border-radius:6px;
  background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary);
  font-size:11.5px; font-weight:600; white-space:nowrap; max-width:100%;
}
.dc-chip::before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor; flex:none; }
.dc-chip-ok { color:var(--dsw-alias-state-success-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 32%, transparent); background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent); }
.dc-chip-warn { color:var(--dsw-alias-state-warn-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 32%, transparent); background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent); }
.dc-chip-bad { color:var(--dsw-alias-state-error-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 32%, transparent); background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.dc-chip-brand { color:var(--dsw-alias-brand-primary); border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 32%, transparent); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent); }
.dc-chip-idle { color:var(--dsw-alias-state-idle-primary); }
.dc-chip-unknown { color:var(--dsw-alias-label-secondary); border-style:dashed; }
.dc-pri { display:inline-flex; align-items:center; height:18px; padding:0 5px; border-radius:4px;
  border:1px solid currentColor; font-size:10px; font-weight:600; font-variant-numeric:tabular-nums; flex:none; }
.dc-pri-p0 { color:var(--dsw-alias-state-error-primary); }
.dc-pri-p1 { color:var(--dsw-alias-state-warn-primary); }
.dc-stale-title { color:var(--dsw-alias-state-warn-primary); font-weight:600; font-variant-numeric:tabular-nums; }
.dc-stale-tag { display:inline-flex; align-items:center; height:20px; margin-left:6px; padding:0 6px;
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent); border-radius:5px;
  background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);
  color:var(--dsw-alias-state-warn-primary); font-size:10.5px; font-weight:600; white-space:nowrap; }
.dc-stale-note { margin:0 0 8px; padding:8px 10px; border-radius:7px;
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent);
  background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary); font-size:12px; overflow-wrap:anywhere; }

/* ---------- 横幅 ---------- */
.dc-banner {
  display:flex; flex-direction:column; gap:6px; padding:12px 14px; border-radius:8px;
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 38%, transparent);
  background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent);
  color:var(--dsw-alias-label-primary); font-size:12.5px;
}
.dc-banner-error { border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 38%, transparent); background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.dc-banner-ok { border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 38%, transparent); background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent); }
.dc-banner-title { font-weight:600; font-size:12.5px; color:var(--dsw-alias-state-warn-primary); }
.dc-banner-error .dc-banner-title { color:var(--dsw-alias-state-error-primary); }
.dc-banner-ok .dc-banner-title { color:var(--dsw-alias-state-success-primary); }
.dc-banner-list { margin:0; padding-left:18px; display:flex; flex-direction:column; gap:3px; overflow-wrap:anywhere; }
.dc-banner-row { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }

/* ---------- ① 项目名片 & 迭代头 ---------- */
.dc-name-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
h2.dc-name { margin:0; font-size:20px; line-height:1.3; font-weight:650; letter-spacing:-.015em; overflow-wrap:anywhere; }
.dc-one-liner { margin:6px 0 0; font-size:13px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.dc-one-liner-empty { color:var(--dsw-alias-state-warn-primary); }
.dc-meta-line { margin-top:10px; display:flex; align-items:baseline; gap:6px; flex-wrap:wrap; font-size:12px; color:var(--dsw-alias-label-secondary); }
.dc-meta-value { color:var(--dsw-alias-label-primary); overflow-wrap:anywhere; min-width:0; }
.dc-iter-row { margin-top:12px; padding-top:12px; border-top:1px solid var(--dsw-alias-border-l1);
  display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:12px; color:var(--dsw-alias-label-secondary); }
.dc-iter-value { color:var(--dsw-alias-label-primary); font-weight:600; font-variant-numeric:tabular-nums; }
.dc-code { font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace; font-size:12px;
  background:var(--dsw-alias-bg-layer-2); border-radius:5px; padding:1px 6px; overflow-wrap:anywhere; word-break:break-word; }

/* ---------- ② 唯一下一步（全页唯一 hero） ---------- */
.dc-action-eyebrow { font-size:11px; font-weight:600; letter-spacing:.06em; color:var(--dsw-alias-label-secondary); }
.dc-action-title { margin:4px 0 0; font-size:20px; font-weight:650; line-height:1.35; letter-spacing:-.015em; overflow-wrap:anywhere; max-width:44em; }
.dc-action-reason { margin:6px 0 0; font-size:13px; color:var(--dsw-alias-label-secondary); max-width:44em; overflow-wrap:anywhere; }
.dc-caps { margin-top:12px; display:flex; flex-direction:column; gap:6px; }
.dc-caps-label { font-size:11px; font-weight:600; letter-spacing:.04em; color:var(--dsw-alias-label-secondary); }
.dc-caps-row { display:flex; gap:6px; flex-wrap:wrap; }
.dc-cap { display:inline-flex; align-items:center; gap:6px; height:24px; padding:0 8px;
  border:1px solid var(--dsw-alias-border-l1); border-radius:6px; background:var(--dsw-alias-bg-layer-1);
  font-size:12px; max-width:100%; }
.dc-cap-name { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:11.5px; overflow-wrap:anywhere; }
.dc-cap-optional { color:var(--dsw-alias-label-secondary); font-size:11px; }
.dc-cap .dc-chip { height:18px; padding:0 6px; font-size:10.5px; border:0; background:transparent; }
.dc-cap .dc-chip::before { width:5px; height:5px; }
.dc-missing { margin-top:12px; padding:12px 14px; border-radius:8px; font-size:12.5px; overflow-wrap:anywhere;
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 38%, transparent);
  background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent); color:var(--dsw-alias-label-primary); }
.dc-missing ul { margin:5px 0 0; padding-left:18px; display:flex; flex-direction:column; gap:3px; overflow-wrap:anywhere; }
.dc-instruction-box { margin-top:12px; }
.dc-instruction-label { font-size:11px; font-weight:600; letter-spacing:.04em; color:var(--dsw-alias-label-secondary); margin-bottom:6px; }
.dc-instruction { margin:0; padding:12px 14px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px;
  background:var(--dsw-alias-bg-layer-1); font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
  font-size:12px; line-height:1.7; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; max-width:100%; }
.dc-action-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:16px; }
.dc-action-row > * { min-width:0; }
.dc-action-row > .dc-missing, .dc-action-row > .dc-plan { flex:1 0 100%; }
.dc-hint { font-size:12px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.dc-hint-bad { color:var(--dsw-alias-state-error-primary); }
.dc-hint-ok { color:var(--dsw-alias-state-success-primary); }
.dc-approve { display:inline-flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0; }
.dc-notes { margin:10px 0 0; padding-left:18px; font-size:11.5px; color:var(--dsw-alias-label-secondary);
  display:flex; flex-direction:column; gap:3px; overflow-wrap:anywhere; }
.dc-plan { margin-top:12px; border:1px dashed var(--dsw-alias-border-l2); border-radius:8px;
  padding:12px 14px; display:flex; flex-direction:column; gap:8px; font-size:12.5px; background:var(--dsw-alias-bg-layer-1); }
.dc-plan-title { font-weight:600; }
.dc-plan-list { margin:0; padding-left:18px; display:flex; flex-direction:column; gap:3px; overflow-wrap:anywhere; }
.dc-plan-list li { min-width:0; overflow-wrap:anywhere; }
.dc-plan-item-exists { color:var(--dsw-alias-label-secondary); }
.dc-plan-item-create { color:var(--dsw-alias-state-success-primary); }

/* ---------- ③ 迭代进度 ---------- */
.dc-progress-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:0 0 16px; font-size:12px; color:var(--dsw-alias-label-secondary); }
.dc-progress-label { font-size:11px; font-weight:600; letter-spacing:.04em; }
.dc-progress-value { font-size:15px; font-weight:650; color:var(--dsw-alias-label-primary); font-variant-numeric:tabular-nums; font-feature-settings:"tnum"; }
.dc-progress-bar { flex:1 1 160px; max-width:280px; height:4px; border-radius:999px; background:var(--dsw-alias-bg-layer-2); overflow:hidden; }
.dc-progress-fill { display:block; height:100%; border-radius:999px; background:var(--dsw-alias-brand-primary); transition:width .16s ease-out; }
.dc-track-label { margin:16px 0 8px; font-size:11px; font-weight:600; letter-spacing:.04em; color:var(--dsw-alias-label-secondary); }
.dc-track { position:relative; display:flex; align-items:flex-start; margin:0; padding:0; list-style:none; }
.dc-track::before { content:""; position:absolute; left:9px; right:9px; top:9px; height:1px; background:var(--dsw-alias-border-l2); }
.dc-stage { position:relative; flex:1 1 0; min-width:0; display:flex; flex-direction:column; gap:2px;
  padding:0 12px 0 0; border:0; border-radius:0; background:transparent; }
.dc-stage-dot { position:relative; z-index:1; width:18px; height:18px; border-radius:50%;
  display:inline-flex; align-items:center; justify-content:center; flex:none;
  border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-base);
  font-size:10px; line-height:1; font-weight:700; color:transparent; }
.dc-stage-name { margin-top:4px; font-size:12px; font-weight:500; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.dc-stage-state { font-size:11px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
.dc-stage-done .dc-stage-dot { border-color:var(--dsw-alias-state-success-primary); background:var(--dsw-alias-state-success-primary); color:var(--dsw-alias-bg-base); }
.dc-stage-done .dc-stage-name { color:var(--dsw-alias-label-primary); }
.dc-stage-current .dc-stage-dot { border:2px solid var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-base); box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
.dc-stage-current .dc-stage-name { color:var(--dsw-alias-brand-primary); font-weight:600; }
.dc-stage-current .dc-stage-state { color:var(--dsw-alias-brand-primary); font-weight:600; }
.dc-stage-pending { opacity:.72; }

/* ---------- ④ 功能账 & 缺陷账 ---------- */
.dc-decision { margin:0 0 12px; padding:12px 14px; border-radius:8px;
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 38%, transparent);
  background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent); }
.dc-decision-title { font-weight:600; color:var(--dsw-alias-state-warn-primary); overflow-wrap:anywhere; }
.dc-decision-options { margin:6px 0 0; padding-left:18px; font-size:12.5px; display:flex; flex-direction:column; gap:3px; overflow-wrap:anywhere; }
.dc-decision-reco { margin-top:6px; font-size:12px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.dc-board-meta { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:12px; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.dc-board-counts { color:var(--dsw-alias-label-primary); font-weight:600; font-variant-numeric:tabular-nums; }
.dc-table-wrap { max-width:100%; overflow-x:auto; scrollbar-width:thin; scrollbar-color:var(--dsw-alias-border-l2) transparent; }
.dc-table-wrap::-webkit-scrollbar { height:8px; }
.dc-table-wrap::-webkit-scrollbar-thumb { background:var(--dsw-alias-border-l2); border-radius:999px; border:2px solid transparent; background-clip:content-box; }
.dc-table-wrap::-webkit-scrollbar-track { background:transparent; }
.dc-table { width:100%; min-width:640px; border-collapse:separate; border-spacing:0; font-size:13px; }
.dc-table th {
  text-align:left; font-size:11px; font-weight:600; letter-spacing:.04em; color:var(--dsw-alias-label-secondary);
  padding:9px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1);
  white-space:nowrap;
}
.dc-table td { padding:12px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); vertical-align:top; font-size:13px; }
.dc-table tbody tr:hover td { background:var(--dsw-alias-bg-layer-1); }
.dc-table tbody tr:last-child td { border-bottom:0; }
.dc-num { text-align:right; font-variant-numeric:tabular-nums; font-feature-settings:"tnum"; }
.dc-cell-mono { font-variant-numeric:tabular-nums; font-feature-settings:"tnum"; }
.dc-cell-bad { color:var(--dsw-alias-state-error-primary); font-weight:600; }
.dc-last-cell { color:var(--dsw-alias-label-secondary); font-size:12.5px; }
.dc-feature-cell { display:flex; align-items:baseline; gap:6px; flex-wrap:wrap; min-width:0; }
.dc-row-toggle { appearance:none; border:0; background:transparent; color:inherit; font:inherit; padding:0;
  display:inline-flex; align-items:center; gap:6px; cursor:pointer; text-align:left; min-width:0; }
.dc-row-toggle:hover .dc-feature-title { color:var(--dsw-alias-brand-primary); }
.dc-row-toggle:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; border-radius:4px; }
.dc-caret { color:var(--dsw-alias-label-secondary); font-size:10px; flex:none; width:8px; }
.dc-feature-id { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:11.5px; color:var(--dsw-alias-label-secondary); flex:none; }
.dc-feature-title { font-weight:600; font-size:13px; overflow-wrap:anywhere; }
.dc-feature-detail-row td { background:var(--dsw-alias-bg-layer-1); padding:12px 14px; }
.dc-feature-detail { display:flex; flex-direction:column; gap:8px; font-size:12.5px; min-width:0; }
.dc-bug-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:5px; }
.dc-bug-item { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; min-width:0; }
.dc-bug-sev { font-size:11px; font-weight:600; flex:none; }
.dc-bug-sev-critical { color:var(--dsw-alias-state-error-primary); }
.dc-bug-sev-important { color:var(--dsw-alias-state-warn-primary); }
.dc-bug-sev-minor { color:var(--dsw-alias-label-secondary); }
.dc-bug-title { overflow-wrap:anywhere; }
.dc-bug-file { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:11px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.dc-path-row { font-size:12px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.dc-sub-title { margin:16px 0 8px; font-size:12px; font-weight:600; color:var(--dsw-alias-state-warn-primary); }
.dc-defects { margin-top:16px; padding-top:12px; border-top:1px solid var(--dsw-alias-border-l1); }
.dc-defects .dc-bug-list { margin-top:6px; }
.dc-empty-box { padding:16px; border:1px dashed var(--dsw-alias-border-l2); border-radius:8px;
  display:flex; flex-direction:column; gap:8px; background:var(--dsw-alias-bg-base); }
.dc-code-block { margin:0; padding:10px 12px; border:1px solid var(--dsw-alias-border-l1); border-radius:6px;
  background:var(--dsw-alias-bg-layer-1); font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
  font-size:12px; line-height:1.6; white-space:pre-wrap; overflow-wrap:anywhere; }
.dc-empty-line { margin:0; font-size:12.5px; color:var(--dsw-alias-label-secondary); }
.dc-notes { margin:8px 0 0; padding-left:18px; font-size:11.5px; color:var(--dsw-alias-label-secondary);
  display:flex; flex-direction:column; gap:3px; overflow-wrap:anywhere; }
.dc-details { margin-top:12px; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.dc-details summary { cursor:pointer; }
.dc-details summary:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; border-radius:3px; }
.dc-details ul { margin:6px 0 0; padding-left:18px; display:flex; flex-direction:column; gap:3px; overflow-wrap:anywhere; }

/* ---------- 验收清单 ---------- */
.dc-acceptance { margin-top:20px; padding-top:16px; border-top:1px solid var(--dsw-alias-border-l1); }
.dc-acceptance > summary { cursor:pointer; font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); padding:0 0 8px; }
.dc-acceptance > summary:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; border-radius:3px; }
.dc-acceptance .dc-table-wrap { margin-top:8px; }
.dc-acc-table { min-width:820px; }
.dc-acc-table th:first-child { width:28%; }
.dc-acc-table th:nth-child(2), .dc-acc-table td:nth-child(2) { width:64px; white-space:nowrap; }
.dc-acc-table th:nth-child(3), .dc-acc-table td:nth-child(3) { width:104px; white-space:nowrap; }
/* 操作列按内容定宽，四个动作在 1200 宽必须排成一行。 */
.dc-acc-table th:nth-child(5), .dc-acc-table td:nth-child(5) { width:1%; white-space:nowrap; }
.dc-acc-id { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:11.5px; color:var(--dsw-alias-label-secondary); margin-right:6px; }
.dc-acc-title { font-weight:600; font-size:13px; overflow-wrap:anywhere; }
.dc-acc-steps { margin-top:2px; font-size:11.5px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere;
  display:-webkit-box; -webkit-line-clamp:1; -webkit-box-orient:vertical; overflow:hidden; }
.dc-acc-actions { display:flex; gap:4px; flex-wrap:nowrap; justify-content:flex-end; align-items:center; }
.dc-acc-actions .dc-btn { flex:none; }
.dc-acc-actions .dc-btn:hover:not(:disabled) { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); background:transparent; }
.dc-acc-actions .dc-btn-undo { margin-left:6px; }
.dc-acc-actions .dc-btn-danger:hover:not(:disabled) { border-color:transparent; border-left-color:var(--dsw-alias-border-l1); color:var(--dsw-alias-state-error-primary); }
.dc-acc-error { margin-top:4px; font-size:11.5px; color:var(--dsw-alias-state-error-primary); overflow-wrap:anywhere; }
.dc-acc-saved { margin-top:4px; font-size:11.5px; color:var(--dsw-alias-state-success-primary); }
.dc-evidence-summary { font-size:12px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.dc-evidence-actions { display:flex; gap:4px; flex-wrap:wrap; margin-top:6px; }
.dc-evidence-input { width:100%; min-width:180px; max-width:100%; min-height:30px; padding:5px 9px;
  border:1px solid var(--dsw-alias-border-l2); border-radius:7px; font:inherit; font-size:12.5px;
  background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); }
.dc-evidence-input::placeholder { color:var(--dsw-alias-label-secondary); }
.dc-evidence-input:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.dc-shot-box { margin-top:8px; display:flex; flex-direction:column; gap:6px; max-width:360px; }
.dc-shot-row { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
.dc-shot-url { width:100%; min-width:0; flex:none; }

/* ---------- 证据缩略图 / diff ---------- */
.dc-thumbs { display:flex; align-items:center; gap:5px; flex-wrap:wrap; margin-top:6px; }
.dc-thumb { appearance:none; padding:0; border:1px solid var(--dsw-alias-border-l1); border-radius:4px;
  background:var(--dsw-alias-bg-layer-1); width:28px; height:28px; overflow:hidden; cursor:pointer; flex:none;
  transition:border-color .15s ease-out, outline-color .15s ease-out; }
.dc-thumb img { width:100%; height:100%; object-fit:cover; display:block; }
.dc-thumb:hover { border-color:var(--dsw-alias-brand-primary); outline:2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent); outline-offset:1px; }
.dc-thumb:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.dc-thumb-more { font-size:11.5px; line-height:28px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
.dc-diff-row { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:8px; }
.dc-diff-btn { appearance:none; border:0; background:transparent; padding:0; font:inherit;
  display:inline-flex; align-items:center; gap:5px; cursor:pointer; flex:none; }
.dc-diff-btn:hover .dc-chip { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
.dc-diff-btn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; border-radius:4px; }
.dc-diff-thumb { width:28px; height:28px; }
.dc-diff-history { list-style:none; margin:6px 0 0; padding:0; display:flex; flex-direction:column; gap:4px;
  font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.dc-diff-history li { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; min-width:0; }
.dc-diff-history-at { font-variant-numeric:tabular-nums; font-feature-settings:"tnum"; white-space:nowrap; }
.dc-diff-history-verdict { color:var(--dsw-alias-label-primary); font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
.dc-scroll-hint { display:none; font-size:11px; color:var(--dsw-alias-label-secondary); margin-top:4px; }

/* ---------- 回执 ---------- */
.dc-receipts { margin-top:20px; padding-top:16px; border-top:1px solid var(--dsw-alias-border-l1); }
.dc-receipts > summary { cursor:pointer; font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); padding:0 0 8px; }
.dc-receipts > summary:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; border-radius:3px; }
.dc-ledger-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column;
  max-height:320px; overflow-y:auto; scrollbar-width:thin; }
.dc-ledger-item { min-width:0; border:0; border-bottom:1px solid var(--dsw-alias-border-l1); border-radius:0; padding:10px 0; background:transparent; }
.dc-ledger-item:last-child { border-bottom:0; }
.dc-ledger-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dc-ledger-stage { font-weight:600; font-size:12.5px; }
.dc-ledger-when { margin-left:auto; color:var(--dsw-alias-label-secondary); font-size:11.5px; font-variant-numeric:tabular-nums; font-feature-settings:"tnum"; }
.dc-ledger-summary { margin:3px 0 0; font-size:12.5px; overflow-wrap:anywhere; }
.dc-ledger-meta { margin-top:3px; font-size:11px; color:var(--dsw-alias-label-secondary); display:flex; gap:8px; flex-wrap:wrap; overflow-wrap:anywhere; }
.dc-notes { margin:8px 0 0; }

/* ---------- 底部 ---------- */
.dc-foot { border-top:1px solid var(--dsw-alias-border-l1); margin-top:24px; padding:14px 0 0;
  display:flex; align-items:center; gap:14px; flex-wrap:wrap; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.dc-foot-item { display:inline-flex; align-items:center; gap:6px; }
.dc-foot-value { color:var(--dsw-alias-label-primary); font-weight:600; font-variant-numeric:tabular-nums; }
.dc-foot .dc-btn { margin-left:auto; }

/* ---------- 两栏布局 / 摘要条 / 右栏 ---------- */
.dc-summary-bar {
  display:flex; align-items:center; gap:20px; flex-wrap:wrap;
  padding:10px 0 14px; margin:0 0 8px; border-bottom:1px solid var(--dsw-alias-border-l1);
}
.dc-summary-stat { display:inline-flex; align-items:baseline; gap:6px; white-space:nowrap; }
.dc-summary-label { font-size:11px; color:var(--dsw-alias-label-secondary); }
.dc-summary-value { font-size:13px; font-weight:600; font-variant-numeric:tabular-nums; font-feature-settings:"tnum"; color:var(--dsw-alias-label-primary); }
.dc-summary-bad { color:var(--dsw-alias-state-error-primary); }
.dc-summary-warn { color:var(--dsw-alias-state-warn-primary); }
.dc-summary-progress { flex:1 1 120px; min-width:60px; height:3px; border-radius:999px; background:var(--dsw-alias-bg-layer-2); overflow:hidden; }
.dc-summary-fill { display:block; height:100%; border-radius:999px; background:var(--dsw-alias-brand-primary); transition:width .15s ease-out; }

.dc-layout { display:grid; grid-template-columns:minmax(0,1fr); gap:20px; align-items:start; }
.dc-main { min-width:0; display:flex; flex-direction:column; container-type:inline-size; }
.dc-main > .dc-card:first-of-type { padding-top:0; border-top:0; }
.dc-main .dc-hero { margin-top:0 !important; }

.dc-rail {
  min-width:0; padding:16px; border:1px solid var(--dsw-alias-border-l1); border-radius:12px;
  background:var(--dsw-alias-bg-layer-1);
}
.dc-rail-group { min-width:0; }
.dc-rail-group + .dc-rail-group, .dc-rail-group + .dc-rail-details, .dc-decision + .dc-rail-group {
  border-top:1px solid var(--dsw-alias-border-l1); margin-top:14px; padding-top:14px;
}
.dc-rail-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; flex-wrap:wrap; margin-bottom:8px; }
.dc-rail-title { margin:0; font-size:12px; font-weight:600; color:var(--dsw-alias-label-primary); }
.dc-rail-meta { font-size:11px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
.dc-rail-note { margin:0; font-size:12px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.dc-rail-stats { display:flex; gap:14px; flex-wrap:wrap; font-size:11.5px; color:var(--dsw-alias-label-secondary); margin-bottom:6px; }
.dc-rail-num { color:var(--dsw-alias-label-primary); font-weight:600; font-variant-numeric:tabular-nums; }
.dc-rail-severe { margin-top:8px; padding-top:8px; border-top:1px dashed var(--dsw-alias-border-l1); font-size:11.5px; min-width:0; }
.dc-rail-severe-text { display:flex; align-items:baseline; gap:6px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dc-rail-severe-text .dc-bug-file { overflow:hidden; text-overflow:ellipsis; }
.dc-rail-foot { margin-top:10px; padding-top:10px; border-top:1px solid var(--dsw-alias-border-l1); font-size:11px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
.dc-rail-details { margin-top:14px; padding-top:14px; border-top:1px solid var(--dsw-alias-border-l1); font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.dc-rail-details summary { cursor:pointer; }
.dc-rail-details summary:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; border-radius:3px; }
.dc-rail-details ul { margin:6px 0 0; padding-left:16px; display:flex; flex-direction:column; gap:3px; overflow-wrap:anywhere; }
.dc-rail .dc-decision { margin:0; padding:0; border:0; background:transparent; }
.dc-rail .dc-decision-title { color:var(--dsw-alias-state-warn-primary); }
.dc-rail .dc-decision-options { margin-top:6px; }

/* 回执时间线 */
.dc-receipts-timeline { list-style:none; margin:0; padding:0; max-height:420px; overflow-y:auto; scrollbar-width:thin; }
.dc-timeline-item { display:grid; grid-template-columns:64px minmax(0,1fr); gap:10px; padding:8px 0; border-bottom:1px solid var(--dsw-alias-border-l1); }
.dc-timeline-item:last-child { border-bottom:0; }
.dc-timeline-when { font-size:11px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; padding-top:1px; }
.dc-timeline-body { min-width:0; display:flex; flex-direction:column; gap:2px; }
.dc-timeline-top { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.dc-timeline-stage { font-size:12px; font-weight:600; color:var(--dsw-alias-label-primary); }
.dc-timeline-top .dc-chip { height:18px; padding:0 6px; font-size:10px; border:0; background:transparent; }
.dc-timeline-top .dc-chip::before { width:5px; height:5px; }
.dc-timeline-summary {
  font-size:12px; color:var(--dsw-alias-label-secondary);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;
}

/* 验收：已通过折叠 / 冷启动压行 */
.dc-passed-fold { margin-top:16px; }
.dc-passed-fold > summary { cursor:pointer; font-size:12px; font-weight:600; color:var(--dsw-alias-label-secondary); padding:6px 0; }
.dc-passed-fold > summary:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; border-radius:3px; }
.dc-passed-fold .dc-table-wrap { margin-top:8px; }
.dc-cold-inline { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:0 0 16px; font-size:12px; color:var(--dsw-alias-label-secondary); }
.dc-cold-label { font-size:11px; font-weight:600; letter-spacing:.04em; }
.dc-cold-item { display:inline-flex; align-items:center; gap:4px; color:var(--dsw-alias-state-success-primary); font-weight:500; }

/* header 高 59（单行）；摘要条常驻在 header 下，右栏再让开摘要高度。 */
@container (min-width:641px) {
  .dc-summary-bar { position:sticky; top:59px; z-index:4; background:var(--dsw-alias-bg-base); }
}

/* 容器查询：面板实际宽度 ≥1040 时才分两栏（右栏 280px），避免与主区堆叠阈值混搭。 */
@container (min-width:1170px) {
  .dc-layout { grid-template-columns:minmax(0,1fr) 280px; }
  .dc-rail { position:sticky; top:106px; z-index:2; }
}

/* ---------- 总览 ---------- */
.dc-cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; }
.dc-ws-card { appearance:none; text-align:left; font:inherit; color:inherit; display:flex; flex-direction:column; gap:6px;
  min-width:0; padding:16px; border:1px solid var(--dsw-alias-border-l1); border-radius:10px;
  background:transparent; cursor:pointer;
  transition:border-color .15s ease-out, background-color .15s ease-out; }
.dc-ws-card:hover { border-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-1); }
.dc-ws-card:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.dc-ws-enter { display:inline-block; transition:transform .15s ease-out; }
.dc-ws-card:hover .dc-ws-enter { transform:translateX(2px); }
.dc-ws-top { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dc-ws-title { font-size:15px; font-weight:600; overflow-wrap:anywhere; }
.dc-ws-meta { font-size:12px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.dc-ws-next { font-size:13px; overflow-wrap:anywhere; }
.dc-ws-path { font-size:11px; color:var(--dsw-alias-label-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.dc-ws-foot { margin-top:4px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:11px; color:var(--dsw-alias-label-secondary); }

/* ---------- 状态页 / 骨架屏 ---------- */
.dc-state { max-width:460px; margin:48px auto; padding:28px; border:1px solid var(--dsw-alias-border-l1);
  border-radius:12px; background:var(--dsw-alias-bg-layer-1); text-align:center; }
h2.dc-state-title { margin:0 0 8px; font-size:15px; font-weight:600; }
.dc-state-body { margin:0 0 18px; font-size:13px; line-height:1.6; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.dc-skeleton { display:flex; flex-direction:column; gap:12px; }
.dc-skel { background:var(--dsw-alias-bg-layer-2); border-radius:8px; animation:dc-pulse 1.6s ease-in-out infinite; }
.dc-skel-line { height:14px; }
.dc-skel-card { height:88px; }
.dc-skel-rail { height:40px; }
@keyframes dc-pulse { 0%, 100% { opacity:.55; } 50% { opacity:1; } }

/* ---------- 动效 / 窄屏 ---------- */
@media (prefers-reduced-motion: reduce) {
  .dc-root *, .dc-root *::before, .dc-root *::after {
    animation-duration:.01ms !important; animation-iteration-count:1 !important;
    transition-duration:.01ms !important; scroll-behavior:auto !important;
  }
}
@container (max-width:640px) {
  .dc-head-inner { padding:12px 14px; }
  .dc-body { padding:20px 14px 40px; }
  .dc-card { padding-top:24px; padding-bottom:16px; }
  .dc-hero { margin-top:24px !important; padding:16px !important; }
  h1.dc-title { font-size:15px; }
  h2.dc-name, .dc-action-title { font-size:20px; }
  .dc-cards { grid-template-columns:1fr; }
  /* 轨道在窄屏换行成网格，避免 6 个节点挤出页面。 */
  .dc-track { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px 8px; }
  .dc-track::before { display:none; }
  .dc-stage { padding-right:0; }
  .dc-ledger-list { max-height:none; overflow:visible; }
}

/* 主列自己的容器：两栏时主列可能只有 560px，表格要按主列宽度而不是窗口宽度降级。 */
@container (max-width:700px) {
  .dc-scroll-hint { display:none; }
  /* 表格在主列过窄时改为堆叠块：不靠横滚，避免整行右侧被切掉 + 大片空白。 */
  .dc-table { display:block; min-width:0; width:100%; }
  .dc-table thead { display:none; }
  .dc-table tbody { display:flex; flex-direction:column; gap:10px; }
  .dc-table tbody > tr { display:block; padding:12px; border:1px solid var(--dsw-alias-border-l1); border-radius:10px; }
  .dc-table tbody tr:hover td { background:transparent; }
  .dc-table td { display:flex; align-items:baseline; gap:8px; width:auto !important; padding:2px 0; border:0; white-space:normal !important; }
  .dc-table td::before { content:attr(data-label); flex:0 0 52px; font-size:11px; color:var(--dsw-alias-label-secondary); }
  .dc-table td:first-child { display:block; padding:0 0 4px; }
  .dc-table td:first-child::before { display:none; }
  .dc-table td[colspan] { display:block; }
  .dc-table td[colspan]::before { display:none; }
  .dc-table tr.dc-feature-detail-row { padding:0; border:0; }
  .dc-acc-table tbody > tr { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px 10px; }
  .dc-acc-table td { display:block; }
  .dc-acc-table td:nth-child(1) { grid-column:1; grid-row:1; }
  .dc-acc-table td:nth-child(3) { grid-column:2; grid-row:1; justify-self:end; }
  .dc-acc-table td:nth-child(2) { grid-column:1 / -1; grid-row:2; }
  .dc-acc-table td:nth-child(4) { grid-column:1 / -1; grid-row:3; }
  .dc-acc-table td:nth-child(5) { grid-column:1 / -1; grid-row:4; }
  .dc-acc-table td:nth-child(2)::before,
  .dc-acc-table td:nth-child(4)::before,
  .dc-acc-table td:nth-child(5)::before { content:attr(data-label); font-size:10.5px; font-weight:600; letter-spacing:.04em; color:var(--dsw-alias-label-secondary); margin-right:6px; }
  .dc-acc-actions { flex-wrap:wrap; justify-content:flex-start; }
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

    // 区标题：左侧 13/600 主色，右侧 11.5 次要色元信息。四区共用同一规格。
    function SectionHead(props) {
      return h(
        'div',
        { className: 'dc-section-head' },
        h('h2', { className: 'dc-section-title' }, props.title),
        props.meta ? h('span', { className: 'dc-section-meta' }, props.meta) : null,
      )
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
            h('div', { className: 'dc-skel dc-skel-line' }),
            h('div', { className: 'dc-skel dc-skel-card' }),
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
      return h('span', { className: 'dc-hint dc-ws-enter', 'aria-hidden': 'true' }, '进入 →')
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
          h('span', { className: 'dc-section-meta' }, `共 ${projects.length} 个项目`),
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
          h('div', { className: 'dc-skel dc-skel-line' }),
          h('div', { className: 'dc-skel dc-skel-card' }),
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
        h(SectionHead, {
          title: '项目名片 & 迭代头',
          meta: `${stackLabel} · ${iteration.current || 'bootstrap'}`,
        }),
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
      // hero 里同一屏只允许一个实心 accent 按钮：有「复制指令」时初始化/确认降为描边次按钮。
      const primaryClass = props.primary === false ? 'dc-btn' : 'dc-btn dc-btn-primary'
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
              className: primaryClass,
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
            h('button', { type: 'button', className: 'dc-btn', onClick: loadPlan }, '重试'),
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
            { type: 'button', className: primaryClass, onClick: applyPlan, disabled: props.disabled },
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
      const primaryClass = props.primary === false ? 'dc-btn' : 'dc-btn dc-btn-primary'
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
            className: primaryClass,
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
        { className: 'dc-card dc-hero' },
        h(SectionHead, { title: '唯一下一步', meta: stageText }),
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
                  className: 'dc-btn dc-btn-primary',
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
                primary: !wantsCopy,
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
                primary: !wantsCopy,
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
          { className: 'dc-stage-dot', 'aria-hidden': 'true' },
          state === 'done' ? '✓' : '',
        ),
        h('span', { className: 'dc-stage-name' }, node.name || STAGE_TEXT[node.stageId] || node.stageId || '阶段'),
        h('span', { className: 'dc-stage-state' }, stateText),
      )
    }

    function ProgressionSection(props) {
      const progression = props.progression || {}
      const cold = asArray(progression.coldStart)
      const cycle = asArray(progression.cycle)
      const iteration = props.iteration || {}
      const action = props.action || {}
      const coldAllDone = cold.length > 0 && cold.every((node) => node && node.state === 'done')

      // 契约保证只有一个 current；万一模型给多了，只强高亮决策指向的那个，避免「两个当前」。
      const firstCurrent = cold.concat(cycle).find((node) => node && node.state === 'current')
      const highlightId = action.stageId || (firstCurrent && firstCurrent.stageId) || ''

      return h(
        'section',
        { className: 'dc-card' },
        h(SectionHead, { title: '迭代进度', meta: iteration.current || 'bootstrap' }),
        coldAllDone
          ? h(
              'div',
              { className: 'dc-cold-inline' },
              h('span', { className: 'dc-cold-label' }, '冷启动'),
              ...cold.map((node, index) =>
                h(
                  'span',
                  { key: `cold${index}`, className: 'dc-cold-item' },
                  node.name || STAGE_TEXT[node.stageId] || node.stageId,
                  ' ✓',
                ),
              ),
            )
          : h(
              React.Fragment,
              null,
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
      )
    }

    // ---------- 详情 · ④ 功能账 & 缺陷账 ----------
    //
    // 功能状态由 Host 用三路证据（验收 / 归属 bug / 回执）推导后下发，这里只如实呈现：
    // 不根据标题猜、不把「读不到」显示成 0。缺陷账分「功能内」与「未归属」两处。

    function FeatureStatusChip(props) {
      const status = props.status || 'unknown'
      const text = props.label || FEATURE_STATUS_TEXT[status] || '—'
      return h(Chip, { tone: FEATURE_STATUS_TONE[status] || 'unknown' }, text)
    }

    function BugList(props) {
      const issues = asArray(props.issues)
      if (issues.length === 0) return null
      return h(
        'ul',
        { className: 'dc-bug-list' },
        issues.map((issue, index) =>
          h(
            'li',
            { key: (issue && (issue.key || issue.title)) || `bug${index}`, className: 'dc-bug-item' },
            h(
              'span',
              { className: `dc-bug-sev dc-bug-sev-${(issue && issue.severity) || 'minor'}` },
              SEVERITY_TEXT[issue && issue.severity] || (issue && issue.severity) || '问题',
            ),
            h('span', { className: 'dc-bug-title' }, (issue && issue.title) || '（没有标题）'),
            issue && issue.file
              ? h(
                  'span',
                  { className: 'dc-bug-file' },
                  `${issue.file}${issue.line ? `:${issue.line}` : ''}`,
                )
              : null,
          ),
        ),
      )
    }

    function FeatureRow(props) {
      const item = props.item || {}
      const acceptance = item.acceptance || {}
      const bugs = item.bugs || {}
      // known === false 是「路径/回执关联不足，没法判断」——必须显示 —，绝不能显示 0。
      const known = bugs.known !== false
      const blockingRaw = Number(bugs.blocking)
      const blocking = Number.isFinite(blockingRaw) ? blockingRaw : 0
      const issues = asArray(bugs.issues)
      // 严重数优先用 Host 算好的全量值；Host 没给时才退回数下发的前 3 条（老数据兼容）。
      const severeRaw = Number(bugs.severe)
      const severeCount = Number.isFinite(severeRaw)
        ? severeRaw
        : issues.filter((issue) => issue && issue.severity === 'critical').length
      let bugText = '—'
      if (known) {
        if (blocking > 0) bugText = severeCount > 0 ? `${blocking}（严重 ${severeCount}）` : String(blocking)
        else bugText = '0'
      }
      const acceptanceTotal = Number(acceptance.total) || 0
      const acceptanceText = acceptanceTotal > 0
        ? `${Number(acceptance.passed) || 0}/${acceptanceTotal}`
        : '—'
      const paths = asArray(item.paths)
      const receipts = Number(item.receipts) || 0
      const inferred = Number(item.inferredReceipts) || 0
      const anchors = item.anchors && typeof item.anchors === 'object' ? item.anchors : {}
      const anchorText = [
        Number(anchors.receipts) > 0 ? `回执自报 ${Number(anchors.receipts)} 条` : null,
        Number(anchors.tasks) > 0 ? `任务标题 ${Number(anchors.tasks)} 个` : null,
      ]
        .filter(Boolean)
        .join('、')
      const expandable = issues.length > 0 || paths.length > 0 || receipts > 0
      const expanded = props.expanded === true
      const when = item.lastAt ? formatRelative(item.lastAt) : ''
      const summary = String(item.lastSummary || '').trim()
      const lastText = when || summary ? [when, summary].filter(Boolean).join(' · ') : '—'

      return h(
        React.Fragment,
        null,
        h(
          'tr',
          null,
          h(
            'td',
            null,
            h(
              'div',
              { className: 'dc-feature-cell' },
              expandable
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dc-row-toggle',
                      'aria-expanded': expanded ? 'true' : 'false',
                      onClick: props.onToggle,
                      title: expanded ? '收起明细' : '展开 bug 明细与关联路径',
                    },
                    h('span', { className: 'dc-caret', 'aria-hidden': 'true' }, expanded ? '▾' : '▸'),
                    h('span', { className: 'dc-feature-id' }, item.id || '—'),
                    item.priority
                      ? h(
                          'span',
                          { className: `dc-pri dc-pri-${String(item.priority).toLowerCase()}` },
                          item.priority,
                        )
                      : null,
                    h('span', { className: 'dc-feature-title' }, item.title || '（没有标题）'),
                  )
                : h(
                    React.Fragment,
                    null,
                    h('span', { className: 'dc-caret', 'aria-hidden': 'true' }, '·'),
                    h('span', { className: 'dc-feature-id' }, item.id || '—'),
                    item.priority
                      ? h(
                          'span',
                          { className: `dc-pri dc-pri-${String(item.priority).toLowerCase()}` },
                          item.priority,
                        )
                      : null,
                    h('span', { className: 'dc-feature-title' }, item.title || '（没有标题）'),
                  ),
            ),
          ),
          h('td', { 'data-label': '状态' }, h(FeatureStatusChip, { status: item.status, label: item.statusLabel })),
          h(
            'td',
            {
              className: blocking > 0 ? 'dc-cell-bad dc-cell-mono dc-num' : 'dc-cell-mono dc-num',
              'data-label': '待修',
            },
            bugText,
          ),
          h('td', { className: 'dc-cell-mono dc-num', 'data-label': '验收' }, acceptanceText),
          h('td', { className: 'dc-last-cell', 'data-label': '最近进展' }, lastText),
        ),
        expanded && expandable
          ? h(
              'tr',
              { className: 'dc-feature-detail-row' },
              h(
                'td',
                { colSpan: 5 },
                h(
                  'div',
                  { className: 'dc-feature-detail' },
                  issues.length > 0
                    ? h(
                        'div',
                        null,
                        h('div', { className: 'dc-caps-label' }, '该功能上的未处置阻塞'),
                        h(BugList, { issues }),
                      )
                    : h('div', { className: 'dc-hint' }, known ? '该功能没有未处置阻塞。' : '关联证据不足，待修数未知（—）。'),
                  paths.length > 0
                    ? h(
                        'div',
                        { className: 'dc-path-row' },
                        '关联路径：',
                        h('code', { className: 'dc-code' }, paths.join('、')),
                      )
                    : null,
                  receipts > 0
                    ? h(
                        'div',
                        { className: 'dc-hint' },
                        `关联回执 ${receipts} 条${inferred > 0 ? `（其中 ${inferred} 条按任务 relatedFiles / 路径自动归属）` : ''}`,
                      )
                    : null,
                  anchorText
                    ? h('div', { className: 'dc-hint' }, `路径锚点：${anchorText}（写了 feature_ids 的回执优先）`)
                    : null,
                ),
              ),
            )
          : null,
      )
    }

    function AcceptanceResultChip(props) {
      const result = props.result || null
      return h(
        Chip,
        { tone: ACCEPTANCE_RESULT_TONE[result] || 'unknown' },
        ACCEPTANCE_RESULT_TEXT[result] || '未验',
      )
    }

    function evidenceLabel(value) {
      const raw = String(value == null ? '' : value).trim()
      if (raw === '') return ''
      const withoutQuery = raw.split(/[?#]/)[0]
      const parts = withoutQuery.split(/[\\/]/).filter(Boolean)
      return parts.length > 0 ? parts[parts.length - 1] : raw
    }

    const IMAGE_EVIDENCE_RE = /\.(png|jpe?g|webp|gif)(?:[?#].*)?$/i

    // 只有项目内相对路径走 /shot（Host 会校验目录穿越与大小）；
    // http(s) 证据直接当图片地址用（契约明确允许）。
    function isImageEvidence(value) {
      const raw = String(value == null ? '' : value).trim()
      if (raw === '') return false
      return /^https?:\/\//i.test(raw) || IMAGE_EVIDENCE_RE.test(raw)
    }

    function evidenceSrc(value, projectPath) {
      const raw = String(value == null ? '' : value).trim()
      if (/^https?:\/\//i.test(raw)) return raw
      return `${API}/shot?path=${encodeURIComponent(projectPath || '')}&file=${encodeURIComponent(raw)}`
    }

    function openEvidenceShot(value, projectPath) {
      const src = evidenceSrc(value, projectPath)
      try {
        window.open(src, '_blank', 'noopener')
      } catch {
        // 弹窗被拦截时什么都不做：证据本身仍然可读
      }
    }

    // 最多 3 张缩略图，多出的显示 +N；非图片证据不在这里处理（保持文本列表）。
    function EvidenceThumbs(props) {
      const images = asArray(props.values).filter((value) => isImageEvidence(value))
      if (images.length === 0) return null
      const shown = images.slice(0, 3)
      const rest = images.slice(3)
      return h(
        'div',
        { className: 'dc-thumbs' },
        shown.map((value, index) =>
          h(
            'button',
            {
              key: `${value}#${index}`,
              type: 'button',
              className: 'dc-thumb',
              title: value,
              'aria-label': `打开证据 ${evidenceLabel(value) || value}`,
              onClick: () => openEvidenceShot(value, props.projectPath),
            },
            h('img', { src: evidenceSrc(value, props.projectPath), alt: '', loading: 'lazy' }),
          ),
        ),
        rest.length > 0
          ? h('span', { className: 'dc-thumb-more', title: rest.join('\n') }, `+${rest.length}`)
          : null,
      )
    }

    // 视觉回归徽章：changed 可点开 diff 图；其余只读（reason 放 title 里悬停看）。
    function ShotDiffBadge(props) {
      const diff = props.diff
      if (!diff) return null
      const verdict = diff.verdict || 'uncomparable'
      const tone = DIFF_VERDICT_TONE[verdict] || 'unknown'
      const text = diffVerdictText(diff)
      if (verdict === 'changed' && diff.diffFile) {
        return h(
          'button',
          {
            type: 'button',
            className: 'dc-diff-btn',
            title: `${diffTitle(diff)}\n点击查看 diff 图`,
            'aria-label': `查看 diff 图：${text}`,
            onClick: () => openEvidenceShot(diff.diffFile, props.projectPath),
          },
          h(Chip, { tone }, text),
          h('span', { className: 'dc-diff-link' }, '查看 diff'),
        )
      }
      return h(Chip, { tone, title: diffTitle(diff) || undefined }, text)
    }

    // 验收清单：面板内可直接记录结果（通过/失败/阻塞/撤销）。
    // 写动作只发「项目路径 + 验收项 + 结果 + 证据路径」，文件校验与迭代归属由 Host 负责；
    // 成功后重新拉面板，让 Host 返回的 result/at/evidence 成为唯一事实源。
    function AcceptancePanel(props) {
      const acceptance = props.acceptance || {}
      const items = asArray(acceptance.items)
      const truncated = acceptance.truncated === true
      // 验收清单降噪：默认只展开需要动作的条目；干净的通过项收进折叠行。
      const actionable = items.filter((item) => item && (item.result !== 'pass' || item.stale === true))
      const cleanPassed = items.filter((item) => item && item.result === 'pass' && item.stale !== true)
      // 通过数用 Host 的全局真值：items 最多 100 条，截断时本地 filter 只覆盖可见项。
      const passedRaw = Number(acceptance.passed)
      const passedCount = Number.isFinite(passedRaw) ? passedRaw : cleanPassed.length
      const staleRaw = Number(acceptance.stale)
      const staleCount = Number.isFinite(staleRaw)
        ? staleRaw
        : items.filter((item) => item && item.stale === true).length
      const [editing, setEditing] = React.useState({})
      const [drafts, setDrafts] = React.useState({})
      const [rowState, setRowState] = React.useState({})
      const [shotUrls, setShotUrls] = React.useState({})
      const mounted = React.useRef(true)
      React.useEffect(
        () => () => {
          mounted.current = false
        },
        [],
      )

      const setEditingFor = (id, value) => setEditing((previous) => ({ ...previous, [id]: value }))
      const setDraft = (id, value) => setDrafts((previous) => ({ ...previous, [id]: value }))
      const setRow = (id, patch) =>
        setRowState((previous) => ({ ...previous, [id]: { ...(previous[id] || {}), ...patch } }))
      const draftFor = (item) => {
        const id = item.id
        if (Object.prototype.hasOwnProperty.call(drafts, id)) return drafts[id]
        return asArray(item.evidence).join(', ')
      }
      // 证据支持多张：逗号/中文逗号/分号/换行分隔。
      const parseEvidence = (text) =>
        String(text == null ? '' : text)
          .split(/[\n,，;；]+/)
          .map((part) => part.trim())
          .filter(Boolean)

      // 截图用行的预览地址：默认取项目名片里的 previewUrl，用户可改，失败时保留。
      const shotUrlFor = (id) =>
        Object.prototype.hasOwnProperty.call(shotUrls, id)
          ? shotUrls[id]
          : String(props.previewUrl || '')
      const setShotUrl = (id, value) => setShotUrls((previous) => ({ ...previous, [id]: value }))

      const capture = async (item) => {
        const id = item.id
        if (!id) return
        const url = String(shotUrlFor(id) || '').trim()
        setRow(id, { capturing: true, shotOpen: true, shotError: '', shotSaved: false })
        try {
          const payload = { path: props.projectPath, item_id: id }
          if (url) payload.url = url
          // 真实截图 2–10 秒，给 90s 兜底；不要用默认 10s 超时把它打断。
          // 注意：必须大于 Host 的 screenshotTimeoutMs（默认 30s，可在 cordis.patch.yml 调大），
          // 否则客户端先超时、服务端其实还在截——虽然服务端会因断开中止，但体验上等于白等。
          const SHOT_REQUEST_TIMEOUT_MS = 90000
          const body = await postJson(`${API}/acceptance-screenshot`, payload, SHOT_REQUEST_TIMEOUT_MS)
          if (!body || body.ok !== true) throw new Error('shot-failed')
          if (!mounted.current) return
          // Host 在同一响应里带回与上一版的像素对比：立刻显示，不用等面板刷新。
          const comparison = body.shot && body.shot.comparison ? body.shot.comparison : null
          // 本轮截图让该条验收失效时，必须强提示「重新点通过」——失效 ≠ 改结果。
          const invalidated = Boolean(body.shot && body.shot.invalidated === true)
          // 审计留痕：Host 若返回回执 id，直接显示，方便追溯这次失效。
          const receiptId = (body.shot && body.shot.receiptId) || null
          // 失效留痕写失败要如实说（不能只显示"已截图"就完事）。
          const receiptWarning =
            body.shot && typeof body.shot.receiptWarning === 'string' ? body.shot.receiptWarning.trim() : ''
          setRow(id, {
            capturing: false,
            shotError: '',
            shotSaved: true,
            shotInvalidated: invalidated,
            shotReceiptId: receiptId,
            shotReceiptWarning: receiptWarning,
            shotMessage: invalidated
              ? `已截图 · 有变化：该条验收已失效，请重新点「通过」${receiptWarning && !receiptId ? '（回执写入失败）' : ''}`
              : comparisonMessage(comparison),
            shotDiffFile:
              comparison && comparison.verdict === 'changed' && comparison.diffFile
                ? String(comparison.diffFile)
                : null,
          })
          if (props.onRefresh) props.onRefresh()
          setTimeout(() => {
            if (mounted.current) setRow(id, { shotSaved: false })
          }, 6000)
        } catch (failure) {
          if (!mounted.current) return
          // 失败保留已填 URL（shotUrls 不动），方便直接重试。
          setRow(id, {
            capturing: false,
            shotSaved: false,
            shotError: explainShotError(messageOf(failure)),
          })
        }
      }

      const submit = async (item, result) => {
        const id = item.id
        if (!id) return
        const evidence = parseEvidence(draftFor(item))
        // 通过必须有证据：前端先拦一次（Host 也会再校验 evidence-required）。
        if (result === 'pass' && evidence.length === 0) {
          setRow(id, { saving: false, saved: false, error: '通过必须附证据' })
          return
        }
        setRow(id, { saving: true, saved: false, error: '' })
        try {
          const body = await postJson(`${API}/acceptance-result`, {
            path: props.projectPath,
            item_id: id,
            result,
            evidence,
          })
          if (!body || body.ok !== true) throw new Error('acceptance-failed')
          if (!mounted.current) return
          setRow(id, { saving: false, saved: true, error: '' })
          setEditingFor(id, false)
          if (props.onRefresh) props.onRefresh()
          setTimeout(() => {
            if (mounted.current) setRow(id, { saved: false })
          }, 2500)
        } catch (failure) {
          if (!mounted.current) return
          // 失败保留输入，只显示行内错误：用户不用重新填一遍证据。
          setRow(id, {
            saving: false,
            saved: false,
            error: explainAcceptanceError(messageOf(failure)),
          })
        }
      }

      const renderTable = (rows) =>
        h(
          'div',
          { className: 'dc-table-wrap' },
          h(
            'table',
            { className: 'dc-table dc-acc-table' },
            h('caption', { className: 'dc-sr' }, '验收清单：逐条记录通过、失败或阻塞'),
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { scope: 'col' }, '验收点'),
                h('th', { scope: 'col' }, '功能'),
                h('th', { scope: 'col' }, '结果'),
                h('th', { scope: 'col' }, '证据'),
                h('th', { scope: 'col' }, '操作'),
              ),
            ),
            h(
              'tbody',
              null,
              rows.map((item) => {
                if (!item || !item.id) return null
                const id = item.id
                const state = rowState[id] || {}
                const evidence = asArray(item.evidence)
                // Host 已按时间正序截断到最近 5 条；最后一条是最新一次对比。
                const shotDiffs = asArray(item.shotDiffs)
                const latestDiff = shotDiffs.length > 0 ? shotDiffs[shotDiffs.length - 1] : null
                const diffOpen = state.diffOpen === true
                const editingRow = editing[id] === true
                const stepsTitle = [
                  item.steps ? `步骤：${item.steps}` : '',
                  item.expect ? `期望：${item.expect}` : '',
                ]
                  .filter(Boolean)
                  .join('\n')
                return h(
                  'tr',
                  { key: id, 'data-acceptance-id': id },
                  h(
                    'td',
                    null,
                    h('span', { className: 'dc-acc-id' }, id),
                    h(
                      'span',
                      { className: 'dc-acc-title', title: stepsTitle || undefined },
                      item.title || '（没有标题）',
                    ),
                    stepsTitle
                      ? h('div', { className: 'dc-acc-steps', title: stepsTitle }, stepsTitle.replace(/\n/g, ' · '))
                      : null,
                  ),
                  h('td', { className: 'dc-cell-mono', 'data-label': '功能' }, item.featureRef || '—'),
                  h(
                    'td',
                    { 'data-label': '结果' },
                    h(AcceptanceResultChip, { result: item.result }),
                    item.stale === true && item.result === 'pass'
                      ? h(
                          'span',
                          { className: 'dc-stale-tag', title: '截图有变化，需重新确认' },
                          '已失效',
                        )
                      : null,
                  ),
                  h(
                    'td',
                    { 'data-label': '证据' },
                    item.stale === true && item.result === 'pass'
                      ? h(
                          'div',
                          { className: 'dc-stale-note', role: 'status' },
                          '截图有变化，之前那次通过已失效，请重新点「通过」确认',
                          item.staleAt ? `（${formatRelative(item.staleAt)}）` : '',
                          item.staleReceiptId || item.receiptId
                            ? h(
                                'span',
                                { className: 'dc-hint' },
                                ` · 已写入回执 ${item.staleReceiptId || item.receiptId}`,
                              )
                            : null,
                        )
                      : null,
                    shotDiffs.length > 0
                      ? h(
                          React.Fragment,
                          null,
                          h(
                            'div',
                            { className: 'dc-diff-row' },
                            h(ShotDiffBadge, { diff: latestDiff, projectPath: props.projectPath }),
                            latestDiff && latestDiff.verdict === 'changed' && latestDiff.diffFile
                              ? h(
                                  'button',
                                  {
                                    type: 'button',
                                    className: 'dc-thumb dc-diff-thumb',
                                    title: '查看 diff 图（变化像素标红）',
                                    'aria-label': '查看 diff 图',
                                    onClick: () => openEvidenceShot(latestDiff.diffFile, props.projectPath),
                                  },
                                  h('img', {
                                    src: evidenceSrc(latestDiff.diffFile, props.projectPath),
                                    alt: 'diff',
                                    loading: 'lazy',
                                  }),
                                )
                              : null,
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'dc-btn dc-btn-sm',
                                'aria-expanded': diffOpen ? 'true' : 'false',
                                onClick: () => setRow(id, { diffOpen: !diffOpen }),
                              },
                              diffOpen ? '收起历史' : '历史',
                            ),
                          ),
                          diffOpen
                            ? h(
                                React.Fragment,
                                null,
                                h('div', { className: 'dc-hint' }, '最近 5 次对比（最新在前）'),
                                h(
                                  'ol',
                                  { className: 'dc-diff-history' },
                                  shotDiffs
                                    .slice()
                                    .reverse()
                                    .map((diff, diffIndex) =>
                                      h(
                                        'li',
                                        { key: `${id}-diff-${diffIndex}` },
                                        h(
                                          'span',
                                          {
                                            className: 'dc-diff-history-at',
                                            title: diff.at ? new Date(diff.at).toLocaleString() : '',
                                          },
                                          diff.at ? formatRelative(diff.at) : '—',
                                        ),
                                        h(
                                          'span',
                                          {
                                            className: 'dc-diff-history-verdict',
                                            title: diffTitle(diff) || undefined,
                                          },
                                          diffVerdictText(diff),
                                        ),
                                        diff.verdict === 'uncomparable' && diff.reason
                                          ? h('span', { className: 'dc-hint' }, explainDiffReason(diff.reason))
                                          : null,
                                        diff.verdict === 'changed' && diff.diffFile
                                          ? h(
                                              'button',
                                              {
                                                type: 'button',
                                                className: 'dc-diff-link',
                                                onClick: () =>
                                                  openEvidenceShot(diff.diffFile, props.projectPath),
                                              },
                                              'diff',
                                            )
                                          : null,
                                      ),
                                    ),
                                ),
                              )
                            : null,
                        )
                      : null,
                    editingRow
                      ? h(
                          React.Fragment,
                          null,
                          h('input', {
                            className: 'dc-evidence-input',
                            value: draftFor(item),
                            placeholder: '截图路径或 URL，如 shots/a1.png',
                            autoFocus: true,
                            'aria-label': `验收项 ${id} 的证据`,
                            onChange: (event) => setDraft(id, event.target.value),
                          }),
                          h('div', { className: 'dc-hint' }, '逗号或换行分隔，支持多张；项目内相对路径或 http(s) URL。'),
                        )
                      : h(
                          React.Fragment,
                          null,
                          h(
                            'div',
                            { className: 'dc-evidence-summary', title: evidence.join('\n') || '' },
                            evidence.length === 0
                              ? '—'
                              : evidence.some((value) => isImageEvidence(value))
                                ? `证据 ${evidence.length} 个 · ${evidenceLabel(evidence[0])}`
                                : evidence.join('、'),
                          ),
                          h(EvidenceThumbs, { values: evidence, projectPath: props.projectPath }),
                        ),
                    h(
                      'div',
                      { className: 'dc-evidence-actions' },
                      editingRow
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'dc-btn dc-btn-sm',
                              onClick: () => setEditingFor(id, false),
                            },
                            '收起编辑',
                          )
                        : h(
                            'button',
                            {
                              type: 'button',
                              className: 'dc-btn dc-btn-sm dc-evidence-edit',
                              onClick: () => setEditingFor(id, true),
                            },
                            '编辑',
                          ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dc-btn dc-btn-sm',
                          'aria-expanded': state.shotOpen === true ? 'true' : 'false',
                          onClick: () =>
                            setRow(id, {
                              shotOpen: state.shotOpen !== true,
                              shotError: state.shotOpen === true ? '' : state.shotError,
                            }),
                        },
                        state.shotOpen === true ? '收起截图' : '截图',
                      ),
                    ),
                    state.shotOpen === true
                      ? h(
                          'div',
                          { className: 'dc-shot-box' },
                          h('input', {
                            className: 'dc-evidence-input dc-shot-url',
                            value: shotUrlFor(id),
                            placeholder: '预览地址，如 http://127.0.0.1:5173',
                            'aria-label': `验收项 ${id} 的预览地址`,
                            onChange: (event) => setShotUrl(id, event.target.value),
                          }),
                          h(
                            'div',
                            { className: 'dc-shot-row' },
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'dc-btn dc-btn-sm dc-btn-primary',
                                disabled: state.capturing === true,
                                onClick: () => capture(item),
                              },
                              state.capturing === true ? '截图中…' : '截图并附到证据',
                            ),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'dc-btn dc-btn-sm',
                                disabled: state.capturing === true,
                                onClick: () => setRow(id, { shotOpen: false }),
                              },
                              '取消',
                            ),
                          ),
                          h(
                            'div',
                            { className: 'dc-hint' },
                            '只允许本机地址（127.0.0.1 / localhost）；截图只挂到证据，不会自动改成「通过」。',
                          ),
                          state.shotError
                            ? h('div', { className: 'dc-acc-error', role: 'alert' }, state.shotError)
                            : null,
                          state.shotSaved
                            ? h(
                                'div',
                                {
                                  className: state.shotInvalidated === true ? 'dc-stale-note' : 'dc-acc-saved',
                                  role: 'status',
                                },
                                state.shotMessage || '已截图并附到证据',
                                state.shotDiffFile
                                  ? h(
                                      React.Fragment,
                                      null,
                                      ' · ',
                                      h(
                                        'button',
                                        {
                                          type: 'button',
                                          className: 'dc-diff-link',
                                          onClick: () =>
                                            openEvidenceShot(state.shotDiffFile, props.projectPath),
                                        },
                                        '查看 diff',
                                      ),
                                    )
                                  : null,
                                state.shotReceiptId
                                  ? h('span', { className: 'dc-hint' }, ` · 已写入回执 ${state.shotReceiptId}`)
                                  : state.shotReceiptWarning
                                    ? h(
                                        'span',
                                        { className: 'dc-acc-error' },
                                        ` · 回执写入失败：${state.shotReceiptWarning}`,
                                      )
                                    : null,
                              )
                            : null,
                        )
                      : null,
                  ),
                  h(
                    'td',
                    { 'data-label': '操作' },
                    h(
                      'div',
                      { className: 'dc-acc-actions' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dc-btn dc-btn-sm',
                          disabled: state.saving === true,
                          onClick: () => submit(item, 'pass'),
                        },
                        '通过',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dc-btn dc-btn-sm',
                          disabled: state.saving === true,
                          onClick: () => submit(item, 'fail'),
                        },
                        '失败',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dc-btn dc-btn-sm',
                          disabled: state.saving === true,
                          onClick: () => submit(item, 'blocked'),
                        },
                        '阻塞',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dc-btn dc-btn-sm dc-btn-danger',
                          disabled: state.saving === true,
                          onClick: () => submit(item, null),
                        },
                        '撤销',
                      ),
                    ),
                    state.saving ? h('div', { className: 'dc-hint' }, '保存中…') : null,
                    state.error ? h('div', { className: 'dc-acc-error', role: 'alert' }, state.error) : null,
                    state.saved
                      ? h('div', { className: 'dc-acc-saved', role: 'status' }, '已保存，面板已刷新')
                      : null,
                  ),
                )
              }),
            ),
          ),
        )

      let content = null
      if (items.length === 0) {
        content = h(
          'div',
          { className: 'dc-empty-box' },
          h('div', { className: 'dc-banner-title' }, '还没有验收清单：让 Agent 用 cockpit_acceptance 起草'),
          props.actionKind === 'acceptance-draft'
            ? h('p', { className: 'dc-empty-line' }, '下一步就是「生成验收清单」，生成后回到这里逐条点结果。')
            : null,
        )
      } else {
        content = h(
          React.Fragment,
          null,
          acceptance.badJson
            ? h('p', { className: 'dc-hint dc-hint-bad' }, '验收表不是合法 JSON，先修好文件再记录结果。')
            : null,
          truncated ? h('p', { className: 'dc-hint' }, '验收表超过 100 条，只显示前 100 条。') : null,
          actionable.length > 0
            ? renderTable(actionable)
            : h('p', { className: 'dc-empty-line' }, '没有待处理的验收项。'),
          cleanPassed.length > 0
            ? h(
                'details',
                { className: 'dc-passed-fold' },
                h('summary', null, `已通过 ${passedCount} 条（展开）`),
                renderTable(cleanPassed),
              )
            : null,
        )
      }

      const meta =
        actionable.length > 0
          ? `需处理 ${actionable.length} 条${staleCount > 0 ? ` · ${staleCount} 条已失效` : ''}`
          : '全部已处理'
      return h(
        'section',
        { className: 'dc-card' },
        h(SectionHead, { title: '验收清单', meta }),
        content,
      )
    }

    function FeatureBoardSection(props) {
      const features = props.features || {}
      const items = asArray(features.items)
      const source = features.source || 'prd'
      const strategy = features.strategy || 'none'
      const formatHint = String(features.formatHint || '')
      const [expanded, setExpanded] = React.useState({})
      const toggle = (id) => setExpanded((previous) => ({ ...previous, [id]: !previous[id] }))

      let board = null
      if (source === 'prd-missing') {
        board = h(
          'div',
          { className: 'dc-empty-box' },
          h('div', { className: 'dc-banner-title' }, '还没有 prd.md —— 想清楚阶段会产出它'),
          h(
            'p',
            { className: 'dc-empty-line' },
            '功能账需要 PRD 里的受控功能清单。把 prd.md 放到项目根目录（或 docs/prd.md），写好功能需求节后再回来看。',
          ),
          h('code', { className: 'dc-code' }, 'prd.md  /  docs/prd.md'),
        )
      } else if (strategy === 'none') {
        board = h(
          'div',
          { className: 'dc-empty-box' },
          h('div', { className: 'dc-banner-title' }, '认不出功能清单'),
          formatHint ? h('pre', { className: 'dc-code-block' }, formatHint) : null,
          h(
            'p',
            { className: 'dc-empty-line' },
            '面板不解析自由文本，只认这个结构：在 prd.md 里写「## 功能需求」，其下每条用「### FR-1 标题」。',
          ),
        )
      } else if (items.length === 0) {
        board = h(
          'div',
          { className: 'dc-empty-box' },
          h('div', { className: 'dc-banner-title' }, 'PRD 里还没有功能条目'),
          h('p', { className: 'dc-empty-line' }, '功能需求节存在，但里面没有解析到「### FR-N 标题」条目。补上后刷新即可。'),
        )
      } else {
        board = h(
          'div',
          { className: 'dc-table-wrap' },
          h(
            'table',
            { className: 'dc-table' },
            h('caption', { className: 'dc-sr' }, '功能账：状态、待修、验收与最近进展'),
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { scope: 'col' }, '功能'),
                h('th', { scope: 'col' }, '状态'),
                h('th', { scope: 'col', className: 'dc-num' }, '待修'),
                h('th', { scope: 'col', className: 'dc-num' }, '验收'),
                h('th', { scope: 'col' }, '最近进展'),
              ),
            ),
            h(
              'tbody',
              null,
              items.map((item, index) => {
                const key = (item && item.id) || `feature${index}`
                return h(FeatureRow, {
                  key,
                  item,
                  expanded: expanded[key] === true,
                  onToggle: () => toggle(key),
                })
              }),
            ),
          ),
        )
      }

      return h(
        'section',
        { className: 'dc-card' },
        h(SectionHead, {
          title: '功能账 & 缺陷账',
          meta: features.prdPath || (strategy === 'none' ? '未识别清单' : undefined),
        }),
        board,
      )
    }

    // 未归属阻塞单列（紧凑）：按路径没匹配到功能的缺陷不能悄悄丢。
    function DefectsSection(props) {
      const features = props.features || {}
      const unattributed = features.unattributed || {}
      const blocking = Number(unattributed.blocking) || 0
      if (blocking <= 0) return null
      return h(
        'section',
        { className: 'dc-card' },
        h(SectionHead, { title: '未归属缺陷', meta: `${blocking} 条` }),
        h('p', { className: 'dc-hint' }, '按路径没匹配到任何功能，可能是共享代码或全项目问题。'),
        h(BugList, { issues: unattributed.issues }),
      )
    }

    // ---------- 摘要条：一行统计，替代大数字 KPI ----------

    function SummaryBar(props) {
      const features = props.features || {}
      const acceptance = props.acceptance || {}
      const progress = features.progress || {}
      const featureTotal = Number(progress.total) || 0
      const featureDone = Number(progress.done) || 0
      const acceptanceTotal = Number(acceptance.total) || 0
      const acceptancePassed = Number(acceptance.passed) || 0
      const stale = Number(acceptance.stale) || 0
      // 阻塞与功能表同源：归属到功能的未处置阻塞 + 未归属缺陷。
      let blocking = 0
      for (const item of asArray(features.items)) {
        const bugs = (item && item.bugs) || {}
        if (bugs.known !== false) blocking += Number(bugs.blocking) || 0
      }
      const unattributed = features.unattributed || {}
      if (unattributed.known !== false) blocking += Number(unattributed.blocking) || 0
      const hasDecision =
        Boolean(props.action && props.action.kind === 'decide') ||
        asArray(props.ledger && props.ledger.receipts).some((receipt) => receipt && receipt.needsDecision)
      const percent = featureTotal > 0 ? Math.round((featureDone / featureTotal) * 100) : 0
      const stats = [
        { key: 'features', label: '功能', value: featureTotal > 0 ? `${featureDone}/${featureTotal}` : '—' },
        { key: 'acceptance', label: '验收', value: acceptanceTotal > 0 ? `${acceptancePassed}/${acceptanceTotal}` : '—' },
        { key: 'blocking', label: '缺陷', value: String(blocking), tone: blocking > 0 ? 'bad' : null, title: '未处置的审核 blocking，含未归属' },
        { key: 'stale', label: '失效', value: String(stale), tone: stale > 0 ? 'warn' : null },
        { key: 'decision', label: '待决策', value: hasDecision ? '1' : '0', tone: hasDecision ? 'warn' : null },
      ]
      return h(
        'div',
        { className: 'dc-summary-bar' },
        stats.map((stat) =>
          h(
            'span',
            { key: stat.key, className: 'dc-summary-stat', title: stat.title || undefined },
            h('span', { className: 'dc-summary-label' }, stat.label),
            h(
              'span',
              { className: `dc-summary-value${stat.tone ? ` dc-summary-${stat.tone}` : ''}` },
              stat.value,
            ),
          ),
        ),
        h(
          'span',
          { className: 'dc-summary-progress', 'aria-hidden': 'true' },
          h('span', { className: 'dc-summary-fill', style: { width: `${percent}%` } }),
        ),
      )
    }

    // ---------- 右栏：待决策 / 审核账本 / 执行回执 / 数据提示 ----------

    // 「最严重」一条：优先审核账本 issues，缺明细时从功能/未归属的 bug 里挑。
    function mostSevereIssue(review, features) {
      const rank = { critical: 0, important: 1, minor: 2 }
      const pool = asArray(review.issues).slice()
      for (const item of asArray(features.items)) {
        const bugs = (item && item.bugs) || {}
        if (bugs.known !== false) pool.push(...asArray(bugs.issues))
      }
      pool.push(...asArray((features.unattributed || {}).issues))
      const sorted = pool
        .filter(Boolean)
        .sort((left, right) => (rank[left.severity] ?? 9) - (rank[right.severity] ?? 9))
      return sorted[0] || null
    }

    function ReviewRail(props) {
      const review = props.review || {}
      const features = props.features || {}
      if (review.available === false) {
        return h(
          'section',
          { className: 'dc-rail-group' },
          h('div', { className: 'dc-rail-head' }, h('h3', { className: 'dc-rail-title' }, '审核账本')),
          h(
            'p',
            { className: 'dc-rail-note' },
            review.reason === 'no-ledger' ? '未接审核账本，挑毛病阶段不做判定。' : '审核账本读取失败。',
          ),
        )
      }
      const blocking = Number(review.blocking) || 0
      const fixed = Number(review.fixed) || 0
      const rounds = Number(review.rounds) || 0
      const gateText = blocking > 0 ? '门禁未过' : rounds > 0 ? '门禁已清' : '未开始'
      const gateTone = blocking > 0 ? 'bad' : rounds > 0 ? 'ok' : 'unknown'
      const severe = mostSevereIssue(review, features)
      return h(
        'section',
        { className: 'dc-rail-group' },
        h(
          'div',
          { className: 'dc-rail-head' },
          h('h3', { className: 'dc-rail-title' }, '审核账本'),
          h(Chip, { tone: gateTone }, gateText),
        ),
        h(
          'div',
          { className: 'dc-rail-stats' },
          h('span', null, '阻塞 ', h('b', { className: 'dc-rail-num' }, String(blocking))),
          h('span', null, '待复检 ', h('b', { className: 'dc-rail-num' }, String(fixed))),
          h('span', null, '已清 ', h('b', { className: 'dc-rail-num' }, `${rounds} 轮`)),
        ),
        h(
          'div',
          { className: 'dc-rail-severe' },
          severe
            ? h(
                'span',
                {
                  className: 'dc-rail-severe-text',
                  title: `[${SEVERITY_TEXT[severe.severity] || severe.severity || '问题'}] ${severe.title || ''}` +
                    (severe.file ? ` · ${severe.file}${severe.line ? `:${severe.line}` : ''}` : ''),
                },
                h(
                  'span',
                  { className: `dc-bug-sev dc-bug-sev-${severe.severity || 'minor'}` },
                  SEVERITY_TEXT[severe.severity] || severe.severity || '问题',
                ),
                ` ${severe.title || '（没有标题）'}`,
                severe.file
                  ? h('span', { className: 'dc-bug-file' }, ` · ${severe.file}${severe.line ? `:${severe.line}` : ''}`)
                  : null,
              )
            : h(
                'span',
                { className: 'dc-rail-note' },
                blocking > 0 ? `阻塞 ${blocking} 条（明细未提供）` : '没有未处置阻塞',
              ),
        ),
      )
    }

    function ReceiptsTimeline(props) {
      const ledger = props.ledger || {}
      const receipts = asArray(ledger.receipts)
      const total = Number(ledger.total) || receipts.length
      const lastAt = ledger.lastAt || (receipts[0] && receipts[0].at) || null
      return h(
        'section',
        { className: 'dc-rail-group' },
        h(
          'div',
          { className: 'dc-rail-head' },
          h('h3', { className: 'dc-rail-title' }, '执行回执'),
          h('span', { className: 'dc-rail-meta' }, lastAt ? `上次 ${formatRelative(lastAt)}` : '还没有回执'),
        ),
        receipts.length === 0
          ? h('p', { className: 'dc-rail-note' }, 'Agent 每完成一步会写一条。')
          : h(
              'ol',
              { className: 'dc-receipts-timeline' },
              receipts.map((receipt, index) => {
                const event = receipt && receipt.event
                const auditText =
                  event === 'acceptance-recheck'
                    ? '验收复核'
                    : event === 'acceptance-stale'
                      ? '验收失效'
                      : null
                return h(
                  'li',
                  { key: (receipt && receipt.id) || `receipt${index}`, className: 'dc-timeline-item' },
                  h(
                    'span',
                    { className: 'dc-timeline-when', title: receipt && receipt.at ? new Date(receipt.at).toLocaleString() : '' },
                    receipt && receipt.at ? formatRelative(receipt.at) : '—',
                  ),
                  h(
                    'span',
                    { className: 'dc-timeline-body' },
                    h(
                      'span',
                      { className: 'dc-timeline-top' },
                      h(
                        'span',
                        { className: 'dc-timeline-stage' },
                        (receipt && (receipt.stageName || STAGE_TEXT[receipt.stage])) || '未知阶段',
                      ),
                      auditText ? h(Chip, { tone: 'idle' }, auditText) : null,
                    ),
                    h(
                      'span',
                      {
                        className: 'dc-timeline-summary',
                        title: (receipt && receipt.summary) || '',
                      },
                      (receipt && receipt.summary) || '（没有摘要）',
                    ),
                  ),
                )
              }),
            ),
        h('div', { className: 'dc-rail-foot' }, `共 ${total} 条`),
      )
    }

    function SidebarRail(props) {
      const ledger = props.ledger || {}
      const receipts = asArray(ledger.receipts)
      const warnings = asArray(props.warnings)
      const dataGaps = asArray(props.dataGaps)
      // 功能账的提示（含「功能超过 N 条只显示前 N 条」的截断告警）不能静默丢。
      const featureNotes = asArray(props.features && props.features.notes)
      const decisionReceipt = receipts.find((receipt) => receipt && receipt.needsDecision) || null
      const decision = decisionReceipt && decisionReceipt.needsDecision
      const gapCount = warnings.length + dataGaps.length + featureNotes.length
      return h(
        'aside',
        { className: 'dc-rail', 'aria-label': '项目辅助信息' },
        decision
          ? h(
              'section',
              { className: 'dc-rail-group dc-decision', role: 'status' },
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
        h(ReviewRail, { review: props.review, features: props.features }),
        h(ReceiptsTimeline, { ledger }),
        gapCount > 0
          ? h(
              'details',
              { className: 'dc-rail-details' },
              h('summary', null, `数据提示 ${gapCount} 条`),
              h(
                'ul',
                null,
                warnings.map((item, index) =>
                  h('li', { key: `warning${index}` }, `读取异常：${(item && item.message) || item}`),
                ),
                dataGaps.map((item, index) =>
                  h('li', { key: `gap${index}` }, `数据缺口：${(item && item.message) || item}`),
                ),
                featureNotes.map((item, index) =>
                  h('li', { key: `note${index}` }, `功能账：${(item && item.message) || item}`),
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
      const auditText =
        receipt.event === 'acceptance-recheck' ? '验收复核' : receipt.event === 'acceptance-stale' ? '验收失效' : null
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
          auditText ? h(Chip, { tone: 'idle', title: '审计事件：只留痕，不参与进度投影' }, auditText) : null,
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
          h(Chip, { tone: 'idle' }, (panel.iteration && panel.iteration.current) || '未开始迭代'),
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
          h(SummaryBar, {
            features: panel.features,
            acceptance: panel.acceptance,
            action,
            ledger,
          }),
          h(
            'div',
            { className: 'dc-layout' },
            h(
              'div',
              { className: 'dc-main' },
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
              }),
              h(FeatureBoardSection, {
                features: panel.features,
              }),
              h(AcceptancePanel, {
                acceptance: panel.acceptance,
                actionKind: action.kind,
                projectPath: project.path || props.selectedPath,
                previewUrl: project.commands && project.commands.previewUrl,
                onRefresh: props.refresh,
              }),
              h(DefectsSection, { features: panel.features }),
            ),
            h(SidebarRail, {
              ledger,
              review: panel.review,
              features: panel.features,
              warnings: panel.warnings,
              dataGaps: panel.dataGaps,
            }),
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





