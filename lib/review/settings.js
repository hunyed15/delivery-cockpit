/**
 * 评审能力的配置规范化（从 @hunyed15/project-cockpit v3.0.0 的 cordis.patch.yml 迁入）。
 *
 * 键名沿用旧插件：enginePath / timeoutSec / transport / allowBundledFallback；
 * 账本模式用本插件既有的 `reviewStorage`（auto|trellis|local）——驾驶舱读账本与
 * 引擎写账本必须用同一个值，否则面板显示的轮次和实际写入位置会悄悄错位。
 */
import { REVIEW_TIMEOUT_MS } from './engine.js'

export const REVIEW_DEFAULT_CONFIG = {
  // 留空 = 自动探测：目标仓库 tools/claude-review → 目标仓库 .dsh/claude-review → 插件自带。
  enginePath: '',
  // 单次审核超时（秒）：传给引擎 -TimeoutSec，并据此算工具级超时（引擎超时 + 120s 余量）。
  timeoutSec: 1500,
  // 传输：auto = 优先内置 ACP（依赖随插件安装），不可用回退 CLI；也可强制 acp/cli。
  transport: 'auto',
  // 目标仓库里的引擎接口过旧时，是否允许回退到插件自带的引擎副本。
  allowBundledFallback: true,
}

export const REVIEW_STORAGE_MODES = new Set(['auto', 'trellis', 'local'])

/** 账本模式：只认三个值，其余（含缺省）按 auto——与旧插件 storageMode() 同语义。 */
export function normalizeStorage(value) {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return REVIEW_STORAGE_MODES.has(mode) ? mode : 'auto'
}

/** 把插件配置（已合并默认值）投影成评审工具真正会用到的那几个值。 */
export function normalizeReviewSettings(config = {}) {
  const rawTimeout = Number.isFinite(config.timeoutSec) && config.timeoutSec > 0 ? Math.trunc(config.timeoutSec) : REVIEW_DEFAULT_CONFIG.timeoutSec
  return {
    enginePath: typeof config.enginePath === 'string' ? config.enginePath.trim() : '',
    timeoutSec: rawTimeout,
    // 工具级超时要盖住引擎超时并留出进程启动余量，否则插件先把进程掐掉、引擎的 -TimeoutSec 形同虚设。
    toolTimeoutMs: Math.min(Math.max(rawTimeout * 1000 + 120_000, REVIEW_TIMEOUT_MS), 60 * 60 * 1000),
    transport: ['auto', 'acp', 'cli'].includes(config.transport) ? config.transport : REVIEW_DEFAULT_CONFIG.transport,
    allowBundledFallback: config.allowBundledFallback !== false,
    storage: normalizeStorage(config.reviewStorage),
  }
}
