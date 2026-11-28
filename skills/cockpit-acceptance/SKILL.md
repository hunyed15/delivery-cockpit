---
name: cockpit-acceptance
description: "驾驶舱验收确认阶段的工作流：按驾驶舱判定的项目形态（新/存量）选做法，按能力调用顺序驱动技能与 MCP，产出该阶段证据并写回执。"
---
# cockpit-acceptance · 验收确认

**阶段**：`acceptance`。这一步只做这件事，不越阶段。

## 目标
每条功能都有真实证据，由人判定通过。

## 输入（先读）
- `acceptance.json`（人已填的结果不覆盖）
- `docs/prd.md` 的 FR 与验收标准

## 按项目形态分两种做法
- 新项目：按 FR 逐条验。
- 存量项目：只验本轮改动涉及的功能，历史功能不重复造证据。

> 形态由驾驶舱判定（`panel.project.shape`，含 `started` / `persisted`），**不要自己扫一遍项目再猜**。

## 能力调用顺序

| 步骤 | 用什么 | 具体怎么调 | 产出 |
|---|---|---|---|
| 1 | 内置 `acceptance-gate`（inline） | 按 FR 列出待验条目；缺条目先用 `cockpit_acceptance` 起草 | 验收清单 |
| 2 | 面板「截图」或 `mcp__playwright__browser_take_screenshot` | 截图自动与上一版做像素对比；有变化会让旧的「通过」失效 | `.dsh/plugin-state/shots/` 与 diff 图 |
| 3 | `verify-claims` 技能 | 证据必须真实存在；URL/文件都要能打开 | 逐条证据 |
| 4 | 人工逐条点「通过 / 没通过 / 卡住」 | agent 不代替人判定 | `acceptance.json` 的 result 与 evidence |
| 5 | 人工「验收签核」 | 全绿后人签字确认这一轮算过 | `approvals.json` 的 acceptance 时间戳 |
| 6 | `cockpit_report` 工具 | stage=acceptance | 一条 acceptance 回执 |

## 门禁
验收全绿 + 每条有证据 + 人已签核。

## 失败与回退
Playwright MCP 不可用 → 面板内置截图；截图也做不了就附文件证据并说明。

## 硬约束
- pass 必须有证据
- 不替人点通过
- 截图变化后旧通过失效，必须重新确认
- 不改阶段：走哪一步由驾驶舱「下一步」决定；本技能只负责把这一步做对。
- 不调用 `trellis` CLI：任务、规范、账本都直接读文件。
