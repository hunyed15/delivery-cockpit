---
name: cockpit-requirements
description: "驾驶舱需求定义阶段的工作流：按驾驶舱判定的项目形态（新/存量）选做法，按能力调用顺序驱动技能与 MCP，产出该阶段证据并写回执。"
---
# cockpit-requirements · 需求定义

**阶段**：`requirements`。这一步只做这件事，不越阶段。

## 目标
把这一轮要交付的东西写成可验收的功能清单，并交给人签核范围。

## 输入（先读）
- `docs/brief.md`（有就作为起点，没有不要造）
- `docs/prd.md`（已存在只补缺失，不重写）
- 现有代码/文档（存量项目）

## 按项目形态分两种做法
- 新项目：从 brief 收敛出第一版 FR 与验收标准。
- 存量项目：只写「本轮要发的范围」，依据是现有代码、文档与最近提交，不搬历史需求。

> 形态由驾驶舱判定（`panel.project.shape`，含 `started` / `persisted`），**不要自己扫一遍项目再猜**。

## 能力调用顺序

| 步骤 | 用什么 | 具体怎么调 | 产出 |
|---|---|---|---|
| 1 | 读 brief / 现有材料 | 没有 brief 就直接用目标、场景、约束写，**不编造 brief** | `docs/prd.md` 的 FR 与验收标准 |
| 2 | `cockpit_acceptance` 工具 | 按 FR 起草验收条目，result 留空，只追加不覆盖 | `.dsh/plugin-state/acceptance.json` |
| 3 | 人工「范围签核」 | 把 FR 与优先级交给人确认，**不替人决定 P0/P1** | `approvals.json` 里的 scope 时间戳 |
| 4 | `cockpit_report` 工具 | stage=requirements | 一条 requirements 回执 |

## 门禁
PRD 能解析出 ≥1 个 FR，每个 FR 至少一条验收；范围已签核。

## 失败与回退
没有 `trellis-brainstorm` 之类技能也能做：内置 PRD 结构 + 逐项追问。

## 硬约束
- 不重写已有 PRD
- 优先级由人签核
- 每 FR 至少一条验收
- 不改阶段：走哪一步由驾驶舱「下一步」决定；本技能只负责把这一步做对。
- 不调用 `trellis` CLI：任务、规范、账本都直接读文件。
