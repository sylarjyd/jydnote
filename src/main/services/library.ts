import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserWindow, dialog, shell } from 'electron'
import type {
  AppSettings,
  CreateNoteInput,
  DocContent,
  DocMeta,
  DocPreview,
  ImportProgress,
  ImportResult,
  ModelStatus,
  UpdateNoteInput
} from '../../shared/types'
import {
  NOTE_FORMAT_EXT,
  isNoteFormat,
  noteFileName,
  validateNoteContent,
  validateNoteTitle
} from '../../shared/notes'
import { KnowledgeBase } from '../core/kb'
import { decodeTextBuffer } from '../core/decode'
import { getDocKind, parseDocument, SUPPORTED_EXTENSIONS } from '../core/parsers'
import { buildDocPreview } from '../core/preview'
import { chunkBlocks } from '../core/chunker'
import { embedTexts, getModelStatus } from '../core/models'
import { dataRoot, ocrCacheDir, sourceUrlFor, tessdataDir } from '../paths'
import { loadSettings, normalizeSettings } from '../settings'

function emitProgress(progress: ImportProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('import:progress', progress)
  }
}

function emitLibraryChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('library:changed')
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function extOf(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase()
}

/** 与 KnowledgeBase 的目录规范化保持一致：去掉空白段、统一用 '/' 分隔 */
function normalizeFolderInput(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/')
}

/** 先写临时文件再覆盖，避免写到一半进程退出留下半截笔记 */
async function writeFileAtomic(target: string, data: string): Promise<void> {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    await fsp.writeFile(temp, data, 'utf8')
    await fsp.rename(temp, target)
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

interface PendingFile {
  file: string
  /** 展示用的目录层级，形如「笔记/工作」，根层文件没有该字段 */
  folder?: string
}

async function collectFiles(
  dir: string,
  folder: string,
  out: PendingFile[],
  depth = 0
): Promise<void> {
  if (depth > 8) return
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await collectFiles(full, `${folder}/${entry.name}`, out, depth + 1)
    else if (entry.isFile()) out.push({ file: full, folder })
    if (out.length > 5000) return
  }
}

/** 所选文件夹的名称，作为知识库树的一级目录；盘符根目录回退为「D:」这类名字 */
function folderRootName(dir: string): string {
  return path.basename(dir) || dir.replace(/[\\/:]+$/, '')
}

export class LibraryService {
  readonly kb: KnowledgeBase
  private initialized = false
  private initPromise: Promise<void> | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor() {
    this.kb = new KnowledgeBase(dataRoot())
  }

  async init(): Promise<void> {
    if (this.initialized) return
    this.initPromise ??= this.kb.load().then(
      () => {
        this.initialized = true
      },
      (error) => {
        this.initPromise = null
        throw error
      }
    )
    await this.initPromise
  }

  async list(): Promise<DocMeta[]> {
    await this.init()
    return this.kb.list()
  }

  async listFolders(): Promise<string[]> {
    await this.init()
    return this.kb.listFolders()
  }

  async createFolder(parent: string, name: string): Promise<string[]> {
    await this.init()
    const folder = await this.kb.createFolder(parent, name)
    emitLibraryChanged()
    return this.kb.listFolders()
  }

  async renameFolder(folder: string, name: string): Promise<string[]> {
    await this.init()
    await this.kb.renameFolder(folder, name)
    emitLibraryChanged()
    return this.kb.listFolders()
  }

  async deleteFolder(folder: string): Promise<string[]> {
    await this.init()
    await this.kb.deleteFolder(folder)
    emitLibraryChanged()
    return this.kb.listFolders()
  }

  async moveDocs(docIds: string[], folder: string | null): Promise<void> {
    await this.init()
    await this.kb.moveDocs(docIds, folder)
    emitLibraryChanged()
  }

