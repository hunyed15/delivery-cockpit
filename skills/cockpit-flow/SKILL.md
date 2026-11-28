---
name: cockpit-flow
description: "驾驶舱唯一的编排技能：读 cockpit_next 的下一步契约，按角色解析出的能力顺序执行本阶段（调用 skill/MCP/工具），在人点节点停下，最后写回执并拿到下一步。"
---

# cockpit-flow · 交付工作流编排（唯一入口）

**什么时候用**：任何时候要"推进这个项目"。先调 `cockpit_next`，它会告诉你现在第几节点、做什么、按什么顺序调用哪些能力。

> 节点是流程（9 个，固定），能力是工具（可换、可复用）。你不需要记 9 套流程——**只有这一套编排**。

## 一次循环（照做即可）

1. **读契约**：`cockpit_next()` → `{ stageId, title, instruction, plan[], needsHuman[], blockedBy[], gates }`。
2. **先看阻塞**：`blockedBy` 非空就先解决它（通常是缺证据/缺签核），不要跳过。
3. **按 `plan` 逐项执行**（顺序就是执行顺序）：
   - `kind=capability`：加载对应技能（`skill` 工具）或调用对应 MCP/工具；MCP 用全名，如 `mcp__playwright__browser_take_screenshot`。
   - `kind=fallback`：首选能力缺失，按 `fallback` 里的做法降级，并在回执里写明"降级原因"。
   - `kind=builtin`：这一步没有外部能力（写 PRD、写契约、跑构建命令），按技能里的说明直接做。
   - `kind=human`：**停**。把材料准备好，请人在面板点（签核 / 通过原型 / 验收结果 / 批准发布），不要代点。
4. **落产物**：按阶段写文件（`docs/prd.md`、`prototype.html`、`test-report.json`、`release.json`…），文件名固定，不要自创。
5. **任务**：动代码前用 `cockpit_task` 认领（`claim`），做完 `complete`；一次只做一个。
6. **写回执**：`cockpit_report({ stage, status, summary_for_human, used_skill_or_mcp, ... })`。
   - `used_skill_or_mcp` 必须包含 `cockpit-flow`（可以再带实际用的能力，如 `cockpit-flow, tdd-loop`）。
   - 返回值里带 `next`：**直接拿它继续下一轮**，不要问人"接下来呢"。
7. 若 `next.stageId` 变了，说明阶段推进了：重新加载本技能，从第 1 步开始。

## 角色与能力怎么对应（不必背，看 plan 就行）

| 角色（role） | 常见绑定 |
|---|---|
| intake / design-method / code-method / verify / review | grilling、frontend-design、tdd-loop、verify-claims、claude_review |
| research | context7（MCP）→ web_search → 读依赖与类型 |
| visual-evidence / capture / e2e | playwright（MCP）→ 面板内置 CDP 截图 |
| constraint / ui-audit | ponytail、impeccable |
| task-claim / evidence / disposition | cockpit_task、test-report、claude_review_disposition |
| human-* | 人点节点，agent 只准备材料 |

## 硬约束

- **不改阶段**：做哪一步由 `cockpit_next` 决定，技能只管把这一步做对。
- **不代点**：范围签核、通过原型、验收结果、验收签核、发布批准只能人做。
- **不伪造证据**：测试要真跑、截图要真截、哈希要真算；空证据会被门禁拒绝。
- **不调 `trellis` CLI**：`.trellis/tasks` 与 `.trellis/spec` 只读；任务状态用 `cockpit_task` 改驾驶舱自己的表。
- **一次一个任务**：不要并行铺开多个任务再一起收尾。
