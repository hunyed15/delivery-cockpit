# 实现契约（Phase 1 / V1.0）

> 本文件是实现期的**唯一接口事实源**。产品设计见 [design.md](design.md)（定稿，不改）。
> 多个 agent 并行写代码时，只按这里写的签名与形状对接；任何偏离都要先改本文件再改代码。

## 0. 包身份（避免与已装插件冲突）

| 项 | 值 | 理由 |
|---|---|---|
| 包名 | `@hunyed15/delivery-cockpit` | 已发布的 `@hunyed15/project-cockpit` v3.0.0 仍装着；两名不能相同 |
| bundle 行 id | `delivery-cockpit` | 同上 |
| 面板 slot id/key | `delivery-cockpit` | `main` 是 keyed 槽，复用已占 key 会顶掉别人的面板 |
| 侧栏入口 | `sidebar.panellist` id=`delivery-cockpit`，label=`交付` | 与 `main` key 必须一致才联动 |
| HTTP 前缀 | `/delivery-cockpit/api` | 与 `/project-cockpit` 并存 |
| 状态目录 | `<项目>/.dsh/plugin-state/` | design §5.4 |
| 显示名 | 交付驾驶舱 | locale `meta.title` |

运行环境：DSH `>=0.2.2-rc.3 <0.3.0`（实测 `0.2.2-rc.5`），Node 24，Windows。

## 1. 文件归属（并行写作用域）

| 负责人 | 文件 |
|---|---|
| **A 数据层** | `lib/receipts.js` `lib/detect.js` `lib/project-card.js` `lib/init.js`，`test/receipts.test.js` `test/detect.test.js` `test/project-card.test.js` `test/init.test.js` |
| **B 业务层** | `lib/playbook.js` `lib/evidence.js` `lib/state.js` `lib/model.js`，`test/playbook.test.js` `test/evidence.test.js` `test/state.test.js` `test/model.test.js` |
| **C 界面层** | `client.js` `test/client-smoke.test.js` `tools/preview/**` |
| **Lead 接线** | `package.json` `cordis.patch.yml` `index.js` `lib/route.js` `lib/approvals.js` `locale/*.json` `icon.svg` `templates/acceptance.json` `docs/DETAIL.md` `README.md` `test/route.test.js` `test/tool-contract.test.js` |

共同规则：

- 纯 ESM（`"type": "module"`），**不引任何第三方依赖**，只用 `node:*`。
- 纯模块（A/B）**不 import DSH 包**、不读环境变量、不 console.log；I/O 只读写给定路径。
- 测试用 `node --test test/xxx.test.js`，一律用 `mkdtemp` 临时目录，不碰真实项目。
- 注释写"为什么"，不写"是什么"；中文。
- **绝不造假**：读不到就是 `null` / `missing` / `unknown`，不默认 0、不猜。

## 2. 存储格式

### 2.1 `.dsh/plugin-state/receipts.jsonl`

一行一条，追加写，永不改历史。字段（`lib/receipts.js` 校验后落盘）：

```json
{"id":"r-ab12cd34","at":"2026-11-20T14:40:12.000Z","iteration_id":"v1.0","stage":"coding",
 "status":"completed","summary_for_human":"客户列表接口跑通",
 "used_skill_or_mcp":"test-driven-development","artifacts":["web/orders/list.ts"],
 "task_ref":"T3","write_scope":["web/orders/**"],"needs_human_decision":null}
```

- `stage` ∈ `bootstrap|requirements|architecture|prototype|implementation|testing|code-review|acceptance|release`（canonical 9 阶段）。**旧账本读取时归一、内部 `appendReceipt` 写入时归一；`cockpit_report` 工具入口只接受 canonical id（schema enum）**，见 §2.7。
- `event`（可选）：**审计事件**，当前有 `acceptance-stale`（插件写的验收失效留痕）与 `acceptance-recheck`（Agent 主动写的验收复核留痕）。带 `event` 的回执只出现在流水账里，
  **不参与阶段进度/功能状态/待决策投影**（否则会让「验效果」长期停在进行中、功能显示进行中，与状态机自相矛盾）。
- `status` ∈ `in_progress|completed|blocked|failed|dropped`
- `iteration_id`：冷启动固定 `"bootstrap"`；迭代环用 `v1.0` / `v1.1` 等
- `implementation` 阶段强制 `task_ref` 非空 + `write_scope` 非空数组（旧 `coding` 别名归一到它后同样强制）
- `needs_human_decision` 非空对象 ⇒ 待人工决策（`title` 必填）
- 坏行：读取时跳过并计入 `badLines`，不抛错

### 2.2 `.dsh/plugin-state/project.json`（项目名片）

```json
{"schemaVersion":1,"name":"客户管理","oneLiner":"给小团队用的客户跟进工具",
 "stack":{"id":"next","label":"Web / Next.js"},
 "commands":{"dev":"pnpm dev","build":"pnpm build","previewUrl":null},
 "detectedAt":"2026-11-20T14:00:00.000Z","updatedAt":"2026-11-20T14:00:00.000Z"}
```

- `name`/`oneLiner` 是**人填字段**：探测与刷新**永不覆盖**非空值；空则保留空（`oneLiner` 空 ⇒ 名片状态 `needs-human`）。
- `name` 默认取目录名（这是确定性回退，不是编造）。
- `detectedAt` 只在探测成功时更新；`stack.id === "unknown"` 表示"未检测到"，不是"没有技术栈"。

### 2.3 `.dsh/plugin-state/playbook.json`（项目覆盖）

内置默认在包内 `templates/playbook.json`（version 2，9 阶段）。项目覆盖文件的合并规则：

- 顶层 `missingHints`：按 key 覆盖；
- `stages`：同名 stage **整体替换**（不做深合并，避免半覆盖产生语义不明的阶段）；未提到的 stage 保留内置；
- **version 不一致**：项目覆盖的 `version` 与内置不同（如旧 `version: 1` + 8 个中文阶段 key）⇒ **忽略覆盖里的 `stages`**，保留内置 9 阶段，只让 `missingHints` 等非 stage 字段覆盖，并记一条 warning；
- 非法 JSON / 结构不是对象 / `stages` 不是对象 ⇒ 忽略覆盖 + 一条 warning，回退内置（绝不半信半疑）。

**canonical stage 对应关系（代码常量 `STAGE_DEFS`，写死一次）**：

| receipt `stage` | playbook key | 4 字阶段名 | 轨 |
|---|---|---|---|
| `bootstrap` | 项目立项 | 项目立项 | 冷启动 |
| `requirements` | 需求定义 | 需求定义 | 迭代环 |
| `architecture` | 架构契约 | 架构契约 | 迭代环 |
| `prototype` | 原型设计 | 原型设计 | 迭代环 |
| `implementation` | 代码开发 | 代码开发 | 迭代环 |
| `testing` | 测试验证 | 测试验证 | 迭代环 |
| `code-review` | 代码复核 | 代码复核 | 迭代环 |
| `acceptance` | 验收确认 | 验收确认 | 迭代环 |
| `release` | 部署发布 | 部署发布 | 迭代环 |

**遗留别名（读取归一 + 内部写归一；工具入口只接受 canonical）**：

| 旧 `stage` | 归一为 |
|---|---|
| `init` / `scaffold` | `bootstrap` |
| `brainstorm` | `requirements` |
| `coding` | `implementation` |
| `code_review` | `code-review` |
| `verification` | `acceptance`（旧「验效果」是人工验收，**不是**新 `testing`） |
| `prototype` / `release` | 同名 |

playbook stage 条目字段：`goal`、`capabilities[]`（旧检测形状 `{kind,name,mode?,optional?,note?}`）、`method`（该阶段唯一方法字符串）、`constraint`（至多一个）、`deliverables`（字符串数组）、`technicalGate`（可空）、`decisionGate`（可空 `{title,approveAction}`）、`promptTemplate` / `exitGate` / `redLines`。本轮只做**声明与透传**，`validate*` 门禁校验器与三校验器下一轮实现。

playbook 条目若自带 `stageId` 字段则以它为准（给项目覆盖留的口子），旧 id 也会先归一。

### 2.4 `.dsh/plugin-state/approvals.json`（人工签核，按迭代）

```json
{"v1.0":{
  "prototypeApprovedAt":"2026-11-20T22:10:00+08:00","prototype":"prototype.html",
  "scopeApprovedAt":"2026-11-20T22:20:00+08:00",
  "architectureApprovedAt":"2026-11-20T22:30:00+08:00",
  "acceptanceApprovedAt":"2026-11-21T10:00:00+08:00",
  "releaseApprovedAt":"2026-11-21T18:00:00+08:00"}}
```

- 必须按 `iteration_id` 存；`bootstrap` 不算任何迭代的批准。
- 文件缺失/坏 JSON ⇒ 视为"没有批准"（不是报错）；坏 JSON 记一条 warning 并降级。
- 每条迭代记录固定这 6 个字段：原型 `prototypeApprovedAt`/`prototype`（既有），加四个决策门时间
  `scopeApprovedAt`/`architectureApprovedAt`/`acceptanceApprovedAt`/`releaseApprovedAt`（ISO 字符串或 `null`）。
  旧文件缺新字段 ⇒ 读成 `null`（= 没签），不报错。
- 一条记录只按迭代存一次；每次签核只更新自己那一门的时间字段，其它字段原样保留（原子写：临时文件 + rename）。
- 读写实现见 `lib/approvals.js`（`evidence.js` 直接 import，不要另写一份解析）：
  - `readApprovals(projectPath)` → `{ map, badJson, missing }`
  - `approvalFor(map, iterationId)` → `{ approved, at, file }`（原型用；bootstrap 恒 false。**条目存在 ≠ 原型已批准**：P1 起先签范围/架构也会建条目，所以看 `prototypeApprovedAt`/`prototype` 本身）
  - `decisionsFor(map, iterationId)` → `{ scope:{approved,at}, architecture:{...}, acceptance:{...}, release:{...} }`（bootstrap/空迭代/缺条目/某门没签 ⇒ 对应门 false）
  - `findPrototype(projectPath)` → `prototype.html` / `docs/prototype.html` 的相对路径或 `null`
  - `approvePrototype(projectPath, iterationId)` → `{ok:true,approval}` / `{ok:false,error:'iteration-required'|'prototype-missing'}`
  - `approveDecision(projectPath, iterationId, gate)` → 见 §3.19；gate ∈ `scope|architecture|prototype|acceptance|release`

### 2.5 `.dsh/plugin-state/acceptance.json`（人话验收表）

```json
{"schemaVersion":1,"iteration_id":"v1.0","items":[
  {"id":"A1","title":"能添加客户","steps":"打开客户页 → 点新增 → 填名字 → 保存",
   "expect":"列表出现新客户","result":null,"evidence":[],"at":null}]}
```

- `items` 空数组 ⇒ **未通过**（"空表不算通过"）。
- `result` ∈ `null|pass|fail|blocked`；`null` 永不等于 pass。
- `pass` 必须 `evidence` 非空才算"有证据的通过"（Phase 1 只做读取与判定，Phase 2 做证据截图 UI）。
- `iteration_id`：`null`/缺失 ⇒ "未绑定迭代"，视作对当前迭代有效；是字符串且 ≠ 当前迭代 ⇒ **视为过期**（`appliesToCurrent:false`，进 `dataGaps`，不参与通过判定），防止 v1.1 误读 v1.0 的验收表。模板默认 `null`。

### 2.6 其他只读数据源（不写）

- `prd.md`：依次探测 `<root>/prd.md`、`<root>/docs/prd.md`、`<root>/PRD.md`，取第一个存在的，返回路径；都没有 ⇒ `found:false`。
- `.trellis/tasks/*/task.json`：只读 `id/title/status`；`status !== "completed"` 记为未完成。最多读 200 个。
- 审核账本（可选适配器）：本地 `.dsh/claude-review/ledger/review/`，或 Trellis `<task>/review/`。口径复用既有的 `report.review.issues` + `meta.failOn` + `dispositions.jsonl`（`fixed|deferred|counter-evidence` 视为已处置）。**缺失 ≠ 故障**，要区分 `reason`。
- `.trellis/` 与 `RULES.md`：`initialized = .trellis 目录存在 && RULES.md 存在`；只有其一则 `partial`，按未初始化处理但把原因写进 UI。

## 3. 模块接口（逐字对接）

### 3.1 A · `lib/receipts.js`

以 `reference/receipts.js` 为起点搬入，导出保持不变并补充：

```js
export const STAGES            // 顺序：bootstrap, requirements, architecture, prototype, implementation, testing, code-review, acceptance, release
export const LEGACY_STAGE_ALIASES // init/scaffold→bootstrap, brainstorm→requirements, coding→implementation, code_review→code-review, verification→acceptance
export function normalizeStage(stage) // 旧 id → canonical；未知返回 null
export const STATUSES          // in_progress, completed, blocked, failed, dropped
export const BOOTSTRAP_ITERATION = 'bootstrap'
export const stateDirOf(projectPath)
export const receiptsPathOf(projectPath)
export function validateReceipt(input)        // -> {ok:true,value} | {ok:false,error:string}
export async function appendReceipt(projectPath, input) // -> {ok:true,receipt} | {ok:false,error}
export async function readReceipts(projectPath)  // -> {receipts, badLines, lastAt, missing}
export async function readReceiptsFromText(text)  // 新：纯函数化读取，供 evidence 复用它做一次读盘
export function currentIteration(receipts)     // -> iterationId ('bootstrap' 兜底)
export function pendingDecision(receipts)      // -> receipt|null
export function stageStates(receipts, iterationId) // -> Map<stage,{status,at,summary}>
export function receiptsForIteration(receipts, iterationId) // 新：该迭代的全部回执（时间正序）
```

`appendReceipt` 写失败必须抛/返回错误，**不许静默丢数据**。

### 3.2 A · `lib/detect.js`

```js
export async function detectStack(projectPath)
// -> { id, label, packageManager, commands:{dev,build,previewUrl}, evidence:[{file,detail}], notes:string[] }
```

- 顺序（先命中先返回，但 `package.json` 与生态文件都读）：
  1. `package.json` → `packageManager`（`packageManager` 字段 > lock 文件：`pnpm-lock.yaml`→pnpm、`yarn.lock`→yarn、`bun.lockb`→bun、`package-lock.json`→npm）
     - 依赖里命中：`next`→`next`／`nuxt`→`nuxt`／`astro`→`astro`／`@sveltejs/kit`→`svelte`／`vue`→`vue`／`react-dom`→`react`／`electron`→`electron`；否则 `node`
     - `dev`: `scripts.dev`→`<pm> dev`；否则 `scripts.start`→`<pm> start`；否则 `null`
     - `build`: `scripts.build`→`<pm> build`；否则 `null`
     - label 例：`Web / Next.js`、`Web / Vite + React`、`Node.js`
  2. `Cargo.toml` → `rust` / `Rust`，dev `cargo run`，build `cargo build`
  3. `go.mod` → `go` / `Go`，dev `go run .`，build `go build ./...`
  4. `pubspec.yaml` → `flutter` / `Flutter`，dev `flutter run`，build `flutter build`
  5. `pyproject.toml` / `requirements.txt` → `python` / `Python`，dev `null`，build `null`（不猜框架），note 说明未识别启动命令
  6. `pom.xml` → `java` / `Java (Maven)`；`build.gradle`→`java` / `Java (Gradle)`；dev/build 用规范命令（`mvn spring-boot:run` / `./gradlew bootRun` 只在 `spring-boot` 依赖出现时给，否则 `null`）
  7. `composer.json` → `php` / `PHP`，dev `null`，build `null`
  8. 都没有 → `{id:'unknown', label:'未检测到技术栈', commands:{dev:null,build:null,previewUrl:null}, evidence:[]}`
