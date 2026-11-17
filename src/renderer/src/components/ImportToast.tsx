import { AlertTriangle, CheckCircle2, Loader2, X } from 'lucide-react'
import type { ImportPhase, ImportProgress } from '../../../shared/types'

const PHASE_LABEL: Record<ImportPhase, string> = {
  copy: '复制文件',
  parse: '解析文档',
  chunk: '切分内容',
  embed: '生成向量',
  save: '写入索引',
  done: '索引完成',
  error: '导入失败'
}

interface Props {
  progress: ImportProgress | null
  onDismiss: () => void
}

export default function ImportToast({ progress, onDismiss }: Props) {
  if (!progress) return null

  const isError = progress.phase === 'error'
  const isDone = progress.phase === 'done'
  const percent =
    progress.total && progress.total > 0
      ? Math.round(((progress.current ?? 0) / progress.total) * 100)
      : null

  return (
    <div className={`import-toast ${isError ? 'error' : isDone ? 'done' : ''}`}>
      <div className="import-toast-icon">
        {isError ? (
          <AlertTriangle size={17} />
        ) : isDone ? (
          <CheckCircle2 size={17} />
        ) : (
          <Loader2 size={17} className="spin" />
        )}
      </div>
      <div className="import-toast-body">
        <div className="import-toast-head">
          <strong>{progress.name || '导入任务'}</strong>
          <span>{PHASE_LABEL[progress.phase] ?? progress.phase}</span>
        </div>
        {isError ? (
          <p className="import-toast-message">{progress.message}</p>
        ) : (
          <>
            {progress.phase === 'embed' && progress.total ? (
              <div className="progress-line">
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${percent ?? 0}%` }} />
                </div>
                <span>
                  {progress.current ?? 0}/{progress.total}
                </span>
              </div>
            ) : null}
            {isDone ? <p className="import-toast-message">已加入知识库，可以直接提问了。</p> : null}
          </>
        )}
      </div>
      {isError || isDone ? (
        <button type="button" className="import-toast-close" onClick={onDismiss} title="关闭">
          <X size={14} />
        </button>
      ) : null}
    </div>
  )
}
