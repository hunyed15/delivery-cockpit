# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

现有代码：DSH 插件（Host 半 + Client 半），客户端是裸 React（`h()`）+ Host 主题 token（`--dsw-alias-*`），无构建步骤、无 UI 依赖。不引入设计系统依赖。

## Users

非技术创始人 / 独立开发者，在 DSH（DeepSeek Harness）里用 AI 交付产品。他们打开驾驶舱的典型时刻：想知道「做到哪了、卡在哪、谁在干、下一步做什么」；不想读代码、不想翻 JSONL。

## Product Purpose

把项目真实状态收拢成一屏：项目名片、唯一下一步、迭代进度与功能账、人话账本（验收/缺陷/回执）。成功 = 人能在 10 秒内知道下一步做什么、哪些功能没完成、卡在哪。

## Positioning

不是又一个任务看板：它从 Agent 的执行证据（回执、验收、审核账本）里**推导**状态，而不是让人手工维护看板；并且**绝不造假**——读不到就显示 `—` / 缺失原因。

## Operating Context

- 在 DSH 面板里打开（侧栏「交付」入口），旁边是 Agent 对话。
- 数据源：`.dsh/plugin-state/`（project.json / acceptance.json / receipts.jsonl / approvals.json）、`docs/prd.md`、`.trellis/tasks`、审核账本。
- 高频动作：看下一步 → 复制指令 / 发送到对话；验效果阶段点验收结果、截图对比。
- 屏幕：桌面为主（1200–1600），窄到 360 也要可读（表格内部横向滚动）。

## Capabilities and Constraints

- 只写 `.dsh/plugin-state/`（截图存 `.dsh/plugin-state/shots/`），不写源码目录。
- 一切数据缺失都要降级显示原因，不许补 0、不许猜。
- 组件必须活在 DSH 主题里：只使用 `--dsw-alias-*` token；深浅色主题都要可读。
- 写操作必须人点（验收结果、原型批准、初始化），Agent 只能写回执（含验收复核留痕）。
- 无外部字体依赖；Operate 界面用系统 sans 即可。

## Product Principles

1. **一眼看清下一步**：最重的视觉资源给「唯一下一步」，其余区为它服务。
2. **诚实优先于好看**：缺失/降级/失效都要看得见，不用装饰掩盖。
3. **证据可追溯**：功能状态能点回验收条目、回执、diff 图。
4. **操作即判断**：写动作（通过/失败/阻塞/撤销/截图/批准）必须显式、可撤销、有反馈。
5. **安静的密度**：信息密度服务于扫读，颜色只用于状态与主操作。

## Accessibility & Inclusion

- 键盘可达：所有可点元素可 Tab 到、有可见 focus ring；操作按钮有明确文案。
- 正文对比度 ≥4.5:1；状态不只用颜色区分（配文字）。
- 尊重 `prefers-reduced-motion`。

## Evidence on Hand

- `docs/design.md`（产品设计规范定稿）、`docs/IMPLEMENTATION.md`（实现契约与偏差）。
- `tools/preview/` 下的真实 React 预览与截图（mock 数据覆盖正常/降级/窄屏）。
- 已实现功能：总览/详情、功能账、验收清单（结果/截图/视觉回归/失效）、执行回执、审核账本。
- 无真实用户访谈与品牌资产；视觉方向由本轮设计决定。