- `previewUrl` Phase 1 恒 `null`（不编造端口）。
- `evidence` 只写实际读到的：`{file:'package.json', detail:'dependencies.next'}`。
- JSON 损坏 ⇒ 继续探测其他生态 + `notes` 记一条。**绝不抛错**。

### 3.3 A · `lib/project-card.js`

```js
export const CARD_SCHEMA_VERSION = 1
export async function readProjectCard(projectPath)
// -> { card: object|null, broken: boolean, missing: boolean }
export function buildDefaultCard(projectPath, detected, now = new Date())
export function mergeDetected(card, detected, now = new Date())  // 保留人填 name/oneLiner
export async function writeProjectCard(projectPath, card)        // 原子写（写临时文件再 rename 同目录，失败回退直接写）
export function cardStatus(card) // 'filled' | 'needs-human' | 'missing' | 'broken'
```

### 3.4 A · `lib/init.js`

```js
export const INIT_FILE_NAMES = ['RULES.md','playbook.json','project.json','acceptance.json']
export const GITIGNORE_HINT = '.dsh/plugin-state/'
export async function planInit(projectPath, options = {})
// options.templatesDir?: string  默认 = <包根>/templates
// -> { projectPath, stateDir, trellisDir, dirs:[{path,status:'create'|'exists'}],
//      files:[{name,path,status:'create'|'exists',source:'template'|'generated',bytes}],
//      gitignoreHint, notes:[], errors:[] }
export async function applyInit(projectPath, plan)
// -> { ...plan, dryRun:false, applied:boolean, created:string[], skipped:string[], errors:string[] }
```

- **只写这四个文件**；`project.json` 由 `detectStack` + `buildDefaultCard` 生成（已存在则 `exists` 不覆盖）。
- 目录：`<root>/.trellis`、`<root>/.dsh/plugin-state`（`mkdir recursive`；已存在记 `exists`）。
- 幂等：第二次执行 ⇒ 所有文件 `exists`、`created: []`、`applied:false`（不改任何字节）。
- **不动 `.gitignore`**，只返回可复制的一行 `GITIGNORE_HINT`。
- `projectPath` 不存在 / 不是目录 ⇒ `errors:['不是目录']` 且不写任何东西（由 route 层 400）。
- 模板缺失 ⇒ 该文件进 `errors`，其余照常，**不静默跳过**。
- 写失败要进 `errors`，但已写成功的不回滚（并如实报告）。

### 3.5 B · `lib/playbook.js`

```js
export const STAGE_DEFS = [
  { id:'bootstrap',    name:'项目立项', playbookKey:'项目立项', cycle:false },
  { id:'requirements', name:'需求定义', playbookKey:'需求定义', cycle:true },
  { id:'architecture', name:'架构契约', playbookKey:'架构契约', cycle:true },
  { id:'prototype',    name:'原型设计', playbookKey:'原型设计', cycle:true },
  { id:'implementation', name:'代码开发', playbookKey:'代码开发', cycle:true },
  { id:'testing',      name:'测试验证', playbookKey:'测试验证', cycle:true },
  { id:'code-review',  name:'代码复核', playbookKey:'代码复核', cycle:true },
  { id:'acceptance',   name:'验收确认', playbookKey:'验收确认', cycle:true },
  { id:'release',      name:'部署发布', playbookKey:'部署发布', cycle:true },
]
export function stageDef(id)          // -> STAGE_DEFS 里那一条 | null（旧 id 先归一）
export function stageName(id)         // -> 4 字中文名（未知则原样）
export async function loadPlaybook(projectPath, builtinText)
// -> { playbook, source:'builtin'|'project', warnings:[{source,message}] }
export function mergePlaybook(builtin, override, warnings?)   // 规则见 §2.3，纯函数；version 不一致时忽略 stages
export function entryForStage(playbook, stageId)   // -> playbook.stages[playbookKey] | null（旧 id 先归一）
export async function resolveCapabilities(entry, services)
// entry 可为 null -> []
// -> [{kind,name,mode,optional,note,present:'yes'|'no'|'unknown',missingMessage:null|string}]
// services: { skills: Set<string>|null, tools: Set<string>, mcp: Set<string>, missingHints }
export function missingCapabilities(resolved)      // -> 过滤 present==='no' 且非 optional
export function renderPrompt(entry, resolved)      // -> { text:string|null, capabilitiesText:string }
```

能力存在性：

- `kind === 'inline'` ⇒ 恒 `present:'yes'`，且**不**进 `{capabilities}` 文本（它指向我们自己的规则，不是可调技能）。
- `kind === 'skill'` ⇒ `services.skills` 里有同名 ⇒ yes；`skills === null`（读不到）⇒ `unknown`（UI 说"无法检测"，不谎报缺失）。
  - **技能可见性（实测修正）**：Host 的 `skills.list()` 在 root context 下只返回 global 层（本机实测只有 5 个），
    用户装在 `$DSH_HOME/skills` 的技能（ponytail / TDD / verification-before-completion …）属于 agent 作用域，服务侧看不到。
    所以 `index.js` 的 `readSkillNames` = 服务列表 ∪ **磁盘扫描**（`$DSH_HOME/skills`、`~/.agents/skills`、
    项目 `.dsh/skills` / `.agents/skills`；跟随符号链接，取目录名 + `SKILL.md` 里 `name:` 声明）。
    两边都读不到才返回 `null`（unknown）。只信服务会把"装着的能力"报成"缺失"，进而错误禁用下一步指令。
- `kind === 'tool'` ⇒ `services.tools` 有 ⇒ yes。
- `kind === 'mcp'` ⇒ `services.mcp` 有 ⇒ yes。
- `present:'no'` 时 `missingMessage` = `missingHints[kind]` 里的 `{name}` 替换；`optional:true` 的缺失**不算阻断**。
- `renderPrompt`：`promptTemplate` 里 `{capabilities}` 替换为 present=yes 且 mode=full 的名字（`, ` 连接）；若被替换进去的集合为空 ⇒ `'（按 RULES.md 自行完成）'`。模板缺失 ⇒ `text:null`。
- 语法上只做 `{capabilities}` 一个占位符的替换，其他 `{...}` 原样保留（不猜变量）。

### 3.6 B · `lib/evidence.js`

```js
export async function readEvidence(projectPath, options = {})
```

返回（**所有字段都必须存在**，缺失用 `null`/空数组/`missing:true` 表达）：

```js
{
  ok: true,
  projectPath,                       // resolve 后的绝对路径
  workspace: { exists: boolean },    // 目录是否存在
  trellis: { exists, rules, initialized, partial },
  prd: { found, path },              // path: 命中的相对路径或 null
  card: { card, status, broken, missing },
  detected: { id, label, packageManager, commands, evidence, notes },
  receipts: { receipts, badLines, missing, lastAt },
  iteration: { current, isBootstrap, approvals: { map, badJson, missing } },
  approval: { approved, at, file, decisions: { scope, architecture, acceptance, release } }, // 原型批准 + 四个决策门（每门 {approved, at}）
  acceptance: { items, empty, badJson, missing, total, withResult, passed, failed, blocked },
  tasks: { available, total, open, completed, items: [{id,title,status}] }, // items 最多 50
  review: { available, reason, rounds, blocking, fixed, lastRound, issues: [{severity,title,file,line}] },
  warnings: [{ source, message }],
  degraded: { flag, reasons: [{ source, message }] },
  generatedAt,
}
```

- `options`: `{ reviewStorage?: 'auto'|'trellis'|'local' }`，默认 `auto`（有 `.trellis/tasks/*` 且任务账本有 history ⇒ trellis，否则本地；都不存在 ⇒ `available:false, reason:'no-ledger'`）。
- `degraded.flag` 只在**读失败/坏 JSON/权限错**时为 true（账本坏行不算降级，单独 `badLines` 报）；`reason` 逐条可读。
- 所有读盘：单文件上限 2 MiB，超限截断并 warning；`ENOENT` 一律视为"没有"，不 warning。
- 目录不存在（项目路径不存在/不是目录）⇒ `ok:false, workspace:{exists:false}` + `degraded`，其余字段给空结构，**不抛错**。

### 3.7 B · `lib/state.js`

```js
export function deriveDecision(evidence) // 纯函数，无 I/O
// -> { priority, kind, stageId, title, reason, disabled, disabledReason, notes:string[] }
```

`kind` / 优先级（design §7 的 12 条，逐条对应）：

| priority | 条件 | kind | stageId |
|---|---|---|---|
| 1 | `degraded.flag === true` | `confirm-data` | `null` |
| 2 | `pendingDecision` 非空（不论 status） | `decide` | 该回执的 stage |
| 3 | `!trellis.initialized` | `init` | `bootstrap` |
| 4 | `!prd.found` | `brainstorm` | `requirements` |
| 4.2 | `approval.decisions` 存在且 `scope.approved !== true` | `scope-approval` | `requirements` |
| 5 | `!approval.approved` | `prototype` | `prototype` |
| 6 | `tasks.open > 0` | `coding` | `implementation` |
| 7 | `tasks.available && tasks.total === 0` | `coding`（拆任务） | `implementation` |
| 8 | `review.blocking > 0` | `fix-blocking` | `code-review` |
| 9 | `review.fixed > 0` | `recheck` | `code-review` |
| 10 | `review.available && review.rounds === 0` | `first-review` | `code-review` |
| 11 | `acceptance.empty` | `acceptance-draft` | `acceptance` |
| 12 | `!acceptanceAllPass(evidence)` | `verification` | `acceptance` |
| 12.2 | `approval.decisions` 存在且 `acceptance.approved !== true` | `acceptance-approval` | `acceptance` |
| 13 | `!released(evidence)` | `release` | `release` |
| 14 | 其余 | `next-iteration` | `release` |

技术门插入点（`gates` 字段存在才判定）：**4.5** 架构契约（在 4.2 之后、5 之前）、**6.5** 测试验证、**12.5** 发布清单（在 12.2 之后、13 之前）。
决策门插入点（`approval.decisions` 字段存在才判定）：**4.2** 范围签核、**4.6** 架构签核（在 4.5 之后、5 之前）、**12.2** 验收签核、**12.8** 发布批准（在 12.5 之后、13 之前）。两个字段都缺（旧证据/手写夹具）⇒ 整段跳过，维持旧行为。

补充规则（实现层澄清，design 未覆盖但必须给唯一答案）：

- `review.available === false` ⇒ 规则 8/9/10 跳过（`notes` 记"未接审核账本，跳过挑毛病判定"）；只有当 `review.reason` 是**读失败**时才走规则 1（已在 `degraded` 中）。
- `acceptanceAllPass`：`items` 非空 && 每条 `result === 'pass'` && `evidence` 非空 && 每条 `stale !== true`（截图变化导致的失效 pass 不放行）。
- `released`：当前迭代存在 `stage:'release' && status:'completed'` 的回执。
- 规则 2 的 `title` 用 `needs_human_decision.title`（这就是"最高优置顶"）。
- 全部 `title` 必须是**人话**（≤ 20 字），`reason` 一句为什么（≤ 40 字），不含代码。

### 3.8 B · `lib/model.js`

```js
export function buildOverviewRow({ id, title, path, evidence, generatedAt })
// -> { id, title, path, initialized, stageId, stageName, nextKind, nextTitle, degraded, hasDecision, updatedAt }

export function buildDetailModel({ evidence, playbook, stageCapabilities, generatedAt, features, team })
// stageCapabilities: { [stageId]: resolved[] }  由调用方先 await resolveCapabilities 得到
// team: readTeam() 的结果（§3.20）；缺省时投影为 {available:false,reason:'not-read',agents:[]}
```

`buildDetailModel` 返回：

```js
{
  ok: true,
  generatedAt,
  project: { path, name, oneLiner, cardStatus, stack:{id,label}, commands:{dev,build,previewUrl}, packageManager, evidence:[] },
  trellis: { exists, rules, initialized, partial },
  iteration: { current, isBootstrap, prototype: { approved, at, file } },
  nextAction: {
    priority, kind, stageId, stageName, title, reason,
    instruction,               // renderPrompt 结果；缺失阻断能力时为 null
    capabilities: resolved,    // 本阶段能力（含 present 状态与 advice；advice 为 null 表示没有建议）
    missing: [{name, kind, message}],
    disabled, disabledReason, notes,
    buttons,                   // ['copy'] / ['init'] / ['copy','init'] …
    method, constraint,        // 9 阶段元信息：该阶段唯一方法 / 至多一个约束；无条目时 null
    deliverables,              // string[]；无条目时 []
    technicalGate, decisionGate, // 门禁声明（decisionGate 为 {title,approveAction,approved,at}|null）；下一轮接校验器
  },
  progression: {
    coldStart: [{ stageId, name, state:'done'|'current'|'pending', receipt: {status,at,summary}|null }],
    cycle:     [ 同上 8 条 ],
  },
  ledger: {
    receipts: [{ id, at, iterationId, stage, stageName, status, summary, artifacts, usedSkill, needsDecision, taskRef, writeScope, featureIds }],
    total, truncated, badLines, missing, lastAt,
  },                              // receipts 最多 20 条（时间倒序），total 是全量条数
  acceptance: { total, withResult, passed, failed, blocked, stale, empty, badJson, truncated,
    items: [{ id, featureRef, title, steps, expect, result, evidence, at,
              stale, staleAt, staleReason,
              shotDiffs: [{ at, verdict, baseline, diffFile, ratio, changedPixels, totalPixels, width, height, reason }] }] },  // items ≤ 100；shotDiffs ≤ 5
  review: { available, reason, rounds, blocking, fixed, issues },  // issues 最多 3
  tasks: { available, total, open, completed, items },             // items 最多 20
  team: { available, reason, agents: [{ id, name, parentName, depth, preset, origin, createdAt, running }], truncated }, // §3.20；无输入时 {available:false,reason:'not-read',agents:[]}
  warnings: [{source,message}],   // 最多 20
  dataGaps: [{source,message}],
  degraded: { flag, reasons },
}
```

