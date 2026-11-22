# Design

<!-- impeccable:design-system 1 -->

Operate 表面（DSH 内的交付驾驶舱面板）。视觉目标：**安静的仪表盘工艺**——信息密度服务扫读，层级靠字号/留白/字重，不靠装饰。深色/浅色同源 token。

## 1. 世界与模式

- 模式：**Operate**（用户带着任务打开：看清下一步、功能进度、验收状态、卡点）。
- 视觉权威：**DSH 主题 token**（`--dsw-alias-*`）。不引入自有品牌色、不引外部字体、不用装饰性插画。
- 全页只有**两个 surface**：主区的「唯一下一步」hero，以及右侧状态栏（审核账本 + 执行回执）。其它区域保持 flat（hairline + 留白），不许再套卡片。


## 2. 布局（模块化工作台）

信息架构参考成熟 SaaS 看板（GitHub 仓库页：主区 2/3 + 右栏 1/3；Linear：常驻属性栏；Vercel/Sentry：顶部指标条 + 主区）。**不是一条长单栏流水账。**

```
[sticky header：← 全部项目 | 项目名 | 健康摘要 | 迭代 | 密度/快捷键/服务/刷新]
[摘要条：一个模块，5 组指标 + 竖分隔线 + 4px 进度条]
┌ 主区 minmax(0,1fr) ──────────────────┐ ┌ 右栏 280px（sticky）──────────┐
│ 下一步（hero 模块，brand tint）        │ │ 需要你决定（有才显示）        │
│ 项目进度（模块）                       │ │ 代码检查（模块）              │
│ 功能（模块，行可展开）                 │ │ 项目动态（模块，时间线分组）  │
│ 验收（模块，默认极简）                 │ │ 数据说明（模块，折叠）        │
│ 没归到功能的待修问题（有才显示）       │ └──────────────────────────────┘
└──────────────────────────────────────┘
```

- **模块系统**（解决"白底+粗字"）：每个区块 = `.dc-module`（画布上的卡片）。
  - 画布 `bg-layer-1`；模块卡 `bg-layer-2` + 1px `border-l1` + radius 12；
  - 模块头 `.dc-module-head` 高 42px（紧凑 36）：`bg-layer-1` 条纹 + 底部 1px 边 + 16px inline SVG 图标 + 标题 13/600 + 右侧 meta 11.5/500；
  - 模块体 padding 16px（紧凑 12）；主区模块间距 16px、右栏模块间距 12px；**不再用区级分隔线**，层次由卡片表面表达。
- hero 是唯一强调模块：`brand 6%` 混合底 + `brand 28%` 边框，标题 22/700（全页唯一 22px）。
- 断点用**容器查询**（`.dc-root { container-type: inline-size; }`），不用 media query（面板宽度 = 窗口 − DSH 侧栏）：
  - `≥1170px`：两栏（主区 ≥830 + 右栏 280 + gap 20）——主区必须放得下验收表的最小宽 820；
  - `741–1169px`：单栏，模块全宽；
  - `≤740px`：单栏，模块间距 12、模块体 padding 12、行堆叠为块，页面零横向溢出。
- sticky 叠层：header `top:0 z:5`；摘要模块 `top:71px z:4`（仅 ≥641 常驻）；右栏 `top:118px z:2`。三层不互相遮挡。
- 摘要条：一个模块，5 组指标（已完成功能 / 验收通过 / 待修问题 / 需要重新确认 / 需要你决定）用 1px 竖分隔线隔开，label 11.5/500 次要色、value 14/700，4px 进度条在最右。
- 右栏「代码检查」在计数之外给**最严重一条**（critical > important > minor，`[严重] 标题 · file:line`，单行 ellipsis + title）；只有计数没明细时如实写"明细未提供"。
- 项目动态按**今天 / 本周 / 更早**分组（本地日历日、周一为周首；空组不渲染），每组 `role="group"` + `aria-label`。
- 主区 `.dc-body` `max-width: 1180px`；页脚移除；已通过的验收折叠成「已经通过 N 条（展开）」；重复小字说明能删则删。
## 2.5 信息架构：Answer-first（给人读状态）

界面的第一职责是让人 10 秒内回答「现在怎么样、我该做什么」，不是把数据摆全。

