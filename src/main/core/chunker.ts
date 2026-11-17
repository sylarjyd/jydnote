import type { ChunkMeta } from '../../shared/types'
import type { TextBlock } from './parsers/base'

export interface ChunkOptions {
  docId: string
  maxChars: number
  overlap: number
}

/** 按中英文句末标点 / 换行切句，保留分隔符后的空白 */
function splitUnits(text: string): string[] {
  const matches = text.match(/[^。！？!?；;\n]*[。！？!?；;\n]\s*|[^。！？!?；;\n]+$/g)
  if (!matches) return [text]
  return matches.filter((unit) => unit.trim().length > 0)
}

/** 取尾部若干字符，尽量从句首开始，避免切出半句话 */
function overlapTail(text: string, overlap: number): string {
  if (overlap <= 0 || !text) return ''
  const start = Math.max(0, text.length - overlap)
  const tail = text.slice(start)
  const boundary = tail.search(/[。！？!?；;\n]/)
  return (boundary >= 0 ? tail.slice(boundary + 1) : tail).trim()
}

/**
 * 把解析出的文本块切成适合嵌入的 chunk。
 * 保留标题路径、页码、工作表等元信息，供引用展示。
 */
export function chunkBlocks(blocks: TextBlock[], options: ChunkOptions): ChunkMeta[] {
  const max = Math.max(200, Math.floor(options.maxChars))
  const overlap = Math.min(Math.max(0, Math.floor(options.overlap)), Math.floor(max / 2))
  const chunks: ChunkMeta[] = []
  let order = 0
  let docOffset = 0

  for (const block of blocks) {
    const raw = block.text.replace(/\r\n?/g, '\n').trim()
    if (!raw) {
      docOffset += block.text.length + 2
      continue
    }

    const units = splitUnits(raw)
    let buffer: string[] = []
    let bufferLen = 0
    let bufferStart = 0
    let cursor = 0

    const flush = (): void => {
      const text = buffer.join('').trim()
      if (!text) return
      chunks.push({
        id: `${options.docId}:${order}`,
        docId: options.docId,
        index: order++,
        text,
        headingPath: block.headingPath ?? [],
        page: block.page,
        sheet: block.sheet,
        charStart: docOffset + Math.max(0, bufferStart),
        charEnd: docOffset + Math.max(0, bufferStart) + text.length
      })
      buffer = []
      bufferLen = 0
    }

    for (const unit of units) {
      const unitStart = cursor
      cursor += unit.length

      // 超长且无标点的段落，硬切
      if (unit.length > max) {
        if (bufferLen > 0) flush()
        let pos = 0
        while (pos < unit.length) {
          const end = Math.min(unit.length, pos + max)
          const piece = unit.slice(pos, end).trim()
          if (piece) {
            bufferStart = unitStart + pos
            buffer = [piece]
            bufferLen = piece.length
            flush()
          }
          if (end >= unit.length) break
          pos = Math.max(pos + 1, end - overlap)
        }
        buffer = []
        bufferLen = 0
        continue
      }

      if (bufferLen > 0 && bufferLen + unit.length > max) {
        flush()
        const tail = overlapTail(chunks.length ? chunks[chunks.length - 1].text : '', overlap)
        buffer = tail ? [tail] : []
        bufferLen = tail.length
        bufferStart = Math.max(0, unitStart - tail.length)
      }

      if (buffer.length === 0) bufferStart = unitStart
      buffer.push(unit)
      bufferLen += unit.length
    }

    flush()
    docOffset += raw.length + 2
  }

  // 过短的尾块合并到前一块，避免产生无意义的碎片
  const minChars = 40
  const merged: ChunkMeta[] = []
  for (const chunk of chunks) {
    const prev = merged[merged.length - 1]
    if (
      prev &&
      chunk.text.length < minChars &&
      prev.docId === chunk.docId &&
      prev.headingPath.join('/') === chunk.headingPath.join('/') &&
      prev.page === chunk.page &&
      prev.text.length + chunk.text.length <= Math.floor(max * 1.3)
    ) {
      prev.text = `${prev.text}\n${chunk.text}`.trim()
      prev.charEnd = chunk.charEnd
      continue
    }
    merged.push(chunk)
  }

  return merged.map((chunk, index) => ({ ...chunk, index, id: `${options.docId}:${index}` }))
}
