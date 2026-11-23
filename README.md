# dsh-project-cockpit

DSH 插件 **交付驾驶舱**：把项目的真实状态收拢成一屏——**哪个功能做完/没做完/有 bug、卡在哪、下一步做什么用什么**。

它**接线**：把现成的 agent loop、现成的 skills/MCP、现成的会话与 worktree 连起来，把人需要知道的信息抄到仪表上。
**不复制 agent 的判断**：插件决定"干什么、什么时候、干完没有"，agent 决定"怎么干、用哪个技能、失败怎么办"。

## 合并说明（只需安装本插件）

从 **v0.2.0** 起，旧的 `@hunyed15/project-cockpit`（v3.0.0）的 **独立评审引擎 + 工具 + 账本**已并入本插件：

- 引擎 `scripts/Invoke-ClaudeReview.ps1`（含 `acp-review.mjs` / `review-schema.json` / `reviewer-role.md` / `config.json` / hook 安装器）随本插件发布；
- 三个工具现由本插件提供：`claude_review`、`claude_review_disposition`、`claude_review_install_hook`，参数与输出契约不变；
- 审核账本位置不变：`.trellis/tasks/<task>/review/` 或 `.dsh/claude-review/ledger/`，面板「代码检查」模块读的就是同一份账本；
- **不再需要同时装两个插件**：装好本插件后，旧 `@hunyed15/project-cockpit` 可禁用或卸载（它的旧面板路由 `/claude-review/api`、`/project-cockpit` 与旧 cockpit 总览不随本插件迁移）。

## 功能账（面板的核心）

功能清单只来自 `prd.md` 的**受控结构**（不解析自由文本）：

```markdown
## 功能需求

### FR-1 信号采集（P0）
### FR-2 检索与打分（P1）
```

每条功能的状态由**三路证据**推导，缺哪路就显示 `—`、不补 0：

| 证据 | 来源 | 推导出的状态 |
|---|---|---|
| 验收通过 + 证据 | `acceptance.json` 条目 `feature_ref: "FR-1"` + `result:"pass"` + `evidence[]` | 已完成 |
| 归属的未处置 bug | 审核账本 blocking 的 `file` 命中该功能的路径（回执 `write_scope`） | 有阻塞 |
| 进行中的回执 | `cockpit_report` 的 `feature_ids: ["FR-1"]` | 进行中 / 待验收 |

配套规则：没有可归属路径的功能，待修列显示 `—`；未归属的 bug 单列；PRD 没识别到 `### FR-N` 时直说并给格式提示。

**回执自动归属（可解释、可覆盖）**：回执没写 `feature_ids` 时，按它的 `write_scope`/`artifacts` 与「任务标题里的 `FR-3` + `relatedFiles`」反推归属；写了 `feature_ids` 就以自报为准、不再推断。展开行会写明"其中 N 条自动归属"。

**验收起草**：走到"生成验收清单"时，指令会点名还缺哪几条 `FR-x`，Agent 用 `cockpit_acceptance` 一次写入条目骨架（`result` 留空）；该工具**只追加，绝不覆盖**人已经填好的结果与证据。

## 交付指标 + 周报（P3）

面板主区新增「交付指标」模块（项目进度之后、功能之前）：**交付周期 / 近 7 天发布 / 返工率 / 验收通过率** 四张数卡 + **修复时长 / 待修问题** 两条小指标。

- **全部是代理口径**：插件只有项目本地的执行回执、审核账本与验收表，拿不到 CI / 发布系统 / 线上监控；每个指标都带一句人话口径与来源，数据不足显示 `—`（含原因），不补 0。
- 交付周期 = 迭代内首条回执 → 该迭代 release 完成的**中位时长**；发布频率 = 近 7 天 release 完成回执数；返工率 = 近 30 天审核轮次里 `fix/reject` 的占比；修复时长 = 审核未通过 → 首次 `fixed` 处置的中位时长；验收通过率 = `pass / 有结果条目`（stale 计入分母）。
- header 新增「导出周报」：`GET /delivery-cockpit/api/report?path=…&days=7` 直接下载 Markdown（概览 / 交付指标 / 功能进度 / 验收 / 代码检查 / 最近动态 / 下一步，含**数据缺口**与代理口径脚注）。`days` 只接受 `7 / 14 / 30`，默认 `7`（配置键 `reportDays`）。

