# Delivery Cockpit · 交付驾驶舱

DSH（DeepSeek Harness）插件：把项目的真实交付状态收拢成一屏——**当前在哪一步、哪个功能做完/没做完/有 bug、卡在哪、下一步做什么、该用哪个能力**。

- 包名：`@hunyed15/delivery-cockpit`
- 插件 / 面板 id：`delivery-cockpit`
- 仓库：https://github.com/hunyed15/delivery-cockpit

## 它做什么

驾驶舱负责**接线**：把 agent loop、skills/MCP、会话与任务账本、验收证据、审核账本连起来，把人需要知道的信息放到仪表上。

它**不复制 agent 的判断**：插件决定"干什么、什么时候、干完没有"，agent 决定"怎么干、用哪个技能、失败怎么办"。所有状态都来自可核对的证据文件或人的操作，读不到就显示 `—` 并说明缺什么，不补 0、不猜。

## 一屏能看什么

- **下一步唯一动作**：状态机根据当前证据给出一个动作（初始化 / 想清楚 / 定架构 / 看原型 / 写代码 / 补测试 / 修审核问题 / 验效果 / 签核 / 发布 / 开下一轮）。
- **9 阶段**：项目立项 → 需求定义 → 架构契约 → 原型设计 → 代码开发 → 测试验证 → 代码复核 → 验收确认 → 部署发布。点任意阶段可只读查看目标、方法、约束、交付物、阶段检查与最近记录。
- **功能账**：从 PRD 的受控结构（`## 功能需求` 下的 `### FR-N`）提取功能，用验收结果、审核 bug、执行回执三路证据推导状态；没有证据就显示 `—`。
- **验收清单**：每条都能在面板里点通过 / 失败 / 阻塞 / 撤销；通过必须有证据，Host 会校验证据文件真实存在。
- **代码检查**：内置独立 Claude Code 评审引擎，面板读取审核账本，显示阻塞问题、已修待复核与最近轮次。
- **团队泳道**：按项目 cwd 列出正在工作的会话与子代理（只读，服务不可用时直说）。
- **交付指标**：交付周期、发布频率、变更失败率、验收通过率、修复时长、待修问题；可接线上 DORA 数据（见下）。

## 工作流与门禁

### 9 阶段与人工签核

每个迭代按 9 阶段推进。关键节点不是"agent 说完成就算"，而是：

| 门 | 依据 |
|---|---|
| 范围签核 | PRD 已存在，人确认这一轮范围 |
| 架构签核 | `docs/architecture.md` + `docs/api.md` / `docs/openapi.json` 通过结构校验 |
| 原型通过 | `prototype.html` 或 `docs/prototype.html` 存在 |
| 测试验证 | `.dsh/plugin-state/test-report.json`（非代码项目可用 `manual-check.json`） |
| 验收签核 | 验收全绿、每条可识别 FR 都有带 `feature_ref` 的验收、证据文件存在 |
| 发布批准 | `release.json` 的产物路径存在且 sha256 匹配，然后人点批准 |

架构 / 测试 / 发布是三道**自动技术门**；其余阶段由状态机规则、执行回执与人工决策门承担。

### 轻量模式

面板 header 可切换「完整流程 / 轻量模式」。轻量模式（`project.json` 的 `workflow: "light"`）跳过架构契约与范围/架构签核，适合小改动；原型、测试、验收、发布门仍然保留。

### Trellis

`cockpit_init` 默认只创建空 `.trellis/`。需要完整 Trellis 工程时，在面板点「接通 Trellis」，或调用 `cockpit_init { trellisInit: true }`；它会运行 `trellis init --dsh`，`evidence.trellis.ready` 表示 trellis-* 技能真的可跑。

## 验收、截图与视觉回归

- 通过必须带证据；证据可以是项目内文件路径或 URL。
- 面板「截图」用本机 Chrome/Edge 的 CDP 截真实页面，保存到 `.dsh/plugin-state/shots/`；只允许回环地址（`127.0.0.1` / `localhost` / `[::1]`），并逐请求拦截非回环地址。
- 每次截图与上一版做像素对比：一致 / 有变化（比例 + 标红 diff 图）/ 新建基线 / 尺寸变化 / 无法对比。
- 视觉有变化时，该条之前的「通过」自动失效，状态机退回「验效果」，并写一条可追溯的执行回执；人重新确认后才放行。
- Agent 可写「验收复核」审计事件，但改验收结果仍由人操作。

## 功能账

功能只从 PRD 的受控结构提取，不解析自由文本：

```markdown
## 功能需求

### FR-1 信号采集（P0）
### FR-2 检索与打分（P1）
```

每条功能状态来自三路证据：

| 证据 | 来源 | 状态 |
|---|---|---|
| 验收通过 + 证据 | `acceptance.json` 中 `feature_ref: "FR-1"`、`result: "pass"`、`evidence[]` | 已完成 |
| 归属的未处置 bug | 审核账本 blocking 的 `file` 命中该功能路径 | 有阻塞 |
| 进行中的回执 | `cockpit_report` 的 `feature_ids: ["FR-1"]` | 进行中 / 待验收 |

回执没写 `feature_ids` 时，会按 `write_scope` / `artifacts` 与任务标题/关联文件自动归属，并在展开行说明"其中 N 条自动归属"；自报优先。

`cockpit_acceptance` 可按 PRD 功能一次性起草验收条目骨架，只追加，不覆盖人已填的结果与证据。

