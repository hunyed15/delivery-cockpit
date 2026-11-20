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
 */

import { pendingDecision } from './receipts.js'

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
  const items = asArray(acceptance.items)
  if (items.length === 0) return false
  return items.every((item) => isObject(item) && item.result === 'pass' && hasEvidence(item.evidence))
}

/** 已发布 = 当前迭代存在一条 release 且 completed 的回执；bootstrap 的回执不参与迭代环。 */
function released(evidence) {
  const current = isObject(evidence.iteration) ? asText(evidence.iteration.current) : ''
  if (current === '') return false
  return asArray(isObject(evidence.receipts) ? evidence.receipts.receipts : []).some(
    (receipt) =>
      isObject(receipt) &&
      receipt.iteration_id === current &&
      receipt.stage === 'release' &&
      receipt.status === 'completed',
  )
}

/** 验效果阶段的理由：按"最卡人的那个事实"说一句人话，绝不把 0 当全绿（坏 JSON 已由降级兜住）。 */
function verificationReason(acceptance) {
  const failed = toCount(acceptance.failed)
  const blocked = toCount(acceptance.blocked)
  const passWithoutEvidence = toCount(acceptance.passWithoutEvidence)
  const total = toCount(acceptance.total)
  const withResult = toCount(acceptance.withResult)

  if (failed !== null && failed > 0) return `有 ${failed} 条验收没通过，先修好再验一遍`
  if (blocked !== null && blocked > 0) return `有 ${blocked} 条验收被卡住，先解决阻塞`
  if (passWithoutEvidence !== null && passWithoutEvidence > 0) {
    return `有 ${passWithoutEvidence} 条标了通过但没证据，去补证据`
  }
  if (acceptance.appliesToCurrent === false) return '验收表属于别的迭代，先按这一轮重做'
  if (total !== null && withResult !== null && withResult < total) return `还有 ${total - withResult} 条验收没填结果`
  return '验收还没全部通过，继续验剩下的'
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
    return makeDecision(2, 'decide', asText(pending.stage) !== '' ? pending.stage : null, title, '有件事需要你拍板才能继续', {
      notes,
    })
  }

  // 3) 未初始化（只差一半也按未初始化处理，但把"只差一半"的事实说出来）。
  const trellis = isObject(root.trellis) ? root.trellis : {}
  if (trellis.initialized !== true) {
    if (trellis.partial === true) notes.push('工作区骨架不完整：.trellis 或 RULES.md 只存在其中一个')
    return makeDecision(3, 'init', 'init', '初始化项目', '还缺工作区骨架和项目规则，先初始化', { notes })
  }

  // 4) 无 prd：先想清楚这一轮做什么。
  const prd = isObject(root.prd) ? root.prd : {}
  if (prd.found !== true) {
    return makeDecision(4, 'brainstorm', 'brainstorm', '先想清楚', '还没有 prd.md，先想清楚这一轮要做什么', { notes })
  }

  // 5) 当前迭代没有原型批准：停在看原型，不进写代码（design §5.3 铁门）。
  const approval = isObject(root.approval) ? root.approval : {}
  if (approval.approved !== true) {
    return makeDecision(5, 'prototype', 'prototype', '看原型', '这一轮还没通过原型，先确认界面长什么样', { notes })
  }

  // 6/7) 任务：有未完成就继续写；任务服务可用但一条任务都没有 ⇒ 先拆任务。
  const tasks = isObject(root.tasks) ? root.tasks : {}
  if (tasks.available !== true) {
    notes.push('任务服务不可用，跳过任务判定')
  } else {
    const open = toCount(tasks.open)
    if (open !== null && open > 0) {
      return makeDecision(6, 'coding', 'coding', '写代码', `还有 ${open} 个任务没做完，继续写代码`, { notes })
    }
    if (toCount(tasks.total) === 0) {
      return makeDecision(7, 'coding', 'coding', '先拆任务', '任务列表还是空的，先把这一轮拆成小任务', { notes })
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
      return makeDecision(8, 'fix-blocking', 'code_review', '先修审核问题', `审核还有 ${blocking} 个阻塞问题，先修掉`, { notes })
    }
    if (fixed !== null && fixed > 0) {
      return makeDecision(9, 'recheck', 'code_review', '复核已修的', `有 ${fixed} 个问题已经改过，去复核一下`, { notes })
    }
    if (rounds === 0) {
      return makeDecision(10, 'first-review', 'code_review', '先做一次审核', '还没有做过审核，先完整查一遍', { notes })
    }
  }

  // 11/12) 验收表：空表不算通过；有表但没全绿就去真实环境验。
  const acceptance = isObject(root.acceptance) ? root.acceptance : {}
  if (acceptance.empty === true) {
    return makeDecision(11, 'acceptance-draft', 'verification', '生成验收清单', '验收表还是空的，先按需求起草几条', { notes })
  }
  if (!acceptanceAllPass(root)) {
    return makeDecision(12, 'verification', 'verification', '验效果', verificationReason(acceptance), { notes })
  }

  // 13/14) 验收全绿后：没发布就发出去，发布过就开下一轮。
  if (!released(root)) {
    return makeDecision(13, 'release', 'release', '发出去', '验收全绿了，打构建并记下版本号', { notes })
  }
  return makeDecision(14, 'next-iteration', 'release', '开启下一轮', '这一轮已经发布完，可以开下一轮迭代', { notes })
}
