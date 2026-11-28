---
name: cockpit-architecture
description: "驾驶舱架构契约阶段的工作流：按驾驶舱判定的项目形态（新/存量）选做法，按能力调用顺序驱动技能与 MCP，产出该阶段证据并写回执。"
---
# cockpit-architecture · 架构契约

**阶段**：`architecture`。这一步只做这件事，不越阶段。

## 目标
把组件、数据模型、接口与关键决策冻结成本轮可执行的契约。

## 输入（先读）
- `docs/prd.md`
- 现有模块结构与依赖方向（存量项目）

## 按项目形态分两种做法
- 新项目：从零写组件、数据模型、接口清单、关键决策（含取舍）。
- 存量项目：**记录现状**而不是重新设计，标出本轮会动的边界。

> 形态由驾驶舱判定（`panel.project.shape`，含 `started` / `persisted`），**不要自己扫一遍项目再猜**。

## 能力调用顺序

| 步骤 | 用什么 | 具体怎么调 | 产出 |
|---|---|---|---|
| 1 | `mcp__context7__resolve-library-id` + `mcp__context7__query-docs` | 查本轮用到的框架/库的真实 API 与版本差异（例如 Tauri 2、Svelte 5） | 引用到 architecture.md 的技术事实 |
| 2 | `ponytail` 技能（约束） | YAGNI：只冻结本轮需要的契约，不预设计 | 更少的接口与表 |
| 3 | 内置 `architecture-template`（inline） | 按模板写 `## 组件` / `## 数据模型` / `## 接口清单` / `## 关键决策`（ADR 至少一条，写 chosen / rejected） | `docs/architecture.md`、`docs/api.md` |
| 4 | 人工「架构签核」 | 契约冻结后若偏离，先补 ADR 再改 | `approvals.json` 的 architecture 时间戳 |
| 5 | `cockpit_report` 工具 | stage=architecture | 一条 architecture 回执 |

## 门禁
架构技术门通过（四个小节 + 关键决策有内容 + api 至少一条 METHOD /path）+ 架构签核。

## 失败与回退
`context7` 不可用时用 web 搜索或仓库内代码求证，并在 ADR 里写明依据来源。

## 硬约束
- YAGNI
- 存量项目不改写既有架构事实
- 契约变了必须先补 ADR
- 不改阶段：走哪一步由驾驶舱「下一步」决定；本技能只负责把这一步做对。
- 不调用 `trellis` CLI：任务、规范、账本都直接读文件。
