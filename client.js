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
    const DENSITY_KEY = 'delivery-cockpit:density'
    const POLL_MS = 8000
    const REQUEST_TIMEOUT_MS = 10000

    // ---------- 文案映射：契约里的英文枚举在界面上必须说人话 ----------

    // 9 阶段 canonical id → 4 字中文名；旧 id 保留映射，历史记录/旧账本仍显示人话。
    const STAGE_TEXT = {
      bootstrap: '项目立项',
      requirements: '需求定义',
      architecture: '架构契约',
      prototype: '原型设计',
      implementation: '代码开发',
      testing: '测试验证',
      'code-review': '代码复核',
      acceptance: '验收确认',
      release: '部署发布',
      // 旧 id（8 阶段模型）：只用于显示旧记录，不再写入新账本。
      init: '初始化',
      scaffold: '搭骨架',
      brainstorm: '想清楚',
      coding: '写代码',
      code_review: '挑毛病',
      verification: '验效果',
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
    // 两套 tone 命名并存：旧 chip 用 ok/bad/unknown，新模块与摘要用 success/error/idle。ok≡success、bad≡error；unknown 是灰虚线的 chip，idle 是 state-idle 实心，二者视觉不同，别混用。
    const FEATURE_STATUS_TEXT = {
      done: '已完成',
      blocked: '有卡点',
      'in-progress': '进行中',
      'pending-acceptance': '等验收',
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
    const ACCEPTANCE_RESULT_TEXT = { pass: '通过', fail: '没通过', blocked: '卡住了' }
    const ACCEPTANCE_RESULT_TONE = { pass: 'ok', fail: 'bad', blocked: 'warn' }
    const ACCEPTANCE_ERROR_TEXT = {
      'item-required': '缺少验收项 ID，刷新面板再试。',
      'bad-result': '结果只能是「通过 / 没通过 / 卡住了 / 撤销」。',
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

    // 视觉回归：Host 每次截图都会与「该验收项的上一张截图」做逐像素比。
    // 界面只如实呈现 verdict / ratio / reason，绝不把 different-size 说成「没变化」。
    const DIFF_VERDICT_TEXT = {
      new: '第一次记录',
      same: '和上一版一样',
      changed: '和上一版有变化',
      'different-size': '页面尺寸变了',
      uncomparable: '没法比较',
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
      'baseline-url': '上一版是 URL 证据，不能逐像素比',
      'baseline-outside-project': '上一版截图在项目外，不能逐像素比',
      'baseline-not-png': '上一版不是 PNG 截图（只支持 PNG 逐像素比）',
      'baseline-bad-png': '上一版截图文件损坏或格式不支持',
      'baseline-too-large': '上一版截图超过 10 MiB，不做逐像素比',
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
      if (verdict === 'changed') return `和上一版有变化 ${diffPercent(diff.ratio)}`
      if (verdict === 'different-size') {
        const size = diff.width && diff.height ? `（${diff.width}×${diff.height}）` : ''
        return `页面尺寸变了${size}`
      }
      return DIFF_VERDICT_TEXT[verdict] || '没法比较'
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
      if (verdict === 'changed') return '已截图并附到证据 · 和上一版有变化'
      if (verdict === 'same') return '已截图并附到证据 · 和上一版一样'
      if (verdict === 'new') return '已截图并附到证据 · 第一次记录'
      if (verdict === 'different-size') return '已截图并附到证据 · 页面尺寸变了'
      return `已截图并附到证据 · 没法比较（${explainDiffReason(comparison.reason)}）`
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
      'iteration-required': '还没定下这一轮，先让 AI 记录一次进展。',
      'workspace-not-allowed': '这个工作区不在已登记列表里，无法写入批准标记。',
    }

    function explainApproveError(raw) {
      const message = String(raw == null ? '' : raw)
      for (const [code, text] of Object.entries(APPROVE_ERROR_TEXT)) {
        if (message.indexOf(code) >= 0) return text
      }
      return explainError(message)
    }

    // 决策门（P1）签核失败：告诉人"现在该去补什么"，而不是只丢一个错误码。
    const DECISION_ERROR_TEXT = {
      'prd-missing': '先写 PRD 再签核。',
      'architecture-gate-not-ready': '架构契约文件还不齐，先补齐。',
      'acceptance-not-passing': '验收还没全部通过（含证据）。',
      'release-gate-not-ready': '发布清单还不完整。',
      'bad-gate': '这个签核动作不认识，刷新重试。',
      'bad-iteration': '还没定下这一轮，刷新重试。',
      'prototype-missing': '先把原型 HTML 放到项目根目录 prototype.html，再点通过。',
      'iteration-required': '还没定下这一轮，先让 AI 记录一次进展。',
      'workspace-not-allowed': '这个工作区不在已登记列表里，无法写入签核记录。',
    }

    function explainDecisionError(raw) {
      const message = String(raw == null ? '' : raw)
      for (const [code, text] of Object.entries(DECISION_ERROR_TEXT)) {
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

    // ---------- 密度：紧凑 / 舒适（默认舒适），只影响样式 ----------

    function readDensity() {
      try {
        return window.localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'cozy'
      } catch {
        return 'cozy'
      }
    }

    function saveDensity(value) {
      try {
        window.localStorage.setItem(DENSITY_KEY, value === 'compact' ? 'compact' : 'cozy')
      } catch {
        // 记不住密度不影响使用
      }
    }

    // 空态按钮：把用户带到 hero 的复制按钮，聚焦但不自动复制（避免误操作）。
    function panelRoot() {
      return typeof document === 'undefined' ? null : document.querySelector('.dc-root')
    }
    function focusHeroCopy() {
      const root = panelRoot()
      const button = root ? root.querySelector('#dc-hero-copy') : null
      if (!button) return
      try {
        button.scrollIntoView({ block: 'center', behavior: 'smooth' })
      } catch {
        button.scrollIntoView()
      }
      button.focus()
    }

    // 功能 → 验收：滚到对应验收行、聚焦并高亮 2 秒（只在面板自己的 DOM 里找）。
    function jumpToAcceptance(id) {
      const root = panelRoot()
      if (!root) return
      const rows = root.querySelectorAll('[data-acc-id]')
      for (const row of rows) {
        if (row.getAttribute('data-acc-id') !== String(id)) continue
        try {
          row.scrollIntoView({ block: 'center', behavior: 'smooth' })
        } catch {
          row.scrollIntoView()
        }
        row.focus({ preventScroll: true })
        row.classList.add('dc-acc-flash')
        setTimeout(() => row.classList.remove('dc-acc-flash'), 2000)
        return
      }
    }

    // ---------- 项目动态：今天 / 本周 / 更早 ----------

    const startOfLocalDay = (date) => {
      const copy = new Date(date)
      copy.setHours(0, 0, 0, 0)
      return copy
    }

    const startOfLocalWeek = (date) => {
      const day = startOfLocalDay(date)
      const offset = (day.getDay() + 6) % 7 // 周一为一周起点
      day.setDate(day.getDate() - offset)
      return day
    }

    function timelineGroupOf(value) {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '更早'
      const now = new Date()
      const today = startOfLocalDay(now)
      if (date.getTime() >= today.getTime()) return '今天'
      const weekStart = startOfLocalWeek(now)
      if (date.getTime() >= weekStart.getTime()) return '本周'
      return '更早'
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
  font-size:13.5px; line-height:1.65; -webkit-font-smoothing:antialiased;
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

/* header：项目名 + 一句人话健康摘要；服务状态弱化成一个点 */
.dc-head-main { min-width:0; display:flex; flex-direction:column; gap:2px; }
.dc-head-summary {
  font-size:12px; color:var(--dsw-alias-label-secondary);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:460px;
}
.dc-service { display:inline-flex; align-items:center; gap:5px; font-size:11.5px; color:var(--dsw-alias-label-secondary); white-space:nowrap; }
.dc-service-dot { width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-success-primary); flex:none; }
.dc-workflow-controls { display:inline-flex; align-items:center; gap:6px; min-width:0; flex-wrap:wrap; }
.dc-mode-btn-light { border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, var(--dsw-alias-border-l2)); color:var(--dsw-alias-brand-primary); }
.dc-inline-msg { font-size:11.5px; color:var(--dsw-alias-label-secondary); max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dc-service-dot-warn { background:var(--dsw-alias-state-warn-primary); }

/* ---------- 页面骨架 ---------- */
.dc-body { max-width:1180px; margin:0 auto; padding:24px 20px 48px; display:flex; flex-direction:column; }
.dc-section-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; flex-wrap:wrap; margin:0 0 12px; }
/* ② 是整页唯一的焦点面（surface）：浅色一层底 + 1px 边 + 12 圆角。 */
.dc-section-title { margin:0; font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); letter-spacing:-.005em; }
.dc-section-meta { font-size:11.5px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; font-feature-settings:"tnum"; }

/* ---------- 按钮体系：30px / radius 8 / 13·600 ---------- */
.dc-btn {
  appearance:none; display:inline-flex; align-items:center; justify-content:center; gap:6px;
  height:30px; padding:0 12px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2);
  background:transparent; color:var(--dsw-alias-label-primary); text-decoration:none;
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

/* ---------- 状态 chip / 优先级 / 需要重新确认标记 ---------- */
.dc-chip {
  display:inline-flex; align-items:center; gap:5px; height:22px; padding:0 8px;
  border:1px solid var(--dsw-alias-border-l1); border-radius:6px;
  background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary);
  font-size:12px; font-weight:600; white-space:nowrap; max-width:100%;
}
.dc-chip::before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor; flex:none; }
.dc-chip-ok { color:var(--dsw-alias-state-success-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 32%, transparent); background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent); }
/* success ≡ ok：新模块按语义命名，旧 chip 的 ok 保留兼容。 */
.dc-chip-success { color:var(--dsw-alias-state-success-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 32%, transparent); background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent); }
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
h2.dc-name { margin:0; font-size:20px; line-height:1.3; font-weight:600; letter-spacing:-.015em; overflow-wrap:anywhere; }
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
.dc-action-title { margin:4px 0 0; font-size:20px; font-weight:600; line-height:1.35; letter-spacing:-.015em; overflow-wrap:anywhere; max-width:44em; }
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
.dc-gate { display:flex; flex-wrap:wrap; gap:6px 10px; align-items:center; margin-top:10px; font-size:12px; color:var(--dsw-alias-label-secondary); }
.dc-gate-label { font-weight:600; color:var(--dsw-alias-label-primary); }
.dc-gate-method, .dc-gate-detail { overflow-wrap:anywhere; }
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
.dc-progress-value { font-size:15px; font-weight:600; color:var(--dsw-alias-label-primary); font-variant-numeric:tabular-nums; font-feature-settings:"tnum"; }
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
  font-size:10px; line-height:1; font-weight:600; color:transparent; }
.dc-stage-name { margin-top:4px; font-size:12px; font-weight:500; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.dc-stage-state { font-size:11px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
.dc-stage-done .dc-stage-dot { border-color:var(--dsw-alias-state-success-primary); background:var(--dsw-alias-state-success-primary); color:var(--dsw-alias-bg-base); }
.dc-stage-done .dc-stage-name { color:var(--dsw-alias-label-primary); }
.dc-stage-current .dc-stage-dot { border:2px solid var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-base); box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
.dc-stage-current .dc-stage-name { color:var(--dsw-alias-brand-primary); font-weight:600; }
.dc-stage-current .dc-stage-state { color:var(--dsw-alias-brand-primary); font-weight:600; }
.dc-stage-pending { opacity:.72; }
.dc-stage-tap { display:flex; flex-direction:column; gap:2px; align-items:flex-start; width:100%; background:transparent; border:0; padding:0; color:inherit; font:inherit; text-align:left; cursor:pointer; border-radius:6px; }
.dc-stage-tap:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.dc-stage-selected .dc-stage-dot { box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 26%, transparent); }
.dc-stage-detail { margin-top:16px; padding:12px 14px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-layer-1); font-size:12.5px; }
.dc-stage-detail-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:8px; }
.dc-stage-detail-head strong { font-size:13px; }
.dc-stage-detail-head .dc-btn { margin-left:auto; }
.dc-stage-row { display:flex; gap:10px; padding:3px 0; align-items:baseline; }
.dc-stage-row-column { flex-direction:column; gap:3px; }
.dc-stage-row-label { flex:none; min-width:64px; color:var(--dsw-alias-label-secondary); font-size:11.5px; font-weight:600; }
.dc-stage-row-value { color:var(--dsw-alias-label-primary); overflow-wrap:anywhere; }
.dc-stage-list { margin:0; padding-left:16px; display:flex; flex-direction:column; gap:2px; color:var(--dsw-alias-label-primary); overflow-wrap:anywhere; }
.dc-stage-caps { display:flex; flex-wrap:wrap; gap:6px; }
.dc-stage-empty { color:var(--dsw-alias-label-secondary); }

/* ---------- ③½ 交付指标（代理口径）：4 张数卡 + 2 条小指标 ---------- */
.dc-metric-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; }
.dc-metric {
  display:flex; flex-direction:column; gap:2px; min-width:0; padding:10px 12px;
  border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1);
}
.dc-metric-label { font-size:11px; font-weight:600; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.dc-metric-value {
  font-size:18px; font-weight:600; line-height:1.25; color:var(--dsw-alias-label-primary);
  font-variant-numeric:tabular-nums; font-feature-settings:"tnum"; overflow-wrap:anywhere;
}
.dc-metric-value-null { color:var(--dsw-alias-label-secondary); }
.dc-metric-mini-row {
  display:flex; gap:4px 18px; flex-wrap:wrap; margin-top:10px;
  font-size:12px; color:var(--dsw-alias-label-secondary);
}
.dc-metric-mini { display:inline-flex; align-items:baseline; gap:6px; min-width:0; }
.dc-metric-mini-value {
  color:var(--dsw-alias-label-primary); font-weight:600;
  font-variant-numeric:tabular-nums; font-feature-settings:"tnum";
}
.dc-metric-mini-value-null { color:var(--dsw-alias-label-secondary); }
.dc-metric-note { margin:8px 0 0; font-size:11.5px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }

/* ---------- ④ 功能 & 待修问题账 ---------- */
.dc-decision { margin:0 0 12px; padding:12px 14px; border-radius:8px;
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 38%, transparent);
  background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent); }