- **header**：项目名 + **一句人话摘要**（如「正在看原型 · 3 个待修问题 · 验收通过 1/6」）+ 迭代标签 + 服务状态点 + 刷新。
- **hero「现在要做的下一件事」**：步骤上下文（第 2 步 / 共 6 步）→ 动作标题（20px）→ 一句为什么 → 「复制给 AI」（唯一实心主按钮）+ 次按钮。
- **摘要条**：五个**带完整标签**的指标（已完成功能 x/y、验收通过 x/y、待修问题 N、需要重新确认 N、需要你决定 N）+ 细进度条；不做无标签的裸数字。
- **项目进度**：一句人话状态（「冷启动已完成，现在在「看原型」」）+ 人话 stepper。
- **功能**：列表行而不是表头表格。每行 = 名称（14/600）+ 人话状态 pill + 验收进度 + 最近动态；整行可点/Enter 展开「细节」，编号、文件路径、卡点明细（severity/file:line）、统计来源都只在细节里。
- **验收**：默认行 = 验收点 + 结果人话 + 一句提示 + 就近操作；证据/截图/对比/历史/路径全部收进「细节 ▸」；已通过的折叠成「已经通过 N 条（展开）」。
- **右栏**：`需要你决定`（有才显示）→ `代码检查`（一句结论 + 最严重一条）→ `项目动态`（时间线，人话）→ `数据说明`（折叠）。
- 技术信息不是删除，而是**降级到细节**：FR 编号、路径、file:line、像素比例、证据清单，展开可查、tooltip 可见。

## 2.6 空态与首次使用（给人下一步，不给"暂无数据"）

统一 `EmptyState`：标题（发生了什么）+ 一句原因 + **一个真的能用的动作** + 可选「细节」折叠（技术信息）。
- PRD 缺失：「还没有 PRD，所以列不出功能」→「复制下一步指令」（滚动到 hero 并聚焦复制按钮，**不自动复制**）。
- PRD 认不出结构：「PRD 里没有 `### FR-N` 结构」→ 同上 + 格式提示在细节里。
- 验收空：「还没有验收条目」→ 当前是 `acceptance-draft` 时给「复制起草指令」，否则说清「验效果阶段会起草」。
- 无动态：「项目还没有动态」+「AI 每完成一步会记一条，你不需要手写」。
- 未初始化：「项目还没初始化」+「初始化此项目」（沿用 init 流程）。

## 2.7 联动与定位（别让人手工找）

- 功能展开「细节」里列该功能的验收条目（`featureRef` 匹配），每条带「去验收」：滚动到验收行、聚焦、2 秒背景高亮（`dc-acc-flash`，不影响布局）。
- 验收行有稳定锚点（`data-acc-id`、`tabIndex=-1`），跳转后焦点落在该行，键盘可继续操作。
- 项目动态按**今天 / 本周 / 更早**分组（本地日历日、周一为周首；空组不渲染），每组 `role="group"` + `aria-label`。

## 3. 文案：说人话

非技术创始人读得懂是第一要求；专业词只在被告知的细节里出现。

| 内部词 | 界面词 |
|---|---|
| 引擎正常 / 账本健康 | 服务正常 |
| 功能账 / 缺陷账 | 功能 / 待修问题 |
| 阻塞（计数） | 卡点（"有 2 个卡点"） |
| 阻塞（验收结果） | 卡住了 |
| 失败（验收） | 没通过 |
| 未验 | 还没验 |
| 失效 / 已失效 | 需要重新确认 |
| 回执 / 执行回执 | 项目动态 |
| 审核账本 / 门禁 | 代码检查 / 检查通过 |
| 未归属缺陷 | 没归到功能的待修问题 |
| 待决策 | 需要你决定 |
| 对比 / diff | 和上一版比 / 看变化 |
| FR-1、路径、百分比 | 只进「细节」或 tooltip |

规则：错误文案必须说清「问题 + 怎么恢复」；按钮用动词；数字必须带名词（"验收通过 1/6"而不是"1/6"）；不用"暂无数据"。

## 4. 字体



单系统 sans（中文回退系统字体），固定 rem 阶梯，不用 fluid/clamp：

