import fs from 'node:fs'

// ---------- 1) presenceOf：插件自带工作流技能恒可用 ----------
const pf = 'lib/playbook.js'
let p = fs.readFileSync(pf, 'utf8')
if (!p.includes("startsWith('cockpit-')")) {
  const anchor = `function presenceOf(kind, name, services) {
  if (kind === 'inline') return 'yes'`
  if (!p.includes(anchor)) throw new Error('presenceOf anchor not found')
  p = p.replace(
    anchor,
    `function presenceOf(kind, name, services) {
  if (kind === 'inline') return 'yes'
  // 插件自带的阶段工作流技能（cockpit-*）随包发布、由 init 释放：不要因为
  // 会话技能目录里暂时没看到就判它缺失，否则整条流程会被误禁。
  if (kind === 'skill' && typeof name === 'string' && name.startsWith('cockpit-')) return 'yes'`,
  )
  fs.writeFileSync(pf, p)
  console.log('playbook: cockpit-* presence always yes')
}

// ---------- 2) playbook.json：method 换成插件自带工作流 ----------
const jf = 'templates/playbook.json'
const raw = fs.readFileSync(jf, 'utf8')
const pb = JSON.parse(raw)
const stageToId = {
  项目立项: 'bootstrap',
  需求定义: 'requirements',
  架构契约: 'architecture',
  原型设计: 'prototype',
  代码开发: 'implementation',
  测试验证: 'testing',
  代码复核: 'code-review',
  验收确认: 'acceptance',
  部署发布: 'release',
}
let changed = 0
for (const [stageName, stageId] of Object.entries(stageToId)) {
  const entry = pb.stages[stageName]
  if (!entry) throw new Error(`stage missing: ${stageName}`)
  const previous = typeof entry.method === 'string' ? entry.method.trim() : ''
  entry.method = `cockpit-${stageId}`
  entry.kit = `cockpit-${stageId}`
  // 原来的第三方 method 降级为「可选工具」：有就用，没有不影响流程。
  if (previous !== '' && previous !== entry.method) {
    const caps = Array.isArray(entry.capabilities) ? entry.capabilities : []
    const exists = caps.some((cap) => cap && cap.name === previous)
    if (!exists) {
      caps.unshift({
        kind: previous === 'claude_review' ? 'tool' : 'skill',
        name: previous,
        mode: 'full',
        optional: true,
        note: `可选：${previous}（原来被当成阶段方法；现在流程由 ${entry.method} 负责，它只是工具）`,
      })
    }
    entry.capabilities = caps
  }
  changed += 1
}
fs.writeFileSync(jf, `${JSON.stringify(pb, null, 2)}\n`, 'utf8')
console.log(`playbook: ${changed} stages now use cockpit-* workflow`)
