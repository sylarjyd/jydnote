import fs from 'node:fs'
import * as XLSX from 'xlsx'
import type { DocKind, DocPreview, SheetPreview } from '../../shared/types'
import { docxToMarkdown } from './parsers/docx'
import { buildSlidesPreview } from './parsers/pptx'

/** 预览只展示左上角区域，避免超大表格把渲染进程卡住 */
const MAX_PREVIEW_ROWS = 400
const MAX_PREVIEW_COLS = 40

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    const pad = (part: number): string => `${part}`.padStart(2, '0')
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`
  }
  return String(value).replace(/\s+/g, ' ').trim()
}

function buildSheetsPreview(filePath: string): SheetPreview[] {
  const workbook = XLSX.read(fs.readFileSync(filePath), {
    type: 'buffer',
    cellDates: true,
    raw: false
  })
  const sheets: SheetPreview[] = []

  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]
    if (!sheet) continue
    const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: '',
      raw: false,
      blankrows: false
    })
    if (!raw.length) continue

    const width = Math.min(MAX_PREVIEW_COLS, Math.max(1, ...raw.map((row) => row.length)))
    const rows = raw.slice(0, MAX_PREVIEW_ROWS).map((row) => {
      const cells: string[] = []
      for (let index = 0; index < width; index++) cells.push(cellText(row[index]))
      return cells
    })
    sheets.push({
      name,
      rows,
      truncated: raw.length > MAX_PREVIEW_ROWS || raw.some((row) => row.length > MAX_PREVIEW_COLS)
    })
  }

  if (!sheets.length) throw new Error('工作簿中没有可预览的工作表')
  return sheets
}

/**
 * 按文件类型生成预览数据。
 * 解析失败会抛错，由调用方决定回退到切块文本。
 */
export async function buildDocPreview(
  kind: DocKind,
  filePath: string,
  sourceUrl: string
): Promise<DocPreview | null> {
  switch (kind) {
    case 'docx': {
      const markdown = (await docxToMarkdown(filePath)).trim()
      return markdown ? { type: 'markdown', markdown } : null
    }
    case 'sheet':
      return { type: 'sheets', sheets: buildSheetsPreview(filePath) }
    case 'pdf':
      return { type: 'pdf', url: sourceUrl }
    case 'slides':
      return { type: 'slides', ...(await buildSlidesPreview(filePath)) }
    case 'image':
      return { type: 'image', url: sourceUrl }
    default:
      return null
  }
}
