import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ChunkMeta, DocMeta, DocContent, EmbedProvider } from '../../shared/types'
import { tokenize } from './tokenize'

export interface SearchHit {
  chunk: ChunkMeta
  score: number
  vectorScore?: number
  keywordScore?: number
}

interface DocEntry {
  meta: DocMeta
  chunks: ChunkMeta[]
  vectors?: Float32Array
  dim: number
}

/** 目录名称里不允许出现的字符，与 Windows 文件名限制保持一致 */
const INVALID_FOLDER_CHARS = /[\\/:*?"<>|\x00-\x1f]/

function normalizeFolderPath(value: string): string {
  return value
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/')
}

function validateFolderName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('目录名称不能为空')
  if (trimmed === '.' || trimmed === '..') throw new Error('目录名称不能是「.」或「..」')
  if (INVALID_FOLDER_CHARS.test(trimmed)) {
    throw new Error('目录名称不能包含 \\ / : * ? " < > | 等字符')
  }
  if (trimmed.length > 60) throw new Error('目录名称不能超过 60 个字符')
  return trimmed
}

function parentOf(folder: string): string {
  const index = folder.lastIndexOf('/')
  return index === -1 ? '' : folder.slice(0, index)
}

/** 把目录路径及其所有上级目录加入集合，返回是否有新增 */
function registerFolder(set: Set<string>, folder: string): boolean {
  let changed = false
  const segments = normalizeFolderPath(folder).split('/').filter(Boolean)
  let current = ''
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment
    if (!set.has(current)) {
      set.add(current)
      changed = true
    }
  }
  return changed
}

/**
 * 纯文件实现的本地知识库：
 * library/
 *   index.json            文档元数据
 *   docs/<id>/source.*    原始文件副本
 *   docs/<id>/doc.json    chunk 元数据
 *   docs/<id>/vectors.bin Float32 向量（已归一化）
 *
 * 向量检索用暴力点积，BM25 用内存倒排索引，二者 RRF 融合。
 * 个人笔记量级（几万 chunk）足够快，且零原生依赖。
 */
export class KnowledgeBase {
  private docs = new Map<string, DocEntry>()
  /** 手动创建与导入时登记的目录路径，允许空目录 */
  private folders = new Set<string>()

  private inverted = new Map<string, Map<string, number>>()
  private chunkIndex = new Map<string, { docId: string; len: number }>()
  private chunkById = new Map<string, ChunkMeta>()
  private chunkTerms = new Map<string, string[]>()
  private totalChunks = 0
  private sumLen = 0
  private avgLen = 1

  constructor(private readonly root: string) {}

  get indexPath(): string {
    return path.join(this.root, 'index.json')
  }

  get rootPath(): string {
    return this.root
  }

  get foldersPath(): string {
    return path.join(this.root, 'folders.json')
  }

  docDir(docId: string): string {
    return path.join(this.root, 'docs', docId)
  }

  async load(): Promise<DocMeta[]> {
    await fsp.mkdir(path.join(this.root, 'docs'), { recursive: true })
    let metas: DocMeta[] = []
    try {
      const raw = await fsp.readFile(this.indexPath, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) metas = parsed as DocMeta[]
    } catch {
      metas = []
    }

    let folders: string[] = []
    try {
      const raw = await fsp.readFile(this.foldersPath, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        folders = parsed.filter((item): item is string => typeof item === 'string')
      }
    } catch {
      folders = []
    }

    this.docs.clear()
    this.folders.clear()
    for (const folder of folders) registerFolder(this.folders, folder)
    let foldersChanged = false
    let recovered = false
    for (const meta of metas) {
      if (!meta?.id) continue
      if (meta.folder && registerFolder(this.folders, meta.folder)) foldersChanged = true
      // 上次进程在索引过程中退出，残留的中间状态无法恢复，标记为失败待重试
      if (meta.status === 'indexing' || meta.status === 'pending') {
        meta.status = 'error'
        meta.error = '上次索引未完成（应用可能被关闭），请重试'
        recovered = true
      }
      const entry: DocEntry = { meta, chunks: [], dim: meta.dim ?? 0 }

      if (meta.status === 'ready') {
        try {
          const dir = this.docDir(meta.id)
          const docData = JSON.parse(await fsp.readFile(path.join(dir, 'doc.json'), 'utf8')) as {
            chunks?: ChunkMeta[]
          }
          const chunks = Array.isArray(docData.chunks) ? docData.chunks : []
          const raw = await fsp.readFile(path.join(dir, 'vectors.bin'))
          const bytes = new Uint8Array(raw)
          if (bytes.byteLength % 4 !== 0) throw new Error('向量文件损坏')
          const dim = meta.dim ?? (chunks.length ? bytes.byteLength / 4 / chunks.length : 0)
          if (!dim || !Number.isInteger(dim)) throw new Error('索引维度异常')
          const flat = new Float32Array(bytes.buffer, 0, bytes.byteLength / 4)
          if (flat.length !== chunks.length * dim) throw new Error('向量数量不匹配')
          entry.chunks = chunks
          entry.vectors = flat
          entry.dim = dim
          entry.meta.dim = dim
        } catch {
          entry.meta.status = 'error'
          entry.meta.error = '索引文件缺失或损坏，请重建索引'
          entry.chunks = []
          entry.vectors = undefined
          entry.dim = 0
        }
      }

      this.docs.set(meta.id, entry)
    }

    if (recovered) await this.saveIndex()
    if (foldersChanged) await this.saveFolders()
    this.rebuildIndex()
    return this.list()
  }

