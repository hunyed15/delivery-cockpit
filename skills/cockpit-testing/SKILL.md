---
name: cockpit-testing
description: "驾驶舱测试验证阶段的工作流：按驾驶舱判定的项目形态（新/存量）选做法，按能力调用顺序驱动技能与 MCP，产出该阶段证据并写回执。"
---
# cockpit-testing · 测试验证

**阶段**：`testing`。这一步只做这件事，不越阶段。

## 目标
把「能跑通」变成可复现的证据。

## 输入（先读）
- 项目真实测试命令（package.json / Cargo.toml / pyproject.toml）
- 本轮改动范围

## 按项目形态分两种做法
- 新项目：建测试骨架并跑通。
- 存量项目：跑既有测试套件，如实记录 ignored（付费/需网络用例）。

> 形态由驾驶舱判定（`panel.project.shape`，含 `started` / `persisted`），**不要自己扫一遍项目再猜**。

## 能力调用顺序

| 步骤 | 用什么 | 具体怎么调 | 产出 |
|---|---|---|---|
| 1 | 跑真实测试命令 | 拿到真实计数（passed / failed / ignored）与耗时 | 命令输出 |
| 2 | 内置 `test-report`（inline） | 写 `.dsh/plugin-state/test-report.json`：`{command, scope, passed, failed, ignored?, at}` | 测试报告 |
| 3 | `webapp-testing` 技能 + `mcp__playwright__browser_*`（可选） | 有 UI 就走一条端到端：打开 → 操作 → 断言 → 截图 | E2E 证据截图 |
| 4 | `verify-claims` 技能 | 没有命令输出/报告不得声称通过 | 结论与证据对齐 |
| 5 | `cockpit_report` 工具 | stage=testing | 一条 testing 回执 |

## 门禁
测试技术门通过（真实命令、至少一条结果、failed=0）。

## 失败与回退
非代码项目写 `manual-check.json`（人工检查单），同样要真实结果。

## 硬约束
- 不伪造计数
- ignored 必须写明
- 失败先修，不改报告
- 不改阶段：走哪一步由驾驶舱「下一步」决定；本技能只负责把这一步做对。
- 不调用 `trellis` CLI：任务、规范、账本都直接读文件。
