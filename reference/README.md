# 参考实现（非运行代码）

这些文件是设计阶段写好的草稿实现，供新工作区起步时参考/搬运，**不被任何东西加载**。

- `receipts.js` —— 账本模块（校验 / 追加写 / 容错读 / 迭代与待决策推导）
- `cockpit-receipts.test.js` —— 配套 11 条断言（已跑通：11 pass / 0 fail）

对应的接口契约见 [../docs/archive/design-8stage-v0.md](../docs/archive/design-8stage-v0.md) §5（`cockpit_report`）与 §12.1。
