# 本项目的工作规则（项目驾驶舱）

> 放在 `.dsh/plugin-state/RULES.md`。任何会话在这个项目里工作，都按这份规则执行。
> 它只规定**底线与顺序**，不规定技术细节；技术细节由各 skill 负责。

## 1. 阶段由插件决定，不由 skill 决定

- 项目走到哪一步、下一步做什么，**以「项目驾驶舱」面板的「下一步」为准**。
- 技能（skill）只能决定"这一步**怎么做**"，**不得改变"做哪一步"**。
- 若某个 skill 的流程与本规则冲突，**以本规则为准**，并在回执里说明"我偏离了哪个 skill 的哪一条"。

## 2. 动手前先认领

- 任何会改代码的工作，**先认领**：在 Agent Teams 任务板（同会话）或 trellis task（跨会话/跨天）里领一条，并声明 `write_scope`（要改哪些目录）。
- 没认领就动手 = 面板看不见谁在做什么，等价于没做记录。
- **一次只做一个任务**；做完再领下一个。

## 3. 每一步都必须交回执

任何技能/MCP 跑完，往 `.dsh/plugin-state/receipts.jsonl` **追加一行**：

```json
{"at":"2026-11-20T14:40:12+08:00","stage":"验效果","skill":"playwright","status":"ready",
 "summary_for_human":"下单主流程跑通，截图 2 张","artifacts":["shots/order-1.png"],
 "task_ref":"T3","write_scope":["web/orders/**"],
 "blocking_issues":[],"needs_human_decision":false}
```

| 字段 | 要求 |
|---|---|
| `stage` / `skill` / `status` | 必填。`status` ∈ `progress` / `waiting` / `ready` / `blocked` / `failed` / `dropped` |
| `summary_for_human` | 必填，**一句人话**说清发生了什么。写不出来 = 这一步不算做完 |
| `task_ref` | 改代码时必填，指向认领的任务 |
| `write_scope` | 改代码时必填，实际改到的目录 |
| `needs_human_decision` | 需要我拍板时置 `true`，并在 `summary` 里写清选什么 |

追加写，不修改历史。

## 4. 什么时候必须停下来问人

出现以下任一情况，**立即停**，写一条 `status: "blocked"` 或 `needs_human_decision: true` 的回执，然后等我：

- 两种方案都合理，取舍取决于产品判断（不是技术判断）
- 需要改已冻结的契约
- 要删数据、改账本、动 `.trellis/` 结构
- 连续 2 次尝试失败
- 预算（轮数/时间）将超出

**这条优先级高于任何 skill 里"不要停下来问人、连续执行"的指令。**

## 5. 能力冲突时的裁决顺序

1. **DSH 内核**（会话、沙箱审批、subagent、Agent Teams）
2. **trellis**（任务、规范、校验）
3. **其他第三方 skill / MCP**

同一件事多层都有能力时按此顺序；跨场景例外（如跨进程协作只能用 trellis channel）。**不得自行引入未登记的能力**——若确实需要，先写回执说明，等我决定。

## 6. 不做的事

- 不写伪造的进度数字：读不到就写 `—` 或"未知"，不默认 0
- 不把"看代码觉得没问题"当作验收通过
- 不改 `AGENTS.md` 的 TRELLIS 区块、不覆盖已有规则
- 不自动 push / 上线（由 DSH 工具审批把关）
