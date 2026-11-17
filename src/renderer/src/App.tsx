import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type {
  AppSettings,
  DocContent,
  DocMeta,
  ImportProgress,
  ModelStatus,
  NoteFormat,
  RagStreamEvent,
  ThemeMode
} from '../../shared/types'
import { noteTitleOfName } from '../../shared/notes'
import { applyTheme } from './lib/theme'
import Sidebar from './components/Sidebar'
import ChatPanel from './components/ChatPanel'
import SettingsDialog from './components/SettingsDialog'
import DocViewer from './components/DocViewer'
import DropOverlay from './components/DropOverlay'
import ImportToast from './components/ImportToast'
import Toast from './components/Toast'
import FolderNameDialog from './components/FolderNameDialog'
import MoveDocDialog from './components/MoveDocDialog'
import NoteEditorDialog, { type NoteDraft } from './components/NoteEditorDialog'
import type { ChatMessage } from './types'

function makeId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function App() {
  const [docs, setDocs] = useState<DocMeta[]>([])
  const [folders, setFolders] = useState<string[]>([])
  const [folderDialog, setFolderDialog] = useState<{
    mode: 'create' | 'rename'
    folder: string
  } | null>(null)
  const [movingDocs, setMovingDocs] = useState<DocMeta[] | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [status, setStatus] = useState<ModelStatus | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [viewerId, setViewerId] = useState<string | null>(null)
  const [noteEditor, setNoteEditor] = useState<
    { mode: 'create'; initial: NoteDraft } | { mode: 'edit'; id: string; initial: NoteDraft } | null
  >(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [themePreview, setThemePreview] = useState<ThemeMode | null>(null)
  const [dragging, setDragging] = useState(false)

  const dragTimer = useRef<number | null>(null)
  const noticeTimer = useRef<number | null>(null)
  const progressTimer = useRef<number | null>(null)

  const showNotice = useCallback((message: string) => {
    setNotice(message)
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4500)
  }, [])

  const refreshDocs = useCallback(async () => {
    try {
      const [nextDocs, nextFolders] = await Promise.all([
        window.jyd.listDocs(),
        window.jyd.listFolders()
      ])
      setDocs(nextDocs)
      setFolders(nextFolders)
      // 文档被删除或重建后，清掉已经不存在的选中项
      setSelectedIds((previous) => {
        const valid = new Set(nextDocs.map((doc) => doc.id))
        const kept = [...previous].filter((id) => valid.has(id))
        return kept.length === previous.size ? previous : new Set(kept)
      })
    } catch {
      // 启动早期读取失败时保持现状
    }
  }, [])

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await window.jyd.modelStatus())
    } catch {
      setStatus(null)
    }
  }, [])

  const handleStream = useCallback((event: RagStreamEvent) => {
    if (event.type === 'sources') {
      setMessages((previous) =>
        previous.map((message) =>
          message.requestId === event.requestId
            ? { ...message, sources: event.sources }
            : message
        )
      )
    } else if (event.type === 'delta') {
      setMessages((previous) =>
        previous.map((message) =>
          message.requestId === event.requestId
            ? { ...message, content: message.content + event.text }
            : message
        )
      )
    } else if (event.type === 'done') {
      setMessages((previous) =>
        previous.map((message) =>
          message.requestId === event.requestId ? { ...message, pending: false } : message
        )
      )
      setBusyId((current) => (current === event.requestId ? null : current))
    } else {
      setMessages((previous) =>
        previous.map((message) =>
          message.requestId === event.requestId
            ? { ...message, pending: false, error: event.message }
            : message
        )
      )
      setBusyId((current) => (current === event.requestId ? null : current))
    }
  }, [])

  useEffect(() => {
    void refreshDocs()
    void refreshStatus()
    void window.jyd
      .getSettings()
      .then(setSettings)
      .catch(() => undefined)

    const offStream = window.jyd.onStream(handleStream)
    const offLibrary = window.jyd.onLibraryChanged(() => {
      void refreshDocs()
    })
    const offProgress = window.jyd.onImportProgress((update) => {
      setProgress(update)
      if (progressTimer.current) window.clearTimeout(progressTimer.current)
      if (update.phase === 'done') {
        progressTimer.current = window.setTimeout(() => {
          setProgress((current) =>
            current && current.docId === update.docId && current.phase === 'done' ? null : current
          )
        }, 2600)
      }
      if (update.phase === 'error') {
        showNotice(`《${update.name}》导入失败：${update.message ?? '未知错误'}`)
      }
    })

    return () => {
      offStream()
      offLibrary()
      offProgress()
      if (dragTimer.current) window.clearTimeout(dragTimer.current)
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
      if (progressTimer.current) window.clearTimeout(progressTimer.current)
    }
  }, [refreshDocs, refreshStatus, handleStream, showNotice])

  // 设置里的主题是唯一持久化来源；弹窗内切换时只做临时预览
  useEffect(() => {
    if (themePreview) {
      applyTheme(themePreview, false)
      return
    }
    if (settings) applyTheme(settings.theme)
  }, [settings, themePreview])

  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    setThemePreview(null)
  }, [])

  const readyCount = useMemo(() => docs.filter((doc) => doc.status === 'ready').length, [docs])

  const needsReindex = useMemo(() => {
    if (!settings) return false
    return docs.some((doc) => {
      if (doc.status !== 'ready' || !doc.embedModel) return false
      const provider = doc.embedProvider ?? 'ollama'
      // 百炼的向量维度是可配置的，dim 不一致时同样无法参与向量检索
      const dimMismatch =
        settings.embedProvider === 'dashscope' && doc.dim !== settings.embedDimensions
      return (
        doc.embedModel !== settings.embedModel ||
        provider !== settings.embedProvider ||
        dimMismatch
      )
    })
  }, [docs, settings])

  const send = useCallback(
    async (question: string) => {
      const trimmed = question.trim()
      if (!trimmed) return
      if (busyId) {
        showNotice('请等待当前回答完成，或先点击停止')
        return
      }
      if (!readyCount) {
        showNotice('请先导入笔记，等索引完成后再提问')
        return
      }

      const requestId = makeId()
      setMessages((previous) => [
        ...previous,
        { id: makeId(), role: 'user', content: trimmed },
        {
          id: requestId,
          role: 'assistant',
          content: '',
          sources: [],
          pending: true,
          requestId
        }
      ])
      setBusyId(requestId)

      try {
        await window.jyd.ask({ requestId, question: trimmed })
      } catch (error) {
        setMessages((previous) =>
          previous.map((message) =>
            message.requestId === requestId
              ? { ...message, pending: false, error: messageOf(error) }
              : message
          )
        )
        setBusyId((current) => (current === requestId ? null : current))
      }
    },
    [busyId, readyCount, showNotice]
  )

  const stop = useCallback(() => {
    if (!busyId) return
    void window.jyd.abort(busyId)
    setMessages((previous) =>
      previous.map((message) =>
        message.requestId === busyId
          ? {
              ...message,
              pending: false,
              stopped: Boolean(message.content),
              content: message.content || '已停止生成。'
            }
          : message
      )
    )
    setBusyId(null)
  }, [busyId])

  const importFiles = useCallback(async () => {
    try {
      const result = await window.jyd.pickAndImport()
      if (!result) return
      showNotice(
        result.failed
          ? `导入完成：成功 ${result.imported} 个，失败 ${result.failed} 个`
          : `已导入 ${result.imported} 个文件，后台正在建立索引`
      )
    } catch (error) {
      showNotice(messageOf(error))
    }
  }, [showNotice])

  const importFolder = useCallback(async () => {
    try {
      const result = await window.jyd.pickFolder()
      if (!result) return
      showNotice(
        result.failed
          ? `导入完成：成功 ${result.imported} 个，失败 ${result.failed} 个`
          : `已导入 ${result.imported} 个文件，后台正在建立索引`
      )
    } catch (error) {
      showNotice(messageOf(error))
    }
  }, [showNotice])

  const importDropped = useCallback(
    async (files: FileList) => {
      const paths = Array.from(files)
        .map((file) => window.jyd.getPathForFile(file))
        .filter(Boolean)
      if (!paths.length) {
        showNotice('没有识别到文件路径，请尝试使用「导入文件」按钮')
        return
      }
      try {
        const result = await window.jyd.importPaths(paths)
        showNotice(
          result.failed
            ? `导入完成：成功 ${result.imported} 个，失败 ${result.failed} 个`
            : `已导入 ${result.imported} 个文件，后台正在建立索引`
        )
      } catch (error) {
        showNotice(messageOf(error))
      }
    },
    [showNotice]
  )

  const removeDoc = useCallback(
    async (doc: DocMeta) => {
      const confirmed = window.confirm(
        `从知识库移除《${doc.name}》？\n库内保存的副本和索引会被删除，原始文件不受影响。`
      )
      if (!confirmed) return
      try {
        await window.jyd.removeDoc(doc.id)
        showNotice('已从知识库移除')
      } catch (error) {
        showNotice(messageOf(error))
      }
    },
    [showNotice]
  )

  const retryDoc = useCallback(
    async (doc: DocMeta) => {
      showNotice(`正在重建《${doc.name}》的索引…`)
      try {
        await window.jyd.reindexDoc(doc.id)
      } catch (error) {
        showNotice(messageOf(error))
      }
    },
    [showNotice]
  )

  const openCreateNote = useCallback(() => {
    setNoteEditor({
      mode: 'create',
      initial: { title: '', content: '', format: 'markdown', folder: null }
    })
  }, [])

  const openEditNote = useCallback((content: DocContent) => {
    const format: NoteFormat = content.meta.kind === 'markdown' ? 'markdown' : 'text'
    setNoteEditor({
      mode: 'edit',
      id: content.meta.id,
      initial: {
        title: noteTitleOfName(content.meta.name),
        content: content.text,
        format,
        folder: content.meta.folder ?? null
      }
    })
  }, [])

  const submitNote = useCallback(
    async (draft: NoteDraft) => {
      if (!noteEditor) return
      if (noteEditor.mode === 'create') {
        const meta = await window.jyd.createNote({
          title: draft.title,
          content: draft.content,
          format: draft.format,
          folder: draft.folder
        })
        setViewerId(meta.id)
        showNotice('笔记已创建，正在建立索引')
      } else {
        await window.jyd.updateNote({
          id: noteEditor.id,
          title: draft.title,
          content: draft.content
        })
        showNotice('已保存，正在重建索引')
      }
    },
    [noteEditor, showNotice]
  )

  const createFolder = useCallback((parent: string) => {
    setFolderDialog({ mode: 'create', folder: parent })
  }, [])

  const renameFolder = useCallback((folder: string) => {
    setFolderDialog({ mode: 'rename', folder })
  }, [])

  const submitFolderName = useCallback(
    async (name: string) => {
      if (!folderDialog) return
      const next =
        folderDialog.mode === 'create'
          ? await window.jyd.createFolder(folderDialog.folder, name)
          : await window.jyd.renameFolder(folderDialog.folder, name)
      setFolders(next)
      showNotice(folderDialog.mode === 'create' ? `已创建目录「${name}」` : '目录已重命名')
    },
    [folderDialog, showNotice]
  )

  const deleteFolder = useCallback(
    async (folder: string) => {
      const confirmed = window.confirm(
        `删除目录「${folder}」？\n目录内的文档和子目录会保留，并移动到上一级目录。`
      )
      if (!confirmed) return
      try {
        setFolders(await window.jyd.deleteFolder(folder))
        showNotice('目录已删除，内容已移到上一级')
      } catch (error) {
        showNotice(messageOf(error))
      }
    },
    [showNotice]
  )

  const moveDocs = useCallback(
    async (targets: DocMeta[], folder: string | null) => {
      const ids = targets.map((doc) => doc.id)
      await window.jyd.moveDocs(ids, folder)
      setSelectedIds((previous) => {
        const next = new Set(previous)
        for (const id of ids) next.delete(id)
        return next
      })
      showNotice(
        folder
          ? `已将 ${ids.length} 个文档移动到「${folder}」`
          : `已将 ${ids.length} 个文档移动到根目录`
      )
    },
    [showNotice]
  )

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((previous) =>
      docs.length > 0 && docs.every((doc) => previous.has(doc.id))
        ? new Set()
        : new Set(docs.map((doc) => doc.id))
    )
  }, [docs])

  const reindexAll = useCallback(async () => {
    const confirmed = window.confirm('重建全部文档索引？文档较多时可能需要几分钟。')
    if (!confirmed) return
    showNotice('正在重建全部索引…')
    try {
      await window.jyd.reindexAll()
      showNotice('索引重建完成')
    } catch (error) {
      showNotice(messageOf(error))
    }
  }, [showNotice])

  const saveSettings = useCallback(
    async (next: AppSettings) => {
      const stamp = (value: AppSettings | null): string =>
        value
          ? `${value.embedProvider}:${value.embedModel}:${value.embedProvider === 'dashscope' ? value.embedDimensions : ''}`
          : ''
      const previousSpace = stamp(settings)
      const saved = await window.jyd.saveSettings(next)
      setThemePreview(null)
      setSettings(saved)
      setSettingsOpen(false)
      void refreshStatus()
      if (previousSpace !== stamp(saved)) {
        showNotice('嵌入模型或向量维度已变更，请在左侧点击「重建」重建索引')
      } else {
        showNotice('设置已保存')
      }
    },
    [settings, refreshStatus, showNotice]
  )

  const handleDragEnter = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    if (dragTimer.current) {
      window.clearTimeout(dragTimer.current)
      dragTimer.current = null
    }
    setDragging(true)
  }

  const handleDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    if (dragTimer.current) window.clearTimeout(dragTimer.current)
    dragTimer.current = window.setTimeout(() => setDragging(false), 150)
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragging(false)
    if (dragTimer.current) {
      window.clearTimeout(dragTimer.current)
      dragTimer.current = null
    }
    if (event.dataTransfer.files.length) void importDropped(event.dataTransfer.files)
  }

  return (
    <div
      className="app-shell"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <Sidebar
        docs={docs}
        folders={folders}
        selectedIds={selectedIds}
        status={status}
        needsReindex={needsReindex}
        onCreateNote={openCreateNote}
        onImportFiles={importFiles}
        onImportFolder={importFolder}
        onOpenDoc={setViewerId}
        onRemoveDoc={(doc) => void removeDoc(doc)}
        onRetryDoc={(doc) => void retryDoc(doc)}
        onMoveDocRequest={(doc) => setMovingDocs([doc])}
        onMoveDocsRequest={setMovingDocs}
        onMoveDoc={(doc, folder) =>
          void moveDocs([doc], folder).catch((error) => showNotice(messageOf(error)))
        }
        onToggleSelect={toggleSelect}
        onToggleSelectAll={toggleSelectAll}
        onCreateFolder={createFolder}
        onRenameFolder={renameFolder}
        onDeleteFolder={(folder) => void deleteFolder(folder)}
        onOpenSettings={() => setSettingsOpen(true)}
        onRefreshStatus={() => void refreshStatus()}
        onReindex={() => void reindexAll()}
      />

      <main className="main-pane">
        <ChatPanel
          messages={messages}
          busyId={busyId}
          settings={settings}
          docsCount={readyCount}
          modelReady={Boolean(status?.chatReady && status.embedReady)}
          onSend={(question) => void send(question)}
          onStop={stop}
          onOpenDoc={setViewerId}
          onOpenSettings={() => setSettingsOpen(true)}
          onImport={() => void importFiles()}
        />
      </main>

      {folderDialog ? (
        <FolderNameDialog
          mode={folderDialog.mode}
          folder={folderDialog.folder}
          onSubmit={submitFolderName}
          onClose={() => setFolderDialog(null)}
        />
      ) : null}

      {movingDocs ? (
        <MoveDocDialog
          docs={movingDocs}
          folders={folders}
          onSubmit={(folder) => moveDocs(movingDocs, folder)}
          onClose={() => setMovingDocs(null)}
        />
      ) : null}

      {settingsOpen && settings ? (
        <SettingsDialog
          initial={settings}
          status={status}
          onClose={closeSettings}
          onSave={saveSettings}
          onThemePreview={setThemePreview}
        />
      ) : null}

      {noteEditor ? (
        <NoteEditorDialog
          mode={noteEditor.mode}
          folders={folders}
          initial={noteEditor.initial}
          onSubmit={submitNote}
          onClose={() => setNoteEditor(null)}
        />
      ) : null}

      {viewerId && !noteEditor ? (
        <DocViewer
          docId={viewerId}
          onClose={() => setViewerId(null)}
          onReindex={(id) => {
            setViewerId(null)
            const doc = docs.find((item) => item.id === id)
            if (doc) void retryDoc(doc)
            else void window.jyd.reindexDoc(id)
          }}
          onEdit={openEditNote}
        />
      ) : null}

      <DropOverlay active={dragging} />
      <ImportToast progress={progress} onDismiss={() => setProgress(null)} />
      <Toast message={notice} onClose={() => setNotice(null)} />
    </div>
  )
}
