import { useEffect, useState } from 'react'
import { ExternalLink, FileText, Loader2, RefreshCw, X } from 'lucide-react'
import type { DocContent } from '../../../shared/types'
import { formatBytes, kindLabel } from '../lib/format'
import DocPreviewView from './DocPreview'
import Markdown from './Markdown'
import SegmentedControl from './SegmentedControl'

interface Props {
  docId: string
  onClose: () => void
  onReindex: (docId: string) => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function DocViewer({ docId, onClose, onReindex }: Props) {
  const [content, setContent] = useState<DocContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [markdownMode, setMarkdownMode] = useState<'rendered' | 'raw'>('rendered')

  useEffect(() => {
    let alive = true
    setMarkdownMode('rendered')
    const load = (initial: boolean): void => {
      if (initial) {
        setContent(null)
        setError(null)
      }
      window.jyd
        .getDocContent(docId)
        .then((result) => {
          if (!alive) return
          setContent(result)
          setError(null)
        })
        .catch((caught) => {
          if (alive) setError(messageOf(caught))
        })
    }
    load(true)
    // 重试索引完成后刷新预览，避免弹窗一直停留在旧状态
    const offLibraryChanged = window.jyd.onLibraryChanged(() => load(false))
    return () => {
      alive = false
      offLibraryChanged()
    }
  }, [docId])

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [onClose])

  const openSource = (): void => {
    void window.jyd.openSource(docId).catch((caught) => setError(messageOf(caught)))
  }

  const indexing = content?.meta.status === 'indexing' || content?.meta.status === 'pending'
  const markdown = content?.meta.kind === 'markdown'
  const hasText = Boolean(content?.text.trim())
  const preview = content?.preview ?? null
  const showRenderedMarkdown = Boolean(
    !preview && markdown && hasText && markdownMode === 'rendered'
  )

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="dialog doc-dialog">
        <header className="dialog-header">
          <div className="doc-dialog-title">
            <div className="doc-dialog-icon">
              <FileText size={18} />
            </div>
            <div>
              <h2>{content?.meta.name ?? '文档预览'}</h2>
              <p>
                {content
                  ? `${kindLabel(content.meta.kind)} · ${formatBytes(content.meta.size)} · ${content.meta.chunkCount} 个片段`
                  : '正在读取本地索引…'}
              </p>
            </div>
          </div>
          <div className="doc-dialog-tools">
            {markdown && hasText ? (
              <SegmentedControl<'rendered' | 'raw'>
                value={markdownMode}
                label="Markdown 显示方式"
                options={[
                  { value: 'rendered', label: '预览' },
                  { value: 'raw', label: '原文' }
                ]}
                onChange={setMarkdownMode}
              />
            ) : null}
            <button type="button" className="dialog-close" onClick={onClose} title="关闭">
              <X size={17} />
            </button>
          </div>
        </header>

        <div className="doc-dialog-body">
          {error ? <div className="doc-dialog-error">{error}</div> : null}
          {content?.meta.status === 'error' ? (
            <div className="doc-dialog-error">
              <strong>索引未完成：</strong>
              {content.meta.error ?? '请点击「重试索引」重新解析。'}
            </div>
          ) : null}
          {!error && !content ? (
            <div className="doc-dialog-loading">
              <Loader2 size={20} className="spin" />
              正在读取…
            </div>
          ) : null}
          {indexing ? (
            <div className="doc-dialog-loading">
              <Loader2 size={20} className="spin" />
              正在解析索引…
            </div>
          ) : null}
          {content && !indexing && !preview && !hasText ? (
            <div className="doc-dialog-empty">
              暂时没有可预览的解析内容。请点击「重试索引」重新解析，或「打开原文件」查看。
            </div>
          ) : null}
          {preview ? <DocPreviewView preview={preview} /> : null}
          {showRenderedMarkdown && content ? (
            <div className="doc-markdown">
              <Markdown content={content.text} />
            </div>
          ) : null}
          {hasText && !preview && !showRenderedMarkdown && content ? (
            <pre className="doc-text">{content.text}</pre>
          ) : null}
        </div>

        <footer className="dialog-footer">
          <span className="footer-note">内容来自库内原文或本地解析结果，原文件可由系统程序打开。</span>
          <div className="footer-actions">
            <button type="button" className="btn-ghost" onClick={() => onReindex(docId)}>
              <RefreshCw size={14} />
              {content?.meta.status === 'error' ? '重试索引' : '重建索引'}
            </button>
            <button type="button" className="btn-outline" onClick={openSource}>
              <ExternalLink size={14} />
              打开原文件
            </button>
            <button type="button" className="btn-primary" onClick={onClose}>
              关闭
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
