/**
 * 验证本地 OCR 链路：tesseract.js worker + resources/tessdata 语言数据。
 * 用一张空白灰度图跑识别，只要 worker 能启动并返回「没有文字」即视为通过。
 *
 * 运行：npm run check-ocr
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { parseImageFile } from '../src/main/core/parsers/image'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0)
  return Buffer.concat([head, data, crc])
}

function whitePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const raw = Buffer.alloc(height * (width + 1), 0xff)
  for (let row = 0; row < height; row++) raw[row * (width + 1)] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'jyd-ocr-'))
const imagePath = path.join(workDir, 'blank.png')

try {
  await fsp.writeFile(imagePath, whitePng(320, 120))
  console.log('正在启动 tesseract worker 并识别空白图片…')

  try {
    const parsed = await parseImageFile({
      filePath: imagePath,
      title: 'blank',
      visionModel: '',
      ollamaUrl: '',
      ocrLangs: 'eng',
      tessdataDir: path.join(ROOT, 'resources', 'tessdata'),
      ocrCacheDir: path.join(workDir, 'cache')
    })
    console.log(`✓ OCR 完成（返回 ${parsed.blocks.length} 个块）`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('没有识别到文字')) {
      console.log('✓ OCR 链路正常（空白图未识别出文字，符合预期）')
    } else {
      throw error
    }
  }
} finally {
  await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
}
