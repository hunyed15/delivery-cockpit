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

test('一屏四区与底部状态', () => {
  for (const title of ['① 项目名片 & 迭代头', '② 唯一下一步', '③ 迭代进度', '④ 功能账 & 缺陷账']) {
    assert.ok(source.includes(title), `缺少区域标题：${title}`)
  }
  for (const text of ['上次回执', '引擎正常', '数据待确认', '主会话活跃']) {
    assert.ok(source.includes(text), `缺少底部状态文案：${text}`)
  }
  assert.ok(source.includes('coldStart') && source.includes('cycle'), '进度必须消费 progression.coldStart/cycle')
  assert.ok(source.includes('stageId === highlightId'), '当前阶段必须有且只有一个强高亮')
})

test('功能进度独立于阶段门', () => {
  assert.ok(source.includes('features.progress'), '必须消费 features.progress')
  assert.ok(source.includes("'功能进度'"), '区③ 必须有「功能进度」标签')
  assert.ok(source.includes("featureTotal > 0 ? `${featureDone}/${featureTotal}` : '—'"),
    'total===0 时功能进度必须显示 —')
  assert.ok(source.includes('dc-progress-row'), '功能进度必须是独立一条，不混进阶段轨道')
})

test('功能账表格：三路证据如实呈现', () => {
  assert.ok(source.includes('features.items'), '必须消费 features.items')
  assert.ok(source.includes('FeatureBoardSection'), '必须有功能账区组件')
  for (const text of ['已完成', '有阻塞', '进行中', '待验收', '未开始', '—']) {
    assert.ok(source.includes(text), `缺少功能状态文案：${text}`)
  }
  assert.ok(source.includes('statusLabel'), '状态必须优先使用 Host 下发的 statusLabel')
  for (const header of ["'功能'", "'状态'", "'待修'", "'验收'", "'最近进展'"]) {
    assert.ok(source.includes(`h('th', { scope: 'col' }, ${header})`), `缺少表头 ${header}`)
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

test('执行回执退到折叠区（默认折叠）', () => {
  assert.ok(source.includes('dc-receipts'), '回执必须有独立折叠区')
  assert.ok(source.includes('执行回执（'), '折叠标题必须是「执行回执（N 条）」')
  assert.ok(source.includes('条）'), '折叠标题必须带条数')
  // 回执区不能默认展开：details 上不能带 open。
  assert.ok(!/h\('details',\s*\{\s*className:\s*'dc-receipts',\s*open:/.test(source), '回执区默认不得展开')
  assert.ok(source.includes("h('summary', null, `执行回执"), '回执折叠区必须有 summary')
})

test('验收清单：面板内可点记录结果', () => {
  assert.ok(source.includes('acceptance.items'), '必须消费 acceptance.items')
  assert.ok(source.includes('AcceptancePanel'), '必须有验收清单组件')
  assert.ok(source.includes('验收清单（') && source.includes('条 · ') && source.includes('已通过'),
    '验收清单标题必须带「N 条 · x 已通过」')
  assert.ok(source.includes('dc-acceptance') && source.includes('open: true'), '验收清单必须默认展开')
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
