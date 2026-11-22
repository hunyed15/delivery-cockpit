# VISION — Delivery Cockpit：AI-native SDLC 的编排层

> 状态：草案（供评审）。本文定义"从脑洞到上线"的阶段模型、交付物契约与门禁。
> 术语均为行业标准术语；不追求通俗化，追求可执行、可校验。

## 1. 问题陈述

用户（甲方）不写代码，以自然语言提出想法；执行者是 AI Agent（可替换模型/子代理）；专业能力由 skills / MCP / 外部 CLI 提供（Claude Code、Playwright、Trellis 等）。

现状缺口：

1. **缺少编排层**：Agent 容易跳步（跳过 PRD、架构、契约、测试、文档）；
2. **缺少证据层**：阶段完成与否靠"回执声称"，不靠交付物；
3. **缺少治理层**：甲方看不到子代理/会话的产出，验收无法追溯；
4. **缺少能力治理**：skill/MCP 缺失时只有"缺失"提示，没有替代方案与安装指引。

驾驶舱定位：**Orchestration + Governance + Reporting**，不做代码生成、不做 CI 执行、不代替人做验收决策。

## 2. 权威依据与映射

| 来源 | 内容 | 本方案的采用点 |
|---|---|---|
| ISO/IEC/IEEE 12207 | 软件生命周期过程：需求 → 架构 → 设计 → 实现 → 集成 → 验证 → 确认 → 运行 → 维护 → 退役 | 阶段划分的"技术过程"主干；新增 S3 Architecture & Contract、S6 Verification、S9 Observe |
| Stage-Gate（Cooper / PDMA） | Stage + Gate；每个 Gate 检查交付物，做 Go/Kill 决策；"tough gates with teeth" | 双门禁模型：技术门（自动校验）+ 决策门（人拍板） |
| 华为 IPD | 6 阶段 + 4 个 DCP（CDCP/PDCP/ADCP/LDCP）+ 6 个 TR（技术评审）；每阶段有输入/动作/交付物/出口 | DCP vs TR 的双门分类；交付物清单驱动 |
| 阿里云效（DevOps） | 需求 → 开发 → 测试 → 发布 → 运维 → 运营；代码评审、CI/CD、效能度量 | S6 测试门禁、S9 上线观察；DORA/效能指标 |
| 腾讯 CODING / TAPD | 需求 → 设计 → 开发 → 构建 → 测试 → 发布 → 部署；需求/迭代/缺陷/测试/报表 | 缺陷账（blocking findings）、任务/迭代模型 |
| Google eng-practices + DORA | Code review 官方实践；DORA 四指标（Lead time / Deployment frequency / Change failure rate / MTTR） | S7 Code Review 门禁；S9 后的度量 |
| Microsoft SDL | Requirements → Design → Implementation → Verification → Release（+ 安全培训、事件响应） | 阶段门内嵌专项检查（安全门后续扩展） |
| SWE-bench / Agentless / Agent4SE Survey（2023–2025） | Agent 在 SE 单点任务（issue 修复、测试生成）上有效；固定 pipeline 可优于复杂 agent；全生命周期治理仍是开放问题 | 流程必须固定、门禁必须硬；驾驶舱填补"治理层"空白 |

**结论**：不存在权威的"AI 全生命周期标准"。本方案 = 12207 的过程主干 + Stage-Gate/IPD 的门禁 + 云效/CODING 的工具链阶段 + DORA 度量；属于可配置的项目级 playbook，不宣称是行业标准。

## 3. 设计原则

1. **Separation of concerns**：插件 = orchestration/verification/reporting；Agent = execution；skill/MCP =专业能力。插件不直接调用 skill/MCP（DSH 不支持），通过 Agent 执行 + 回执验证。
2. **Evidence-gated transitions**：阶段迁移只认交付物（files + schema）与门禁结果，不认"声称完成"。
3. **Two-gate model**：Technical Gate（自动化校验，可机器判断）与 Decision Gate（甲方决策，必须人工点击）。
4. **No fabrication**：缺失数据输出 `—`/`unknown`/`null` + 原因；不补 0、不猜状态。
5. **Idempotent & append-only**：状态写入幂等；回执/审计事件 append-only，不篡改历史。
6. **Capability-aware**：skills/MCP 探测；缺失时给替代方案与安装指引，不自动安装。
7. **Single source of truth**：状态存放在项目 `.dsh/plugin-state/`，与 PRD/ADR/测试报告同仓可追溯。

