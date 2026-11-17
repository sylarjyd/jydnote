import { decodeTextBuffer, normalizeWhitespace } from '../decode'
import type { ParsedDoc, TextBlock } from './base'

/**
 * Markdown 按标题切块，保留标题路径；代码块里的 # 不会被当成标题。
 */
export function parseMarkdownText(markdown: string, fallbackTitle: string): ParsedDoc {
  const lines = normalizeWhitespace(markdown).split('\n')
  const blocks: TextBlock[] = []
  const stack: { level: number; text: string }[] = []
  let buffer: string[] = []
  let title = ''

  const currentPath = (): string[] => stack.map((item) => item.text)

  const flush = (): void => {
    const text = buffer.join('\n').trim()
    buffer = []
    if (!text) return
    blocks.push({ text, headingPath: currentPath() })
  }

  let inFence = false
  let fenceMarker = ''

  for (const line of lines) {
    const fence = line.match(/^\s*(```|~~~)/)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceMarker = fence[1]
      } else if (line.trim().startsWith(fenceMarker)) {
        inFence = false
      }
      buffer.push(line)
      continue
    }

    if (!inFence) {
      const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
      if (heading) {
        flush()
        const level = heading[1].length
        const text = heading[2].trim()
        if (level === 1 && !title) title = text
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
        stack.push({ level, text })
        continue
      }
    }

    buffer.push(line)
  }
  flush()

  return {
    title: title || fallbackTitle,
    blocks: blocks.length ? blocks : [{ text: normalizeWhitespace(markdown), headingPath: [] }]
  }
}

export function parsePlainText(text: string, fallbackTitle: string): ParsedDoc {
  const normalized = normalizeWhitespace(text)
  if (!normalized) return { title: fallbackTitle, blocks: [] }

  const paragraphs = normalized.split(/\n{2,}/)
  const blocks: TextBlock[] = []
  let buffer: string[] = []
  let size = 0

  const flush = (): void => {
    if (!buffer.length) return
    blocks.push({ text: buffer.join('\n\n'), headingPath: [] })
    buffer = []
    size = 0
  }

  for (const paragraph of paragraphs) {
    if (size > 0 && size + paragraph.length > 1200) flush()
    buffer.push(paragraph)
    size += paragraph.length
  }
  flush()

  return { title: fallbackTitle, blocks }
}

export function parseTextFile(buffer: Buffer, title: string, ext: string): ParsedDoc {
  const text = decodeTextBuffer(buffer)
  if (ext === 'md' || ext === 'markdown') return parseMarkdownText(text, title)
  return parsePlainText(text, title)
}
