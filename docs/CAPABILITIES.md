# 能力规划（Capabilities Matrix）

> 本文件回答：9 个阶段里，哪些由 Agent 本体完成、哪些需要 Skill、哪些需要 MCP、哪些需要工具/人工。
> 结论会写进 `templates/playbook.json` 的 `capabilities` 声明，由驾驶舱探测、降级与校验。

## 1. 能力分类

| 类别 | 含义 | 谁执行 | 驾驶舱的职责 |
|---|---|---|---|
| `agent` | Agent 原生能力：推理、读写文件、跑命令、git、写代码 | Agent | 给指令、收 receipt、不直接执行 |
| `skill` | 方法/流程知识（提示词资产）：TDD、代码风格、原型设计、复核规范 | Agent 加载 skill 后执行 | 探测、缺失提示、给替代 skill |
| `mcp` | 外部系统连接：浏览器、文档检索、部署平台、数据库 | Agent 通过 MCP 工具调用 | 探测、缺失给安装指引、降级方案 |
| `tool` | 插件注册的工具：`cockpit_*`、`claude_review` 等 | Agent 调用 | 自己提供或探测 |
| `subagent` | 角色化子代理：架构/前端/后端/联调/复核 | Agent 派生 | 显示 lane、绑定 receipt |
| `human` | 决策门：范围签核、架构签核、原型通过、验收、发布 | 甲方 | 必须人工点击，不可自动通过 |

## 2. 九阶段能力矩阵

图例：● 必需 / ○ 可选 / — 不需要 / ⚠ 当前缺失（有回退）

### S1 项目立项

> 交接物：`docs/brief.md`（一页概念：目标用户 / 场景 / 价值 / 约束 / 初步范围 / 不做什么）

| 能力 | 内容 | 现状 |
|---|---|---|
| agent | 采集脑洞、初始化目录、探测技术栈、写首条 receipt | ● 可用 |
| skill | **`grill`（拷问式追问，把脑洞问清楚）**；`trellis-start`（原） | ⚠ 本机无 grill skill（见 §5 缺口） |
| tool | `cockpit_init`（释放 RULES/项目名片/验收空表） | ● 可用（本插件） |
| mcp | — | — |
| human | **立项确认**（这个想法做不做） | 待实现 |

### S2 需求定义

> 输入：`docs/brief.md`；交接物：`docs/prd.md`（FR 清单 + 优先级 + 验收标准）

| 能力 | 内容 | 现状 |
|---|---|---|
| agent | 从 brief 生成 PRD、拆 FR、写验收标准 | ● 可用 |
| skill | `trellis-brainstorm`（原，缺失）；替代：**`grill` + PRD 模板 + `writing-plans`** | ⚠ trellis 缺失（回退可用） |
| tool | `cockpit_acceptance`（按 FR 起草验收条目） | ● 可用 |
| mcp | — | — |
| human | **范围签核**（功能范围与优先级） | 待实现 |

### S3 架构契约（强制技术门）

| 能力 | 内容 | 现状 |
|---|---|---|
| agent | 架构推理、写 `architecture.md` / ADR / API 契约 | ● 可用 |
| skill | 无专门架构 skill（**缺口**）；替代：`writing-plans` + 本仓库架构模板 | ⚠ 需补模板/skill |
| mcp | `context7`（查框架/库文档）；替代：`web_search` / `dsh-doc` | ⚠ 缺失（回退可用） |
| tool | 契约校验器（P0 新增） | 待实现 |
| human | **架构签核** | 待实现 |

### S4 原型设计

| 能力 | 内容 | 现状 |
|---|---|---|
| agent | 生成静态 `prototype.html`（假数据） | ● 可用 |
| skill | `ui-ux-pro-max`、`frontend-design`、`impeccable` | ● 可用 |
| mcp | `playwright`（打开/验证/截图）；替代：本机 Chrome CDP 截图 | ⚠ 缺失（回退已实现） |
| tool | 原型批准门禁（`approve-prototype`） | ● 可用 |
| human | **原型通过** | ● 已实现 |

### S5 代码开发

