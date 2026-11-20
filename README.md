# dsh-project-cockpit

DSH 插件 **交付驾驶舱**：把项目的真实状态收拢成一屏——**做到哪了、卡在哪、谁在干、下一步做什么用什么**。

它**接线**：把现成的 agent loop、现成的 skills/MCP、现成的会话与 worktree 连起来，把人需要知道的信息抄到仪表上。
**不复制 agent 的判断**：插件决定"干什么、什么时候、干完没有"，agent 决定"怎么干、用哪个技能、失败怎么办"。

## 文档

- **产品设计（定稿）**：[docs/design.md](docs/design.md) —— 定位、12 条状态机、降级矩阵、能力路由、非目标
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

**测试**：`npm test` = `node --test "test/*.test.js"`，当前 **214 个用例全绿**（含一条从空项目走到下一轮迭代的端到端用例，以及写授权 fail-closed 的专项用例）。

> 勾选只在**实现并通过验收**之后做。`node --test test/`（目录形式）在本机 Node 24 不支持，请用上面的 glob 形式或 `npm test`。

## Phase 2 / 3（未开始，设计 §10）

- Phase 2：Playwright 截图视觉画廊、`acceptance.json` 契约生成 UI、一键发送至对话
- Phase 3：人话账本自动归类、多项目总览增强、并行视图（等宿主开放 Agent Teams 任务板接口）


## 仓库布局

```
index.js            Host 半：两个工具 + 面板路由 + 能力探测
client.js           Client 半：main / sidebar.panellist 两处注册，一屏四区
lib/receipts.js     回执账本（校验 / 追加写 / 容错读 / 迭代与待决策推导）
lib/detect.js       技术栈探测（只读文件，不猜）
lib/project-card.js 项目名片（探测字段 + 人填两字段）
lib/init.js         状态目录初始化（幂等 / dry-run / 只写四个文件）
lib/playbook.js     阶段能力路由（内置 + 项目覆盖 + 存在性检测）
lib/evidence.js     只读证据聚合（trellis / prd / 回执 / 批准 / 验收表 / 任务 / 审核账本）
lib/state.js        状态机：唯一动作
lib/model.js        面板模型（总览行 + 详情一屏四区）
lib/route.js        HTTP 路由（授权 / 读写接口）
templates/          释放到项目的 RULES.md / playbook.json / acceptance.json
test/               node --test 单测与契约断言
tools/preview/      本机预览 + 截图（真实 React + 真实 CSS，用于看不到 GUI 时的视觉验收）
```

## 开发

```powershell
cd D:\Coding\dsh-plugins\dsh-project-cockpit
node --test test/                      # 全部单测
node tools/preview/server.mjs          # 本机预览面板（默认 http://127.0.0.1:4711）
```

改 `index.js` / `lib/*` 需要重载插件（重新启用或重启 DSH）；改 `client.js` 刷新页面即可（本机开发时先确认客户端构建已重跑）。

## 安装

```powershell
plugin_manager(action: "install_bundle", target: "D:\\Coding\\dsh-plugins\\dsh-project-cockpit")
```

需要 DSH `>=0.2.2-rc.3 <0.3.0`。与已装的 `@hunyed15/project-cockpit`（面板 id `project-cockpit`）并存，本插件的行 id / 面板 id 是 `delivery-cockpit`。

## License

MIT
