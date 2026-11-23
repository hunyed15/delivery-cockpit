/**
 * 客户端模块的静态自测（不启动浏览器，毫秒级）。
 *
 * 为什么需要它：`client.js` 只能在 DSH 的 Web 页面里执行，Node 里跑不起来；但它一旦
 * 写错（模块 id、slot 名、注入列表、API 前缀），后果是整块面板不出现甚至插件激活失败。
 *
 * 用法：`node --test test/client-smoke.test.js`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = dirname(HERE)
const source = await readFile(join(PACKAGE_DIR, 'client.js'), 'utf8')
const previewServer = await readFile(join(PACKAGE_DIR, 'tools/preview/server.mjs'), 'utf8')

function extractCss(text) {
  const marker = 'const CSS = `'
  const start = text.indexOf(marker)
  if (start < 0) return ''
  const bodyStart = start + marker.length
  const end = text.indexOf('`', bodyStart)
  return end < 0 ? '' : text.slice(bodyStart, end)
}
const css = extractCss(source)
const sliceBetween = (from, to) => {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start + 1)
  return start < 0 || end < 0 ? '' : source.slice(start, end)
}

test('模块包装与身份', () => {
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/, '必须经 __ModuleLoader__.load 注册')
  assert.ok(source.includes("id: '@hunyed15/delivery-cockpit'"), '模块 id 必须等于包名')
  assert.match(source, /factory\s*\(\s*require\s*\)/, 'factory 必须接收 require')
  const requires = [...source.matchAll(/require\(([^)]*)\)/g)].map((match) => match[1].trim())
  assert.deepEqual(requires, ["'react'"], `只允许 require react，实际：${requires.join(' | ')}`)
  assert.ok(!source.includes("'@deepseek-ai/"), '客户端不得 import DSH 包')
  assert.ok(!/from\s+'node:/.test(source) && !/require\('node:/.test(source), '不得引用 node 内置模块')
})

test('inject 与两处 slot 注册', () => {
  const match = source.match(/inject:\s*\[([^\]]*)\]/)
  const declared = match[1]
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
  assert.deepEqual(declared, ['slots'], `只注入 slots，实际：${declared.join(',')}`)
  assert.ok(!source.includes('ctx.styles'), '不得访问 ctx.styles')
  assert.ok(source.includes("ctx.slots.inject('main'"), 'main 必须经 slots.inject 注册')
  assert.ok(source.includes("ctx.slots.inject('sidebar.panellist'"), 'sidebar.panellist 必须经 slots.inject 注册')
  assert.ok(source.includes("const PANEL_ID = 'delivery-cockpit'"), '面板 id 必须是 delivery-cockpit')
  assert.equal([...source.matchAll(/ctx\.slots\.register\(/g)].length, 2, '只注册两处 slot')
  assert.ok(!source.includes("'conversation.view'") && !source.includes("'shell.overlay'"), 'Phase 1 不注册其它槽')
})

test('侧栏图标与 API 契约', () => {
  assert.match(source, /function Icon\(props\)/, '必须导出 Icon({size, active})')
  assert.ok(source.includes('currentColor'), '颜色必须跟随 currentColor')
  assert.ok(source.includes("const API = '/delivery-cockpit/api'"), 'API 前缀必须逐字')
  for (const endpoint of ['/workspaces', '/panel?path=', '/init-plan?path=', '/init', '/approve', '/approve-prototype', '/acceptance-result', '/acceptance-screenshot']) {
    assert.ok(source.includes(`\${API}${endpoint}`), `缺少接口 ${endpoint}`)
  }
  assert.ok(source.includes('confirm: true'), 'POST /init 必须带 confirm: true')
  assert.ok(source.includes('iteration_id: props.iterationId'), 'approve-prototype 必须带 iteration_id')
  assert.ok(source.includes('item_id: id'), 'acceptance-result 必须带 item_id')
  assert.ok(source.includes("credentials: 'same-origin'"), 'fetch 必须 same-origin')
  assert.equal([...source.matchAll(/fetch\(/g)].length, 1, '所有请求必须收口到一个 fetch 封装')
})

test('样式隔离：只依赖 host token 与 .dc- 前缀', () => {
  const classTokens = [...css.matchAll(/\.[A-Za-z][\w-]*/g)].map((match) => match[0])
  assert.ok(classTokens.length > 40, `选择器数量异常：${classTokens.length}`)
  for (const token of classTokens) assert.ok(token.startsWith('.dc-'), `选择器缺少 .dc- 前缀：${token}`)
  const vars = [...css.matchAll(/var\(\s*--([A-Za-z0-9-]+)/g)].map((match) => match[1])
  assert.ok(vars.length > 20, `主题 token 数量异常：${vars.length}`)
  for (const name of vars) assert.ok(name.startsWith('dsw-alias-'), `只允许 host 主题 token，发现 --${name}`)
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'CSS 不得出现字面十六进制色值')
  assert.ok(!/(?:rgba?|hsla?)\(/.test(css), 'CSS 不得出现字面 rgb/hsl 色值')
  assert.ok(source.includes("document.createElement('style')") && source.includes('document.head.appendChild'), '样式注入 head')
  assert.ok(!source.includes('document.body') && !/body\.appendChild/.test(source), '不得向 body 追加节点')
  // 面板只在自己 DOM 里找行（j/k 与「去验收」需要），不读取宿主其它区域。
  assert.ok(source.includes("querySelectorAll('[data-kb-row]')"), '键盘导航只查询面板自己的行')
})