## 文档

- **产品设计（8 阶段旧稿，已归档）**：[docs/archive/design-8stage-v0.md](docs/archive/design-8stage-v0.md) —— 定位、12 条状态机、降级矩阵、能力路由、非目标
- **实现契约**：[docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) —— 模块接口、数据形状、HTTP 端点、测试清单
- **插件详情页文案**：[docs/DETAIL.md](docs/DETAIL.md)
- **参考实现（设计期草稿）**：[reference/](reference/) —— 账本模块与 11 条断言（已跑通，后续被 `lib/receipts.js` 取代）

## 状态

**Phase 1（V1.0）已实现并真机验收**，对应设计 §10 第一阶段：

- [x] 包骨架、bundle patch、locale/icon/详情页
- [x] `.dsh/plugin-state/` 初始化（幂等 + dry-run）
- [x] 技术栈探测（读文件）与项目名片
- [x] `cockpit_report` 强类型工具（含 `output` 声明 + 断言）
- [x] 账本读取 + 坏行降级
- [x] 冷启动 + 迭代环状态机（design §7，14 条优先级）
- [x] Playbook 加载与能力存在性检测
- [x] 一屏四区面板（总览 → 详情）
- [x] 真机安装验收：`application: applied`、`listTools` 可见两工具、两处 slot 已注册、HTTP 路由 200/403/409 实测、二次 init 幂等
- [x] 原型批准最小写路径（`POST /approve-prototype`，按 `iteration_id` 落盘）—— 没有它状态机第 4 条永远过不去；视觉画廊仍属 Phase 2
- [x] **功能账（V1.0.1）**：PRD `### FR-N` 提取 + 三路证据状态 + 缺陷按路径归属 + 未归属单列（用户反馈后补齐，取代原来的回执流水账）
- [x] **自动归属 + 验收起草（V1.0.2）**：回执按任务 `relatedFiles`/FR 标题自动归属（自报优先、可解释）；`cockpit_acceptance` 按 PRD 功能起草验收条目（只追加不覆盖）
- [x] **面板内填验收结果（V1.0.3）**：验收清单每条都有 `通过 / 失败 / 阻塞 / 撤销`；`通过` 强制证据且 Host 校验文件真实存在，写接口只允许已登记工作区 + 同源
- [x] **面板一键截图当证据（V1.0.4）**：本机 Chrome/Edge 无头 CDP 截真实页面（不依赖 Playwright），存 `.dsh/plugin-state/shots/` 并挂到证据；面板显示缩略图；只允许回环地址；截图不改验收结果
- [x] **截图自动对比上一版（V1.0.5）**：每次截图与该条上一版做像素对比（容差 + 占比阈值），给出一致 / 有变化（比例 + 标红 diff 图）/ 新建基线 / 尺寸变了 / 无法对比；阈值可配
- [x] **视觉变化联动「验效果」阶段门（V1.0.6）**：截图有变化 ⇒ 该条之前判的「通过」自动失效（结果保留为历史），状态机退回「验效果」并点名「N 条因截图变化失效」，人重新确认后才放行
- [x] **失效留痕（V1.0.7）**：每次失效自动追加一条 `cockpit_report` 回执（阶段=验效果、带截图证据与功能编号），执行流水账可追溯"哪次截图让哪条验收失效"
- [x] **Agent 主动写验收复核（V1.0.8）**：`cockpit_report` 支持 `event:"acceptance-recheck"`（必须 verification/completed），流水账可见「验收复核」徽章；审计事件不参与进度投影，改结果仍由人点
- [x] **阶段只读切换（V1.4.1）**：点 9 阶段节点查看该阶段的目标/方法/约束/交付物/阶段检查/记录（只读，不改下一步，Esc 或「回到当前」关闭）
- [x] **人工签核（P1，V1.5.0）**：playbook 的 decisionGate 从声明变成真按钮、真门禁——范围签核 / 架构签核 / 验收签核 / 发布批准各走 `POST /approve`，前置由 Host 校验（PRD / 契约文件 / 验收全绿 / 发布清单），状态机插入 4.2 / 4.6 / 12.2 / 12.8；原型通过保留不变
- [x] **阶段详情显示签核状态（P1 收尾）**：每个阶段的「需要你确认」直接显示已签核 / 未签核（warn/success）+ 签核时间，点开阶段节点就能看到，不用回头翻 approvals.json
- [x] **缺失能力给替代 / 安装指引（P1 收尾）**：playwright / context7 / grilling / trellis-* / webapp-testing / claude_review 等已知缺失能力，hero 与阶段详情直接给「替代：…」与「安装：label」（链接 / 可复制命令，只展示、不自动安装）；未知能力不编造
- [x] **团队泳道（P1 收尾）**：右栏「团队」按项目 cwd 列出会话与子代理（名字 + 角色/层级 + 在线/空闲），子代理按层级缩进；只读、服务未暴露时直说读不到
- [x] **面板阶段检查（V1.4.0）**：hero 显示阶段检查状态（通过/未通过/未就绪）+ 方法/约束/交付物；数据来自 `panel.gates`
- [x] **技术门 + 能力校验（V1.4.0）**：`cockpit_report` 写前校验阶段 Method（constraint 不能冒充）；架构契约/测试报告/发布清单三个技术门接入状态机（4.5/6.5/12.5）与面板下一步
- [x] **9 阶段模型（V1.3.0）**：项目立项 / 需求定义 / 架构契约 / 原型设计 / 代码开发 / 测试验证 / 代码复核 / 验收确认 / 部署发布；旧账本 stage 自动归一；playbook v2 声明 method/constraint/deliverables/technicalGate/decisionGate
- [x] **状态色体系（V1.2.1）**：模块图标底片 + 摘要数字按语义上色（tone：brand/success/warn/error/idle，全 token）、hero 阶段色带、功能行细进度条
- [x] **模块化工作台（V1.2.0）**：画布/卡片/模块头三层表面 + 8 个 inline SVG 图标 + 字重阶梯（22/700 仅 hero、正文 400），主区与右栏全部模块化，彻底告别"白底粗字列表"
- [x] **可用性四件事（V1.1.1）**：空态给下一步动作、功能行展开能看到该功能的验收并可「去验收」跳转高亮、项目动态按今天/本周/更早分组、舒适/紧凑密度切换 + j/k/Enter/Esc 键盘导航（输入框内不劫持）
- [x] **人话化 + 两栏看板（V1.1.0）**：界面按「给人读状态」重做——header 一句人话摘要、摘要条带完整标签、功能/验收改成 Linear 式列表行（技术细节折叠）、右栏「需要你决定/代码检查/项目动态」；内部词全部换成人话（卡点/待修问题/需要重新确认/没通过…），`docs/DESIGN.md` 记录视觉与文案系统
- [x] **评审引擎合并（0.2.0）**：旧 `@hunyed15/project-cockpit` 的独立评审引擎（`scripts/` 原样）与 `claude_review` / `claude_review_disposition` / `claude_review_install_hook` 三个工具并入本插件；账本路径与配置键沿用，面板「代码检查」读同一份账本，旧插件可禁用/卸载（旧面板路由与 cockpit 总览不迁移）
- [x] **交付指标 + 周报导出（P3）**：主区「交付指标」模块（交付周期 / 近 7 天发布 / 返工率 / 验收通过率 + 修复时长 / 待修问题），全部标注代理口径与数据缺口；header「导出周报」走 `GET /report` 下载 Markdown（`days=7/14/30`，默认 7，配置键 `reportDays`）

