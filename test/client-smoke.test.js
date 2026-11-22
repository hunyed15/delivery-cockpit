/**
 * 客户端模块的静态自测（不启动浏览器，毫秒级）。
 *
 * 为什么需要它：`client.js` 只能在 DSH 的 Web 页面里执行，Node 里跑不起来；但它一旦
 * 写错（模块 id、slot 名、注入列表、API 前缀），后果是整块面板不出现甚至插件激活失败。
 * 这类错误用源码断言就能挡住，不必等装进 DSH、重启、点开面板才发现。
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

// CSS 在模块里是一个模板字符串；单独切出来才能对选择器/颜色做静态约束。
function extractCss(text) {
  const marker = 'const CSS = `'
  const start = text.indexOf(marker)
  if (start < 0) return ''
  const bodyStart = start + marker.length
  const end = text.indexOf('`', bodyStart)
  return end < 0 ? '' : text.slice(bodyStart, end)
}

const css = extractCss(source)

test('模块包装与身份', () => {
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/, '必须经 __ModuleLoader__.load 注册')
  assert.ok(source.includes("id: '@hunyed15/delivery-cockpit'"), '模块 id 必须等于包名')
  assert.match(source, /factory\s*\(\s*require\s*\)/, 'factory 必须接收 require')
  assert.ok(source.includes("require('react')"), '必须 require react')
  const requires = [...source.matchAll(/require\(([^)]*)\)/g)].map((match) => match[1].trim())
  assert.deepEqual(requires, ["'react'"], `只允许 require react，实际：${requires.join(' | ')}`)
  assert.ok(!source.includes("'@deepseek-ai/"), '客户端不得 import DSH 包')
  assert.ok(!/from\s+'node:/.test(source) && !/require\('node:/.test(source), '不得引用 node 内置模块')
})

test('inject 只声明真实存在的 cordis 服务', () => {
  const match = source.match(/inject:\s*\[([^\]]*)\]/)
  assert.ok(match, '必须声明 inject')
  const declared = match[1]
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
  assert.deepEqual(declared, ['slots'], `只注入 slots，实际：${declared.join(',')}`)
  assert.ok(!declared.includes('styles'), 'styles 是模块级 builtin，写进 inject 会让插件激活失败')
  assert.ok(!source.includes('ctx.styles'), '不得访问 ctx.styles')
  assert.match(source, /name:\s*'main',\s*key:\s*PANEL_ID/, 'main 是 keyed 槽，key 必须与侧栏 id 同名')
})

test('注册两处 slot（main + sidebar.panellist）', () => {
  assert.ok(source.includes("name: 'sidebar.panellist'"), '必须注册侧栏入口')
  assert.match(source, /name:\s*'sidebar\.panellist',\s*id:\s*PANEL_ID,\s*order:\s*30,\s*label:\s*\(\)\s*=>\s*'交付'/,
    '侧栏入口 id=PANEL_ID、order=30、label=交付')
  // 槽声明是宿主条目稍后才提供的（且收拢/恢复会重建）：必须经 slots.inject 注册，
  // 直接 register 在声明未就绪时会静默注册不上，面板就不出现。
  assert.ok(source.includes("ctx.slots.inject('main'"), 'main 必须经 slots.inject 注册')
  assert.ok(source.includes("ctx.slots.inject('sidebar.panellist'"), 'sidebar.panellist 必须经 slots.inject 注册')
  assert.ok(source.includes("const PANEL_ID = 'delivery-cockpit'"), '面板 id 必须是 delivery-cockpit')
  const registers = [...source.matchAll(/ctx\.slots\.register\(/g)]
  assert.equal(registers.length, 2, `只注册两处（main / sidebar.panellist），实际 ${registers.length}`)
  assert.ok(!source.includes("'conversation.view'"), 'Phase 1 不注册 conversation.*')
  assert.ok(!source.includes("'conversation.input.dock'"), 'Phase 1 不注册 conversation.input.dock')
  assert.ok(!source.includes("'shell.overlay'"), 'Phase 1 不注册 shell.overlay')
})

test('侧栏图标是纯 SVG 且用 currentColor', () => {
  assert.match(source, /function Icon\(props\)/, '必须导出 Icon({size, active})')
  assert.ok(source.includes("'svg'"), 'Icon 必须是 SVG')
  assert.ok(source.includes('currentColor'), '颜色必须跟随 currentColor')
  assert.ok(source.includes('props.active'), 'Icon 要接 active 状态')
})

test('API 前缀与端点逐字对接契约', () => {
  assert.ok(source.includes("const API = '/delivery-cockpit/api'"), 'API 前缀必须逐字')
  for (const endpoint of ['/workspaces', '/panel?path=', '/init-plan?path=', '/init', '/approve-prototype', '/acceptance-result', '/acceptance-screenshot']) {
    assert.ok(source.includes(`\${API}${endpoint}`), `缺少接口 ${endpoint}`)
  }
  // 写盘动作必须显式确认 + 按迭代批准；缺任何一个都会写坏状态。
  assert.ok(source.includes('confirm: true'), 'POST /init 必须带 confirm: true')
  assert.ok(source.includes('iteration_id: props.iterationId'), 'approve-prototype 必须带 iteration_id')
  assert.ok(source.includes('item_id: id'), 'acceptance-result 必须带 item_id')
  assert.ok(source.includes('evidence,'), 'acceptance-result 必须带 evidence')
  assert.ok(source.includes("credentials: 'same-origin'"), 'fetch 必须 same-origin')
  const fetches = [...source.matchAll(/fetch\(/g)]
  assert.equal(fetches.length, 1, '所有请求必须收口到一个 fetch 封装')
  assert.ok(!source.includes('/project-cockpit/api'), '不得调用旧插件路由')
  assert.ok(!source.includes('/claude-review/api'), '不得调用别的插件路由')
})

test('样式隔离：只用 .dc- 前缀与 --dsw-alias-* token', () => {
  assert.ok(css.length > 2000, `CSS 未提取到（${css.length} 字符）`)
  const classTokens = [...css.matchAll(/\.[A-Za-z][\w-]*/g)].map((match) => match[0])
  assert.ok(classTokens.length > 40, `选择器数量异常：${classTokens.length}`)
  for (const token of classTokens) {
    assert.ok(token.startsWith('.dc-'), `选择器缺少 .dc- 前缀：${token}`)
  }
  const vars = [...css.matchAll(/var\(\s*--([A-Za-z0-9-]+)/g)].map((match) => match[1])
  assert.ok(vars.length > 20, `主题 token 数量异常：${vars.length}`)
  for (const name of vars) {
    assert.ok(name.startsWith('dsw-alias-'), `只允许 host 主题 token，发现 --${name}`)
  }
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'CSS 不得出现字面十六进制色值')
  assert.ok(!/(?:rgba?|hsla?)\(/.test(css), 'CSS 不得出现字面 rgb/hsl 色值')
})