test('记住上次项目', () => {
  assert.ok(source.includes("const LAST_PROJECT_KEY = 'delivery-cockpit:last-project'"), 'localStorage key 必须逐字')
  assert.match(source, /localStorage\.getItem\(LAST_PROJECT_KEY\)/, '要读上次项目')
  assert.match(source, /localStorage\.setItem\(LAST_PROJECT_KEY/, '要写上次项目')
})

test('人话词表：旧词清零、新词齐备', () => {
  const forbidden = [
    '引擎正常',
    '账本健康',
    '门禁',
    '回执',
    '阻塞',
    '失效',
    '未验',
    '功能账',
    '缺陷',
    '未归属缺陷',
    '待决策',
    '执行回执',
    '审核账本',
  ]
  for (const word of forbidden) assert.ok(!source.includes(word), `旧词必须消失：${word}`)
  for (const word of ['卡点', '待修问题', '需要重新确认', '项目动态', '代码检查', '需要你决定', '细节']) {
    assert.ok(source.includes(word), `新词必须出现：${word}`)
  }
  // 技术路径不再出现在区标题 meta；FR 编号/路径只在折叠细节里。
  assert.ok(!source.includes('清单来源') && !/meta:\s*features\.prdPath/.test(source), '区标题不得显示 PRD 路径')
  assert.ok(!source.includes('h(\'th\''), '功能/验收不再用表头表格')
})

test('STAGE_TEXT：9 个 canonical id 的中文名齐备，旧 id 映射保留', () => {
  const canonical = {
    bootstrap: '项目立项',
    requirements: '需求定义',
    architecture: '架构契约',
    prototype: '原型设计',
    implementation: '代码开发',
    testing: '测试验证',
    'code-review': '代码复核',
    acceptance: '验收确认',
    release: '部署发布',
  }
  for (const [id, name] of Object.entries(canonical)) {
    const plain = source.includes(`${id}: '${name}'`)
    const quoted = source.includes(`'${id}': '${name}'`)
    assert.ok(plain || quoted, `STAGE_TEXT 缺少新 id 映射 ${id} → ${name}`)
  }
  const legacy = {
    init: '初始化',
    scaffold: '搭骨架',
    brainstorm: '想清楚',
    coding: '写代码',
    code_review: '挑毛病',
    verification: '验效果',
  }
  for (const [id, name] of Object.entries(legacy)) {
    assert.ok(source.includes(`      ${id}: '${name}'`), `STAGE_TEXT 必须保留旧 id 映射 ${id} → ${name}`)
  }
})

test('信息架构：主区四块 + 右栏，footer 已删', () => {
  for (const title of ['现在要做的下一件事', '项目进度', '功能', '验收']) {
    assert.ok(source.includes(`title: '${title}'`), `缺少区标题：${title}`)
  }
  assert.ok(!source.includes("className: 'dc-foot'"), '详情/总览都不再有 footer')
  assert.ok(!source.includes('主会话活跃'), '页脚残留必须删除')
  assert.ok(source.includes('coldStart') && source.includes('cycle'), '进度必须消费 progression.coldStart/cycle')
  assert.ok(source.includes('stageId === highlightId'), '当前阶段必须唯一高亮')
})

test('header 与摘要条说人话', () => {
  assert.ok(source.includes("className: 'dc-head-summary'"), 'header 必须有一句健康摘要')
  assert.ok(source.includes('acceptancePassed}/${acceptanceTotal') && source.includes('blockingCount'), '健康摘要要含验收与待修')
  assert.ok(source.includes('dc-service-dot'), '服务状态必须弱化成小圆点')
  for (const label of ["'已完成功能'", "'验收通过'", "'待修问题'", "'需要重新确认'", "'需要你决定'"]) {
    assert.ok(source.includes(label), `摘要条缺少人话指标 ${label}`)
  }
  assert.ok(source.includes('dc-summary-progress') && css.includes('height:3px'), '摘要条保留 3px 功能进度条')
})

test('Hero：Answer-first 动作 + 步骤上下文 + 唯一主按钮', () => {
  assert.ok(source.includes('第 ${cycleIndex + 1} 步 / 共 ${cycleNodes.length || 8} 步'), 'hero 必须有「第 N 步 / 共 8 步」上下文')
  assert.ok(source.includes('stepText') && source.includes('dc-action-eyebrow'), '步骤上下文必须渲染')
  assert.ok(source.includes("'复制给 AI'"), '主按钮必须是「复制给 AI」')
  assert.ok(source.includes("className: 'dc-module-hero'"), 'hero 是唯一 surface')
  assert.ok(css.includes('.dc-module-hero') && css.includes('font-size:22px'), 'hero 标题用 22px/700，全页唯一大字号')
  assert.ok(source.includes('...rest'), 'Module 必须透传未知属性（role/aria 语义不能被容器吞掉）')
  assert.ok(source.includes('level === 3'), '右栏模块标题要降级为 h3，标题层级不能压平')
  assert.ok(css.includes('.dc-module-meta-warn'), '代码检查 meta 要保留红绿状态信号')
})

test('功能：人话列表、行可展开、细节才给技术信息', () => {
  assert.ok(source.includes('features.items') && source.includes('FeatureRow'), '必须消费 features.items')
  assert.ok(source.includes("className: 'dc-feature-list'") && source.includes("className: 'dc-feature-row'"), '功能必须是列表行')
  assert.ok(source.includes("'aria-expanded': expanded ? 'true' : 'false'") && source.includes('onClick: props.onToggle'), '行必须可展开且 aria-expanded')
  assert.ok(source.includes("h('button'"), '整行用原生 button，键盘 Enter/Space 可展开')
  for (const text of ['已完成', '进行中', '等验收', '未开始', '卡住了']) assert.ok(source.includes(text), `状态人话缺失：${text}`)
  assert.ok(source.includes('有 ${blocking} 个卡点'), '卡点状态要带数量')
  assert.ok(source.includes('item.statusLabel'), '状态人话必须优先消费 Host 的 statusLabel（不自行推断）')
  assert.ok(source.includes("'优先级'") && source.includes('dc-pri-'), 'P0/P1 优先级不能丢，放展开细节里')
  assert.ok(source.includes('验收通过 ') && source.includes('还没验收'), '验收进度必须人话')
  assert.ok(source.includes('暂时没有动态') || source.includes('最近动态'), '行内要有最近动态')
  const rowMarkup = sliceBetween("className: 'dc-feature-row'", "className: 'dc-feature-detail'")
  assert.ok(!rowMarkup.includes('item.id'), '默认功能行不得出现 FR 编号')
  assert.ok(!rowMarkup.includes('item.paths'), '默认功能行不得出现路径')
  assert.ok(source.includes("h('span', { className: 'dc-detail-label' }, '编号')"), '编号只能在展开细节里')
  assert.ok(source.includes("'相关文件'") && source.includes("'待修问题'"), '展开细节要有路径与待修问题')
})

test('功能空态：PRD 缺失 / 认不出 / 无条目', () => {
  assert.ok(source.includes("source === 'prd-missing'"), '必须处理 prd-missing')
  assert.ok(source.includes('还没有 PRD，所以列不出功能'), 'PRD 缺失文案必须人话')
  assert.ok(source.includes("strategy === 'none'"), '必须处理 strategy===\'none\'')
  assert.ok(source.includes('formatHint') && source.includes('dc-code-block'), '格式提示必须存在（折叠里）')
  assert.ok(source.includes('PRD 里还没有功能条目'), '无条目要有独立文案')
  assert.ok(source.includes("h('summary', null, '细节')"), '技术写法必须收进「细节」')
})

test('自动归属与 known 语义保留', () => {
  assert.ok(source.includes('inferredReceipts'), '必须消费 inferredReceipts')
  assert.ok(source.includes('自动归入'), '展开细节要说明哪些动态是自动归入的')
  assert.ok(source.includes('bugs.known !== false'), '必须区分 bugs.known===false')
  assert.ok(source.includes('还看不出有没有问题'), 'known=false 不伪造 0')
  assert.ok(source.includes('有问题需要修') || source.includes('没有问题需要修'), '空明细要有人话兜底')
})

test('验收：默认极简、细节折叠、已通过折叠', () => {
  assert.ok(source.includes('acceptance.items') && source.includes('AcceptancePanel'), '必须消费 acceptance.items')
  assert.ok(source.includes('const actionable = items.filter') && source.includes('const cleanPassed = items.filter'), '区分待处理与已通过')
  assert.ok(source.includes('已经通过 ${passedCount} 条（展开）'), '已通过必须折叠成一行，且用 Host 全局通过数（截断时不低估）')
  for (const button of ["'通过'", "'没通过'", "'卡住了'", "'撤销'"]) assert.ok(source.includes(button), `缺少操作按钮 ${button}`)
  assert.ok(source.includes("h('summary', null, '细节')") && source.includes('dc-acc-more'), '每行必须有「细节」折叠')
  // 默认行只含标题/结果/提示/按钮；证据、截图、比例、diff 都在细节里。
  const defaultRow = sliceBetween('const renderRow = (item) =>', 'renderDetails(item)')
  assert.ok(!defaultRow.includes('dc-evidence-input'), '默认行不得出现证据输入')
  assert.ok(!defaultRow.includes('dc-diff-block') && !defaultRow.includes('diffPercent'), '默认行不得出现像素比例/变化图')
  const details = sliceBetween('const renderDetails = (item) =>', 'const renderRow = (item) =>')
  assert.ok(details.includes('dc-evidence-input') && details.includes('dc-diff-block'), '证据/比较必须收进细节')
  assert.ok(source.includes('截图并附到证据') && source.includes('编辑证据'), '截图/证据编辑在细节里保留')
  assert.ok(source.includes('通过必须附证据'), '通过必须有证据')
  assert.ok(source.includes('if (props.onRefresh) props.onRefresh()'), '成功后必须刷新')
  assert.ok(source.includes('还没有验收条目'), '空态文案必须人话')
  assert.ok(source.includes("props.actionKind === 'acceptance-draft'"), 'acceptance-draft 时要有指引')
})

test('验收结果与错误码人话', () => {
  assert.ok(source.includes("fail: '没通过'") && source.includes("blocked: '卡住了'"), '结果枚举必须人话')
  for (const [code, text] of [
    ['evidence-required', '通过必须附证据'],
    ['evidence-not-found', '证据文件不存在'],
    ['iteration-mismatch', '验收表属于别的迭代'],
    ['acceptance-broken', '验收表不是合法 JSON'],
    ['item-not-found', '这条验收项已不存在'],
    ['bad-result', '没通过 / 卡住了'],
  ]) {
    assert.ok(source.includes(code), `缺少错误码映射 ${code}`)
    assert.ok(source.includes(text), `错误码 ${code} 没翻成人话`)
  }
  assert.ok(source.includes('explainAcceptanceError'), '错误码要收口到映射函数')
})

test('截图：只挂证据、不改 result', () => {
  assert.ok(source.includes('${API}/acceptance-screenshot'), '必须调用截图端点')
  assert.ok(source.includes('/shot?path='), '证据缩略图必须走 /shot')
  assert.ok(source.includes("window.open(src, '_blank', 'noopener')"), '缩略图必须新标签打开')
  assert.ok(source.includes('IMAGE_EVIDENCE_RE') && source.includes('dc-thumb'), '必须识别图片证据')
  assert.ok(source.includes('const shown = images.slice(0, 3)') && source.includes('dc-thumb-more'), '缩略图最多 3 张 + N')
  assert.ok(source.includes('capturing') && source.includes('截图中…'), '必须有截图中状态')
  assert.ok(source.includes('SHOT_REQUEST_TIMEOUT_MS = 90000'), '截图请求给 90s 兜底')
  assert.ok(source.includes('const payload = { path: props.projectPath, item_id: id }'), '截图 payload 不允许带 result')
  assert.ok(source.includes('不会自动判定通过'), '界面必须说明截图不改结果')
  assert.ok(source.includes('只允许截本机地址'), '必须提示只能截本机')
  // 失效留痕写失败必须如实显示（不能只显示"已截图"就算完）。
  assert.ok(source.includes('shot.receiptWarning') && source.includes('留痕写入失败'), '留痕写失败必须如实显示')
  assert.ok(source.includes('shotReceiptWarning'), '失败原因要行内展示')
})

test('截图错误码人话', () => {
  for (const [code, text] of [
    ['no-url', '先填预览地址'],
    ['browser-not-found', '本机没找到 Chrome/Edge'],
    ['url-not-loopback', '只允许截本机地址'],
    ['timeout', '截图超时'],
    ['capture-failed', '截图失败'],
  ]) {
    assert.ok(source.includes(code), `缺少截图错误码 ${code}`)
    assert.ok(source.includes(text), `截图错误码 ${code} 没翻成人话`)
  }
  assert.ok(source.includes('explainShotError'), '截图错误码要收口')
})

test('视觉回归：结论人话、变化细节收进折叠', () => {
  assert.ok(source.includes('shotDiffs') && source.includes('ShotDiffBadge'), '必须消费 shotDiffs')
  for (const text of ['第一次记录', '和上一版一样', '和上一版有变化', '页面尺寸变了', '没法比较']) {
    assert.ok(source.includes(text), `缺少比较结论文案：${text}`)
  }
  assert.ok(source.includes('最近 5 次版本变化'), '历史列表要说人话')
  assert.ok(source.includes('看变化') && !source.includes('查看 diff'), '变化图链接要说人话')
  assert.ok(source.includes('body.shot && body.shot.comparison'), '截图成功必须消费 comparison')
  assert.ok(source.includes('comparisonMessage(comparison)'), 'comparison 必须翻成人话')
  assert.ok(source.includes('explainDiffReason'), '比较失败原因要收口')
  for (const text of ['上一张截图文件已不在', '不能逐像素比', '只支持 PNG']) {
    assert.ok(source.includes(text), `比较失败原因缺失：${text}`)
  }
})

test('需要重新确认：通过失效的显示与重新确认', () => {
  assert.ok(source.includes('acceptance.stale') && source.includes('item.stale === true'), '必须消费 stale')
  assert.ok(source.includes('需要重新确认'), '结果/提示必须说「需要重新确认」')
  assert.ok(source.includes('截图有变化，需要你重新确认'), '默认行必须给一句提示')
  assert.ok(source.includes('条需要重新确认'), '区标题 meta 要带失效数')
  assert.ok(source.includes("h('button'") && source.includes('body.shot.invalidated'), 'invalidated 必须强提示')
  assert.ok(source.includes('已记录在项目动态里'), '失效留痕要可追溯')
  assert.ok(!/stale:\s*false[\s\S]{0,80}result:/.test(source), 'stale 分支不得改写 result')
})

test('项目进度：一句人话 + 人话 stepper', () => {
  assert.ok(source.includes("title: '项目进度'"), '区标题必须是「项目进度」')
  assert.ok(source.includes('冷启动已完成，现在在「${stageName}」'), '进度区必须有一句人话')
  assert.ok(source.includes('dc-progress-summary'), '人话摘要必须渲染')
  assert.ok(source.includes('dc-cold-inline') && source.includes('coldAllDone'), '冷启动完成时压成一行')
  assert.ok(!source.includes("className: 'dc-facts'"), '不再有 2×2 元信息')
  assert.ok(source.includes('现在这一轮'), 'stepper 标签要人话')
})

test('右栏：需要你决定 / 代码检查 / 项目动态 / 数据说明', () => {
  for (const title of ["'需要你决定'", "'代码检查'", "'项目动态'", '数据说明']) {
    assert.ok(source.includes(title), `右栏缺少 ${title}`)
  }
  assert.ok(source.includes('最近 ${rounds} 轮检查通过 · 没问题'), '代码检查通过要人话')
  assert.ok(source.includes('有 ${blocking} 个待修问题'), '有待修问题要人话')
  assert.ok(source.includes('dc-rail-severe-text'), '最严重的一条仍要显示（file 在 title 里）')
  assert.ok(source.includes('dc-receipts-timeline') && css.includes('max-height:420px'), '动态时间线要有 420 上限')
  assert.ok(source.includes('最近 5 次版本变化'), '动态里的变化历史仍按人话')
  assert.ok(source.includes('`${total} 条`') === false, '不再显示工程感的总条数')
})

test('降级 / 坏行 / 缺失能力 / 错误态兜底', () => {
  assert.match(source, /panel\.degraded\.flag/, '必须消费 degraded.flag')
  assert.ok(source.includes('degradedReasons'), '降级横幅要列原因')
  assert.ok(source.includes('动态记录里有几行读不出来（已降级显示）'), '坏行提示必须人话')
  assert.ok(source.includes('missingBlocks') && source.includes('暂不下发指令'), '能力缺失时显示缺失文案')
  assert.ok(source.includes('disabledReason'), '主按钮禁用要给出原因')
  assert.ok(source.includes('还没有项目工作区'), '总览空态')
  assert.ok(source.includes('还没有验收条目'), '验收空态')
  assert.ok(source.includes('正在加载'), '加载态')
  assert.ok(source.includes('getDerivedStateFromError') && source.includes('面板渲染失败'), 'ErrorBoundary 兜底')
  assert.ok(source.includes("'重试'"), '错误态可重试')
})

test('原型批准与初始化', () => {
  assert.ok(source.includes("action.kind === 'prototype'") && source.includes('通过原型'), '原型批准按钮')
  assert.ok(source.includes('已于') && source.includes('prototype-missing'), '已通过只读态与错误码')
  assert.ok(source.includes('/init-plan?path=') && source.includes('确认写入并初始化'), '初始化先计划后执行')
  assert.ok(source.includes('onApplied'), '初始化成功要刷新')
})

test('决策门签核：四个 gate 的真按钮、POST /approve、错误码人话、a11y', () => {
  // 按钮文案：与 playbook decisionGate 的四个声明一一对应。
  for (const label of ['确认范围', '架构签核', '确认验收', '批准发布']) {
    assert.ok(source.includes(label), `缺少决策门按钮文案：${label}`)
  }
  assert.ok(source.includes('function DecisionGateButton'), '决策门按钮必须是一个可复用组件')
  assert.ok(source.includes('DECISION_GATE_BY_KIND'), 'kind → gate 的映射必须在客户端收口')
  for (const gate of ["gate: 'scope'", "gate: 'architecture'", "gate: 'acceptance'", "gate: 'release'"]) {
    assert.ok(source.includes(gate), `缺少 gate 映射：${gate}`)
  }
  // 接口：POST /approve，body 必须带 path / iteration_id / gate。
  assert.ok(source.includes('${API}/approve'), '必须 POST 到 /approve')
  assert.ok(source.includes('iteration_id: props.iterationId') && source.includes('gate: props.gate'), '签核请求必须带迭代与 gate')
  assert.ok(source.includes('onApproved(body)') || source.includes('props.onApproved'), '成功后面板要刷新')
  // 错误码翻译：四种前置失败都要告诉人下一步做什么。
  for (const [code, text] of [
    ['prd-missing', '先写 PRD 再签核。'],
    ['architecture-gate-not-ready', '架构契约文件还不齐，先补齐。'],
    ['acceptance-not-passing', '验收还没全部通过（含证据）。'],
    ['release-gate-not-ready', '发布清单还不完整。'],
    ['bad-gate', '这个签核动作不认识，刷新重试。'],
    ['bad-iteration', '还没定下这一轮，刷新重试。'],
  ]) {
    assert.ok(source.includes(`'${code}': '${text}'`), `缺少错误码人话：${code}`)
  }
  // a11y / 防重复提交：原生 button + 保存中禁用。
  assert.equal(
    [...source.matchAll(/type: 'button'[\s\S]{0,200}?disabled: props\.disabled === true \|\| state\.step === 'saving'/g)].length >= 2,
    true,
    '原型与决策门按钮都要 type=button 且提交中禁用',
  )
  assert.ok(source.includes("state.step === 'saving' ? '提交中…' : props.label"), '提交中要有明确文案')
})

test('两栏布局：容器查询 / sticky / 断点', () => {
  assert.ok(css.includes('container-type:inline-size'), '必须用容器查询')
  assert.ok(css.includes('@container (min-width:1170px)'), '两栏断点必须是 1170px 容器查询')
  assert.ok(!/@container \(min-width:1040px\)/.test(css), '不得残留旧 1040 断点')
  assert.ok(css.includes('grid-template-columns:minmax(0,1fr) 280px'), '主区 + 280px 右栏')
  assert.ok(css.includes('.dc-rail { position:sticky; top:118px; z-index:2; }'), '右栏 sticky 与 header+摘要对齐')
  assert.ok(css.includes('.dc-summary-module { position:sticky; top:71px; z-index:4; }'), '摘要条随 header 常驻')
  assert.ok(css.includes('@container (max-width:700px)'), '主区 ≤700 时行改为堆叠')
  assert.ok(css.includes('.dc-feature-row, .dc-acc-row { grid-template-columns:minmax(0,1fr); }'), '窄主区行必须堆叠')
  assert.ok(source.includes('共 ${projects.length} 个项目'), '总览标题行显示项目数')
})

test('视觉体系：字号 / 等宽数字 / focus / 动效 / 双主题 / 骨架', () => {
  assert.ok(css.includes('font-size:13.5px') && css.includes('line-height:1.65'), '正文 13.5/1.65')
  assert.ok(css.includes('.dc-feature-name') && css.includes('font-size:14px') && css.includes('font-weight:600'), '行主文本 14/600')
  assert.ok(css.includes('font-variant-numeric:tabular-nums'), '数字必须等宽')
  assert.ok(css.includes(':focus-visible') && css.includes('outline:2px solid var(--dsw-alias-brand-primary)'), 'focus ring 用 accent token')
  assert.ok(css.includes('prefers-reduced-motion: reduce'), '必须尊重 reduced-motion')
  assert.ok(css.includes('ease-out'), '状态变化用 ease-out')
  assert.ok(source.includes('dc-skel dc-skel-line') && !source.includes('dc-spinner'), '加载态用骨架屏')
  assert.ok(source.includes('dc-ws-enter') && css.includes('.dc-ws-card:hover .dc-ws-enter'), '总览箭头 hover 位移')
  assert.ok(previewServer.includes('html[data-theme="dark"]') && previewServer.includes("get('theme') === 'dark'"), '深色主题可切换')
  assert.ok(source.includes("h('summary', null, '细节')"), '折叠统一叫「细节」')
  assert.ok(css.includes('.dc-more > summary') || css.includes('.dc-more > summary'), '细节折叠有可展开样式')
})

test('空态引导：一句原因 + 一个真能用的动作', () => {
  assert.ok(source.includes('function EmptyState(props)'), '必须有统一 EmptyState')
  for (const text of [
    '还没有 PRD，所以列不出功能',
    'PRD 里没有「### FR-N」结构',
    '还没有验收条目',
    '项目还没有动态',
    '项目还没初始化',
  ]) {
    assert.ok(source.includes(text), `缺少空态文案：${text}`)
  }
  for (const label of ['复制下一步指令', '复制起草指令']) {
    assert.ok(source.includes(label), `缺少空态动作：${label}`)
  }
  assert.ok(source.includes('id: \'dc-hero-copy\''), 'hero 复制按钮必须有稳定 id')
  assert.ok(source.includes('function focusHeroCopy()'), '空态动作要能滚到 hero 并聚焦')
  assert.ok(source.includes("scrollIntoView({ block: 'center'") && source.includes('button.focus()'), '动作=滚动+聚焦，不自动复制')
  assert.ok(source.includes('AI 每完成一步会记一条'), '无动态空态必须人话')
})

test('功能 ↔ 验收联动：过滤、去验收、高亮', () => {
  assert.ok(source.includes("entry.featureRef === item.id"), '功能细节必须按 featureRef 过滤验收项')
  assert.ok(source.includes("'这个功能的验收'"), '细节里必须有一段「这个功能的验收」')
  assert.ok(source.includes('这个功能还没有验收条目'), '没有关联验收时要有一句兜底')
  assert.ok(source.includes("'去验收'") && source.includes('onJumpToAcceptance'), '每条关联验收要有「去验收」')
  assert.ok(source.includes("'data-acc-id': id") && source.includes('tabIndex: -1'), '验收行要有稳定锚点且可聚焦')
  assert.ok(source.includes('function jumpToAcceptance(id)') && source.includes('classList.add(\'dc-acc-flash\')'), '跳转后要加高亮类')
  assert.ok(source.includes('setTimeout(() => row.classList.remove(\'dc-acc-flash\'), 2000)'), '高亮 2 秒后移除')
  assert.ok(css.includes('.dc-acc-flash') && css.includes('transition:background-color .15s ease-out'), '高亮只做背景过渡')
})

test('项目动态按时间分组：今天 / 本周 / 更早', () => {
  assert.ok(source.includes('function timelineGroupOf(value)'), '必须有分组函数')
  for (const label of ["'今天'", "'本周'", "'更早'"]) assert.ok(source.includes(label), `缺少分组：${label}`)
  assert.ok(source.includes("role: 'group'") && source.includes("'aria-label': label"), '分组要有语义 aria-label')
  assert.ok(source.includes('dc-timeline-group-title'), '分组标题必须渲染')
  assert.ok(source.includes('dc-timeline-scroll') && css.includes('max-height:420px'), '时间线仍 420 滚动')
  assert.ok(source.includes("event === 'acceptance-stale'") && source.includes('需要重新确认'), '审计徽章保留')
})

test('密度切换：紧凑/舒适 + localStorage', () => {
  assert.ok(source.includes("const DENSITY_KEY = 'delivery-cockpit:density'"), '密度 localStorage key 必须逐字')
  assert.ok(source.includes('function readDensity()') && source.includes('function saveDensity('), '密度要读写本地记忆')
  assert.ok(source.includes('dc-compact') && source.includes("'aria-pressed': props.density === 'compact'"), '切换按钮要有 aria-pressed')
  assert.ok(source.includes("props.density === 'compact' ? '紧凑' : '舒适'"), '按钮文案要紧凑/舒适')
  assert.ok(css.includes('.dc-root.dc-compact') && css.includes('.dc-compact .dc-feature-row'), '紧凑态有独立样式')
  assert.ok(css.includes('.dc-compact .dc-module-body') && css.includes('.dc-compact .dc-thumb'), '模块间距与缩略图也要随密度变')
})

test('键盘：j/k、Enter、Esc、? + 输入框不劫持', () => {
  assert.ok(source.includes('function usePanelKeyboard(rootRef)'), '必须有键盘导航 hook')
  assert.ok(source.includes("node.addEventListener('keydown', onKeyDown)") && source.includes("node.removeEventListener('keydown', onKeyDown)"), '监听必须挂在根上且卸载时清理')
  assert.ok(source.includes("element.tagName === 'INPUT'") && source.includes("element.tagName === 'TEXTAREA'") && source.includes("element.tagName === 'SELECT'") && source.includes('element.isContentEditable'), '输入框/可编辑区不劫持')
  assert.ok(source.includes("event.key === 'j' || event.key === 'k'") && source.includes('% list.length'), 'j/k 必须在行间移动并回绕')
  assert.ok(source.includes("event.key === 'Enter'") && source.includes("details.open = !details.open"), 'Enter 要能开合验收细节')
  assert.ok(source.includes("event.key === 'Escape'") && source.includes("expandedFeature.click()"), 'Esc 要能收起当前展开行')
  assert.ok(source.includes("event.key === '?'") && source.includes(".dc-shortcuts"), '? 要打开快捷键说明')
  assert.ok(source.includes('aria-keyshortcuts'), '行上必须有 aria-keyshortcuts')
  assert.ok(source.includes("'data-kb-row': 'true'"), '功能行与验收行必须参与 j/k')
  assert.ok(source.includes("className: 'dc-shortcuts'") && source.includes("h('kbd', null, 'j')"), 'header 要有快捷键 details 列表')
  assert.ok(css.includes('.dc-shortcuts-summary') && css.includes('.dc-shortcuts-body'), '快捷键说明有可展开样式')
})

test('模块化工作台：容器 / 头 / 体 / 层色 / 间距', () => {
  assert.ok(source.includes('function Module(props)'), '必须有统一 Module 组件')
  assert.ok(source.includes("className: 'dc-module'") || source.includes('dc-module${'), '模块容器必须存在')
  assert.ok(source.includes("className: 'dc-module-head'") && source.includes("className: 'dc-module-body'"), '模块必须有头/体')
  assert.ok(css.includes('.dc-module {') && css.includes('background:var(--dsw-alias-bg-layer-2)'), '模块卡底必须是 layer-2（浮在画布上）')
  assert.ok(css.includes('.dc-root { background:var(--dsw-alias-bg-layer-1);'), '画布必须是 layer-1')
  assert.ok(css.includes('.dc-module-head {') && /\.dc-module-head \{[\s\S]{0,120}background:var\(--dsw-alias-bg-layer-1\)/.test(css), '模块头必须与卡体形成 layer-1/layer-2 条纹')
  assert.ok(/\.dc-module-head \{[\s\S]{0,80}height:42px/.test(css), '模块头 42px')
  assert.ok(/\.dc-module-body \{ padding:16px/.test(css), '模块体 padding 16px')
  assert.ok(css.includes('.dc-main { gap:16px; }') && css.includes('.dc-rail { display:flex; flex-direction:column; gap:12px;'), '主区模块间距 16、右栏 12')
  assert.ok(css.includes('.dc-rail-group'), '旧连通面板样式可保留但不再使用')
  assert.ok(!source.includes("className: 'dc-rail-group'"), '右栏必须是 4 个独立模块，不是连通面板')
  assert.ok((source.match(/h\(\s*Module,/g) || []).length >= 7, '模块数量应覆盖主区与右栏')
  assert.ok(source.includes("title: '需要你决定'") && source.includes("title: '代码检查'") && source.includes("title: '项目动态'") && source.includes("title: '数据说明'"), '右栏四个模块齐备')
  assert.ok(css.includes('.dc-module-warn'), '需要你决定是 warn 模块')
  assert.ok(css.includes('color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, var(--dsw-alias-bg-layer-2))'), 'hero 必须 brand 6% 混合底')
  assert.ok(css.includes('border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, var(--dsw-alias-border-l1))'), 'hero 边框 brand 28%')
  assert.ok(css.includes('.dc-summary-stat + .dc-summary-stat') && css.includes('border-left:1px solid var(--dsw-alias-border-l1)'), '摘要组间必须有竖分隔线')
  assert.ok(css.includes('.dc-feature-detail, .dc-more-body') && css.includes('background:var(--dsw-alias-bg-layer-1)'), '展开细节/代码块用 layer-1 圆角块')
  assert.ok(css.includes('.dc-empty-state { background:var(--dsw-alias-bg-layer-1); border:1px dashed'), '空态是虚线框')
})

test('图标：inline SVG 模块图标 ≥6 种', () => {
  assert.ok(source.includes('function ModuleIcon(props)'), '必须有 inline SVG 图标组件')
  for (const name of ['next', 'progress', 'feature', 'acceptance', 'defects', 'review', 'receipts', 'info']) {
    assert.ok(source.includes(`        ${name}: [`), `缺少图标 ${name}`)
  }
  assert.ok(source.includes("fill: 'none'") && source.includes("stroke: 'currentColor'") && source.includes('strokeWidth: 1.6'), '图标必须 stroke 1.6 + currentColor')
  assert.ok(source.includes("strokeLinecap: 'round'") && source.includes("strokeLinejoin: 'round'"), '图标线头/线角圆角')
  assert.ok(source.includes("icon: 'next'") || source.includes("icon: 'progress'"), '模块头必须传图标')
})

test('字重阶梯：22/700 仅 hero；正文 400；无 650', () => {
  assert.ok(!css.includes('font-weight:650'), '不得再有 650')
  assert.ok(css.includes('.dc-action-title { font-size:22px; font-weight:700'), 'hero 标题 22/700')
  assert.ok(css.includes('.dc-module-title {') && css.includes('font-size:13px; font-weight:600'), '模块标题 13/600')
  assert.ok(css.includes('.dc-feature-name, .dc-acc-title { font-size:13.5px; font-weight:600'), '行名 13.5/600')
  assert.ok(css.includes('font-size:13.5px; line-height:1.65; font-weight:400'), '正文 13.5/400/1.65')
  assert.ok(css.includes('.dc-module-meta { margin-left:auto; font-size:11.5px; font-weight:500'), 'meta 11.5/500')
  assert.ok(css.includes('.dc-chip { font-size:11.5px; font-weight:600'), '状态 pill 11.5/600')
})

test('模块尺寸：360 与紧凑', () => {
  assert.ok(/@container \(max-width:700px\) \{[\s\S]{0,200}\.dc-module-body \{ padding:12px; \}/.test(css), '360 模块体 padding 12')
  assert.ok(/@container \(max-width:700px\) \{[\s\S]{0,300}\.dc-main, \.dc-rail \{ gap:12px; \}/.test(css), '360 模块间距 12')
  assert.ok(css.includes('.dc-compact .dc-module-head { height:36px'), '紧凑模块头 36')
  assert.ok(css.includes('.dc-compact .dc-module-body { padding:12px; }'), '紧凑模块体 12')
  assert.ok(css.includes('.dc-compact .dc-main { gap:10px; }') && css.includes('.dc-compact .dc-rail { gap:10px; }'), '紧凑间距 10')
  assert.ok(css.includes('.dc-compact .dc-feature-row { min-height:40px; }'), '紧凑行高 40')
  assert.ok(css.includes('.dc-root { background:var(--dsw-alias-bg-layer-1); font-size:13.5px'), '画布 layer-1 且正文 13.5')
})

test('状态色：模块图标底片 + 摘要数字 tone', () => {
  const tones = ['brand', 'success', 'warn', 'error', 'idle']
  for (const tone of tones) {
    assert.ok(css.includes(`.dc-module-icon-${tone}`), `缺少模块图标 tone：${tone}`)
  }
  assert.ok(css.includes('.dc-module-icon {') && css.includes('width:24px; height:24px; border-radius:6px'), '图标是 24×24 圆角 6 底片')
  assert.ok(css.includes('background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent)'), '底片用 tone 10% 混合')
  assert.ok(css.includes('.dc-module-icon-idle { background:var(--dsw-alias-bg-layer-1)'), 'idle 底片用 layer-1')
  assert.ok(source.includes('dc-module-icon-${tone ||') || source.includes("dc-module-icon-${tone || 'idle'}"), 'Module 必须按 tone 上底片')
  // 各模块语义 tone
  assert.ok(source.includes('tone: heroTone'), 'hero 用 brand（decide 时 warn）')
  assert.ok(source.includes('tone: progressTone'), '项目进度按阶段 tone')
  assert.ok(source.includes('tone: featuresTone'), '功能按卡点/完成 tone')
  assert.ok(source.includes('tone: acceptanceTone'), '验收按失败/待确认/通过 tone')
  assert.ok(source.includes("tone: 'error'") && source.includes('title: \'没归到功能的待修问题\''), '待修问题 error')
  assert.ok(source.includes("tone: 'warn'") && source.includes("title: '数据说明'"), '数据说明 warn')
  assert.ok(source.includes("tone: 'warn'") && source.includes("title: '需要你决定'"), '需要你决定 warn')
  // 摘要数字语义色
  for (const tone of ['success', 'brand', 'warn', 'error']) {
    assert.ok(css.includes(`.dc-summary-value.dc-summary-${tone}`), `摘要数字缺少 tone：${tone}`)
  }
  assert.ok(source.includes("key: 'blocking'") && source.includes("tone: blocking > 0 ? 'error' : null"), '待修问题 >0 才红')
  assert.ok(source.includes("key: 'stale'") && source.includes("tone: stale > 0 ? 'warn' : null"), '需要重新确认 >0 才 warn')
  assert.ok(!/dc-summary-(bad|ok)\b/.test(css) && !source.includes("tone: blocking > 0 ? 'bad'"), '不再用旧 bad/ok tone')
})

test('hero 阶段色带：4px、推进百分比、decide 变 warn', () => {
  assert.ok(source.includes("className: 'dc-hero-band"), 'hero 必须有色带容器')
  assert.ok(source.includes("'aria-hidden': 'true'") && source.includes('dc-hero-band-fill'), '色带 aria-hidden 且填充层存在')
  assert.ok(source.includes('const bandPercent =') && source.includes('(cycleIndex + 1) / cycleNodes.length'), '按当前步骤计算推进百分比')
  assert.ok(source.includes('style: { width: `${bandPercent}%` }'), '色带 fill 宽度使用百分比')
  assert.ok(source.includes("action.kind === 'decide' ? 'warn' : 'brand'"), 'decide 阶段改 warn')
  assert.ok(source.includes('dc-hero-band-warn'), 'warn 色带类存在')
  assert.ok(/\.dc-hero-band \{ height:4px; width:100%; background:var\(--dsw-alias-bg-layer-2\)/.test(css), '色带 4px、轨道 layer-2、贴顶')
  assert.ok(css.includes('.dc-hero-band-fill { display:block; height:100%; background:var(--dsw-alias-brand-primary); }'), '色带填充 brand')
})

test('功能行细进度条：0/部分/全过 + 360 不溢出', () => {
  assert.ok(source.includes("className: 'dc-feature-progress'"), '功能行必须有进度条')
  assert.ok(source.includes("'aria-hidden': 'true'") && source.includes('dc-feature-progress-fill'), '进度条 aria-hidden（文字已朗读）')
  assert.ok(source.includes('accepted > 0') && source.includes('dc-feature-progress'), '无验收条目不渲染进度条')
  assert.ok(source.includes("passed === accepted ? ' dc-feature-progress-full'"), '全过用 success 填充')
  assert.ok(source.includes('style: { width: `${Math.round((passed / accepted) * 100)}%` }'), '进度按 passed/total')
  assert.ok(css.includes('.dc-feature-progress {') && css.includes('width:60px; height:3px'), '3px 细条、宽 60')
  assert.ok(css.includes('.dc-feature-progress-fill { display:block; height:100%; background:var(--dsw-alias-brand-primary); }'), '部分进度 brand')
  assert.ok(css.includes('.dc-feature-progress-full { background:var(--dsw-alias-state-success-primary); }'), '全过 success')
  assert.ok(css.includes('.dc-feature-progress { width:40px; }'), '360 下缩到 40px')
  assert.ok(css.includes('.dc-compact .dc-feature-progress { width:48px; }'), '紧凑下 48px')
})





test('阶段检查：hero 读取 panel.gates，展示检查状态 / 方法 / 交付物', () => {
  assert.ok(source.includes('gates: panel.gates'), 'DetailPage 必须把 gates 传给 hero')
  assert.ok(source.includes('阶段检查'), 'hero 必须有阶段检查标签')
  assert.ok(source.includes("validateArchitecture: 'architecture'") && source.includes("validateTestReport: 'tests'") && source.includes("validateRelease: 'release'"), '技术门映射三键')
  assert.ok(source.includes("gateOk ? 'success' : 'warn'"), '通过用 success，未过用 warn')
  assert.ok(source.includes('方法：') && source.includes('交付物：'), '展示 method 与 deliverables')
  assert.ok(css.includes('.dc-gate {') && css.includes('.dc-gate-label {'), '门禁样式存在')
})
test('阶段只读详情：节点可点击（data-stage / aria-pressed），详情只读且不改下一步', () => {
  assert.ok(source.includes("className: 'dc-stage-tap'"), '节点必须是可点击按钮')
  assert.ok(source.includes("'data-stage': node.stageId"), '节点带 data-stage 便于定位')
  assert.ok(source.includes("'aria-pressed': selected"), '按钮有 aria-pressed 状态')
  assert.ok(source.includes('阶段详情') && source.includes('function StageDetail'), '只读阶段详情组件存在')
  assert.ok(source.includes('回到当前'), '详情可回到当前阶段')
  assert.ok(source.includes('const [selectedId, setSelectedId] = React.useState'), '选中态只在客户端')
  assert.ok(css.includes('.dc-stage-detail {') && css.includes('.dc-stage-row-label {'), '详情样式存在')
})

test('阶段详情显示签核状态：已签核 / 未签核 + 时间', () => {
  assert.ok(source.includes("'需要你确认'"), '决策门仍在「需要你确认」一行')
  assert.ok(source.includes("'已签核'") && source.includes("'未签核'"), '签核状态必须是人话 Chip')
  assert.ok(source.includes("stage.decisionGate.approved === true ? 'success' : 'warn'"), '已签核 success、未签核 warn')
  assert.ok(source.includes('stage.decisionGate.title'), '必须显示签核标题')
  assert.ok(source.includes('formatRelative(stage.decisionGate.at)'), '已签核必须显示时间')
  assert.ok(source.includes('dc-stage-row-when'), '时间有独立样式锚点')
  assert.ok(css.includes('.dc-chip-success'), 'success chip 样式存在（与 ok 同色）')
  assert.ok(!source.includes('已完成签核') && !source.includes('未完成签核'), '签核文案保持两态，不造第三态')
})

test('缺失能力给替代 / 安装指引：只展示，不执行、不自动安装', () => {
  assert.ok(source.includes('function CapabilityAdvice'), '建议必须是可复用组件')
  assert.ok(source.includes('缺失能力的替代与安装'), '建议块有可读 aria-label')
  for (const text of ['替代：', '安装：', 'dc-advice-list', 'dc-advice-fallback']) {
    assert.ok(source.includes(text), `建议块缺少：${text}`)
  }
  assert.ok(source.includes('target: \'_blank\'') && source.includes("rel: 'noreferrer'"), '安装链接新窗口打开且 noopener')
  assert.ok(source.includes("h('code', { className: 'dc-advice-cmd' }"), '安装命令必须用 <code> 展示可复制文本')
  assert.ok(!source.includes('navigator.clipboard.writeText(target.command)'), '不得提供命令自动执行 / 复制注入')
  assert.ok(source.includes('advice.fallback'), '替代文案来自 Host 下发的 advice')
  assert.ok(source.includes('h(CapabilityAdvice, { items: caps })'), 'hero 与阶段详情都渲染建议')
  assert.ok(css.includes('.dc-advice-list {') && css.includes('.dc-advice-link'), '建议块样式存在')
  // 建议块里不出现按钮：替代/安装只能看，不能点着执行。
  const adviceBlock = sliceBetween('function CapabilityAdvice', 'function NextActionSection')
  assert.ok(!adviceBlock.includes("h('button'"), '建议块不得有按钮')
  assert.ok(!adviceBlock.includes('onClick'), '建议块不得挂点击执行')
})

test('团队泳道：右栏模块 / 名字 + 角色 + 在线空闲 / 空态 / 只读', () => {
  assert.ok(source.includes('function TeamRail'), '团队模块必须存在')
  assert.ok(source.includes("title: '团队'") && source.includes('team: panel.team'), '右栏消费 panel.team')
  assert.ok(source.includes('h(TeamRail, { team: props.team })'), '团队模块挂在右栏')
  for (const text of ["'在线'", "'空闲'", 'dc-team-name', 'dc-team-role']) {
    assert.ok(source.includes(text), `团队模块缺少：${text}`)
  }
  assert.ok(css.includes('.dc-team-list {') && css.includes('.dc-team-row {'), '团队列表样式存在')
  assert.ok(source.includes('没有正在运行的子代理'), '空态文案')
  assert.ok(source.includes('当前 DSH 没有暴露会话信息'), '服务缺失文案')
  const teamBlock = sliceBetween('function TeamRail', 'function SidebarRail')
  assert.ok(!teamBlock.includes("h('button'"), '团队模块只读，不给按钮')
  assert.ok(!teamBlock.includes('onClick'), '团队模块不挂点击')
})

test('团队泳道在 360 窄屏不溢出（可换行 + min-width:0）', () => {
  assert.ok(/\.dc-team-name \{[^}]*min-width:0/.test(css), '名字必须允许收缩')
  assert.ok(/\.dc-team-role \{[^}]*overflow:hidden/.test(css), '角色过长要截断')
  assert.ok(/\.dc-team-row \{[^}]*min-width:0/.test(css), '行容器必须 min-width:0')
  assert.ok(/\.dc-advice \{[^}]*overflow-wrap:anywhere/.test(css), '建议长文本必须换行')
})

test('交付指标：主区模块、四个数卡 + 两条小指标、— 兜底与代理口径', () => {
  assert.ok(source.includes("title: '交付指标'"), '主区要有「交付指标」模块')
  for (const label of ['交付周期', '近 7 天发布', '返工率', '验收通过率', '修复时长', '待修问题']) {
    assert.ok(source.includes(label), `缺少指标名：${label}`)
  }
  assert.ok(
    source.includes('h(MetricsSection, { metrics: panel.metrics })'),
    '指标数据必须来自 model 透传的 panel.metrics',
  )
  assert.ok(source.includes("text === null ? '—' : text"), 'value 为 null 时必须渲染成 —（不是 0）')
  assert.ok(source.includes('dc-metric-value-null'), '— 要走弱化样式，不能和真实数字一样醒目')
  assert.ok(css.includes('.dc-metric-grid') && css.includes('grid-template-columns:repeat(4,minmax(0,1fr))'), '4 张数卡网格')
  assert.ok(css.includes('grid-template-columns:repeat(2,minmax(0,1fr))'), '窄屏降成 2 列，360 不溢出')
  assert.ok(source.includes('dc-metric-mini-row'), '修复时长/待修问题用两行小指标')
  assert.ok(source.includes('数据不足') && source.includes('代理口径'), '要明说数据不足与代理口径')
  assert.ok(source.includes("meta: metrics ? '代理口径' : '数据不足'"), '模块 meta 不能写「近 N 天」（六项窗口口径不一致）')
  assert.ok(source.includes('发布看近 7 天、返工率看近 30 天'), '窗口细节要写在脚注里')
  assert.ok(source.includes('样本 '), 'title 里要带样本数')
  // 0 是合法值：只有 null 才显示 —，0 走正常格式化。
  assert.ok(source.includes("`${Math.round(value * 100)}%`"), '百分比保留整数')
  assert.ok(!/value\s*===\s*0\s*\?\s*'—'/.test(source), '0 不能被当成空值')
})

test('交付指标：模块顺序在「项目进度」之后、「功能」之前', () => {
  const progress = source.indexOf("title: '项目进度'")
  const metrics = source.indexOf("title: '交付指标'")
  const features = source.indexOf("title: '功能'")
  assert.ok(progress >= 0 && metrics > progress && features > metrics, `顺序不对：${progress} / ${metrics} / ${features}`)
})

test('导出周报：header 有下载入口，直接指向 /report（浏览器下载，不走 fetch）', () => {
  assert.ok(source.includes('导出周报'), 'header 要有「导出周报」入口')
  assert.match(source, /href:\s*`\$\{API\}\/report\?path=\$\{encodeURIComponent\(project\.path \|\| props\.selectedPath \|\| ''\)\}&days=7`/, '链接必须带 path 与 days=7')
  assert.ok(!/fetch\(\s*`\$\{API\}\/report/.test(source), '周报下载不走 fetch')
})
