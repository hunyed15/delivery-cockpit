/**
 * 最小 PNG 编解码（零依赖）。
 *
 * 只覆盖截图对比真正需要的子集：8-bit、非隔行、颜色类型 2(RGB) / 6(RGBA)。
 * Chrome 的 `Page.captureScreenshot` 实测输出就是 8-bit RGB（colorType=2）。
 * 其他格式一律返回 `unsupported`，不做"尽力猜"——猜错会给出错的视觉回归结论。
 */
import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const SUPPORTED_COLOR_TYPES = new Set([2, 6])

let crcTable = null
export function crc32(buffer) {
  if (crcTable === null) {
    crcTable = new Int32Array(256)
    for (let index = 0; index < 256; index += 1) {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      }
      crcTable[index] = value
    }
  }
  let crc = -1
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft
  const distLeft = Math.abs(estimate - left)
  const distUp = Math.abs(estimate - up)
  const distUpperLeft = Math.abs(estimate - upperLeft)
  if (distLeft <= distUp && distLeft <= distUpperLeft) return left
  if (distUp <= distUpperLeft) return up
  return upperLeft
}

function unfilterLine(filter, line, previous, target, bytesPerPixel) {
  const length = line.length
  for (let index = 0; index < length; index += 1) {
    const left = index >= bytesPerPixel ? target[index - bytesPerPixel] : 0
    const up = previous[index] ?? 0
    const upperLeft = index >= bytesPerPixel ? (previous[index - bytesPerPixel] ?? 0) : 0
    const value = line[index]
    let restored
    switch (filter) {
      case 0:
        restored = value
        break
      case 1:
        restored = value + left
        break
      case 2:
        restored = value + up
        break
      case 3:
        restored = value + ((left + up) >> 1)
        break
      case 4:
        restored = value + paeth(left, up, upperLeft)
        break
      default:
        return false
    }
    target[index] = restored & 0xff
  }
  return true
}

/** 解码 PNG → `{ok:true,width,height,channels,data}`（data 为逐行 RGB/RGBA 原始字节）或 `{ok:false,error}`。 */
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    return { ok: false, error: 'not-png' }
  }
  let offset = 8
  let header = null
  const idat = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    if (dataStart + length + 4 > buffer.length) return { ok: false, error: 'truncated' }
    const data = buffer.subarray(dataStart, dataStart + length)
    // CRC 校验：坏字节必须当场发现，否则会把损坏图算进视觉回归结论。
    const storedCrc = buffer.readUInt32BE(dataStart + length)
    if (crc32(Buffer.concat([buffer.subarray(offset + 4, dataStart), data])) !== storedCrc) {
      return { ok: false, error: 'bad-crc' }
    }
    if (type === 'IHDR') {
      if (length < 13) return { ok: false, error: 'bad-ihdr' }
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset = dataStart + length + 4
  }
  if (header === null) return { ok: false, error: 'no-ihdr' }
  if (header.width <= 0 || header.height <= 0) return { ok: false, error: 'bad-size' }
  if (header.bitDepth !== 8 || !SUPPORTED_COLOR_TYPES.has(header.colorType) || header.interlace !== 0 || header.compression !== 0 || header.filter !== 0) {
    return { ok: false, error: 'unsupported' }
  }

  const channels = header.colorType === 6 ? 4 : 3
  const stride = header.width * channels
  let inflated
  try {
    inflated = inflateSync(Buffer.concat(idat))
  } catch {
    return { ok: false, error: 'bad-zlib' }
  }
  if (inflated.length < (stride + 1) * header.height) return { ok: false, error: 'truncated' }

  const data = Buffer.alloc(stride * header.height)
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < header.height; y += 1) {
    const rowStart = y * (stride + 1)
    const filter = inflated[rowStart]
    const line = inflated.subarray(rowStart + 1, rowStart + 1 + stride)
    const target = data.subarray(y * stride, (y + 1) * stride)
    if (!unfilterLine(filter, line, previous, target, channels)) return { ok: false, error: 'bad-filter' }
    previous = target
  }
  return { ok: true, width: header.width, height: header.height, channels, colorType: header.colorType, data }
}

/** 编码 PNG（filter=0，非隔行）。channels 3 → colorType 2，4 → colorType 6。 */
export function encodePng({ width, height, channels = 3, data }) {
  const colorType = channels === 4 ? 6 : 2
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = colorType
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 把任意支持的图转成 RGB（RGBA 丢掉 alpha：截图都是不透明的）。 */
export function toRgb(decoded) {
  if (decoded.channels === 3) return decoded.data
  const pixels = decoded.width * decoded.height
  const rgb = Buffer.alloc(pixels * 3)
  for (let index = 0; index < pixels; index += 1) {
    rgb[index * 3] = decoded.data[index * 4]
    rgb[index * 3 + 1] = decoded.data[index * 4 + 1]
    rgb[index * 3 + 2] = decoded.data[index * 4 + 2]
  }
  return rgb
}
