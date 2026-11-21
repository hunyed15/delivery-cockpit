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

- `stage` ∈ `init|scaffold|brainstorm|prototype|coding|code_review|verification|release`
- `status` ∈ `in_progress|completed|blocked|failed|dropped`
- `iteration_id`：冷启动固定 `"bootstrap"`；迭代环用 `v1.0` / `v1.1` 等
- `coding` 阶段强制 `task_ref` 非空 + `write_scope` 非空数组
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

内置默认在包内 `templates/playbook.json`（8 阶段）。项目覆盖文件的合并规则：

- 顶层 `missingHints`：按 key 覆盖；
- `stages`：同名 stage **整体替换**（不做深合并，避免半覆盖产生语义不明的阶段）；未提到的 stage 保留内置；
- 非法 JSON / 结构不是对象 / `stages` 不是对象 ⇒ 忽略覆盖 + 一条 warning，回退内置（绝不半信半疑）。

**stage 对应关系（代码常量，写死一次）**：

| receipt `stage` | playbook key | 人话阶段名 | 备注 |
|---|---|---|---|
| `init` | 初始化 | 初始化 | 冷启动 |
| `scaffold` | 搭骨架 | 搭骨架 | 冷启动 |
| `brainstorm` | 想清楚 | 想清楚 | 迭代环 |
| `prototype` | 定规格 | 看原型 | 迭代环；"定规格"是 playbook 的写法 |
| `coding` | 写代码 | 写代码 | 迭代环 |
| `code_review` | 挑毛病 | 挑毛病 | 迭代环 |
| `verification` | 验效果 | 验效果 | 迭代环 |
| `release` | 发出去 | 发出去 | 迭代环 |

playbook 条目若自带 `stageId` 字段则以它为准（给项目覆盖留的口子）。

### 2.4 `.dsh/plugin-state/approvals.json`（原型批准，按迭代）

```json
{"v1.0":{"prototypeApprovedAt":"2026-11-20T22:10:00+08:00","prototype":"prototype.html"}}
```

- 必须按 `iteration_id` 存；`bootstrap` 不算任何迭代的批准。
- 文件缺失/坏 JSON ⇒ 视为"没有批准"（不是报错）；坏 JSON 记一条 warning 并降级。
- 读写实现见 `lib/approvals.js`（Lead 提供，`evidence.js` 直接 import，不要另写一份解析）：
  - `readApprovals(projectPath)` → `{ map, badJson, missing }`
  - `approvalFor(map, iterationId)` → `{ approved, at, file }`（`bootstrap` 恒 false）
  - `findPrototype(projectPath)` → `prototype.html` / `docs/prototype.html` 的相对路径或 `null`
  - `approvePrototype(projectPath, iterationId)` → `{ok:true,approval}` / `{ok:false,error:'iteration-required'|'prototype-missing'}`

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
export const STAGES            // 顺序：init, scaffold, brainstorm, prototype, coding, code_review, verification, release
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
  { id:'init',         name:'初始化', playbookKey:'初始化', cycle:false },
  { id:'scaffold',     name:'搭骨架', playbookKey:'搭骨架', cycle:false },
  { id:'brainstorm',   name:'想清楚', playbookKey:'想清楚', cycle:true },
  { id:'prototype',    name:'看原型', playbookKey:'定规格', cycle:true },
  { id:'coding',       name:'写代码', playbookKey:'写代码', cycle:true },
  { id:'code_review',  name:'挑毛病', playbookKey:'挑毛病', cycle:true },
  { id:'verification', name:'验效果', playbookKey:'验效果', cycle:true },
  { id:'release',      name:'发出去', playbookKey:'发出去', cycle:true },
]
export function stageDef(id)          // -> STAGE_DEFS 里那一条 | null
export function stageName(id)         // -> 人话名（未知则原样）
export async function loadPlaybook(projectPath, builtinText)
// -> { playbook, source:'builtin'|'project', warnings:[{source,message}] }
export function mergePlaybook(builtin, override)   // 规则见 §2.3，纯函数
export function entryForStage(playbook, stageId)   // -> playbook.stages[playbookKey] | null
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
  approval: { approved, at, file },  // 当前迭代的原型批准（bootstrap 恒 false）
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
| 3 | `!trellis.initialized` | `init` | `init` |
| 4 | `!prd.found` | `brainstorm` | `brainstorm` |
| 5 | `!approval.approved` | `prototype` | `prototype` |
| 6 | `tasks.open > 0` | `coding` | `coding` |
| 7 | `tasks.available && tasks.total === 0` | `coding`（拆任务） | `coding` |
| 8 | `review.blocking > 0` | `fix-blocking` | `code_review` |
| 9 | `review.fixed > 0` | `recheck` | `code_review` |
| 10 | `review.available && review.rounds === 0` | `first-review` | `code_review` |
| 11 | `acceptance.empty` | `acceptance-draft` | `verification` |
| 12 | `!acceptanceAllPass(evidence)` | `verification` | `verification` |
| 13 | `!released(evidence)` | `release` | `release` |
| 14 | 其余 | `next-iteration` | `release` |

补充规则（实现层澄清，design 未覆盖但必须给唯一答案）：

- `review.available === false` ⇒ 规则 8/9/10 跳过（`notes` 记"未接审核账本，跳过挑毛病判定"）；只有当 `review.reason` 是**读失败**时才走规则 1（已在 `degraded` 中）。
- `acceptanceAllPass`：`items` 非空 && 每条 `result === 'pass'` && `evidence` 非空。
- `released`：当前迭代存在 `stage:'release' && status:'completed'` 的回执。
- 规则 2 的 `title` 用 `needs_human_decision.title`（这就是"最高优置顶"）。
- 全部 `title` 必须是**人话**（≤ 20 字），`reason` 一句为什么（≤ 40 字），不含代码。

