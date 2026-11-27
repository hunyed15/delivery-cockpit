---
name: cockpit-review
description: "驾驶舱代码复核阶段的工作流：先按驾驶舱判定的项目形态（新/存量）选做法，再产出该阶段产物并写回执。"
---
# cockpit-review · 代码复核

**阶段**：`code-review`。何时用：面板要求做独立评审或复核已修问题时。

## 先读
- 审核账本（`.dsh/claude-review/ledger/` 或 `.trellis/tasks/<task>/review/`）
- 评审器设置 `.dsh/plugin-state/review.json`

## 按项目形态分两种做法
- 新项目：每轮实现后跑一次 range 审核。
- 存量项目：只在**本轮改动范围**内审（`mode=range` 或 `paths`），不要试图审全库。

> 形态由驾驶舱判定（面板 `project.shape` / 指令里的说法），**不要自己扫一遍项目再猜**；判不出来就直接问用户一句。

## 步骤
1. 调用 `claude_review`（按项目设置走 Claude 或 Gemini）。
2. 逐条处置：`claude_review_disposition` 记 fixed / deferred / counter-evidence。
3. 阻塞问题清零后写 `cockpit_report`：stage=code-review。

## 产物
- .dsh/claude-review/ledger/review/

## 硬约束
- 不跳过处置
- 不接受"看起来没问题"当结论
- 不改阶段：走哪一步由驾驶舱「下一步」决定，本 skill 只负责把这一步做对。
