import type { SourceItem } from '../../shared/types'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources?: SourceItem[]
  error?: string
  pending?: boolean
  stopped?: boolean
  requestId?: string
}