  async getContent(docId: string): Promise<DocContent> {
    await this.init()
    const content = this.kb.getContent(docId)
    if (!content) throw new Error('文档不存在')

    const preview = await this.buildPreview(content.meta)

    // TXT / Markdown 优先读库内原文：按片段拼接会带出重叠内容与〔标题〕标记，适合检索不适合阅读
    const source = await this.readSourceText(content.meta)
    if (source !== null) return { ...content, text: source }

    // 其他格式优先展示富预览；没有预览时回退到切块文本，索引失败的文档仍尽量读 doc.json
    if (content.text.trim() || content.meta.status !== 'error') return { ...content, preview }
    const chunks = await this.readChunkText(content.meta)
    return chunks === null ? { ...content, preview } : { ...content, text: chunks, preview }
  }

  /** 富预览只影响阅读体验，失败时静默回退到切块文本 */
  private async buildPreview(meta: DocMeta): Promise<DocPreview | undefined> {
    if (meta.status !== 'ready' && meta.status !== 'error') return undefined
    if (!meta.sourceRel) return undefined
    const filePath = path.join(this.kb.rootPath, meta.sourceRel)
    if (!fs.existsSync(filePath)) return undefined
    try {
      return (await buildDocPreview(meta.kind, filePath, sourceUrlFor(meta.sourceRel))) ?? undefined
    } catch (error) {
      console.warn(`[preview] ${meta.name} 预览失败：${messageOf(error)}`)
      return undefined
    }
  }

  private async readSourceText(meta: DocMeta): Promise<string | null> {
    if (meta.kind !== 'text' && meta.kind !== 'markdown') return null
    if (!meta.sourceRel) return null
    try {
      return decodeTextBuffer(await fsp.readFile(path.join(this.kb.rootPath, meta.sourceRel)))
        .replace(/\r\n?/g, '\n')
        .trim()
    } catch {
      return null
    }
  }

  private async readChunkText(meta: DocMeta): Promise<string | null> {
    try {
      const raw = await fsp.readFile(path.join(this.kb.docDir(meta.id), 'doc.json'), 'utf8')
      const parsed = JSON.parse(raw) as { chunks?: { text?: string }[] }
      const text = (Array.isArray(parsed.chunks) ? parsed.chunks : [])
        .map((chunk) => chunk.text ?? '')
        .filter(Boolean)
        .join('\n\n')
      return text.trim() ? text : null
    } catch {
      return null
    }
  }

  /** 串行执行导入、重建与笔记写入，避免同一个文档被并发改写 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const job = this.queue.then(task)
    this.queue = job.catch(() => undefined)
    return job
  }

  async importPaths(rawPaths: string[]): Promise<ImportResult> {
    return this.enqueue(() => this.runImport(rawPaths))
  }

  async pickAndImport(): Promise<ImportResult | null> {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = {
      title: '选择要导入的笔记',
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
      filters: [
        { name: '笔记文档', extensions: [...SUPPORTED_EXTENSIONS] },
        { name: '所有文件', extensions: ['*'] }
      ]
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths.length) return null
    return this.importPaths(result.filePaths)
  }

  async pickFolder(): Promise<ImportResult | null> {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: '选择笔记文件夹',
          properties: ['openDirectory']
        })
      : await dialog.showOpenDialog({ title: '选择笔记文件夹', properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths.length) return null
    return this.importPaths(result.filePaths)
  }

  /** 删除也要排队：后台索引完成后会检查文档是否还存在，这里同样避免交错写入 */
  async removeDoc(docId: string): Promise<void> {
    await this.enqueue(async () => {
      await this.init()
      await this.kb.removeDoc(docId)
      emitLibraryChanged()
    })
  }