## 4. 阶段模型（9 阶段）

每个阶段定义：**Objective / Inputs / Deliverables（路径 + schema）/ Technical Gate / Decision Gate / Definition of Done (DoD)**。

### S1 Bootstrap（立项与初始化）

- Objective：建立项目状态目录与规则基线。
- Deliverables：`RULES.md`、`project.json`（project card）、`acceptance.json`（空表）、`playbook.json`（可覆盖）。
- Technical Gate：四个文件存在且 schema 合法；`.trellis/` 存在。
- Decision Gate：无（自动化）。
- DoD：`cockpit_init` dry-run 通过后 apply 幂等成功。

### S2 Requirements（需求）

- Objective：把想法收敛为可验收的需求基线。
- Deliverables：`docs/prd.md`，包含 `## 功能需求` 与 `### FR-N 标题（P0/P1）`；每条 FR 至少一个 acceptance criterion。
- Technical Gate：可解析出 ≥1 个 FR，且每个 FR 至少关联 1 条 acceptance item（自动起草）。
- Decision Gate：**Scope Sign-off**（甲方确认功能范围与优先级）。
- DoD：PRD 结构合法 + 甲方确认。

### S3 Architecture & Contract（架构与契约）— 新增，强制门

- Objective：在写代码前冻结架构决策与接口契约，避免返工。
- Deliverables：
  - `docs/architecture.md`：`## 组件`、`## 数据模型`、`## 接口清单`、`## 关键决策（ADR）`；
  - `docs/api.md`（或 `openapi.json`）：每个接口含 method / path / request / response / error codes。
- Technical Gate：文件存在 + 必需小节齐全 + 接口数 ≥1；ADR 至少 1 条（含 chosen option 与 rejected options）。
- Decision Gate：**Architecture Sign-off**（甲方确认技术选型与接口契约）。
- DoD：契约冻结后，后续实现不得偏离（偏离需新增 ADR 并重新签核）。

### S4 Prototype（原型/规格）

- Objective：用静态原型确认交互契约。
- Deliverables：`prototype.html`（或 `docs/prototype.html`），含假数据。
- Technical Gate：文件可打开，非空。
- Decision Gate：**Prototype Approval**（甲方点击"通过原型"，已实现）。
- DoD：甲方批准记录写入 `approvals.json`。

### S5 Implementation（实现）

- Objective：按任务拆分实现，前后端可并行。
- Deliverables：任务清单（`.trellis/tasks/*` 或 `.dsh/plugin-state/tasks.json`，含 `id/title/status/acceptance`）；代码；每条任务一条 receipt（`write_scope`）。
- Technical Gate：任务全部 `completed`；receipt 覆盖任务；write_scope 与任务声明一致。
- Decision Gate：无（过程门）。
- DoD：实现完成且 receipt 齐全。
- 可选子轨道（lane）：`backend` / `frontend` / `integration`，以任务标签区分；由编排层派给子代理。

### S6 Verification（测试）— 新增，强制门

- Objective：用可执行测试证明实现满足契约。
- Deliverables：`.dsh/plugin-state/test-report.json`，schema：`{command, scope, passed, failed, skipped, durationMs, at}`；可选覆盖率。
- Technical Gate：存在 ≥1 条 report，`failed=0`，`command` 可复现；验收（S8）前必须满足。
- Decision Gate：无。
- DoD：测试通过证据入账；非代码项目（纯文档/设计）允许以 `manual-check.json` 替代并标注。

### S7 Code Review（复核）

- Objective：独立第二视角审查 diff。
- Deliverables：review ledger（`.dsh/claude-review/ledger` 或 Trellis），blocking findings 全部 resolved。
- Technical Gate：`blocking=0`；review 轮次可追溯（含 disposition）。
- Decision Gate：无。
- DoD：gate 通过（复用现有 `claude_review` 引擎）。

### S8 Acceptance（验收）

- Objective：甲方逐条验收，证据可追溯。
- Deliverables：`acceptance.json`（result + evidence）、截图/diff（`.dsh/plugin-state/shots/`）。
- Technical Gate：每条 result 非空；pass 必须有 evidence；evidence 文件真实存在；视觉变化导致 stale 的必须重验。
- Decision Gate：**Acceptance Sign-off**（甲方点击通过/失败/阻塞，已实现）。
- DoD：全部 pass 且无 stale。

### S9 Release & Observe（发布与观测）

