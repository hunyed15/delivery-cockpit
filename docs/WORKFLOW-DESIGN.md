# 驾驶舱工作流设计 v2（节点 / 技能 / 产出物 / 进度）

> 状态：**设计稿，未实现**。本轮不写代码，用来先把结构定死。
> 目标读者：写这个插件的人、用这个插件的 agent。
> 结论先行：**9 个阶段是唯一主轴；能力（skill/MCP/工具）挂在阶段上、由阶段技能按顺序驱动；进度只存事件流，文档全部由状态渲染。**

---

## 1. 设计目标与非目标

### 目标

1. **单一主轴**：任何时刻只问「现在第几阶段、下一步做什么」，不问「该跑哪个命令」。
2. **能力可换，阶段不换**：缺 Playwright 就降级用面板截图，缺评审引擎就人工清单——但阶段不能跳。
3. **agent 可自动推进**：每完成一步，工具结果里直接带回下一步；不需要人再问一句「接下来呢」。
4. **文档不手写**：进度、状态摘要、周报都由状态渲染，agent 只写「事实」（回执、验收、测试报告、发布清单），从根上避免文档漂移。
5. **存量项目可接入**：已有项目从当前阶段接管，不回放历史、不伪造历史阶段。

### 非目标

- 不做「会话编排框架」（不像 Trellis 那样定义 start/check/finish 的命令轴）。
- 不自己实现模型调用、不自己实现浏览器、不自己实现代码评审引擎——这些用现成工具/MCP。
- 不做多项目管理后台（面板只读工作区列表）。

---

## 2. 四个「放哪里」的原则

| 类别 | 放哪里 | 谁写 | 为什么 |
|---|---|---|---|
| **节点（9 阶段）** | 插件 `templates/playbook.json` 的 `stages`，代码里只有 `STAGE_DEFS` 的 id/名称映射 | 插件维护者 | 阶段是产品定义，不该散落在 9 个文件里各写一遍 |
| **技能（阶段工作流）** | 插件 `skills/cockpit-<stage>/SKILL.md`，`cockpit_init` 安装到项目 `.dsh/skills/` | 插件维护者写，Host 安装/更新 | 技能随插件升级；项目里只是副本 |
| **产出物（阶段证据）** | 项目 `.dsh/plugin-state/` 与 `docs/` | agent 写事实；Host 写状态与生成物 | 证据要能被机器读，文档要给人读，两者分离 |
| **进度（当前到哪了）** | 项目 `.dsh/plugin-state/receipts.jsonl`（append-only 事件流），其余全是派生 | agent 追加回执；Host 派生 | 只追加不改写，重放即可重建任何视图 |

一句话：**插件放「规则与技能」，项目放「事实与证据」，进度只留事件流。**

---

## 3. 目录树

### 3.1 插件仓库

