import { useEffect, useRef, useState, type FormEvent } from 'react'
import { FolderPlus, Pencil, X } from 'lucide-react'

interface Props {
  mode: 'create' | 'rename'
  /** 新建时是上级目录，重命名时是目录本身 */
  folder: string
  onSubmit: (name: string) => Promise<void>
  onClose: () => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function FolderNameDialog({ mode, folder, onSubmit, onClose }: Props) {
  const rename = mode === 'rename'
  const [value, setValue] = useState(rename ? folder.slice(folder.lastIndexOf('/') + 1) : '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [onClose])

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const name = value.trim()
    if (!name || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(name)
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
      <form className="dialog folder-dialog" onSubmit={(event) => void submit(event)}>
        <header className="dialog-header">
          <div className="doc-dialog-title">
            <div className="doc-dialog-icon">
              {rename ? <Pencil size={18} /> : <FolderPlus size={18} />}
            </div>
            <div>
              <h2>{rename ? '重命名目录' : '新建目录'}</h2>
              <p>
                {rename
                  ? `目录「${folder}」内的文档与子目录会一起改名`
                  : folder
                    ? `将创建在「${folder}」下`
                    : '将创建在知识库根目录'}
              </p>
            </div>
          </div>
          <button type="button" className="dialog-close" onClick={onClose} title="关闭">
            <X size={17} />
          </button>
        </header>

        <div className="dialog-body">
          <div className="field-grid folder-name-field">
            <label className="full">
              <span>目录名称</span>
              <input
                ref={inputRef}
                type="text"
                value={value}
                maxLength={60}
                spellCheck={false}
                onChange={(event) => setValue(event.target.value)}
                placeholder="例如：工作资料"
              />
              <small>不能包含 \ / : * ? " &lt; &gt; | 等字符；分类只在知识库内生效，不会移动原始文件。</small>
            </label>
          </div>
          {error ? <div className="settings-error">{error}</div> : null}
        </div>

        <footer className="dialog-footer">
          <span className="footer-note">目录可以嵌套，随时可以重命名或删除。</span>
          <div className="footer-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn-primary" disabled={busy || !value.trim()}>
              {busy ? '处理中…' : rename ? '保存' : '创建'}
            </button>
          </div>
        </footer>
      </form>
    </div>
  )
}