- 阶段进度：某阶段在该迭代有 `completed` 回执 ⇒ `done`；有回执但非 completed ⇒ `current`；没有 ⇒ 看决策 `stageId` 是否等于它 ⇒ `current`，否则 `pending`。冷启动阶段（`bootstrap`）对 `bootstrap` 迭代；迭代环 8 阶段对当前迭代。
- `instruction` 为 `null` 且 `missing.length > 0` ⇒ `disabled:true`，`disabledReason` = 第一条 missing 的 message（design §6.3：不下发注定失败的指令）。
  - 实现补充：**`missing.length > 0` 时 `instruction` 一律置空**（哪怕 playbook 模板存在），否则"复制/发送至对话"会把注定失败的指令发出去。
- `dataGaps`：审核账本不可用、任务服务不可用、card 未填 `oneLiner` 等"缺数据"提示，与 `warnings`（读取异常）分开。

### 3.9 Lead · `lib/route.js`

```js
export function createRoutes(deps) // -> { handle(request): Promise<Response> }
```

`deps`：

```js
{
  listWorkspaces,               // async () -> [{id,title,path}]
  resolveWorkspace,             // async (path) -> {id,title,path}|null  （= 授权：只认已登记工作区）
  readOverview,                 // async () -> { projects: row[], generatedAt }
  readDetail,                   // async (projectPath) -> detail
  planInit,                     // async (projectPath) -> plan
  applyInit,                    // async (projectPath) -> result
  approvePrototype,             // async (projectPath, iterationId) -> {ok, approval|error}
  approveDecision,              // async (projectPath, iterationId, gate) -> {ok, gate, at, iteration_id}|{ok:false,error,missing?}
}
```

路由（前缀 `/delivery-cockpit/api`，均 JSON）：

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/workspaces` | `{ok:true, projects, generatedAt}`；`listWorkspaces` 抛错 ⇒ 500 `{ok:false,error}` |
| GET | `/panel?path=` | 无 `path` ⇒ 400 `{ok:false,error:'missing-path'}`；未授权 ⇒ 403 `{ok:false,error:'workspace-not-allowed'}`；否则 `{ok:true, panel}` |
| GET | `/init-plan?path=` | 同上授权；`{ok:true, plan}` |
| POST | `/init` | body `{path, confirm:true}`；`confirm!==true` ⇒ 400 `confirm-required`；未授权 ⇒ 403；成功 `{ok:true, applied, created, skipped, gitignoreHint}` |
| POST | `/approve-prototype` | body `{path, iteration_id}`；未授权 ⇒ 403；迭代为空/bootstrap ⇒ 400 `iteration-required`；找不到 `prototype.html` ⇒ 409 `prototype-missing`；成功 `{ok:true, approval:{iterationId, prototypeApprovedAt, prototype}}`。**保留向后兼容**；新客户端走 `/approve` |
| POST | `/approve` | body `{path, iteration_id, gate}`（gate ∈ `scope\|architecture\|prototype\|acceptance\|release`）；授权/同源/JSON 与其它写接口一致；400 `bad-gate`/`bad-iteration`；409 `prd-missing`/`architecture-gate-not-ready`/`acceptance-not-passing`/`release-gate-not-ready`/`prototype-missing`（前置不满足时带 `missing[]`）；成功 `{ok:true, gate, at, iteration_id}`（prototype 分支也投影成同一形状；旧 `/approve-prototype` 仍返回原 `approval`） |
| POST | `/acceptance-result` | body `{path, item_id, result:'pass'\|'fail'\|'blocked'\|null, evidence?: string[]}`；400 `item-required`/`bad-result`/`bad-evidence`/`evidence-required`；404 `item-not-found`；409 `evidence-not-found`/`acceptance-broken`/`iteration-mismatch`/`iteration-required`；成功 `{ok:true, item}`（`null` = 撤销，清空 result/at/evidence） |
| POST | `/acceptance-screenshot` | body `{path, item_id, url?}`（url 缺省用项目名片 `commands.previewUrl`）；只允许回环 http(s)；成功 `{ok:true, item, shot:{file,width,height,url,comparison,invalidated,receiptId,receiptWarning}, added}`；400 `item-required`/`no-url`/`invalid-url`/`url-not-loopback`；404 `item-not-found`；409 `browser-not-found`/`acceptance-broken`/`iteration-*`；504 `timeout`；499 `aborted`；502 `browser-failed`/`capture-failed`。**只挂证据、不改 result**；`shot.comparison` 是本次自动视觉回归结果，`shot.invalidated` 表示这次变化让该条已通过的验收失效，`shot.receiptId` 是失效留痕的回执 id |
| GET | `/shot?path=&file=` | 证据图片字节（png/jpeg/webp/gif，≤10 MiB，`cache-control:no-store`）；415 `not-image`/413 `file-too-large`/404 `shot-not-found`/403 未授权 |
| 其他 | — | 404 `not found` |

- 资源路由只接 GET/HEAD（DSH 实测对 resource 的非 GET 回 405）；POST 走 `kind:'exact'` 的 **handler 路由**（`initHandler(deps)`，签名 `(req, res) => Promise<void>`）。
- **写操作只允许已登记工作区**（与 GET 同一道 `resolveWorkspace` 授权），并且 `Origin` 头存在时必须与请求的 host 同源；`content-type` 必须是 `application/json`。
- 不把异常抛给载体：一律转成 JSON + 状态码；500 的 `error` 只放一句可读原因。
- 客户端路径只传 `path`（不传 cwd/相对路径解析）：`path` 必须绝对路径且命中已登记工作区。

### 3.10 Lead · `index.js`

```js
export const inject = ['tools']            // skills/mcpManager/webServer 全部按可选处理
export const TOOL_DEFINITIONS = [...]      // 供 test/tool-contract.test.js 断言
export function apply(ctx, config = {})
```

- 工具（每个都必须有 `output: { schema, render }`）：
  - `cockpit_report` —— design §5.1 逐字（字段/required/枚举/additionalProperties:false），外加两个可选扩展：
    `feature_ids?: string[]`（回执挂到 PRD 功能）与 `event?: 'acceptance-recheck'`（**验收复核留痕**：stage 必须 `acceptance`、status 必须 `completed`、summary 写清复核了哪条与结论；这类回执只进流水账，不改验收结果、不参与进度投影）。旧账本里的 `verification` 经 `normalizeStage` 归一到 `acceptance`。
  - `cockpit_init` —— `{ cwd?: string, dryRun?: boolean }` → `{ ok, dryRun, applied, projectPath, created[], skipped[], gitignoreHint }`；dryRun 默认 `true`（**不写盘是默认**）。
- 工具 cwd 解析：`exec.agent` → `ctx.get('workingDirectory').get(agent)` → `exec.agent?.session?.header?.cwd` → `process.cwd()`（同上游 `agentCwd`，取不到不猜目录）。
- 每个工具 `ctx.effect(() => ctx.tools.register(def))`。
- 面板路由：`ctx.inject(['webServer'], scope => …)` 优先，同步抛错则立刻试 + 有限重试（默认 10 次 × 500ms）+ 看门狗告警；路由注册失败**不影响工具**。
- 日志：`ctx.logger.warn`，前缀 `[delivery-cockpit]`；不 console.log 正常路径。
- `Config`：`{ panelRetryAttempts, panelRetryMs, panelWatchdogMs, reviewStorage }`，全部有默认值。

### 3.11 C · `client.js`

- `window.__ModuleLoader__.load({ id:'@hunyed15/delivery-cockpit', factory(require){…} })`
- 直接 `require('react')`；返回 `{ inject:['slots'], apply(ctx){…} }`。
- 注册两处（都用 `ctx.slots.inject(key, () => ctx.slots.register(...))`：slot 声明在之后才就绪，声明收拢/恢复时会重建，直接 register 有时序注册不上的风险）：
  1. `main` keyed：`ctx.slots.register({ name:'main', key: PANEL_ID }, PanelRoot)`
  2. `sidebar.panellist`：`ctx.slots.register({ name:'sidebar.panellist', id: PANEL_ID, order: 30, label: () => '交付' }, Icon)`
     - `Icon({ size, active })`，纯 SVG，颜色用 `currentColor`。
  3. （不注册 `shell.overlay` / `conversation.*`，Phase 1 不做提醒与通栏。）
- 数据：`fetch('/delivery-cockpit/api/...', { credentials:'same-origin' })`；**不读盘、不碰 DOM 外部、不 appendChild 到 body**。
- 结构：总览（工作区卡片列表）↔ 详情（一屏四区）。用 `localStorage` 记住上次项目（key `delivery-cockpit:last-project`），点卡片进入详情、返回按钮回总览。
- 一屏四区（design §4）：① 项目名片 & 迭代头 ② 唯一下一步（title/reason/能力/指令 + 复制 + 初始化按钮 + `kind==='prototype'` 时的「通过原型」按钮）③ 迭代进度（冷启动 1 + 迭代环 8 的进度线）④ 人话账本（最近回执 + 待决策 + 坏行提示）。底部：主会话活跃（Phase 1 不接，显示 `—`）+ 引擎正常（`ok:true`）+ 上次回执相对时间 + 刷新。
- 「通过原型」：`POST /delivery-cockpit/api/approve-prototype`（body `{path, iteration_id: panel.iteration.current}`）；成功后刷新。错误码映射人话：`prototype-missing` → 「先把原型 HTML 放到项目根目录 prototype.html，再点通过」；`iteration-required` → 「当前迭代还没确定」；其余显示原文。
- 决策门按钮（P1）：hero 按 `nextAction.kind`（`scope-approval` / `architecture-approval` / `acceptance-approval` / `release-approval`）渲染「确认范围 / 架构签核 / 确认验收 / 批准发布」，点 `POST /delivery-cockpit/api/approve`（body `{path, iteration_id, gate}`）；成功刷新面板。错误码映射：`prd-missing`→先写 PRD、`architecture-gate-not-ready`→先补齐契约文件、`acceptance-not-passing`→验收还没全部通过（含证据）、`release-gate-not-ready`→发布清单还不完整、`bad-gate`/`bad-iteration`→刷新重试。
- 降级：`degraded.flag` ⇒ 顶部横幅列原因 + 主按钮禁用；`ledger.badLines>0` ⇒ 顶部提示"账本存在损坏行（已降级显示）"；`missing.length>0` ⇒ 显示 missing 文案而不是指令。
- 样式：只引用 host 主题 token `--dsw-alias-*`（别名见上游 `client.js` 顶部），每段 CSS 选择器以 `.dc-` 前缀；字号/间距对齐现有 host 页。
- 组件内 ErrorBoundary：渲染异常不白屏；空态、加载态、错误态都要有。
- 视觉验收：`tools/preview/`（真实 React + 真实 CSS 渲染 `client.js` + CDP 截图，从 `D:\Coding\dsh-plugins\claude-code-review\tools\preview\` 复制后改造成本包 API/场景）。

### 3.12 Lead · 测试与断言清单

必过：

- `test/tool-contract.test.js`
  - 每个 `TOOL_DEFINITIONS` 都有 `output.schema`（对象）与 `output.render`（函数）；
  - `render` 返回非空 `ContentBlock[]`，至少一个 `{type:'text'}`；
  - `cockpit_report.parameters.required` 恰为 `['iteration_id','stage','status','summary_for_human']`；
  - `stage`/`status` 枚举与 `lib/receipts.js` 常量一致；`additionalProperties === false`；
  - `cockpit_init` 的 `dryRun` 默认语义在 `execute` 里成立（不写盘）。
- `test/route.test.js`：未授权路径 403、缺 path 400、`confirm` 必须 true、POST 非 JSON 415/400、GET 正常 200、未知路由 404。
- `test/client-smoke.test.js`：模块 id、三个 slot 注册、API 前缀、无 DSH 包 require、CSS 前缀、无 `document.body.appendChild`。

### 3.13 Lead · `lib/features.js`（功能账：PRD 功能清单 + 三路证据推导）

> 背景：design §4 的第四区是「功能账 + 缺陷账」，不是回执流水账。V1.0 实现成流水账是取舍错误，
> 本轮补齐。功能清单**不解析自由文本**：只认 PRD 里的受控结构（`### FR-N 标题`），认不到就直说。

```js
export function extractFeatures(prdText)
// -> { strategy: 'fr-section'|'fr-global'|'none', sectionTitle: string|null,
//      features: [{ id:'FR-1', title:'信号采集', priority:'P0'|'P1'|null, line:number }],
//      warnings: [{source,message}] }

export async function readPrdText(projectPath, prdRelPath)   // -> { text, missing, error }

export function buildFeatureBoard({ extracted, prd, receipts, acceptance, review })
// -> {
//   source: 'prd'|'prd-missing'|'prd-empty',
//   strategy, formatHint: string|null,
//   counts: { total, done, blocked, inProgress, pendingAcceptance, notStarted },
//   items: [...], unattributed: { blocking, known, issues }, notes: []
// }
```

**提取规则（确定性，不做 NLP）**

1. 先找二级标题文本含「功能需求」的那一节（到下一个 `##` 为止）；在这一节里取 `### FR-<数字> <标题>`。
2. 没有该节时，回退到全文扫描 `### FR-<数字>`；两者都没有 ⇒ `strategy:'none'`、`features:[]`。
3. 标题里的 `（P0）`/`(P1)`/`（P0，核心）` 解析成 `priority`，并从标题里去掉（保留人话标题）。
4. **跳过代码围栏**（``` 内的 `###` 不算标题）；按 id 去重（先出现者胜）；保持文件顺序。
5. 认不到结构时 `formatHint = '在 prd.md 里写「## 功能需求」，其下每行用「### FR-1 标题」列功能'`，绝不猜。

**状态推导（三路证据，缺数据就是 `—`）**，按优先级：

| 条件 | status |
|---|---|
| 归属到该功能的未处置 blocking > 0 | `blocked` |
| 该功能验收条目全部 pass 且都有证据 | `done` |
| 验收条目存在但没人填结果（全 null） | `pending-acceptance` |
| 验收部分通过/有失败，或有关联的 `in_progress`/`blocked` 回执 | `in-progress` |
| 有关联的 `completed` 回执但没有验收条目 | `pending-acceptance` |
| 三路都读不到（审核 `read-error`、验收坏 JSON、无回执） | `unknown`（显示 `—`） |
| 没有任何关联证据 | `not-started` |

语义说明：验收条目的 `result:'blocked'` 只计入 `acceptance.blocked` 统计，状态仍按**进行中**处理 ——
"有阻塞"在本面板专指**审核发现的未处置 bug**，两件事不能混成一个状态。

**关联规则（杜绝猜测）**

- 回执 → 功能：回执新增可选 `feature_ids: string[]`（`cockpit_report` 签名扩展）；`feature_ids` 含该 id 的回执即关联。
- 功能 → 路径：这些关联回执的 `write_scope` + `artifacts` 并集（去重、归一成正斜杠、去掉尾部 `/**`、`/*`、`/`）。
- 验收 → 功能：验收条目新增可选 `feature_ref`（等于功能 id）。
- 审核 bug → 功能：blocking issue 的 `file` 与功能路径做**前缀匹配**（`file === path` 或 `file` 以 `path + '/'` 开头）；匹配不上任何功能 ⇒ 进 `unattributed` 单列。
- 没有任何路径/回执关联的功能：bug 数显示 `—`（`bugs.known=false`），不显示 0。

