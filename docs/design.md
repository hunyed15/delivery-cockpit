# `@hunyed15/project-cockpit` 产品设计规范（定稿）

> 对象：非技术创始人 / 独立开发者 · DSH 插件 · 本文定稿后不再改动结构，只随实现补细节

## 1. 定位与三条铁律

**它是面向非技术创始人的 AI 产品交付驾驶舱**：把项目真实状态收拢成一屏，回答"做到哪了、卡在哪、谁在干、下一步做什么用什么"。

1. **只做驾驶舱，不做发动机**：不替 Agent 写代码、不做架构决策；只做上下文感知、规则约束、路由建议、可视化。
   - 判据三问：需要看代码/看界面才能定吗？做错了要重试吗？→ 归 Agent。只是按规则从已知选项挑一个？→ 归插件。
2. **绝不造假，诚实降级**：读不到就显示"缺 MCP/Skill"或 `—`；空验收表绝不判通过；缺失数据降级为只读。
3. **流程主权在驾驶舱**：专业能力**整包复用**（`full`），流程编排**抽取内联**（`inline`），冲突的自动化流程能力**彻底拔除**。

## 2. 范围

- **这是 DSH 插件，只管 DSH 内部**，不接外部 agent。
- **项目 = 工作区**。每个工作区一条项目信息，**空目录也要出现**（显示「未初始化」+ 下一步"初始化"）。
- 一个工作区可有多个会话；会话是执行单元，项目是归属单元。

## 3. 全生命周期

查询由**一次性冷启动** + **可无限循环的功能迭代环**组成。

```
冷启动（每项目 1 次）：  [初始化] → [搭骨架]
                                  ↓
迭代环（v1.0, v1.1…）：  [想清楚] → [看原型] → [写代码] → [挑毛病] → [验效果] → [发出去]
                             ↑                                                       │
                             └───────────────────────────────────────────────────────┘
```

### 3.1 冷启动

| 阶段 | 做什么 | 退出门禁 |
|---|---|---|
| **init 初始化** | 生成 `.trellis/`、`.dsh/plugin-state/`、`.gitignore` 提示行；释放 `RULES.md`/`project.json`/`playbook.json`/`acceptance.json` | `.trellis/` 且 `RULES.md` 齐备 |
| **scaffold 搭骨架** | 探测技术栈（读 `package.json` / `Cargo.toml` / `pubspec.yaml` 等），生成可本地启动的空壳与项目名片 | 本地能启动空壳 + 名片已填 |

### 3.2 功能迭代环

| 阶段 | 做什么 | 用什么 | 退出门禁 |
|---|---|---|---|
| **brainstorm 想清楚** | 梳理本轮需求，产出/修改 `prd.md` | `trellis-brainstorm` | `prd.md` 含目标用户/核心流程/不做什么 |
| **prototype 看原型** | 生成含假数据的**纯静态 HTML 原型** + API 契约 | `ui-ux-pro-max`、`frontend-design` | **人点过「通过原型」**（见 §5.3） |
| **coding 写代码** | 拆微型任务，逐条实现 | `trellis` + `ponytail` + `TDD` + `systematic-debugging` + `task-loop`(inline) | 任务全 completed + 每任务一次通过的 range 审核 |
| **code_review 挑毛病** | 全量门禁审查，blocking 清零 | `claude_review` + `trellis-check` | 账本无未处置 blocking 且 gate 通过 |
| **verification 验效果** | 人话版验收表 + 真实浏览器跑通 + 截图 | `Playwright MCP` + `verification-before-completion` | 验收表非空、每条有结果、pass 有证据 |
| **release 发出去** | 构建与版本归档，开启下一轮 | `finishing-a-development-branch`、`trellis-finish-work` | 构建产物 + 版本号/链接 |

## 4. 驾驶舱 UI：一屏四区