.dc-decision-title { font-weight:600; color:var(--dsw-alias-state-warn-primary); overflow-wrap:anywhere; }
.dc-decision-options { margin:6px 0 0; padding-left:18px; font-size:12.5px; display:flex; flex-direction:column; gap:3px; overflow-wrap:anywhere; }
.dc-decision-reco { margin-top:6px; font-size:12px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.dc-board-meta { display:none; }
.dc-board-counts { color:var(--dsw-alias-label-primary); font-weight:600; font-variant-numeric:tabular-nums; }

/* ---------- 功能：人话列表（行可展开，展开才是技术细节） ---------- */
.dc-feature-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; }
.dc-feature-item { min-width:0; border-bottom:1px solid var(--dsw-alias-border-l1); }
.dc-feature-item:last-child { border-bottom:0; }
.dc-feature-row {
  appearance:none; width:100%; background:transparent; border:0; color:inherit; font:inherit;
  display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:12px;
  min-height:52px; padding:10px 8px; text-align:left; cursor:pointer;
  transition:background-color .15s ease-out;
}
.dc-feature-row:hover { background:var(--dsw-alias-bg-layer-1); }
.dc-feature-row:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:-2px; }
.dc-feature-main { min-width:0; display:flex; flex-direction:column; gap:2px; }
.dc-feature-name { font-size:14px; font-weight:600; color:var(--dsw-alias-label-primary); overflow-wrap:anywhere; }
.dc-feature-recent {
  font-size:12px; color:var(--dsw-alias-label-secondary);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.dc-feature-side { display:flex; align-items:center; gap:8px; flex:none; }
.dc-feature-acceptance { font-size:11.5px; color:var(--dsw-alias-label-secondary); white-space:nowrap; font-variant-numeric:tabular-nums; }
.dc-feature-toggle { font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.dc-feature-detail { padding:4px 8px 14px 8px; display:flex; flex-direction:column; gap:8px; }
.dc-detail-line { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; font-size:12.5px; min-width:0; }
.dc-detail-label { flex:0 0 64px; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.dc-detail-hint { color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.dc-detail-block { display:flex; flex-direction:column; gap:4px; font-size:12.5px; }
.dc-detail-block .dc-detail-label { flex:none; }
.dc-more { margin-top:6px; }
.dc-more > summary { cursor:pointer; font-size:12px; color:var(--dsw-alias-label-secondary); padding:4px 0; }
.dc-more > summary:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; border-radius:3px; }
.dc-more-body { display:flex; flex-direction:column; gap:8px; padding:8px 0 2px; }
.dc-progress-summary { margin:0 0 14px; font-size:12.5px; color:var(--dsw-alias-label-secondary); }

/* ---------- 验收：默认极简，细节折叠 ---------- */
.dc-acc-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; }
.dc-acc-item { min-width:0; border-bottom:1px solid var(--dsw-alias-border-l1); padding:10px 0; }
.dc-acc-item:last-child { border-bottom:0; }
.dc-acc-row { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:10px 16px; }
.dc-acc-main { min-width:0; display:flex; flex-direction:column; gap:4px; }
.dc-acc-title { font-size:14px; font-weight:600; color:var(--dsw-alias-label-primary); overflow-wrap:anywhere; }
.dc-acc-sub { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dc-acc-warn { font-size:12px; color:var(--dsw-alias-state-warn-primary); }
.dc-acc-actions { display:flex; gap:4px; flex-wrap:nowrap; align-items:center; justify-content:flex-end; }
.dc-acc-actions .dc-btn { flex:none; }
.dc-acc-more { margin-top:2px; }
.dc-acc-saved { margin-top:4px; font-size:11.5px; color:var(--dsw-alias-state-success-primary); }
.dc-diff-block { display:flex; flex-direction:column; align-items:flex-start; gap:6px; }

/* ---------- 空态：一句原因 + 一个真能用的动作 ---------- */
.dc-empty-state {
  display:flex; flex-direction:column; align-items:flex-start; gap:8px;
  padding:20px; border:1px dashed var(--dsw-alias-border-l2); border-radius:10px;
  background:var(--dsw-alias-bg-base);
}
.dc-empty-state-inline { padding:14px; }
.dc-empty-title { font-size:14px; font-weight:600; color:var(--dsw-alias-label-primary); }
.dc-empty-reason { margin:0; font-size:12.5px; color:var(--dsw-alias-label-secondary); }

/* ---------- 功能 ↔ 验收联动 ---------- */
.dc-related-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; }
.dc-related-item { display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0; }
.dc-related-title { font-size:12.5px; overflow-wrap:anywhere; }
.dc-related-item .dc-btn { margin-left:auto; }
.dc-acc-item:focus-visible, .dc-acc-item:focus { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:-2px; border-radius:4px; }
.dc-acc-flash { background-color:var(--dsw-alias-bg-layer-2); transition:background-color .15s ease-out; }

/* ---------- 密度切换 ---------- */
.dc-root.dc-compact { font-size:13px; }
.dc-compact .dc-feature-row { min-height:40px; padding:6px 8px; }
.dc-compact .dc-acc-item { padding:6px 0; }
.dc-compact .dc-thumb { width:24px; height:24px; }
.dc-compact .dc-diff-thumb { width:24px; height:24px; }
.dc-compact .dc-more-body { gap:6px; }
.dc-density { font-size:11.5px; }

/* ---------- 键盘说明 ---------- */
.dc-shortcuts { position:relative; font-size:11.5px; }
.dc-shortcuts-summary { cursor:pointer; color:var(--dsw-alias-label-secondary); list-style:none; }
.dc-shortcuts-summary::-webkit-details-marker { display:none; }
.dc-shortcuts-summary:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; border-radius:3px; }
.dc-shortcuts[open] .dc-shortcuts-summary { color:var(--dsw-alias-label-primary); }
.dc-shortcuts-body {
  position:absolute; right:0; top:22px; z-index:6; width:230px;
  display:flex; flex-direction:column; gap:6px; padding:10px 12px;
  border:1px solid var(--dsw-alias-border-l1); border-radius:8px;
  background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary);
  font-size:11.5px; box-shadow:none;
}
.dc-shortcuts-body kbd {
  display:inline-block; min-width:18px; padding:0 4px; border:1px solid var(--dsw-alias-border-l2);
  border-radius:4px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary);
  font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:10.5px; text-align:center;
}

/* ---------- 动态分组 ---------- */
.dc-timeline-scroll { max-height:420px; overflow-y:auto; scrollbar-width:thin; }
.dc-timeline-group + .dc-timeline-group { margin-top:10px; }
.dc-timeline-group-title {
  font-size:11px; font-weight:600; color:var(--dsw-alias-label-secondary);
  padding:2px 0 4px;
}
.dc-receipts-timeline { list-style:none; margin:0; padding:0; }
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

/* ---------- 动态 ---------- */
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
.dc-summary-progress { flex:1 1 120px; min-width:60px; height:3px; border-radius:999px; background:var(--dsw-alias-bg-layer-2); overflow:hidden; }
.dc-summary-fill { display:block; height:100%; border-radius:999px; background:var(--dsw-alias-brand-primary); transition:width .15s ease-out; }

.dc-layout { display:grid; grid-template-columns:minmax(0,1fr); gap:20px; align-items:start; }
.dc-main { min-width:0; display:flex; flex-direction:column; container-type:inline-size; }

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
.dc-review-settings { font-size:11.5px; }
.dc-review-settings-summary { cursor:pointer; color:var(--dsw-alias-label-secondary); list-style:none; }
.dc-review-settings-summary::-webkit-details-marker { display:none; }
.dc-review-settings-summary:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; border-radius:4px; }
.dc-review-settings[open] > .dc-review-settings-summary { color:var(--dsw-alias-label-primary); }
.dc-review-settings-body { display:flex; flex-direction:column; gap:8px; padding-top:8px; }
.dc-review-settings-body label { display:flex; flex-direction:column; gap:4px; font-size:11px; color:var(--dsw-alias-label-secondary); }
.dc-review-settings-body select, .dc-review-settings-body input { width:100%; height:28px; padding:0 8px; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; box-sizing:border-box; }
.dc-review-settings-body select:focus-visible, .dc-review-settings-body input:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.dc-review-settings-hint { margin:0; font-size:11px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.dc-review-settings-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
/* header 里的评审器菜单：贴在模式切换旁边，点开是浮层，不用滚到右栏底部 */
.dc-review-settings-header { position:relative; }
.dc-review-settings-header > .dc-review-settings-body {
  position:absolute; right:0; top:calc(100% + 6px); z-index:30; width:264px;
  padding:12px; border:1px solid var(--dsw-alias-border-l1); border-radius:10px;
  background:var(--dsw-alias-bg-base);
  box-shadow:0 10px 28px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent);
}
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

/* 动态时间线 */
.dc-receipts-timeline { list-style:none; margin:0; padding:0; scrollbar-width:thin; }
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

/* ===== 模块化工作台：画布 layer-1 / 模块卡 layer-2 / 模块头 layer-1 ===== */
.dc-root { background:var(--dsw-alias-bg-layer-1); font-size:13.5px; line-height:1.65; font-weight:400; }
.dc-head { background:var(--dsw-alias-bg-layer-1); }
.dc-body { gap:16px; }
.dc-layout { gap:20px; }
.dc-main { gap:16px; }
.dc-module {
  min-width:0; overflow:hidden;
  background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l1);
  border-radius:12px;
}
.dc-module-head {
  height:42px; padding:0 16px; box-sizing:border-box;
  display:flex; align-items:center; gap:10px;
  background:var(--dsw-alias-bg-layer-1);
  border-bottom:1px solid var(--dsw-alias-border-l1);
}
/* 图标底片：24×24、圆角 6、tone 10% 底；idle 用 layer-1 + 次要色 */
.dc-module-icon {
  width:24px; height:24px; border-radius:6px; box-sizing:border-box;
  display:inline-flex; align-items:center; justify-content:center; flex:none;
  background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary);
}
.dc-module-icon-brand { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); color:var(--dsw-alias-brand-primary); }
.dc-module-icon-success { background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); color:var(--dsw-alias-state-success-primary); }
.dc-module-icon-warn { background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); color:var(--dsw-alias-state-warn-primary); }
.dc-module-icon-error { background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); color:var(--dsw-alias-state-error-primary); }
.dc-module-icon-idle { background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary); }

/* 摘要数字：只有有语义的数字上色 */
.dc-summary-value.dc-summary-success { color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 70%, var(--dsw-alias-label-primary)); }
.dc-summary-value.dc-summary-brand { color:color-mix(in srgb, var(--dsw-alias-brand-primary) 70%, var(--dsw-alias-label-primary)); }
.dc-summary-value.dc-summary-warn { color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 70%, var(--dsw-alias-label-primary)); }
.dc-summary-value.dc-summary-error { color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 70%, var(--dsw-alias-label-primary)); }

/* hero 4px 阶段色带：轨道 layer-2，推进部分 brand（decide 时 warn） */
.dc-hero-band { height:4px; width:100%; background:var(--dsw-alias-bg-layer-2); overflow:hidden; }
.dc-hero-band-fill { display:block; height:100%; background:var(--dsw-alias-brand-primary); }
.dc-hero-band-warn .dc-hero-band-fill { background:var(--dsw-alias-state-warn-primary); }

/* 功能行 3px 细进度条 */
.dc-feature-progress {
  width:60px; height:3px; flex:none; border-radius:2px; overflow:hidden;
  background:var(--dsw-alias-bg-layer-2); display:inline-block; vertical-align:middle;
}
.dc-feature-progress-fill { display:block; height:100%; background:var(--dsw-alias-brand-primary); }
.dc-feature-progress-full { background:var(--dsw-alias-state-success-primary); }
.dc-module-title { margin:0; font-size:13px; font-weight:600; letter-spacing:0; color:var(--dsw-alias-label-primary); }
.dc-module-meta { margin-left:auto; font-size:11.5px; font-weight:500; letter-spacing:0; color:var(--dsw-alias-label-secondary); white-space:nowrap; }
.dc-module-meta-ok { color:var(--dsw-alias-state-success-primary); }
.dc-module-meta-warn { color:var(--dsw-alias-state-warn-primary); }
.dc-module-meta-unknown { color:var(--dsw-alias-label-secondary); }
.dc-module-body { padding:16px; min-width:0; }
.dc-module-hero {
  background:color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, var(--dsw-alias-bg-layer-2));
  border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, var(--dsw-alias-border-l1));
}
.dc-module-hero .dc-module-body { padding:18px 20px; }
.dc-module-warn {
  border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, var(--dsw-alias-border-l1));
  background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 7%, var(--dsw-alias-bg-layer-2));
}
.dc-summary-module .dc-module-body { padding:10px 16px; }
.dc-summary-module .dc-summary-bar { border:0; margin:0; padding:0; }
.dc-summary-stat + .dc-summary-stat { border-left:1px solid var(--dsw-alias-border-l1); padding-left:16px; }
.dc-summary-label { font-size:11.5px; font-weight:500; letter-spacing:0; }
.dc-summary-value { font-size:14px; font-weight:700; }
.dc-summary-progress { height:4px; }

/* 右栏：4 个独立模块，不再是连通面板 */
.dc-rail { display:flex; flex-direction:column; gap:12px; min-width:0; padding:0; border:0; border-radius:0; background:transparent; }
.dc-rail-group, .dc-rail-details { border:0; margin:0; padding:0; }
.dc-rail-note { font-size:12px; font-weight:400; color:var(--dsw-alias-label-secondary); margin:0; }