**模型载荷（给界面，逐字）**

```js
features: {
  source: 'prd' | 'prd-missing' | 'prd-empty',
  prdPath: string|null,
  strategy: 'fr-section'|'fr-global'|'none',
  formatHint: string|null,
  counts: { total, done, blocked, inProgress, pendingAcceptance, notStarted },
  progress: { done, total },            // 区③ 顶部「功能进度 x/y」
  items: [{
    id, title, priority,
    status, statusLabel,                // 已完成/有阻塞/进行中/待验收/未开始/—
    acceptance: { total, passed, failed, blocked, missingEvidence, stale },  // stale 的 pass 不计入 passed
    bugs: { blocking, severe, known, issues: [{severity,title,file,line}] },   // issues ≤ 3；severe 按全量归属结果算
    lastAt, lastSummary, receipts, inferredReceipts, anchors: { receipts, tasks }, paths,
  }],
  unattributed: { blocking, known, issues },
  notes: [string],
}
```

界面口径：区④ 从「只列回执」改成「功能账表格 + 缺陷账（未归属）+ 执行回执（折叠次要）」；
`source==='prd-missing'` 显示「还没有 prd.md」；`strategy==='none'` 显示格式提示；`bugs.known=false` 显示 `—`。

### 3.14 Lead · 回执的自动归属（可解释、可覆盖）

功能路径锚点有两个来源，**回执自报优先**：

1. **任务锚点**：`.trellis/tasks/<task>/task.json` 的 `title` 或目录名里出现 `FR-<n>`（如 `FR-3 转存`）⇒ 该任务的 `relatedFiles` 作为这个功能的路径锚点。
2. **回执锚点**：回执 `feature_ids` 声明的功能 ⇒ 该回执的 `write_scope` + `artifacts` 作为路径锚点。

回执归属：

- 写了 `feature_ids` ⇒ 只按自报归属（**不推断**，避免被路径重复挂到别的功能）。
- 没写 `feature_ids` ⇒ 用它的路径（`write_scope` + `artifacts` + 所属任务 `relatedFiles`）与功能锚点做前缀交集推断；命中即归属，并在条目上记 `inferredReceipts`。
- 推断出的回执**不反向扩大**功能路径（否则一条 `web/**` 会把所有功能都连起来）。
- 界面必须显示"其中 N 条按任务 relatedFiles / 路径自动归属"与锚点来源；一条锚点都没有时，note 明确提示"第一条 coding 回执请写上 feature_ids"。

### 3.15 Lead · `lib/acceptance.js` + `cockpit_acceptance` 工具（按 PRD 起草验收）

- `readAcceptanceFile(projectPath)` → `{table, missing, badJson, error}`（坏表与空表分开）。
- `normalizeDraftItems(rawItems)`：`title` 必填；`feature_ref` 可选但必须是 `FR-<数字>`（统一大写）；`result/evidence/at` 固定由人后续填。
- `draftAcceptance(projectPath, rawItems)`：
  - 迭代：读回执得到当前迭代；`bootstrap` ⇒ `iteration-required`（验收表属于迭代环）。
  - 现有表坏 JSON ⇒ `acceptance-broken`（**不覆盖坏文件**）；`iteration_id` 与当前不一致 ⇒ `iteration-mismatch`；`null` ⇒ 绑定当前迭代。
  - 去重键 = `feature_ref|title`（同一条重复起草跳过，reason `exists`）；**已有条目原样保留，只追加**，新条目 id 取未占用的 `A<n>`。
  - 原子写（临时文件 + rename，失败回退直接写）。
- 工具 `cockpit_acceptance({items:[{feature_ref?,title,steps?,expect?}]})`：必须声明 `output`；只写会话工作目录下的 `.dsh/plugin-state/acceptance.json`（**没有 cwd 参数**，无注入面）；错误码翻译成人话后抛出。
- 生成验收清单那一步（`kind==='acceptance-draft'`）的指令由模型按功能账改写：点名"还缺 FR-x"，指向 `cockpit_acceptance`，其余阶段仍完全由 playbook 模板决定。
- **人工填结果**：`setAcceptanceResult(projectPath, {item_id, result, evidence})`（`lib/acceptance.js`）——
  - `result: null` = 撤销：**无条件成功**（直接清空 `result/at/evidence`，不校验旧证据文件是否还在）；
  - 枚举只收 `pass|fail|blocked`；
  - `pass` 必须至少一条证据，且项目内相对路径必须**真实存在、不越出项目**（防编造截图/路径穿越），`http(s)` URL 原样允许；
  - `fail`/`blocked` 的证据只是备注：只做路径规整，**不校验文件存在**（旧截图被删不该妨碍改判）；
  - `result` 大小写不敏感（存盘统一小写）；证据上限 20 条。
  - **已知放宽**：`http(s)` URL 证据不做可达性校验（预览链接是真实用例，离线也无法校验），只保证它是合法 URL 形状。
  - 落盘只改这一条的结果/证据/时间，不动标题与步骤；迭代不匹配、坏表、条目不存在都 fail-closed。
  - HTTP 层：`POST /acceptance-result`（已登记工作区授权 + 同源 + JSON + body 上限），错误码 → 状态码见 §3.9。

### 3.16 Lead · `lib/screenshot.js`（面板截图引擎，CDP 版）

> 为什么不直接用 Playwright MCP：本机 profile 没有装（实测 `playwright` 缺失），而"点一下出截图"必须由 Host 做。
> 装了 Playwright 的机器上 Agent 仍可走 MCP；这里的引擎只依赖本机已有浏览器，零 npm 依赖。

- `parsePreviewUrl(value)`：**只放行 http(s) 的回环地址**（`127.0.0.1` / `localhost` / `[::1]`），其他返回 `url-not-loopback`/`invalid-url`/`no-url`。不做任意 URL 抓取（SSRF）。
- `detectBrowser(explicitPath)`：显式配置 → `CHROME_PATH` → Chrome → Edge（Windows/macOS/Linux 常见路径）；都没有返回 `null` ⇒ 工具报 `browser-not-found`，**不偷偷装依赖**。
- `captureScreenshot({url,width,height,timeoutMs,browserPath,signal})`：spawn `--headless=new --remote-debugging-port=<free>`，等 CDP target → `Page.enable` → `Emulation.setDeviceMetricsOverride`（deviceScaleFactor=1，避免 125% DPI 裁切）→ `Page.navigate` → poll `document.readyState==='complete'` → settle 700ms → `Page.captureScreenshot`；PNG ≤10 MiB。
  - **单一 deadline 贯穿全程**：每一步都吃"剩余预算"，不会出现"4 段各自 30s"的最坏 100s+（实测卡死页在 6s 预算下 6.3s 返回 `timeout`）。
  - **客户端断开即中止**：路由层把 `res 'close'` 转成 AbortSignal 传进来；截图期间断开 ⇒ 返回 `aborted`、**不写盘不挂证据**（避免"客户端报超时、服务端其实已成功"的重复截图）。
  - **进程树清理**：Windows 用 `taskkill /PID <pid> /T /F`（裸 `child.kill()` 只杀主进程，renderer 会残留），失败回退 `SIGKILL`；临时 profile 删除失败会延迟重试一次，仍失败打 stderr 提示（不静默）。
- `writeScreenshot(projectPath, name, png)`：写到 **`.dsh/plugin-state/shots/`**（守住"插件只写自己的状态目录"），返回项目相对路径。
- 组合（`index.js` 的 `takeAcceptanceScreenshot`）：先确认条目存在（不存在的条目不为它起浏览器）→ 取 url（body.url 或项目名片 `commands.previewUrl`）→ 截图 → 落盘 → `addAcceptanceEvidence` 只追加证据、**不改 result**。
- 读图（`readShot`）：只允许项目内、图片扩展名、≤10 MiB；路径穿越/非图片/超大一律拒绝。桌面端 `GET /shot` 用它，客户端据此渲染缩略图。
- 配置（`cordis.patch.yml` 可覆盖）：`browserPath`（''=自动探测）、`screenshotWidth`（1280）、`screenshotHeight`（900）、`screenshotTimeoutMs`（30000）。

### 3.17 Lead · `lib/png.js` + `lib/visual-diff.js`（视觉回归）

- `lib/png.js`：最小 PNG 编解码，**只支持 8-bit 非隔行 RGB/RGBA**（Chrome `Page.captureScreenshot` 实测输出 colorType=2）；其他格式返回 `unsupported`，不"尽力猜"。
- `lib/visual-diff.js`：
  - `compareScreenshots(before, after, {tolerance=8, maxRatio=0.001, minChangedPixels=24})`：逐像素逐通道；单通道差 ≤ tolerance 视为同一像素；
    **两条判据取更敏感的**：变化占比 > maxRatio，**或**变化像素数 ≥ minChangedPixels ⇒ `changed`。
    为什么要 minChangedPixels：只看占比会漏掉小面积真实改动（1280×900 下 0.1% ≈ 1152 像素，一个按钮换色/一行文案改字可能只有几十像素）。返回 `changedPixels/totalPixels/ratio/bbox/mask`；尺寸不同 ⇒ `different-size`（**ratio/changedPixels/totalPixels 在数据源头就是 null**，只留宽高差异）；解析失败 ⇒ `uncomparable`。
  - `renderDiffPng(after, mask)`：变化像素标红 `(255,0,72)`、其余压成 55% 灰，用于一眼看出改哪了；mask 不匹配直接拒绝，不给假 diff。
- 组合（`index.js` 的 `compareWithBaseline`）：基线 = **该条证据里最后一张能当基线的图**（`pickBaselineEvidence`：URL 优先于 `.png` 后缀判定，所以带查询串的 `.png` URL 也算 URL 证据；跳过普通文本证据）：
  - 没有图片证据 ⇒ `new`（建立基线）；
  - 基线是 http(s) URL ⇒ `uncomparable` + `baseline-url`（不抓远端图来比较）；
  - 基线是 jpg/webp/gif ⇒ `uncomparable` + `baseline-not-png`（只支持 PNG 像素对比）；
  - 基线越界/文件不存在/超过 10 MiB/CRC 坏 ⇒ `uncomparable` + `baseline-outside-project` / `baseline-missing` / `baseline-too-large` / `baseline-bad-png`；
  - `changed` 时把 diff 图写进 `.dsh/plugin-state/shots/diff-<item>-<stamp>.png`，路径记在 `shotDiffs[].diffFile`（**不进 evidence 列表**，避免污染证据）。
- 落盘：`addAcceptanceEvidence(projectPath, {item_id, evidence, shotDiff})` 一次原子写同时追加证据与对比记录（`shot_diffs`，最多 20 条）；挂证据失败会删掉刚写的截图与 diff（不留孤儿）。
- 配置：`screenshotDiffTolerance`（8）、`screenshotDiffMaxRatio`（0.001）、`screenshotDiffMinChangedPixels`（24）。


### 3.18 Lead · `lib/capabilities.js` + `lib/gates.js`（必要能力校验 + 三个技术门）

- `lib/capabilities.js`
  - `capabilityTokens(value)`：`used_skill_or_mcp` 按 `/[\s,+/|]+/` 切 token、小写去空；非字符串返回空 Set。
  - `stageCapabilityRequirement(playbook, stageId)`：用 `entryForStage` 取阶段声明；`method` 为方法；`allowed = 去重([method, ...capabilities.filter(substitute===true).map(name)])`——**只有显式 `substitute:true` 的能力可替代 method**（如 `claude_review` 替代 `claude-code-review`、`ui-ux-pro-max` 替代 `frontend-design`）；`optional` 仅表示"方法缺失允许回退"，**证据/辅助能力（playwright、context7）不能静默顶替 method**；constraint 不进 allowed（防止 `ponytail` 冒充 `tdd-loop`）。
  - `checkStageCapability(playbook, stageId, used)`：method 为空 ⇒ `skipped`；命中 allowed ⇒ `matched`；method 可选（`optional:true`）⇒ `fallback` + warning；否则返回 `stage-capability-required`，message 含 4 字中文名与 allowed。
  - 接入：`cockpit_report` 在 `appendReceipt` 之前校验；不通过 ⇒ 抛错且**一字节不落盘**；可选回退 ⇒ 回执正常写，output 增带 `capabilityWarning`（schema 可选字段，render 不变）。
  - 模板对齐：架构契约 `method:null`（不强制 skill，门禁靠契约文件）；`ui-ux-pro-max`（原型）、`claude_review`（复核）标 `optional:true`，可作为方法替代记录。
- `lib/gates.js`（纯读文件，任何异常只影响自身，不抛）
  - 统一形状 `{available, ok, gate, missing[], detail?, reason?}`；`available`=主证据文件存在且可读（区分“还没做”与“做了没过”），`ok`=内容满足门禁。
  - `validateArchitecture(projectPath)`：`docs/architecture.md` 必需小节「组件/数据模型/接口清单/关键决策」+ `docs/api.md` 或 `docs/openapi.json` 非空。
  - `validateTestReport(projectPath)`：优先 `.dsh/plugin-state/test-report.json`（`command`/`passed`/`failed`/`at` 合法且 `failed===0`）；文件不存在时回退 `.dsh/plugin-state/manual-check.json`（非代码项目：`checks[]` 非空 + `at`，`fail`/`blocked` 均不放行）。test-report 存在时优先，不静默改用回退。
  - `validateRelease(projectPath)`：`.dsh/plugin-state/release.json`，`version`/`artifacts:[{path, sha256}]`/`rollback`/`at` 合法；每个产物必须解析到项目内、文件存在、sha256 匹配（越界/缺文件/哈希不符都会列进 missing）。
  - `readGateEvidence(projectPath)`：三门并发读取、逐个兜错；文件不存在记 `missing`，**不触发 `degraded`**（阶段未完成不是读取故障）。
- 接入 `lib/evidence.js`：`readEvidence` 顶部新增 `gates: { architecture, tests, release }`；降级分支同样带 gates 键。- 接入面板：`lib/model.js` 的 `gatesSection` 把三门只读投影给 `detail.gates`；hero 的「阶段检查」块显示 已通过/未通过/未就绪 + 方法/约束/交付物（`client.js`，token-only 样式）。- 阶段只读切换：`detail.stages` 投影 9 阶段的元信息/门禁/能力/最近 3 条记录；进度节点是按钮（`data-stage`/`aria-pressed`），点击在客户端展开只读详情，Esc 或「回到当前」关闭，**不写盘、不改状态机**。
- 状态机门禁决策（`lib/state.js`，插在既有 1–14 序号之间，保持旧序号不动）：
  - **4.5**：有 PRD 但架构契约门不过 ⇒ `architecture`「先定架构与契约」（在原型之前）。
  - **6.5**：任务做完但测试门不过 ⇒ `testing`「补测试证据」（在代码复核之前；失败数>0 的文案带失败数）。
  - **12.5**：验收全绿但发布清单不完整 ⇒ `release`「准备发布清单」（在发出去之前）。
  - 证据里**没有 `gates` 字段**（旧数据/手写夹具）⇒ 整段门禁判定跳过，维持旧行为。