```
┌ 1. 项目名片 & 迭代头 ───────────────────────────────────────────┐
│ [项目名] · [Web/Next.js] · [▶ 本地预览]  当前迭代 v1.1 [+新迭代]  │
│ 定位：给人看的一句话           [待修复 0 / 账本健康]              │
├ 2. 唯一下一步 ─────────────────────────────────────────────────┤
│ 👉 【看原型】确认 UI 布局与交互契约                              │
│    推荐能力：ui-ux-pro-max, frontend-design                      │
│    指令：…（可直接执行）           [复制] [一键发送至对话]        │
├ 3. 迭代进度 & 视觉画廊 ────────────────────────────────────────┤
│ [✓想清楚]→[●看原型]→[写代码]→[挑毛病]→[验效果]→[发出去]         │
│ 🖼 原型：prototype.html(新标签打开)   📸 验收截图：待生成         │
├ 4. 人话账本 ───────────────────────────────────────────────────┤
│ 功能账：客户列表（进行中）｜接口对接（已完成）                    │
│ 缺陷账：[严重] 提交按钮移动端失效 · 归属：客户列表 [展开技术详情]  │
└────────────────────────────────────────────────────────────────┘
 底部：主会话活跃 ｜ 引擎正常 ｜ 上次回执 2 分钟前 ｜ [刷新]
```

两级：**总览（= 工作区列表，空目录可见）→ 详情（上图）**。

## 5. 数据协议：`cockpit_report` 强类型工具

**取代"AI 手写 JSONL"**：注册 Host 工具，由 DSH 校验参数，插件负责追加写。坏行从源头消失。

### 5.1 工具签名

```json
{
  "name": "cockpit_report",
  "description": "Agent 向 Project Cockpit 上报当前阶段推进状态与回执",
  "parameters": {
    "type": "object",
    "required": ["iteration_id", "stage", "status", "summary_for_human"],
    "properties": {
      "iteration_id": { "type": "string", "description": "迭代版本号；冷启动阶段固定传 \"bootstrap\"" },
      "stage": { "type": "string", "enum": ["init","scaffold","brainstorm","prototype","coding","code_review","verification","release"] },
      "status": { "type": "string", "enum": ["in_progress","completed","blocked","failed","dropped"] },
      "summary_for_human": { "type": "string", "description": "一两句人话：做完了什么 / 卡在哪" },
      "used_skill_or_mcp": { "type": "string" },
      "artifacts": { "type": "array", "items": { "type": "string" } },
      "task_ref": { "type": "string", "description": "改代码时必填" },
      "write_scope": { "type": "array", "items": { "type": "string" }, "description": "改代码时必填" },
      "needs_human_decision": {
        "type": "object",
        "required": ["title"],
        "properties": {
          "title": { "type": "string" },
          "options": { "type": "array", "items": { "type": "string" } },
          "recommended": { "type": "string" }
        }
      }
    },
    "additionalProperties": false
  },
  "output": {
    "schema": {
      "type": "object",
      "properties": { "ok": { "type": "boolean" }, "receiptId": { "type": "string" }, "at": { "type": "string" } },
      "required": ["ok", "receiptId"]
    },
    "render": "把 summary_for_human 作为一行文本返回"
  }
}
```

### 5.2 三条硬约束

1. **必须声明 `output: { schema, render }`** —— DSH 的硬要求；漏了会导致**整个插件激活失败**（面板与全部工具一起 404）。必须配一条断言守住。
2. **`task_ref` / `write_scope` 即使 V1 不做并发防撞也要留在签名里**（可选），以后迭代不用改接口。
3. **`needs_human_decision` 非空 ⇒ 一律视为「待人工决策」并最高优置顶**，与 `status` 填什么无关。防止 Agent 传 `in_progress` 导致面板漏掉该弹窗。

### 5.3 原型批准（按迭代存）

面板提供「通过原型」按钮，写入：

```json
// .dsh/plugin-state/approvals.json
{ "v1.0": { "prototypeApprovedAt": "2026-11-20T22:10:00+08:00", "prototype": "prototype.html" } }
```

- **必须按 `iteration_id` 存**：否则 v1.1 会误读成"已通过原型"而跳过确认。
- 没有当前迭代的批准标记 → 下一步永远是「看原型」，不得进「写代码」。

### 5.4 账本

- 存储：`.dsh/plugin-state/receipts.jsonl`，插件追加写，永不改历史。
- 坏行处理：读取时**跳过损毁行**，UI 顶部标「账本存在损坏行（已降级显示）」，不伪造成正常数据。
- `iteration_id = "bootstrap"` 的记录只属于冷启动，不参与迭代环的进度计算。

## 6. 能力武器库：full / inline / skip

