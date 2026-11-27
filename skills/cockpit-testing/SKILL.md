---
name: cockpit-testing
description: "驾驶舱测试验证阶段的工作流：先按驾驶舱判定的项目形态（新/存量）选做法，再产出该阶段产物并写回执。"
---
# cockpit-testing · 测试验证

**阶段**：`testing`。何时用：面板要求补测试证据时。

## 先读
- 项目的测试命令（package.json / Cargo.toml）
- `workflow`：轻量模式仍要过这道门

## 按项目形态分两种做法
- 新项目：建测试骨架并跑通。
- 存量项目：跑既有测试套件，把真实结果写进报告；付费/需网络用例可以 ignored，但要写明。

> 形态由驾驶舱判定（面板 `project.shape` / 指令里的说法），**不要自己扫一遍项目再猜**；判不出来就直接问用户一句。

## 步骤
1. 真的跑测试，拿到命令与真实计数（passed / failed / ignored）。
2. 写 `.dsh/plugin-state/test-report.json`：`{command, scope, passed, failed, ignored?, at}`；非代码项目写 `manual-check.json`。
3. 失败就修，不要改报告。
4. 写 `cockpit_report`：stage=testing。

## 产物
- .dsh/plugin-state/test-report.json

## 硬约束
- 不伪造计数
- ignored 要如实写
- 命令必须可直接复现
- 不改阶段：走哪一步由驾驶舱「下一步」决定，本 skill 只负责把这一步做对。
