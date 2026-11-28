---
name: cockpit-review
description: "驾驶舱代码复核阶段的工作流：按驾驶舱判定的项目形态（新/存量）选做法，按能力调用顺序驱动技能与 MCP，产出该阶段证据并写回执。"
---
# cockpit-review · 代码复核

**阶段**：`code-review`。这一步只做这件事，不越阶段。

## 目标
用独立评审找出本轮改动里的真问题，并逐条处置。

## 输入（先读）
- 本轮改动范围（range / paths）
- `.dsh/plugin-state/review.json`（评审器与模型）
- 上一轮未处置问题

## 按项目形态分两种做法
- 新项目：每轮实现后跑一次 range 审核。
- 存量项目：只审本轮改动，不试图审全库。

> 形态由驾驶舱判定（`panel.project.shape`，含 `started` / `persisted`），**不要自己扫一遍项目再猜**。

## 能力调用顺序

| 步骤 | 用什么 | 具体怎么调 | 产出 |
|---|---|---|---|
| 1 | `claude_review` 工具 | 按项目设置走 Claude 或 Gemini(agy)；`mode=range` 或带 `paths` | 审核账本 + 结构化结论 |
| 2 | `claude-code-review` 技能（清单） | 按五轴（正确性/契约/边界/可维护性/证据）人工过一遍工具没覆盖的点 | 补充结论 |
| 3 | `claude_review_disposition` 工具 | 逐条记 fixed / deferred / counter-evidence，**不允许沉默** | 处置账本 |
| 4 | 内置 `review-ledger`（inline） | 确认本轮 `blocking=0` | 可复核的账本 |
| 5 | `cockpit_report` 工具 | stage=code-review | 一条 code-review 回执 |

## 门禁
本轮 blocking=0，且所有问题都有处置记录。

## 失败与回退
评审器不可用 → 用 `claude-code-review` 清单人工审，并在回执写明降级原因。

## 硬约束
- 不跳过处置
- 不接受「看起来没问题」当结论
- defer 必须说明为什么现在不修
- 不改阶段：走哪一步由驾驶舱「下一步」决定；本技能只负责把这一步做对。
- 不调用 `trellis` CLI：任务、规范、账本都直接读文件。
