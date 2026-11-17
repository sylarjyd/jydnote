import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Cpu, Square } from 'lucide-react'
import type { AppSettings, ChatProvider } from '../../../shared/types'
import type { ChatMessage } from '../types'
import ChatMessageView from './ChatMessageView'
import EmptyChat from './EmptyChat'

const CHAT_PROVIDER_LABEL: Record<ChatProvider, string> = {
  deepseek: 'DeepSeek',
  openai: 'LM Studio / API',
  ollama: 'Ollama'
}

interface Props {
  messages: ChatMessage[]
  busyId: string | null
  settings: AppSettings | null
  docsCount: number
  modelReady: boolean
  onSend: (question: string) => void
  onStop: () => void
  onOpenDoc: (docId: string) => void
  onOpenSettings: () => void
  onImport: () => void
}

export default function ChatPanel({
  messages,
  busyId,
  settings,
  docsCount,
  modelReady,
  onSend,
  onStop,
  onOpenDoc,
  onOpenSettings,
  onImport
}: Props) {
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }, [messages])

  const submit = (): void => {
    const question = input.trim()
    if (!question || busyId) return
    setInput('')
    onSend(question)
  }

  return (
    <section className="chat-panel">
      <header className="chat-header">
        <div>
          <h1>知识库问答</h1>
          <p>基于本地笔记检索并回答，引用可回溯原文</p>
        </div>
        <div
          className="model-chip"
          title={
            settings
              ? `当前对话模型：${CHAT_PROVIDER_LABEL[settings.chatProvider]} · ${settings.chatModel}`
              : '当前对话模型'
          }
        >
          <Cpu size={13} />
          <span>{settings?.chatModel ?? '未配置模型'}</span>
        </div>
      </header>

      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <EmptyChat
            docsCount={docsCount}
            modelReady={modelReady}
            onImport={onImport}
            onOpenSettings={onOpenSettings}
            onSuggest={(question) => onSend(question)}
          />
        ) : (
          <div className="message-list">
            {messages.map((message) => (
              <ChatMessageView
                key={message.id}
                message={message}
                onOpenDoc={onOpenDoc}
                onOpenSettings={onOpenSettings}
              />
            ))}
          </div>
        )}
      </div>

      <div className="composer-wrap">
        <div className="composer">
          <textarea
            value={input}
            rows={Math.min(5, Math.max(1, input.split('\n').length))}
            placeholder={
              docsCount === 0
                ? '先导入笔记，再开始提问…'
                : '基于我的笔记，问点什么…（Enter 发送）'
            }
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submit()
              }
            }}
          />
          {busyId ? (
            <button type="button" className="send-button stop" onClick={onStop} title="停止生成">
              <Square size={15} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              className="send-button"
              onClick={submit}
              disabled={!input.trim() || docsCount === 0}
              title="发送"
            >
              <ArrowUp size={18} />
            </button>
          )}
        </div>
        <div className="composer-hint">
          <span>Enter 发送 · Shift + Enter 换行</span>
          <span>回答仅依据本地笔记，请核对引用原文</span>
        </div>
      </div>
    </section>
  )
}
