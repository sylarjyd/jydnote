import { ChevronRight, Quote } from 'lucide-react'
import type { SourceItem } from '../../../shared/types'

interface Props {
  sources: SourceItem[]
  onOpen: (docId: string) => void
}

export default function SourceList({ sources, onOpen }: Props) {
  if (!sources.length) return null

  return (
    <div className="sources">
      <div className="sources-title">
        <Quote size={13} />
        <span>引用来源 · {sources.length}</span>
      </div>
      <div className="sources-grid">
        {sources.map((source) => {
          const location = [source.heading, source.page ? `第 ${source.page} 页` : '']
            .filter(Boolean)
            .join(' · ')
          return (
            <button
              key={source.chunkId}
              type="button"
              className="source-card"
              onClick={() => onOpen(source.docId)}
              title={location ? `打开原文 · ${location}` : '打开原文'}
            >
              <span className="source-index">[{source.index}]</span>
              <span className="source-title">{source.docName}</span>
              <ChevronRight size={14} className="source-chevron" />
            </button>
          )
        })}
      </div>
    </div>
  )
}
