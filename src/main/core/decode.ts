import iconv from 'iconv-lite'
import jschardet from 'jschardet'

/**
 * 笔记文件常见 UTF-8 / GBK / GB18030 混用，这里做一次宽松解码：
 * 先按 UTF-8 解，出现较多替换字符时用 jschardet 猜编码再解。
 */
export function decodeTextBuffer(input: Buffer | Uint8Array): string {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (buffer.length === 0) return ''

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return iconv.decode(buffer, 'utf16-le').replace(/^﻿/, '')
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return iconv.decode(buffer, 'utf16-be').replace(/^﻿/, '')
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8')
  }

  const utf8 = buffer.toString('utf8')
  const replacementRatio = (utf8.match(/�/g)?.length ?? 0) / Math.max(utf8.length, 1)
  if (replacementRatio < 0.002) return utf8

  try {
    const detected = jschardet.detect(buffer)
    const encoding = normalizeEncoding(detected?.encoding)
    const decoded = iconv.decode(buffer, encoding)
    const badRatio = (decoded.match(/�/g)?.length ?? 0) / Math.max(decoded.length, 1)
    return badRatio <= replacementRatio ? decoded : utf8
  } catch {
    return utf8
  }
}

function normalizeEncoding(encoding?: string | null): string {
  if (!encoding) return 'gb18030'
  const name = encoding.toLowerCase()
  if (name === 'utf-8' || name === 'utf8' || name === 'ascii') return 'utf-8'
  if (name === 'utf-16le' || name === 'utf-16be') return name
  if (name.includes('gb') || name.includes('gb18030') || name.includes('gbk') || name.includes('gb2312')) {
    return 'gb18030'
  }
  if (name.includes('big5')) return 'big5'
  return iconv.encodingExists(encoding) ? encoding : 'gb18030'
}

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