  async reindexDoc(docId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.init()
      const meta = this.kb.getMeta(docId)
      if (!meta) return
      const source = path.join(this.kb.rootPath, meta.sourceRel)
      if (!meta.sourceRel || !fs.existsSync(source)) {
        await this.kb.upsertMeta({
          ...meta,
          status: 'error',
          error: '源文件缺失，无法重建索引'
        })
        emitLibraryChanged()
        return
      }
      await this.importOne(source, meta)
      emitLibraryChanged()
    })
  }

  async reindexAll(): Promise<void> {
    return this.enqueue(async () => {
      await this.init()
      for (const meta of this.kb.list()) {
        if (meta.status === 'indexing') continue
        const source = path.join(this.kb.rootPath, meta.sourceRel)
        if (!meta.sourceRel || !fs.existsSync(source)) {
          await this.kb.upsertMeta({
            ...meta,
            status: 'error',
            error: '源文件缺失，无法重建索引'
          })
          emitLibraryChanged()
          continue
        }
        await this.importOne(source, meta)
      }
      emitLibraryChanged()
    })
  }

  /** 在知识库内新建笔记：写源文件后立即返回，索引交给后台队列 */
  async createNote(input: CreateNoteInput): Promise<DocMeta> {
    const title = validateNoteTitle(input?.title)
    const content = validateNoteContent(input?.content)
    if (!isNoteFormat(input?.format)) throw new Error('笔记格式错误')
    const format = input.format
    const folder = normalizeFolderInput(input?.folder)
    await this.init()

    const meta = await this.enqueue(async () => {
      await this.init()
      if (folder && !this.kb.listFolders().includes(folder)) {
        throw new Error('目标目录不存在，请刷新后重试')
      }
      const id = randomUUID()
      const ext = NOTE_FORMAT_EXT[format]
      const draft: DocMeta = {
        id,
        name: noteFileName(title, format),
        ext,
        kind: format === 'markdown' ? 'markdown' : 'text',
        size: 0,
        addedAt: Date.now(),
        status: 'indexing',
        chunkCount: 0,
        sourceRel: `docs/${id}/source.${ext}`,
        folder: folder || undefined,
        preview: content.slice(0, 120).replace(/\s+/g, ' ')
      }
      const written = await this.writeSource(draft, content)
      const saved: DocMeta = { ...draft, size: written.size, sourceRel: written.sourceRel }
      await this.kb.upsertMeta(saved)
      emitLibraryChanged()
      return saved
    })

    void this.enqueue(() => this.indexStoredSource(meta.id))
    return meta
  }

  /** 覆写库内副本并重建索引；绝不改动用户磁盘上的原文件 */
  async updateNote(input: UpdateNoteInput): Promise<DocMeta> {
    const title = validateNoteTitle(input?.title)
    const content = validateNoteContent(input?.content)
    const docId = typeof input?.id === 'string' ? input.id : ''
    if (!docId) throw new Error('文档不存在，可能已被删除')
    await this.init()

    const meta = await this.enqueue(async () => {
      await this.init()
      const current = this.kb.getMeta(docId)
      if (!current) throw new Error('文档不存在，可能已被删除')
      if (current.kind !== 'text' && current.kind !== 'markdown') {
        throw new Error('只有 TXT / Markdown 文档可以编辑')
      }
      if (!current.sourceRel) throw new Error('源文件缺失，无法编辑')
      const ext = current.ext || NOTE_FORMAT_EXT[current.kind === 'markdown' ? 'markdown' : 'text']
      const draft: DocMeta = {
        ...current,
        name: `${title}.${ext}`,
        size: 0,
        status: 'indexing',
        error: undefined,
        chunkCount: 0,
        preview: content.slice(0, 120).replace(/\s+/g, ' ')
      }
      const written = await this.writeSource(draft, content)
      const saved: DocMeta = { ...draft, size: written.size, sourceRel: written.sourceRel }
      await this.kb.upsertMeta(saved)
      emitLibraryChanged()
      return saved
    })

    void this.enqueue(() => this.indexStoredSource(meta.id))
    return meta
  }

  /** 重新索引库内已存在的副本；复用导入流程，路径相同时不会再次复制 */
  private async indexStoredSource(docId: string): Promise<void> {
    await this.init()
    const meta = this.kb.getMeta(docId)
    if (!meta) return
    if (meta.kind !== 'text' && meta.kind !== 'markdown') return
    const source = meta.sourceRel ? path.join(this.kb.rootPath, meta.sourceRel) : ''
    if (!source || !fs.existsSync(source)) {
      await this.kb.upsertMeta({ ...meta, status: 'error', error: '源文件缺失，无法建立索引' })
      emitLibraryChanged()
      return
    }
    await this.importOne(source, meta)
    emitLibraryChanged()
  }

  /** 源文件必须落在知识库根目录内，防止 sourceRel 被篡改成任意路径 */
  private sourcePathOf(meta: DocMeta): string {
    const root = path.resolve(this.kb.rootPath)
    const full = path.resolve(root, meta.sourceRel)
    if (full !== root && !full.startsWith(`${root}${path.sep}`)) {
      throw new Error('源文件路径不在知识库目录内')
    }
    return full
  }

  private async writeSource(
    meta: DocMeta,
    content: string
  ): Promise<{ sourcePath: string; sourceRel: string; size: number }> {
    const sourcePath = this.sourcePathOf(meta)
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true })
    await writeFileAtomic(sourcePath, content)
    const sourceRel = path.relative(this.kb.rootPath, sourcePath).split(path.sep).join('/')
    return { sourcePath, sourceRel, size: Buffer.byteLength(content, 'utf8') }
  }

  async modelStatus(): Promise<ModelStatus> {
    return getModelStatus(loadSettings())
  }

  async testModels(input: AppSettings): Promise<ModelStatus> {
    return getModelStatus(normalizeSettings({ ...loadSettings(), ...input }))
  }

  async openSource(docId: string): Promise<void> {
    await this.init()
    const meta = this.kb.getMeta(docId)
    if (!meta?.sourceRel) throw new Error('源文件不存在')
    const fullPath = path.join(this.kb.rootPath, meta.sourceRel)
    if (!fs.existsSync(fullPath)) throw new Error('源文件已被移动或删除')
    const error = await shell.openPath(fullPath)
    if (error) throw new Error(error)
  }

  private async runImport(rawPaths: string[]): Promise<ImportResult> {
    await this.init()
    const libraryRoot = path.resolve(this.kb.rootPath)
    const files: PendingFile[] = []

    for (const rawPath of rawPaths) {
      if (!rawPath) continue
      const resolved = path.resolve(rawPath)
      // 避免把库里的副本再次导入
      if (resolved === libraryRoot || resolved.startsWith(`${libraryRoot}${path.sep}`)) continue
      try {
        const stat = await fsp.stat(resolved)
        if (stat.isDirectory()) {
          await collectFiles(resolved, folderRootName(resolved), files)
        } else if (stat.isFile()) {
          files.push({ file: resolved })
        }
      } catch {
        // 忽略不存在或无权限的路径
      }
    }

    const unique = new Map<string, PendingFile>()
    for (const item of files) {
      if (getDocKind(extOf(item.file)) === null || unique.has(item.file)) continue
      unique.set(item.file, item)
    }
    // 导入文件夹时把目录结构登记下来，空目录也能在侧边栏保留
    const importedFolders = [...new Set([...unique.values()].map((item) => item.folder))]
      .filter((folder): folder is string => Boolean(folder))
    if (importedFolders.length) await this.kb.addFolders(importedFolders)
    let imported = 0
    let failed = 0
    for (const item of unique.values()) {
      const ok = await this.importOne(item.file, undefined, item.folder)
      if (ok) imported++
      else failed++
    }

    emitLibraryChanged()
    return { imported, failed }
  }

  private async importOne(
    sourcePath: string,
    existing?: DocMeta,
    folder?: string
  ): Promise<boolean> {
    const settings = loadSettings()
    const ext = existing?.ext ?? extOf(sourcePath)
    const kind = existing?.kind ?? getDocKind(ext)
    if (!kind) return false

    const id = existing?.id ?? randomUUID()
    const displayName = existing?.name ?? path.basename(sourcePath)
    const title = displayName.replace(/\.[^.]+$/, '')
    let stat: fs.Stats
    try {
      stat = await fsp.stat(sourcePath)
    } catch (error) {
      emitProgress({
        docId: id,
        name: displayName,
        phase: 'error',
        message: messageOf(error)
      })
      return false
    }

    const meta: DocMeta = existing
      ? { ...existing, status: 'indexing', error: undefined, size: stat.size }
      : {
          id,
          name: displayName,
          ext,
          kind,
          size: stat.size,
          addedAt: Date.now(),
          status: 'indexing',
          chunkCount: 0,
          sourceRel: '',
          folder
        }

    const dir = this.kb.docDir(id)
    const storedName = `source.${ext || 'bin'}`
    const storedPath = path.join(dir, storedName)

    try {
      await fsp.mkdir(dir, { recursive: true })
      if (!existing) {
        emitProgress({ docId: id, name: meta.name, phase: 'copy' })
        await fsp.copyFile(sourcePath, storedPath)
        meta.sourceRel = path.relative(this.kb.rootPath, storedPath).split(path.sep).join('/')
      } else {
        const stored = meta.sourceRel ? path.join(this.kb.rootPath, meta.sourceRel) : storedPath
        if (path.resolve(stored) !== path.resolve(sourcePath)) {
          await fsp.mkdir(path.dirname(stored), { recursive: true })
          await fsp.copyFile(sourcePath, stored)
          meta.sourceRel = path.relative(this.kb.rootPath, stored).split(path.sep).join('/')
        }
        if (!meta.sourceRel) {
          meta.sourceRel = path
            .relative(this.kb.rootPath, storedPath)
            .split(path.sep)
            .join('/')
        }
      }

      await this.kb.upsertMeta(meta)
      emitLibraryChanged()

      emitProgress({ docId: id, name: meta.name, phase: 'parse' })
      const parseSource = path.join(this.kb.rootPath, meta.sourceRel)
      const parsed = await parseDocument({
        filePath: parseSource,
        fileName: meta.name,
        title,
        kind,
        visionModel: settings.visionModel,
        ollamaUrl: settings.ollamaUrl,
        ocrLangs: settings.ocrLangs,
        tessdataDir: tessdataDir(),
        ocrCacheDir: ocrCacheDir()
      })

      emitProgress({ docId: id, name: meta.name, phase: 'chunk' })
      const chunks = chunkBlocks(parsed.blocks, {
        docId: id,
        maxChars: settings.chunkSize,
        overlap: settings.chunkOverlap
      })
      if (!chunks.length) throw new Error('没有解析出可索引的文字内容')

      const embedInputs = chunks.map((chunk) =>
        [parsed.title, chunk.headingPath.join(' › '), chunk.text]
          .filter(Boolean)
          .join('\n')
      )
      emitProgress({
        docId: id,
        name: meta.name,
        phase: 'embed',
        current: 0,
        total: embedInputs.length
      })
      const vectors = await embedTexts(settings, embedInputs, ({ done, total }) => {
        emitProgress({
          docId: id,
          name: meta.name,
          phase: 'embed',
          current: done,
          total
        })
      })

      const dim = vectors[0]?.length ?? 0
      if (!dim) throw new Error('嵌入模型返回了空向量')
      const flat = new Float32Array(chunks.length * dim)
      vectors.forEach((vector, index) => flat.set(vector, index * dim))

      // 索引期间可能被删除或移动过：删除就放弃提交，移动则沿用最新的目录分类
      const latest = this.kb.getMeta(id)
      if (!latest) return false
      meta.folder = latest.folder
      meta.embedModel = settings.embedModel
      meta.embedProvider = settings.embedProvider
      meta.preview = chunks[0].text.slice(0, 120).replace(/\s+/g, ' ')

      emitProgress({ docId: id, name: meta.name, phase: 'save' })
      await this.kb.saveDoc(meta, chunks, flat, dim)
      emitProgress({ docId: id, name: meta.name, phase: 'done' })
      emitLibraryChanged()
      return true
    } catch (error) {
      const message = messageOf(error)
      // 失败时也只在文档仍存在时写回状态，避免把刚删除的文档重新建出来
      const latest = this.kb.getMeta(id)
      if (latest) {
        meta.folder = latest.folder
        meta.status = 'error'
        meta.error = message
        meta.chunkCount = 0
        try {
          await this.kb.upsertMeta(meta)
        } catch {
          // 忽略索引写入失败，尽量把错误状态留在内存里
        }
      }
      emitProgress({ docId: id, name: meta.name, phase: 'error', message })
      emitLibraryChanged()
      return false
    }
  }
}
