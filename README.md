# Delivery Cockpit

DSH（DeepSeek Harness）插件，用来管理一个软件项目从想法到发布的完整交付过程。

它把项目当前的状态、下一步该做什么、做完没有、证据在哪，集中放到一个面板里，并让关键节点必须由人确认。它不替 agent 写代码，也不替 skill 做决定；它负责流程、证据和门禁。

- 包名：`@hunyed15/delivery-cockpit`
- 插件 / 面板 id：`delivery-cockpit`
- 仓库：https://github.com/hunyed15/delivery-cockpit

## 做什么用

一个项目从"有个想法"到"上线"，中间有很多步骤：想清楚需求、定架构、做原型、写代码、跑测试、代码复核、验收、发布。每一步都可能：

- 做没做完说不清；
- 做完了但没有证据；
- 不知道下一步该做什么；
- 跳过验收直接发布；
- 代码检查、测试、验收各自为政。

Delivery Cockpit 的作用是把这些步骤固定成 9 个节点，给每个节点定义输入、产物、检查项和负责人；然后从项目文件里读取真实证据，推导当前进度和下一步动作。

它主要解决四类问题：

1. **进度不可信**：不靠聊天记录或 agent 自报，靠回执、文件、测试报告、验收证据。
2. **下一步不明确**：状态机每次只给一个动作，人和 agent 不需要自己判断流程。
3. **关键节点没人把关**：范围、架构、原型、验收、发布需要人点确认，前置条件由 Host 校验。
4. **交付和证据脱节**：验收结果、截图、测试、审核、发布清单都落到固定文件，面板和周报能直接读。

## 设计理念

**1. 插件决定"做哪一步"，skill 决定"怎么做"**

阶段顺序、门禁、下一步由插件控制。具体用哪个 skill、怎么写代码、怎么测试，由 skill 和 agent 决定。skill 不能推翻阶段顺序。

**2. 只认证据，不认自报**

"做完了"不算完成。要有回执、文件、测试报告、验收证据或人的签核。读不到就显示 `—` 并说明缺什么，不补 0，不猜。

**3. 人保留关键决定权**

范围、架构、原型、验收、发布五个节点需要人确认。Agent 可以把材料准备好，但不能替人点通过。

**4. 复用已有能力，不自建一套生态**

插件不复制 Trellis、Playwright、Context7、Claude Code Review 等能力，只负责按阶段路由、检查是否存在、缺了给替代方案或安装提示。

**5. 写操作尽量少，并且可追溯**

插件主要写 `.dsh/plugin-state/`；项目代码、文档、测试由 agent 和 skill 按阶段产出。所有执行记录追加到回执账本，不修改历史。

## 9 个节点

| 节点 | 做什么 | 主要产物 | 复用的能力 | 门禁 |
|---|---|---|---|---|
| 1. 项目立项 | 明确目标、用户、约束、不做什么；初始化项目状态 | `docs/brief.md`、`RULES.md`、`project.json`、`playbook.json`、`acceptance.json` | `grilling`（可选）、`cockpit_init` | 无 |
| 2. 需求定义 | 写 PRD，拆出 FR 和验收标准 | `docs/prd.md`、`acceptance.json` 骨架 | `trellis-brainstorm`（可选，缺失用内置 PRD 模板）、`cockpit_acceptance` | 范围签核 |
| 3. 架构契约 | 定组件、数据模型、接口、关键决策 | `docs/architecture.md`、`docs/api.md` 或 `docs/openapi.json` | `ponytail`（YAGNI）、`context7`（可选） | 架构技术门 + 架构签核 |
| 4. 原型设计 | 做可点击的静态原型，让人先看界面 | `prototype.html` | `frontend-design`、`ui-ux-pro-max`（可选）、`impeccable`、`playwright`（可选） | 原型通过 |
| 5. 代码开发 | 按任务实现，一次一个任务 | 任务清单、代码、`receipts.jsonl` | `tdd-loop`、`ponytail`、`claude_review` | 无 |
| 6. 测试验证 | 跑测试，留下可复现的报告 | `test-report.json`（非代码项目用 `manual-check.json`） | `verify-claims`、`webapp-testing`（可选）、`playwright`（可选） | 测试技术门 |
| 7. 代码复核 | 独立评审，修掉阻塞问题 | `.dsh/claude-review/ledger/` 或 `.trellis/tasks/<task>/review/` | `claude_review`、`claude-code-review` | 阻塞问题必须为 0 |
| 8. 验收确认 | 人逐条验收，每条通过都要有证据 | `acceptance.json`、`shots/`、diff 图 | `verify-claims`、`webapp-testing`（可选） | 验收签核 |
| 9. 部署发布 | 写发布清单，人批准后发布 | `release.json`（版本、产物 sha256、回滚说明） | `trellis-finish-work`（可选，缺失用 git + 清单模板） | 发布技术门 + 发布批准 |