| 角色 | 尺寸/字重 |
|---|---|
| 页面唯一大标题（下一步） | 20px / 650 |
| 区标题 | 13px / 600 |
| 正文、表格、按钮 | 13px / 500–600 |
| 次要信息（说明、元信息值） | 12px / 500 |
| 元信息标签、表头 | 11px / 600，`letter-spacing: .04em` |

- 所有数字 `font-variant-numeric: tabular-nums`；计数列右对齐。
- 行高：正文 1.6，表格行高 ≥44px，标题 1.25。
- 不用 display 字体、不用渐变文字、不用等宽字体装"技术感"（只有代码/路径用 `font-family: ui-monospace`）。

## 5. 颜色

只使用 token；client CSS 内**不允许出现 hex/rgb/hsl 字面值**。

- 分层（模块化工作台）：**画布** `bg-layer-1` → **模块卡** `bg-layer-2` → **模块头** `bg-layer-1` 条纹；代码块/展开细节/空态虚线框 `bg-layer-1` + 1px 边；hero 例外：`brand 6%` 混合底 + `brand 28%` 边框。
- 线：`border-l1`（常规 hairline）/ `border-l2`（强调分隔、输入聚焦底）。
- 字：`label-primary` / `label-secondary`；禁用 `opacity: .5`。
- 主色 `brand-primary` 只用于：主按钮、当前步骤、focus ring、链接、选中态。
- **状态色体系（tone）**：`brand / success / warn / error / idle` 五个 token 色，界面任何"语义色"都从这五个里选，不新造色：
  - 模块头图标：24×24 圆角 6 底片 = `color-mix(tone 10%)`，图标 `color:tone`；idle 用 layer-1 底 + 次要色图标。
  - 模块 tone 语义：下一步/项目动态=brand；项目进度（全完成=success，否则 brand）；功能（有卡点=warn，全完成=success，否则 brand）；验收（失败=error，待确认/卡住=warn，全过=success，空=idle）；待修问题=error；代码检查=success/warn/idle；数据说明=warn/idle；需要你决定=warn。
  - 摘要数字按语义上色：待修问题 >0 error；需要重新确认 >0 warn；需要你决定 >0 warn；已完成功能全完成 success、否则 brand；验收通过 有失败 error、待确认 warn、全过 success、否则 brand；无值保持 primary（不要全彩）。
  - hero 顶部 4px 阶段色带：轨道 layer-2，填充 `(当前步骤+1)/总步数` brand；`decide` 状态整条 warn；`aria-hidden`。
  - 功能行 3px 细进度条（60px，紧凑 48/360 40）：验收通过比例，全过 success、部分 brand、空轨 layer-2；无验收条目不渲染；`aria-hidden`，朗读交给旁边文字。

- 状态色只给状态（成功/警告/错误/进行中），且**永远配文字**，不单靠颜色：
  - pass/已完成 = success；fail/阻塞 = error/warn；stale = warn + 「已失效」文字；未开始 = 中性。
  - 状态 pill = 6px 圆点 + 文字（弱底 + 1px 边框），不用大面积高饱和块。
- 深色：同一份 client CSS，预览 harness 用 `html[data-theme="dark"]` 覆盖同一批 token（`?theme=dark`）。深色下 hero surface、warn 框、状态 pill 必须逐一验证可读。

## 6. 组件

- **Module**（所有区块的统一容器）：`.dc-module`（卡片，layer-2 + 1px 边 + 12 圆角）→ `.dc-module-head`（42px，layer-1 条纹，16px inline SVG 图标 + 标题 13/600 + 右侧 meta 11.5/500，meta 支持 ok/warn/unknown 状态色）→ `.dc-module-body`（padding 16）。Module 透传未知属性（role/aria-* 不被容器吞掉）；右栏模块标题用 h3。
- **图标**：8 个 authored inline SVG（next / progress / feature / acceptance / defects / review / receipts / info），16×16、stroke 1.6、currentColor、aria-hidden，只出现在模块头与空态。

- **按钮三档**，统一高 30px、radius 8px、padding 0 12px、13px/600：
  - `primary`：brand 填充，hover 深一档，active 下沉 1px；每屏只允许一个（hero 里的「复制指令」）。
  - `secondary`：透明底 + 1px `border-l2`，hover `bg-layer-1`。
  - `quiet`：无边框文字按钮；危险动作（撤销）用 error 色文字、无填充。
  - disabled：`opacity:.5` + `cursor:not-allowed`。
