# 本项目的工作规则（Delivery Cockpit）

> 放在 `.dsh/plugin-state/RULES.md`。任何会话在这个项目里工作，都按这份规则执行。
> 它只规定**底线与顺序**，不规定技术细节；技术细节由各 skill 负责。

## 1. 阶段由插件决定，不由 skill 决定

项目阶段固定为 9 个（4 字中文名 / canonical id）：

| 中文名 | id | 说明 |
|---|---|---|
| 项目立项 | `bootstrap` | 冷启动，每项目一次 |
| 需求定义 | `requirements` | PRD / FR / 验收标准 |
| 架构契约 | `architecture` | 组件 / 数据模型 / 接口 / ADR |
| 原型设计 | `prototype` | 静态原型 + 人点通过 |
| 代码开发 | `implementation` | 按任务实现 |
| 测试验证 | `testing` | 测试报告（失败数=0） |
| 代码复核 | `code-review` | 独立评审，blocking=0 |
| 验收确认 | `acceptance` | 人工逐条验收 + 证据 |
| 部署发布 | `release` | 发布清单 + 人批准 |

- 走到哪一步、下一步做什么，**以驾驶舱面板的「下一步」为准**。
- 每个阶段的流程由**插件自带的阶段技能** `cockpit-<stage>` 承担（装在 `.dsh/skills/`）：`cockpit-bootstrap`、`cockpit-requirements`、`cockpit-architecture`、`cockpit-prototype`、`cockpit-implementation`、`cockpit-testing`、`cockpit-review`、`cockpit-acceptance`、`cockpit-release`。
- 第三方 skill / MCP（trellis-*、frontend-design、tdd-loop、verify-claims、playwright…）是**可选工具**：有就用，没有不影响流程，也不由它们决定做哪一步。
- 技能（skill）只决定"这一步**怎么做**"，**不得改变"做哪一步"**。
- 若某个 skill 的流程与本规则冲突，**以本规则为准**，并在回执里说明"我偏离了哪个 skill 的哪一条"。
- 历史账本里的旧 stage id（`init`/`scaffold`/`brainstorm`/`coding`/`code_review`/`verification`）会被自动归一，不影响既有记录。

## 1.5 先看项目形态：新项目还是存量项目

- 形态（`new` / `existing`）由**驾驶舱判定**并随面板下发（`project.shape` 与指令里的说法），依据是工程文件、源码目录、需求文档与已有回执。
- **不要自己扫一遍项目再猜形态**；判不出来就直接问用户一句。
- 两种形态的做法不同：
  - 新项目：从零产出该阶段的东西（问出 brief、写 PRD、定契约、做原型…）；
  - 存量项目：**记录现状、最小改动**——不重写已有文档与实现，不补历史阶段，只处理本轮发版需要的范围。
- 存量项目不补写历史阶段（例如不为半路接入的项目伪造 brief 或架构契约）。

## 2. 动手前先认领

- 任何会改代码的工作，**先认领**：在 Agent Teams 任务板（同会话）或 trellis task（跨会话/跨天）里领一条，并声明 `write_scope`（要改哪些目录）。
- 没认领就动手 = 面板看不见谁在做什么，等价于没做记录。
- **一次只做一个任务**；做完再领下一个。

## 3. 每一步都必须交回执

优先调用 `cockpit_report` 工具（强类型校验，参数见工具 schema）；工具不可用时才手工往 `.dsh/plugin-state/receipts.jsonl` 追加一行，schema 如下：

```json
{"iteration_id":"v1.0","stage":"acceptance","status":"completed",
 "summary_for_human":"下单主流程跑通，截图 2 张", "used_skill_or_mcp":"verify-claims",
 "artifacts":["shots/order-1.png"], "task_ref":"T3", "write_scope":["web/orders/**"],
 "feature_ids":["FR-1"], "needs_human_decision":null}
```

| 字段 | 要求 |
|---|---|
| `iteration_id` | 必填。冷启动固定 `"bootstrap"`；迭代环用 `v1.0` / `v1.1` |
| `stage` | 必填，canonical id（见 §1）；旧 id 会被归一 |
| `status` | 必填，`in_progress` / `completed` / `blocked` / `failed` / `dropped` |
| `summary_for_human` | 必填，一句人话说清发生了什么；写不出来 = 这一步不算做完 |
| `used_skill_or_mcp` | 记录这一步实际使用的 skill/MCP（如 `tdd-loop`、`frontend-design`、`claude_review`） |
| `task_ref` / `write_scope` | 改代码时必填（`implementation` 阶段强制） |
| `feature_ids` | 这条回执对应哪些 PRD 功能（如 `["FR-1"]`），可省略 |
| `artifacts` | 产物路径（截图、报告、发布清单等） |
| `needs_human_decision` | 需要我拍板时给决策对象，并在 summary 写清选什么 |

追加写，不修改历史。

## 4. 什么时候必须停下来问人

出现以下任一情况，**立即停**，写一条 `status: "blocked"` 或 `needs_human_decision` 的回执，然后等我：

- 两种方案都合理，取舍取决于产品判断（不是技术判断）
- 需要改已冻结的契约（架构契约阶段签核过的接口/数据模型）
- 要删数据、改账本、动 `.trellis/` 结构
- 连续 2 次尝试失败
- 预算（轮数/时间）将超出

**这条优先级高于任何 skill 里"不要停下来问人、连续执行"的指令。**

## 5. 能力冲突时的裁决顺序

1. **DSH 内核**（会话、沙箱审批、subagent、Agent Teams）
2. **trellis**（任务、规范、校验）
3. **其他第三方 skill / MCP**

同一件事多层都有能力时按此顺序；跨场景例外（如跨进程协作只能用 trellis channel）。**不得自行引入未登记的能力**——若确实需要，先写回执说明，等我决定。

## 6. 能力纪律

- 每个阶段有**声明的 Method/Constraint**（如代码开发=`tdd-loop`、测试验证=`verify-claims`、原型设计=`frontend-design`）；按声明使用，并在回执 `used_skill_or_mcp` 里写实际使用的名字。
- 声明的能力缺失时：优先用 playbook 里的回退方案，并在回执里写明"缺失 + 回退"；不得静默跳过。
- 没有证据（命令输出/测试报告/截图/审核账本）不得声称完成。

## 7. 不做的事

- 不写伪造的进度数字：读不到就写 `—` 或"未知"，不默认 0
- 不把"看代码觉得没问题"当作验收通过
- 不改 `AGENTS.md` 的 TRELLIS 区块、不覆盖已有规则
- 不自动 push / 上线（由 DSH 工具审批把关）
