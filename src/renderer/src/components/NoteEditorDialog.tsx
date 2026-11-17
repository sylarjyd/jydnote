import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ChevronDown, FilePlus2, Folder, Pencil, X } from 'lucide-react'
import type { NoteFormat } from '../../../shared/types'
import {
  NOTE_CONTENT_MAX,
  NOTE_FORMAT_EXT,
  validateNoteContent,
  validateNoteTitle
} from '../../../shared/notes'
import { folderLabel } from '../lib/folders'
import FolderPicker from './FolderPicker'
import SegmentedControl from './SegmentedControl'

export interface NoteDraft {
  title: string
  content: string
  format: NoteFormat
  folder: string | null
}

interface Props {
  mode: 'create' | 'edit'
  folders: string[]
  initial: NoteDraft
  onSubmit: (draft: NoteDraft) => Promise<void>
  onClose: () => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function NoteEditorDialog({
  mode,
  folders,
  initial,
  onSubmit,
  onClose
}: Props) {
  const [title, setTitle] = useState(initial.title)
  const [format, setFormat] = useState<NoteFormat>(initial.format)
  const [folder, setFolder] = useState<string | null>(initial.folder)
  const [folderOpen, setFolderOpen] = useState(false)
  const [contentDirty, setContentDirty] = useState(false)
  const [contentEmpty, setContentEmpty] = useState(() => !initial.content.trim())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const titleRef = useRef<HTMLInputElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const busyRef = useRef(false)

  const dirty =
    contentDirty || title !== initial.title || format !== initial.format || folder !== initial.folder

  useEffect(() => {
    if (mode === 'create') {
      titleRef.current?.focus()
      return
    }
    const textarea = textRef.current
    if (!textarea) return
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  }, [mode])

  const requestClose = useCallback(() => {
    if (busyRef.current) return
    if (dirty && !window.confirm('放弃未保存的修改？')) return
    onClose()
  }, [dirty, onClose])

  const submit = useCallback(async (): Promise<void> => {
    if (busyRef.current) return
    if (mode === 'edit' && !dirty) return
    const content = textRef.current?.value ?? ''
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const draft: NoteDraft = {
        title: validateNoteTitle(title),
        content: validateNoteContent(content),
        format,
        folder
      }
      await onSubmit(draft)
      onClose()
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [mode, dirty, title, format, folder, onSubmit, onClose])

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      requestClose()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [requestClose])

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      void submit()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [submit])

  const submitForm = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    void submit()
  }

  const fileName = `${title.trim() || '未命名'}.${NOTE_FORMAT_EXT[format]}`
  const canSave = !busy && Boolean(title.trim()) && !contentEmpty && (mode === 'create' || dirty)

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose()
      }}
    >
      <form className="dialog note-dialog" onSubmit={submitForm}>
        <header className="dialog-header">
          <div className="doc-dialog-title">
            <div className="doc-dialog-icon">
              {mode === 'create' ? <FilePlus2 size={18} /> : <Pencil size={18} />}
            </div>
            <div>
              <h2>{mode === 'create' ? '新建笔记' : '编辑笔记'}</h2>
              <p>
                {mode === 'create'
                  ? '保存后会自动解析、切块并建立索引，随后参与检索'
                  : '保存后会重写库内副本并重建索引'}
              </p>
            </div>
          </div>
          <div className="doc-dialog-tools">
            <button type="button" className="dialog-close" onClick={requestClose} title="关闭">
              <X size={17} />
            </button>
          </div>
        </header>

        <div className="dialog-body note-dialog-body">
          <div className="note-meta-row">
            <label className="note-title-field">
              <span>标题</span>
              <input
                ref={titleRef}
                type="text"
                value={title}
                maxLength={120}
                spellCheck={false}
                placeholder="例如：产品周报"
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <div className="note-format-field">
              <span>格式</span>
              {mode === 'create' ? (
                <SegmentedControl<NoteFormat>
                  value={format}
                  label="笔记格式"
                  options={[
                    { value: 'markdown', label: 'Markdown' },
                    { value: 'text', label: '纯文本' }
                  ]}
                  onChange={setFormat}
                />
              ) : (
                <span className="note-format-readonly">
                  {format === 'markdown' ? 'Markdown' : '纯文本'}
                </span>
              )}
            </div>
          </div>

          <div className="note-file-hint">
            文件名：<strong>{fileName}</strong>
            {mode === 'create' ? null : ' · 格式与扩展名保持原样'}
          </div>

          {mode === 'create' ? (
            <div className="note-folder-section">
              <button
                type="button"
                className="note-folder-toggle"
                aria-expanded={folderOpen}
                onClick={() => setFolderOpen((open) => !open)}
              >
                <Folder size={14} />
                <span>保存位置：{folderLabel(folder)}</span>
                <ChevronDown size={14} className={folderOpen ? 'open' : ''} />
              </button>
              {folderOpen ? (
                <div className="note-folder-panel">
                  <FolderPicker
                    folders={folders}
                    value={folder}
                    onChange={setFolder}
                    emptyHint="还没有创建目录，笔记会保存到知识库根目录。"
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          <textarea
            ref={textRef}
            className="note-editor-textarea"
            defaultValue={initial.content}
            maxLength={NOTE_CONTENT_MAX}
            spellCheck={false}
            placeholder={mode === 'create' ? '从这里开始写…支持 Markdown 语法' : undefined}
            onChange={(event) => {
              setContentDirty(true)
              setContentEmpty(!event.target.value.trim())
            }}
          />

          {error ? <div className="settings-error">{error}</div> : null}
        </div>

        <footer className="dialog-footer">
          <span className="footer-note">
            保存后会重写库内副本并重建索引，外部原文件不会被修改。
          </span>
          <div className="footer-actions">
            <button type="button" className="btn-ghost" onClick={requestClose}>
              取消
            </button>
            <button type="submit" className="btn-primary" disabled={!canSave}>
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </footer>
      </form>
    </div>
  )
}
