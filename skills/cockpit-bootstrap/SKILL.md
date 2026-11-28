---
name: cockpit-bootstrap
description: "驾驶舱项目立项阶段的工作流：按驾驶舱判定的项目形态（新/存量）选做法，按能力调用顺序驱动技能与 MCP，产出该阶段证据并写回执。"
---
# cockpit-bootstrap · 项目立项

**阶段**：`bootstrap`。这一步只做这件事，不越阶段。

## 目标
把「做什么、为谁做、不做什么」问清楚，并把项目状态建起来。

## 输入（先读）
- 根目录现状（有没有工程文件 / 源码 / docs）
- `.dsh/plugin-state/RULES.md`（已存在就先读）

## 按项目形态分两种做法
- 新项目：一次只问一个问题，问出目标用户、场景、价值、约束、不做什么。
- 存量项目：**不要重写历史**。从 README / docs / 代码读出目标与约束，补一页 brief；读不出来的写「待确认」。

> 形态由驾驶舱判定（`panel.project.shape`，含 `started` / `persisted`），**不要自己扫一遍项目再猜**。

## 能力调用顺序

| 步骤 | 用什么 | 具体怎么调 | 产出 |
|---|---|---|---|
| 1 | `grilling` 技能（可选） | 本机有就用来主持提问；没有就按 brief 模板逐项问 | `docs/brief.md` |
| 2 | `cockpit_init` 工具 | `dryRun:true` 先看会写什么，确认后 `dryRun:false` | `.dsh/plugin-state/{RULES,playbook,project,acceptance}`、空的 `.trellis/`、`.dsh/skills/` |
| 3 | `cockpit_report` 工具 | stage=bootstrap，used_skill_or_mcp=cockpit-bootstrap | 一条 bootstrap 回执 |

## 门禁
`.trellis/` 与四个状态文件存在；brief 写清目标用户与「不做什么」。

## 失败与回退
`grilling` 缺失不是阻塞：按模板自问自答，但要在回执里说明用的是内置模板。

## 硬约束
- 不补历史阶段
- 不把实施细节写进 brief
- init 幂等：已存在的文件不覆盖
- 不改阶段：走哪一步由驾驶舱「下一步」决定；本技能只负责把这一步做对。
- 不调用 `trellis` CLI：任务、规范、账本都直接读文件。