阶段定义在 `templates/playbook.json`。每个阶段包含：

- `method`：首选方法；
- `constraint`：约束；
- `capabilities`：需要的能力（skill / tool / MCP），以及缺失时的替代方案；
- `deliverables`：产物路径；
- `technicalGate`：自动检查；
- `decisionGate`：人工确认；
- `promptTemplate`：下发给 agent 的指令模板。

项目可以在 `.dsh/plugin-state/playbook.json` 覆盖这些定义。

## 复用了哪些 skill 和功能

插件不安装这些能力，只检测本机是否已安装，并在面板里提示"用哪个、缺什么、替代方案是什么"。

**Trellis 系列**

- `trellis-brainstorm`：需求梳理；
- `trellis-finish-work`：发布收尾；
- Trellis 任务 / 规范 / 账本：代码开发阶段的任务来源。

**设计与前端**

- `frontend-design`：原型设计主方法；
- `ui-ux-pro-max`：设计令牌和组件规范（可选）；
- `impeccable`：UI 质量审计。

**开发与验证**

- `tdd-loop`：测试先行；
- `ponytail`：YAGNI、最小改动；
- `verify-claims`：没有命令输出/证据不算通过；
- `webapp-testing`：Playwright 端到端测试决策树；
- `claude-code-review`：五轴代码复核清单。

**MCP**

- Playwright MCP：浏览器端到端测试；
- Context7 MCP：查框架/库文档。

**插件自带的工具**

- `claude_review`：调用本地 Claude Code CLI 做独立评审；
- `claude_review_disposition`：记录评审问题如何处理；
- `claude_review_install_hook`：安装 pre-commit 评审门禁；
- `cockpit_report`：写执行回执；
- `cockpit_init`：初始化项目状态；
- `cockpit_acceptance`：按 PRD 起草验收条目。

## 产出物

项目里的主要文件：

| 文件 | 内容 |
|---|---|
| `docs/brief.md` | 项目一页说明：目标、用户、约束、不做什么 |
| `docs/prd.md` | 需求文档，功能用 `### FR-N 标题` 表示 |
| `docs/architecture.md` | 组件、数据模型、接口清单、关键决策（ADR） |
| `docs/api.md` / `docs/openapi.json` | 接口契约 |
| `prototype.html` | 可点击的原型 |
| `.trellis/tasks/` | 任务清单（使用 Trellis 时） |
| `.dsh/plugin-state/receipts.jsonl` | 执行回执：谁、在哪个阶段、做了什么、用了什么能力 |
| `.dsh/plugin-state/acceptance.json` | 验收条目、结果、证据 |
| `.dsh/plugin-state/shots/` | 验收截图和 diff 图 |
| `.dsh/plugin-state/test-report.json` | 测试命令、通过/失败数、时间 |
| `.dsh/plugin-state/release.json` | 版本、产物 `{path, sha256}`、回滚说明 |
| `.dsh/plugin-state/approvals.json` | 按迭代记录范围/架构/验收/发布签核 |
| `.dsh/plugin-state/dora.json` | 可选：线上发布与事故记录 |

面板本身产出：

- 项目总览：多个项目当前在哪个阶段、下一步做什么；
- 项目详情：9 阶段、功能账、验收、代码检查、团队、指标；
- 周报：Markdown，包含进度、指标、验收、检查、数据缺口和下一步。

## 如何使用

### 1. 安装

要求 DSH `>=0.2.2-rc.3 <0.3.0`。

```powershell
# 在插件目录安装评审引擎依赖
npm install

# 安装到当前 DSH profile（target 换成插件目录的绝对路径）
plugin_manager(action: "install_bundle", target: "<插件目录绝对路径>")
```

安装后应有六个工具：

`cockpit_report` / `cockpit_init` / `cockpit_acceptance` / `claude_review` / `claude_review_disposition` / `claude_review_install_hook`

### 2. 初始化项目

在项目根目录调用：

```json
{ "cwd": "<项目目录>", "dryRun": false }
```

`cockpit_init` 会创建：

- `.trellis/`（空目录）
- `.dsh/plugin-state/RULES.md`
- `.dsh/plugin-state/project.json`
- `.dsh/plugin-state/playbook.json`
- `.dsh/plugin-state/acceptance.json`

如果想同时把项目升级成完整 Trellis 工程：

```json
{ "cwd": "<项目目录>", "dryRun": false, "trellisInit": true }
```

也可以在面板上点「接通 Trellis」。

### 3. 打开面板

在 DSH 侧栏打开「交付驾驶舱」，选择项目。面板顶部会显示当前阶段和下一步动作；跟着「下一步」做即可。