```
dsh-project-cockpit/
├─ index.js                     Host 半：注册工具 + HTTP 路由（薄壳，不含业务判断）
├─ client.js                    面板（只读渲染，全部数据来自 /api/panel）
├─ lib/
│  ├─ core/                     ── 事实层（只读项目文件，不写业务结论）
│  │  ├─ evidence.js            聚合证据：trellis/prd/brief/card/receipts/acceptance/review/gates
│  │  ├─ receipts.js            事件流：校验、追加、归一旧 stage、派生迭代与阶段状态
│  │  ├─ gates.js               三道技术门：架构契约 / 测试报告 / 发布清单
│  │  ├─ approvals.js           决策门：scope / architecture / prototype / acceptance / release
│  │  ├─ acceptance.js          验收表：起草、写结果、失效联动
│  │  ├─ shape.js               项目形态：new / existing（+ started / persisted）
│  │  └─ features.js            功能账：PRD FR 提取 + 三路证据
│  ├─ flow/                     ── 流程层（节点与推进）
│  │  ├─ stages.js              9 阶段定义（id / 中文名 / 循环与否）
│  │  ├─ playbook.js            读内置+项目覆盖、能力解析、渲染指令、sequence
│  │  ├─ state.js               状态机：唯一动作（优先级表）
│  │  └─ next.js               ★ 新增：把「状态 + playbook」编译成 agent 可直接执行的 next 契约
│  ├─ render/                   ── 渲染层（只从事实派生，不回写）
│  │  ├─ model.js               面板模型（总览行 + 详情）
│  │  ├─ status.js             ★ 新增：docs/STATUS.md 渲染
│  │  └─ report.js              周报 Markdown
│  ├─ tools/                    ── 工具实现（每个工具一个文件）
│  │  ├─ report.js              cockpit_report
│  │  ├─ init.js                cockpit_init（含技能安装/更新）
│  │  ├─ acceptance.js          cockpit_acceptance
│  │  └─ review/                claude_review / disposition / install_hook
│  ├─ routes/                   HTTP：panel / workspaces / report / 写接口
│  ├─ adapters/                 ── 外部数据适配（只读）
│  │  ├─ trellis.js             .trellis/tasks 与 spec（只读，不调 CLI）
│  │  └─ dora.js                可选线上数据
│  └─ screenshot/               本机 CDP 截图 + PNG 对比（含只读与回环约束）
├─ skills/
│  ├─ cockpit-bootstrap/SKILL.md
│  ├─ cockpit-requirements/SKILL.md
│  ├─ cockpit-architecture/SKILL.md
│  ├─ cockpit-prototype/SKILL.md
│  ├─ cockpit-implementation/SKILL.md
│  ├─ cockpit-testing/SKILL.md
│  ├─ cockpit-review/SKILL.md
│  ├─ cockpit-acceptance/SKILL.md
│  └─ cockpit-release/SKILL.md          ← 只有 9 个，不再有命令层
├─ templates/
│  ├─ RULES.md                          项目规则（安装到 .dsh/plugin-state/）
│  ├─ playbook.json                     阶段定义 + sequence + 能力
│  └─ acceptance.json
├─ docs/                                设计/契约/审查记录
└─ test/                                node --test
```

> 说明：`core / flow / render / tools / routes / adapters` 是一次**物理分层**，为了把「读事实」「算下一步」「画出来」「被调用」分开。当前代码把这些混在 `lib/*.js`，迁移是机械的，但先定目录再动手。

### 3.2 项目里（被驾驶舱接管的仓库）

```
<project>/
├─ .dsh/
│  ├─ plugin-state/                     ── 唯一事实源（machine-readable）
│  │  ├─ RULES.md                       本项目规则（人可读；agent 必读）
│  │  ├─ project.json                   名片：name / stack / workflow / shape
│  │  ├─ playbook.json                  本项目阶段覆盖（默认=插件内置）
│  │  ├─ receipts.jsonl                 事件流：每条回执一行（进度唯一来源）
│  │  ├─ acceptance.json                验收条目与结果
│  │  ├─ approvals.json                 按迭代的签核时间戳
│  │  ├─ test-report.json               测试证据（或 manual-check.json）
│  │  ├─ release.json                   发布清单（产物 + sha256 + 回滚）
│  │  ├─ review.json                    评审器设置（claude / agy + 模型 + 代理）
│  │  ├─ dora.json                      可选：线上发布/事故
│  │  ├─ shots/                         截图与 diff 图（证据）
│  │  └─ generated/                     ── Host 生成的只读派生物
│  │     ├─ STATUS.md                   当前进度快照（勿手改）
│  │     └─ weekly-YYYY-MM-DD.md        周报导出
│  └─ skills/cockpit-<stage>/SKILL.md   ← init 安装的 9 个阶段技能
├─ .trellis/                            ── 只读数据源（不调 trellis CLI）
│  ├─ tasks/                            任务（state 机读 in_progress/completed）
│  ├─ spec/                             工程规范（阶段技能先读它）
│  └─ tasks/<task>/review/              审核账本（可选位置之一）
├─ docs/                                ── 阶段产出（人可读契约）
│  ├─ brief.md                          项目立项
│  ├─ prd.md                            需求定义（## 功能需求 + ### FR-N）
│  ├─ architecture.md / api.md          架构契约
│  └─ STATUS.md                         → 软链/指针到 .dsh/plugin-state/generated/STATUS.md
└─ prototype.html                       原型设计
```

**放置规则（硬性）**

