---
name: tdd-loop
description: "Use when implementing any feature or bugfix. Enforces red-green-refactor: write a failing test first, minimal implementation, then refactor; requires test command output as evidence. Pairs with the delivery-cockpit test gate."
---

# TDD Loop（测试驱动纪律）

目标：**先让测试失败，再让实现通过**。每次只推进一个行为，避免"先写实现再补测试"。

## 何时使用

- 实现任何功能、修任何 bug 之前；
- 修改已有逻辑（先补覆盖该行为的测试，再改）；
- 重构（先确认现有测试能保护行为）。

不适用：纯文档/配置且无可执行断言时，改用 verify-claims 的手工检查清单。

## 循环（每个行为一次）

1. **Red（写失败测试）**：写一个最小测试，表达期望行为；运行测试，**确认它失败**（失败信息要能说明缺什么）。
2. **Green（最小实现）**：只写让该测试通过的最少代码；不顺手加功能。
3. **Refactor（重构）**：测试保持通过的前提下清理重复/命名/结构；不改变行为。
4. **记录**：测试命令 + 输出（通过数/失败数/耗时）写入 `test-report.json` 或回执 `artifacts`。

## 强制规则

1. 没有"先失败"的测试，不算 TDD；直接写实现再补测试的，必须在回执里说明原因（例如第三方接口无法本地断言）。
2. 一次只测一个行为；一个测试里断言多件事时拆开。
3. 测试要能真正失败：禁止 `expect(true).toBe(true)` 这类同义反复；断言必须检查实现结果，而不是 mock 的调用次数本身。
4. Bug 修复必须先写**复现该 bug 的回归测试**，再修。
5. 测试通过前不得说"实现完成"（配合 verify-claims）。
6. 发现实现需要偏离测试时，先改测试（说明原因），再改实现；不得删除测试来"通过"。

## 证据

- 命令：项目自己的测试命令（如 `npm test` / `pytest` / `go test ./...`）；
- 输出：至少包含运行命令、通过/失败计数、退出码；
- 落盘：`.dsh/plugin-state/test-report.json`，schema `{command, scope, passed, failed, skipped, durationMs, at}`。

## 与驾驶舱的集成

- 代码开发阶段的 Method = `tdd-loop`，回执 `used_skill_or_mcp: "tdd-loop"`；
- 测试验证阶段的技术门校验 `test-report.json`（failed=0）；
- 未写测试的改动会在门禁上被拦下（缺证据），而不是靠人提醒。

## 严禁

- 先写实现再补测试（除非回执说明不可测原因）；
- 为了让测试通过而删测试/放宽断言；
- 只跑 happy path；边界（空值/越界/失败路径）至少各一条；
- 把"测试跑过了"当成"功能正确"的全部证据（配合验收与复核）。
