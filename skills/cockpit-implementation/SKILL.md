---
name: cockpit-implementation
description: "驾驶舱代码开发阶段的工作流：先按驾驶舱判定的项目形态（新/存量）选做法，再产出该阶段产物并写回执。"
---
# cockpit-implementation · 代码开发

**阶段**：`implementation`。何时用：面板要求写代码（有未完成任务或需要拆任务）时。

## 先读
- `.trellis/tasks/`（有 Trellis 就用它的任务；没有就用会话任务板）
- `docs/architecture.md` 的契约边界

## 按项目形态分两种做法
- 新项目：先拆任务，一次只做一个。
- 存量项目：**不重写已有实现**，最小改动接进现有结构；先读相邻代码保持一致。

> 形态由驾驶舱判定（面板 `project.shape` / 指令里的说法），**不要自己扫一遍项目再猜**；判不出来就直接问用户一句。

## 步骤
1. 认领一个任务，声明 write_scope。
2. 先写失败测试再实现（TDD），或对存量代码先补特征测试。
3. 实现后跑测试/审核，绿了再写回执。
4. 写 `cockpit_report`：stage=implementation，必须带 task_ref / write_scope / used_skill_or_mcp。

## 产物
- 代码
- .dsh/plugin-state/receipts.jsonl

## 硬约束
- 一次一个任务
- 不跨阶段：不在这步写 PRD 或发布清单
- 不改阶段：走哪一步由驾驶舱「下一步」决定，本 skill 只负责把这一步做对。
