export type DocStatus = 'pending' | 'indexing' | 'ready' | 'error'

export type DocKind = 'text' | 'markdown' | 'docx' | 'sheet' | 'pdf' | 'slides' | 'image'

export type ChatProvider = 'deepseek' | 'openai' | 'ollama'
export type EmbedProvider = 'dashscope' | 'openai' | 'ollama'
export type ThemeMode = 'light' | 'dark'

export interface DocMeta {
  id: string
  name: string
  ext: string
  kind: DocKind
  size: number
  addedAt: number
  status: DocStatus
  error?: string
  chunkCount: number
  embedModel?: string
  /** 旧版本索引没有该字段，按本地 Ollama 处理 */
  embedProvider?: EmbedProvider
  dim?: number
  /** 相对 library 根目录的源文件路径 */
  sourceRel: string
  /** 导入时的目录层级（相对所选文件夹，'/' 分隔，不含文件名）；旧索引没有该字段时按根目录展示 */
  folder?: string
  preview?: string
}

export interface ChunkMeta {
  id: string
  docId: string
  index: number
  text: string
  headingPath: string[]
  page?: number
  sheet?: string
  charStart: number
  charEnd: number
}

export interface SourceItem {
  index: number
  chunkId: string
  docId: string
  docName: string
  heading: string
  page?: number
  score: number
}

export interface AppSettings {
  /** 界面主题；与索引和模型配置无关 */
  theme: ThemeMode

  chatProvider: ChatProvider
  chatModel: string
  deepseekApiKey: string
  deepseekBaseUrl: string

  embedProvider: EmbedProvider
  embedModel: string
  dashscopeApiKey: string
  dashscopeBaseUrl: string
  /** text-embedding-v4 支持的维度：2048/1536/1024/768/512/256/128/64 */
  embedDimensions: number

  /** 混合检索后用 qwen3-rerank 重新打分；关闭时不产生额外的百炼请求 */
  rerankEnabled: boolean
  rerankModel: string

  /** LM Studio 或任意 OpenAI 兼容服务；默认指向 LM Studio 本地服务 */
  openaiBaseUrl: string
  /** LM Studio 默认不需要鉴权；连接云端兼容 API 时填写 */
  openaiApiKey: string

  /** 本地模式与图片识别使用的 Ollama 地址 */
  ollamaUrl: string
  /** 留空则图片走本地 OCR；填写如 qwen2.5vl:3b 则优先用视觉模型 */
  visionModel: string

  topK: number
  chunkSize: number
  chunkOverlap: number
  temperature: number
  maxContextChars: number
  ocrLangs: string
}

export const DASHSCOPE_EMBED_DIMENSIONS = [2048, 1536, 1024, 768, 512, 256, 128, 64] as const

/** 切换提供方时的默认模型；OpenAI 兼容服务的模型名由用户从 /models 选择 */
export const DEFAULT_CHAT_MODELS: Record<ChatProvider, string> = {
  deepseek: 'deepseek-flash',
  openai: '',
  ollama: 'qwen3:4b'
}

export const DEFAULT_EMBED_MODELS: Record<EmbedProvider, string> = {
  dashscope: 'text-embedding-v4',
  openai: '',
  ollama: 'bge-m3'
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',

  chatProvider: 'deepseek',
  chatModel: DEFAULT_CHAT_MODELS.deepseek,
  deepseekApiKey: '',
  deepseekBaseUrl: 'https://api.deepseek.com',

  embedProvider: 'dashscope',
  embedModel: DEFAULT_EMBED_MODELS.dashscope,
  dashscopeApiKey: '',
  dashscopeBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  embedDimensions: 1024,

  rerankEnabled: false,
  rerankModel: 'qwen3-rerank',

  openaiBaseUrl: 'http://127.0.0.1:1234/v1',
  openaiApiKey: '',

  ollamaUrl: 'http://127.0.0.1:11434',
  visionModel: '',

  topK: 8,
  chunkSize: 900,
  chunkOverlap: 120,
  temperature: 0.2,
  maxContextChars: 12000,
  ocrLangs: 'chi_sim+eng'
}

export interface ChatRequest {
  requestId: string
  question: string
  docIds?: string[]
}

export type RagStreamEvent =
  | { requestId: string; type: 'sources'; sources: SourceItem[] }
  | { requestId: string; type: 'delta'; text: string }
  | { requestId: string; type: 'done' }
  | { requestId: string; type: 'error'; message: string }

