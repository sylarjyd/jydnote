import type { NoteFormat } from './types'

export const NOTE_TITLE_MAX = 120
export const NOTE_CONTENT_MAX = 1_000_000

/** 新建笔记时格式与源文件扩展名的对应关系；编辑时沿用文档原有扩展名 */
export const NOTE_FORMAT_EXT: Record<NoteFormat, 'md' | 'txt'> = {
  markdown: 'md',
  text: 'txt'
}

function hasControlOrNewline(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * 标题只用于列表展示与文件名，写盘路径固定为 docs/<id>/source.<ext>，
 * 因此这里不做 Windows 文件名限制，避免误伤「？」「：」这类正常标题。
 */
export function validateNoteTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('标题不能为空')
  const title = raw.trim()
  if (!title) throw new Error('标题不能为空')
  if (title.length > NOTE_TITLE_MAX) throw new Error(`标题不能超过 ${NOTE_TITLE_MAX} 个字符`)
  if (hasControlOrNewline(title)) throw new Error('标题不能包含换行或控制字符')
  return title
}

export function validateNoteContent(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('笔记内容不能为空')
  if (raw.length > NOTE_CONTENT_MAX) {
    throw new Error('笔记内容过长，最多 100 万字符')
  }
  return raw
}

export function isNoteFormat(value: unknown): value is NoteFormat {
  return value === 'markdown' || value === 'text'
}

/** 由文档名推出编辑弹窗的初始标题，例如「周报.md」→「周报」 */
export function noteTitleOfName(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

/** 标题与格式组成文档名；扩展名与格式保持一致 */
export function noteFileName(title: string, format: NoteFormat): string {
  return `${title}.${NOTE_FORMAT_EXT[format]}`
}