**测试**：`npm test` = `node --test "test/*.test.js"`，当前 **508 个用例全绿**。全局 skill 已装 22 个（Trellis 12 + grilling 2 + webapp-testing 等）；本机 MCP 已接 Playwright + Context7。（含端到端状态机推进、人工签核四门与前置失败、功能账三路证据与自动归属、验收起草/结果写入/失效联动与留痕、截图引擎与 PNG 对比/CRC 边界、技能可见性、能力建议映射、团队泳道读取、写授权 fail-closed 专项；合并进来的评审三工具：schema/render、命令行拼装、结论归一、dryRun 真实干跑、处置账本写入、hook 安装；以及 P3：指标口径/0 与 null/窗口边界/坏行与 2000 行上限、周报排版与管道符转义、`/report` 授权与下载头）。

> 勾选只在**实现并通过验收**之后做。`node --test test/`（目录形式）在本机 Node 24 不支持，请用上面的 glob 形式或 `npm test`。

## Phase 2 / 3（未开始，设计 §10）

- Phase 2：Playwright 截图视觉画廊、`acceptance.json` 契约生成 UI、一键发送至对话
- Phase 3：人话账本自动归类、多项目总览增强、并行视图（等宿主开放 Agent Teams 任务板接口）；其中「交付指标（DORA 代理口径）+ 项目周报导出」已随 P3 落地（见上）


