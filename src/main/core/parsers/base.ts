import type { DocKind } from '../../../shared/types'

export interface TextBlock {
  text: string
  headingPath: string[]
  page?: number
  sheet?: string
}

export interface ParsedDoc {
  title: string
  blocks: TextBlock[]
}

export interface ParseContext {
  filePath: string
  fileName: string
  title: string
  kind: DocKind
  visionModel: string
  ollamaUrl: string
  ocrLangs: string
  tessdataDir: string
  ocrCacheDir: string
}
