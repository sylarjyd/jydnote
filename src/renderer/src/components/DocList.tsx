import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  AlertTriangle,
  ChevronRight,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Loader2,
  Pencil,
  Presentation,
  RefreshCw,
  Trash2
} from 'lucide-react'
import type { DocKind, DocMeta } from '../../../shared/types'
import { formatDate, kindLabel } from '../lib/format'

interface Props {
  docs: DocMeta[]
  folders: string[]
  selectedIds: Set<string>
  onOpen: (docId: string) => void
  onRemove: (doc: DocMeta) => void
  onRetry: (doc: DocMeta) => void
  onMoveRequest: (doc: DocMeta) => void
  onMoveManyRequest: (docs: DocMeta[]) => void
  onMove: (doc: DocMeta, folder: string | null) => void
  onToggleSelect: (docId: string) => void
  onToggleSelectAll: () => void
  onCreateFolder: (parent: string) => void
  onRenameFolder: (folder: string) => void
  onDeleteFolder: (folder: string) => void
}

interface FolderNode {
  name: string
  path: string
  children: Map<string, FolderNode>
  docs: DocMeta[]
  docCount: number
}

const DRAG_TYPE = 'application/x-jyd-doc'

function countDocs(node: FolderNode): number {
  node.docCount = node.docs.length
  for (const child of node.children.values()) node.docCount += countDocs(child)
  return node.docCount
}

function buildTree(docs: DocMeta[], folders: string[]): FolderNode {
  const root: FolderNode = { name: '', path: '', children: new Map(), docs: [], docCount: 0 }

  const ensure = (segments: string[]): FolderNode => {
    let node = root
    for (const segment of segments) {
      let child = node.children.get(segment)
      if (!child) {
        child = {
          name: segment,
          path: node.path ? `${node.path}/${segment}` : segment,
          children: new Map(),
          docs: [],
          docCount: 0
        }
        node.children.set(segment, child)
      }
      node = child
    }
    return node
  }

  // 先登记手动创建的空目录，再挂载文档
  for (const folder of folders) ensure(folder.split('/').filter(Boolean))
  for (const doc of docs) ensure((doc.folder ?? '').split('/').filter(Boolean)).docs.push(doc)
  countDocs(root)
  return root
}

