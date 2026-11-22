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
  for (const endpoint of ['/workspaces', '/panel?path=', '/init-plan?path=', '/init', '/approve-prototype', '/acceptance-result', '/acceptance-screenshot']) {
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
  assert.ok(!source.includes('document.body') && !source.includes('querySelector'), '不得碰宿主 DOM')
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
  assert.ok(source.includes('第 ${cycleIndex + 1} 步 / 共 ${cycleNodes.length || 6} 步'), 'hero 必须有「第 N 步 / 共 6 步」上下文')
  assert.ok(source.includes('stepText') && source.includes('dc-action-eyebrow'), '步骤上下文必须渲染')
  assert.ok(source.includes("'复制给 AI'"), '主按钮必须是「复制给 AI」')
  assert.ok(source.includes("className: 'dc-card dc-hero'"), 'hero 是唯一 surface')
  assert.ok(css.includes('.dc-hero') && css.includes('font-size:20px'), 'hero 标题用 20px')
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
  assert.ok(source.includes('还没有 PRD——「想清楚」阶段会产出它'), 'PRD 缺失文案必须人话')
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
  assert.ok(source.includes('还没有验收清单：让 AI 起草一份'), '空态文案必须人话')
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
  assert.ok(source.includes('还没有验收清单'), '验收空态')
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

test('两栏布局：容器查询 / sticky / 断点', () => {
  assert.ok(css.includes('container-type:inline-size'), '必须用容器查询')
  assert.ok(css.includes('@container (min-width:1170px)'), '两栏断点必须是 1170px 容器查询')
  assert.ok(!/@container \(min-width:1040px\)/.test(css), '不得残留旧 1040 断点')
  assert.ok(css.includes('grid-template-columns:minmax(0,1fr) 280px'), '主区 + 280px 右栏')
  assert.ok(css.includes('.dc-rail { position:sticky; top:118px; z-index:2; }'), '右栏 sticky 与 header+摘要对齐')
  assert.ok(css.includes('.dc-summary-bar { position:sticky; top:71px; z-index:4;'), '摘要条随 header 常驻')
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