| 能力 | 内容 | 现状 |
|---|---|---|
| agent | 写代码、跑命令、git、自测 | ● 可用 |
| skill | `ponytail`、`test-driven-development`、`systematic-debugging`、`writing-plans` | ● 可用 |
| tool | 任务板 + `cockpit_report`（写作用域/回执） | 部分（回执已有，内置任务板待做） |
| subagent | 前端 / 后端 / 联调 lane | 待实现（P1） |
| mcp | `context7`（可选，查文档）、数据库 MCP（可选） | ⚠ 缺失（可选） |
| human | 无 | — |

### S6 测试验证（强制技术门）

| 能力 | 内容 | 现状 |
|---|---|---|
| agent | 跑测试命令、整理失败原因 | ● 可用 |
| skill | `test-driven-development`、`verification-before-completion` | ● 可用 |
| mcp | `playwright`（端到端）；替代：人工 + CDP 截图 | ⚠ 缺失（回退可用） |
| tool | 测试报告校验器（P0 新增） | 待实现 |
| human | 无 | — |

### S7 代码复核

| 能力 | 内容 | 现状 |
|---|---|---|
| agent | 调复核工具、处置 findings、写 disposition | ● 可用 |
| skill | `claude-code-review`、`receiving-code-review` | ● 可用 |
| tool | `claude_review`（旧插件引擎）、账本读取（本插件） | ● 可用（P2 合并） |
| mcp | — | — |
| human | 无（重大争议可升级为决策门） | — |

### S8 验收确认

| 能力 | 内容 | 现状 |
|---|---|---|
| agent | 生成证据、说明结果、复核 | ● 可用 |
| skill | `verification-before-completion` | ● 可用 |
| mcp | `playwright`（交互式验证）；替代：CDP 截图 + 人工 | ⚠ 缺失（回退可用） |
| tool | 验收表、截图、像素对比、失效门禁 | ● 可用（本插件核心） |
| human | **验收签核**（逐条通过/失败/阻塞/撤销） | ● 已实现 |

### S9 部署发布

| 能力 | 内容 | 现状 |
|---|---|---|
| agent | 构建、打 tag、执行部署命令、写发布清单 | ● 可用 |
| skill | `finishing-a-development-branch` | ● 可用 |
| mcp | 部署平台 MCP（Vercel / Cloudflare / Docker / 云厂商）；替代：本机命令 + 部署说明 | ⚠ 缺失（回退可用） |
| tool | `release.json` 校验器（P0 新增） | 待实现 |
| human | **发布批准** | 待实现 |

## 2.5 阶段交接物链（Handoff）

每个阶段的输出就是下一阶段的输入，不允许跳步：

    脑洞
     → S1 项目立项：docs/brief.md（grill 追问后的一页概念）+ 环境就绪
     → S2 需求定义：docs/prd.md（FR 清单 / 优先级 / 验收标准）
     → S3 架构契约：docs/architecture.md + docs/api.md（组件 / 数据模型 / 接口 / ADR）
     → S4 原型设计：prototype.html（假数据；甲方点通过）
     → S5 代码开发：任务清单 + 代码 + 每条任务的 receipt（含写入范围）
     → S6 测试验证：test-report.json（命令 / 通过 / 失败 / 时间）
     → S7 代码复核：审核账本（blocking=0）
     → S8 验收确认：acceptance.json + 截图/差异（甲方逐条签核）
     → S9 部署发布：release.json（版本 / 产物 / 回滚 / 变更记录；甲方批准）
## 3. 当前 profile 探测结果（2026-11-22）

### 4.1 Skill 分布（实扫，2026-11-22）

DSH 的 skill 作用域 = **全局（`DSH_HOME/skills` + `~/.agents/skills`）+ 当前项目（`<cwd>/.dsh/skills` + `<cwd>/.agents/skills`）**。项目级 skill **只在那个项目里可见**——这就是"本机有 grill、但当前项目看不到"的原因。

