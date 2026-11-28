/**
 * 「下一步」契约：把面板模型里的结论编译成 agent 能直接执行的形状（prd.md FR-3）。
 *
 * 为什么要单独一层：
 * - `cockpit_next` 与 `cockpit_report` 的返回值必须**同形**，否则 agent 要写两套判断；
 * - 下一步不只是"标题"，还要带：编排技能、能力调用计划（角色→能力）、需要人点的节点、
 *   阻塞原因与门禁状态。这些都在 detail 里算好了，这里只做投影，不重算。
 */

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const asArray = (value) => (Array.isArray(value) ? value : [])
const text = (value) => (typeof value === 'string' ? value.trim() : '')

export function nextContract(detail) {
  const safe = isObject(detail) ? detail : {}
  const action = isObject(safe.nextAction) ? safe.nextAction : {}
  const stageId = text(action.stageId)
  const stage = asArray(safe.stages).find((item) => isObject(item) && item.id === stageId) ?? null

  const blockedBy = []
  if (action.disabled === true) blockedBy.push(text(action.disabledReason) || '被阻塞')
  for (const item of asArray(stage?.plan)) {
    if (item?.kind !== 'fallback') continue
    blockedBy.push(`${item.label}：缺少首选能力，按回退做法（${item.fallback}）`)
  }

  return {
    stageId: stageId || null,
    stageName: text(action.stageName) || (stage ? stage.name : null),
    kind: text(action.kind) || null,
    title: text(action.title) || null,
    reason: text(action.reason) || null,
    // 编排技能固定是 cockpit-flow；具体做什么由 plan 决定
    skill: text(action.method) || 'cockpit-flow',
    instruction: text(action.instruction) || null,
    plan: asArray(stage?.plan),
    needsHuman: asArray(stage?.needsHuman),
    blockedBy,
    // 门禁只读投影：缺什么一眼能看到，不用再开面板
    gates: isObject(safe.gates) ? safe.gates : null,
  }
}
