/**
 * 最小 PNG 编解码：只保证截图对比需要的那部分正确。
 * 这些用例是视觉回归的地基——解码错了，"一致/有变化"的结论就全错。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { crc32, decodePng, encodePng, toRgb } from '../lib/png.js'

function solid(width, height, rgb, channels = 3) {
  const data = Buffer.alloc(width * height * channels)
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      data[pixel * channels + channel] = rgb[channel] ?? 0
    }
  }
  return { width, height, channels, data }
}

/** 改 IHDR 里的一个字节并重算 CRC——用来构造"合法但格式不支持"的图。 */
function patchIhdr(png, offsetInIhdrData, value) {
  const copy = Buffer.from(png)
  copy[16 + offsetInIhdrData] = value
  const crc = crc32(copy.subarray(12, 29))
  copy.writeUInt32BE(crc, 29)
  return copy
}

test('编码→解码往返：RGB 像素逐一相等', () => {
  const source = solid(5, 4, [10, 200, 30])
  const png = encodePng(source)
  const decoded = decodePng(png)
  assert.equal(decoded.ok, true)
  assert.equal(decoded.width, 5)
  assert.equal(decoded.height, 4)
  assert.equal(decoded.channels, 3)
  assert.deepEqual([...decoded.data], [...source.data])
})

test('编码→解码往返：RGBA（colorType 6）也支持', () => {
  const source = solid(3, 2, [1, 2, 3, 250], 4)
  const decoded = decodePng(encodePng(source))
  assert.equal(decoded.ok, true)
  assert.equal(decoded.channels, 4)
  assert.deepEqual([...decoded.data], [...source.data])
})

test('toRgb：RGBA 丢掉 alpha，转成逐像素 RGB', () => {
  const decoded = decodePng(encodePng(solid(2, 1, [7, 8, 9, 128], 4)))
  const rgb = toRgb(decoded)
  assert.deepEqual([...rgb], [7, 8, 9, 7, 8, 9])
})

test('非 PNG / 截断数据：明确报错，不抛异常', () => {
  assert.deepEqual(decodePng(Buffer.from('not a png')), { ok: false, error: 'not-png' })
  const png = encodePng(solid(4, 4, [1, 2, 3]))
  const truncated = decodePng(png.subarray(0, 40))
  assert.equal(truncated.ok, false)
  assert.equal(typeof truncated.error, 'string')
})

test('不支持的格式（调色板 / 隔行 / 16-bit）→ unsupported，不做"尽力猜"', () => {
  const png = encodePng(solid(2, 2, [1, 2, 3]))
  // PNG: 8 字节签名 + 4 长度 + 4 类型 ⇒ IHDR data 从 16 开始；
  // bitDepth=24, colorType=25, interlace=28。
  assert.deepEqual(decodePng(patchIhdr(png, 9, 3)), { ok: false, error: 'unsupported' }) // 调色板
  assert.deepEqual(decodePng(patchIhdr(png, 12, 1)), { ok: false, error: 'unsupported' }) // 隔行
  assert.deepEqual(decodePng(patchIhdr(png, 8, 16)), { ok: false, error: 'unsupported' }) // 16-bit
})

test('CRC 不对 ⇒ bad-crc（损坏图绝不能算进视觉回归）', () => {
  const png = encodePng(solid(4, 4, [9, 9, 9]))
  const corrupted = Buffer.from(png)
  corrupted[24] = 9 // 直接改 IHDR 数据、不重算 CRC
  assert.deepEqual(decodePng(corrupted), { ok: false, error: 'bad-crc' })
})

test('IDAT 坏掉 → bad-crc（CRC 先拦下损坏数据）', () => {
  const png = encodePng(solid(8, 8, [9, 9, 9]))
  const broken = Buffer.from(png)
  // 找 IDAT 数据起点（signature 8 + IHDR(4+4+13+4)=25 ⇒ 33 起是 IDAT 长度/类型/数据）
  const idatDataStart = 33 + 8
  broken[idatDataStart] = broken[idatDataStart] ^ 0xff
  assert.deepEqual(decodePng(broken), { ok: false, error: 'bad-crc' })
})