判据：**需要它全部 → 整包复用；只需要一部分 → 不登记它，把那几句重写进我们自己的规则**（skill 是整份指令，登记即整份执行，无法"半用"）。

| 模式 | 对象 | 处理 |
|---|---|---|
| **full 整包复用** | `ui-ux-pro-max`、`frontend-design`、`impeccable`、`ponytail`、`test-driven-development`、`systematic-debugging`、`verification-before-completion`、`using-git-worktrees`、`finishing-a-development-branch`、`claude_review`、`Playwright MCP`、`Context7 MCP`、trellis 各技能 | 原封不动调用，只登记不改它 |
| **inline 抽取内联** | `subagent-driven-development`（只取"任务级评审 + 修复循环"）、`dispatching-parallel-agents`（只取"一任务一 agent"） | 写进 `RULES.md` 的 `task-loop`，不登记原 skill |
| **skip 拔除** | `using-superpowers`、`brainstorming`、`executing-plans`、`subagent-driven-development`、`dispatching-parallel-agents` | 断开 `~/.dsh/skills` 符号链接（不动源目录，可恢复） |

### 6.1 三层裁决

1. **DSH 内核**（会话、沙箱与审批、`subagent`、Agent Teams）
2. **trellis**（任务、规范、校验、`trellis-channel` 跨进程协作）
3. **第三方 skill / MCP**

跨场景例外：同会话短任务并行用层 1 的 subagent；跨进程/长期驻留 worker 用层 2 的 `trellis-channel`。

### 6.2 两个必须承认的边界

- **`Context7 MCP` 不用于技术栈探测**：它是查库文档的；技术栈靠读项目文件探测。Context7 只在「写代码」查语法时用。
- **插件读不到 Agent Teams 任务板**（宿主服务目录里没有对应接口）。"谁在做什么"只能来自 `cockpit_report` 自报的 `task_ref`/`write_scope`，界面须标明是**自报数据**。

### 6.3 能力缺失

每个能力条目带 `kind`（`skill`/`tool`/`mcp`/`inline`）做存在性检测。缺失时显示「该阶段需要的 MCP 未安装：playwright」，**不下发注定失败的指令**。

## 7. 状态机

优先级从高到低：

| # | 条件 | 动作 |
|---|---|---|
| 1 | **存在 `needs_human_decision` 非空的回执**（不论 status） | 处理人工决策（把 title/options 顶到首行） |
| 2 | 工作区未初始化（缺 `.trellis` 或 `RULES.md`） | 初始化 |
| 3 | 无 `prd.md` | 想清楚 |
| 4 | 有 prd、当前迭代无原型批准 | 看原型 |
| 5 | 有原型、有未完成任务 | 写代码 |
| 6 | 有未处置 blocking | 挑毛病（修） |
| 7 | 有 ready 待复检 | 复检 |
| 8 | 从未审核 | 第一次审核 |
| 9 | 审核干净、验收表为空 | 生成验收清单 |
| 10 | 验收表非空未全绿 | 验效果 |
| 11 | 验收通过、无发布记录 | 发出去 |
| 12 | 全部完成 | 开启下一轮迭代 / 跑提交门禁 |

任何一步数据不可信 → 降级为「先确认数据」并禁用主按钮。

## 8. 降级矩阵

| 缺失/异常 | 表现 |
|---|---|
| 无 `.trellis` | 显示「未初始化」+ 初始化下一步 |
| 账本坏行 | 跳过 + 顶部提示"存在损坏行" |
| 缺 MCP/Skill | 该阶段显示"缺 X，需安装"或不发指令 |
| 无原型批准 | 不进写代码，停在「看原型」 |
| 无 Agent Teams | 并行区显示原因；"谁在做什么"退化为回执自报 |
| 读取失败 | 保留旧数据 + 标注时间 + 重试 |

## 9. 非目标

- 不做冷热缓存、不做无人值守 L2 全自动（V1 明确放弃）
- 不重造待办、不做甘特图/趋势图
- 不写业务源码；自有状态只写 `.dsh/plugin-state/`
- 不解析 PRD 自由文本算进度、不跑 git 判定 worktree、不从自由文本猜"在等人"

## 10. 路线图