测试：`test/capabilities.test.js`（8）、`test/gates.test.js`（14）、`test/state.test.js`（+5 门禁用例）、`test/evidence.test.js`（gates 契约）、`test/tool-contract.test.js`（能力校验/拒绝/回退）、`test/integration.test.js`（真实三门推进）。当前 **393 个用例全绿**。

### 3.19 Lead · 决策门（P1）：`lib/approvals.js` + `/approve` + 客户端按钮

把 playbook 里声明的 decisionGate（范围/架构/原型/验收/发布）变成真按钮、真门禁；原型通过保留不变。

- `lib/approvals.js`（不 import `evidence.js`，避免循环；只 import `gates.js` 与 `acceptance.js`）
  - `decisionsFor(map, iterationId)`：固定形状 `{scope, architecture, acceptance, release}`，每门 `{approved, at}`；bootstrap/空迭代/缺条目/没签 ⇒ false。
  - `approveDecision(projectPath, iterationId, gate)`：
    - gate 不在 `scope|architecture|prototype|acceptance|release` ⇒ `{ok:false,error:'bad-gate'}`；迭代为空/bootstrap ⇒ `{ok:false,error:'bad-iteration'}`；
    - `prototype` ⇒ 直接复用 `approvePrototype`（返回形状不变）；
    - `scope` 前置：`prd.md` 或 `docs/prd.md` 存在，否则 `prd-missing`；
    - `architecture` 前置：`readGateEvidence().architecture.ok === true`，否则 `architecture-gate-not-ready` + `missing`；
    - `acceptance` 前置：`.dsh/plugin-state/acceptance.json` 非空、每条 `result==='pass'`、evidence 非空、`stale!==true`，否则 `acceptance-not-passing` + `missing`；
    - `release` 前置：发布门 `ok===true` **且**验收同上通过，否则 `release-gate-not-ready` + `missing`；
    - 成功：只写本门对应的时间字段（`scopeApprovedAt`/`architectureApprovedAt`/`acceptanceApprovedAt`/`releaseApprovedAt`），其余字段与原型记录原样保留（原子写），返回 `{ok:true, gate, at, iteration_id}`。
  - `approvalFor` 的口径补一条：**条目存在 ≠ 原型已批准**（P1 起先签范围/架构也会建条目），按 `prototypeApprovedAt`/`prototype` 字段判定；旧文件只有 `prototype` 仍算批准。
- `lib/state.js`：决策门 4.2 / 4.6 / 12.2 / 12.8，只在 `evidence.approval.decisions` **存在**时启用（旧证据跳过，向后兼容）。
- `lib/route.js`：`createDecisionHandler(deps)` → `POST /approve`；授权/同源/JSON 与其它写接口同一道；错误码见 §3.9。`index.js` 注入 `deps.approveDecision` 并注册 exact 路由；`/approve-prototype` 保留。
- `client.js`：`DecisionGateButton` + `DECISION_GATE_BY_KIND` 渲染 hero 按钮（确认范围 / 架构签核 / 确认验收 / 批准发布，原生 `type=button`、提交中禁用），POST `/approve`，`DECISION_ERROR_TEXT` 把五种前置失败翻成人话；原型通过仍用 `ApprovePrototype`。

测试：`test/approvals.test.js`（决策门 + 前置 + 兼容/原子写）、`test/evidence.test.js`（decisions 透传）、`test/state.test.js`（4.2/4.6/12.2/12.8 + 顺序 + 向后兼容）、`test/model.test.js`（四个按钮 token）、`test/route.test.js`（/approve 200/400/409/403/405）、`test/integration.test.js`（范围→架构→原型→…→验收→发布四签核推进）、`test/client-smoke.test.js`（按钮/接口/错误映射/a11y）。当前 **438 个用例全绿**。


### 3.20 P1 收尾 · 签核状态 / 能力建议 / 团队泳道

#### ① 阶段详情显示签核状态

- `lib/model.js`：`decisionGateRow(evidence, gate)` 统一输出 `{ title, approveAction, approved, at }`；`nextAction.decisionGate` 与 `stages[].decisionGate` 共用同一份 `decisionStatusOf`：
  - `approveAction`（也接受直接写 gate 名）→ `scope|architecture|acceptance|release`，读 `evidence.approval.decisions[gate]`；
  - `prototype` 读 `evidence.approval.approved/at`（原型批准从 P0 起就不在 decisions 里）；
  - 读不到 / `decisions` 缺失 / 没签 ⇒ `approved:false, at:null`，**不把"没读到"显示成"已签"**。
- `client.js` StageDetail：「需要你确认」一行 = `decisionGate.title` + 状态 Chip（`已签核` success / `未签核` warn）+ 已签核时间（`formatRelative`；`title` 给完整本地时间）。「签核」在人话词表内，禁用词（门禁/回执/阻塞…）不出现。

#### ② 缺失能力给「替代 / 安装指引」

- 新模块 `lib/recommend.js`（纯函数、无 I/O）：
  - `adviceFor(capability) → { fallback?, install?: [{label, command?, url?}], note? } | null`
  - 只对 `present !== 'yes'` 或 `optional === true` 的能力给建议；`present==='yes'` 且必需 ⇒ `null`；未知能力 ⇒ `null`（**不编造**）。
  - 没有安装信息时只给 `fallback` + `note`（如 `claude_review`），绝不硬凑 URL/命令。
  - 能力名大小写不敏感；`trellis-` 前缀全部命中同一份建议。映射：

| 能力 | fallback | install（label / command / url） |
|---|---|---|
| `playwright` | 面板内置 CDP 截图（不需要 MCP） | Playwright MCP / — / https://github.com/microsoft/playwright-mcp |
| `context7` | web_search / dsh-doc 查文档 | Context7 MCP / — / https://github.com/upstash/context7 |
| `grilling`、`grill-me` | 内置追问模板，产出 docs/brief.md | mattpocock/skills（含 grilling） / — / https://github.com/mattpocock/skills |
| `trellis-*` | 内置模板 / 原生 git 收尾 | Trellis / `npm i -g @mindfoldhq/trellis` / https://github.com/mindfold-ai/Trellis |
| `webapp-testing` | 本机 Chrome + CDP 截图 | anthropics/skills（webapp-testing） / — / https://github.com/anthropics/skills |
| `claude_review` | 启用 claude-code-review 插件 | @hunyed15/project-cockpit（review 引擎） / — / — |
| `ui-ux-pro-max`、`frontend-design`、`impeccable`、`ponytail`、`tdd-loop`、`verify-claims` | 按 CAPABILITIES.md 现状给替代/说明（已装的可略） | 只有已知来源的才给（如 frontend-design → anthropics/skills） |

- `lib/model.js`：`nextAction.capabilities[]` 与 `stages[].capabilities[]` 每项附 `advice`（`null` 保留，界面据此判断"没有建议"）。
- `client.js`：`CapabilityAdvice` 组件；hero「推荐能力」chips 下方与阶段详情「能力」行展示 `替代：…`、`安装：label`：
  - 有 `url` ⇒ `<a target="_blank" rel="noreferrer">`（可读文本 = 安装项名字）；
  - 有 `command` ⇒ `<code>` 展示可复制命令；
  - **只展示，不执行、不自动安装**（建议块里没有按钮 / onClick）。

#### ③ 团队泳道（子代理可见）

- 新模块 `lib/team.js`：`readTeam(ctx, projectPath) → { available, reason, agents, truncated? }`（异步，**永不抛**）：
  - 取 `ctx.get('agents')` / `ctx.get('sessions')`（必需）与 `ctx.get('subagents')`（可选）；
  - `agents` / `sessions` 任一缺失或 `list` 不可用 ⇒ `{available:false, reason:'service-missing', agents:[]}`；`list()` 抛错或返回非数组 ⇒ `read-error`；
  - **按项目 cwd 过滤**（面板路由是 root scope，拿不到"当前会话"）：只留 `session.header.cwd` 规范化后等于项目路径的会话（Windows 大小写不敏感）；
  - 行：`{id, name, parentName, depth, preset, origin, createdAt, running}`：
    - `name` 优先 `subagents.namesOf(agent).self`；失败回退 `lead`（无 `parentSession`）或 `subagent-<id 后 6 位>`；
    - `parentName` 取 `namesOf.parent`，否则用父会话行的名字；`running` = id 出现在 `agents.list()` 里；
  - 排序 depth 升序 + createdAt 升序（缺时间排最后）；最多 20 行 + `truncated`。
- `index.js` 的 `readDetail` 在 `buildDetailModel` 前 `await readTeam(ctx, projectPath)`，并把结果作为 `team` 传入。
- `lib/model.js`：`teamSection(team)` 投影上述形状（数组再截断到 20）；入参缺失时 `{available:false, reason:'not-read', agents:[]}`。
- `client.js` 右栏新增「团队」模块（与代码检查/项目动态同一栏，排在代码检查之后）：
  - 有数据：每行「名字 + 角色/层级（`preset`，否则主会话 / 子代理 · 第 N 层）+ 在线/空闲」，子代理按 depth 缩进（最多 4 层）；
  - 无数据：「没有正在运行的子代理」；服务缺失：「当前 DSH 没有暴露会话信息」；
  - 只读、无按钮；token-only 样式；窄屏 `min-width:0` + 截断，不溢出。

测试：`test/recommend.test.js`（映射 / 未知能力 null / present=yes 不给建议 / 输出不共享引用）、`test/team.test.js`（正常 / cwd 过滤 / 服务缺失 / list 读失败 / namesOf 回退 / 排序 / 截断 / 离线可见）、`test/model.test.js`（签核状态、capabilities.advice、team 投影）、`test/client-smoke.test.js`（签核 Chip、替代/安装静态断言、团队文案/只读/360）。当前 **459 个用例全绿**。

1. `npm test`（= `node --test "test/*.test.js"`）全绿。
2. `plugin_manager(action:"install_bundle", target:<本目录绝对路径>)` → `application: applied`（不是 failed/restart-required）。
3. `cordis_inspect_query(platform:"host", provider:"Tool", method:"listTools")` 能看到 `cockpit_report` / `cockpit_init` / `cockpit_acceptance` / `claude_review` / `claude_review_disposition` / `claude_review_install_hook` 六个工具。
4. 路由：`/delivery-cockpit/api/workspaces`、`/panel?path=<已登记工作区>` 返回 200；未登记路径 403；缺 path 400；`prototype-missing` 409。
5. 面板页面：侧栏出现「交付」入口，点击进入总览 → 详情；一屏四区内容来自真实 `.dsh/plugin-state/`。
6. 视觉：`tools/preview` 截图核对四区、窄屏不溢出、degraded 横幅一致。
7. 独立评审：`claude_review` 跑一次，blocking 清零。

实测记录（2026-11-20/21，DSH 0.2.2-rc.5 / Node 24.20）：

- 1/2/3/4/6 全部通过；`npm test` = 340 用例全绿。
- 安装返回 `application: applied`；`listTools` 可见 `cockpit_report` / `cockpit_init`；`Slots.listSubTree` 在 live 页面里看到 `main` 与 `sidebar.panellist` 都有 `delivery-cockpit`（active）。
- HTTP 实测（本机 `Invoke-WebRequest`）：未登记路径 403、缺 path 400、无原型批准 409、同源 POST 200、跨源 POST 403、二次 init `applied:false / created:[]`。
- **功能账 live 实测**（临时夹具：PRD 4 条 FR + 3 条回执 + 验收表 + 审核账本 1 条归属 bug、1 条未归属）：FR-1 = 有阻塞（bug 归属到 `web/orders/list.ts`）、FR-2/FR-3 = 进行中、FR-4 = 未开始且待修列 `—`（known=false）、未归属 1 条、功能进度 0/4。夹具用完已清理，未留在仓库。
- **真实 PRD 实测**：`D:\Coding\EasyVod` 的 `docs/prd.md`（959 行）→ 稳定提取 10 条功能（FR-1…FR-10，P0/P1 正确，`（P0，核心差异化）` 这类写法也能正确剥出标题与优先级），状态全部「未开始」、待修列 `—`（没有审核账本），如实反映"只有 PRD、还没有执行证据"。
- **V1.0.2 live 实测**（临时夹具，验完已清理）：
  - 任务 `T2` 标题 `FR-1 客户列表` + `relatedFiles:["web/orders"]` ⇒ 形成任务锚点；回执 `r-1` 自报 `feature_ids:["FR-1"]` ⇒ 显式归属。
  - 回执 `r-2` **没写** `feature_ids`，只靠 `task_ref:"T1"` 与任务 `relatedFiles:["web/import"]` ⇒ 被推断归属到 `FR-2`（`inferredReceipts=1`），note 写明"有 1 条回执没写 feature_ids，已自动归属"。
  - `acceptance-draft` 的指令实测为「还缺 FR-1、FR-2、FR-3：调用 cockpit_acceptance 一次写入…」。
  - 直接走工具的 execute 路径：首次 `added=2`，再次 `skipped=1`（幂等、不重复），写出的条目 `result:null / evidence:[]`。
  - 技能可见性修正前后：`verification-before-completion` 由 `no` → `yes`，`missing` 只剩真正没装的 `playwright`。
