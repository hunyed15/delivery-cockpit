/**
 * 状态机：把一份只读证据压成"此刻唯一该做的下一步"。
 *
 * 为什么必须是纯函数：同一份证据在一个面板里会被多处消费（总览行、详情、测试），
 * 只要有一处自己 if/else 判优先级，两处结论迟早会分叉。这里成为唯一裁决点。
 *
 * 口径（IMPLEMENTATION §3.7 / design §7）：
 * - 优先级 1-14 从上往下，第一条命中即返回，保证任何时候只有一个动作；
 * - 待人工决策与 status 无关（design §5.2 第 3 条），永远压过流程推进；
 * - 降级（degraded）压过一切：数据不可信就不给可执行指令；
 * - 状态机不猜能力：disabled 只在这里由"先确认数据"给出，能力缺失由 model 层补；
 * - 人话硬约束：标题 ≤ 20 字、理由 ≤ 40 字、不含代码，界面上不出现技术符号。
 *
 * 9 阶段迁移：kind / priority / 文案保持不变，只把 stageId 换成 canonical id。
 * 技术门插入点使用 4.5（架构契约）/ 6.5（测试验证）/ 12.5（发布清单），
 * 保持既有 1-14 的序号不动；证据里没有 gates 字段（旧数据/手工构造）时跳过门禁判定。
 *
 * P1 决策门（人工签核）插入点：4.2 范围 / 4.6 架构 / 12.2 验收 / 12.8 发布，
 * 同样保持既有 1-14 序号不动。只有证据的 `approval.decisions` **存在**时才启用，
 * 旧证据/手写夹具没有该字段 ⇒ 跳过，向后兼容。
 */

import { normalizeStage, pendingDecision } from './receipts.js'

/** 界面上的一行字能放下的长度（按字符数，不按字节）。 */
const TITLE_LIMIT = 20
const REASON_LIMIT = 40

/** review 缺失不是故障，但必须让人知道"这一条判定被跳过了"，不能假装审核是干净的。 */
const REVIEW_SKIP_NOTE = '未接审核账本，跳过挑毛病判定'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const asArray = (value) => (Array.isArray(value) ? value : [])
const asText = (value) => (typeof value === 'string' ? value.trim() : '')
const toCount = (value) => (Number.isInteger(value) ? value : null)

/**
 * 人话清洗：去掉代码记号（反引号）与多余空白，并把过长文案截断。
 * Agent 上报的 needs_human_decision.title 是不可控输入，直接上屏会撑破一行；
 * 这里只做展示层收敛，不改变含义，也不编造内容。
 */
