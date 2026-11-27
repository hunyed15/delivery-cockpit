---
name: cockpit-architecture
description: "驾驶舱架构契约阶段的工作流：先按驾驶舱判定的项目形态（新/存量）选做法，再产出该阶段产物并写回执。"
---
# cockpit-architecture · 架构契约

**阶段**：`architecture`。何时用：面板要求定架构与契约（完整流程）时；轻量模式会跳过本阶段。

## 先读
- `docs/prd.md`
- 现有代码结构与依赖方向

## 按项目形态分两种做法
- 新项目：从零写组件、数据模型、接口清单、关键决策（含取舍）。
- 存量项目：**记录现状**而不是重新设计——把已有模块、真实接口、既有决策写下来，标出本轮会动的边界。

> 形态由驾驶舱判定（面板 `project.shape` / 指令里的说法），**不要自己扫一遍项目再猜**；判不出来就直接问用户一句。

## 步骤
1. 写 `docs/architecture.md`：`## 组件` / `## 数据模型` / `## 接口清单` / `## 关键决策`（ADR 至少一条，写清 chosen / rejected）。
2. 写 `docs/api.md`（至少一条 `METHOD /path`）或 `docs/openapi.json`（`paths` 非空）。
3. 交给人做架构签核；契约冻结后若偏离，先补一条 ADR 再改。
4. 写 `cockpit_report`：stage=architecture。

## 产物
- docs/architecture.md
- docs/api.md

## 硬约束
- YAGNI：只冻结本轮需要的契约
- 存量项目不改写既有架构事实
- 不改阶段：走哪一步由驾驶舱「下一步」决定，本 skill 只负责把这一步做对。
