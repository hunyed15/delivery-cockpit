/**
 * 视觉回归对比：一致 / 有变化 / 尺寸不同 / 无法对比。
 * 关键约束：不许把"解析不了"包装成"没变化"，也不许把"页面长高了"算成 0 差异。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { decodePng, encodePng } from '../lib/png.js'
import { compareScreenshots, pickBaselineEvidence, renderDiffPng } from '../lib/visual-diff.js'

function image(width, height, rgb) {
  const data = Buffer.alloc(width * height * 3)
  data.fill(0)
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    data[pixel * 3] = rgb[0]
    data[pixel * 3 + 1] = rgb[1]
    data[pixel * 3 + 2] = rgb[2]
  }
  return encodePng({ width, height, channels: 3, data })
}

function paint(pngBuffer, width, x, y, rgb) {
  const decoded = decodePng(pngBuffer)
  const offset = (y * width + x) * 3
  decoded.data[offset] = rgb[0]
  decoded.data[offset + 1] = rgb[1]
  decoded.data[offset + 2] = rgb[2]
  return encodePng({ width: decoded.width, height: decoded.height, channels: 3, data: decoded.data })
}

test('两张完全一样的图 ⇒ same，mask 全 0', () => {
  const a = image(20, 10, [30, 60, 90])
  const result = compareScreenshots(a, a)
  assert.equal(result.ok, true)
  assert.equal(result.verdict, 'same')
  assert.equal(result.changedPixels, 0)
  assert.equal(result.ratio, 0)
  assert.equal(result.bbox, null)
  assert.ok(result.mask.every((value) => value === 0))
})

test('单通道差在 tolerance 内视为同一像素（抗锯齿噪声不算变化）', () => {
  const a = image(10, 10, [100, 100, 100])
  const b = paint(a, 10, 3, 4, [105, 106, 104]) // 差 6/5/4 ≤ 8
  const result = compareScreenshots(a, b, { tolerance: 8 })
  assert.equal(result.verdict, 'same')
  assert.equal(result.changedPixels, 0)
})

test('局部变化 ⇒ changed，给出比例、bbox 与 mask', () => {
  const a = image(100, 100, [10, 20, 30])
  const b = paint(a, 100, 50, 60, [250, 0, 0])
  const result = compareScreenshots(a, b, { tolerance: 8, maxRatio: 0 })
  assert.equal(result.verdict, 'changed')
  assert.equal(result.changedPixels, 1)
  assert.equal(result.totalPixels, 10000)
  assert.equal(result.ratio, 0.0001)
  assert.deepEqual(result.bbox, { x: 50, y: 60, width: 1, height: 1 })
  assert.equal(result.mask[60 * 100 + 50], 1)
})

test('变化占比不超过 maxRatio 时仍算 same（用比例抗抖动）', () => {
  const a = image(100, 100, [0, 0, 0])
  const b = paint(a, 100, 0, 0, [255, 255, 255]) // 1/10000 = 0.0001
  assert.equal(compareScreenshots(a, b, { maxRatio: 0.001 }).verdict, 'same')
  assert.equal(compareScreenshots(a, b, { maxRatio: 0.00001 }).verdict, 'changed')
})

test('最小变化像素数下限：小面积但真实的变化不能被占比阈值吞掉', () => {
  // 大图里改 30 个像素：占比 30/1000000 = 0.00003，远低于 maxRatio，但超过下限 24 ⇒ 必须有变化
  const a = image(1000, 1000, [10, 10, 10])
  let b = a
  const changed = []
  for (let index = 0; index < 30; index += 1) {
    changed.push([index % 10, Math.floor(index / 10)])
  }
  for (const [x, y] of changed) b = paint(b, 1000, x, y, [250, 250, 250])
  const result = compareScreenshots(a, b, { maxRatio: 0.001, minChangedPixels: 24 })
  assert.equal(result.changedPixels, 30)
  assert.equal(result.verdict, 'changed', '占比极低但变化像素数够多，必须报有变化')

  // 只有 5 个像素变化：低于下限且占比也低 ⇒ same
  let small = a
  for (let index = 0; index < 5; index += 1) small = paint(small, 1000, index, 0, [250, 250, 250])
  assert.equal(compareScreenshots(a, small, { maxRatio: 0.001, minChangedPixels: 24 }).verdict, 'same')
  // 想更敏感就把下限调到 1
  assert.equal(compareScreenshots(a, small, { maxRatio: 0.001, minChangedPixels: 1 }).verdict, 'changed')
})

test('尺寸不同 ⇒ different-size（页面长高了不能当成 0 差异；比例/像素数给 null）', () => {
  const result = compareScreenshots(image(10, 10, [1, 2, 3]), image(10, 12, [1, 2, 3]))
  assert.equal(result.verdict, 'different-size')
  assert.equal(result.ratio, null)
  assert.equal(result.changedPixels, null)
  assert.equal(result.totalPixels, null)
  assert.equal(result.width, 10)
  assert.equal(result.height, 12)
})

test('基线挑选：URL 优先于 .png 后缀（带查询串也算 URL 证据）', () => {
  assert.deepEqual(pickBaselineEvidence(['shots/a.png', 'https://ci.example.com/shot.png?v=2']), {
    kind: 'url',
    entry: 'https://ci.example.com/shot.png?v=2',
  })
  assert.deepEqual(pickBaselineEvidence(['shots/a.png', 'https://ci.example.com/view']), {
    kind: 'url',
    entry: 'https://ci.example.com/view',
  })
  assert.deepEqual(pickBaselineEvidence(['shots/a.png', 'shots/b.png']), { kind: 'png', entry: 'shots/b.png' })
  assert.deepEqual(pickBaselineEvidence(['shots/a.jpg']), { kind: 'non-png', entry: 'shots/a.jpg' })
  assert.deepEqual(pickBaselineEvidence(['一条文字证据', '   ', '说明：手动验证过']), { kind: 'new', entry: null })
  assert.deepEqual(pickBaselineEvidence([]), { kind: 'new', entry: null })
  // 取"最后一张能当基线的图"，中间的普通文本证据要跳过
  assert.deepEqual(pickBaselineEvidence(['shots/a.png', '人工补充说明', 'shots/b.png']), { kind: 'png', entry: 'shots/b.png' })
})

test('解析不了 ⇒ uncomparable，绝不假装比过', () => {
  const ok = image(5, 5, [1, 1, 1])
  const bad = compareScreenshots(Buffer.from('nope'), ok)
  assert.equal(bad.ok, false)
  assert.equal(bad.verdict, 'uncomparable')
  assert.match(bad.reason, /baseline/)
  const badCurrent = compareScreenshots(ok, Buffer.from('nope'))
  assert.equal(badCurrent.verdict, 'uncomparable')
  assert.match(badCurrent.reason, /current/)
})

test('diff 图：变化像素标红、其余压灰，尺寸与原图一致', () => {
  const a = image(40, 20, [200, 200, 200])
  const b = paint(a, 40, 10, 5, [0, 0, 255])
  const result = compareScreenshots(a, b, { maxRatio: 0 })
  assert.equal(result.verdict, 'changed')
  const diff = renderDiffPng(b, result.mask)
  assert.equal(diff.ok, true)
  const decoded = decodePng(diff.png)
  assert.equal(decoded.width, 40)
  assert.equal(decoded.height, 20)
  const changedOffset = (5 * 40 + 10) * 3
  assert.deepEqual([...decoded.data.subarray(changedOffset, changedOffset + 3)], [255, 0, 72])
  const unchangedOffset = 0
  const gray = decoded.data[unchangedOffset]
  assert.equal(decoded.data[unchangedOffset + 1], gray)
  assert.equal(decoded.data[unchangedOffset + 2], gray)
  assert.ok(gray < 200, '未变化区域必须被压暗，变化才看得出来')
})

test('diff 图：mask 不匹配时拒绝生成（不给假 diff）', () => {
  const b = image(4, 4, [1, 2, 3])
  assert.deepEqual(renderDiffPng(b, Buffer.alloc(3)), { ok: false, error: 'bad-mask' })
})