### Phase 1 · 核心闭环（V1.0）
- [ ] 工作区与 `.trellis` / `.dsh` 目录自动初始化
- [ ] 技术栈探测（读文件）与项目名片生成
- [ ] 注册 `cockpit_report` 强类型工具（含 `output` 声明 + 断言）+ JSONL 容错解析
- [ ] 「冷启动 + 循环迭代」状态机
- [ ] 本机 Playbook 路由与 L1 目标级指令生成

### Phase 2 · 视觉左移与画廊（V1.1）
- [ ] 「看原型」阶段门禁（必须产出静态 HTML + 人批准标记）
- [ ] 人话版 `acceptance.json` 契约生成
- [ ] Playwright 截图在面板直接渲染（视觉画廊）

### Phase 3 · 体验打磨（V1.2）
- [ ] 人话账本分类 + 「AI 一键自动归类缺陷」
- [ ] 轻量多项目总览（状态真实降级显示）

> 阶段标记保持 `[ ]`，实现并通过验收后才勾选——上一版把它们全标成已完成，会误导后续判断。

## 11. 风险

| 风险 | 对策 |
|---|---|
| 工具契约错误导致整插件失效 | `output` 声明 + 断言 + 真机 `application: applied` 检查 |
| 已装 skill 自动触发绕过编排 | RULES 声明优先级 + 回执必填 `used_skill_or_mcp` + 断链 skip 类 |
| 原型门禁形同虚设 | 批准标记按 iteration 落盘；无标记不进 coding |
| 迭代间状态串味 | 所有回执与批准都带 `iteration_id`；`bootstrap` 单独归冷启动 |
| 借鉴后自成分支、拿不到上游修复 | 记录来源与参考版本，自己维护 |
| 能力缺失被误判为插件坏了 | `kind` 检测 + 明确提示缺什么 |

## 12. 实现交接（新工作区起步清单）

本仓库只承载设计。开发在新工作区进行，避免上下文与目录污染。

### 12.1 参考实现

`reference/receipts.js` + `reference/cockpit-receipts.test.js` —— 账本模块与 11 条断言（已跑通）。可直接搬进新工程当起点；它已经实现：

- `validateReceipt`：必填校验、`coding` 阶段强制 `task_ref`/`write_scope`、`needs_human_decision.title` 必填
- `appendReceipt`：目录自建 + 追加写，写失败抛出（不静默丢数据）
- `readReceipts`：坏行跳过并计数，无文件时返回 `missing` 而不是抛错
- `currentIteration`：忽略 `bootstrap`
- `pendingDecision`：最新一条决策且之后无同迭代回执才算未解决
- `stageStates`：按迭代取各阶段最新状态

### 12.2 Phase 1 起步清单

| 要建的东西 | 验收标准 |
|---|---|
| `.dsh/plugin-state/` 初始化（幂等 + dry-run） | 二次执行不覆盖；只写四个模板文件 |
| 技术栈探测（读 `package.json` / `Cargo.toml` / `pubspec.yaml` 等） | 空项目也能给出"未检测到"而不是猜 |
| 项目名片 `project.json`（探测优先，人填两字段） | 技术栈与预览命令无需手写即可显示 |
| `cockpit_report` 工具注册 | **`output: {schema, render}` 必须声明**；`application: applied`；`listTools` 能看到 |
| 账本读取 + 坏行降级 | 坏行跳过，UI 顶部标"存在损坏行" |
| 冷启动 + 迭代环状态机（12 条优先级） | 每个分支都能给出唯一动作 |
| Playbook 加载（内置默认 + 项目覆盖） | 缺能力时显示"缺 MCP/skill"，不发注定失败的指令 |

### 12.3 三条最容易踩的坑

1. **工具漏 `output` 声明 → 整个插件激活失败**（面板与全部工具一起 404）。每加一个工具都要断言一次。
2. **`iteration_id` 冷启动必须能填 `"bootstrap"`**，否则 `init`/`scaffold` 阶段永远校验不过。
3. **原型批准必须按 `iteration_id` 存**，否则 v1.1 会误读成"已通过原型"直接跳过确认。

## 13. 参考

- 编排思路参考 `superpowers` 的 subagent-driven-development（任务级评审 + 修复循环）、`dsh-superagent` 的结构化 Report。**规则与模板文字为自行重写，不随上游同步**。