test('样式注入与 DOM 边界', () => {
  assert.ok(source.includes("document.createElement('style')"), '必须用原生 style 标签注入样式')
  assert.ok(source.includes('document.head.appendChild'), '样式注入 document.head')
  assert.ok(source.includes("const STYLE_ID = 'delivery-cockpit-style'"), '样式标签要有固定 id 防重复注入')
  assert.ok(!source.includes('document.body'), '不得碰 document.body')
  assert.ok(!/body\.appendChild/.test(source), '不得向 body 追加节点')
  assert.ok(!source.includes('querySelector'), '不得读取宿主 DOM')
})

test('记住上次项目', () => {
  assert.ok(source.includes("const LAST_PROJECT_KEY = 'delivery-cockpit:last-project'"), 'localStorage key 必须逐字')
  assert.match(source, /localStorage\.getItem\(LAST_PROJECT_KEY\)/, '要读上次项目')
  assert.match(source, /localStorage\.setItem\(LAST_PROJECT_KEY/, '要写上次项目')
})

test('信息架构：主区四块 + 右栏，页脚已删除', () => {
  for (const title of ['唯一下一步', '迭代进度', '功能账 & 缺陷账', '验收清单']) {
    assert.ok(source.includes(`title: '${title}'`), `缺少区标题：${title}`)
  }
  // 四个区不是序列：区标题不再带 ①–④ 圆圈数字。
  assert.ok(!source.includes("title: '① 项目名片"), '区标题不得再带圆圈数字')
  for (const text of ['引擎正常', '数据待确认']) {
    assert.ok(source.includes(text), `缺少状态文案：${text}`)
  }
  assert.ok(source.includes('上次 '), '右栏回执标题行必须带「上次 <相对时间>」')
  assert.ok(!source.includes('主会话活跃'), '页脚（主会话活跃）必须删除')
  assert.ok(!source.includes("className: 'dc-foot'"), '详情/总览都不再有 footer')
  assert.ok(source.includes('coldStart') && source.includes('cycle'), '进度必须消费 progression.coldStart/cycle')
  assert.ok(source.includes('stageId === highlightId'), '当前阶段必须有且只有一个强高亮')
})

test('摘要条取代功能区进度行', () => {
  assert.ok(source.includes('features.progress'), '必须消费 features.progress')
  assert.ok(source.includes('SummaryBar'), '必须有摘要条组件')
  for (const label of ["'功能'", "'验收'", "'缺陷'", "'失效'", "'待决策'"]) {
    assert.ok(source.includes(label), `摘要条缺少统计项 ${label}`)
  }
  assert.ok(source.includes("featureTotal > 0 ? `${featureDone}/${featureTotal}` : '—'"),
    'total===0 时功能统计必须显示 —')
  assert.ok(source.includes('dc-summary-progress') && source.includes('dc-summary-fill'), '摘要条必须有 3px 功能进度条')
  assert.ok(!source.includes("className: 'dc-progress-row'"), '功能进度不再单独占区③一行')
})

test('功能账表格：三路证据如实呈现', () => {
  assert.ok(source.includes('features.items'), '必须消费 features.items')
  assert.ok(source.includes('FeatureBoardSection'), '必须有功能账区组件')
  for (const text of ['已完成', '有阻塞', '进行中', '待验收', '未开始', '—']) {
    assert.ok(source.includes(text), `缺少功能状态文案：${text}`)
  }
  assert.ok(source.includes('statusLabel'), '状态必须优先使用 Host 下发的 statusLabel')
  for (const header of ["'功能'", "'状态'", "'最近进展'"]) {
    assert.ok(source.includes(`h('th', { scope: 'col' }, ${header})`), `缺少表头 ${header}`)
  }
  // 数字列（待修/验收）右对齐 + 等宽数字，视觉改版后仍必须保持。
  for (const header of ["'待修'", "'验收'"]) {
    assert.ok(source.includes(`h('th', { scope: 'col', className: 'dc-num' }, ${header})`), `缺少数字表头 ${header}`)
  }
  assert.ok(source.includes('dc-feature-detail-row'), '行必须可展开显示 bug 明细')
  assert.ok(source.includes('dc-path-row') && source.includes('关联路径'), '展开区必须显示关联路径')
  assert.ok(source.includes('dc-pri'), 'priority 必须有 P0/P1 小徽章')
  assert.ok(source.includes('lastSummary'), '最近进展必须来自 lastSummary')
})

test('缺陷账：known 不能伪造成 0，未归属必须单列', () => {
  assert.ok(source.includes('bugs.known !== false'), '必须区分 bugs.known===false')
  assert.ok(source.includes('if (known) {'), 'known 分支必须存在')
  assert.ok(source.includes("let bugText = '—'"), 'known===false 时待修列初始为 —')
  assert.ok(source.includes("else bugText = '0'"), 'known===true 且无阻塞时才显示 0')
  assert.ok(source.includes('acceptanceTotal > 0'), '验收 total===0 时必须显示 —')
  assert.ok(source.includes('unattributed.blocking'), '必须消费 unattributed.blocking')
  assert.ok(source.includes('未归属缺陷'), '未归属阻塞必须单列')
  assert.ok(source.includes('按路径没匹配到任何功能'), '未归属区必须注明匹配口径')
  assert.ok(source.includes('SEVERITY_TEXT'), 'bug 明细必须显示 severity 中文')
})

test('自动归属可解释：推断条数与路径锚点要显示出来', () => {
  assert.ok(source.includes('inferredReceipts'), '必须消费 inferredReceipts')
  assert.ok(source.includes('自动归属'), '展开区必须说明哪些回执是自动归属的')
  assert.ok(source.includes('路径锚点'), '展开区必须说明锚点来源（自报回执 / 任务标题）')
  assert.ok(source.includes('写了 feature_ids 的回执优先'), '必须写明显式声明优先于推断')
})

test('功能账空态：PRD 缺失 / 结构认不出 / 无条目 分开写', () => {
  assert.ok(source.includes("source === 'prd-missing'"), '必须处理 prd-missing')
  assert.ok(source.includes('还没有 prd.md —— 想清楚阶段会产出它'), 'PRD 缺失文案必须逐字')
  assert.ok(source.includes('prd.md  /  docs/prd.md'), 'PRD 缺失要引导到 prd.md')
  assert.ok(source.includes("strategy === 'none'"), "必须处理 strategy==='none'")
  assert.ok(source.includes('formatHint'), '必须渲染 formatHint')
  assert.ok(source.includes('dc-code-block'), 'formatHint 必须是等宽代码块')
  assert.ok(source.includes('面板不解析自由文本，只认这个结构'), '必须说明只认受控结构')
  assert.ok(source.includes('PRD 里还没有功能条目'), 'items.length===0 要有独立文案')
})

test('执行回执：右栏时间线 + 420 上限', () => {
  assert.ok(source.includes('ReceiptsTimeline'), '必须有回执时间线组件')
  assert.ok(source.includes('dc-receipts-timeline'), '回执必须是时间线容器')
  assert.ok(css.includes('max-height:420px'), '时间线必须有 420 高度上限')
  assert.ok(source.includes("h('h3', { className: 'dc-rail-title' }, '执行回执')"), '右栏标题必须是「执行回执」')
  assert.ok(source.includes('dc-timeline-summary') && source.includes('text-overflow:ellipsis'), '一句话摘要必须单行省略')
  assert.ok(source.includes('共 ${total} 条'), '时间线底部必须显示总条数')
  assert.ok(source.includes('验收复核') && source.includes('验收失效'), '审计回执要保留复核/失效细徽章')
})

test('验收清单：默认只展示需要动作的条目', () => {
  assert.ok(source.includes('acceptance.items'), '必须消费 acceptance.items')
  assert.ok(source.includes('AcceptancePanel'), '必须有验收清单组件')
  assert.ok(source.includes("const actionable = items.filter"), '必须区分需要动作的条目')
  assert.ok(source.includes('已通过 ${passedCount} 条（展开）'), '已通过条目必须折叠成一行（用 Host 全局通过数）')
  assert.ok(!source.includes("className: 'dc-acceptance'"), '验收清单不再是默认展开的 details')
  for (const button of ["'通过'", "'失败'", "'阻塞'", "'撤销'"]) {
    assert.ok(source.includes(button), `缺少操作按钮 ${button}`)
  }
  assert.ok(source.includes('dc-evidence-input'), '证据必须可编辑（行内 input）')
  assert.ok(source.includes('截图路径或 URL'), '证据输入要有 placeholder')
  // 摘要里的通过数必须用 Host 的全局真值：items 最多 100 条，截断时前端 filter 只覆盖可见项。
  assert.ok(source.includes('acceptance.passed'), '验收摘要必须用 Host 的 acceptance.passed')
  assert.ok(source.includes('Number.isFinite(passedRaw)'), '缺 acceptance.passed 时才回退本地统计')
  assert.ok(source.includes('通过必须附证据'), '点通过但没证据时必须拦下')
  assert.ok(source.includes("submit(item, null)"), '撤销必须发 result=null')
  assert.ok(source.includes('if (props.onRefresh) props.onRefresh()'), '成功后必须刷新面板')
  assert.ok(source.includes('还没有验收清单：让 Agent 用 cockpit_acceptance 起草'), '空态文案必须逐字')
  assert.ok(source.includes("props.actionKind === 'acceptance-draft'"), 'acceptance-draft 时要有指引')
})

test('验收结果错误码全部翻人话', () => {
  for (const [code, text] of [
    ['evidence-required', '通过必须附证据'],
    ['evidence-not-found', '证据文件不存在：先确认路径'],
    ['iteration-mismatch', '验收表属于别的迭代'],
    ['acceptance-broken', '验收表不是合法 JSON，先修好'],
    ['item-not-found', '这条验收项已不存在，刷新面板'],
    ['bad-result', '结果只能是 通过 / 失败 / 阻塞 / 撤销'],
    ['workspace-not-allowed', '这个工作区不在已登记列表里'],
  ]) {
    assert.ok(source.includes(code), `缺少错误码映射 ${code}`)
    assert.ok(source.includes(text), `错误码 ${code} 没翻成人话`)
  }
  assert.ok(source.includes('explainAcceptanceError'), '错误码必须收口到一个映射函数')
})

test('浏览器截图进证据：只挂证据、不改 result', () => {
  assert.ok(source.includes('${API}/acceptance-screenshot'), '必须调用 acceptance-screenshot 端点')
  assert.ok(source.includes('/shot?path='), '项目内证据缩略图必须走 /shot 接口')
  assert.ok(source.includes("window.open(src, '_blank', 'noopener')"), '点缩略图必须新标签打开')
  assert.ok(source.includes('IMAGE_EVIDENCE_RE'), '必须能识别图片证据扩展名')
  assert.ok(source.includes('dc-thumb') && source.includes('dc-thumb-more'), '必须渲染缩略图与 +N')
  assert.ok(source.includes('const shown = images.slice(0, 3)'), '缩略图最多显示 3 张')
  assert.ok(source.includes('capturing'), '必须有截图中状态')
  assert.ok(source.includes("state.capturing === true ? '截图中…' : '截图并附到证据'"), '截图按钮文案要随状态切换')
  assert.ok(source.includes('已截图并附到证据'), '成功提示文案必须逐字')
  assert.ok(source.includes('SHOT_REQUEST_TIMEOUT_MS = 90000'), '截图请求必须给 90s 超时兜底（要大于 Host 的 screenshotTimeoutMs 默认 30s）')
  // 截图 payload 里只有 path/item_id（可选 url），没有 result —— 截图不等于验收通过。
  assert.ok(source.includes('const payload = { path: props.projectPath, item_id: id }'), '截图 payload 不允许带 result')
  assert.ok(source.includes('if (url) payload.url = url'), 'url 可选')
  assert.ok(source.includes('不会自动改成「通过」'), '界面必须说明截图不改结果')
  assert.ok(source.includes('只允许本机地址（127.0.0.1 / localhost）'), '必须提示只能是回环地址')
})

test('截图错误码全部翻人话', () => {
  for (const [code, text] of [
    ['no-url', '先填预览地址（或把 previewUrl 写进 .dsh/plugin-state/project.json）'],
    ['browser-not-found', '本机没找到 Chrome/Edge，截图需要本机浏览器；也可手工把图放进项目再点「编辑」填路径'],
    ['url-not-loopback', '只允许截本机地址（127.0.0.1 / localhost）'],
    ['timeout', '截图超时：页面太慢或浏览器没起来'],
    ['capture-failed', '截图失败'],
    ['browser-failed', '截图失败'],
  ]) {
    assert.ok(source.includes(code), `缺少截图错误码映射 ${code}`)
    assert.ok(source.includes(text), `截图错误码 ${code} 没翻成人话`)
  }
  assert.ok(source.includes('explainShotError'), '截图错误码必须收口到一个映射函数')
})

test('视觉回归：shotDiffs 如实呈现、不伪造结论', () => {
  assert.ok(source.includes('shotDiffs'), '必须消费 panel.acceptance.items[].shotDiffs')
  assert.ok(source.includes('ShotDiffBadge'), '必须有视觉回归徽章组件')
  // 五种 verdict 都要有独立文案：new / same / changed / different-size / uncomparable。
  for (const text of ['新增基线', '与上一版一致', '有变化', '尺寸变了', '无法对比']) {
    assert.ok(source.includes(text), `缺少对比结论文案：${text}`)
  }
  assert.ok(source.includes('DIFF_VERDICT_TEXT'), '五种 verdict 必须收口到一个映射')
  // different-size 绝不能显示成「没变化」：文案与徽章必须是独立结论。
  assert.ok(source.includes("'different-size': '尺寸变了'"), 'different-size 必须是独立文案')
  assert.ok(source.includes('changedPixels') && source.includes('totalPixels'), '变化明细放 title，不丢信息')
  // diff 图走 /shot，30px 缩略图并新标签打开。
  assert.ok(source.includes('openEvidenceShot(diff.diffFile'), 'changed 的历史条目必须能打开 diff 图')
  assert.ok(source.includes('openEvidenceShot(latestDiff.diffFile'), '最新 changed 必须有 diff 缩略图入口')
  assert.ok(source.includes('dc-diff-thumb'), 'diff 缩略图必须有独立样式（30px）')
  assert.ok(source.includes('dc-diff-history'), '必须有最近 5 次对比的历史列表')
  assert.ok(source.includes('最近 5 次对比（最新在前）'), '历史列表标题必须说明范围与顺序')
  // 截图响应里的 comparison 要立刻用于行内提示。
  assert.ok(source.includes('body.shot && body.shot.comparison'), '截图成功必须消费 shot.comparison')
  assert.ok(source.includes('comparisonMessage(comparison)'), 'comparison 必须翻成行内提示')
  assert.ok(source.includes('与上一版有变化') && source.includes('已建立基线'), '截图提示必须区分 changed / new')
  assert.ok(source.includes('diffPercent'), '变化比例必须格式化成百分比')
})

test('视觉回归 reason 全部翻人话', () => {
  for (const [code, text] of [
    ['baseline-missing', '上一张截图文件已不在'],
    ['baseline-url', '上一版是 URL 证据，不能像素对比'],
    ['baseline-outside-project', '上一版截图在项目外，不能像素对比'],
  ]) {
    assert.ok(source.includes(code), `缺少 reason 映射 ${code}`)
    assert.ok(source.includes(text), `reason ${code} 没翻成人话`)
  }
  assert.ok(source.includes('解析失败'), '未知 reason 必须以「解析失败」兜底')
  assert.ok(source.includes('explainDiffReason'), 'reason 必须收口到一个映射函数')
})

test('验效果阶段门：截图变化让「通过」失效、必须重新确认', () => {
  assert.ok(source.includes('acceptance.stale'), '必须消费 acceptance.stale')
  assert.ok(source.includes('item.stale === true'), '必须消费 items[].stale')
  assert.ok(source.includes("item.stale === true && item.result === 'pass'"), '只有 pass + stale 才显示失效')
  assert.ok(source.includes('staleAt'), '失效时间要展示/可悬停')
  assert.ok(source.includes('已失效'), '结果列必须有「已失效」标签')
  assert.ok(source.includes('截图有变化，需重新确认'), '标签 title 必须说明原因')
  assert.ok(source.includes('截图有变化，之前那次通过已失效，请重新点「通过」确认'), '行内必须给重新确认提示')
  assert.ok(source.includes('条已失效'), '标题必须补「y 条已失效」')
  assert.ok(source.includes('dc-stale-title') && source.includes('dc-stale-tag') && source.includes('dc-stale-note'),
    '失效三处必须有独立样式（标题/标签/行内提示）')
  assert.ok(source.includes('body.shot && body.shot.invalidated'), '截图成功必须消费 shot.invalidated')
  assert.ok(source.includes('该条验收已失效，请重新点「通过」'), 'invalidated 时必须强提示重新确认')
  assert.ok(source.includes('receiptId') && source.includes('已写入回执'), '失效回执 id 要显示出来（可追溯）')
  assert.ok(source.includes('验收复核') && source.includes('验收失效'), '账本审计回执要能区分复核/失效')
  // 失效 ≠ 改结果：stale 分支不能改 result，重新确认仍走原有四个按钮。
  assert.ok(!/stale:\s*false[\s\S]{0,80}result:/.test(source), '前端不得用 stale 分支改写 result')
})

test('降级矩阵：横幅、坏行、缺失能力', () => {
  assert.match(source, /panel\.degraded\.flag/, '必须消费 degraded.flag')
  assert.ok(source.includes('degradedReasons'), '降级横幅要列原因')
  assert.ok(source.includes('账本存在损坏行（已降级显示）'), '坏行提示文案必须逐字')
  assert.ok(source.includes('missingBlocks'), '必须消费 nextAction.missing')
  assert.ok(source.includes('暂不下发指令'), '能力缺失时显示缺失文案而不是指令')
  assert.ok(source.includes('disabledReason'), '主按钮禁用要给出原因')
})

test('原型批准（Phase 1 门禁）', () => {
  assert.ok(source.includes("action.kind === 'prototype'"), 'kind=prototype 时必须出现通过原型按钮')
  assert.ok(source.includes('通过原型'), '缺少「通过原型」按钮')
  assert.ok(source.includes('已于'), 'approved 时必须是只读的已通过状态')
  assert.ok(source.includes('prototype-missing'), '必须识别 prototype-missing 错误码')
  assert.ok(source.includes('先把原型 HTML 放到项目根目录 prototype.html'), 'prototype-missing 要翻成人话')
  assert.ok(source.includes('iteration-required'), '必须识别 iteration-required 错误码')
})

test('初始化：先计划后执行', () => {
  assert.ok(source.includes('/init-plan?path='), '初始化必须先请求 init-plan')
  assert.ok(source.includes('确认写入并初始化'), '必须有人工确认按钮')
  assert.ok(source.includes('onApplied'), '成功后要刷新面板')
})

test('空态 / 加载态 / 错误态 / ErrorBoundary', () => {
  assert.ok(source.includes('还没有项目工作区'), '缺少总览空态')
  assert.ok(source.includes('还没有回执'), '缺少账本空态')
  assert.ok(source.includes('正在加载'), '缺少加载态')
  assert.ok(source.includes('重试'), '错误态必须能重试')
  assert.ok(source.includes('getDerivedStateFromError'), '必须有 ErrorBoundary')
  assert.ok(source.includes('面板渲染失败'), 'ErrorBoundary 要有可读兜底')
})

test('账本与人话状态映射', () => {
  for (const text of ['进行中', '已完成', '被卡住', '失败', '已放弃']) {
    assert.ok(source.includes(text), `缺少状态中文：${text}`)
  }
  for (const stage of ['初始化', '搭骨架', '想清楚', '看原型', '写代码', '挑毛病', '验效果', '发出去']) {
    assert.ok(source.includes(stage), `缺少阶段中文：${stage}`)
  }
  assert.ok(source.includes('待你决策'), '待决策必须置顶显示')
})

test('视觉体系：排版、按钮、focus、动效、骨架屏、双主题', () => {
  assert.ok(css.length > 8000, `样式改版后仍应完整（${css.length} 字符）`)
  // 两栏外壳：1180 页宽；hero 20px 是唯一大字号内容、正文 13px。
  assert.ok(css.includes('max-width:1180px'), '页面必须是 1180px 两栏外壳')
  assert.ok(css.includes('font-size:20px'), 'hero 标题必须用 20px 层级')
  assert.ok(css.includes('font-size:13px'), '正文必须 13px')
  assert.ok(css.includes('line-height:1.6'), '正文行高必须 1.6')
  // 数字等宽与右对齐。
  assert.ok(css.includes('font-variant-numeric:tabular-nums'), '数字必须等宽')
  assert.ok(css.includes('.dc-num'), '数字列必须有右对齐类')
  assert.ok(css.includes('text-align:right'), '数字列必须右对齐')
  // 统一 focus ring。
  assert.ok(css.includes(':focus-visible'), '必须有统一 focus 样式')
  assert.ok(css.includes('outline:2px solid var(--dsw-alias-brand-primary)'), 'focus ring 必须用 accent token')
  assert.ok(css.includes('outline-offset:2px'), 'focus ring 必须留 offset')
  // 按钮体系：30px 高、radius 8、disabled 有态。
  assert.ok(css.includes('height:30px') && css.includes('border-radius:8px'), '按钮必须统一 30px/8px')
  assert.ok(css.includes(':disabled'), '按钮必须有 disabled 态')
  // 动效 + reduced motion。
  assert.ok(css.includes('ease-out'), '状态变化必须 ease-out')
  assert.ok(css.includes('prefers-reduced-motion: reduce'), '必须尊重 reduced-motion')
  // 骨架屏（3 行）而不是转圈。
  assert.ok(source.includes('dc-skel dc-skel-line'), '加载态必须有骨架行')
  assert.ok((source.match(/dc-skel dc-skel-card/g) || []).length >= 6, '每处加载态至少 3 行骨架')
  assert.ok(!source.includes('dc-spinner'), '不要转圈加载')
  // 深色主题由预览 harness 打标，client.js 只消费 token。
  assert.ok(previewServer.includes('html[data-theme="dark"]'), '预览必须提供深色 token 覆盖')
  assert.ok(previewServer.includes("get('theme') === 'dark'"), '?theme=dark 必须能切换主题')
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'client 样式不得出现硬编码十六进制色')
  assert.ok(!/(?:rgba?|hsla?)\(/.test(css), 'client 样式不得出现硬编码 rgb/hsl 色')
  // 区标题去序列号；② 是唯一 surface 焦点面。
  assert.ok(source.includes("className: 'dc-card dc-hero'"), '唯一下一步必须是唯一 surface（dc-hero）')
  assert.ok(css.includes('.dc-hero') && css.includes('background:var(--dsw-alias-bg-layer-1)'), 'hero 必须用 layer-1 底')
  // 窄屏表格改为堆叠块（不是横滚切片）。
  assert.ok(css.includes('.dc-table thead { display:none; }'), '窄屏表头必须隐藏（堆叠布局）')
  assert.ok(css.includes('content:attr(data-label)'), '窄屏堆叠必须用 data-label 做行标签')
  assert.ok(source.includes("'data-label': '状态'"), '功能行必须带 data-label')
  assert.ok(source.includes("'data-label': '操作'"), '验收操作列必须带 data-label')
  // 缩略图 28px + hover/focus accent。
  assert.ok(css.includes('width:28px; height:28px'), '证据缩略图必须 28px')
  assert.ok(css.includes('.dc-thumb:hover') && css.includes('.dc-thumb:focus-visible'), '缩略图必须有 hover/focus accent')
  // stale 警示框用 layer-1 底 + warn 边框 + 主色文字（两套主题可读）。
  assert.ok(css.includes('.dc-stale-note') && css.includes('background:var(--dsw-alias-bg-layer-1)'), 'stale 提示必须用 layer-1 底')
  // 总览箭头 hover 位移。
  assert.ok(source.includes('dc-ws-enter'), '总览卡片必须有箭头位移元素')
  assert.ok(css.includes('.dc-ws-card:hover .dc-ws-enter'), '总览箭头必须在 hover 时右移')
})

test('两栏布局：容器查询 / 摘要条 / 右栏 sticky / 信息降噪', () => {
  assert.ok(css.includes('container-type:inline-size'), '必须用容器查询而不是窗口 media query')
  assert.ok(css.includes('@container (min-width:1170px)'), '两栏断点必须是 1170px 容器查询（主区 ≥830 才放得下 820 的验收表）')
  assert.ok(!/@container \(min-width:880px\)/.test(css), '不得再有两栏 880 断点（会与主区堆叠混排）')
  assert.ok(!/@container \(min-width:1040px\)/.test(css), '1040 两栏会与主区 ≤700 堆叠在 1040 处相交，产生混合态')
  assert.ok(css.includes('@container (max-width:700px)'), '表格堆叠必须只在主区 ≤700 时触发')
  assert.ok(css.includes('grid-template-columns:minmax(0,1fr) 280px'), '两栏必须是主区 + 280px 右栏')
  assert.ok(css.includes('.dc-rail { position:sticky; top:106px; z-index:2; }'), '右栏必须在 ≥1040 时 sticky 于 106px（header 59 + 摘要 46）')
  assert.ok(css.includes('.dc-summary-bar {') && css.includes('position:sticky; top:59px'), '摘要条必须随 header 常驻')
  assert.ok(source.includes('SummaryBar') && source.includes('dc-summary-bar'), '必须有摘要条')
  assert.ok(source.includes("title: '未处置的审核 blocking，含未归属'"), '缺陷统计必须有 tooltip 说明口径')
  assert.ok(source.includes('dc-rail-severe') && source.includes('没有未处置阻塞'), '右栏必须有「最严重」一行或空文案')
  assert.ok(source.includes('mostSevereIssue'), '最严重一条必须从已有 review/features 数据挑，不新造')
  // 信息不能因为重排被丢掉：回执写失败、功能账提示（含截断）都要有出口。
  assert.ok(source.includes('receiptWarning'), '截图失效留痕写失败必须如实显示，不能只显示"已截图"')
  assert.ok(source.includes('props.features && props.features.notes'), '功能账 notes（含截断告警）必须迁移到右栏数据提示')
  assert.ok(css.includes('height:3px'), '摘要条必须有 3px 功能进度条')
  assert.ok(source.includes('dc-cold-inline') && source.includes('coldAllDone'), '冷启动完成时必须压成一行')
  assert.ok(!source.includes("className: 'dc-facts'"), '区③ 2×2 元信息必须删除')
  assert.ok(!source.includes('状态按三路证据推导'), '功能账下方重复小字说明必须删除')
  // 验收默认只列需要动作的条目，已通过折叠。
  assert.ok(source.includes('const cleanPassed = items.filter'), '必须区分已通过条目')
  assert.ok(source.includes('已通过 ${passedCount} 条（展开）'), '已通过必须折叠成一行')
  // 总览标题行加项目数元信息。
  assert.ok(source.includes('共 ${projects.length} 个项目'), '总览标题行必须显示项目数')
})


