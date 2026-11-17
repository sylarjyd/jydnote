import { ArrowUpRight, FolderOpen, MessagesSquare, Sparkles } from 'lucide-react'

interface Props {
  docsCount: number
  modelReady: boolean
  onImport: () => void
  onOpenSettings: () => void
  onSuggest: (question: string) => void
}

const SUGGESTIONS = [
  '帮我总结一下知识库里最重要的内容',
  '把这些笔记里的待办事项整理成清单',
  '围绕最近导入的资料，给我出一份复习提纲'
]

export default function EmptyChat({
  docsCount,
  modelReady,
  onImport,
  onOpenSettings,
  onSuggest
}: Props) {
  return (
    <div className="empty-chat">
      <div className="empty-glow" />
      <div className="empty-badge">
        <Sparkles size={22} />
      </div>
      <h2>让笔记开口说话</h2>
      <p className="empty-sub">
        文档与索引保存在本机；提问时只把检索到的片段发送给所选模型，回答会标注来源。
      </p>

      <div className="empty-steps">
        <div className={`empty-step ${docsCount > 0 ? 'done' : ''}`}>
          <span className="step-index">1</span>
          <span>导入 TXT / Markdown / Word / Excel / PDF / 图片</span>
        </div>
        <div className={`empty-step ${docsCount > 0 ? 'done' : ''}`}>
          <span className="step-index">2</span>
          <span>后台自动解析、分块并生成本地向量索引</span>
        </div>
        <div className={`empty-step ${modelReady ? 'done' : ''}`}>
          <span className="step-index">3</span>
          <span>配置 DeepSeek 或本地 Ollama 模型，开始带引用的问答</span>
        </div>
      </div>

      {docsCount === 0 ? (
        <button type="button" className="empty-cta" onClick={onImport}>
          <FolderOpen size={16} />
          导入第一份笔记
        </button>
      ) : (
        <div className="suggestions">
          <div className="suggestions-title">
            <MessagesSquare size={14} />
            试着这样问
          </div>
          {SUGGESTIONS.map((question) => (
            <button
              key={question}
              type="button"
              className="suggestion-chip"
              onClick={() => onSuggest(question)}
            >
              <span>{question}</span>
              <ArrowUpRight size={14} />
            </button>
          ))}
        </div>
      )}

      {!modelReady ? (
        <button type="button" className="empty-link" onClick={onOpenSettings}>
          模型还没就绪？去配置 API Key 或本地 Ollama
        </button>
      ) : null}
    </div>
  )
}