  list(): DocMeta[] {
    return [...this.docs.values()]
      .map((entry) => ({ ...entry.meta }))
      .sort((a, b) => b.addedAt - a.addedAt)
  }

  listFolders(): string[] {
    return [...this.folders].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  }

  /** 批量登记目录（导入时使用），自动补齐上级目录 */
  async addFolders(folders: string[]): Promise<void> {
    let changed = false
    for (const folder of folders) {
      if (registerFolder(this.folders, folder)) changed = true
    }
    if (changed) await this.saveFolders()
  }

  async createFolder(parent: string, name: string): Promise<string> {
    const cleanParent = normalizeFolderPath(parent)
    if (cleanParent && !this.folders.has(cleanParent)) {
      throw new Error('上级目录不存在，请刷新后重试')
    }
    const cleanName = validateFolderName(name)
    const folder = cleanParent ? `${cleanParent}/${cleanName}` : cleanName
    if (this.folders.has(folder)) throw new Error(`已经有同名目录「${cleanName}」`)
    registerFolder(this.folders, folder)
    await this.saveFolders()
    return folder
  }

  async renameFolder(folder: string, name: string): Promise<string> {
    const source = normalizeFolderPath(folder)
    if (!this.folders.has(source)) throw new Error('目录不存在，请刷新后重试')
    const cleanName = validateFolderName(name)
    const parent = parentOf(source)
    const target = parent ? `${parent}/${cleanName}` : cleanName
    if (target === source) return source
    if (this.folders.has(target)) throw new Error(`已经有同名目录「${cleanName}」`)

    const prefix = `${source}/`
    const next = new Set<string>()
    for (const item of this.folders) {
      if (item === source) next.add(target)
      else if (item.startsWith(prefix)) next.add(`${target}/${item.slice(prefix.length)}`)
      else next.add(item)
    }
    this.folders = next
    for (const entry of this.docs.values()) {
      const current = entry.meta.folder
      if (!current) continue
      if (current === source) entry.meta.folder = target
      else if (current.startsWith(prefix)) {
        entry.meta.folder = `${target}/${current.slice(prefix.length)}`
      }
    }

    await this.saveFolders()
    await this.saveIndex()
    return target
  }

  /** 删除目录但保留内容：目录内的文档与子目录都上移到父目录 */
  async deleteFolder(folder: string): Promise<void> {
    const source = normalizeFolderPath(folder)
    if (!this.folders.has(source)) throw new Error('目录不存在，请刷新后重试')
    const parent = parentOf(source)
    const prefix = `${source}/`
    const lift = (item: string): string =>
      parent ? `${parent}/${item.slice(prefix.length)}` : item.slice(prefix.length)

    const next = new Set<string>()
    for (const item of this.folders) {
      if (item === source) continue
      next.add(item.startsWith(prefix) ? lift(item) : item)
    }
    this.folders = next
    for (const entry of this.docs.values()) {
      const current = entry.meta.folder
      if (!current) continue
      if (current === source) entry.meta.folder = parent || undefined
      else if (current.startsWith(prefix)) entry.meta.folder = lift(current)
    }

    await this.saveFolders()
    await this.saveIndex()
  }

  /** 批量移动文档：先整体校验，避免中途失败只移动了一部分 */
  async moveDocs(docIds: string[], folder: string | null): Promise<void> {
    const ids = [...new Set(docIds)]
    if (!ids.length) return
    const target = normalizeFolderPath(folder ?? '')
    if (target && !this.folders.has(target)) throw new Error('目标目录不存在，请刷新后重试')
    for (const docId of ids) {
      if (!this.docs.has(docId)) throw new Error('文档不存在，请刷新后重试')
    }

    let changed = false
    for (const docId of ids) {
      const entry = this.docs.get(docId)!
      if ((entry.meta.folder ?? '') === target) continue
      entry.meta.folder = target || undefined
      changed = true
    }
    if (changed) await this.saveIndex()
  }

