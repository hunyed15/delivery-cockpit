---
name: cockpit-release
description: "驾驶舱部署发布阶段的工作流：先按驾驶舱判定的项目形态（新/存量）选做法，再产出该阶段产物并写回执。"
---
# cockpit-release · 部署发布

**阶段**：`release`。何时用：面板要求准备发布清单或请人批准发布时。

## 先读
- `acceptance.json` 是否全绿并已签核
- 构建产物的实际路径

## 按项目形态分两种做法
- 新项目：写版本、产物与回滚说明。
- 存量项目：沿用现有发版方式（安装包 / 便携包），把真实产物路径与哈希写进清单。

> 形态由驾驶舱判定（面板 `project.shape` / 指令里的说法），**不要自己扫一遍项目再猜**；判不出来就直接问用户一句。

## 步骤
1. 构建产物，计算真实 sha256。
2. 写 `.dsh/plugin-state/release.json`：`{version, artifacts:[{path,sha256}], rollback, at}`。
3. 请人点「发布批准」；批准后才算发布完成。
4. 写 `cockpit_report`：stage=release，带产物路径。

## 产物
- .dsh/plugin-state/release.json

## 硬约束
- 产物必须存在且哈希匹配
- 回滚说明要能照着做
- 不自动发布
- 不改阶段：走哪一步由驾驶舱「下一步」决定，本 skill 只负责把这一步做对。
