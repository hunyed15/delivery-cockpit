---
name: cockpit-start
description: "驾驶舱命令：开始/接续一次开发会话。用一分钟说清：这是新项目还是存量项目、现在在哪一步、下一步唯一动作、有没有要我先拍板的事。"
---
# cockpit-start · 开始/接续一次开发会话

**何时用**：进入一个项目准备开工，或隔了几天要接着做时（对应 Trellis 的 start，但用驾驶舱自己的流程）。

**目的**：用一分钟说清：这是新项目还是存量项目、现在在哪一步、下一步唯一动作、有没有要我先拍板的事。

## 步骤
1. 读 `.dsh/plugin-state/`：`project.json`（shape / workflow）、`receipts.jsonl` 最后几条、`acceptance.json`。
2. 读面板「下一步」（`nextAction`）：kind / method / instruction —— 这是本轮唯一该做的事。
3. 只读看一眼 `.trellis/tasks/` 有没有 `in_progress` 任务；读不到就当没有，**不要调用 trellis 命令**。
4. 输出三段：现状一句话 / 现在做哪一步（含技能名）/ 要人决定的事（没有就说没有）。
5. 需要动手时，先认领任务并声明 `write_scope`，再开始。

## 产出
- 一段可读的开工简报
- 一条认领记录（任务板或回执）

## 硬约束
- 不调用 `trellis` CLI：任务与规范只是文件，直接读。
- 不重放历史阶段：存量项目从当前阶段开始。
- 没有 `nextAction` 就先跑 `cockpit_init`。

> 这些命令是驾驶舱自己的流程实现：Trellis 只作为数据来源（`.trellis/tasks`、`.trellis/spec`、审核账本），**不调用 `trellis` CLI**。
