# 本地预览与截图工具

DSH 的 Web GUI 需要鉴权 token，agent 打不开，因此**看不到自己写的界面**——只靠读 CSS 猜效果，
会漏掉溢出、对比度、换行、层级这类只有渲染才暴露的问题。

这组脚本绕开鉴权：用真实 React + 真实 CSS 在 localhost 渲染本包的 `client.js`，
数据由 `mock-data.mjs` 按 `docs/IMPLEMENTATION.md` §3.8 的契约形状注入（不依赖并行开发的 `lib/`），
再用 CDP 在**精确 CSS 像素宽度**下截图。

> 仅用于本机验证，不进入插件运行时：`package.json` 主包不依赖这里的任何东西。

## 用法

```powershell
# 第一次：装预览用的 React（不会进插件包依赖）。本机若已有 React 18 UMD 也可直接复制：
#   tools/preview/node_modules/react/umd/react.production.min.js
#   tools/preview/node_modules/react-dom/umd/react-dom.production.min.js
npm --prefix tools/preview install

# 起预览服务（默认 4711）
node tools/preview/server.mjs
```

浏览器打开 `http://127.0.0.1:4711/`，或直接截图（Chrome/Edge 自动探测，找不到会报错，不会偷偷装依赖）：

```powershell
# 宽屏全页（full 会把视口拉到内容真实高度，一张图看见全部四区）
node tools/preview/shot.mjs "http://127.0.0.1:4711/?scenario=normal" 1200 900 tools/preview/shots/normal.png full

# 窄屏（真实 CSS 像素）——同时验证无横向溢出
node tools/preview/shot.mjs "http://127.0.0.1:4711/?scenario=normal" 360 1600 tools/preview/shots/normal-360.png full

# 只量溢出，不截图（有横向溢出时退出码非 0，并列出越界元素）
node tools/preview/shot.mjs "http://127.0.0.1:4711/?scenario=normal" 360 --measure
```

浏览器可用 `CHROME_PATH` 指定；截图输出目录 `shots/` 已被 `tools/preview/.gitignore` 忽略。

## 场景

`?scenario=` 同时决定 mock 数据与初始导航（预置 `delivery-cockpit:last-project` 走详情，否则停在总览）：

| 值 | 用途 |
|---|---|
| `normal` | 详情正常态：看原型阶段、可复制指令、可点「通过原型」 |
| `features` | 功能账主视图（5 个功能覆盖 done/blocked/in-progress/not-started/pending-acceptance + 1 条未归属 bug） |
| `features-expanded` | 自动展开第一行，验证 bug 明细（severity/标题/file:line）与关联路径 |
| `features-prd-missing` | 没有 prd.md 的空态（引导去 prd.md） |
| `features-no-fr` | PRD 有内容但认不出 `### FR-N` 结构：显示 formatHint 等宽代码块 |
| `acceptance` | 验收清单主视图（6 条：通过带证据 / 失败 / 阻塞 / 未验，含 URL 证据） |
| `acceptance-edit` | 自动展开 A4 的证据输入框（验证行内 input） |
| `acceptance-save` | 自动点 A1「撤销」：验证 POST `/acceptance-result` 成功后刷新面板（A1 变未验、计数同步） |
| `acceptance-error` | A4 填不存在的证据路径 → Host 409 → 行内「证据文件不存在」 |
| `acceptance-empty` | 没有验收条目：空态 + `acceptance-draft` 指引 |
| `acceptance-truncated` | items 被截断（2 条可见）但 `acceptance.passed` 是全局真值：摘要应显示 Host 计数 + 截断提示 |
| `approved` | 原型已批准：按钮变只读「已于 X 通过原型」 |
| `pending` | 待人工决策：决策置顶 + 待决策 chip |
| `degraded` | 读取降级：顶部横幅列原因、主按钮禁用、坏行提示 |
| `badlines` | 只有账本坏行（不算降级）：顶部「账本存在损坏行」提示 |
| `missing` | 能力缺失：显示缺失文案而不是指令 |
| `init` | 未初始化：自动点「初始化此项目」，展示 init-plan 预览 |
| `initdone` | 在 `init` 基础上自动确认，展示 POST /init 成功横幅 |
| `approve-action` | 自动点「通过原型」，验证 POST → 刷新成只读的完整链路 |
| `nav` | 从总览点卡片进详情，验证两级导航 |
| `overview` | 总览：三个工作区卡片 |
| `empty` | 没有工作区（空态，不是故障） |
| `error` | `/panel` 返回 500：错误态 + 重试 |

## 两个坑（都踩过）

1. **不要用 `chrome --screenshot`**：在 125% DPI 的机器上它会缩放页面，布局正确看起来也被裁掉，
   真正的溢出反而看着正常。必须用 CDP 的 `Emulation.setDeviceMetricsOverride` 把 `deviceScaleFactor` 钉成 1。
2. **预览服务必须发 `cache-control: no-store`**：否则同一 user-data-dir 会复用缓存的旧 `client.js`，
   改了代码截图却还是旧样子。`shot.mjs` 也会先等 harness 把 `document.title` 置成 `ready:*` 再截。

## 限制（必须说清）

- `tokens.css` 里的 `--dsw-alias-*` 是**近似值**。排版、换行、溢出可信；**颜色对比度不可信**，
  必须在真机用真实 token 复核。
- 这里渲染的是组件本身，不含 DSH 外壳（侧栏、主面板容器、真实滚动容器），
  所以「sticky 头是否生效」「宿主给的宽度」这类问题仍要真机确认。
- 只覆盖静态渲染与预设点击链路（init / approve），不覆盖键盘与拖拽交互。
