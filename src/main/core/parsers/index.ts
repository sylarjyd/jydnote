import fs from 'node:fs'
import type { DocKind } from '../../../shared/types'
import type { ParseContext, ParsedDoc } from './base'
import { parseTextFile } from './text'
import { parseDocxFile } from './docx'
import { parseSpreadsheetFile } from './spreadsheet'
import { parsePdfFile } from './pdf'
import { parsePptxFile } from './pptx'
import { parseImageFile } from './image'

export const SUPPORTED_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'docx',
  'xlsx',
  'xls',
  'csv',
  'pdf',
  'pptx',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'bmp',
  'tif',
  'tiff'
] as const

const KIND_BY_EXT: Record<string, DocKind> = {
  txt: 'text',
  md: 'markdown',
  markdown: 'markdown',
  docx: 'docx',
  xlsx: 'sheet',
  xls: 'sheet',
  csv: 'sheet',
  pdf: 'pdf',
  pptx: 'slides',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  bmp: 'image',
  tif: 'image',
  tiff: 'image'
}

export function getDocKind(ext: string): DocKind | null {
  return KIND_BY_EXT[ext.toLowerCase()] ?? null
}

export async function parseDocument(context: ParseContext): Promise<ParsedDoc> {
  switch (context.kind) {
    case 'text':
    case 'markdown': {
      const buffer = await fs.promises.readFile(context.filePath)
      return parseTextFile(buffer, context.title, context.fileName.split('.').pop() ?? 'txt')
    }
    case 'docx':
      return parseDocxFile(context.filePath, context.title)
    case 'sheet':
      return parseSpreadsheetFile(context.filePath, context.title)
    case 'pdf':
      return parsePdfFile(context.filePath, context.title)
    case 'slides':
      return parsePptxFile(context.filePath, context.title)
    case 'image':
      return parseImageFile(context)
    default:
      throw new Error(`暂不支持的文件类型：${context.kind}`)
  }
}
