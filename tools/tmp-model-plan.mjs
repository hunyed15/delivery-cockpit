import fs from 'node:fs'

const f = 'lib/model.js'
let t = fs.readFileSync(f, 'utf8')

if (!t.includes('resolveStagePlan')) {
  t = t.replace(
    "import { entryForStage, missingCapabilities, renderPrompt, stageName, STAGE_DEFS } from './playbook.js'",
    "import { entryForStage, missingCapabilities, renderPrompt, stageName, STAGE_DEFS } from './playbook.js'\nimport { resolveStagePlan } from './roles.js'",
  )

  t = t.replace(
    '    const sequence = asArray(entry?.sequence).filter((item) => typeof item === \'string\' && item.trim() !== \'\')',
    `    const sequence = asArray(entry?.sequence).filter((item) => typeof item === 'string' && item.trim() !== '')
    // 角色化路由：把 roles + sequence 解析成"这一步实际调什么"（首选/替代/回退）
    const plan = resolveStagePlan(entry, capabilities)`,
  )

  t = t.replace('      sequence,', '      sequence,\n      plan: plan.items,\n      needsHuman: plan.needsHuman,')
  fs.writeFileSync(f, t)
  console.log('model: stage plan')
} else {
  console.log('model already has plan')
}
