import fs from 'node:fs'
import mammoth from 'mammoth'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import type { ParsedDoc } from './base'
import { parseMarkdownText } from './text'

/**
 * mammoth 的表格单元格里会包一层 <p>，turndown 的表格插件因此放弃转换、直接保留 HTML。
 * 这里先把单元格内的段落压平成纯文本，让表格变成可阅读的 Markdown 表格。
 */
function flattenTableCells(html: string): string {
  return html.replace(/<table[\s\S]*?<\/table>/gi, (table) => {
    const flat = table
      .replace(/<(td|th)([^>]*)>\s*<p[^>]*>/gi, '<$1$2>')
      .replace(/<\/p>\s*<\/(td|th)>/gi, '</$1>')
      .replace(/<\/p>\s*<p[^>]*>/gi, ' ')
    // Markdown 表格必须有表头，Word 表格没有 <th> 时把首行提升为表头
    if (/<th[\s>]/i.test(flat)) return flat
    return flat.replace(/<tr[^>]*>[\s\S]*?<\/tr>/i, (row) =>
      row.replace(/<td([^>]*)>/gi, '<th$1>').replace(/<\/td>/gi, '</th>')
    )
  })
}

/** Word 转 Markdown：导入切块与预览共用，图片会转成 data URL 内联 */
export async function docxToMarkdown(filePath: string): Promise<string> {
  const buffer = await fs.promises.readFile(filePath)
  const result = await mammoth.convertToHtml(
    { buffer },
    { ignoreEmptyParagraphs: true }
  )

  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced'
  })
  turndown.use(gfm)

  return turndown.turndown(flattenTableCells(result.value || ''))
}

export async function parseDocxFile(filePath: string, title: string): Promise<ParsedDoc> {
  const markdown = await docxToMarkdown(filePath)
  return parseMarkdownText(markdown, title)
}