function humanText(value, limit) {
  const text = asText(value).replace(/`/g, '').replace(/\s+/g, ' ')
  const chars = [...text]
  if (chars.length <= limit) return text
  return `${chars.slice(0, limit - 1).join('')}…`
}

function makeDecision(priority, kind, stageId, title, reason, extra = {}) {
  return {
    priority,
    kind,
    stageId,
    title: humanText(title, TITLE_LIMIT),
    reason: humanText(reason, REASON_LIMIT),
    disabled: extra.disabled === true,
    disabledReason: typeof extra.disabledReason === 'string' ? extra.disabledReason : null,
    notes: asArray(extra.notes).filter((note) => typeof note === 'string' && note !== ''),
  }
}

/** 验收条目有没有证据：数组非空或非空字符串才算；与 evidence 层口径一致，不在这里另立标准。 */
function hasEvidence(value) {
  if (Array.isArray(value)) return value.length > 0
  return asText(value) !== ''
}

/**
 * 全部通过 = 对当前迭代有效 && 非空 && 每条 pass 且都有证据。
 * 单独守 passWithoutEvidence：pass 但没证据的条目不算通过（§2.5），哪怕每条都写了 pass。
 */
function acceptanceAllPass(evidence) {
  const acceptance = isObject(evidence.acceptance) ? evidence.acceptance : {}
  if (acceptance.appliesToCurrent === false) return false
  const passWithoutEvidence = toCount(acceptance.passWithoutEvidence)
  if (passWithoutEvidence !== null && passWithoutEvidence > 0) return false
  const stale = toCount(acceptance.stale)
  // 有"失效的 pass"（截图变了但没重新确认）时阶段门不放行。
  if (stale !== null && stale > 0) return false
  const items = asArray(acceptance.items)
  if (items.length === 0) return false
  return items.every((item) => isObject(item) && item.result === 'pass' && hasEvidence(item.evidence) && item.stale !== true)
}

/** 已发布 = 当前迭代存在一条 release 且 completed 的回执；bootstrap 的回执不参与迭代环。 */

function released(evidence) {
  const current = isObject(evidence.iteration) ? asText(evidence.iteration.current) : ''
  if (current === '') return false
  return asArray(isObject(evidence.receipts) ? evidence.receipts.receipts : []).some(
    (receipt) =>
      isObject(receipt) &&
      receipt.iteration_id === current &&
      normalizeStage(receipt.stage) === 'release' &&
      receipt.status === 'completed',
  )
}

/** 验收阶段的理由：按"最卡人的那个事实"说一句人话，绝不把 0 当全绿（坏 JSON 已由降级兜住）。 */
function verificationReason(acceptance) {
  const failed = toCount(acceptance.failed)
  const blocked = toCount(acceptance.blocked)
  const passWithoutEvidence = toCount(acceptance.passWithoutEvidence)
  const stale = toCount(acceptance.stale)
  const total = toCount(acceptance.total)
  const withResult = toCount(acceptance.withResult)

  if (failed !== null && failed > 0) return `有 ${failed} 条验收没通过，先修好再验一遍`
  if (blocked !== null && blocked > 0) return `有 ${blocked} 条验收被卡住，先解决阻塞`
  // 截图变了 ⇒ 之前那次"通过"的依据已经不在了，必须重新确认。
  if (stale !== null && stale > 0) return `有 ${stale} 条验收因截图变化失效，重新确认后再放行`
  if (passWithoutEvidence !== null && passWithoutEvidence > 0) {
    return `有 ${passWithoutEvidence} 条标了通过但没证据，去补证据`
  }
  if (acceptance.appliesToCurrent === false) return '验收表属于别的迭代，先按这一轮重做'
  if (total !== null && withResult !== null && withResult < total) return `还有 ${total - withResult} 条验收没填结果`
  return '验收还没全部通过，继续验剩下的'
}

/** gates 缺失（旧数据/手工构造）时整段门禁判定跳过，保持向后兼容。 */
function gatesOf(evidence) {
  return isObject(evidence.gates) ? evidence.gates : null
}

function gateMissingText(gate) {
  const missing = asArray(gate?.missing).filter((item) => typeof item === 'string' && item.trim() !== '')
  return missing.length > 0 ? missing.join('、') : '必需文件'
}

function architectureGateReason(gate) {
  return `还缺架构契约：${gateMissingText(gate)}；先写 architecture.md 与 api.md`
}

function testGateReason(gate) {
  const detail = isObject(gate?.detail) ? gate.detail : {}
  const manual = detail.source === '.dsh/plugin-state/manual-check.json'
  if (gate?.reason === 'bad-json') {
    return manual ? '人工检查单不是合法 JSON，先修 manual-check.json' : '测试报告不是合法 JSON，先修 test-report.json'
  }
  if (gate?.reason === 'wrong-shape') {
    return `${manual ? '人工检查单' : '测试报告'}格式不对：${gateMissingText(gate)}`
  }
  const failed = toCount(detail.failed)
  const blocked = toCount(detail.blocked)
  if (manual && blocked !== null && blocked > 0) return `人工检查还有 ${blocked} 条阻塞，先处理`
  if (manual && failed !== null && failed > 0) return `人工检查还有 ${failed} 条没通过，先处理`
  if (failed !== null && failed > 0) return `测试还有 ${failed} 个失败，先修好再验`
  return `还没有可用的测试证据：${gateMissingText(gate)}；跑测试写 test-report.json，非代码项目写 manual-check.json`
}

function releaseGateReason(gate) {
  if (gate?.reason === 'bad-json') return '发布清单不是合法 JSON，先修 release.json'
  if (gate?.reason === 'wrong-shape') return `发布清单不完整：${gateMissingText(gate)}`
  return `还缺发布清单：${gateMissingText(gate)}；写版本、产物与回滚说明`
}

/**
 * 主裁决：evidence 缺字段时按"没有/不可信"处理，但不抛错（面板不能因为一份残缺证据白屏）。
 * 返回形状固定为 { priority, kind, stageId, title, reason, disabled, disabledReason, notes }。
 */
export function deriveDecision(evidence) {
  const root = isObject(evidence) ? evidence : {}
  const degraded = isObject(root.degraded) ? root.degraded : {}
  const notes = []
  const receipts = asArray(isObject(root.receipts) ? root.receipts.receipts : [])
  const legacy = isObject(root.legacyProject) && root.legacyProject.active === true
  const projectCard = isObject(root.card) && isObject(root.card.card) ? root.card.card : {}
  const lightweight = projectCard.workflow === 'light'
  if (legacy) notes.push('历史项目：本轮跳过新增门禁，下一轮按 9 阶段执行')
  else if (lightweight) notes.push('轻量模式：跳过架构契约与范围/架构签核')

  // 1) 数据不可信：先确认数据，且禁用主按钮（不给注定失败的指令）。
  if (degraded.flag === true) {
    const firstReason = asArray(degraded.reasons).find((item) => isObject(item) && asText(item.message) !== '')
    return makeDecision(1, 'confirm-data', null, '先确认数据', '有数据没能读出来，先确认一下再继续', {
      disabled: true,
      disabledReason: firstReason ? asText(firstReason.message) : '数据读取失败，先确认数据再继续',
    })
  }

  // 2) 待人工决策最高优：与 status 无关，防止有人在别的流程里把它埋掉（design §5.2）。
  const pending = pendingDecision(receipts)
  if (pending) {
    const detail = isObject(pending.needs_human_decision) ? pending.needs_human_decision : {}
    const title = asText(detail.title) !== '' ? detail.title : '有件事要你拍板'
    // 旧账本里的 stage 别名（如 code_review）也投影到 canonical id。
    return makeDecision(2, 'decide', normalizeStage(pending.stage), title, '有件事需要你拍板才能继续', {
      notes,
    })
  }

  // 3) 未初始化（只差一半也按未初始化处理，但把"只差一半"的事实说出来）。
  const trellis = isObject(root.trellis) ? root.trellis : {}
  if (trellis.initialized !== true) {
    if (trellis.partial === true) notes.push('工作区骨架不完整：.trellis 或 RULES.md 只存在其中一个')
    return makeDecision(3, 'init', 'bootstrap', '初始化项目', '还缺工作区骨架和项目规则，先初始化', { notes })
  }

  // 3.5) 当前迭代已经发布：旧项目可能缺签核/发布清单/任务归档，但那都是历史；
  // 唯一正确的下一步是开下一轮，而不是把已发布迭代重新拉回补材料。
  if (released(root)) {
    return makeDecision(14, 'next-iteration', 'release', '开启下一轮', '当前迭代已发布，可以开下一轮迭代', { notes })
  }

  // 4) 无 prd：先想清楚这一轮做什么。
  const prd = isObject(root.prd) ? root.prd : {}
  if (prd.found !== true) {
    return makeDecision(4, 'brainstorm', 'requirements', '先想清楚', '还没有 prd.md，先想清楚这一轮要做什么', { notes })
  }

  // 4.2) 范围签核（决策门）：PRD 写出来不等于甲方确认了范围，必须先签核才继续。
  // 只有证据带 decisions 时才启用（旧证据/手写夹具没有 ⇒ 跳过，保持向后兼容）。
  const approval = isObject(root.approval) ? root.approval : {}
  const decisions = isObject(approval.decisions) ? approval.decisions : null
  if (decisions !== null && !legacy && !lightweight) {
    const scopeDecision = isObject(decisions.scope) ? decisions.scope : {}
    if (scopeDecision.approved !== true) {
      return makeDecision(4.2, 'scope-approval', 'requirements', '确认这一轮范围', '范围还没签核：先确认 PRD 的功能与优先级', { notes })
    }
  }

  // 4.5) 架构契约技术门：写代码/做原型前必须冻结组件、数据模型与接口（docs 没有 gates 时跳过）。
  const gates = legacy ? null : gatesOf(root)
  const requireArchitectureGate = !isObject(root.workflow) || root.workflow.requireArchitectureGate !== false
  if (gates !== null && !lightweight && requireArchitectureGate) {
    const architecture = isObject(gates.architecture) ? gates.architecture : {}
    if (architecture.ok !== true) {
      return makeDecision(4.5, 'architecture', 'architecture', '先定架构与契约', architectureGateReason(architecture), { notes })
    }
  }

  // 4.6) 架构签核（决策门）：契约文件齐了不等于甲方认可技术选型，签核后才进原型。
  if (decisions !== null && !legacy && !lightweight) {
    const architectureDecision = isObject(decisions.architecture) ? decisions.architecture : {}
    if (architectureDecision.approved !== true) {
      return makeDecision(4.6, 'architecture-approval', 'architecture', '架构签核', '契约与接口还没签核', { notes })
    }
  }

  // 5) 当前迭代没有原型批准：停在看原型，不进代码开发（design §5.3 铁门）。
  if (!legacy && approval.approved !== true) {
    return makeDecision(5, 'prototype', 'prototype', '看原型', '这一轮还没通过原型，先确认界面长什么样', { notes })
  }

  // 6/7) 任务：有未完成就继续写；任务服务可用但一条任务都没有 ⇒ 先拆任务。
  const tasks = isObject(root.tasks) ? root.tasks : {}
  let tasksConfirmedDone = false
  if (tasks.available !== true) {
    notes.push('任务服务不可用，跳过任务判定')
  } else {
    const open = toCount(tasks.open)
    if (open !== null && open > 0) {
      return makeDecision(6, 'coding', 'implementation', '写代码', `还有 ${open} 个任务没做完，继续写代码`, { notes })
    }
    if (toCount(tasks.total) === 0 && !legacy) {
      return makeDecision(7, 'coding', 'implementation', '先拆任务', '任务列表还是空的，先把这一轮拆成小任务', { notes })
    }
    tasksConfirmedDone = true
  }

  // 6.5) 测试验证技术门：只在"任务已确认做完"时挡路；任务服务不可用时无法判断实现是否完成，跳过。
  if (gates !== null && tasksConfirmedDone) {
    const tests = isObject(gates.tests) ? gates.tests : {}
    if (tests.ok !== true) {
      return makeDecision(6.5, 'testing', 'testing', '补测试证据', testGateReason(tests), { notes })
    }
  }

  // 8/9/10) 审核账本：缺失就跳过这三条，并留下"跳过"的痕迹（不许假装审核干净）。
  const review = isObject(root.review) ? root.review : {}
  if (review.available !== true) {
    notes.push(REVIEW_SKIP_NOTE)
  } else {
    const blocking = toCount(review.blocking)
    const fixed = toCount(review.fixed)
    const rounds = toCount(review.rounds)
    if (blocking !== null && blocking > 0) {
      return makeDecision(8, 'fix-blocking', 'code-review', '先修审核问题', `审核还有 ${blocking} 个阻塞问题，先修掉`, { notes })
    }
    if (fixed !== null && fixed > 0) {
      return makeDecision(9, 'recheck', 'code-review', '复核已修的', `有 ${fixed} 个问题已经改过，去复核一下`, { notes })
    }
    if (rounds === 0) {
      return makeDecision(10, 'first-review', 'code-review', '先做一次审核', '还没有做过审核，先完整查一遍', { notes })
    }
  }

  // 11/12) 验收表：空表不算通过；有表但没全绿就去真实环境验。
  const acceptance = isObject(root.acceptance) ? root.acceptance : {}
  if (acceptance.empty === true) {
    return makeDecision(11, 'acceptance-draft', 'acceptance', '生成验收清单', '验收表还是空的，先按需求起草几条', { notes })
  }
  if (!acceptanceAllPass(root)) {
    return makeDecision(12, 'verification', 'acceptance', '验效果', verificationReason(acceptance), { notes })
  }

  // 12.2) 验收签核（决策门）：全绿是机器判定，签核是人对"这一轮算不算验过"的确认。
  if (decisions !== null && !legacy) {
    const acceptanceDecision = isObject(decisions.acceptance) ? decisions.acceptance : {}
    if (acceptanceDecision.approved !== true) {
      return makeDecision(12.2, 'acceptance-approval', 'acceptance', '验收签核', '验收结果还没签核', { notes })
    }
  }

  // 12.5) 发布技术门：验收全绿不等于发布清单完整，先补 release.json。
  if (gates !== null) {
    const release = isObject(gates.release) ? gates.release : {}
    if (release.ok !== true) {
      return makeDecision(12.5, 'release', 'release', '准备发布清单', releaseGateReason(release), { notes })
    }
  }

  // 12.8) 发布批准（决策门）：清单齐了也不自动上线，等人点批准。
  if (decisions !== null && !legacy) {
    const releaseDecision = isObject(decisions.release) ? decisions.release : {}
    if (releaseDecision.approved !== true) {
      return makeDecision(12.8, 'release-approval', 'release', '发布批准', '发布清单已齐，等你批准上线', { notes })
    }
  }

  // 13/14) 验收全绿后：没发布就发出去，发布过就开下一轮。
  if (!released(root)) {
    return makeDecision(13, 'release', 'release', '发出去', '验收全绿了，打构建并记下版本号', { notes })
  }
  return makeDecision(14, 'next-iteration', 'release', '开启下一轮', '这一轮已经发布完，可以开下一轮迭代', { notes })
}