- **输入**：1px `border-l1`、radius 8、高 30px；focus 用 brand 边框 + 2px ring。
- **状态 pill**：见 §4。
- **stepper**：一条连续轨道 + 节点；已完成=实心 brand 圆点 + 勾，当前=brand 环 + 标签 600，未开始=空心中性；节点文案 11–12px。
- **表格**：表头 11px/600 次要色 + `bg-layer-1`；行 hover `bg-layer-1`；第一列主信息 13/600；其余 13；数字右对齐。
- **缩略图**：28px、radius 4、1px hairline、`object-fit: cover`；hover/focus accent 外环；`+N` 与缩略图基线对齐。
- **hero surface**：唯一卡片；`bg-layer-1` + 1px border-l1 + radius 12 + 20px padding；标题 20px 是页面唯一大字号。
- **空态/错误态**：居中窄块（max 420px），一句话说清 + 一个动作（重试/去 prd.md/初始化）；不写"暂无数据"。
- **加载骨架**：3 行灰块骨架，不用居中 spinner。

## 7. 状态与反馈

每个交互组件必须齐：default / hover / focus-visible / active / disabled / loading / error。
- 写动作成功/失败给行内反馈（不弹 alert）；失败保留用户输入。
- 截图/验收/批准等长动作有进行中文案与禁用态。
- 降级横幅保留数据原因，不许隐藏。

## 8. 动效

- 只做状态变化：hover 背景/边框、展开折叠、箭头位移，120–160ms `cubic-bezier(.2,.6,.3,1)`。
- 不做页面入场编排、不做装饰性动效；`@media (prefers-reduced-motion: reduce)` 全部关闭。

## 9. 可访问性

- 所有可点元素可 Tab 到；`:focus-visible` 2px brand 环 + offset 2px；跳转/展开后焦点落到目标行。
- 键盘：`j`/`k` 在功能行与验收行之间移动（回绕）、`Enter` 展开/收起、`Esc` 逐层收起后回顶部、`?` 打开快捷键说明；输入框/可编辑区域内不劫持；行标 `aria-keyshortcuts`；监听随组件卸载清理。
- 正文对比度 ≥4.5:1；状态不只靠颜色；表格有表头、按钮有明确文案。
- 代码块/路径用等宽字体但保持 13px；长路径可换行不溢出。
- 密度切换（舒适/紧凑）用 `aria-pressed` 两态按钮，选择持久化；`localStorage` 不可用时降级为不记忆而不是报错。

## 10. 明确不做（anti-patterns）

- 卡片套卡片、每区一张同款卡片。
- 圆圈/方形段落序号（①②③④ 已删）。
- 彩色左边框、零偏移彩色阴影、渐变文字、玻璃拟态装饰。
- 用色块面积表达状态（用 pill + 文字）。
- 表格里塞图标代替文字标签。

## 11. 验证基线

- 预览 harness（`tools/preview`）截图：`style-1200.png`（模块化两栏）、`style-dark.png`（深色三层）、`style-360.png`、`style-compact.png`、`style-details.png`、`style-empty.png`、`style-overview.png`；状态色加码：`accent-1200.png`、`accent-dark.png`、`accent-360.png`、`accent-compact.png`、`accent-status.png`（error/warn/success 底片）、`accent-hero.png`（色带）、`accent-features.png`（进度条三态）；可用性轮补充：`goal-empty-prd.png`、`goal-empty-acceptance.png`、`goal-empty-receipts.png`、`goal-feature-link.png`、`goal-timeline-groups.png`、`goal-compact.png`、`goal-keyboard.png`、`goal-360.png`、`goal-dark.png`。
- 360 宽：`docScrollWidth = 360`、`offenders = []`；行自动堆叠。
- 断点：容器 ≥1170 两栏、741–1169 单栏、≤740 主区 ≤700 堆叠；无混合态。
- sticky：滚动后 header 0 / 摘要条贴 header / 右栏不遮挡。
- `test/client-smoke.test.js` 覆盖：旧词表清零 + 新词齐备、header 摘要、hero Answer-first、功能行可展开（`aria-expanded`）、验收默认极简（比例/证据只在细节）、右栏三块、断点/sticky、token-only、双主题、字号/等宽数字/focus/reduced-motion/骨架屏。

