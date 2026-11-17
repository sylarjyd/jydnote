import { AlertCircle, Sparkles } from 'lucide-react'
import type { ChatMessage } from '../types'
import Markdown from './Markdown'
import SourceList from './SourceList'

interface Props {
  message: ChatMessage
  onOpenDoc: (docId: string) => void
  onOpenSettings: () => void
}

export default function ChatMessageView({ message, onOpenDoc, onOpenSettings }: Props) {
  if (message.role === 'user') {
    return (
      <div className="message-row user">
        <div className="bubble user-bubble">{message.content}</div>
      </div>
    )
  }

  const showTyping = message.pending && !message.content

  return (
    <div className="message-row assistant">
      <div className="assistant-avatar">
        <Sparkles size={14} />
      </div>
      <div className="assistant-main">
        <div className="assistant-name">简阅助手</div>
        <div className="bubble assistant-bubble">
          {message.content ? <Markdown content={message.content} /> : null}
          {showTyping ? (
            <span className="typing-dots" aria-label="正在生成">
              <i />
              <i />
              <i />
            </span>
          ) : null}
          {message.pending && message.content ? <span className="stream-cursor" /> : null}
          {message.stopped ? <div className="message-note">已停止生成</div> : null}
          {message.error ? (
            <div className="message-error">
              <AlertCircle size={15} />
              <span>{message.error}</span>
              <button type="button" onClick={onOpenSettings}>
                检查设置
              </button>
            </div>
          ) : null}
        </div>
        {message.sources?.length ? (
          <SourceList sources={message.sources} onOpen={onOpenDoc} />
        ) : null}
      </div>
    </div>
  )
}
