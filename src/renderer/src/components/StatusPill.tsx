import { RefreshCw } from 'lucide-react'
import type { ModelStatus } from '../../../shared/types'

interface Props {
  status: ModelStatus | null
  onRefresh: () => void
}

export default function StatusPill({ status, onRefresh }: Props) {
  let tone: 'good' | 'warn' | 'bad' | 'idle' = 'idle'
  let label = '检查模型服务…'

  if (status) {
    if (status.chatReady && status.embedReady) {
      tone = 'good'
      label = '模型已就绪'
    } else if (status.chatReady || status.embedReady) {
      tone = 'warn'
      label = '部分模型未就绪'
    } else {
      tone = 'bad'
      const errors = `${status.chatError ?? ''} ${status.embedError ?? ''}`
      label = /未配置|API Key/.test(errors) ? '待配置模型' : '模型未就绪'
    }
  }

  const title = status
    ? [
        `对话模型：${status.chatDetail ?? status.chatError ?? '未就绪'}`,
        `嵌入模型：${status.embedDetail ?? status.embedError ?? '未就绪'}`,
        status.rerankReady === undefined
          ? ''
          : `重排序：${status.rerankDetail ?? status.rerankError ?? '未就绪'}`,
        status.models.length ? `可用模型：${status.models.join(', ')}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    : '正在检查模型配置'

  return (
    <button
      type="button"
      className={`status-pill ${tone}`}
      title={title}
      onClick={onRefresh}
    >
      <span className="status-dot" />
      <span className="status-label">{label}</span>
      <RefreshCw size={12} className="status-refresh" />
    </button>
  )
}