export type ImportPhase =
  | 'copy'
  | 'parse'
  | 'chunk'
  | 'embed'
  | 'save'
  | 'done'
  | 'error'

export interface ImportProgress {
  docId: string
  name: string
  phase: ImportPhase
  current?: number
  total?: number
  message?: string
}

export interface ImportResult {
  imported: number
  failed: number
}

export interface ModelStatus {
  chatReady: boolean
  embedReady: boolean
  /** 就绪时的简短说明，例如 “DeepSeek · deepseek-flash” */
  chatDetail?: string
  embedDetail?: string
  chatError?: string
  embedError?: string
  /** 两侧模型名的并集，用于状态提示 */
  models: string[]
  /** 对话提供方返回的模型列表 */
  chatModels: string[]
  /** 嵌入提供方返回的模型列表 */
  embedModels: string[]
  /** 仅在开启重排序时返回对应状态 */
  rerankReady?: boolean
  rerankDetail?: string
  rerankError?: string
}

export interface SheetPreview {
  name: string
  rows: string[][]
  /** 行列超出预览上限时为 true，仅展示左上角区域 */
  truncated: boolean
}

export interface SlideParagraph {
  text: string
  /** 字号（磅） */
  size: number
  bold: boolean
  /** 大纲层级，0 为最外层 */
  level: number
  align: 'left' | 'center' | 'right'
}

/** 幻灯片上的一个文本框；坐标单位为 EMU，与 DocPreview.width/height 同一坐标系 */
export interface SlideTextBlock {
  x: number
  y: number
  w: number
  h: number
  anchor: 'top' | 'middle' | 'bottom'
  paragraphs: SlideParagraph[]
}

export interface SlidePicture {
  x: number
  y: number
  w: number
  h: number
  /** data URL */
  src: string
}

export interface SlideTable {
  x: number
  y: number
  w: number
  h: number
  rows: string[][]
}

export interface SlidePreview {
  index: number
  background: string
  texts: SlideTextBlock[]
  pictures: SlidePicture[]
  tables: SlideTable[]
}

export type DocPreview =
  | { type: 'markdown'; markdown: string }
  | { type: 'sheets'; sheets: SheetPreview[] }
  | { type: 'pdf'; url: string }
  | { type: 'image'; url: string }
  | { type: 'slides'; width: number; height: number; slides: SlidePreview[] }

export interface DocContent {
  meta: DocMeta
  text: string
  /** 富文本预览数据；TXT / Markdown 由 text 直接展示，不带该字段 */
  preview?: DocPreview
}

/** 应用内可写的笔记格式；仅用于新建，编辑时保持文档原有格式 */
export type NoteFormat = 'markdown' | 'text'

export interface CreateNoteInput {
  title: string
  content: string
  format: NoteFormat
  /** null / 空白表示知识库根目录 */
  folder?: string | null
}

export interface UpdateNoteInput {
  id: string
  title: string
  content: string
}

export interface JydApi {
  listDocs(): Promise<DocMeta[]>
  listFolders(): Promise<string[]>
  createFolder(parent: string, name: string): Promise<string[]>
  renameFolder(path: string, name: string): Promise<string[]>
  deleteFolder(path: string): Promise<string[]>
  moveDocs(ids: string[], folder: string | null): Promise<void>
  importPaths(paths: string[]): Promise<ImportResult>
  pickAndImport(): Promise<ImportResult | null>
  pickFolder(): Promise<ImportResult | null>
  removeDoc(id: string): Promise<void>
  createNote(input: CreateNoteInput): Promise<DocMeta>
  updateNote(input: UpdateNoteInput): Promise<DocMeta>
  getDocContent(id: string): Promise<DocContent>
  reindexAll(): Promise<void>
  reindexDoc(id: string): Promise<void>
  getSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<AppSettings>
  modelStatus(): Promise<ModelStatus>
  testModels(settings: AppSettings): Promise<ModelStatus>
  openSource(id: string): Promise<void>
  ask(req: ChatRequest): Promise<void>
  abort(requestId: string): Promise<void>
  getPathForFile(file: File): string
  onImportProgress(cb: (progress: ImportProgress) => void): () => void
  onStream(cb: (event: RagStreamEvent) => void): () => void
  onLibraryChanged(cb: () => void): () => void
}
