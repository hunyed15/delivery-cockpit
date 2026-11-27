---
name: cockpit-bootstrap
description: "驾驶舱项目立项阶段的工作流：先按驾驶舱判定的项目形态（新/存量）选做法，再产出该阶段产物并写回执。"
---
# cockpit-bootstrap · 项目立项

**阶段**：`bootstrap`。何时用：面板「下一步」是初始化项目 / 立项，或项目还没有 RULES.md 与 project.json 时。

## 先读
- `.dsh/plugin-state/RULES.md`（已存在就先读，不要覆盖）
- `project.json` 的 `workflow`（full / light）与 `name`

## 按项目形态分两种做法
- 新项目：用提问把目标用户、场景、价值、约束、不做什么问清楚（grilling 式，一次只问一个）。
- 存量项目：**不要重写历史**。从 README / docs / 代码里读出目标与约束，补一页 brief；读不出来的列为「待确认」，不要编。

> 形态由驾驶舱判定（面板 `project.shape` / 指令里的说法），**不要自己扫一遍项目再猜**；判不出来就直接问用户一句。

## 步骤
1. 先判断形态：看根目录有没有工程文件、源码目录、`docs/prd.md`、已有回执；判不出来就问用户一句。
2. 按形态产出 `docs/brief.md`（新项目问出来，存量项目读出来）。
3. 调用 `cockpit_init`（`dryRun:false`）释放状态文件；已存在的不覆盖。
4. 确认 `.trellis/` 与 `.dsh/plugin-state/RULES.md` 都在。
5. 写一条 `cockpit_report`：stage=bootstrap，used_skill_or_mcp=cockpit-bootstrap。

## 产物
- docs/brief.md
- .dsh/plugin-state/{RULES.md,project.json,playbook.json,acceptance.json}

## 硬约束
- 不回填历史阶段
- 不在 brief 里写实施细节（那是架构契约的事）
- 不改阶段：走哪一步由驾驶舱「下一步」决定，本 skill 只负责把这一步做对。