| 位置 | 数量 | 代表 skill |
|---|---|---|
| `D:\Users\Admin\.dsh\skills`（DSH_HOME，全局） | 17 | claude-code-review、ponytail、test-driven-development、systematic-debugging、verification-before-completion、writing-plans、writing-skills、ui-ux-pro-max、impeccable、frontend-design、finishing-a-development-branch、executing-plans、subagent-driven-development、dispatching-parallel-agents、requesting/receiving-code-review、using-git-worktrees |
| `D:\Users\Admin\.agents\skills`（全局 agents 生态） | 11 | clawhub 包、comet*、ponytail、impeccable、anthropic-frontend-design |
| `D:\Coding\XinHuo\.dsh\skills`（项目级示例） | 14 | **grill-me / grilling**、comet*、trellis-start / continue / finish-work、unslop、code-review-and-quality |
| 旧插件包（claude-code-review 仓库的 `.claude/.agents/.cursor/.dsh/skills`） | 11 + 7 | trellis-start / brainstorm / spec-bootstrap / before-dev / check / finish-work / break-loop / channel / meta / session-insight / update-spec；ui-ux-pro-max 的 design / brand / design-system / slides / ui-styling / banner-design |
| Claude Code 插件市场缓存 | — | `mattpocock-skills`（grilling 的来源），**未装入 DSH** |

> 注意：旧插件包里的 trellis 系列是给 Claude Code / Cursor 用的约定目录，**DSH 不会自动加载**；要用于 DSH，需要复制/软链到全局或项目 `.dsh/skills`。

### 4.2 当前能力状态

- **全局可用 Skills**：上表 DSH_HOME 的 17 个（本会话 skill catalog 可见）。
- **项目级 grill**：存在于 XinHuo 项目（`grill-me` 触发 → `grilling`：设计树式追问，每轮给推荐答案，直到 frontier 为空）；当前项目未安装 → 本会话不可调用。
- **旧插件 trellis 系列**：存在于插件包，未进 DSH 加载路径 → 视为"可选 + 回退"。
- **MCP**：`playwright` 缺失、`context7` 缺失、无部署平台 MCP → 全部走回退，并给安装指引。
- **Tools**：`cockpit_*`（本插件）、`claude_review*`（旧插件）可用。

## 4. playbook 结构扩展（P0 落地）

每个阶段从"只有 promptTemplate"扩展为：

```json
{
  "id": "architecture",
  "name": "架构契约",
  "objective": "冻结组件、数据模型、接口契约与关键决策",
  "execution": ["agent", "skill:writing-plans", "mcp:context7"],
  "capabilities": [
    { "kind": "skill", "name": "writing-plans", "required": false, "fallback": "本仓库架构模板" },
    { "kind": "mcp", "name": "context7", "required": false, "fallback": "web_search" }
  ],
  "deliverables": [
    { "path": "docs/architecture.md", "sections": ["组件", "数据模型", "接口清单", "关键决策"] },
    { "path": "docs/api.md" }
  ],
  "technicalGate": "validateContract",
  "decisionGate": { "title": "架构签核", "approveAction": "approve-architecture" },
  "definitionOfDone": ["契约文件齐全", "甲方签核"]
}
```

新增字段：`execution`、`capabilities[].required/fallback`、`deliverables[]`、`technicalGate`、`decisionGate`、`definitionOfDone`。
探测规则：`agent` 永远可用；`skill` 查本机 skills 目录；`mcp` 查 MCP 配置/工具；`tool` 查 `ctx.tools`；`human` 为门禁配置。

## 5. 规划结论

1. **必需 vs 可选**：只有 S3（架构契约）、S6（测试验证）、S9（部署发布）的**技术门**是硬的；skills/MCP 绝大多数是"可选 + 回退"，避免因缺插件卡死全流程。
2. **硬依赖只有一个**：S7 的复核工具（`claude_review`）。缺失时 S7 技术门无法通过，面板必须明确阻塞并给安装/启用指引。
3. **缺口优先级**：⓪ **grill skill（S1/S2 的想法澄清）——本机存在于 XinHuo 项目级（`grill-me` / `grilling`，mattpocock 系），只需复制/软链到全局或当前项目即可用，不必自建**；① 架构模板（S3，可先做提示词模板，不必新 skill）；② 部署 MCP 推荐与指引（S9）；③ Playwright 安装指引（S4/S6/S8，已有 CDP 回退）；④ 回执/任务板（S5）。
4. **人工门共 5 个**：范围签核、架构签核、原型通过、验收签核、发布批准。
5. **探测即规划**：矩阵写进 playbook 后，面板直接显示每阶段的"必需能力 / 可选能力 / 缺失 / 回退方案"，不需要人记。
