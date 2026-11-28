---
name: cockpit-implementation
description: "驾驶舱代码开发阶段的工作流：按驾驶舱判定的项目形态（新/存量）选做法，按能力调用顺序驱动技能与 MCP，产出该阶段证据并写回执。"
---
# cockpit-implementation · 代码开发

**阶段**：`implementation`。这一步只做这件事，不越阶段。

## 目标
按任务把功能实现出来，每步都有测试与回执。

## 输入（先读）
- `.trellis/tasks/` 里认领的任务（只读；没有就用会话任务板）
- `docs/architecture.md` 的契约边界

## 按项目形态分两种做法
- 新项目：先拆任务，一次只做一个。
- 存量项目：不重写已有实现，最小改动接进现有结构，先读相邻代码保持一致。

> 形态由驾驶舱判定（`panel.project.shape`，含 `started` / `persisted`），**不要自己扫一遍项目再猜**。

## 能力调用顺序

| 步骤 | 用什么 | 具体怎么调 | 产出 |
|---|---|---|---|
| 1 | 认领任务 | 声明 `write_scope`；一次只做一个任务 | 任务归属记录 |
| 2 | `tdd-loop` 技能 | 先写失败测试 → 最小实现 → 通过 → 重构；存量代码先补特征测试 | 测试 + 实现 |
| 3 | `ponytail` 技能（约束） | 最小改动，不顺手重构 | 更小的 diff |
| 4 | `claude_review` 工具（range 模式） | 每个任务完成后审本轮改动，阻塞问题当场修 | 审核账本一轮记录 |
| 5 | `cockpit_report` 工具 | stage=implementation，带 task_ref / write_scope / used_skill_or_mcp | 一条 implementation 回执 |

## 门禁
任务完成、测试通过、本任务范围内审核无阻塞。

## 失败与回退
`claude_review` 不可用时在回执里如实写「未审核」，不要假装审过。

## 硬约束
- 一次一个任务
- 不跨阶段
- 不伪造测试通过
- 不改阶段：走哪一步由驾驶舱「下一步」决定；本技能只负责把这一步做对。
- 不调用 `trellis` CLI：任务、规范、账本都直接读文件。
