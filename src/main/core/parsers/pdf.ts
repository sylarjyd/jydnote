import fs from 'node:fs'
import { normalizeWhitespace } from '../decode'
import type { ParsedDoc, TextBlock } from './base'

export async function parsePdfFile(filePath: string, title: string): Promise<ParsedDoc> {
  const buffer = await fs.promises.readFile(filePath)
  // unpdf 是 ESM-only 包，主进程为 CJS，运行时动态引入
  const { extractText } = await import('unpdf')
  const result = await extractText(new Uint8Array(buffer), { mergePages: false })
  const pages = Array.isArray(result.text) ? result.text : [result.text]

  const blocks: TextBlock[] = []
  pages.forEach((pageText, index) => {
    const text = normalizeWhitespace(cleanupPdfText(pageText ?? ''))
    if (text.length < 2) return
    blocks.push({ text, headingPath: [], page: index + 1 })
  })

  if (!blocks.length) {
    throw new Error(
      '这个 PDF 没有可提取的文字，可能是扫描件。可将页面截图作为图片导入，或先用 OCR 工具生成可搜索 PDF。'
    )
  }

  return { title, blocks }
}

function cleanupPdfText(text: string): string {
  return text
    // PDF 常见的软换行：中文行尾直接拼接，英文保留空格
    .replace(/([^\n])\n(?=[^\n])/g, (_, ch: string) => {
      return /[A-Za-z0-9,.;:!?)]/.test(ch) ? `${ch} ` : ch
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}