  async saveFolders(): Promise<void> {
    await fsp.mkdir(this.root, { recursive: true })
    await fsp.writeFile(this.foldersPath, JSON.stringify(this.listFolders(), null, 2), 'utf8')
  }

  getMeta(docId: string): DocMeta | undefined {
    const meta = this.docs.get(docId)?.meta
    return meta ? { ...meta } : undefined
  }

  getChunk(chunkId: string): ChunkMeta | undefined {
    return this.chunkById.get(chunkId)
  }

  getContent(docId: string): DocContent | null {
    const entry = this.docs.get(docId)
    if (!entry) return null
    const blocks: string[] = []
    let lastLabel = ''
    const pageLabel = entry.meta.kind === 'slides' ? '张幻灯片' : '页'
    for (const chunk of entry.chunks) {
      const label = chunk.sheet
        ? `工作表：${chunk.sheet}`
        : chunk.page
          ? `第 ${chunk.page} ${pageLabel}`
          : chunk.headingPath.length
            ? chunk.headingPath.join(' › ')
            : ''
      if (label && label !== lastLabel) {
        blocks.push(`〔${label}〕`)
        lastLabel = label
      }
      blocks.push(chunk.text)
    }
    return { meta: { ...entry.meta }, text: blocks.join('\n\n') }
  }

  async upsertMeta(meta: DocMeta): Promise<void> {
    const existing = this.docs.get(meta.id)
    if (existing) this.unindexEntry(existing)
    this.docs.set(meta.id, { meta, chunks: [], dim: 0 })
    await this.saveIndex()
  }