1. 机器要读的 → `.dsh/plugin-state/`，扁平、无子目录（`shots/`、`generated/` 除外）。
2. 人要读的契约 → `docs/`，一个阶段一个文件，文件名固定（不要让 agent 自己起名）。
3. 生成物 → `.dsh/plugin-state/generated/`，**只由 Host 写**，任何 agent 都不许手改。
4. 任务与规范 → `.trellis/`，**只读**。要改任务状态由人/人授权的工具做，驾驶舱不代改。

---

## 4. 数据契约（谁写、谁读、什么形状）

| 文件 | 写入者 | 读取者 | 关键字段 |
|---|---|---|---|
| `receipts.jsonl` | agent（`cockpit_report`）/ 人（手工追加，兜底） | state、metrics、model、report | `id, at, iteration_id, stage, status, summary_for_human, used_skill_or_mcp, artifacts, task_ref, write_scope, feature_ids, needs_human_decision, event?` |
| `acceptance.json` | agent 起草（`cockpit_acceptance`）+ 人填结果（面板） | evidence、approvals、model | `iteration_id, items[{id,title,feature_ref,result,evidence[],stale?,staleReason?}]` |
| `approvals.json` | 人（面板按钮 → HTTP → Host 校验后写） | state、model | `{[iteration]: {scopeApprovedAt, architectureApprovedAt, prototypeApprovedAt, prototype, acceptanceApprovedAt, releaseApprovedAt}}` |
| `test-report.json` | agent（跑完真实命令后写） | gates、metrics | `{command, scope, passed, failed, ignored?, durationMs?, at}` |
| `release.json` | agent 写 + 人批准 | gates、state | `{version, artifacts[{path,sha256}], rollback, at, url?}` |
| `playbook.json`（项目） | 人（可覆盖内置） | playbook、model、tools | `{version, stages{中文key:{method,constraint,capabilities[],sequence[],deliverables[],technicalGate,decisionGate,promptTemplate}}, missingHints{}}` |
| `STATUS.md`（生成物） | **Host only** | 人、agent（只读） | 当前阶段、下一步、门禁状态、待办、最近 5 条回执 |

---

## 5. agent 视角的驱动回路

### 5.1 一次完整循环（自动下一步）

```
        ┌──────────────────────────── agent 每步都从这开始 ───────────────────────────┐
        │  cockpit_next()                                                             │
        │    → { stageId, stageName, kind, title, skill, instruction,                 │
        │        sequence[], capabilities[], blockedBy[], needsHuman[], gates{} }      │
        └───────────────────────────────────┬────────────────────────────────────────┘
                                            │ 1) 读 instruction，加载 skill
                                            ▼
        ┌─────────────────────────────────────────────────────────────────────────────┐
        │  阶段技能（.dsh/skills/cockpit-<stage>/SKILL.md）                            │
        │  按 sequence 逐项执行：                                                      │
        │    grilling / context7 MCP / frontend-design / playwright MCP / tdd-loop …   │
        │  产出：docs/prd.md、prototype.html、代码、test-report.json、截图 …            │
        └───────────────────────────────────┬────────────────────────────────────────┘
                                            │ 2) 到达人点节点就停
                                            ▼
        ┌─────────────────────────────────────────────────────────────────────────────┐
        │  人点节点（面板按钮）：范围签核 / 通过原型 / 验收结果 / 验收签核 / 发布批准     │
        │  Host 校验前置（PRD、契约、验收全绿、发布清单），写 approvals.json            │
        └───────────────────────────────────┬────────────────────────────────────────┘
                                            │ 3) 写回执（带证据）
                                            ▼
        ┌─────────────────────────────────────────────────────────────────────────────┐
        │  cockpit_report(...)                                                        │
        │  校验：阶段能力（used_skill_or_mcp 必须含 cockpit-<stage>）、必填证据字段      │
        │  写入：receipts.jsonl（append）                                              │
        │  渲染：STATUS.md 刷新                                                         │
        │  ★ 返回：{ receiptId, next: {…同 cockpit_next 的形状…} }                      │
        └───────────────────────────────────┬────────────────────────────────────────┘
                                            │ 4) agent 直接拿 next.next 继续，不必再问
                                            ▼
                                   （回到循环顶部）
```

