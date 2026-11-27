---
name: cockpit-requirements
description: "驾驶舱需求定义阶段的工作流：先按驾驶舱判定的项目形态（新/存量）选做法，再产出该阶段产物并写回执。"
---
# cockpit-requirements · 需求定义

**阶段**：`requirements`。何时用：面板要求写 PRD 或让范围签核时。

## 先读
- `docs/brief.md`（有就作为输入，没有不要造）
- `docs/prd.md`（已存在则只补缺失，不重写）
- `project.json` 的 `workflow`

## 按项目形态分两种做法
- 新项目：从 brief 收敛出第一版 FR 与验收标准。
- 存量项目：把「本轮要发的范围」写成 PRD（不搬历史需求）；依据是现有代码、已有文档、最近提交。

> 形态由驾驶舱判定（面板 `project.shape` / 指令里的说法），**不要自己扫一遍项目再猜**；判不出来就直接问用户一句。

## 步骤
1. 有 `docs/brief.md` 就以它为起点；没有就直接用目标、场景、约束写，**不要编造 brief**。
2. 写 `docs/prd.md`：`## 功能需求` 下每条 `### FR-N 标题（P0/P1）`，每条至少一条验收标准。
3. 用 `cockpit_acceptance` 按 FR 起草验收条目，result 留空；只追加，不覆盖人已填的结果。
4. 把范围与优先级交给人签核（面板「确认范围」），**不要替人决定 P0/P1**。
5. 签核后写 `cockpit_report`：stage=requirements。

## 产物
- docs/prd.md
- .dsh/plugin-state/acceptance.json

## 硬约束
- 不重写已存在的 PRD
- 优先级由人签核
- 每条 FR 至少一条验收
- 不改阶段：走哪一步由驾驶舱「下一步」决定，本 skill 只负责把这一步做对。