- **V1.0.3 live 实测**（临时夹具，验完已清理）：`POST /acceptance-result` 无证据 400、证据不存在 409、真实截图 200（证据归一化为 `shots/a1.png`、写入 `at`）、撤销 200 清空、未授权路径 403；面板随之把 FR-1 变「已完成」、功能进度 1/1。修复后复测：**漏传 `result` 字段 400 且 `acceptance.json` 一个字节未变**，显式 `null` 才走撤销。
- **V1.0.4 live 实测**（临时夹具，验完已清理）：真实 Chrome headless 截图 3s 出图、落盘 `.dsh/plugin-state/shots/`、自动挂到证据、`GET /shot` 回 `image/png`，`result` 保持空；卡死页面 `timeoutMs=6000` ⇒ 6.3s 返回 `timeout`；客户端 1.5s 断开 ⇒ 2.2s 返回 `aborted`；两次异常后 **0 残留临时 profile、0 僵尸 chrome 进程**。
- **V1.0.5 live 实测**（临时夹具，验完已清理）：同一验收项连拍四次——① 无基线 ⇒ `new`；② 同页面 ⇒ `same`（0/1,152,000 像素变化，证明渲染确定性够用）；③ 改了页面（换文案 + 加搜索框）⇒ `changed`（3,535 像素 = 0.31%，diff 图正确把"变化的文字行 + 新增输入框"标红、其余压灰）；④ 又是同页面 ⇒ `same`。面板 `acceptance.items[].shotDiffs` 按序下发 4 条记录，`result` 始终保持为空（截图不判通过）。
- **小改动回归实测**（评审修复后）：只把「保存按钮在右下角」改成「左下角」——151 像素、占比 0.01%，修复前会被占比阈值判成 `same`，现在正确报 `changed` 并出 diff 图；同页面重拍仍 `same`。
- **V1.0.6 live 实测**（临时夹具，验完已清理）：起点验收全绿 ⇒ `next=release`；第 1 次截图（`new`，建立基线）⇒ 仍 `release`；改页面再截 ⇒ `comparison=changed`、`invalidated=true`，面板 `next=verification`、`reason=「有 1 条验收因截图变化失效，重新确认后再放行」`、`passed=0 / stale=1`、条目 `result` 仍是 `pass`（历史保留）；人重新点「通过」⇒ `next=release`、`passed=1 / stale=0`。
- 第 5 条的 **页面内点击** 属人工确认项（agent 打不开带鉴权的 GUI）；视觉由 `tools/preview` 的真实 React + CDP 截图覆盖：`features.png`（功能账主视图）/ `features-prd-missing.png` / `features-no-fr.png` / `degraded.png` / `overview.png` / `features-360.png`（360px 无横向溢出）。
- 改动 Host 代码后需要**重载插件**（disable→enable 或重启 DSH）才生效；只改 `client.js` 需要**刷新页面**。

### 3.21 Lead · 评审引擎合并（原 `@hunyed15/project-cockpit` v3.0.0）

> 目标：**只装 `@hunyed15/delivery-cockpit` 一个插件**，就能拿到旧插件的「独立评审引擎 + 三个工具 + 账本」。

#### ① 随包发布的引擎（`scripts/`，旧仓库原样复制）

| 文件 | 作用 |
|---|---|
| `Invoke-ClaudeReview.ps1` | 审核引擎（git 快照 / diff 范围 / prompt / 报告 / 退出码 0/1/2），文件头带 `# claude-review-api: 3` |
| `acp-review.mjs` | ACP 传输桥（优先）；依赖随插件安装，用户无需单独配置 ACP |
| `review-schema.json` | 结构化审核输出 schema |
| `reviewer-role.md` | 内置只读审核员角色 |
| `config.json` | 引擎自己的参数：`reviewerRoleFile` / `failOn` / `maxRounds` / `maxDiffChars` / `excludePathspecs` … |
| `install-git-hook.ps1` + `git-hooks/pre-commit` | 提交门禁 hook 安装器与模板 |

- 接口握手：插件要求引擎 API **v3**；目标仓库里的旧引擎（无标记或版本低）会被跳过并回退到自带副本，`result.engineWarning` 说明回退原因。
- 项目级审核员角色文件默认 `<项目>/.trellis/agents/review.md`（引擎 `config.json` 的 `reviewerRoleFile`），不是插件配置键。

#### ② 三个工具（名字 / 参数 / output schema / 错误语义与旧插件一致）

- `claude_review`：参数 `mode`(incremental|full|gate|range) / `base` / `head` / `profile`(quick|deep) / `description` / `checks[]` / `paths[]` / `focus` / `taskDir` / `cwd` / `dryRun`；output 必填 `ok/mode/verdict/exitCode`，可选 `critical/important/minor/summary/reportPath/markdownPath/storage/base/head/profile/transport/roleMode/transportWarning/truncated/scopeWarning/cached/costUsd/costKnown/dryRun/escalated/note/enginePath/engineSource/engineWarning`。
  - exit 2 ⇒ **抛错**「审核未完成（exit 2）：<error|stderr 首行>」；exit 非 0/1 且无信封 ⇒ 抛错；`fix`/`reject`/exit 1 ⇒ `ok:false`（门禁不能靠 note 文字绕过）；`gate` 阻断 ⇒ `verdict:'gate-blocked'`；`dryRun` ⇒ `verdict:'dry-run'`；`nothing-to-review` 明确不是 pass。
- `claude_review_disposition`：批量 `entries[]` 或单条 `round/key/index/status/note/evidence`；写 `<taskDir>/review/dispositions.jsonl`。参数在写盘前校验（status ∈ fixed/counter-evidence/deferred、round 是数字、key|index 至少一个），**被拒绝的批次一个字节都不落盘**。
- `claude_review_install_hook`：`cwd` / `force` / `enginePath` / `taskDir`；`-File` 调 `install-git-hook.ps1`；已存在 `pre-commit` 且未 `force` ⇒ 安装器拒绝、工具报「安装失败（exit 1）：…」，原文件不动；`force` ⇒ 先备份 `pre-commit.bak-<yyyyMMdd-HHmmss>`。

#### ③ 启动逻辑（`lib/review/engine.js`）

- 引擎路径：`enginePath`（绝对或相对 cwd）→ `<cwd>/tools/claude-review/` → `<cwd>/.dsh/claude-review/` → 自带 `scripts/`；`allowBundledFallback:false` 时不允许最后一项。
- 命令行：`pwsh -NoProfile -ExecutionPolicy Bypass -Command "<UTF-8 前置段>; & '<engine>' -Mode '…' -Storage '…' -Cwd '…' -Json -TimeoutSec N …"`；参数名裸写、值单引号（`'` → `''`）、数组拼成 `-Checks 'a','b'`（PowerShell 不允许同一命名参数出现多次）。
- 超时：`-TimeoutSec = timeoutSec`（默认 1500s）；工具级 `timeoutMs = min(max(timeoutSec*1000 + 120s, 30min), 60min)`，保证插件不会先掐掉引擎。
- 输出归一：取 stdout 最后一个可解析 JSON 行；出现 U+FFFD ⇒ 大声失败（编码损坏不当作审核结论）。
- 单飞：`isConcurrencySafe() === false`（同一仓库的审核与快照不能并发）。
- **已知引擎语义**：干净工作区会在 `-DryRun` 分支之前被判成 `nothing-to-review` 并写一轮历史；要验证 dryRun 的组装语义，工作区里必须有一处未提交改动（`test/review-tools.test.js` 的临时仓库就是这样造的）。

#### ④ cwd 与 subprocess（本插件的新约束）

- `claude_review` / `install_hook` 的 cwd 解析顺序与旧插件一致：显式 `cwd`（相对 cwd 解析）→ `workingDirectory.get(agent)` → `agent.session.header.cwd` → `process.cwd()`。**但写路径必须授权**：`claude_review` 写账本、`claude_review_disposition` 写 dispositions、`claude_review_install_hook` 写 `.git/hooks`，三者的显式 `cwd` 与显式 `taskDir`/`enginePath` 都过同一个 `authorizeWrite`（未登记工作区 fail-closed）；会话自身工作目录不校验。评审工具"不改代码"不等于"不写盘"。
- `inject` 仍然只有 `['tools']`：`subprocess` 在精简 profile 里可能不存在，硬依赖会让整个插件不激活。工具执行时用 `ctx.get('subprocess')` **可选获取**，缺失/不可用 ⇒ 明确报「缺少 subprocess 服务」，其余工具照常可用。

#### ⑤ 账本与 disposition

- 只迁写入侧纯逻辑（`lib/review/ledger.js` 的 `resolveTaskDir` / `appendDispositions`），**不迁**旧 `panel.js` 的面板投影（loadPanel / derive* / 匹配算法）——驾驶舱的「代码检查」模块已用本插件 `lib/evidence.js` 读同一份账本，再迁一套只会变成第二套口径。
- 账本位置不变：Trellis `<项目>/.trellis/tasks/<task>/review/`，本地 `<项目>/.dsh/claude-review/ledger/review/`；`reviewStorage: auto|trellis|local` 同时供驾驶舱读账本与引擎 `-Storage`，两边不会错位。
- Trellis 下 disposition **必须显式 taskDir**，不按 history/in_progress 猜任务；本地模式要求账本已存在（先跑一次 `claude_review`）。

#### ⑥ 配置（`cordis.patch.yml` 与 `DEFAULT_CONFIG` 新增，旧键名）

`reviewStorage`（沿用，默认 auto）、`enginePath: ''`、`timeoutSec: 1500`、`transport: 'auto'`、`allowBundledFallback: true`。旧插件的 `storage` 键不再使用（它是独立包，配置块不共享）；`reviewerRoleFile` 等属于引擎 `scripts/config.json`。

#### ⑦ 不迁移

旧 `/claude-review/api` 协同面板路由、`/project-cockpit` 驾驶舱路由、旧 `client.js` / `panel.js`、旧 cockpit 总览均不迁移；本插件路由仍只有 `/delivery-cockpit/api/*`，三个工具本身不需要 HTTP。

#### ⑧ 依赖

`package.json` 的 `dependencies`：`@agentclientprotocol/claude-agent-acp ^0.106.0`、`@agentclientprotocol/sdk ^2.6.0`；`files` 增加 `scripts`。`acp-review.mjs` 按包名解析这两个依赖，所以本地源码安装前要在插件目录执行 `npm install`（装好后 `node_modules/@agentclientprotocol/*` 存在）。

测试：`test/review-tools.test.js`（14 条：schema/render、命令行拼装、结论归一、旧引擎回退、subprocess 缺失、dryRun 真实干跑（临时 git 仓库，确认不落 history/state/报告）、处置账本、hook 安装与备份）。

### 3.22 P3 · 交付指标（DORA 代理口径）+ 项目周报导出

> 目标：面板能回答「这一轮交付得多快、返工多少、堵在哪」，并能一键导出 Markdown 周报。
> **全部是代理指标**：插件只有项目本地的执行回执 / 审核账本 / 验收表，拿不到 CI、发布系统与线上监控；
> 每个指标都带 `definition`（一句人话口径）与 `source`，面板 tooltip 与周报脚注都会亮出来，不冒充实测。

#### ① `lib/metrics.js`（纯逻辑 + 一个只读入口）

| 指标 | 公式（代理） | 数据源 | 空值口径 |
|---|---|---|---|
| `leadTimeHours` | 按 `iteration_id` 分组（排除 `bootstrap` 与审计事件 `event`），迭代内**最早回执 `at` → 该迭代最后一条 `release`+`completed` 的 `at`** 的小时数，取已发布迭代的中位数 | receipts | 无已发布迭代 ⇒ `value:null` |
| `deploymentFrequency7d` | `now-7d..now`（含端点）内 `stage:'release' && status:'completed'` 回执数 | receipts | **0 是合法值**（`value:0, sample:0`） |
| `changeFailureRate` | 近 `windowDays`（默认 30）内 `verdict ∈ {fix, reject}` 的行数 / 窗口内 verdict 可判定的行数 | review-history | 窗口内无行 ⇒ `null` |
| `reviewFixHours` | 对 verdict 为 fix/reject 的轮次，找同轮最早 `status:'fixed'` 处置的 `at`，取（fixed − review）小时数的中位数 | review-history + dispositions | 无配对 ⇒ `null` |
| `acceptanceRate` | `passed / (passed + failed + blocked + stale)`；stale 有结果但**不算通过** | acceptance | 分母 0 ⇒ `null` |
| `blockingInventory` | `review.blocking + acceptance.failed + acceptance.blocked`（已判定路 null 按 0，`sample` 记已知几路） | review + acceptance | 两路都不可知 ⇒ `null`；否则数字（0 合法） |

- **坏数据一律跳过**：`at` 解析失败、`round` 不是整数、fixed 早于 review（时钟回拨）都不参与，绝不拿生成时间兜底。
- **0 与 null 严格区分**：数据不足是 `null` 并进 `unavailable: [{metric, reason}]`；"近 7 天确实没发布"是 `0`。
- 中位数：偶数取中间两个平均；小时数保留 2 位、比率保留 4 位小数（客户端/周报再按整数百分比展示）。
- `readMetricLedger(projectPath, {reviewStorage})`：读 `history.jsonl` + `dispositions.jsonl`，返回 `{history, dispositions, dirs, badLines, truncated}`。
  - 口径与 `lib/evidence.js` 一致：`trellis` 优先（扫 `.trellis/tasks/<task>/review`，最多 200 个任务目录），没有才回退本地 `.dsh/claude-review/ledger/review`；`reviewStorage` 可强制 `trellis` / `local`。
  - 容忍坏行（跳过并计入 `badLines`）与缺文件（返回空数组）；每份账本最多读 **2000 行**（取尾部，账本追加写）、单文件 **2 MiB** 上限，超限置 `truncated`。
  - 行上打 `ledger` 目录标签：`reviewFixHours` 只配对**同一账本内**的同号轮次，避免把 A 任务的处置安到 B 任务头上。

#### ② `lib/report.js`（纯函数，无 I/O）

`buildWeeklyReport({ detail, metrics, days, now })` → Markdown：标题（`# <项目名> 项目周报（YYYY-MM-DD ~ YYYY-MM-DD）`，UTC 日期）+ 七个区块
（概览 / 交付指标 / 功能进度 / 验收 / 代码检查 / 最近动态 / 下一步）。