**自动下一步的实现要点**：`cockpit_report` 的返回值里**内联下一步**。这样 agent 一次工具调用就拿到「刚做完什么 + 接下来做什么」，不需要人补一句、也不依赖 agent 记得去查面板。

### 5.2 自动调用的三层

| 层 | 机制 | 谁保证 |
|---|---|---|
| 阶段 → 技能 | `instruction` 首句写「按技能 `.dsh/skills/cockpit-<stage>/SKILL.md` 执行本阶段」，`skill` 字段给技能名 | Host 渲染；agent 依指令加载 |
| 技能 → 能力（MCP/skill/工具） | 技能里的「能力调用顺序」表写清工具名与调用方式（`mcp__playwright__browser_take_screenshot` 等） | 技能内容 + `sequence` 数据 |
| 能力缺失 → 降级 | 技能里的「失败与回退」；面板 `capabilities[].present/advice` 提前给出替代与安装 | 技能 + `recommend.js` |

### 5.3 自动更新文档与进度

原则：**agent 只写事实，Host 只做派生。**

```
事实（agent 写）                          派生物（Host 渲染，任何人不得手改）
receipts.jsonl        ─┐
acceptance.json       ─┼─→ state.next ─→ panel（一屏）
approvals.json        ─┤                ─→ generated/STATUS.md（进度快照）
test-report.json      ─┤                ─→ 周报 Markdown
release.json          ─┤                ─→ 指标（DORA 代理/线上）
playbook.json         ─┘
```

- 回执写入后：Host 重新派生 `next`，并把 `STATUS.md` 标脏（下一次渲染时刷新）。
- 面板每次打开都是「读事实 → 现场算」，不缓存结论，避免“面板显示与文件不一致”。
- 周报导出走同一套派生逻辑，不另写一份统计口径。

### 5.4 什么不能自动（边界，写进 RULES）

- 人点节点：范围签核、通过原型、验收结果、验收签核、发布批准——agent 不得代点。
- 证据真实性：截图必须真实；测试必须真跑；产物哈希必须真算——`cockpit_report` 与门禁会拒绝空证据。
- 改 `.trellis/tasks` 状态、改别人的规范结论：不做，交给人。
- 无法判断形态（既没工程文件也没文档）时：**问一句**，不猜。

---

## 6. 节点怎么放（playbook 是唯一配置面）

一个阶段的完整定义（示例：测试验证）：

```json
{
  "测试验证": {
    "method": "cockpit-testing",
    "kit": "cockpit-testing",
    "constraint": "verify-claims",
    "capabilities": [
      { "kind": "inline", "name": "test-report", "mode": "inline" },
      { "kind": "skill", "name": "verify-claims", "mode": "full" },
      { "kind": "skill", "name": "webapp-testing", "mode": "full", "optional": true },
      { "kind": "mcp", "name": "playwright", "mode": "full", "optional": true }
    ],
    "sequence": ["test-report", "webapp-testing", "playwright", "verify-claims", "cockpit_report"],
    "deliverables": [".dsh/plugin-state/test-report.json"],
    "technicalGate": "validateTestReport",
    "decisionGate": null,
    "promptTemplate": "用 {capabilities} 跑真实测试并写报告…"
  }
}
```

- **节点只在这一处定义**；代码里 `STAGE_DEFS` 只保留 id/名称/是否循环，避免两处真相。
- `sequence` 里可以出现 `human-*` 标记，表示“这里必须停，等人操作”。
- `technicalGate` 只允许指向真实存在的校验器（当前三个）；没有校验器就不许写名字（防止“看起来有门”）。

---

## 7. 技能怎么放（9 个，格式统一）

每个 `skills/cockpit-<stage>/SKILL.md` 固定七段：

```
---
name: cockpit-<stage>
description: "…（一句话：这一阶段做什么、由什么驱动）"
---
# cockpit-<stage> · <中文名>
**阶段**：`<id>`（只做这一步）
## 目标
## 输入（先读）
## 按项目形态分两种做法（新项目 / 存量项目）
## 能力调用顺序（表格：步骤 | 用什么 | 具体怎么调 | 产出）
## 门禁
## 失败与回退
## 硬约束
```

