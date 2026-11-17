import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserWindow, dialog, shell } from 'electron'
import type {
  AppSettings,
  DocContent,
  DocMeta,
  DocPreview,
  ImportProgress,
  ImportResult,
  ModelStatus
} from '../../shared/types'
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

  async importPaths(rawPaths: string[]): Promise<ImportResult> {
    const job = this.queue.then(() => this.runImport(rawPaths))
    this.queue = job.catch(() => undefined)
    return job
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

  async removeDoc(docId: string): Promise<void> {
    await this.init()
    await this.kb.removeDoc(docId)
    emitLibraryChanged()
  }

  async reindexDoc(docId: string): Promise<void> {
    const job = this.queue.then(async () => {
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
    this.queue = job.catch(() => undefined)
    return job
  }

  async reindexAll(): Promise<void> {
    const job = this.queue.then(async () => {
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
    this.queue = job.catch(() => undefined)
    return job
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
      meta.status = 'error'
      meta.error = message
      meta.chunkCount = 0
      try {
        await this.kb.upsertMeta(meta)
      } catch {
        // 忽略索引写入失败，尽量把错误状态留在内存里
      }
      emitProgress({ docId: id, name: meta.name, phase: 'error', message })
      emitLibraryChanged()
      return false
    }
  }
}