- 指标表三列（指标 | 值 | 说明/来源），`null` 显示 `—`，表后列 **数据缺口**，并附代理口径脚注；
- 空数据写「无」/「—」，**不补 0**；表格单元格的 `|` 与换行转义（定义里有 `|` 也不会打散表格）；
- 验收最多列 20 条未通过（含 `pass` 但 stale 的"需要重新确认"），代码检查给"最近结论"一句人话；
- 最近动态取 `detail.ledger.receipts` 最近 10 条；下一步带指令原文（指令含 ``` 时自动加长围栏）。
- `reportFileName(projectName, now)`：项目名做文件名安全处理（路径分隔符/控制字符换 `-`，空名回退 `project`）。

#### ③ `GET /delivery-cockpit/api/report?path=...&days=7`

- 与 `/panel` **同一道读授权**：`authorize(deps, path)`，缺 path ⇒ 400 `missing-path`，未登记 ⇒ 403 `workspace-not-allowed`；
- `days` 只接受 `7 / 14 / 30`，其它（含 `7abc` / `7.5`）一律 400 `bad-days`（参数不合法时不读盘）；缺省不硬编码，交给 `readReport` 按配置 `reportDays`（默认 `7`）决定，配置覆盖才有效；
- 调 `deps.readReport(auth.path, days === undefined ? {} : { days })`，返回 `{ markdown, filename, days }`；读失败走统一 500 JSON；
- 响应头：`Content-Type: text/markdown; charset=utf-8`、`Cache-Control: no-store`、
  `Content-Disposition: attachment; filename="<项目名>-weekly-<YYYY-MM-DD>.md"; filename*=UTF-8''<percent-encoded>`。
  纯 ASCII 项目名时 `filename=` 与契约逐字一致；中文项目名按 RFC 5987 进 `filename*`（HTTP 头只能是 ByteString，见 §5 偏差）。
- `index.js` 的 `readReport` 复用 `readDetailWithEvidence`（详情 + evidence + metrics 同一条读盘链），不再扫第二遍项目文件；审核账本按指标口径单独读一次（为什么不能与 evidence 共用，见 §5 偏差）；
- 配置：`reportDays` 默认 `7`（`DEFAULT_CONFIG` + `cordis.patch.yml`），面板入口固定带 `days=7`。

#### ④ 面板（`client.js`）

- 主区新增「交付指标」模块，位置在「项目进度」之后、「功能」之前：4 张数卡（交付周期 / 近 7 天发布 / 返工率 / 验收通过率）+ 2 条小指标（修复时长 / 待修问题）。
- 数据来自 `detail.metrics`（`lib/model.js` 的 `metricsSection` 透传；Host 没算 ⇒ `null`，模块显示"数据不足"而不是 0）。
  `value:null` 渲染 `—` 并给弱化样式，`title` 带口径短句 + 缺口原因 + 样本数；`0` 正常显示 `0`；百分比保留整数。
- header 增加 `<a class="dc-btn" href="${API}/report?path=…&days=7">导出周报</a>`：下载由浏览器按 `Content-Disposition` 处理，不新增 `fetch`。
- 样式只用 host 主题 token；4 卡网格在窄屏（容器 ≤700px）降为 2 列，360 宽不溢出。
- 词表沿用现有约定（不出现 引擎正常 / 账本健康 / 门禁 / 回执 / 阻塞 / 失效 / 未验 / 功能账 / 缺陷 / 待决策 等）。

测试：`test/metrics.test.js`（12 条：中位数/窗口边界/0 vs null/坏时间/跨账本配对/验收 stale/库存 sample/真实临时目录的本地与 Trellis 账本读取、坏行、2000 行上限）、`test/report.test.js`（8 条：七区块/日期范围/null 与 0/缺口脚注/空数据不补 0/管道符转义/截断/文件名）、`test/route.test.js` +6（/report 授权、下载头、days=14、days=3 ⇒ 400、中文名 RFC 5987、读失败 500）、`test/model.test.js` +1（metrics 透传与 null/0）、`test/client-smoke.test.js` +3（指标模块文案/顺序/导出入口）。全量 `node --test "test/*.test.js"` = **505 个用例全绿**。

### 3.23 P1 兼容与轻量（2026-11-23）

- **老项目 grandfather**：`lib/receipts.js` 读取时保留 `legacyStage`（raw stage ≠ canonical 时）；`evidence.legacyProject.active` = 当前迭代有旧 stage 回执且没有 `approvals.json`。状态机在该迭代跳过范围/架构/验收/发布签核、架构/测试/发布技术门与"空任务先拆任务"，但保留审核/验收/发布动作；一旦开新一轮（canonical 回执）自动恢复 9 阶段门禁。
- **轻量模式**：`.dsh/plugin-state/project.json` 的 `workflow: "light"` 会跳过架构契约门与范围/架构签核（面板 notes 注明），用于小改动；原型、测试、验收、发布门照旧。`buildDefaultCard` 默认写 `workflow: "full"`。
- **Trellis 初始化**：`cockpit_init` 新增可选参数 `trellisInit: true`；显式开启时若 `.trellis/scripts/get_context.py` 不存在且 subprocess/Trellis CLI 可用，执行 `trellis init --dsh -y -s -u <系统用户名>`；缺服务/CLI 时安全跳过并在返回值 `trellisInit.status/reason` 说明，失败不阻断 init。
- **MCP 可用性**：`readMcpNames` 排除 `mcpManager` 中 `status.state` 为 `failed/disabled/closed` 的 server（reconnecting 仍算已配置），避免面板对断连的 MCP 下发注定失败的指令。
- **周报窗口**：`/report?days=7|14|30` 的 days 现在同时作为 `computeMetrics.windowDays`（7/14/30），不再只改标题；部署频率仍是近 7 天。
- **团队泳道**：项目子目录里的会话也算该项目（worktree 仍是独立路径）。
- **D4 测试门结构校验**：command 非占位（拒绝 <...>/todo/tbd/n-a）、t 可解析、passed+failed ≥1；可选 xitCode 必须 0、durationMs 必须非负。插件不代执行测试命令。
- **D5 FR 验收覆盖**：验收签核时若 PRD 能提取出 FR，则每条 FR 必须有带 eature_ref 的验收条目，缺失列进 missing；PRD 没有 FR 结构时跳过（不猜）。
- **D7 requireArchitectureGate**：配置默认 true；false 时跳过架构契约技术门（范围/架构签核也可由轻量模式跳过）。
- **D9 playbook 迁移**：版本不一致时不再整份忽略 stages，而是把旧中文 key（初始化/搭骨架/想清楚/定规格/写代码/挑毛病/验效果/发出去）映射到 9 阶段并合并字段，无法映射的 key 单独 warning。

测试：**529 passed / 0 failed**。

### 3.24 产品增强 P4（面板开关 / Trellis 入口 / 线上 DORA）

- **workflow 开关**：`POST /delivery-cockpit/api/workflow` body `{path, workflow:'full'|'light'}`，只改 `.dsh/plugin-state/project.json` 的 `workflow` 与 `updatedAt`（`setWorkflow`，保留名片其它字段）；非法值 400，缺名片/坏名片 409。面板 header 显示「完整流程 / 轻量模式」按钮，切换后自动刷新；`panel.project.workflow` 由 model 下发。
- **Trellis 入口**：`lib/trellis.js#initializeTrellis` 抽成 Host 共享实现（`cockpit_init {trellisInit:true}` 与 `POST /api/trellis-init` 共用）；只有 `.trellis/scripts/get_context.py` 不存在时才跑 `trellis init --dsh -y -s -u <user>`，缺 subprocess/CLI 返回 skipped 不报错；`evidence.trellis.ready` 表示运行时真的可跑。面板在 `initialized && !ready` 时显示「接通 Trellis」。
- **线上 DORA**：可选 `.dsh/plugin-state/dora.json`，schema `{deployments:[{at, version?, success?, leadTimeHours?}], incidents:[{at, resolvedAt}]}`。`lib/dora.js` 做只读归一（坏行计数、坏 JSON 不降级）；`computeMetrics` 有线上数据时用真实发布/失败/恢复时长替换代理的发布频率、变更失败率、交付周期，并新增 `mttrHours`；`metrics.source='live'|'proxy'`，面板 meta/脚注、周报定义同步说明来源；没接线上数据时 `mttrHours=null` 并说明原因，不补 0。
- **验证**：562 passed / 0 failed；新增 dora/project-card/route/evidence/client 用例。


### 3.25 评审器切换：Claude / Gemini（2026-11-27）