### 3.8 B · `lib/model.js`

```js
export function buildOverviewRow({ id, title, path, evidence, generatedAt })
// -> { id, title, path, initialized, stageId, stageName, nextKind, nextTitle, degraded, hasDecision, updatedAt }

export function buildDetailModel({ evidence, playbook, stageCapabilities, generatedAt })
// stageCapabilities: { [stageId]: resolved[] }  由调用方先 await resolveCapabilities 得到
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
    capabilities: resolved,    // 本阶段能力（含 present 状态）
    missing: [{name, kind, message}],
    disabled, disabledReason, notes,
    buttons,                   // ['copy'] / ['init'] / ['copy','init'] …
  },
  progression: {
    coldStart: [{ stageId, name, state:'done'|'current'|'pending', receipt: {status,at,summary}|null }],
    cycle:     [ 同上 6 条 ],
  },
  ledger: {
    receipts: [{ id, at, iterationId, stage, stageName, status, summary, artifacts, usedSkill, needsDecision, taskRef, writeScope }],
    total, truncated, badLines, missing, lastAt,
  },                              // receipts 最多 20 条（时间倒序），total 是全量条数
  acceptance: { total, withResult, passed, failed, blocked, empty, badJson },
  review: { available, reason, rounds, blocking, fixed, issues },  // issues 最多 3
  tasks: { available, total, open, completed, items },             // items 最多 20
  warnings: [{source,message}],   // 最多 20
  dataGaps: [{source,message}],
  degraded: { flag, reasons },
}
```

- 阶段进度：某阶段在该迭代有 `completed` 回执 ⇒ `done`；有回执但非 completed ⇒ `current`；没有 ⇒ 看决策 `stageId` 是否等于它 ⇒ `current`，否则 `pending`。冷启动两阶段对 `bootstrap` 迭代；迭代环六阶段对当前迭代。
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
}
```

路由（前缀 `/delivery-cockpit/api`，均 JSON）：

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/workspaces` | `{ok:true, projects, generatedAt}`；`listWorkspaces` 抛错 ⇒ 500 `{ok:false,error}` |
| GET | `/panel?path=` | 无 `path` ⇒ 400 `{ok:false,error:'missing-path'}`；未授权 ⇒ 403 `{ok:false,error:'workspace-not-allowed'}`；否则 `{ok:true, panel}` |
| GET | `/init-plan?path=` | 同上授权；`{ok:true, plan}` |
| POST | `/init` | body `{path, confirm:true}`；`confirm!==true` ⇒ 400 `confirm-required`；未授权 ⇒ 403；成功 `{ok:true, applied, created, skipped, gitignoreHint}` |
| POST | `/approve-prototype` | body `{path, iteration_id}`；未授权 ⇒ 403；迭代为空/bootstrap ⇒ 400 `iteration-required`；找不到 `prototype.html` ⇒ 409 `prototype-missing`；成功 `{ok:true, approval:{iterationId, prototypeApprovedAt, prototype}}` |
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
  - `cockpit_report` —— design §5.1 逐字（字段/required/枚举/additionalProperties:false）。
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
- 一屏四区（design §4）：① 项目名片 & 迭代头 ② 唯一下一步（title/reason/能力/指令 + 复制 + 初始化按钮 + `kind==='prototype'` 时的「通过原型」按钮）③ 迭代进度（冷启动 2 + 迭代环 6 的进度线）④ 人话账本（最近回执 + 待决策 + 坏行提示）。底部：主会话活跃（Phase 1 不接，显示 `—`）+ 引擎正常（`ok:true`）+ 上次回执相对时间 + 刷新。
- 「通过原型」：`POST /delivery-cockpit/api/approve-prototype`（body `{path, iteration_id: panel.iteration.current}`）；成功后刷新。错误码映射人话：`prototype-missing` → 「先把原型 HTML 放到项目根目录 prototype.html，再点通过」；`iteration-required` → 「当前迭代还没确定」；其余显示原文。
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
    acceptance: { total, passed, failed, blocked, missingEvidence },
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

## 4. 验收（真机）

1. `npm test`（= `node --test "test/*.test.js"`）全绿。
2. `plugin_manager(action:"install_bundle", target:<本目录绝对路径>)` → `application: applied`（不是 failed/restart-required）。
3. `cordis_inspect_query(platform:"host", provider:"Tool", method:"listTools")` 能看到 `cockpit_report` 与 `cockpit_init`。
4. 路由：`/delivery-cockpit/api/workspaces`、`/panel?path=<已登记工作区>` 返回 200；未登记路径 403；缺 path 400；`prototype-missing` 409。
5. 面板页面：侧栏出现「交付」入口，点击进入总览 → 详情；一屏四区内容来自真实 `.dsh/plugin-state/`。
6. 视觉：`tools/preview` 截图核对四区、窄屏不溢出、degraded 横幅一致。
7. 独立评审：`claude_review` 跑一次，blocking 清零。

实测记录（2026-11-20/21，DSH 0.2.2-rc.5 / Node 24.20）：

- 1/2/3/4/6 全部通过；`npm test` = 271 用例全绿。
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
- 第 5 条的 **页面内点击** 属人工确认项（agent 打不开带鉴权的 GUI）；视觉由 `tools/preview` 的真实 React + CDP 截图覆盖：`features.png`（功能账主视图）/ `features-prd-missing.png` / `features-no-fr.png` / `degraded.png` / `overview.png` / `features-360.png`（360px 无横向溢出）。
- 改动 Host 代码后需要**重载插件**（disable→enable 或重启 DSH）才生效；只改 `client.js` 需要**刷新页面**。

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
