# Design

<!-- impeccable:design-system 1 -->

Operate 表面（DSH 内的交付驾驶舱面板）。视觉目标：**安静的仪表盘工艺**——信息密度服务扫读，层级靠字号/留白/字重，不靠装饰。深色/浅色同源 token。

## 1. 世界与模式

- 模式：**Operate**（用户带着任务打开：看清下一步、功能进度、验收状态、卡点）。
- 视觉权威：**DSH 主题 token**（`--dsw-alias-*`）。不引入自有品牌色、不引外部字体、不用装饰性插画。
- 全页只有**两个 surface**：主区的「唯一下一步」hero，以及右侧状态栏（审核账本 + 执行回执）。其它区域保持 flat（hairline + 留白），不许再套卡片。


## 2. 布局（两栏看板）

信息架构参考成熟 SaaS 看板（GitHub 仓库页：主区 2/3 + 右栏 1/3；Linear：常驻属性栏；Vercel/Sentry：顶部指标条 + 主区）。**不是一条长单栏流水账。**

```
[sticky header：← 全部项目 | 项目名 | 健康 chip | 迭代 chip | 更新于 | 刷新]
[sticky 摘要条：功能 1/5 · 验收 1/6 · 缺陷 3 · 失效 1 · 待决策 0 + 细进度条]
┌ 主区 minmax(0,1fr) ──────────────────┐ ┌ 右栏 280px（sticky）──────────┐
│ 下一步（唯一 hero surface）           │ │ 待决策（有才显示）            │
│ 迭代进度（stepper + 冷启动压一行）     │ │ 审核账本（计数 + 最严重一行）  │
│ 功能账 & 缺陷账（表格）                │ │ 执行回执（时间线，max-h 420）  │
│ 验收清单（未决优先，已通过折叠）       │ │ 数据提示/警告（折叠）          │
│ 未归属缺陷（有才显示）                 │ └──────────────────────────────┘
└──────────────────────────────────────┘
```

- 断点用**容器查询**（`.dc-root { container-type: inline-size; }`），不用 media query（面板宽度 = 窗口 − DSH 侧栏）：
  - `≥1170px`：两栏（主区 ≥830 + 右栏 280 + gap 20）——主区必须放得下验收表的最小宽 820，否则会内部横滚；
  - `741–1169px`：单栏，表格保持表格；
  - `≤740px`（主区 ≤700）：单栏，功能账/验收清单**堆叠为块**（`data-label`），页面零横向溢出。
- **不允许混合态**：两栏与堆叠的边界必须错开（两栏时主区 ≥830 > 700，不可能触发堆叠）；出现"两栏 + 堆叠表格"说明断点没对齐。

- sticky 叠层：header `top:0 z:5`；摘要条 `top:59px z:4`（仅 ≥641 常驻）；右栏 `top:106px z:2`。三层不互相遮挡。
- 摘要条五项：`功能 x/y`、`验收 x/y`、`缺陷 N`（未处置审核 blocking，含未归属，title 说明）、`失效 N`、`待决策 0/1` + 3px 功能进度条；数字 tabular、状态色只在非 0 时用。
- 右栏「审核账本」在计数之外给**最严重一条**（critical > important > minor，`[严重] 标题 · file:line`，单行 ellipsis + title）；只有计数没明细时如实写"明细未提供"。

- 主区 `.dc-body` `max-width: 1180px`；页脚移除（header 已含更新与刷新，上次回执并进右栏标题行）。
- 右栏是**一个面板**（layer-1 + 1px border + radius 12 + 16px padding），内部分组用 1px 分隔线，不套多张卡。
- 降噪：冷启动两项都完成时压成一行；进度区不再放 2×2 元信息（归入摘要条/右栏）；已通过的验收折叠成一行「已通过 N 条（展开）」；重复的小字说明能删则删。


## 3. 字体

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

## 4. 颜色

只使用 token；client CSS 内**不允许出现 hex/rgb/hsl 字面值**。

- 底：`bg-base`（页面）/ `bg-layer-1`（hero surface、行 hover、代码块）/ `bg-layer-2`（弱底）。
- 线：`border-l1`（常规 hairline）/ `border-l2`（强调分隔、输入聚焦底）。
- 字：`label-primary` / `label-secondary`；禁用 `opacity: .5`。
- 主色 `brand-primary` 只用于：主按钮、当前步骤、focus ring、链接、选中态。
- 状态色只给状态（成功/警告/错误/进行中），且**永远配文字**，不单靠颜色：
  - pass/已完成 = success；fail/阻塞 = error/warn；stale = warn + 「已失效」文字；未开始 = 中性。
  - 状态 pill = 6px 圆点 + 文字（弱底 + 1px 边框），不用大面积高饱和块。
- 深色：同一份 client CSS，预览 harness 用 `html[data-theme="dark"]` 覆盖同一批 token（`?theme=dark`）。深色下 hero surface、warn 框、状态 pill 必须逐一验证可读。

## 5. 组件

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

## 6. 状态与反馈

每个交互组件必须齐：default / hover / focus-visible / active / disabled / loading / error。
- 写动作成功/失败给行内反馈（不弹 alert）；失败保留用户输入。
- 截图/验收/批准等长动作有进行中文案与禁用态。
- 降级横幅保留数据原因，不许隐藏。

## 7. 动效

- 只做状态变化：hover 背景/边框、展开折叠、箭头位移，120–160ms `cubic-bezier(.2,.6,.3,1)`。
- 不做页面入场编排、不做装饰性动效；`@media (prefers-reduced-motion: reduce)` 全部关闭。

## 8. 可访问性

- 所有可点元素可 Tab 到；`:focus-visible` 2px brand 环 + offset 2px。
- 正文对比度 ≥4.5:1；状态不只靠颜色；表格有表头、按钮有明确文案。
- 代码块/路径用等宽字体但保持 13px；长路径可换行不溢出。

## 9. 明确不做（anti-patterns）

- 卡片套卡片、每区一张同款卡片。
- 圆圈/方形段落序号（①②③④ 已删）。
- 彩色左边框、零偏移彩色阴影、渐变文字、玻璃拟态装饰。
- 用色块面积表达状态（用 pill + 文字）。
- 表格里塞图标代替文字标签。

## 10. 验证基线

- 预览 harness（`tools/preview`）截图：`layout-1200.png`（两栏）、`layout-1000.png` / `layout-900.png`（单栏+表格）、`layout-700.png` / `layout-360.png`（单栏+堆叠）、`layout-dark.png`，以及 `redesign-features.png` / `redesign-acceptance.png` / `redesign-stale.png` / `redesign-overview.png` / `redesign-empty.png` / `redesign-error.png`。
- 断点实测：1200 两栏、1000/900 单栏且表格仍是表格（**不允许两栏+堆叠混合态**）、700/360 堆叠。
- `360` 宽：`docScrollWidth = 360`、`offenders = []`。
- sticky：滚动时 header + 摘要条常驻、右栏不遮挡内容。
- `test/client-smoke.test.js` 覆盖：token-only、tabular-nums、focus-visible、reduced-motion、骨架屏、错误重试、窄屏堆叠、hero surface、右栏 sticky、摘要条、断点一致性、深色 token。