- 项目配置 `.dsh/plugin-state/review.json`：`{agent:'claude'|'agy', model:'', agyProxy:''}`；面板「代码检查」可切换并保存，不同项目互不影响。缺文件/坏 JSON 回退插件默认值（Claude）。
- 工具 `claude_review` 每次执行读项目 profile，合并到插件 settings；`buildReviewParts` 传 `-Agent` / `-Model` / `-AgyPath` / `-AgyProxy`；`agent=agy` 时强制 ACP，不允许 CLI 回退。
- 新增 `scripts/agy-acp-review.mjs`：启动 `agy acp --sandbox --disable-telemetry`，只向子进程注入 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY`（含小写与 `NO_PROXY`）；ACP initialize 后建会话、systemPrompt 注入 reviewer role、切 `plan` 模式、权限回调只允许 read/search；模型用 `session/set_config_option` 设置，支持 `gemini-4-hydrogen-high` 这类“模型 + 推理档位”后缀拆分。
- 只读兜底：写/执行/联网权限一律拒绝；评审前后由引擎/桥接保持工作区检查；不使用 `--dangerously-skip-permissions`。
- 输出归一：agy 文本里的最后 JSON 对象作为 `result`，PowerShell 引擎对嵌套 result 做 `ConvertTo-Json` 后再解析，兼容现有账本/面板。
- 测试：Claude 路径不变；新增 profile/route/client/provider 测试，真实 agy 引擎在临时仓库跑通（transport=acp, model=gemini-4-hydrogen-high）。


### 3.26 需求阶段的输入口径（2026-11-28）

- **brief 是可选项**：`docs/brief.md` 存在时，需求定义的指令说「把 brief 收敛成需求」；不存在时直接说「用目标/场景/约束写需求，不必先补 brief」，不允许 agent 编造一份 brief。`evidence.brief` 只用于把话说准，不做门禁。
- **PRD 不覆盖**：`docs/prd.md` 已存在时，指令明确「不要重写，只补缺失的 FR 与验收标准」，避免存量项目被覆盖。
- **谁决定优先级**：PRD 由 agent 起草，但功能范围与优先级必须由人通过「范围签核」确认，指令里写明不要替人拍板。
- **项目 playbook 会盖掉内置更新**：`cockpit_init` 会把内置 playbook 复制进项目；之后内置模板更新不会自动进项目。需要同步时改 `.dsh/plugin-state/playbook.json` 对应 stage，或删掉该文件改用内置。

### 3.27 工作流归插件所有（2026-11-28）

**问题**：把 trellis-brainstorm / frontend-design / tdd-loop 这类第三方 skill 当成阶段 method，等于把流程交给不理解驾驶舱状态的组件——它们不知道项目是新的还是存量的，也不知道当前该做哪一步，指令只能靠"猜"。

**改法**：

1. **插件自带阶段技能**：`skills/cockpit-<stage>/SKILL.md`（9 个），每个都写清「何时用 / 先读什么 / 新项目怎么做 / 存量项目怎么做 / 步骤 / 产物 / 硬约束」。`cockpit_init` 把它们释放到项目 `.dsh/skills/`（幂等，已存在则 skipped）。
2. **method 指向自带技能**：`templates/playbook.json` 9 个阶段的 `method` 全部改为 `cockpit-<stage>`，并新增 `kit` 字段；`renderPrompt` 在指令前加一句「按技能 `.dsh/skills/<kit>/SKILL.md` 执行本阶段」。
3. **第三方降级为工具**：trellis-*、frontend-design、tdd-loop、verify-claims、playwright 等仍列在 `capabilities` 里，但只是「可选工具」，缺了不影响流程。
4. **新/存量由驾驶舱判定**：新增 `lib/shape.js`，依据工程文件、源码目录、需求文档、已有回执给出 `new` / `existing` 与理由；写进 `evidence.shape` → `panel.project.shape`。skill 一律读这个结论，不许自己扫一遍再猜。
5. **回执校验随之收紧**：`used_skill_or_mcp` 必须包含 `cockpit-<stage>`（可再附带实际用的工具，如 `cockpit-implementation, tdd-loop`），否则 `cockpit_report` 拒绝写入。

## 5. 实现偏差记录（实现期确认，均已在测试中固化）

写在这里是为了让下一个人知道"为什么与契约字面不同"，而不是当成漏做。

**数据层**

- `readReceiptsFromText` 是**同步**纯函数（§3.1 字面写了 `async`）；`await` 同步返回值兼容，且更符合"纯函数"。
- `planInit` 额外返回 `templatesDir`；`applyInit(projectPath)` 允许自行现做计划（route 层只传一个参数）。
- `mergeDetected` 遇到 `unknown` 保留上一次已确认的 stack/commands（"没检测到" ≠ "没有技术栈"），只更新 `updatedAt`。
- Node 项目若无 `packageManager` 字段也无锁文件 ⇒ dev/build 为 `null` + notes，**不默认 npm**。
- Java 的 build 取 `mvn package` / `./gradlew build`（契约只写了 spring-boot 的 run 命令）；dev 严格只在 spring-boot 出现时给。
- `writeProjectCard` 返回 `{ok,path,bytes}`；`cardStatus` 同时接受名片对象与 `readProjectCard` 结果（后者才能表达 `broken`）。
- `applyInit` 的 `created` 同时包含目录与文件（`.trellis`、`.dsh/plugin-state`、四个文件），`skipped` 同理。

**业务层**

- `mergePlaybook` 返回合并后的 playbook（`source/warnings` 由 `loadPlaybook` 包装）。
- `evidence` 比契约多三处：`acceptance.appliesToCurrent`、`acceptance.passWithoutEvidence`、顶层 `dataGaps`（§2.5 要求"过期表不参与判定"，但要有地方说清楚）。
- `review` 不可用时 `rounds/blocking/fixed/lastRound` 是 **null 而不是 0**（`no-ledger` / `read-error` 都不默认 0）。
- `review` 账本坏行按 `read-error` + degraded 处理：跳过坏行会让 blocking 口径不可信，宁可整段降级。
- `tasks.available` = ".trellis 已初始化"（已初始化但还没任务时 `available:true,total:0`），否则 §3.7 的"拆任务"分支永远触发不到。
- `playbook` 的 `missingHints` 只有 skill/mcp；缺 `tool` 时用中性兜底文案（UI 文案，不是数据编造），项目可覆盖。
- `ledger.receipts[].needsDecision` 返回**决策对象或 null**（不是布尔）：账本区要展示 title/options。
- 优先级 2 的 title 取回执 `needs_human_decision.title`，但会去反引号并按 20 字截断（人话硬约束优先）。
- `progression` 保证**最多一个** `current`：整轮已发布（优先级 14）时该轨没有 current，不为凑数伪造。

**功能账（V1.0.1 补）**

- `evidence.review` 新增 `blockingIssues`（全量，上限 200；`issues` 仍是前 3 条给列表用）：功能账要按文件路径归属 bug，只给 3 条会把其余 bug 误算成「未归属」。
- `cockpit_report` 新增可选 `feature_ids: string[]`（落盘统一去空格 + 大写）；`acceptance.json` 条目的 `feature_ref` 直接透传（evidence 的 items 保留原始字段）。
- `evidence.tasks.items[]` 新增 `relatedFiles`（上限 50）：自动归属要用任务的声明范围，不能凭空猜。

**功能账（V1.0.2 补：自动归属 + 验收起草）**

- 自动归属的锚点优先级：回执自报 `feature_ids` > 任务标题里的 `FR-<n>` + `relatedFiles`。**推断只用于挂回执，不反向扩大功能路径**（否则一条 `web/**` 会把所有功能连起来）。
- 界面新增 `inferredReceipts` / `anchors{receipts,tasks}`：自动归属必须能一眼看出"为什么算在这条功能上"。
- 新增工具 `cockpit_acceptance`（第三个工具）：只追加、绝不覆盖已有 `result/evidence`；`bootstrap` 阶段拒绝（验收表属于迭代环）；坏表/跨迭代一律拒绝写入。
- `acceptance-draft` 的下一步指令由模型按功能账改写（点名还缺的 `FR-x` 并指向 `cockpit_acceptance`）；这是唯一一处覆盖 playbook 模板的地方，已在上文 §3.15 写死。
  - 独立评审第 1 轮 important：改写**必须在 `action.disabled === false` 时才发生**，且只改 instruction/notes/buttons，绝不改 `disabled`/`disabledReason` —— 否则会把"缺必需能力不下发指令"这道防线绕过去。
- 自动归属的 note 按**唯一回执**计数（一条回执覆盖多个功能时是"多处归属"，不是"多条回执"）；`task_ref` 指向不存在的任务时优雅降级为空。
- **技能可见性修正**（live 实测发现）：只信 `ctx.skills.list()` 会把用户目录里装着的技能报成"缺失"（root context 只看得到 global 层），
  于是"验效果"这类阶段被错误禁用。现在 `readSkillNames` = 服务 ∪ 磁盘扫描（`$DSH_HOME/skills`、`~/.agents/skills`、项目两个目录；
  跟随符号链接、目录名与 `SKILL.md` 的 `name:` 都收）。实测修正后 `verification-before-completion` 由 `no` 变 `yes`，只剩真正没装的 `playwright` 报缺失。
- 状态优先级按实现收敛为：`有阻塞`（归属 bug）> `已完成`（验收全 pass 且有证据）> `进行中`（in_progress/blocked 回执，或验收部分有结果）> `待验收`（completed 回执但没验收通过）> `未开始`（无任何关联证据）> `—`（验收表坏了且无证据）。
  - 关键修正：**验收草稿（result 全 null）不是证据**——它曾经让"什么都没做"的功能显示「待验收」，语义反了。
- 每条功能的 `bugs.known` 独立判断：账本不可用，或该功能没有任何可归属路径而账本里确有 bug ⇒ `false`（界面显示 `—`）。**不写 0**。
- 路径匹配：`write_scope`/`artifacts` 归一成正斜杠、去 `./`、折叠重复斜杠、去尾部 `/**`/`/*`/`/`；按"等于或前缀 + `/`"匹配 issue.file。
- PRD 提取跳过代码围栏、按 id 去重、`(P0)`/`（P1）` 解析并从标题剥离；没有「功能需求」小节时全文兜底并留一条建议；完全没有 FR 结构 ⇒ 空 + 格式提示。

**功能账（V1.0.3 补：面板内填验收结果）**

- 面板新增写动作 `POST /acceptance-result`（另一处写接口）：只允许已登记工作区 + 同源 + JSON；`pass` 强制证据，且项目内路径必须真实存在、不越出项目（`http(s)` URL 放行）。
- 模型载荷 `panel.acceptance.items`（≤100 条，`truncated` 标记截断）：界面据此渲染验收清单与四个动作按钮，**不在前端重算通过数**（counts 仍由 Host 算）。
- `result:null` 语义 = 撤销（清空 result/at/evidence）。理由：保留"未验但有证据"的状态会让"通过必须附证据"这条不变量出现歧义。
- 证据最多 20 条；超过的截断（不报错），避免病态输入撑爆写盘。
- **`result` 必须显式给**（独立评审第 1 轮 important）：字段缺失或 `undefined` ≠ 撤销，直接 400 `bad-result`；
  路由层只透传客户端真的给了的字段，避免"漏字段"被下游解释成"清空人已经填好的结果"。
- **证据按结果分级校验**（独立评审第 2 轮 important）：`pass` 才校验文件存在；`fail`/`blocked` 只规整不校验；
  `null`（撤销）无条件成功、完全不碰磁盘。理由：撤销/改判不该被"旧截图已被删除"卡死。

**功能账（V1.0.4 补：面板截图）**

- 截图引擎用 **CDP + 本机 Chrome/Edge**，不引 Playwright 依赖：本机没装 Playwright MCP 时"点一下就出图"必须由 Host 实现；装了 Playwright 的机器 Agent 仍可走 MCP。
- 只允许**回环地址**（SSRF 边界写死，不做任意 URL 抓取）；浏览器不存在时明确报 `browser-not-found`，不静默降级、不自动安装。
- 截图写进 `.dsh/plugin-state/shots/`（不是项目的 `shots/`）：插件仍然只写自己的状态目录。
- **截图只挂证据、不改 result**：截了图 ≠ 验过了，通过仍要人点。这是"证据"与"判断"之间的线。
- 缩略图经 `GET /shot` 读取：只允许项目内图片、≤10 MiB，路径穿越/非图片一律拒绝（避免变成任意文件下载器）。
- **独立评审第 1 轮 2 条 important 已修**：① Windows 上杀整个进程树（taskkill /T）+ 临时 profile 延迟重删；② 单一 deadline 贯穿 + 客户端断开经 AbortSignal 中止（断开时不写盘、不挂证据）。
- **第 2 轮 3 条 minor 已修**：截图返回前再查一次 abort（断开不写盘）；挂证据失败时删除已写的孤儿截图；`SCREENSHOT_STATUS` 补 `evidence-not-found`→409 / `bad-evidence`→400；客户端截图超时改 90s 常量并注明必须大于 Host 的 `screenshotTimeoutMs`。

**功能账（V1.0.5 补：截图自动对比上一版）**

- 比较的是**该条验收项证据里的最后一张图片**（截图按顺序追加）。为什么不做"按文件名版本号"：证据顺序就是人看到的顺序，不受重命名影响。
- 变化占比的阈值（`maxRatio`）默认 0.1%：纯像素全等会被字体栅格/抗锯齿噪声打破，用比例抗抖动；单通道差 ≤ 8 再过滤一层。
- **小面积改动不能漏**（独立评审第 1 轮 important）：只按占比判会漏掉"一个按钮换色、一行文案改字"（几十个像素、占比 0.00x%），所以加了 `minChangedPixels=24` 下限——变化 ≥ 24 像素就判 `changed`，与占比阈值取"更敏感"的那条。想更敏感可把下限调到 1（代价：抗锯齿噪声可能误报）。
- 尺寸不同单独给 `different-size`，**不能**折成比例（否则"页面长高了"会被判成 0 差异）。
- 基线是 URL / 文件已删 / 格式不支持 ⇒ `uncomparable` + reason，绝不"假装比过"。
- 只有 `changed` 才生成 diff 图，存 `.dsh/plugin-state/shots/diff-*.png`，只记在 `shotDiffs[].diffFile`，**不进证据列表**（证据只放真实截图）。
- `shot_diffs` 每次截图一条、最多保留 20 条；面板只展示最近 5 条（Host 下发已截断）。

**功能账（V1.0.6 补：视觉变化联动阶段门）**

- 语义：**截图变了 ⇒ 之前那次 pass 失效（stale），但 result 不改**。理由：result 是人做过的判断，删掉等于篡改历史；失效标记让"阶段门不再认它"，同时保留可追溯。
- 触发条件（三件同时成立）：该条原本 `result==='pass'`；本次 `shotDiff.verdict` ∈ `changed|different-size`；`invalidateOnVisualChange !== false`（配置默认 true）。
- 失效后：`evidence.acceptance.passed` 排除它、`stale` 单独计数、`withResult` 也不把它算"验过"（否则功能会停在"进行中"）；`acceptanceAllPass` 返回 false ⇒ 状态机退回「验效果」，`verificationReason` 点名「有 N 条验收因截图变化失效」。
- 清除：人重新点任意结果（通过/失败/阻塞/撤销）⇒ `stale` 清空；**`same` 截图不会把失效冲掉**（变了就是变了）。
- `new` / `same` / `uncomparable` 不触发失效（无法证明变化，不制造假紧张）。
- **第五处口径**（独立评审 important）：`lib/features.js` 的按功能 `acceptanceStatsOf` 也必须排除 stale 的 pass，否则会出现"功能账显示已完成、阶段门却拦在验效果"的自相矛盾；功能账同步透出 `acceptance.stale` 计数。
- **失效留痕**（V1.0.7，9 阶段迁移后 stage 改为 `acceptance`）：失效时自动追加一条 `cockpit_report` 回执（`stage:'acceptance'`、`status:'in_progress'`、`event:'acceptance-stale'`、`summary` 写明"截图有变化 x%，验收「标题」已失效，需要你重新确认"、`artifacts` 放本次截图、`feature_ids` 取条目的 `feature_ref`）。配置 `receiptOnInvalidate` 可关；回执写失败只回 `receiptWarning`，**不把截图流程判失败**（截图与失效已落盘，trace 失败要如实说而不是回滚数据）。
  - **审计事件不投影**（独立评审 important）：`stage:'acceptance'+status:'in_progress'` 若被当成进度，会让功能显示进行中、进度轨永久卡在验收确认。所以带 `event` 的回执在 `stageStates`、进度轨与功能账里一律跳过（`isAuditReceipt`），只保留在流水账；**待决策判定同样跳过**（审计回执不能静默吞掉 `needs_human_decision`）。

**功能账（V1.0.8 补：Agent 主动写验收复核回执）**

- `cockpit_report` 新增可选 `event`，当前只接受 `acceptance-recheck`（验收复核）。工具 schema 的 `enum` 就是白名单；`additionalProperties:false` 不变。
- 写入口（`validateReceipt`）强制事件与 stage/status 配对：`acceptance-stale` ⇒ acceptance + in_progress；`acceptance-recheck` ⇒ acceptance + completed。配错直接抛错，避免"复核"回执伪装成别的阶段进度（旧 `verification` 先归一为 `acceptance`）。
- 这类回执是**审计事件**：进流水账、面板账本行显示「验收复核」徽章，但 `stageStates`/进度轨/功能账/待决策全部跳过它；`result` 永远不由回执改，必须人在面板点。
- 可发现性：`templates/playbook.json` 的「验收确认」指令里写明用法（`cockpit_report` + `event:"acceptance-recheck"` + `stage:"acceptance"` + `feature_ids`），出口条件补「没有失效（stale）条目」。
- 审计回执**不能携带 `needs_human_decision`**（写入口拒绝；`pendingDecision` 也跳过审计回执），避免"复核留痕"顶出一个来源错误的决策卡。

**接线层**

- 缺阻断能力时 `instruction` 一律 `null`（哪怕 playbook 模板存在）并 `disabled:true` —— 否则"复制/发送"会把注定失败的指令发出去（design §6.3）。这是 Lead 评审时补的。
- 写接口额外做了三件契约没写但必须的事：`Origin` 存在时必须同源、`content-type` 必须是 JSON、body 上限 64 KiB（413）。
- `cockpit_init` 的 `dryRun` **默认 true**；显式 `dryRun:false` 才写盘。
- **工具层写授权**（独立评审第 1 轮 important，第 2 轮收紧为 fail-closed）：显式 `cwd` 是模型可控参数，必须过 `authorizeWrite` —— 与 HTTP 层同一道闸门：只能是已登记工作区（写层额外允许其子目录，因为会话可能在子目录里工作；读层只认精确登记路径）。无法确认归属时（服务不可用 / 列表读不到 / 一条工作区都没登记）**一律拒绝**，不再 fail-open 放行。`resolveByPath` 的返回值也要再做一次归属校验，避免两条分支语义不对称。会话自身的工作目录不是模型参数，不走这道校验。
- `agentCwd` **不再回退 `process.cwd()`**：取不到会话工作目录就报错，避免把状态写进 DSH 进程启动目录。
- `readReceipts` 加了 2 MiB 上限：超限只读**尾部**（最新回执），并丢掉落点处的半行、置 `truncated`；`evidence` 据此给一条 warning（不降级）。
- `approvals.js` 的临时文件名改用随机串（不再用 pid），并发批准不会撞名。

**界面层**

- 只注册两处 slot（`main` + `sidebar.panellist`），不注册 `conversation.*` / `shell.overlay`（Phase 1 不做提醒与通栏）。
- `ledger.badLines > 0` 不置 `degraded`（§3.6 规定坏行只计数），只出顶部提示，主按钮仍可用。
- 降级（`confirm-data`）时 `buttons: []`，界面呈现原因 + 重试，而不是一个被禁用的主按钮。

**交付指标 + 周报（P3）**

- `computeMetrics.windowDays` 只接受 `7 / 30`：`/report` 的 `days=14` 只影响标题日期范围，不改变"返工率 = 近 30 天"的代理口径（不为了让参数看起来有用而偷偷改指标）。
- `blockingInventory` 数据全缺时返回 `null`（不是 0 项）：按 `review.available` / `acceptance.missing` 判已知性，`model.js` 透传 null，面板显示 —；`sample` 记已知几路，`unavailable` 写"检查与验收都还没读到"。
- `deploymentFrequency7d` 的 `sample` 等于 `value`（都是窗口内的发布回执数）——契约没有更细的样本概念，不造一个没含义的数字。
- **`Content-Disposition` 中文文件名**：HTTP 头值只能是 ByteString，中文直接进 header 会让 `new Response` 抛 `Cannot convert argument to a ByteString`。因此非 ASCII 项目名用 `filename*=UTF-8''<percent-encoded>`，再给一个纯 ASCII 的 `filename=` 回退；纯 ASCII 项目名时两份一致、与契约逐字相符（`filename="demo-weekly-YYYY-MM-DD.md"`）。
- `readMetricLedger` 返回 **对象** `{history, dispositions, dirs, badLines, truncated}` 而不是单个数组：`reviewFixHours` 必须按"账本目录 + 轮次"配对（只按 round 会把别的任务的处置算进来），两个数组是配对所需的最小信息。
- 周报日期一律按 **UTC** 取：周报是导出文件，同一份数据在任何时区都应得到相同的标题与文件名（测试也按 UTC 断言）。
- **指标层单独读一遍审核账本**（不跟 `evidence.review` 共用解析结果）：`evidence` 只回计数，且它把任何坏行当 `read-error` 整段降级；指标口径要求"坏行跳过、能算多少算多少"。两种失败语义不同，共用会让指标因为一行历史坏数据全部变 `null`。代价是面板刷新时账本 I/O 两次（真实项目任务目录很少，可接受）。
- `acceptanceRate` 的 definition 写明真实分母：`通过（含证据）/（通过+没通过+卡住+需重新确认）`——`stale`（需重新确认）计入分母、`pass` 但没证据的条目不计入，文案与算法一致，避免"有结果但没证据"被误读成已计入。
- 面板「交付指标」模块 meta 只写「代理口径」不写「近 N 天」：六项里只有发布频率（近 7 天）与返工率（近 30 天）是窗口口径，交付周期/修复时长看全部历史，一个窗口前缀会把整组指标说成同一口径；窗口细节放在每项 tooltip 与脚注。

### 3.28 驾驶舱命令面（2026-11-28）

- 借鉴 Trellis 的命令划分（start / continue / check / finish-work / update-spec / break-loop），但实现是自己的：`skills/cockpit-start|continue|check|finish-work|spec|break-loop`，随包发布、由 init 安装。
- playbook 顶层新增 `commands` 元数据（id / title / when），面板投影为 `panel.commands`。
- 阶段能力里不再出现 `trellis-*` 技能：Trellis 只作数据来源（`.trellis/tasks`、`.trellis/spec`、审核账本），**不执行 `trellis` CLI**；没有 Trellis 时命令照常工作。
- 命令与阶段技能的分工：阶段技能做"这一步的具体工作"，命令处理跨阶段动作（开工/续作/自检/收尾/沉淀/破循环）。