- Objective：发布并观测线上质量。
- Deliverables：`.dsh/plugin-state/release.json`，schema：`{version, artifacts:[{path, sha256}], url, environment, rollback, changelog, at}`；发布 receipt。
- Technical Gate：manifest schema 合法；artifacts 存在且 hash 匹配；rollback 非空。
- Decision Gate：**Release Approval**（甲方点击）。
- DoD：发布完成；上线后进入观测（DORA 指标：lead time / deployment frequency / change failure rate / MTTR）。

## 5. 双门禁模型

| 类型 | 判定者 | 输入 | 失败行为 |
|---|---|---|---|
| Technical Gate（TG） | 插件自动校验 | 交付物文件 + schema + 账本 | 阻塞阶段迁移，面板显示缺什么、怎么补 |
| Decision Gate（DG） | 甲方 | 面板上的明确按钮 | 阶段暂停，等待人工决策；不得自动通过 |

对应 IPD：TG ≈ TR（技术评审点），DG ≈ DCP（决策评审点）。

## 6. 角色与编排（Orchestration）

- **Root session（Lead Agent）**：编排者，读 playbook，按阶段派活、收集回执、跑门禁。
- **Subagent lanes**：`architecture` / `frontend` / `backend` / `integration` / `review` / `verification`；每个子代理独立上下文，共享 cwd 与交付物。
- **可见性**：驾驶舱通过 `ctx.agents.list()` 与 `ctx.subagents.listDescendants()` 显示 lane 视图（活跃状态、最近 receipt、产出文件），解决"甲方看不到子代理"。
- **多会话**：DSH 侧栏会话由 workspace 层创建；跨会话分工用 lane label + receipt 归属表达，不依赖插件创建侧栏会话。
- **规则注入**：子代理 prompt 由编排层注入 `RULES.md` 摘要 + 本阶段 DoD；不依赖子代理自觉读取。

## 7. 证据与状态模型

```
.dsh/plugin-state/
  RULES.md
  project.json            # project card
  playbook.json           # stage overrides
  acceptance.json         # S8
  approvals.json          # S4 / DG records
  receipts.jsonl          # append-only activity log（含 audit events）
  test-report.json        # S6
  release.json            # S9
  shots/                  # S8 evidence
```

审计事件（`acceptance-stale` / `acceptance-recheck`）只进 activity log，不参与进度投影。

## 8. 能力治理（Capability Management）

缺失能力时按顺序给出建议（不自动安装）：

1. **Installed alternatives**：按任务关键词匹配已装 skills（如 Playwright 缺失 → 本机 Chrome CDP 截图）；
2. **dshmarket**：启用已安装的市场插件，搜索/安装；
3. **Official bundles**：`list_bundles` 中 `availability=missing` 且有 `installTarget` 的，输出确切安装命令；
4. **Web search**：检索对应 skill/MCP 仓库，附链接与安装步骤。

## 9. 度量（后置）

- DORA：Lead time for changes、Deployment frequency、Change failure rate、MTTR；
- 交付效能（阿里口径）：需求交付周期、开发周期、发布前置时间、缺陷库存；
- 验收质量：acceptance pass rate、stale rate、证据覆盖率。

## 10. Roadmap

| 阶段 | 内容 | 依赖 |
|---|---|---|
| P0 | 交付物契约 + S3/S6/S9 三个 TG 校验器；playbook 升级为 9 阶段 | 本仓库 |
| P1 | Lane 视图（agents/subagents 可见性）；规则注入 | DSH `ctx.agents` / `ctx.subagents` |
| P2 | 合并 review engine（`claude_review` → 本插件，旧 UI 不迁） | 旧插件源码 |
| P3 | DORA/效能指标 + 项目周报导出 | P0/P1 数据 |

## 11. 非目标（Non-goals）

- 不做代码生成（Agent 职责）；
- 不替代 CI/CD（只校验产物与门禁）；
- 不自动通过验收或发布（Decision Gate 必须人工）；
- 不管理系统级多租户/权限（DSH profile 负责）。

## 12. 待决问题（Open Decisions）

1. S3 Architecture Sign-off 是否强制（建议：强制，可配置 `requireArchitectureGate`）；
2. 面板术语是否切换为专业术语（Acceptance / Blocking / Stale / DoD / ADR），或"专业术语 + 人话句子"混排；
3. Review engine 合并方式（内嵌 vs 独立 bundle）；
4. 多会话支持范围（lane 视图 vs 真正多 session）。
