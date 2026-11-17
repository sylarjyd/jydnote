import fs from 'node:fs'
import * as XLSX from 'xlsx'
import type { ParsedDoc, TextBlock } from './base'

const ROWS_PER_BLOCK = 12
const MAX_CELL_CHARS = 200

function cleanCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|')
}

function padRow(row: unknown[], width: number): string[] {
  const cells = row.map(cleanCell)
  while (cells.length < width) cells.push('')
  return cells.slice(0, width)
}

/**
 * Excel / CSV 转成 Markdown 表格块。
 * 每 12 行重复一次表头，保证任意一块被检索出来时都自带字段名。
 */
export function parseSpreadsheetFile(filePath: string, title: string): ParsedDoc {
  const buffer = fs.readFileSync(filePath)
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: false })
  const blocks: TextBlock[] = []

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) continue

    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: '',
      raw: false,
      blankrows: false
    })
    if (!rows.length) continue

    const width = Math.max(1, ...rows.map((row) => row.length))
    const header = padRow(rows[0] ?? [], width)
    const headerLine = `| ${header.map(escapeCell).join(' | ')} |`
    const separatorLine = `| ${header.map(() => '---').join(' | ')} |`
    const dataRows = rows.slice(1)

    if (!dataRows.length) {
      blocks.push({
        text: `工作表「${sheetName}」\n\n${headerLine}\n${separatorLine}`,
        headingPath: [sheetName],
        sheet: sheetName
      })
      continue
    }

    for (let start = 0; start < dataRows.length; start += ROWS_PER_BLOCK) {
      const slice = dataRows.slice(start, start + ROWS_PER_BLOCK)
      const lines = slice.map(
        (row) => `| ${padRow(row, width).map(escapeCell).join(' | ')} |`
      )
      const firstRow = start + 2
      const lastRow = start + slice.length + 1
      blocks.push({
        text: `工作表「${sheetName}」第 ${firstRow}-${lastRow} 行\n\n${headerLine}\n${separatorLine}\n${lines.join('\n')}`,
        headingPath: [sheetName],
        sheet: sheetName
      })
    }
  }

  return { title, blocks }
}