## 仓库布局

```
index.js            Host 半：六个工具 + 面板路由 + 能力探测
client.js           Client 半：main / sidebar.panellist 两处注册，一屏四区
lib/receipts.js     回执账本（校验 / 追加写 / 容错读 / 迭代与待决策推导）
lib/detect.js       技术栈探测（只读文件，不猜）
lib/project-card.js 项目名片（探测字段 + 人填两字段）
lib/init.js         状态目录初始化（幂等 / dry-run / 只写四个文件）
lib/playbook.js     阶段能力路由（内置 + 项目覆盖 + 存在性检测）
lib/recommend.js    缺失能力的替代 / 安装建议（写死映射，未知能力不编造）
lib/team.js         团队泳道（按项目 cwd 读会话/子代理，服务缺失不抛）
lib/features.js     功能账（PRD 受控结构提取 + 三路证据状态推导 + bug 路径归属 + 回执自动归属）
lib/acceptance.js   验收表起草（只追加不覆盖；坏表/跨迭代拒绝写入）
lib/evidence.js     只读证据聚合（trellis / prd / 回执 / 批准 / 验收表 / 任务 / 审核账本）
lib/metrics.js      交付指标（DORA 代理口径：审核账本容错读 + 纯函数计算）
lib/report.js       周报导出（纯函数：详情 + 指标 → Markdown）
lib/state.js        状态机：唯一动作
lib/model.js        面板模型（总览行 + 详情一屏四区）
lib/route.js        HTTP 路由（授权 / 读写接口）
lib/review/         评审引擎合并层：engine（定位/命令行/归一）、tools（三个工具）、ledger（处置账本）、settings
scripts/            随包发布的评审引擎（Invoke-ClaudeReview.ps1 / acp-review.mjs / schema / role / hook 安装器）
templates/          释放到项目的 RULES.md / playbook.json / acceptance.json
test/               node --test 单测与契约断言
tools/preview/      本机预览 + 截图（真实 React + 真实 CSS，用于看不到 GUI 时的视觉验收）
```

## 开发

```powershell
cd D:\Coding\dsh-plugins\dsh-project-cockpit
npm install                            # 拉评审引擎的 ACP 依赖（claude-agent-acp / acp sdk）
node --test "test/*.test.js"           # 全部单测
node tools/preview/server.mjs          # 本机预览面板（默认 http://127.0.0.1:4711）
```

改 `index.js` / `lib/*` 需要重载插件（重新启用或重启 DSH）；改 `client.js` 刷新页面即可（本机开发时先确认客户端构建已重跑）。

## 安装

```powershell
plugin_manager(action: "install_bundle", target: "D:\\Coding\\dsh-plugins\\dsh-project-cockpit")
```

需要 DSH `>=0.2.2-rc.3 <0.3.0`。本地源码安装前先在本目录执行 `npm install`（评审引擎的 ACP 依赖）；安装后 `listTools` 应能看到六个工具：`cockpit_report` / `cockpit_init` / `cockpit_acceptance` / `claude_review` / `claude_review_disposition` / `claude_review_install_hook`。

本插件的行 id / 面板 id 是 `delivery-cockpit`。从 v0.2.0 起它已内置旧 `@hunyed15/project-cockpit` 的评审能力，**只装这一个插件即可**；旧插件可禁用/卸载（见上面「合并说明」）。

## License

MIT
