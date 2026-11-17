import { useEffect, useState } from 'react'
import { FolderTree, X } from 'lucide-react'
import type { DocMeta } from '../../../shared/types'
import { folderLabel } from '../lib/folders'
import FolderPicker from './FolderPicker'

interface Props {
  docs: DocMeta[]
  folders: string[]
  onSubmit: (folder: string | null) => Promise<void>
  onClose: () => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function MoveDocDialog({ docs, folders, onSubmit, onClose }: Props) {
  const count = docs.length
  const firstFolder = docs[0]?.folder ?? null
  // 全部文档仍在同一目录时才显示「当前」并预选；跨目录时从根目录开始选择
  const sameFolder = docs.every((doc) => (doc.folder ?? null) === firstFolder)
    ? firstFolder
    : undefined
  const [selected, setSelected] = useState<string | null>(sameFolder ?? null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const unchanged = docs.every((doc) => (doc.folder ?? null) === selected)

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [onClose])

  const submit = async (): Promise<void> => {
    if (busy || unchanged) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(selected)
      onClose()
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="dialog folder-dialog">
        <header className="dialog-header">
          <div className="doc-dialog-title">
            <div className="doc-dialog-icon">
              <FolderTree size={18} />
            </div>
            <div>
              <h2>{count > 1 ? '批量移动文档' : '移动文档'}</h2>
              <p>
                {count > 1
                  ? sameFolder === undefined
                    ? `已选择 ${count} 个文档，它们目前分布在不同的目录`
                    : `已选择 ${count} 个文档，当前都位于「${folderLabel(sameFolder)}」`
                  : `《${docs[0]?.name ?? ''}》当前位于「${folderLabel(firstFolder)}」`}
              </p>
            </div>
          </div>
          <button type="button" className="dialog-close" onClick={onClose} title="关闭">
            <X size={17} />
          </button>
        </header>

        <div className="dialog-body">
          <FolderPicker
            folders={folders}
            value={selected}
            onChange={setSelected}
            current={sameFolder}
            emptyHint="还没有创建目录，可以先在侧边栏新建目录后再移动。"
          />
          {error ? <div className="settings-error">{error}</div> : null}
        </div>

        <footer className="dialog-footer">
          <span className="footer-note">移动只改变知识库里的归类，不会移动或删除原始文件。</span>
          <div className="footer-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busy || unchanged}
              onClick={() => void submit()}
            >
              {busy ? '移动中…' : count > 1 ? `移动 ${count} 个文档` : '移动到这里'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