- 技能只描述「这一步怎么做」，**不描述流程顺序**（顺序由 playbook + 状态机决定）。
- 技能里出现的工具名必须是真实存在的（MCP 用 `mcp__<server>__<tool>` 全名）。
- 技能随插件升级：`cockpit_init` 对比内容，不一致就 `update` 覆盖；用户自建技能不受影响。

---

## 8. 产出物怎么放（三档）

| 档 | 位置 | 例子 | 特点 |
|---|---|---|---|
| 事实（机器读） | `.dsh/plugin-state/*.json`、`*.jsonl` | receipts、acceptance、approvals、test-report、release | schema 固定，门禁直接读 |
| 契约（人读） | `docs/*.md`、`prototype.html` | brief、prd、architecture、api | 文件名固定，阶段技能负责写 |
| 生成物（只读） | `.dsh/plugin-state/generated/` | STATUS.md、周报 | 只由 Host 写，禁止手改 |

**为什么不把进度写进 docs**：docs 是人写的契约，进度是派生物。混在一起就会出现「文档说做完了、回执没写」这类漂移。

---

## 9. 进度怎么放（事件流 + 派生）

- **唯一写入**：`receipts.jsonl` 追加一行，格式固定，永不修改历史行。
- **派生**：
  - `iteration.current` = 最后一条非 bootstrap 回执的 `iteration_id`；
  - 阶段状态（done/current/pending）= 该迭代内每个 stage 是否有 `completed` 回执；
  - 下一步 = `state.js` 的优先级表（技术门 → 决策门 → 任务 → 审核 → 验收 → 发布）；
  - 指标 = 事件流 + 审核账本 + 验收表的纯函数计算。
- **收益**：任何视图（面板 / STATUS / 周报 / 指标）都能从事件流重建；删掉生成物不会丢信息。

---

## 10. 存量项目接入（XinHuo 这类）

1. `cockpit_init`：写 4 个状态文件 + 安装 9 个技能；`.trellis/` 已存在则保留。
2. 形态判定：有工程文件/源码/文档 ⇒ `existing`，写进 `project.json` 的 `shape`，之后不再随目录变化。
3. 基线回执：写一条当前迭代的 `implementation` 回执（说明“历史项目接入”），让状态机知道从哪继续。
4. 本轮发版材料：`docs/prd.md`（本轮范围）、`prototype.html`（真实界面快照）、`test-report.json`（真实跑一次）、`acceptance.json`（起草）、`release.json`（真实产物哈希）。
5. **不补历史阶段**：brief / 架构契约 / 历史验收都不回填。

---

## 11. 实施计划（本轮不做，供排期）

| 步骤 | 内容 | 风险 |
|---|---|---|
| S1 | 物理分层：`lib/{core,flow,render,tools,routes,adapters,screenshot}` | 机械迁移，测试保护 |
| S2 | 新增 `cockpit_next` 工具 + `cockpit_report` 返回 `next` | 契约新增字段，需兼容旧调用 |
| S3 | 新增 `render/status.js`，生成 `generated/STATUS.md` | 只读派生，风险低 |
| S4 | 阶段技能先读 `.trellis/spec`（`cockpit-implementation`/`cockpit-check` 语义并入阶段） | 需要 spec 索引格式约定 |
| S5 | 面板展示 `sequence` 与当前步骤（“下一步：跑测试 → 写报告”） | 纯前端 |

---

## 12. 需要你拍板的三个问题

1. **`cockpit_next` 是否做成独立工具**，还是只靠 `cockpit_report` 返回值 + 面板？
   - 独立工具：agent 随时能问「现在做什么」，多一次调用；
   - 只靠回执返回：少一次调用，但新会话起手需要先读面板。
2. **`STATUS.md` 放 `docs/STATUS.md` 还是 `.dsh/plugin-state/generated/STATUS.md`（docs 里放指针）**？
   - 放 docs：人容易看到，但会被手改；
   - 放 generated：不会被误改，但人要找。
3. **任务表是否也归驾驶舱**（`.dsh/plugin-state/tasks.json`），Trellis 只当只读导入？
   - 归驾驶舱：闭环更完整，但和 Trellis 任务并行会出现两份；
   - 保持只读 Trellis：兼容现状，但“任务完成”需要人去 Trellis 改。
