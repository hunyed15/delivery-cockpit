/**
 * 视觉回归：把本次截图和该验收项上一版截图做像素对比。
 *
 * 口径：
 * - 逐像素、逐通道比较，单通道差异 ≤ tolerance 视为"同一像素"（抗锯齿/字体栅格的微小噪声）；
 * - 变化像素占比 ≤ maxRatio 视为"一致"（默认 0.1%），否则"有变化"；
 * - 尺寸不同直接判 different-size（不能把"页面变高了"当成 0 差异）；
 * - 解析不了（非 8-bit/非 RGB/RGBA）就 `uncomparable`，绝不假装比过了。
 */
import { decodePng, encodePng, toRgb } from './png.js'

export const VISUAL_DEFAULTS = {
  tolerance: 8,
  maxRatio: 0.001,
  // 占比阈值会漏掉小面积的真实改动（1280×900 下 0.1% ≈ 1152 像素）：
  // 所以再加一条"最少变化像素数"下限——只要变化 ≥ 24 像素就判有变化，不看占比。
  minChangedPixels: 24,
}

function normalizeOptions(options) {
  const tolerance = Number.isInteger(options?.tolerance) && options.tolerance >= 0 ? options.tolerance : VISUAL_DEFAULTS.tolerance
  const maxRatio = Number.isFinite(options?.maxRatio) && options.maxRatio >= 0 ? options.maxRatio : VISUAL_DEFAULTS.maxRatio
  const minChangedPixels =
    Number.isInteger(options?.minChangedPixels) && options.minChangedPixels >= 0
      ? options.minChangedPixels
      : VISUAL_DEFAULTS.minChangedPixels
  return { tolerance, maxRatio, minChangedPixels }
}

/** 从证据列表里挑"上一版截图"：最后一张能当基线的图（跳过普通文本证据）。 */
export function pickBaselineEvidence(evidence) {
  const list = Array.isArray(evidence) ? evidence.filter((entry) => typeof entry === 'string' && entry.trim() !== '') : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const entry = list[index].trim()
    // URL 先判：带查询串的 .png URL（?v=2）或路径里没 .png 的 URL 都要归到 url。
    if (/^https?:\/\//i.test(entry)) return { kind: 'url', entry }
    if (/\.png(\?|#|$)/i.test(entry)) return { kind: 'png', entry }
    if (/\.(jpe?g|webp|gif)(\?|#|$)/i.test(entry)) return { kind: 'non-png', entry }
  }
  return { kind: 'new', entry: null }
}

/**
 * 比较两张截图。
 * @returns {{ok:boolean, verdict:'same'|'changed'|'different-size'|'uncomparable', ratio?:number|null,
 *   changedPixels?:number|null, totalPixels?:number|null, bbox?:object|null, width?:number, height?:number,
 *   tolerance?:number, maxRatio?:number, minChangedPixels?:number, reason?:string, mask?:Buffer}}
 */
export function compareScreenshots(beforeBuffer, afterBuffer, options = {}) {
  const { tolerance, maxRatio, minChangedPixels } = normalizeOptions(options)
  const before = decodePng(beforeBuffer)
  if (!before.ok) return { ok: false, verdict: 'uncomparable', reason: `baseline:${before.error}` }
  const after = decodePng(afterBuffer)
  if (!after.ok) return { ok: false, verdict: 'uncomparable', reason: `current:${after.error}` }

  if (before.width !== after.width || before.height !== after.height) {
    return {
      ok: true,
      verdict: 'different-size',
      // 尺寸不同时"变化比例/像素数"没有意义：给 null，由存储层/界面只展示宽高差异。
      ratio: null,
      changedPixels: null,
      totalPixels: null,
      bbox: null,
      width: after.width,
      height: after.height,
      beforeWidth: before.width,
      beforeHeight: before.height,
      tolerance,
      maxRatio,
      minChangedPixels,
    }
  }

  const beforeRgb = toRgb(before)
  const afterRgb = toRgb(after)
  const totalPixels = before.width * before.height
  const mask = Buffer.alloc(totalPixels)
  let changedPixels = 0
  let minX = after.width
  let minY = after.height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < after.height; y += 1) {
    for (let x = 0; x < after.width; x += 1) {
      const pixel = y * after.width + x
      const offset = pixel * 3
      const dr = Math.abs(beforeRgb[offset] - afterRgb[offset])
      const dg = Math.abs(beforeRgb[offset + 1] - afterRgb[offset + 1])
      const db = Math.abs(beforeRgb[offset + 2] - afterRgb[offset + 2])
      if (Math.max(dr, dg, db) <= tolerance) continue
      mask[pixel] = 1
      changedPixels += 1
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }

  const ratio = totalPixels === 0 ? 0 : changedPixels / totalPixels
  // 两条判据取"更敏感"的那条：占比超过阈值，或变化像素数达到下限（小图标/小文案改动）。
  const same = changedPixels < minChangedPixels && ratio <= maxRatio
  const verdict = same ? 'same' : 'changed'
  return {
    ok: true,
    verdict,
    ratio,
    changedPixels,
    totalPixels,
    bbox: changedPixels > 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
    width: after.width,
    height: after.height,
    tolerance,
    maxRatio,
    minChangedPixels,
    mask,
  }
}

/**
 * 生成 diff 图：变化像素标红，其余压成灰，便于一眼看出改哪了。
 * 入参用 compareScreenshots 的 mask；没有 mask 时返回错误而不是给一张假 diff。
 */
export function renderDiffPng(afterBuffer, mask) {
  const after = decodePng(afterBuffer)
  if (!after.ok) return { ok: false, error: after.error }
  if (!Buffer.isBuffer(mask) || mask.length !== after.width * after.height) {
    return { ok: false, error: 'bad-mask' }
  }
  const rgb = toRgb(after)
  const out = Buffer.alloc(after.width * after.height * 3)
  for (let pixel = 0; pixel < after.width * after.height; pixel += 1) {
    const offset = pixel * 3
    if (mask[pixel] === 1) {
      out[offset] = 255
      out[offset + 1] = 0
      out[offset + 2] = 72
      continue
    }
    const gray = Math.round(((rgb[offset] + rgb[offset + 1] + rgb[offset + 2]) / 3) * 0.55)
    out[offset] = gray
    out[offset + 1] = gray
    out[offset + 2] = gray
  }
  return { ok: true, png: encodePng({ width: after.width, height: after.height, channels: 3, data: out }) }
}