## 代码检查

插件内置独立评审引擎（Claude Code CLI），提供三个工具：

- `claude_review`
- `claude_review_disposition`
- `claude_review_install_hook`

审核账本可在 `.trellis/tasks/<task>/review/` 或 `.dsh/claude-review/ledger/`；面板「代码检查」读同一份账本。引擎文件随插件发布在 `scripts/`，ACP 依赖通过 `npm install` 安装。

## 交付指标与周报

面板「交付指标」模块默认是**本地代理口径**：来自执行回执、审核账本、验收表，不是线上监控。数据不足显示 `—` 并说明原因。

可选接入线上 DORA 数据：`.dsh/plugin-state/dora.json`

```json
{
  "deployments": [
    { "at": "2026-11-23T10:00:00Z", "version": "v1.0.1", "success": true, "leadTimeHours": 8 }
  ],
  "incidents": [
    { "at": "2026-11-23T08:00:00Z", "resolvedAt": "2026-11-23T09:00:00Z" }
  ]
}
```

接入后，发布频率 / 变更失败率 / 交付周期 / MTTR（线上恢复时长）使用真实记录（交付周期需部署记录带 `leadTimeHours`），面板标注「线上数据」；其余指标仍是本地代理。窗口内没有发布记录时，变更失败率显示 `—`，不会显示 0%。

header「导出周报」下载 Markdown：`GET /delivery-cockpit/api/report?path=…&days=7`，`days` 支持 `7 / 14 / 30`，同时作为指标窗口。

## 安装

环境要求：DSH `>=0.2.2-rc.3 <0.3.0`。

```powershell
# 在插件目录安装评审引擎依赖
npm install

# 安装到当前 DSH profile
plugin_manager(action: "install_bundle", target: "<插件目录绝对路径>")
```

安装后 `listTools` 应能看到六个工具：

`cockpit_report` / `cockpit_init` / `cockpit_acceptance` / `claude_review` / `claude_review_disposition` / `claude_review_install_hook`

## 数据文件

插件只写 `.dsh/plugin-state/`（初始化时额外创建空 `.trellis/`）；显式点「接通 Trellis」时由 `trellis init` 写项目文件；审核引擎按自己的账本路径写入。

| 文件 | 用途 |
|---|---|
| `RULES.md` | 项目执行规则 |
| `project.json` | 项目名片：名称、技术栈、命令、`workflow: full/light` |
| `playbook.json` | 阶段能力路由（可覆盖内置） |
| `acceptance.json` | 验收条目、结果与证据 |
| `approvals.json` | 按迭代记范围/架构/验收/发布签核 |
| `test-report.json` | 测试命令、通过/失败数、时间 |
| `manual-check.json` | 非代码项目的人工检查单 |
| `release.json` | 版本、产物 `{path, sha256}`、回滚说明 |
| `dora.json` | 可选的线上发布/事故记录 |
| `receipts.jsonl` | 执行回执流水账 |

## 开发

```powershell
npm install
node --test "test/*.test.js"     # 全部单测（当前 539 个用例）
node tools/preview/server.mjs    # 本机预览面板，默认 http://127.0.0.1:4711
```

改 `index.js` / `lib/*` 后重载插件；改 `client.js` 后刷新页面（本机开发时先确认客户端构建已重跑）。

> 目录形式的 `node --test test/` 在 Node 24 不可用，请使用上面的 glob 形式或 `npm test`。

## 目录

```
index.js            Host 半：六个工具 + 面板路由 + 能力探测
client.js           Client 半：main / sidebar.panellist，两处入口
lib/state.js        状态机：给出下一步唯一动作
lib/evidence.js     只读证据聚合（trellis / PRD / 回执 / 签核 / 验收 / 任务 / 审核 / 门禁）
lib/gates.js        架构 / 测试 / 发布技术门校验
lib/approvals.js    人工签核（按迭代落盘，前置校验）
lib/acceptance.js   验收表起草与结果写入
lib/features.js     功能账（PRD 受控结构 + 三路证据 + bug 归属）
lib/screenshot.js   本机 CDP 截图（回环限制 + 逐请求拦截）
lib/png.js          最小 PNG 编解码
lib/visual-diff.js  像素对比与 diff 图
lib/metrics.js      交付指标（代理 + 线上 DORA）
lib/dora.js         可选线上数据读取
lib/report.js       周报 Markdown
lib/model.js        面板模型（总览 + 详情）
lib/route.js        HTTP 路由
lib/trellis.js      Trellis 初始化
lib/review/         评审引擎接入层（引擎/工具/账本/配置）
scripts/            随包发布的评审引擎
templates/          释放到项目的 RULES / playbook / acceptance 模板
test/               node --test 单测与契约断言
tools/preview/      本机预览与截图（真实 React + CSS）
```

## 文档

- [docs/VISION.md](docs/VISION.md) —— 产品定位、9 阶段、门禁与边界
- [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) —— 模块接口、数据形状、HTTP 端点、测试清单
- [docs/CAPABILITIES.md](docs/CAPABILITIES.md) —— 能力路由与 skills/MCP 说明
- [docs/DETAIL.md](docs/DETAIL.md) —— 插件详情页文案
- [DESIGN.md](DESIGN.md) —— 视觉与文案系统
- [docs/REVIEW-2026-11-23.md](docs/REVIEW-2026-11-23.md) —— 代码 / 设计 / 使用冲突审查与修复记录

## License

MIT