function sortedFolders(node: FolderNode): FolderNode[] {
  return [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

function DocIcon({ kind }: { kind: DocKind }) {
  const size = 15
  if (kind === 'sheet') return <FileSpreadsheet size={size} />
  if (kind === 'image') return <FileImage size={size} />
  if (kind === 'pdf') return <File size={size} />
  if (kind === 'slides') return <Presentation size={size} />
  return <FileText size={size} />
}

export default function DocList({
  docs,
  folders,
  selectedIds,
  onOpen,
  onRemove,
  onRetry,
  onMoveRequest,
  onMoveManyRequest,
  onMove,
  onToggleSelect,
  onToggleSelectAll,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder
}: Props) {
  // 目录默认折叠，只记住用户主动展开的路径
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [dragDocId, setDragDocId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const tree = useMemo(() => buildTree(docs, folders), [docs, folders])
  const selectedDocs = useMemo(
    () => docs.filter((doc) => selectedIds.has(doc.id)),
    [docs, selectedIds]
  )
  const allSelected = docs.length > 0 && selectedDocs.length === docs.length
  const selectAllRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // 部分选中时显示系统的半选横线
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedDocs.length > 0 && !allSelected
    }
  }, [selectedDocs.length, allSelected])

  const toggleFolder = (folderPath: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(folderPath)) next.delete(folderPath)
      else next.add(folderPath)
      return next
    })
  }

  const finishDrag = (): void => {
    setDragDocId(null)
    setDropTarget(null)
  }

  const moveTo = (docId: string, folder: string | null): void => {
    const doc = docs.find((item) => item.id === docId)
    finishDrag()
    if (doc) onMove(doc, folder)
  }

  const dropOn = (event: DragEvent<HTMLDivElement>, folder: string | null): void => {
    if (!dragDocId) return
    event.preventDefault()
    event.stopPropagation()
    const id = event.dataTransfer.getData(DRAG_TYPE) || dragDocId
    moveTo(id, folder)
  }

  const renderDoc = (doc: DocMeta) => (
    <div
      key={doc.id}
      className={`doc-item ${doc.status} ${selectedIds.has(doc.id) ? 'selected' : ''} ${
        dragDocId === doc.id ? 'dragging' : ''
      }`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, doc.id)
        event.dataTransfer.effectAllowed = 'move'
        setDragDocId(doc.id)
      }}
      onDragEnd={finishDrag}
    >
      <label
        className="doc-select"
        title="选择文档"
        onDragStart={(event) => event.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={selectedIds.has(doc.id)}
          onChange={() => onToggleSelect(doc.id)}
          aria-label={`选择 ${doc.name}`}
        />
      </label>
      <button
        type="button"
        className="doc-main"
        onClick={() => {
          // 索引失败的文档也要能打开：预览可显示错误原因与可识别的原文
          if (doc.status === 'ready' || doc.status === 'error') onOpen(doc.id)
        }}
        title={doc.error ?? doc.name}
      >
        <span className={`doc-icon kind-${doc.kind}`}>
          <DocIcon kind={doc.kind} />
        </span>
        <span className="doc-info">
          <span className="doc-name">{doc.name}</span>
          <span className="doc-meta">
            {doc.status === 'indexing' ? (
              <>
                <Loader2 size={11} className="spin" />
                解析索引中…
              </>
            ) : doc.status === 'error' ? (
              <>
                <AlertTriangle size={11} />
                索引失败
              </>
            ) : (
              <>
                {kindLabel(doc.kind)} · {doc.chunkCount} 个片段 · {formatDate(doc.addedAt)}
              </>
            )}
          </span>
          {doc.status === 'error' && doc.error ? (
            <span className="doc-error">{doc.error}</span>
          ) : null}
        </span>
      </button>
      <div className="doc-actions">
        {doc.status === 'error' ? (
          <button type="button" title="重试索引" onClick={() => onRetry(doc)}>
            <RefreshCw size={14} />
          </button>
        ) : null}
        <button
          type="button"
          className="doc-move"
          title="移动到目录"
          onClick={() => onMoveRequest(doc)}
        >
          <FolderInput size={14} />
        </button>
        <button type="button" title="从知识库移除" onClick={() => onRemove(doc)}>
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )

  const renderFolder = (node: FolderNode) => {
    const open = expanded.has(node.path)
    const empty = !node.children.size && !node.docs.length
    return (
      <div key={node.path} className="doc-folder-group">
        <div
          className={`doc-folder-row ${dropTarget === node.path ? 'drop-target' : ''}`}
          onDragOver={(event) => {
            if (!dragDocId) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            setDropTarget(node.path)
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
            setDropTarget((current) => (current === node.path ? null : current))
          }}
          onDrop={(event) => dropOn(event, node.path)}
        >
          <button
            type="button"
            className="doc-folder"
            onClick={() => toggleFolder(node.path)}
            aria-expanded={open}
            title={node.path}
          >
            <ChevronRight size={13} className={`doc-folder-chevron ${open ? 'open' : ''}`} />
            {open ? <FolderOpen size={14} /> : <Folder size={14} />}
            <span className="doc-folder-name">{node.name}</span>
            <span className="doc-folder-count">{node.docCount}</span>
          </button>
          <div className="doc-folder-actions">
            <button type="button" title="新建子目录" onClick={() => onCreateFolder(node.path)}>
              <FolderPlus size={13} />
            </button>
            <button type="button" title="重命名目录" onClick={() => onRenameFolder(node.path)}>
              <Pencil size={13} />
            </button>
            <button type="button" title="删除目录" onClick={() => onDeleteFolder(node.path)}>
              <Trash2 size={13} />
            </button>
          </div>
        </div>
        {open ? (
          <div className="doc-folder-children">
            {sortedFolders(node).map(renderFolder)}
            {node.docs.map(renderDoc)}
            {empty ? <span className="doc-folder-empty">空目录</span> : null}
          </div>
        ) : null}
      </div>
    )
  }

  if (!docs.length && !folders.length) {
    return (
      <div className="doc-empty">
        <p>知识库还是空的</p>
        <span>导入文件或新建目录后，就能在这里分类整理</span>
      </div>
    )
  }

  return (
    <div className="doc-list" onDragOver={(event) => dragDocId && event.preventDefault()}>
      {docs.length ? (
        <div className="doc-bulk-bar">
          <label className="doc-select-all">
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={allSelected}
              onChange={onToggleSelectAll}
              aria-label="全选文档"
            />
            <span>全选</span>
          </label>
          <span className="doc-bulk-count">
            {selectedDocs.length ? `已选 ${selectedDocs.length} 个` : `共 ${docs.length} 个文档`}
          </span>
          <button
            type="button"
            className="doc-bulk-move"
            disabled={!selectedDocs.length}
            onClick={() => onMoveManyRequest(selectedDocs)}
          >
            <FolderInput size={12} />
            批量移动
          </button>
        </div>
      ) : null}
      {dragDocId ? (
        <div
          className={`doc-drop-root ${dropTarget === '' ? 'drop-target' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            setDropTarget('')
          }}
          onDragLeave={() => setDropTarget((current) => (current === '' ? null : current))}
          onDrop={(event) => dropOn(event, null)}
        >
          <FolderInput size={13} />
          拖到这里移到根目录
        </div>
      ) : null}
      {sortedFolders(tree).map(renderFolder)}
      {tree.docs.map(renderDoc)}
    </div>
  )
}
