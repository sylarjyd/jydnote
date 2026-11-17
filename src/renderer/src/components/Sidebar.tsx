import {
  BookOpen,
  FilePlus,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  Settings,
  Upload
} from 'lucide-react'
import type { DocMeta, ModelStatus } from '../../../shared/types'
import DocList from './DocList'
import StatusPill from './StatusPill'

interface Props {
  docs: DocMeta[]
  folders: string[]
  selectedIds: Set<string>
  status: ModelStatus | null
  needsReindex: boolean
  onCreateNote: () => void
  onImportFiles: () => void
  onImportFolder: () => void
  onOpenDoc: (docId: string) => void
  onRemoveDoc: (doc: DocMeta) => void
  onRetryDoc: (doc: DocMeta) => void
  onMoveDocRequest: (doc: DocMeta) => void
  onMoveDocsRequest: (docs: DocMeta[]) => void
  onMoveDoc: (doc: DocMeta, folder: string | null) => void
  onToggleSelect: (docId: string) => void
  onToggleSelectAll: () => void
  onCreateFolder: (parent: string) => void
  onRenameFolder: (folder: string) => void
  onDeleteFolder: (folder: string) => void
  onOpenSettings: () => void
  onRefreshStatus: () => void
  onReindex: () => void
}

export default function Sidebar({
  docs,
  folders,
  selectedIds,
  status,
  needsReindex,
  onCreateNote,
  onImportFiles,
  onImportFolder,
  onOpenDoc,
  onRemoveDoc,
  onRetryDoc,
  onMoveDocRequest,
  onMoveDocsRequest,
  onMoveDoc,
  onToggleSelect,
  onToggleSelectAll,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onOpenSettings,
  onRefreshStatus,
  onReindex
}: Props) {
  const readyCount = docs.filter((doc) => doc.status === 'ready').length

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <BookOpen size={19} />
        </div>
        <div className="brand-text">
          <strong>简阅笔记</strong>
          <span>JYD · PRIVATE RAG</span>
        </div>
      </div>

      <div className="sidebar-actions">
        <button
          type="button"
          className="btn-primary note-create-button"
          onClick={onCreateNote}
          title="在知识库内新建 Markdown 或 TXT 笔记"
        >
          <FilePlus size={15} />
          新建笔记
        </button>
        <button type="button" className="btn-primary" onClick={onImportFiles}>
          <Upload size={15} />
          导入文件
        </button>
        <button
          type="button"
          className="btn-outline"
          onClick={onImportFolder}
          title="递归导入文件夹内所有支持的文件"
        >
          <FolderOpen size={15} />
          导入文件夹
        </button>
      </div>

      {needsReindex ? (
        <div className="reindex-banner">
          <div>
            <strong>嵌入模型已变更</strong>
            <span>旧文档需要重建索引才能参与向量检索</span>
          </div>
          <button type="button" onClick={onReindex}>
            <RefreshCw size={13} />
            重建
          </button>
        </div>
      ) : null}

      <div className="section-title">
        <span>知识库</span>
        <span className="section-tools">
          <span className="section-count">{readyCount}/{docs.length}</span>
          <button
            type="button"
            className="section-add"
            title="新建根目录"
            onClick={() => onCreateFolder('')}
          >
            <FolderPlus size={13} />
          </button>
        </span>
      </div>

      <div className="doc-scroll">
        <DocList
          docs={docs}
          folders={folders}
          selectedIds={selectedIds}
          onOpen={onOpenDoc}
          onRemove={onRemoveDoc}
          onRetry={onRetryDoc}
          onMoveRequest={onMoveDocRequest}
          onMoveManyRequest={onMoveDocsRequest}
          onMove={onMoveDoc}
          onToggleSelect={onToggleSelect}
          onToggleSelectAll={onToggleSelectAll}
          onCreateFolder={onCreateFolder}
          onRenameFolder={onRenameFolder}
          onDeleteFolder={onDeleteFolder}
        />
      </div>

      <div className="sidebar-footer">
        <StatusPill status={status} onRefresh={onRefreshStatus} />
        <button type="button" className="settings-button" onClick={onOpenSettings}>
          <Settings size={15} />
          设置
        </button>
      </div>
    </aside>
  )
}