  async saveDoc(
    meta: DocMeta,
    chunks: ChunkMeta[],
    vectors: Float32Array,
    dim: number
  ): Promise<void> {
    const dir = this.docDir(meta.id)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'doc.json'), JSON.stringify({ chunks }), 'utf8')
    await fsp.writeFile(
      path.join(dir, 'vectors.bin'),
      Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength)
    )

    const existing = this.docs.get(meta.id)
    if (existing) this.unindexEntry(existing)

    meta.status = 'ready'
    meta.error = undefined
    meta.chunkCount = chunks.length
    meta.dim = dim
    const entry: DocEntry = { meta, chunks, vectors, dim }
    this.docs.set(meta.id, entry)
    this.indexEntry(entry)
    await this.saveIndex()
  }

  async removeDoc(docId: string): Promise<void> {
    const entry = this.docs.get(docId)
    if (entry) this.unindexEntry(entry)
    this.docs.delete(docId)
    await fsp.rm(this.docDir(docId), { recursive: true, force: true })
    await this.saveIndex()
  }

  async saveIndex(): Promise<void> {
    await fsp.mkdir(this.root, { recursive: true })
    const metas = [...this.docs.values()].map((entry) => entry.meta)
    await fsp.writeFile(this.indexPath, JSON.stringify(metas, null, 2), 'utf8')
  }

  hybridSearch(
    queryVector: Float32Array,
    queryText: string,
    embedModel: string,
    embedProvider: EmbedProvider,
    topK: number,
    docIds?: string[],
    /** 返回候选数；重排序需要比最终 topK 更大的池子，默认与 topK 相同 */
    limit = topK
  ): SearchHit[] {
    const allowed = docIds && docIds.length ? new Set(docIds) : undefined
    const wide = Math.max(20, topK * 3)
    const maxResults = Math.max(1, Math.min(limit, wide))
    const vectorHits = this.searchVector(queryVector, embedModel, embedProvider, wide, allowed)
    const keywordHits = this.searchKeyword(queryText, wide, allowed)

    const merged = new Map<string, SearchHit & { rrf: number }>()
    vectorHits.forEach((hit, rank) => {
      merged.set(hit.chunk.id, { ...hit, rrf: 1 / (60 + rank + 1) })
    })
    keywordHits.forEach((hit, rank) => {
      const existing = merged.get(hit.chunk.id)
      if (existing) {
        existing.rrf += 1 / (60 + rank + 1)
        existing.keywordScore = hit.score
        existing.score = existing.rrf
      } else {
        merged.set(hit.chunk.id, { ...hit, rrf: 1 / (60 + rank + 1) })
      }
    })

    const sorted = [...merged.values()].sort((a, b) => b.rrf - a.rrf)
    const perDoc = new Map<string, number>()
    const result: SearchHit[] = []
    for (const item of sorted) {
      const used = perDoc.get(item.chunk.docId) ?? 0
      // 单个文档最多 4 条，避免答案被同一篇笔记淹没
      if (used >= 4) continue
      perDoc.set(item.chunk.docId, used + 1)
      result.push({
        chunk: item.chunk,
        score: item.rrf,
        vectorScore: item.vectorScore,
        keywordScore: item.keywordScore
      })
      if (result.length >= maxResults) break
    }
    return result
  }

  private searchVector(
    query: Float32Array,
    embedModel: string,
    embedProvider: EmbedProvider,
    topK: number,
    allowed?: Set<string>
  ): SearchHit[] {
    const scored: SearchHit[] = []
    for (const [docId, entry] of this.docs) {
      if (entry.meta.status !== 'ready' || !entry.vectors) continue
      if (entry.meta.embedModel !== embedModel) continue
      // 旧索引没有提供方字段，按最初的 Ollama 处理
      if ((entry.meta.embedProvider ?? 'ollama') !== embedProvider) continue
      if (allowed && !allowed.has(docId)) continue
      if (entry.dim !== query.length) continue

      const { chunks, vectors, dim } = entry
      for (let i = 0; i < chunks.length; i++) {
        let score = 0
        const offset = i * dim
        for (let d = 0; d < dim; d++) score += query[d] * vectors[offset + d]
        scored.push({ chunk: chunks[i], score })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK)
  }

  private searchKeyword(queryText: string, topK: number, allowed?: Set<string>): SearchHit[] {
    const queryTokens = tokenize(queryText)
    if (!queryTokens.length || !this.totalChunks) return []

    const queryCounts = new Map<string, number>()
    for (const token of queryTokens) {
      queryCounts.set(token, (queryCounts.get(token) ?? 0) + 1)
    }

    const k1 = 1.2
    const b = 0.75
    const scores = new Map<string, number>()

    for (const [term, queryTf] of queryCounts) {
      const postings = this.inverted.get(term)
      if (!postings) continue
      const df = postings.size
      const idf = Math.log(1 + (this.totalChunks - df + 0.5) / (df + 0.5))

      for (const [chunkId, tf] of postings) {
        const info = this.chunkIndex.get(chunkId)
        if (!info) continue
        if (allowed && !allowed.has(info.docId)) continue
        const dl = info.len || 1
        const score =
          idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / this.avgLen)))
        scores.set(chunkId, (scores.get(chunkId) ?? 0) + score * Math.min(queryTf, 3))
      }
    }

    const hits: SearchHit[] = []
    for (const [chunkId, score] of scores) {
      const chunk = this.chunkById.get(chunkId)
      if (chunk) hits.push({ chunk, score })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, topK)
  }

  private rebuildIndex(): void {
    this.inverted.clear()
    this.chunkIndex.clear()
    this.chunkById.clear()
    this.chunkTerms.clear()
    this.totalChunks = 0
    this.sumLen = 0
    for (const entry of this.docs.values()) this.indexEntry(entry)
    this.recalcAvg()
  }

  private indexEntry(entry: DocEntry): void {
    if (entry.meta.status !== 'ready' || !entry.vectors || !entry.chunks.length) return

    for (const chunk of entry.chunks) {
      const textForIndex = `${entry.meta.name} ${chunk.headingPath.join(' ')} ${chunk.text}`
      const tokens = tokenize(textForIndex)
      const len = Math.max(1, tokens.length)
      this.chunkIndex.set(chunk.id, { docId: chunk.docId, len })
      this.chunkById.set(chunk.id, chunk)

      const counts = new Map<string, number>()
      for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
      for (const [term, tf] of counts) {
        let postings = this.inverted.get(term)
        if (!postings) {
          postings = new Map()
          this.inverted.set(term, postings)
        }
        postings.set(chunk.id, tf)
      }
      this.chunkTerms.set(chunk.id, [...counts.keys()])
      this.totalChunks++
      this.sumLen += len
    }
    this.recalcAvg()
  }

  private unindexEntry(entry: DocEntry): void {
    for (const chunk of entry.chunks) {
      const terms = this.chunkTerms.get(chunk.id)
      if (terms) {
        for (const term of terms) {
          const postings = this.inverted.get(term)
          if (!postings) continue
          postings.delete(chunk.id)
          if (!postings.size) this.inverted.delete(term)
        }
      }
      this.chunkTerms.delete(chunk.id)
      const info = this.chunkIndex.get(chunk.id)
      if (info) {
        this.totalChunks = Math.max(0, this.totalChunks - 1)
        this.sumLen = Math.max(0, this.sumLen - info.len)
      }
      this.chunkIndex.delete(chunk.id)
      this.chunkById.delete(chunk.id)
    }
    this.recalcAvg()
  }

  private recalcAvg(): void {
    this.avgLen = this.totalChunks > 0 ? this.sumLen / this.totalChunks || 1 : 1
  }
}

export function sourceExists(kb: KnowledgeBase, meta: DocMeta): boolean {
  return fs.existsSync(path.join(kb.rootPath, meta.sourceRel))
}
