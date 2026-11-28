---
name: cockpit-prototype
description: "驾驶舱原型设计阶段的工作流：按驾驶舱判定的项目形态（新/存量）选做法，按能力调用顺序驱动技能与 MCP，产出该阶段证据并写回执。"
---
# cockpit-prototype · 原型设计

**阶段**：`prototype`。这一步只做这件事，不越阶段。

## 目标
让「界面长什么样」先被人确认，再进代码。

## 输入（先读）
- `docs/prd.md` 里界面相关的 FR
- 现有界面截图（存量项目，作为视觉基线）

## 按项目形态分两种做法
- 新项目：做可点击的静态原型。
- 存量项目：用**真实界面截图**做基线页，不重画一套不存在的设计。

> 形态由驾驶舱判定（`panel.project.shape`，含 `started` / `persisted`），**不要自己扫一遍项目再猜**。

## 能力调用顺序

| 步骤 | 用什么 | 具体怎么调 | 产出 |
|---|---|---|---|
| 1 | `frontend-design` 技能 | 定版式、层级、状态与空态；一个新项目只做本轮核心流程 | `prototype.html` |
| 2 | `ui-ux-pro-max`（可选） | 需要设计令牌/组件规范时加载，不重复 frontend-design | 统一的令牌与间距 |
| 3 | `mcp__playwright__browser_navigate` + `browser_take_screenshot` | 打开 `prototype.html` 或本机预览地址，截图留档；也可用面板内置 CDP 截图 | 原型截图（存 `.dsh/plugin-state/shots/`） |
| 4 | `impeccable` 技能 | 按质量底线自检一遍（对比度、溢出、焦点态） | 自检结论写进回执 |
| 5 | 人工「通过原型」 | 视觉可接受与否由人判断 | `approvals.json` 的 prototypeApprovedAt |
| 6 | `cockpit_report` 工具 | stage=prototype | 一条 prototype 回执 |

## 门禁
`prototype.html` 存在且人点过「通过原型」。

## 失败与回退
Playwright MCP 不可用就用面板内置截图（本机 Chrome/Edge CDP，只允许回环地址）。

## 硬约束
- 原型不改业务代码
- 存量项目不重做设计
- 截图必须真实（不许用示意图冒充）
- 不改阶段：走哪一步由驾驶舱「下一步」决定；本技能只负责把这一步做对。
- 不调用 `trellis` CLI：任务、规范、账本都直接读文件。
