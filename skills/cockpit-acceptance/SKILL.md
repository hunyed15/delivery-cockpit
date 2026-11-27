---
name: cockpit-acceptance
description: "驾驶舱验收确认阶段的工作流：先按驾驶舱判定的项目形态（新/存量）选做法，再产出该阶段产物并写回执。"
---
# cockpit-acceptance · 验收确认

**阶段**：`acceptance`。何时用：面板要求验效果或签核验收时。

## 先读
- `acceptance.json`（人已填的结果不要覆盖）
- `docs/prd.md` 的 FR 与验收标准

## 按项目形态分两种做法
- 新项目：按 FR 逐条验。
- 存量项目：只验本轮改动涉及的功能；历史功能不重复造证据。

> 形态由驾驶舱判定（面板 `project.shape` / 指令里的说法），**不要自己扫一遍项目再猜**；判不出来就直接问用户一句。

## 步骤
1. 缺条目就用 `cockpit_acceptance` 起草（result 留空）。
2. 逐条给证据：截图 / 文件 / 命令输出；**证据必须真实存在**。
3. 把结果交给人点通过（或人在面板填），agent 不代替人判定通过。
4. 全绿后请人点「验收签核」，再写 `cockpit_report`：stage=acceptance。

## 产物
- .dsh/plugin-state/acceptance.json
- .dsh/plugin-state/shots/

## 硬约束
- pass 必须有证据
- 不替人点通过
- 截图变化会让旧通过失效，需要重新确认
- 不改阶段：走哪一步由驾驶舱「下一步」决定，本 skill 只负责把这一步做对。