/* 团队泳道：名字 + 角色/层级 + 在线状态，只读 */
.dc-team-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; min-width:0; }
.dc-team-row { display:flex; align-items:baseline; gap:8px; min-width:0; font-size:12px; }
.dc-team-name { font-weight:600; color:var(--dsw-alias-label-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.dc-team-role { font-size:11px; color:var(--dsw-alias-label-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.dc-team-row .dc-chip { margin-left:auto; height:18px; padding:0 6px; font-size:10.5px; border:0; background:transparent; }
.dc-team-row .dc-chip::before { width:5px; height:5px; }

/* 能力建议：替代 / 安装（只展示链接与可复制命令，不执行、不自动安装） */
.dc-advice-list { list-style:none; margin:8px 0 0; padding:0; display:flex; flex-direction:column; gap:6px; min-width:0; }
.dc-advice { display:flex; align-items:baseline; gap:6px; flex-wrap:wrap; min-width:0; font-size:11.5px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.dc-advice-name { color:var(--dsw-alias-label-primary); font-weight:600; }
.dc-advice-install { display:inline-flex; align-items:baseline; gap:6px; flex-wrap:wrap; min-width:0; }
.dc-advice-target { display:inline-flex; align-items:baseline; gap:6px; flex-wrap:wrap; min-width:0; }
.dc-advice-link { color:var(--dsw-alias-brand-primary); text-decoration:underline; text-underline-offset:2px; }
.dc-advice-link:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; border-radius:3px; }
.dc-advice-cmd { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:11px; padding:1px 5px; border-radius:4px;
  background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); overflow-wrap:anywhere; }
.dc-advice-note { font-size:11px; color:var(--dsw-alias-label-secondary); }
.dc-stage-row-when { font-size:11px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }

/* 展开细节 / 代码 / 空态：比模块卡更浅一层 */
.dc-feature-detail, .dc-more-body, .dc-instruction, .dc-code-block, .dc-plan {
  background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1);
  border-radius:8px;
}
.dc-feature-detail { padding:12px; }
.dc-more-body { padding:12px; }
.dc-instruction { padding:12px 14px; }
.dc-code-block { padding:10px 12px; }
.dc-empty-state { background:var(--dsw-alias-bg-layer-1); border:1px dashed var(--dsw-alias-border-l2); border-radius:8px; }
.dc-empty-head { display:flex; align-items:center; gap:8px; }
.dc-empty-icon { display:inline-flex; color:var(--dsw-alias-label-secondary); }
.dc-empty-title { font-size:13.5px; font-weight:600; }
.dc-empty-reason { font-size:12px; font-weight:400; }

/* 字重阶梯：22/700 只给 hero，行名/模块标题 600，正文 400，meta 500 */
.dc-action-title { font-size:22px; font-weight:700; line-height:1.3; letter-spacing:-.02em; }
.dc-action-reason { font-size:13.5px; font-weight:400; }
.dc-action-eyebrow { font-size:11.5px; font-weight:600; letter-spacing:0; color:var(--dsw-alias-label-secondary); }
.dc-feature-name, .dc-acc-title { font-size:13.5px; font-weight:600; }
.dc-feature-recent, .dc-acc-sub, .dc-progress-summary { font-weight:400; }
.dc-chip { font-size:11.5px; font-weight:600; letter-spacing:0; }
.dc-ws-card { background:var(--dsw-alias-bg-layer-2); border-radius:12px; }
.dc-ws-title { font-size:14px; font-weight:600; }

/* 紧凑：模块头 36 / body 12 / 间距 10 / 行 40 / 正文 13 */
.dc-compact .dc-module-head { height:36px; padding:0 14px; }
.dc-compact .dc-module-body { padding:12px; }
.dc-compact .dc-main { gap:10px; }
.dc-compact .dc-rail { gap:10px; }
.dc-compact .dc-feature-row { min-height:40px; }
.dc-compact .dc-feature-progress { width:48px; }
.dc-compact .dc-acc-item { padding:6px 0; }

/* header 高 71；摘要条模块常驻在 header 下，右栏再让开摘要高度。 */
@container (min-width:641px) {
  .dc-summary-module { position:sticky; top:71px; z-index:4; }
}

/* 容器查询：面板实际宽度 ≥1170 时才分两栏（右栏 280px）。 */
@container (min-width:1170px) {
  .dc-layout { grid-template-columns:minmax(0,1fr) 280px; }
  .dc-rail { position:sticky; top:118px; z-index:2; }
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
  .dc-module-body { padding:12px; }
  .dc-module-head { height:38px; padding:0 12px; }
  .dc-main, .dc-rail { gap:12px; }
  .dc-feature-row, .dc-acc-row { grid-template-columns:minmax(0,1fr); }
  .dc-feature-side { flex-wrap:wrap; }
  .dc-feature-progress { width:40px; }
  .dc-metric-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .dc-metric-value { font-size:16px; }
  .dc-feature-side { justify-content:flex-start; flex-wrap:wrap; }
  .dc-acc-actions { justify-content:flex-start; flex-wrap:wrap; }
  .dc-feature-row { min-height:0; }
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

    // 区标题：保留给空态/说明使用；模块本身走 Module 组件。
    function SectionHead(props) {
      return h(
        'div',
        { className: 'dc-section-head' },
        h('h2', { className: 'dc-section-title' }, props.title),
        props.meta ? h('span', { className: 'dc-section-meta' }, props.meta) : null,
      )
    }

    // 16×16 线性图标（authored inline SVG）：只放模块头与空态。
    function ModuleIcon(props) {
      const name = props.name || 'info'
      const base = {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }
      const shapes = {
        next: [
          h('path', { key: 'a', d: 'M3 8h8.5' }),
          h('path', { key: 'b', d: 'M8.3 4.6 11.7 8l-3.4 3.4' }),
        ],
        progress: [
          h('path', { key: 'a', d: 'M4.2 8h1.6M9 8h1.6' }),
          h('circle', { key: 'b', cx: 3, cy: 8, r: 1.3 }),
          h('circle', { key: 'c', cx: 8, cy: 8, r: 1.3 }),
          h('circle', { key: 'd', cx: 13, cy: 8, r: 1.3 }),
        ],
        feature: [
          h('path', { key: 'a', d: 'M8 2.4 13.6 5.5 8 8.6 2.4 5.5z' }),
          h('path', { key: 'b', d: 'M2.4 8.2 8 11.3l5.6-3.1' }),
          h('path', { key: 'c', d: 'M2.4 10.7 8 13.8l5.6-3.1' }),
        ],
        acceptance: [
          h('rect', { key: 'a', x: 2.5, y: 2.5, width: 11, height: 11, rx: 2 }),
          h('path', { key: 'b', d: 'm5.2 8.1 1.9 1.9 3.7-3.9' }),
        ],
        defects: [
          h('path', { key: 'a', d: 'M8 2.4 13.9 13H2.1z' }),
          h('path', { key: 'b', d: 'M8 6.1v3' }),
          h('circle', { key: 'c', cx: 8, cy: 11.2, r: 0.7, fill: 'currentColor', stroke: 'none' }),
        ],
        review: [
          h('path', { key: 'a', d: 'M8 2.2 13 4v3.5c0 3-2.1 5.4-5 6.3-2.9-.9-5-3.3-5-6.3V4z' }),
          h('path', { key: 'b', d: 'm5.7 8.1 1.7 1.7 3.1-3.2' }),
        ],
        receipts: [
          h('circle', { key: 'a', cx: 8, cy: 8, r: 5.5 }),
          h('path', { key: 'b', d: 'M8 4.8V8l2.2 1.3' }),
        ],
        team: [
          h('circle', { key: 'a', cx: 6, cy: 5.6, r: 2 }),
          h('path', { key: 'b', d: 'M2.6 12.8c.4-2 1.8-3.1 3.4-3.1s3 1.1 3.4 3.1' }),
          h('circle', { key: 'c', cx: 11.5, cy: 6, r: 1.6 }),
          h('path', { key: 'd', d: 'M9.9 10.6c1.6-.3 3 .7 3.4 2.2' }),
        ],
        info: [
          h('circle', { key: 'a', cx: 8, cy: 8, r: 5.5 }),
          h('path', { key: 'b', d: 'M8 7.2v3.3' }),
          h('circle', { key: 'c', cx: 8, cy: 5.2, r: 0.7, fill: 'currentColor', stroke: 'none' }),
        ],
      }
      return h('svg', base, shapes[name] || shapes.info)
    }

    // 统一模块卡：模块头（图标+标题+meta）+ 模块体。
    function Module(props) {
      // 透传未知属性（role/aria-* 等）：模块只是容器，不能吞掉调用方的无障碍语义。
      const { className, title, icon, tone, band, meta, metaTone, level, children, ...rest } = props
      const Heading = level === 3 ? 'h3' : 'h2'
      return h(
        'section',
        { className: `dc-module${className ? ` ${className}` : ''}`, ...rest },
        band || null,
        title
          ? h(
              'div',
              { className: 'dc-module-head' },
              h(
                'span',
                { className: `dc-module-icon dc-module-icon-${tone || 'idle'}` },
                h(ModuleIcon, { name: icon || 'info' }),
              ),
              h(Heading, { className: 'dc-module-title' }, title),
              meta
                ? h(
                    'span',
                    { className: `dc-module-meta${metaTone ? ` dc-module-meta-${metaTone}` : ''}` },
                    meta,
                  )
                : null,
            )
          : null,
        h('div', { className: 'dc-module-body' }, children),
      )
    }

    // 空态统一形状：一句为什么 + 一个真能用的动作（默认带用户去 hero 复制）。
    function EmptyState(props) {
      return h(
        'div',
        { className: props.inline ? 'dc-empty-state dc-empty-state-inline' : 'dc-empty-state' },
        h(
          'div',
          { className: 'dc-empty-head' },
          h('span', { className: 'dc-empty-icon' }, h(ModuleIcon, { name: props.icon || 'info' })),
          h('div', { className: 'dc-empty-title' }, props.title),
        ),
        props.reason ? h('p', { className: 'dc-empty-reason' }, props.reason) : null,
        props.children || null,
        props.actionLabel
          ? h(
              'button',
              {
                type: 'button',
                className: props.primary ? 'dc-btn dc-btn-sm dc-btn-primary' : 'dc-btn dc-btn-sm',
                disabled: props.disabled === true,
                onClick: props.onAction || focusHeroCopy,
              },
              props.actionLabel,
            )
          : null,
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
            h('span', { className: 'dc-sub' }, '看一眼项目走到哪了'),
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

      // 总览页也轮询：多项目时首页状态会变（比如 Agent 刚写完一条动态）。
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

    // 面板键盘导航：j/k 在行间移动，Enter 展开，Esc 收起/回顶部，? 打开快捷键说明。
    // 输入控件内不劫持；监听挂在面板根上，组件卸载时移除。
    function usePanelKeyboard(rootRef) {
      React.useEffect(() => {
        const node = rootRef.current
        if (!node) return undefined
        const isEditable = (element) =>
          Boolean(
            element &&
              (element.tagName === 'INPUT' ||
                element.tagName === 'TEXTAREA' ||
                element.tagName === 'SELECT' ||
                element.isContentEditable),
          )
        const rows = () => Array.from(node.querySelectorAll('[data-kb-row]'))
        const onKeyDown = (event) => {
          if (isEditable(event.target)) return
          if (event.key === 'j' || event.key === 'k') {
            const list = rows()
            if (list.length === 0) return
            event.preventDefault()
            const index = list.indexOf(document.activeElement)
            const step = event.key === 'j' ? 1 : -1
            const next = index < 0 ? (step === 1 ? 0 : list.length - 1) : (index + step + list.length) % list.length
            list[next].focus()
            return
          }
          if (event.key === 'Enter') {
            const row = event.target.closest ? event.target.closest('[data-kb-row]') : null
            if (!row) return
            // 焦点在行内按钮/链接/输入等交互元素上时，把 Enter 交还给浏览器（否则会抢掉"通过/撤销"等点击）。
            const interactive = event.target.closest
              ? event.target.closest('button, a, summary, input, textarea, select, [role="button"]')
              : null
            if (interactive && interactive !== row) return
            // 功能行是原生 button，回车由浏览器处理；验收行是 div[tabindex]，这里手动开合细节。
            if (row.classList.contains('dc-acc-item')) {
              const details = row.querySelector('.dc-acc-more')
              if (details) {
                event.preventDefault()
                details.open = !details.open
              }
            }
            return
          }
          if (event.key === 'Escape') {
            const expandedFeature = node.querySelector('.dc-feature-row[aria-expanded="true"]')
            if (expandedFeature) {
              event.preventDefault()
              expandedFeature.click()
              return
            }
            const openDetail = node.querySelector('.dc-acc-more[open]')
            if (openDetail) {
              event.preventDefault()
              openDetail.open = false
              return
            }
            // 回顶：用 scrollIntoView 让最近的滚动容器把面板顶部带进视口（dc-root 自己不是滚动容器）。
            const scrolled = (typeof window !== 'undefined' && window.scrollY > 0) || node.getBoundingClientRect().top < -1
            if (!scrolled) return
            event.preventDefault()
            try {
              node.scrollIntoView({ block: 'start', behavior: 'smooth' })
            } catch {
              node.scrollIntoView({ block: 'start' })
            }
            return
          }
          if (event.key === '?') {
            const shortcuts = node.querySelector('.dc-shortcuts')
            if (shortcuts) {
              event.preventDefault()
              shortcuts.open = true
              const summary = shortcuts.querySelector('summary')
              if (summary && typeof summary.focus === 'function') summary.focus()
            }
          }
        }
        node.addEventListener('keydown', onKeyDown)
        return () => node.removeEventListener('keydown', onKeyDown)
      }, [rootRef])
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
          title: item.path || '',
          onClick: () => props.onOpen(item.path),
          'aria-label': `打开项目 ${title}`,
        },
        h(
          'div',
          { className: 'dc-ws-top' },
          h('span', { className: 'dc-ws-title' }, title),
          degraded
            ? h(Chip, { tone: 'unknown', title: '有些数据没读到' }, '数据不全')
            : null,
          hasDecision ? h(Chip, { tone: 'warn' }, '需要你决定') : null,
          initialized ? null : h(Chip, { tone: 'warn' }, '还没初始化'),
        ),
        h(
          'div',
          { className: 'dc-ws-meta' },
          stageName ? `现在：${stageName}` : '还没开始',
        ),
        h('div', { className: 'dc-ws-next' }, nextTitle ? `下一步：${nextTitle}` : '下一步：—'),
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
          h('span', { className: 'dc-sub' }, '看看每个项目走到哪了'),
          h('span', { className: 'dc-spacer' }),
          h('span', { className: 'dc-section-meta' }, `共 ${projects.length} 个项目`),
          h(
            'button',
            {
              type: 'button',
              className: 'dc-btn dc-btn-ghost dc-density',
              'aria-pressed': props.density === 'compact' ? 'true' : 'false',
              title: '在紧凑和舒适之间切换',
              onClick: props.onToggleDensity,
            },
            props.density === 'compact' ? '紧凑' : '舒适',
          ),
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
            '在任意目录里打开一个会话后，这里会自动出现该项目；空目录也算项目，会显示「还没初始化」。',
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
        { className: `dc-root${props.density === 'compact' ? ' dc-compact' : ''}` },
        header,
        h('main', { className: 'dc-body' }, content),
      )
    }

    function InitPanel(props) {
      const [state, setState] = React.useState({ step: 'idle', plan: null, result: null, error: '' })
      // hero 里同一屏只允许一个实心 accent 按钮：有「复制给 AI」时初始化/确认降为描边次按钮。
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
          h(EmptyState, {
            inline: true,
            icon: 'progress',
            primary: props.primary !== false,
            disabled: props.disabled === true,
            title: '项目还没初始化',
            reason: '先把项目规则和记录建好，再开始下一步。',
            actionLabel: '初始化此项目',
            onAction: loadPlan,
          }),
          h('span', { className: 'dc-hint' }, '先预览会写哪些文件，确认后才会写。'),
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

    // 原型批准：design §5.3 的检查落点。批准标记由 Host 按 iteration_id 写盘，
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

    // 哪些下一步动作对应一个决策门：kind 由 Host 状态机给出，按钮文案与 gate 名在这里收口。
    // 原型通过保留单独组件（已有文案与回归测试），四个新签核共用这一个。
    const DECISION_GATE_BY_KIND = {
      'scope-approval': { gate: 'scope', label: '确认范围', doneText: '已确认范围，正在刷新…', approvedText: '确认范围' },
      'architecture-approval': { gate: 'architecture', label: '架构签核', doneText: '已签核架构，正在刷新…', approvedText: '签核架构' },
      'acceptance-approval': { gate: 'acceptance', label: '确认验收', doneText: '已确认验收，正在刷新…', approvedText: '确认验收' },
      'release-approval': { gate: 'release', label: '批准发布', doneText: '已批准发布，正在刷新…', approvedText: '批准发布' },
    }

    // 决策门签核：Host 会按 gate 校验前置（PRD / 契约文件 / 验收全绿 / 发布清单），
    // 客户端只发「我确认了」，失败按错误码说人话。
    function DecisionGateButton(props) {
      const [state, setState] = React.useState({ step: 'idle', error: '' })
      const primaryClass = props.primary === false ? 'dc-btn' : 'dc-btn dc-btn-primary'
      if (props.approved === true) {
        return h(
          'span',
          { className: 'dc-hint dc-hint-ok', title: props.at ? new Date(props.at).toLocaleString() : '' },
          `已于 ${props.at ? formatRelative(props.at) : '—'}${props.approvedText || '签核'}`,
        )
      }
      if (state.step === 'done') {
        return h('span', { className: 'dc-hint dc-hint-ok' }, props.doneText || '已签核，正在刷新…')
      }
      const approve = async () => {
        setState({ step: 'saving', error: '' })
        try {
          const body = await postJson(`${API}/approve`, {
            path: props.projectPath,
            iteration_id: props.iterationId,
            gate: props.gate,
          })
          if (!body || body.ok !== true) throw new Error('approval-failed')
          setState({ step: 'done', error: '' })
          if (props.onApproved) props.onApproved(body)
        } catch (failure) {
          setState({ step: 'idle', error: explainDecisionError(messageOf(failure)) })
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
          state.step === 'saving' ? '提交中…' : props.label,
        ),
        state.error ? h('span', { className: 'dc-hint dc-hint-bad' }, state.error) : null,
      )
    }

    // 缺失 / 可选能力的「替代 / 安装」建议：只展示链接与可复制命令，不执行、不自动安装。
    // 只有 Host 给了 advice（已知能力）才渲染；未知能力不猜，不出现这一块。
    function CapabilityAdvice(props) {
      const items = asArray(props.items).filter((item) => item && item.advice)
      if (items.length === 0) return null
      return h(
        'ul',
        { className: 'dc-advice-list', 'aria-label': '缺失能力的替代与安装' },
        items.map((item, index) => {
          const advice = item.advice || {}
          const install = asArray(advice.install)
          return h(
            'li',
            { key: `advice${index}`, className: 'dc-advice' },
            h('span', { className: 'dc-advice-name' }, item.name || '未命名能力'),
            advice.fallback ? h('span', { className: 'dc-advice-fallback' }, `替代：${advice.fallback}`) : null,
            install.length > 0
              ? h(
                  'span',
                  { className: 'dc-advice-install' },
                  h('span', null, '安装：'),
                  install.map((target, targetIndex) =>
                    h(
                      'span',
                      { key: `install${targetIndex}`, className: 'dc-advice-target' },
                      // 有链接才给 <a>，可读文本就是安装项名字；没有链接就只显示名字，不编地址。
                      target.url
                        ? h(
                            'a',
                            {
                              className: 'dc-advice-link',
                              href: target.url,
                              target: '_blank',
                              rel: 'noreferrer',
                            },
                            target.label || target.url,
                          )
                        : h('span', null, target.label || '按文档安装'),
                      // 命令只渲染成可复制文本，不提供执行入口。
                      target.command ? h('code', { className: 'dc-advice-cmd' }, target.command) : null,
                    ),
                  ),
                )
              : null,
            advice.note ? h('span', { className: 'dc-advice-note' }, advice.note) : null,
          )
        }),
      )
    }

    function NextActionSection(props) {
      const action = props.action || {}
      const iteration = props.iteration || {}
      const prototype = iteration.prototype || {}
      const iterationId = iteration.current || ''
      const stageText =
        action.stageName || STAGE_TEXT[action.stageId] || (action.kind === 'init' ? '初始化' : '下一步')
      const cycleNodes = asArray(props.progression && props.progression.cycle)
      const cycleIndex = cycleNodes.findIndex((node) => node && node.stageId === action.stageId)
      const stepText =
        cycleIndex >= 0
          ? `第 ${cycleIndex + 1} 步 / 共 ${cycleNodes.length || 8} 步 · ${stageText}`
          : stageText
      const bandPercent =
        cycleIndex >= 0 && cycleNodes.length > 0
          ? Math.round(((cycleIndex + 1) / cycleNodes.length) * 100)
          : 0
      const heroTone = action.kind === 'decide' ? 'warn' : 'brand'
      const heroBand = h(
        'div',
        { className: `dc-hero-band${heroTone === 'warn' ? ' dc-hero-band-warn' : ''}`, 'aria-hidden': 'true' },
        h('span', { className: 'dc-hero-band-fill', style: { width: `${bandPercent}%` } }),
      )
      const missing = asArray(action.missing)
      const caps = asArray(action.capabilities)
      const notes = asArray(action.notes)
      const buttons = asArray(action.buttons)
      const instruction = typeof action.instruction === 'string' ? action.instruction.trim() : ''
      const wantsInit = buttons.indexOf('init') >= 0 || action.kind === 'init'
      const wantsApprove = action.kind === 'prototype'
      // 决策门：Host 只在「该签还没签」时把 kind 指到这里，按钮成功后面板刷新自然进下一步。
      const decisionSpec = DECISION_GATE_BY_KIND[action.kind] || null
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
        Module,
        { className: 'dc-module-hero', title: '现在要做的下一件事', icon: 'next', tone: heroTone, band: heroBand },
        h('div', { className: 'dc-action-eyebrow' }, stepText),
        h('h3', { className: 'dc-action-title' }, action.title || '暂无建议'),
        h(
          'p',
          { className: 'dc-action-reason' },
          action.reason || '服务端没有返回下一步，可能是插件版本不匹配。',
        ),
        (() => {
          const gateMap = { validateArchitecture: 'architecture', validateTestReport: 'tests', validateRelease: 'release' }
          const gateKey = action.technicalGate ? gateMap[action.technicalGate] : ''
          const gate = gateKey && props.gates ? props.gates[gateKey] : null
          if (!gateKey || !gate) return null
          const gateOk = gate.ok === true
          const gateText = gateOk ? '已通过' : gate.available === true ? '未通过' : '未就绪'
          const missingGate = asArray(gate.missing)
          return h(
            'div',
            { className: 'dc-gate', 'data-gate': gateKey },
            h('span', { className: 'dc-gate-label' }, '阶段检查'),
            h(Chip, { tone: gateOk ? 'success' : 'warn' }, gateText),
            action.method ? h('span', { className: 'dc-gate-method' }, `方法：${action.method}`) : null,
            action.constraint ? h('span', { className: 'dc-gate-method' }, `约束：${action.constraint}`) : null,
            missingGate.length > 0 ? h('span', { className: 'dc-gate-detail' }, `缺：${missingGate.join('、')}`) : null,
            asArray(action.deliverables).length > 0
              ? h('span', { className: 'dc-gate-detail' }, `交付物：${asArray(action.deliverables).join('、')}`)
              : null,
          )
        })(),
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
        caps.length > 0 ? h(CapabilityAdvice, { items: caps }) : null,
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
                  id: 'dc-hero-copy',
                  onClick: copyInstruction,
                  disabled: disabled,
                  title: disabled ? disabledReason : '复制给 AI',
                },
                copyState === 'done' ? '已复制' : copyState === 'fail' ? '复制失败，请手动选择' : '复制给 AI',
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
          decisionSpec
            ? h(DecisionGateButton, {
                // key 用 gate：签完一门后下一步是另一门时强制重挂，避免沿用上一门的「已签核」状态。
                key: decisionSpec.gate,
                projectPath: props.projectPath,
                iterationId,
                gate: decisionSpec.gate,
                label: decisionSpec.label,
                doneText: decisionSpec.doneText,
                approvedText: decisionSpec.approvedText,
                approved: false,
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
      const selected = props.selected === true
      const stateText = state === 'done' ? '已完成' : state === 'current' ? '当前' : '未开始'
      const summary = node.receipt && node.receipt.summary
      const onSelect = typeof props.onSelect === 'function' ? props.onSelect : null
      return h(
        'li',
        {
          className: `dc-stage dc-stage-${highlighted ? 'current' : state === 'current' ? 'pending' : state}${selected ? ' dc-stage-selected' : ''}`,
          'aria-current': highlighted ? 'step' : undefined,
          // 阶段卡片只保留一行；动态摘要放在 title 里，避免一屏四区被进度条挤满。
          title: summary ? `${stateText}：${summary}` : `${(node.name || node.stageId || '')}：${stateText}`,
        },
        h(
          'button',
          {
            type: 'button',
            className: 'dc-stage-tap',
            'aria-pressed': selected,
            'data-stage': node.stageId,
            onClick: () => onSelect && onSelect(node.stageId),
          },
          h(
            'span',
            { className: 'dc-stage-dot', 'aria-hidden': 'true' },
            state === 'done' ? '✓' : '',
          ),
          h('span', { className: 'dc-stage-name' }, node.name || STAGE_TEXT[node.stageId] || node.stageId || '阶段'),
          h('span', { className: 'dc-stage-state' }, stateText),
        ),
      )
    }

    // 阶段详情：只读。点进度节点打开，不改变状态机给的下一步。
    function StageDetail(props) {
      const stage = props.stage || {}
      const gate = stage.gate
      const caps = asArray(stage.capabilities)
      const receipts = asArray(stage.receipts && stage.receipts.items)
      const stateText = stage.state === 'done' ? '已完成' : stage.state === 'current' ? '当前' : '未开始'
      const stateTone = stage.state === 'done' ? 'success' : stage.state === 'current' ? 'brand' : 'idle'
      const row = (label, value) =>
        value ? h('div', { className: 'dc-stage-row' }, h('span', { className: 'dc-stage-row-label' }, label), h('span', { className: 'dc-stage-row-value' }, value)) : null
      const gateText = gate
        ? gate.ok
          ? '已通过'
          : gate.available
            ? '未通过'
            : '未就绪'
        : null
      return h(
        'div',
        {
          className: 'dc-stage-detail',
          role: 'region',
          'aria-label': `${stage.name || '阶段'}详情`,
          onKeyDown: (event) => {
            if (event.key === 'Escape' && typeof props.onClose === 'function') {
              event.stopPropagation()
              props.onClose()
            }
          },
        },
        h(
          'div',
          { className: 'dc-stage-detail-head' },
          h('strong', null, stage.name || '阶段'),
          h(Chip, { tone: stateTone }, stateText),
          h('button', { type: 'button', className: 'dc-btn', onClick: props.onClose }, '回到当前'),
        ),
        row('目标', stage.goal),
        row('方法', stage.method),
        row('约束', stage.constraint),
        asArray(stage.deliverables).length > 0
          ? h(
              'div',
              { className: 'dc-stage-row dc-stage-row-column' },
              h('span', { className: 'dc-stage-row-label' }, '交付物'),
              h('ul', { className: 'dc-stage-list' }, asArray(stage.deliverables).map((item, index) => h('li', { key: `d${index}` }, item))),
            )
          : null,
        gate
          ? row('阶段检查', gate.missing.length > 0 ? `${gateText} · 缺：${gate.missing.join('、')}` : gateText)
          : null,
        stage.decisionGate && stage.decisionGate.title
          ? h(
              'div',
              { className: 'dc-stage-row' },
              h('span', { className: 'dc-stage-row-label' }, '需要你确认'),
              h(
                'span',
                { className: 'dc-stage-row-value' },
                stage.decisionGate.title,
                ' ',
                h(
                  Chip,
                  { tone: stage.decisionGate.approved === true ? 'success' : 'warn' },
                  stage.decisionGate.approved === true ? '已签核' : '未签核',
                ),
                stage.decisionGate.approved === true
                  ? h(
                      'span',
                      {
                        className: 'dc-stage-row-when',
                        title: stage.decisionGate.at ? new Date(stage.decisionGate.at).toLocaleString() : '',
                      },
                      ` · ${stage.decisionGate.at ? formatRelative(stage.decisionGate.at) : '—'}`,
                    )
                  : null,
              ),
            )
          : null,
        caps.length > 0
          ? h(
              'div',
              { className: 'dc-stage-row dc-stage-row-column' },
              h('span', { className: 'dc-stage-row-label' }, '能力'),
              h(
                'div',
                { className: 'dc-stage-caps' },
                caps.map((capability, index) => {
                  const presence = PRESENCE_TEXT[capability.present] || PRESENCE_TEXT.unknown
                  return h(
                    'span',
                    { key: `c${index}`, className: 'dc-cap', title: capability.note || undefined },
                    h('span', { className: 'dc-cap-name' }, capability.name || '未命名能力'),
                    h(Chip, { tone: presence.tone }, presence.text),
                  )
                }),
              ),
              h(CapabilityAdvice, { items: caps }),
            )
          : null,
        h(
          'div',
          { className: 'dc-stage-row dc-stage-row-column' },
          h('span', { className: 'dc-stage-row-label' }, `记录（${stage.receipts ? stage.receipts.count : 0}）`),
          receipts.length > 0
            ? h(
                'ul',
                { className: 'dc-stage-list' },
                receipts.map((receipt, index) =>
                  h(
                    'li',
                    { key: `r${index}` },
                    `${formatRelative(receipt.at)} · ${STATUS_TEXT[receipt.status] || receipt.status || '状态未知'} · ${receipt.summary || '无摘要'}${receipt.usedSkill ? ` · 用了 ${receipt.usedSkill}` : ''}`,
                  ),
                ),
              )
            : h('span', { className: 'dc-stage-empty' }, '这个阶段还没有记录'),
        ),
      )
    }

    function ProgressionSection(props) {
      const progression = props.progression || {}
      const cold = asArray(progression.coldStart)
      const cycle = asArray(progression.cycle)
      const stages = asArray(props.stages)
      const [selectedId, setSelectedId] = React.useState('')
      const iteration = props.iteration || {}
      const action = props.action || {}
      const coldAllDone = cold.length > 0 && cold.every((node) => node && node.state === 'done')

      // 契约保证只有一个 current；万一模型给多了，只强高亮决策指向的那个，避免「两个当前」。
      const firstCurrent = cold.concat(cycle).find((node) => node && node.state === 'current')
      const highlightId = action.stageId || (firstCurrent && firstCurrent.stageId) || ''
      const stageName = action.stageName || STAGE_TEXT[action.stageId] || '下一步'
      const coldPending = cold.filter((node) => node && node.state !== 'done')
      const cycleAllDone = cycle.length > 0 && cycle.every((node) => node && node.state === 'done')
      const progressTone = coldAllDone && cycleAllDone ? 'success' : 'brand'
      const summaryText = coldAllDone
        ? `冷启动已完成，现在在「${stageName}」`
        : `先完成冷启动：${coldPending.map((node) => node.name || STAGE_TEXT[node.stageId]).join('、') || '初始化'}`
      const selected = selectedId !== '' ? stages.find((stage) => stage && stage.id === selectedId) : null
      const onSelect = (stageId) => setSelectedId((current) => (current === stageId ? '' : stageId))

      return h(
        Module,
        { title: '项目进度', icon: 'progress', tone: progressTone },
        h('p', { className: 'dc-progress-summary' }, summaryText),
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
              h('div', { className: 'dc-track-label' }, '冷启动'),
              h(
                'ol',
                { className: 'dc-track' },
                cold.map((node, index) =>
                  h(StageNode, {
                    key: `cold${index}`,
                    node,
                    highlight: node && node.stageId === highlightId,
                    selected: node && node.stageId === selectedId,
                    onSelect,
                  }),
                ),
              ),
            ),
        h('div', { className: 'dc-track-label' }, '现在这一轮'),
        h(
          'ol',
          { className: 'dc-track' },
          cycle.map((node, index) =>
            h(StageNode, {
              key: `cycle${index}`,
              node,
              highlight: node && node.stageId === highlightId,
              selected: node && node.stageId === selectedId,
              onSelect,
            }),
          ),
        ),
        selected ? h(StageDetail, { stage: selected, onClose: () => setSelectedId('') }) : null,
      )
    }

    // ---------- ③½ 交付指标（P3）：代理口径 ----------
    //
    // 指标由 Host 的 lib/metrics.js 算好下发（detail.metrics）。客户端只负责显示：
    // - 数据不足（value=null）显示「—」并把口径/缺口原因放进 title，不显示 0；
    // - 0 是合法值（近 7 天确实没发布），照常显示 0；
    // 面板里不出现技术账本/引擎词汇，口径短句直接来自 Host。
    // 指标名走人话词表：契约里的库存指标在面板统一叫「待修问题」。
    const METRIC_LABELS = {
      leadTimeHours: '交付周期',
      deploymentFrequency7d: '近 7 天发布',
      changeFailureRate: '返工率',
      reviewFixHours: '修复时长',
      acceptanceRate: '验收通过率',
      blockingInventory: '待修问题',
      mttrHours: '线上恢复时长',
    }

    // 小时类指标超过 2 天改用「天」显示，避免「168 小时」这种要心算的数字。
    function formatMetricValue(metric, key) {
      const value = metric && typeof metric.value === 'number' && Number.isFinite(metric.value) ? metric.value : null
      if (value === null) return null
      if (key === 'leadTimeHours' || key === 'reviewFixHours' || key === 'mttrHours') {
        return value >= 48 ? `${Number((value / 24).toFixed(1))} 天` : `${Number(value.toFixed(1))} 小时`
      }
      if (key === 'deploymentFrequency7d') return `${value} 次`
      if (key === 'blockingInventory') return `${value} 项`
      // 比率保留整数百分比：面板上「33%」比「32.6%」更好读。
      return `${Math.round(value * 100)}%`
    }

    function metricTitle(metric, key, unavailableMap) {
      const parts = []
      if (metric && metric.definition) parts.push(metric.definition)
      const value = metric && typeof metric.value === 'number' ? metric.value : null
      if (unavailableMap[key]) parts.push(unavailableMap[key])
      if (metric && Number.isInteger(metric.sample)) parts.push(`样本 ${metric.sample}`)
      return parts.length > 0 ? parts.join(' · ') : '数据不足'
    }

    function MetricsSection(props) {
      const metrics = props.metrics || null
      const values = (metrics && metrics.metrics) || {}
      const unavailable = asArray(metrics && metrics.unavailable)
      const unavailableMap = {}
      for (const item of unavailable) {
        if (item && typeof item.metric === 'string') unavailableMap[item.metric] = item.reason || '数据不足'
      }
      const cards = ['leadTimeHours', 'deploymentFrequency7d', 'changeFailureRate', 'acceptanceRate']
      const minis = ['reviewFixHours', 'mttrHours', 'blockingInventory']

      const valueNode = (key, className) => {
        const metric = values[key] || null
        const text = formatMetricValue(metric, key)
        const valueClass = text === null ? `${className} dc-metric-value-null` : className
        return h('span', { className: valueClass, title: metricTitle(metric, key, unavailableMap) }, text === null ? '—' : text)
      }

      const note = metrics
        ? unavailable.length > 0
          ? `有 ${unavailable.length} 项数据还不够，先用 — 占位。`
          : metrics && metrics.source === 'live'
            ? '发布频率 / 变更失败率 / 交付周期 / MTTR 来自 .dsh/plugin-state/dora.json 的线上记录（交付周期需部署记录带 leadTimeHours）；其余仍是本地代理。'
            : '指标为代理口径：来自项目本地记录，不是线上监控（发布看近 7 天、返工率看近 30 天，其余看全部历史）。'
        : '还没有算出交付指标，随项目动态与检查记录补齐后出现。'

      return h(
        Module,
        {
          title: '交付指标',
          icon: 'progress',
          tone: metrics ? 'brand' : 'idle',
          // 不写「近 N 天」：六项里只有发布/返工率是窗口口径，其余看全部历史，
          // 一个窗口前缀会把整组指标说成同一口径（误导）。窗口细节放在每项 tooltip 与脚注里。
          meta: metrics ? (metrics.source === 'live' ? '线上数据' : '代理口径') : '数据不足',
        },
        h(
          'div',
          { className: 'dc-metric-grid' },
          cards.map((key, index) =>
            h(
              'div',
              { key: `metric${index}`, className: 'dc-metric' },
              h('span', { className: 'dc-metric-label' }, METRIC_LABELS[key]),
              valueNode(key, 'dc-metric-value'),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dc-metric-mini-row' },
          minis.map((key, index) =>
            h(
              'span',
              { key: `metricMini${index}`, className: 'dc-metric-mini' },
              h('span', null, METRIC_LABELS[key]),
              valueNode(key, 'dc-metric-mini-value'),
            ),
          ),
        ),
        h('p', { className: 'dc-metric-note' }, note),
      )
    }

    // ---------- 详情 · ④ 功能 & 待修问题账 ----------
    //
    // 功能状态由 Host 用三路证据（验收 / 归属 bug / 动态）推导后下发，这里只如实呈现：
    // 不根据标题猜、不把「读不到」显示成 0。待修问题账分「功能内」与「未归属」两处。

    function FeatureStatusPill(props) {
      return h(Chip, { tone: props.tone || 'unknown' }, props.text)
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
            issue && issue.file && props.showFile === true
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

    // 状态人话由 Host 的 status 决定（与 statusLabel 同源）；未知状态才直接显示 Host 的 label，不自己推断。
    function featureStatusLabel(item) {
      const bugs = (item && item.bugs) || {}
      const known = bugs.known !== false
      const blocking = Number(bugs.blocking) || 0
      // 卡点数只在 Host 明确（known）时给，读不到就说「卡住了」，不编数字。
      if (item && item.status === 'blocked' && known && blocking > 0) return `有 ${blocking} 个卡点`
      const mapped = FEATURE_STATUS_TEXT[(item && item.status) || 'unknown']
      if (mapped && mapped !== '—') return mapped
      const hostLabel = item && typeof item.statusLabel === 'string' ? item.statusLabel.trim() : ''
      return hostLabel !== '' ? hostLabel : '—'
    }

    function featureAcceptanceText(item) {
      const acceptance = (item && item.acceptance) || {}
      const total = Number(acceptance.total) || 0
      const passed = Number(acceptance.passed) || 0
      return total > 0 ? `验收通过 ${passed}/${total}` : '还没验收'
    }

    function FeatureRow(props) {
      const item = props.item || {}
      const bugs = item.bugs || {}
      const known = bugs.known !== false
      const issues = asArray(bugs.issues)
      const paths = asArray(item.paths)
      const receipts = Number(item.receipts) || 0
      const inferred = Number(item.inferredReceipts) || 0
      const anchors = item.anchors && typeof item.anchors === 'object' ? item.anchors : {}
      const acceptance = item.acceptance || {}
      const when = item.lastAt ? formatRelative(item.lastAt) : ''
      const summary = String(item.lastSummary || '').trim()
      const recent = [when, summary].filter(Boolean).join(' · ') || '暂时没有动态'
      const relatedAcceptance = asArray(props.acceptanceItems).filter(
        (entry) => entry && entry.featureRef === item.id,
      )
      const expandable =
        issues.length > 0 || paths.length > 0 || receipts > 0 || inferred > 0 || relatedAcceptance.length > 0
      const expanded = props.expanded === true
      const accepted = Number(acceptance.total) || 0
      const passed = Number(acceptance.passed) || 0
      const failed = Number(acceptance.failed) || 0
      const blocked = Number(acceptance.blocked) || 0
      const acceptanceDetail =
        accepted > 0
          ? `验收通过 ${passed}/${accepted}${failed > 0 ? ` · 没通过 ${failed}` : ''}${blocked > 0 ? ` · 卡住 ${blocked}` : ''}`
          : '还没验收'
      const anchorText = [
        Number(anchors.receipts) > 0 ? `由 ${Number(anchors.receipts)} 条动态自动归入` : null,
        Number(anchors.tasks) > 0 ? `按任务标题归入 ${Number(anchors.tasks)} 次` : null,
      ]
        .filter(Boolean)
        .join(' · ')

      return h(
        'li',
        { className: 'dc-feature-item' },
        h(
          expandable ? 'button' : 'div',
          expandable
            ? {
                type: 'button',
                className: 'dc-feature-row',
                'aria-expanded': expanded ? 'true' : 'false',
                'aria-keyshortcuts': 'j k Enter Escape',
                'data-kb-row': 'true',
                onClick: props.onToggle,
              }
            : {
                className: 'dc-feature-row',
                tabIndex: 0,
                'aria-keyshortcuts': 'j k',
                'data-kb-row': 'true',
              },
          h(
            'span',
            { className: 'dc-feature-main' },
            h('span', { className: 'dc-feature-name' }, item.title || '（没有标题）'),
            h('span', { className: 'dc-feature-recent' }, recent),
          ),
          h(
            'span',
            { className: 'dc-feature-side' },
            h(FeatureStatusPill, {
              tone: FEATURE_STATUS_TONE[(item && item.status) || 'unknown'] || 'unknown',
              text: featureStatusLabel(item),
            }),
            h('span', { className: 'dc-feature-acceptance' }, featureAcceptanceText(item)),
            accepted > 0
              ? h(
                  'span',
                  { className: 'dc-feature-progress', 'aria-hidden': 'true' },
                  h('span', {
                    className: `dc-feature-progress-fill${passed === accepted ? ' dc-feature-progress-full' : ''}`,
                    style: { width: `${Math.round((passed / accepted) * 100)}%` },
                  }),
                )
              : null,
            expandable ? h('span', { className: 'dc-feature-toggle', 'aria-hidden': 'true' }, expanded ? '收起' : '细节') : null,
          ),
        ),
        expanded && expandable
          ? h(
              'div',
              { className: 'dc-feature-detail' },
              h(
                'div',
                { className: 'dc-detail-line' },
                h('span', { className: 'dc-detail-label' }, '编号'),
                h('code', { className: 'dc-code' }, item.id || '—'),
              ),
              item.priority
                ? h(
                    'div',
                    { className: 'dc-detail-line' },
                    h('span', { className: 'dc-detail-label' }, '优先级'),
                    h(
                      'span',
                      { className: `dc-pri dc-pri-${String(item.priority).toLowerCase()}` },
                      String(item.priority),
                    ),
                  )
                : null,
              paths.length > 0
                ? h(
                    'div',
                    { className: 'dc-detail-line' },
                    h('span', { className: 'dc-detail-label' }, '相关文件'),
                    h('code', { className: 'dc-code' }, paths.join('、')),
                  )
                : null,
              h(
                'div',
                { className: 'dc-detail-block' },
                h('div', { className: 'dc-detail-label' }, '待修问题'),
                issues.length > 0
                  ? h(BugList, { issues, showFile: true })
                  : h('span', { className: 'dc-detail-hint' }, known ? '没有问题需要修。' : '还看不出有没有问题。'),
              ),
              h(
                'div',
                { className: 'dc-detail-line' },
                h('span', { className: 'dc-detail-label' }, '验收'),
                h('span', { className: 'dc-detail-hint' }, acceptanceDetail),
              ),
              receipts > 0 || inferred > 0
                ? h(
                    'div',
                    { className: 'dc-detail-line' },
                    h('span', { className: 'dc-detail-label' }, '动态'),
                    h(
                      'span',
                      { className: 'dc-detail-hint' },
                      `${receipts} 条${inferred > 0 ? `（其中 ${inferred} 条是自动归入的）` : ''}${anchorText ? ` · ${anchorText}` : ''}`,
                    ),
                  )
                : null,
              h(
                'div',
                { className: 'dc-detail-block' },
                h('div', { className: 'dc-detail-label' }, '这个功能的验收'),
                relatedAcceptance.length > 0
                  ? h(
                      'ul',
                      { className: 'dc-related-list' },
                      relatedAcceptance.map((entry) =>
                        h(
                          'li',
                          { key: entry.id, className: 'dc-related-item' },
                          h('span', { className: 'dc-related-title' }, entry.title || '（没有标题）'),
                          h(AcceptanceResultChip, { result: entry.result }),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dc-btn dc-btn-sm',
                              onClick: () => props.onJumpToAcceptance && props.onJumpToAcceptance(entry.id),
                            },
                            '去验收',
                          ),
                        ),
                      ),
                    )
                  : h('span', { className: 'dc-detail-hint' }, '这个功能还没有验收条目。'),
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
        ACCEPTANCE_RESULT_TEXT[result] || '还没验',
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

    // 视觉回归徽章：changed 可点开 变化图；其余只读（reason 放 title 里悬停看）。
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
            title: `${diffTitle(diff)}\n点击看变化图`,
            'aria-label': `看变化图：${text}`,
            onClick: () => openEvidenceShot(diff.diffFile, props.projectPath),
          },
          h(Chip, { tone }, text),
          h('span', { className: 'dc-diff-link' }, '看变化'),
        )
      }
      return h(Chip, { tone, title: diffTitle(diff) || undefined }, text)
    }

    // 验收清单：面板内可直接记录结果（通过/失败/卡点/撤销）。
    // 写动作只发「项目路径 + 验收项 + 结果 + 证据路径」，文件校验与迭代归属由 Host 负责；
    // 成功后重新拉面板，让 Host 返回的 result/at/evidence 成为唯一事实源。
    function AcceptancePanel(props) {
      const acceptance = props.acceptance || {}
      const items = asArray(acceptance.items)
      const truncated = acceptance.truncated === true
      // 通过数用 Host 的全局真值：items 最多 100 条，截断时本地 filter 只覆盖可见项。
      const passedRaw = Number(acceptance.passed)
      const passedCount = Number.isFinite(passedRaw)
        ? passedRaw
        : items.filter((item) => item && item.result === 'pass').length
      const staleRaw = Number(acceptance.stale)
      const staleCount = Number.isFinite(staleRaw)
        ? staleRaw
        : items.filter((item) => item && item.stale === true).length
      const failedRaw = Number(acceptance.failed)
      const failedCount = Number.isFinite(failedRaw) ? failedRaw : items.filter((item) => item && item.result === 'fail').length
      const blockedCount =
        Number(acceptance.blocked) || items.filter((item) => item && item.result === 'blocked').length
      const totalCount = Number(acceptance.total) || items.length
      const acceptanceTone =
        failedCount > 0
          ? 'error'
          : staleCount > 0 || blockedCount > 0
            ? 'warn'
            : totalCount > 0 && passedCount === totalCount
              ? 'success'
              : totalCount === 0
                ? 'idle'
                : 'brand'
      // 默认只展开需要动作的条目；干净的通过项收进折叠行。
      const actionable = items.filter((item) => item && (item.result !== 'pass' || item.stale === true))
      const cleanPassed = items.filter((item) => item && item.result === 'pass' && item.stale !== true)
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
      const parseEvidence = (text) =>
        String(text == null ? '' : text)
          .split(/[\n,，;；]+/)
          .map((part) => part.trim())
          .filter(Boolean)
      const shotUrlFor = (id) =>
        Object.prototype.hasOwnProperty.call(shotUrls, id)
          ? shotUrls[id]
          : String(props.previewUrl || '')
      const setShotUrl = (id, value) => setShotUrls((previous) => ({ ...previous, [id]: value }))

      const capture = async (item) => {
        const id = item.id
        if (!id) return
        const url = String(shotUrlFor(id) || '').trim()
        setRow(id, { capturing: true, shotError: '', shotSaved: false })
        try {
          const payload = { path: props.projectPath, item_id: id }
          if (url) payload.url = url
          const SHOT_REQUEST_TIMEOUT_MS = 90000
          const body = await postJson(`${API}/acceptance-screenshot`, payload, SHOT_REQUEST_TIMEOUT_MS)
          if (!body || body.ok !== true) throw new Error('shot-failed')
          if (!mounted.current) return
          const comparison = body.shot && body.shot.comparison ? body.shot.comparison : null
          const invalidated = Boolean(body.shot && body.shot.invalidated === true)
          const receiptId = (body.shot && body.shot.receiptId) || null
          // 留痕写失败要如实说：不能让用户以为"已截图"就完事、细节可追溯。
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
              ? `已截图并附到证据 · 截图有变化，需要你重新确认${receiptWarning && !receiptId ? '（留痕写入失败）' : ''}`
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
        if (result === 'pass' && evidence.length === 0) {
          setRow(id, { saving: false, saved: false, error: '通过必须附证据。' })
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
          setRow(id, {
            saving: false,
            saved: false,
            error: explainAcceptanceError(messageOf(failure)),
          })
        }
      }

      const resultLabel = (item) => {
        if (item.stale === true && item.result === 'pass') return { text: '需要重新确认', tone: 'warn' }
        if (item.result === 'pass') return { text: '通过', tone: 'ok' }
        if (item.result === 'fail') return { text: '没通过', tone: 'bad' }
        if (item.result === 'blocked') return { text: '卡住了', tone: 'warn' }
        return { text: '还没验', tone: 'unknown' }
      }

      const renderDetails = (item) => {
        const id = item.id
        const state = rowState[id] || {}
        const evidence = asArray(item.evidence)
        const shotDiffs = asArray(item.shotDiffs)
        const latestDiff = shotDiffs.length > 0 ? shotDiffs[shotDiffs.length - 1] : null
        const diffOpen = state.diffOpen === true
        const editingRow = editing[id] === true
        return h(
          'details',
          { className: 'dc-more dc-acc-more' },
          h('summary', null, '细节'),
          h(
            'div',
            { className: 'dc-more-body' },
            item.stale === true && item.result === 'pass'
              ? h(
                  'div',
                  { className: 'dc-stale-note', role: 'status' },
                  '之前那次通过需要重新确认',
                  item.staleAt ? `（${formatRelative(item.staleAt)}）` : '',
                  item.staleReceiptId || item.receiptId
                    ? h(
                        'span',
                        { className: 'dc-hint' },
                        ` · 这条变化已记录在项目动态里 ${item.staleReceiptId || item.receiptId}`,
                      )
                    : null,
                )
              : null,
            h(
              'div',
              { className: 'dc-detail-line' },
              h('span', { className: 'dc-detail-label' }, '功能'),
              h('span', { className: 'dc-detail-hint' }, item.featureRef || '还没归到功能'),
            ),
            editingRow
              ? h(
                  React.Fragment,
                  null,
                  h('input', {
                    className: 'dc-evidence-input',
                    value: draftFor(item),
                    placeholder: '截图路径或网址，如 shots/a1.png',
                    autoFocus: true,
                    'aria-label': `验收项 ${item.title || id} 的证据`,
                    onChange: (event) => setDraft(id, event.target.value),
                  }),
                  h('div', { className: 'dc-hint' }, '多张用逗号或换行分开。'),
                )
              : h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { className: 'dc-evidence-summary', title: evidence.join('\n') || '' },
                    evidence.length === 0
                      ? '还没有证据'
                      : evidence.some((value) => isImageEvidence(value))
                        ? `${evidence.length} 个证据 · ${evidenceLabel(evidence[0])}`
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
                    '编辑证据',
                  ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dc-btn dc-btn-sm',
                  'aria-expanded': state.shotOpen === true ? 'true' : 'false',
                  onClick: () => setRow(id, { shotOpen: state.shotOpen !== true }),
                },
                state.shotOpen === true ? '收起截图' : '补一张截图',
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
                    'aria-label': `验收项 ${item.title || id} 的预览地址`,
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
                  h('div', { className: 'dc-hint' }, '只允许截本机地址；截图只当证据，不会自动判定通过。'),
                  state.shotError ? h('div', { className: 'dc-acc-error', role: 'alert' }, state.shotError) : null,
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
                                  onClick: () => openEvidenceShot(state.shotDiffFile, props.projectPath),
                                },
                                '看变化',
                              ),
                            )
                          : null,
                        state.shotReceiptId
                          ? h(
                              'span',
                              { className: 'dc-hint' },
                              ` · 已记录在项目动态里 ${state.shotReceiptId}`,
                            )
                          : state.shotReceiptWarning
                            ? h(
                                'span',
                                { className: 'dc-acc-error' },
                                ` · 留痕写入失败：${state.shotReceiptWarning}`,
                              )
                            : null,
                      )
                    : null,
                )
              : null,
            shotDiffs.length > 0
              ? h(
                  'div',
                  { className: 'dc-diff-block' },
                  h(
                    'div',
                    { className: 'dc-detail-line' },
                    h('span', { className: 'dc-detail-label' }, '和上一版比'),
                    h(ShotDiffBadge, { diff: latestDiff, projectPath: props.projectPath }),
                    latestDiff && latestDiff.verdict === 'changed' && latestDiff.diffFile
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'dc-thumb dc-diff-thumb',
                            title: '看变化图',
                            'aria-label': '看变化图',
                            onClick: () => openEvidenceShot(latestDiff.diffFile, props.projectPath),
                          },
                          h('img', {
                            src: evidenceSrc(latestDiff.diffFile, props.projectPath),
                            alt: '',
                            loading: 'lazy',
                          }),
                        )
                      : null,
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dc-btn dc-btn-sm',
                      'aria-expanded': diffOpen ? 'true' : 'false',
                      onClick: () => setRow(id, { diffOpen: !diffOpen }),
                    },
                    diffOpen ? '收起历史' : '看历史记录',
                  ),
                  diffOpen
                    ? h(
                        React.Fragment,
                        null,
                        h('div', { className: 'dc-hint' }, '最近 5 次版本变化（最新在前）'),
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
                                diff.verdict === 'changed' && diff.diffFile
                                  ? h(
                                      'button',
                                      {
                                        type: 'button',
                                        className: 'dc-diff-link',
                                        onClick: () => openEvidenceShot(diff.diffFile, props.projectPath),
                                      },
                                      '看变化',
                                    )
                                  : null,
                              ),
                            ),
                        ),
                      )
                    : null,
                )
              : null,
          ),
        )
      }

      const renderRow = (item) => {
        const id = item.id
        const state = rowState[id] || {}
        const result = resultLabel(item)
        return h(
          'li',
          {
            key: id,
            className: 'dc-acc-item',
            'data-acc-id': id,
            'data-acceptance-id': id,
            'data-kb-row': 'true',
            'aria-keyshortcuts': 'j k Enter Escape',
            tabIndex: -1,
          },
          h(
            'div',
            { className: 'dc-acc-row' },
            h(
              'span',
              { className: 'dc-acc-main' },
              h('span', { className: 'dc-acc-title' }, item.title || '（没有标题）'),
              h(
                'span',
                { className: 'dc-acc-sub' },
                h(Chip, { tone: result.tone }, result.text),
                item.stale === true && item.result === 'pass'
                  ? h('span', { className: 'dc-acc-warn' }, '截图有变化，需要你重新确认')
                  : null,
              ),
            ),
            h(
              'span',
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
                '没通过',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dc-btn dc-btn-sm',
                  disabled: state.saving === true,
                  onClick: () => submit(item, 'blocked'),
                },
                '卡住了',
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
          ),
          state.saving ? h('div', { className: 'dc-hint' }, '保存中…') : null,
          state.error ? h('div', { className: 'dc-acc-error', role: 'alert' }, state.error) : null,
          state.saved ? h('div', { className: 'dc-acc-saved', role: 'status' }, '已保存') : null,
          renderDetails(item),
        )
      }

      let content = null
      if (items.length === 0) {
        const drafting = props.actionKind === 'acceptance-draft'
        content = h(EmptyState, {
          icon: 'acceptance',
          title: '还没有验收条目',
          reason: drafting
            ? '下一步就是按 PRD 起草第一版，生成后回来逐条看结果。'
            : '「验收确认」阶段会按 PRD 起草。',
          actionLabel: drafting ? '复制起草指令' : null,
        })
      } else {
        content = h(
          React.Fragment,
          null,
          acceptance.badJson ? h('p', { className: 'dc-hint dc-hint-bad' }, '验收清单读不出来，先修好文件再记录结果。') : null,
          truncated ? h('p', { className: 'dc-hint' }, '条目太多，只显示前 100 条。') : null,
          actionable.length > 0
            ? h('ul', { className: 'dc-acc-list' }, actionable.map(renderRow))
            : h('p', { className: 'dc-empty-line' }, '没有需要处理的验收项。'),
          cleanPassed.length > 0
            ? h(
                'details',
                { className: 'dc-passed-fold' },
                h('summary', null, `已经通过 ${passedCount} 条（展开）`),
                h('ul', { className: 'dc-acc-list' }, cleanPassed.map(renderRow)),
              )
            : null,
        )
      }

      const meta =
        actionable.length > 0
          ? `需要处理 ${actionable.length} 条${staleCount > 0 ? ` · ${staleCount} 条需要重新确认` : ''}`
          : '全部处理完了'
      return h(Module, { title: '验收', icon: 'acceptance', tone: acceptanceTone, meta }, content)
    }

    function FeatureBoardSection(props) {
      const features = props.features || {}
      const items = asArray(features.items)
      const acceptanceItems = asArray((props.acceptance || {}).items)
      const progress = features.progress || {}
      const featureTotal = Number(progress.total) || items.length
      const featureDone = Number(progress.done) || 0
      let featureBlocking = 0
      for (const item of items) {
        const bugs = (item && item.bugs) || {}
        if (bugs.known !== false) featureBlocking += Number(bugs.blocking) || 0
      }
      const unattributed = features.unattributed || {}
      if (unattributed.known !== false) featureBlocking += Number(unattributed.blocking) || 0
      const featuresTone =
        featureBlocking > 0 ? 'warn' : featureTotal > 0 && featureDone === featureTotal ? 'success' : 'brand'
      const source = features.source || 'prd'
      const strategy = features.strategy || 'none'
      const formatHint = String(features.formatHint || '')
      const [expanded, setExpanded] = React.useState({})
      const toggle = (id) => setExpanded((previous) => ({ ...previous, [id]: !previous[id] }))
      // 技术格式只放「细节」里：默认行只给人看的标题与状态。
      const technical = (extra) =>
        h(
          'details',
          { className: 'dc-more' },
          h('summary', null, '细节'),
          h(
            'div',
            { className: 'dc-more-body' },
            extra,
            formatHint ? h('pre', { className: 'dc-code-block' }, formatHint) : null,
            source !== 'prd-missing'
              ? h('p', { className: 'dc-hint' }, '面板只认「## 功能需求」下的「### FR-N 标题」写法。')
              : null,
          ),
        )

      let board = null
      if (source === 'prd-missing') {
        board = h(
          EmptyState,
          {
            icon: 'feature',
            title: '还没有 PRD，所以列不出功能',
            reason: '「需求定义」阶段会产出它，先看上面的下一步。',
            actionLabel: '复制下一步指令',
          },
          technical(h('p', { className: 'dc-hint' }, '以后把文件放到项目根目录的 prd.md 或 docs/prd.md 就行。')),
        )
      } else if (strategy === 'none') {
        board = h(
          EmptyState,
          {
            icon: 'feature',
            title: 'PRD 里没有「### FR-N」结构',
            reason: '面板不解析自由文本，只认这种写法。',
            actionLabel: '复制下一步指令',
          },
          technical(null),
        )
      } else if (items.length === 0) {
        board = h(EmptyState, {
          icon: 'feature',
          title: 'PRD 里还没有功能条目',
          reason: '功能需求那一节还是空的，补上后刷新即可。',
        }, technical(null))
      } else {
        board = h(
          'ul',
          { className: 'dc-feature-list' },
          items.map((item, index) => {
            const key = (item && item.id) || `feature${index}`
            return h(FeatureRow, {
              key,
              item,
              acceptanceItems,
              onJumpToAcceptance: props.onJumpToAcceptance,
              expanded: expanded[key] === true,
              onToggle: () => toggle(key),
            })
          }),
        )
      }

      return h(Module, { title: '功能', icon: 'feature', tone: featuresTone }, board)
    }

    function DefectsSection(props) {
      const features = props.features || {}
      const unattributed = features.unattributed || {}
      const blocking = Number(unattributed.blocking) || 0
      if (blocking <= 0) return null
      return h(
        Module,
        { title: '没归到功能的待修问题', icon: 'defects', tone: 'error', meta: `${blocking} 条` },
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
      // 卡点与功能表同源：归属到功能的未处置卡点 + 没归到功能的待修问题。
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
      const acceptanceItems = asArray(acceptance.items)
      const failedCount =
        Number(acceptance.failed) || acceptanceItems.filter((item) => item && item.result === 'fail').length
      const blockedCount =
        Number(acceptance.blocked) || acceptanceItems.filter((item) => item && item.result === 'blocked').length
      const stats = [
        {
          key: 'features',
          label: '已完成功能',
          value: featureTotal > 0 ? `${featureDone}/${featureTotal}` : '—',
          tone: featureTotal > 0 ? (featureDone === featureTotal ? 'success' : 'brand') : null,
        },
        {
          key: 'acceptance',
          label: '验收通过',
          value: acceptanceTotal > 0 ? `${acceptancePassed}/${acceptanceTotal}` : '—',
          tone:
            acceptanceTotal > 0
              ? failedCount > 0
                ? 'error'
                : stale > 0 || blockedCount > 0
                  ? 'warn'
                  : acceptancePassed === acceptanceTotal
                    ? 'success'
                    : 'brand'
              : null,
        },
        {
          key: 'blocking',
          label: '待修问题',
          value: String(blocking),
          tone: blocking > 0 ? 'error' : null,
          title: '还没修掉的待修问题，含没归到功能的',
        },
        { key: 'stale', label: '需要重新确认', value: String(stale), tone: stale > 0 ? 'warn' : null },
        { key: 'decision', label: '需要你决定', value: hasDecision ? '1' : '—', tone: hasDecision ? 'warn' : null },
      ]
      return h(
        Module,
        { className: 'dc-summary-module' },
        h(
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
        ),
      )
    }

    // ---------- 右栏：需要你决定 / 代码检查 / 项目动态 / 数据说明 ----------

    // 「最严重」一条：优先代码检查 issues，缺明细时从功能/未归属的 bug 里挑。
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

    const REVIEW_AGENT_LABELS = { claude: 'Claude Code', agy: 'Gemini（Antigravity）' }

    function ReviewSettings(props) {
      const settings = props.settings || {}
      const projectPath = typeof props.projectPath === 'string' ? props.projectPath.trim() : ''
      const [agent, setAgent] = React.useState(settings.agent === 'agy' ? 'agy' : 'claude')
      const [model, setModel] = React.useState(settings.model || '')
      const [proxy, setProxy] = React.useState(settings.agyProxy || '')
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')

      React.useEffect(() => {
        setAgent(settings.agent === 'agy' ? 'agy' : 'claude')
        setModel(settings.model || '')
        setProxy(settings.agyProxy || '')
      }, [settings.agent, settings.model, settings.agyProxy])

      const save = async () => {
        if (busy || projectPath === '') return
        setBusy(true)
        setMessage('')
        try {
          await postJson(`${API}/review-settings`, {
            path: projectPath,
            agent,
            model: model.trim(),
            agyProxy: proxy.trim(),
          })
          setMessage('已保存')
          if (props.onRefresh) props.onRefresh()
        } catch (error) {
          const raw = String(error && error.message ? error.message : error)
          setMessage(explainError(raw))
        } finally {
          setBusy(false)
        }
      }

      const modelText = model.trim() ? model.trim() : '默认模型'
      const summary = `评审：${REVIEW_AGENT_LABELS[agent] || agent} · ${modelText}`
      const header = props.variant === 'header'
      return h(
        'details',
        { className: `dc-review-settings${header ? ' dc-review-settings-header' : ''}` },
        h(
          'summary',
          {
            className: 'dc-review-settings-summary',
            title: header ? '切换 Claude Code / Gemini 评审器，并设置模型与 agy 代理' : '切换评审器并设置模型',
          },
          header ? summary : `评审器：${REVIEW_AGENT_LABELS[agent] || agent} · ${modelText}`,
        ),
        h(
          'div',
          { className: 'dc-review-settings-body' },
          projectPath === ''
            ? h('p', { className: 'dc-review-settings-hint', role: 'status' }, '这个视图拿不到项目路径，刷新面板后再改评审器。')
            : null,
          h(
            'label',
            null,
            '评审引擎',
            h(
              'select',
              {
                value: agent,
                onChange: (event) => {
                  setAgent(event.target.value)
                  setMessage('')
                },
              },
              h('option', { value: 'claude' }, 'Claude Code'),
              h('option', { value: 'agy' }, 'Gemini（Antigravity）'),
            ),
          ),
          h(
            'label',
            null,
            '模型',
            h('input', {
              type: 'text',
              value: model,
              placeholder: agent === 'agy' ? '留空用 agy 默认；如 gemini-4-hydrogen-high' : '留空用 Claude 默认模型',
              onChange: (event) => setModel(event.target.value),
            }),
          ),
          agent === 'agy'
            ? h(
                'label',
                null,
                'agy 代理',
                h('input', {
                  type: 'text',
                  value: proxy,
                  placeholder: '留空不注入；例如 http://127.0.0.1:10808',
                  onChange: (event) => setProxy(event.target.value),
                }),
              )
            : null,
          h(
            'div',
            { className: 'dc-review-settings-actions' },
            h(
              'button',
              { type: 'button', className: 'dc-btn', onClick: save, disabled: busy || projectPath === '' },
              busy ? '保存中…' : '保存',
            ),
            message ? h('span', { className: 'dc-inline-msg', role: 'status' }, message) : null,
          ),
          agent === 'agy'
            ? h('p', { className: 'dc-review-settings-hint' }, '需要本机安装 agy 并已登录；代理只注入 agy 子进程。')
            : null,
        ),
      )
    }

    function ReviewRail(props) {
      const review = props.review || {}
      const features = props.features || {}
      if (review.available === false) {
        return h(
          Module,
          { title: '代码检查', icon: 'review', tone: 'idle' },
          h(
            'p',
            { className: 'dc-rail-note' },
            review.reason === 'no-ledger' ? '还没有接过代码检查。' : '代码检查暂时没读到。',
          ),
        )
      }
      const blocking = Number(review.blocking) || 0
      const rounds = Number(review.rounds) || 0
      const severe = mostSevereIssue(review, features)
      const gateText = blocking > 0 ? '有要修的' : rounds > 0 ? '最近检查通过' : '还没检查'
      return h(
        Module,
        { title: '代码检查', icon: 'review', tone: blocking > 0 ? 'warn' : rounds > 0 ? 'success' : 'idle', level: 3, meta: gateText, metaTone: blocking > 0 ? 'warn' : rounds > 0 ? 'ok' : 'unknown' },
        blocking > 0
          ? h(
              React.Fragment,
              null,
              h('p', { className: 'dc-rail-note' }, `有 ${blocking} 个待修问题`),
              severe
                ? h(
                    'div',
                    {
                      className: 'dc-rail-severe-text',
                      title: `[${SEVERITY_TEXT[severe.severity] || '问题'}] ${severe.title || ''}` +
                        (severe.file ? ` · ${severe.file}${severe.line ? `:${severe.line}` : ''}` : ''),
                    },
                    h(
                      'span',
                      { className: `dc-bug-sev dc-bug-sev-${severe.severity || 'minor'}` },
                      SEVERITY_TEXT[severe.severity] || '问题',
                    ),
                    ` ${severe.title || '（没有标题）'}`,
                  )
                : h('span', { className: 'dc-rail-note' }, '明细还没读到。'),
            )
          : h(
              'p',
              { className: 'dc-rail-note' },
              rounds > 0 ? `最近 ${rounds} 轮检查通过 · 没问题` : '还没做代码检查。',
            ),
      )
    }

    function ReceiptsTimeline(props) {
      const ledger = props.ledger || {}
      const receipts = asArray(ledger.receipts)
      const lastAt = ledger.lastAt || (receipts[0] && receipts[0].at) || null
      return h(
        Module,
        { title: '项目动态', icon: 'receipts', tone: receipts.length > 0 ? 'brand' : 'idle', meta: lastAt ? `上次 ${formatRelative(lastAt)}` : '还没有动态' },
        receipts.length === 0
          ? h(EmptyState, {
              inline: true,
              icon: 'receipts',
              title: '项目还没有动态',
              reason: 'AI 每完成一步会记一条，你不需要手写。',
            })
          : h(
              'div',
              { className: 'dc-timeline-scroll' },
              ['今天', '本周', '更早'].map((label) => {
                const group = receipts.filter((receipt) => timelineGroupOf(receipt && receipt.at) === label)
                if (group.length === 0) return null
                return h(
                  'section',
                  {
                    key: label,
                    className: 'dc-timeline-group',
                    role: 'group',
                    'aria-label': label,
                  },
                  h('div', { className: 'dc-timeline-group-title' }, label),
                  h(
                    'ol',
                    { className: 'dc-receipts-timeline' },
                    group.map((receipt, index) => {
                      const event = receipt && receipt.event
                      const auditText =
                        event === 'acceptance-recheck'
                          ? '重新确认'
                          : event === 'acceptance-stale'
                            ? '需要重新确认'
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
                          { className: 'dc-timeline-text', title: (receipt && receipt.summary) || '' },
                          h(
                            'span',
                            { className: 'dc-timeline-stage' },
                            (receipt && (receipt.stageName || STAGE_TEXT[receipt.stage])) || '这一步',
                          ),
                          '：',
                          (receipt && receipt.summary) || '（没有摘要）',
                        ),
                        auditText ? h(Chip, { tone: 'idle' }, auditText) : null,
                      )
                    }),
                  ),
                )
              }),
            ),
      )
    }

    // 团队泳道：这个项目里正在跑的会话 / 子代理。只读，不提供任何按钮或跳转。
    // 服务缺失（旧版 DSH 没暴露 sessions/agents）与"真的没人"是两件事，文案必须分开。
    function TeamRail(props) {
      const team = props.team || {}
      const agents = asArray(team.agents)
      if (team.available !== true) {
        return h(
          Module,
          { title: '团队', icon: 'team', tone: 'idle', level: 3, meta: '读不到' },
          h(
            'p',
            { className: 'dc-rail-note' },
            team.reason === 'service-missing'
              ? '当前 DSH 没有暴露会话信息'
              : '这次没读到团队信息，刷新再试。',
          ),
        )
      }
      if (agents.length === 0) {
        return h(
          Module,
          { title: '团队', icon: 'team', tone: 'idle', level: 3, meta: '0 人' },
          h('p', { className: 'dc-rail-note' }, '没有正在运行的子代理'),
        )
      }
      return h(
        Module,
        {
          title: '团队',
          icon: 'team',
          tone: 'brand',
          level: 3,
          meta: `${agents.length} 人${team.truncated ? '+' : ''}`,
        },
        h(
          'ul',
          { className: 'dc-team-list' },
          agents.map((agent, index) => {
            const depth = Number.isInteger(agent && agent.depth) ? agent.depth : 0
            const running = Boolean(agent && agent.running)
            // 层级用缩进表达（最多 4 层，避免窄栏里挤成一条竖线），角色优先用 Host 给的 preset。
            const role = agent && agent.preset
              ? `${agent.preset}${depth > 0 ? ` · 第 ${depth} 层` : ''}`
              : depth > 0
                ? `子代理 · 第 ${depth} 层`
                : '主会话'
            const hint = agent && agent.parentName ? `上级：${agent.parentName}` : ''
            return h(
              'li',
              {
                key: (agent && agent.id) || `agent${index}`,
                className: 'dc-team-row',
                style: depth > 0 ? { paddingLeft: `${Math.min(depth, 4) * 12}px` } : undefined,
                title: hint || undefined,
              },
              h('span', { className: 'dc-team-name' }, (agent && agent.name) || '未命名'),
              h('span', { className: 'dc-team-role' }, role),
              h(Chip, { tone: running ? 'success' : 'idle' }, running ? '在线' : '空闲'),
            )
          }),
        ),
        team.truncated ? h('p', { className: 'dc-rail-note' }, '只显示前 20 个会话') : null,
      )
    }

    function SidebarRail(props) {
      const ledger = props.ledger || {}
      const receipts = asArray(ledger.receipts)
      const warnings = asArray(props.warnings)
      const dataGaps = asArray(props.dataGaps)
      const featureNotes = asArray(props.features && props.features.notes)
      const decisionReceipt = receipts.find((receipt) => receipt && receipt.needsDecision) || null
      const decision = decisionReceipt && decisionReceipt.needsDecision
      const gapCount = warnings.length + dataGaps.length + featureNotes.length
      return h(
        'aside',
        { className: 'dc-rail', 'aria-label': '补充信息' },
        decision
          ? h(
              Module,
              { className: 'dc-module-warn', title: '需要你决定', icon: 'defects', tone: 'warn', level: 3, role: 'status' },
              h('div', { className: 'dc-decision-title' }, decision.title || '这件事需要你拍板'),
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
        h(TeamRail, { team: props.team }),
        h(ReceiptsTimeline, { ledger }),
        gapCount > 0
          ? h(
              Module,
              { title: '数据说明', icon: 'info', tone: 'warn', level: 3 },
              h(
                'details',
                { className: 'dc-more' },
                h('summary', null, `展开 ${gapCount} 条说明`),
                h(
                  'ul',
                  { className: 'dc-rail-details-list' },
                  warnings.map((item, index) =>
                    h('li', { key: `warning${index}` }, `有东西没读到：${(item && item.message) || item}`),
                  ),
                  dataGaps.map((item, index) =>
                    h('li', { key: `gap${index}` }, `这里缺数据：${(item && item.message) || item}`),
                  ),
                  featureNotes.map((item, index) =>
                    h('li', { key: `note${index}` }, `${(item && item.message) || item}`),
                  ),
                ),
              ),
            )
          : null,
      )
    }


    // ---------- 详情页 ----------

    const WORKFLOW_ERROR_TEXT = {
      'bad-workflow': '模式只支持完整流程 / 轻量模式',
      'project-card-missing': '项目名片还没生成，先初始化',
      'project-card-broken': '项目名片不是合法 JSON，先修好',
    }
    const TRELLIS_SKIP_TEXT = {
      'subprocess-missing': '当前会话不能启动子进程，请在能跑命令的会话里初始化',
      'cli-missing': '没找到 trellis CLI，先安装 Trellis',
      'pwsh-missing': '找不到 pwsh（PowerShell 7+）',
    }

    function WorkflowControls(props) {
      const [busy, setBusy] = React.useState('')
      const [message, setMessage] = React.useState('')
      const light = props.workflow === 'light'
      const path = props.projectPath
      const trellis = props.trellis || {}

      const toggleWorkflow = async () => {
        if (busy) return
        setBusy('workflow')
        setMessage('')
        try {
          await postJson(`${API}/workflow`, { path, workflow: light ? 'full' : 'light' })
          if (props.onRefresh) props.onRefresh()
        } catch (error) {
          const key = String(error && error.message ? error.message : error)
          setMessage(WORKFLOW_ERROR_TEXT[key] || key)
        } finally {
          setBusy('')
        }
      }

      const initTrellis = async () => {
        if (busy) return
        setBusy('trellis')
        setMessage('')
        try {
          const body = await postJson(`${API}/trellis-init`, { path })
          if (body.status === 'done' || body.status === 'already-initialized') {
            if (props.onRefresh) props.onRefresh()
            return
          }
          setMessage(TRELLIS_SKIP_TEXT[body.reason] || `Trellis 没初始化成功（${body.reason || body.status}）`)
        } catch (error) {
          setMessage(String(error && error.message ? error.message : error))
        } finally {
          setBusy('')
        }
      }

      const showTrellis = trellis.initialized === true && trellis.ready !== true
      return h(
        'span',
        { className: 'dc-workflow-controls' },
        h(
          'button',
          {
            type: 'button',
            className: `dc-btn dc-btn-ghost dc-mode-btn${light ? ' dc-mode-btn-light' : ''}`,
            'aria-pressed': light ? 'true' : 'false',
            title: light
              ? '轻量模式：跳过架构契约与范围/架构签核；点一下恢复完整 9 阶段'
              : '完整 9 阶段；小改动可切到轻量模式（跳过架构契约与范围/架构签核）',
            onClick: toggleWorkflow,
            disabled: busy === 'workflow',
          },
          busy === 'workflow' ? '切换中…' : light ? '轻量模式' : '完整流程',
        ),
        showTrellis
          ? h(
              'button',
              {
                type: 'button',
                className: 'dc-btn dc-btn-ghost',
                title: '运行 trellis init --dsh，把项目升级成完整 Trellis 工程（trellis-* 技能才可用）',
                onClick: initTrellis,
                disabled: busy === 'trellis',
              },
              busy === 'trellis' ? '初始化中…' : '接通 Trellis',
            )
          : null,
        message ? h('span', { className: 'dc-inline-msg', role: 'status' }, message) : null,
      )
    }

    function DetailPage(props) {
      const panel = props.panel || {}
      const project = panel.project || {}
      // 统一口径：写接口必须拿到项目路径，缺了就禁用而不是发一个 missing-path 的空请求。
      const projectPath = project.path || props.selectedPath || ''
      const ledger = panel.ledger || {}
      const action = panel.nextAction || {}
      const degraded = Boolean(panel.degraded && panel.degraded.flag)
      const degradedReasons = asArray(panel.degraded && panel.degraded.reasons)
      const badLines = Number(ledger.badLines) || 0
      const [initResult, setInitResult] = React.useState(null)
      const rootRef = React.useRef(null)
      usePanelKeyboard(rootRef)

      const lastAt = ledger.lastAt || (asArray(ledger.receipts)[0] && asArray(ledger.receipts)[0].at) || null
      const engineText = degraded || props.panelError ? '服务待确认' : '服务正常'
      const features = panel.features || {}
      const acceptance = panel.acceptance || {}
      const stageName = action.stageName || STAGE_TEXT[action.stageId] || '这里'
      let blockingCount = 0
      for (const item of asArray(features.items)) {
        const bugs = (item && item.bugs) || {}
        if (bugs.known !== false) blockingCount += Number(bugs.blocking) || 0
      }
      const unattributed = features.unattributed || {}
      if (unattributed.known !== false) blockingCount += Number(unattributed.blocking) || 0
      const acceptanceTotal = Number(acceptance.total) || 0
      const acceptancePassed = Number(acceptance.passed) || 0
      const healthText = [
        `正在${stageName}`,
        blockingCount > 0 ? `${blockingCount} 个待修问题` : '暂时没有待修问题',
        acceptanceTotal > 0 ? `验收通过 ${acceptancePassed}/${acceptanceTotal}` : '还没验收',
      ].join(' · ')
      const sourceNames = {
        receipts: '项目动态',
        acceptance: '验收',
        review: '代码检查',
        prd: '需求文档',
        tasks: '任务',
        trellis: '项目规则',
        project: '项目名片',
      }

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
          h(
            'div',
            { className: 'dc-head-main' },
            h('h1', { className: 'dc-title' }, project.name || baseName(project.path) || '项目'),
            h('div', { className: 'dc-head-summary', title: healthText }, healthText),
          ),
          h(Chip, { tone: 'idle' }, (panel.iteration && panel.iteration.current) || '还没开始'),
          h(WorkflowControls, {
            projectPath,
            workflow: project.workflow === 'light' ? 'light' : 'full',
            trellis: panel.trellis || {},
            onRefresh: props.refresh,
          }),
          h(ReviewSettings, {
            settings: (panel.review && panel.review.settings) || {},
            projectPath,
            onRefresh: props.refresh,
            variant: 'header',
          }),
          h('span', { className: 'dc-spacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'dc-btn dc-btn-ghost dc-density',
              'aria-pressed': props.density === 'compact' ? 'true' : 'false',
              title: '在紧凑和舒适之间切换',
              onClick: props.onToggleDensity,
            },
            props.density === 'compact' ? '紧凑' : '舒适',
          ),
          h(
            'details',
            { className: 'dc-shortcuts' },
            h('summary', { className: 'dc-shortcuts-summary', title: '键盘快捷键（按 ? 打开）' }, '快捷键'),
            h(
              'div',
              { className: 'dc-shortcuts-body' },
              h('div', null, h('kbd', null, 'j'), ' / ', h('kbd', null, 'k'), ' 在功能/验收行之间移动'),
              h('div', null, h('kbd', null, 'Enter'), ' 展开或收起点开的那一行'),
              h('div', null, h('kbd', null, 'Esc'), ' 收起，再按一次回到顶部'),
              h('div', null, h('kbd', null, '?'), ' 打开这份说明'),
            ),
          ),
          h(
            'span',
            { className: 'dc-service', title: degraded || props.panelError ? '有些数据没读到' : '一切正常' },
            h('span', { className: `dc-service-dot${degraded || props.panelError ? ' dc-service-dot-warn' : ''}` }),
            engineText,
          ),
          panel.generatedAt
            ? h('span', { className: 'dc-sub dc-time' }, `更新于 ${formatTime(panel.generatedAt)}`)
            : null,
          props.panelLoading ? h('span', { className: 'dc-sr', role: 'status' }, '正在刷新') : null,
          h(
            'a',
            {
              className: 'dc-btn',
              // 下载交给浏览器处理（Content-Disposition: attachment），不走 JS fetch。
              href: `${API}/report?path=${encodeURIComponent(projectPath)}&days=7`,
              title: '下载最近 7 天的项目周报（Markdown）',
            },
            '导出周报',
          ),
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
        { className: `dc-root${props.density === 'compact' ? ' dc-compact' : ''}`, ref: rootRef },
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
                  '动态记录里有几行读不出来（已降级显示）',
                ),
                h('div', { className: 'dc-hint' }, `有 ${badLines} 行不是合法动态，已跳过；下面的统计可能偏低。`),
              )
            : null,
          degraded
            ? h(
                Banner,
                {
                  tone: 'error',
                  role: 'alert',
                  title: '有些数据没读到，先别按下一步行动',
                },
                h(
                  'ul',
                  { className: 'dc-banner-list' },
                  degradedReasons.length > 0
                    ? degradedReasons.map((reason, index) =>
                        h(
                          'li',
                          { key: `reason${index}` },
                          `${sourceNames[(reason && reason.source) || ''] || '数据'}：${(reason && reason.message) || '没读到'}`,
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
                gates: panel.gates,
                iteration: panel.iteration,
                progression: panel.progression,
                projectPath,
                onApplied: (result) => {
                  setInitResult(result)
                  props.refresh()
                },
                onApproved: () => props.refresh(),
              }),
              h(ProgressionSection, {
                progression: panel.progression,
                stages: panel.stages,
                iteration: panel.iteration,
                action,
              }),
              h(MetricsSection, { metrics: panel.metrics }),
              h(FeatureBoardSection, {
                features: panel.features,
                acceptance: panel.acceptance,
                onJumpToAcceptance: jumpToAcceptance,
              }),
              h(AcceptancePanel, {
                acceptance: panel.acceptance,
                actionKind: action.kind,
                projectPath,
                previewUrl: project.commands && project.commands.previewUrl,
                onRefresh: props.refresh,
              }),
              h(DefectsSection, { features: panel.features }),
            ),
            h(SidebarRail, {
              ledger,
              review: panel.review,
              features: panel.features,
              team: panel.team,
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
      const [density, setDensity] = React.useState(readDensity)
      const toggleDensity = React.useCallback(() => {
        setDensity((previous) => {
          const next = previous === 'compact' ? 'cozy' : 'compact'
          saveDensity(next)
          return next
        })
      }, [])
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
          density,
          onToggleDensity: toggleDensity,
        })
      }

      return h(OverviewPage, {
        projects: cockpit.projects,
        overviewAt: cockpit.overviewAt,
        overviewLoading: cockpit.overviewLoading,
        overviewError: cockpit.overviewError,
        openProject: cockpit.openProject,
        refresh: cockpit.refresh,
        density,
        onToggleDensity: toggleDensity,
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