- 阶段条可以点开任意节点，看目标、方法、约束、产物、检查项和最近记录；
- 功能账显示每个 FR 的状态；
- 验收清单可以逐条点通过/失败/阻塞/撤销；
- 代码检查显示审核问题；
- 团队泳道显示正在工作的会话和子代理；
- 交付指标显示本地代理口径，接入 `dora.json` 后部分指标变为线上数据。

### 4. 让 agent 按流程工作

给 agent 的规则很简单：

1. 先看面板的「下一步」；
2. 按该阶段声明的方法做事；
3. 做完写一条 `cockpit_report` 回执，写清用了哪个 skill/MCP、改了什么、产物在哪；
4. 需要人决定时写 `needs_human_decision`；
5. 不要跳过门禁。

示例回执：

```json
{
  "iteration_id": "v1.0",
  "stage": "implementation",
  "status": "completed",
  "summary_for_human": "完成客户新增接口和表单",
  "used_skill_or_mcp": "tdd-loop",
  "task_ref": "T3",
  "write_scope": ["web/customers/**"],
  "artifacts": ["web/customers/create.tsx"],
  "feature_ids": ["FR-1"]
}
```

### 5. 验收和发布

- 开发完成后，状态机会让 agent 生成验收清单；
- 人在面板逐条验收，通过必须附截图或文件证据；
- 截图可以直接在面板里用本机 Chrome/Edge 截；
- 截图和上一版有像素变化时，之前的"通过"会自动失效，需要人重新确认；
- 验收全部通过并签核后，才进入发布清单；
- 发布清单里的产物必须存在且 sha256 匹配，然后人点发布批准。

### 6. 导出周报

```text
GET /delivery-cockpit/api/report?path=<项目路径>&days=7
```

`days` 支持 `7 / 14 / 30`，返回 Markdown 下载。

## 轻量模式

小改动不需要完整走架构契约。面板顶部可以切换「完整流程 / 轻量模式」。

轻量模式会跳过：

- 架构契约技术门；
- 范围签核；
- 架构签核。

仍然保留原型、测试、验收、发布门。模式存在 `.dsh/plugin-state/project.json` 的 `workflow` 字段：`full` 或 `light`。

## 线上 DORA 数据（可选）

默认指标来自项目本地记录，是代理口径。要使用真实线上数据，在项目里放 `.dsh/plugin-state/dora.json`：

```json
{
  "deployments": [
    {
      "at": "2026-11-23T10:00:00Z",
      "version": "v1.0.1",
      "success": true,
      "leadTimeHours": 8
    }
  ],
  "incidents": [
    {
      "at": "2026-11-23T08:00:00Z",
      "resolvedAt": "2026-11-23T09:00:00Z"
    }
  ]
}
```

接入后：

- 发布频率、变更失败率、交付周期、MTTR 使用线上记录；
- 面板标注「线上数据」；
- 其余指标仍是本地代理；
- 窗口内没有发布记录时，变更失败率显示 `—`，不会显示 0%。

## 开发

```powershell
npm install
npm test                         # node --test "test/*.test.js"，当前 539 个用例
node tools/preview/server.mjs    # 本机预览面板，默认 http://127.0.0.1:4711
```

改 `index.js` / `lib/*` 后重载插件；改 `client.js` 后刷新页面。

> Node 24 下不要用 `node --test test/` 目录形式，使用 `npm test` 或带引号的 glob。

## 目录

```
index.js            Host 半：工具、面板路由、能力探测
client.js           Client 半：总览 + 详情面板
lib/state.js        9 阶段状态机
lib/evidence.js     只读证据聚合
lib/gates.js        架构 / 测试 / 发布技术门
lib/approvals.js    人工签核
lib/acceptance.js   验收表
lib/features.js     功能账
lib/screenshot.js   本机 CDP 截图
lib/png.js          PNG 编解码
lib/visual-diff.js  截图像素对比
lib/metrics.js      交付指标
lib/dora.js         线上 DORA 数据
lib/report.js       周报
lib/model.js        面板模型
lib/route.js        HTTP 路由
lib/trellis.js      Trellis 初始化
lib/review/         评审引擎接入
scripts/            评审引擎
templates/          RULES / playbook / acceptance 模板
test/               单测
tools/preview/      本机预览
```

## 文档

- [docs/VISION.md](docs/VISION.md)：产品定位、阶段和门禁的设计
- [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)：模块、数据形状、HTTP 端点
- [docs/CAPABILITIES.md](docs/CAPABILITIES.md)：能力路由和 skills/MCP 说明
- [docs/DETAIL.md](docs/DETAIL.md)：插件详情页文案
- [DESIGN.md](DESIGN.md)：视觉与文案规范
- [docs/REVIEW-2026-11-23.md](docs/REVIEW-2026-11-23.md)：代码/设计/使用冲突审查记录

## License

MIT
