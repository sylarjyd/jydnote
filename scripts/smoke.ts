/**
 * 冒烟测试：不依赖 Electron / Ollama，验证解码、markdown 解析、
 * 表格解析、分块与本地知识库（向量 + BM25 融合）的核心链路。
 *
 * 运行：npm run smoke
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import iconv from 'iconv-lite'
import * as XLSX from 'xlsx'
import { decodeTextBuffer, normalizeWhitespace } from '../src/main/core/decode'
import { tokenize } from '../src/main/core/tokenize'
import { chunkBlocks } from '../src/main/core/chunker'
import { parseMarkdownText, parsePlainText } from '../src/main/core/parsers/text'
import { parseSpreadsheetFile } from '../src/main/core/parsers/spreadsheet'
import { parseDocxFile } from '../src/main/core/parsers/docx'
import { parsePdfFile } from '../src/main/core/parsers/pdf'
import { KnowledgeBase, sourceExists } from '../src/main/core/kb'
import {
  dashscopeEmbed,
  dashscopeRerank,
  deepseekChatStream,
  openaiChatStream,
  openaiEmbed,
  openaiProbe
} from '../src/main/core/cloud'
import { getModelStatus } from '../src/main/core/models'
import {
  NOTE_TITLE_MAX,
  noteFileName,
  noteTitleOfName,
  validateNoteContent,
  validateNoteTitle
} from '../src/shared/notes'
import type { AppSettings, DocMeta } from '../src/shared/types'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0

async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn()
  passed++
  console.log(`✓ ${name}`)
}

/** 生成一个单页、可提取文字的最小 PDF */
function buildPdf(text: string): Buffer {
  const escaped = text.replace(/\\/g, '\\\\').replace(/[()]/g, (match) => `\\${match}`)
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]

  let output = '%PDF-1.4\n'
  const offsets: number[] = []
  bodies.forEach((body, index) => {
    offsets.push(output.length)
    output += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefStart = output.length
  output += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    output += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  output += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return Buffer.from(output, 'latin1')
}

function makeMeta(id: string, name: string): DocMeta {
  return {
    id,
    name,
    ext: 'txt',
    kind: 'text',
    size: 128,
    addedAt: Date.now(),
    status: 'indexing',
    chunkCount: 0,
    embedModel: 'test-embed',
    embedProvider: 'dashscope',
    sourceRel: `docs/${id}/source.txt`
  }
}

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'jyd-smoke-'))

try {
  await run('中文 GB18030 文本可正确解码', () => {
    const source = '离线笔记支持中文检索与引用。\n这是一段用于测试的说明文字。\n'.repeat(12)
    const encoded = iconv.encode(source, 'gb18030')
    assert.equal(normalizeWhitespace(decodeTextBuffer(encoded)), normalizeWhitespace(source))
  })

  await run('UTF-8 BOM 文本可正确解码', () => {
    const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('标题\n正文', 'utf8')])
    assert.equal(decodeTextBuffer(buffer), '标题\n正文')
  })

  await run('中文分词产出单字与二元组，拉丁词保持完整', () => {
    const tokens = tokenize('离线 RAG 笔记 July 2026')
    for (const expected of ['离线', '笔记', 'rag', 'july', '2026']) {
      assert.ok(tokens.includes(expected), `缺少 token: ${expected}`)
    }
    const longRun = tokenize('番茄炒蛋')
    for (const expected of ['番', '番茄', '茄', '茄炒', '蛋']) {
      assert.ok(longRun.includes(expected), `长词缺少 token: ${expected}`)
    }
  })

  await run('笔记标题与正文校验拒绝空值和超长内容', () => {
    assert.equal(validateNoteTitle('  周报  '), '周报')
    assert.equal(validateNoteContent('  正文  '), '  正文  ')
    assert.equal(noteTitleOfName('产品周报.md'), '产品周报')
    assert.equal(noteFileName('产品周报', 'markdown'), '产品周报.md')
    assert.equal(noteFileName('随手记', 'text'), '随手记.txt')

    const throwMessage = (fn: () => unknown): string => {
      try {
        fn()
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      return ''
    }

    assert.ok(throwMessage(() => validateNoteTitle('')).includes('不能为空'))
    assert.ok(throwMessage(() => validateNoteTitle('   ')).includes('不能为空'))
    assert.ok(
      throwMessage(() => validateNoteTitle('长'.repeat(NOTE_TITLE_MAX + 1))).includes('120')
    )
    assert.ok(throwMessage(() => validateNoteTitle('第一行\n第二行')).includes('换行'))
    assert.ok(throwMessage(() => validateNoteContent('   ')).includes('不能为空'))
    assert.ok(throwMessage(() => validateNoteContent(undefined)).includes('不能为空'))
  })

  await run('Markdown 解析保留标题路径，代码块内容不被当作标题', () => {
    const markdown = [
      '# 项目计划',
      '',
      '## 目标',
      '',
      '完成第一版离线检索。',
      '',
      '```ts',
      '# 这不是标题',
      'const a = 1',
      '```',
      '',
      '## 任务',
      '',
      '- 解析 PDF',
      '- 接入 Ollama'
    ].join('\n')

    const parsed = parseMarkdownText(markdown, 'fallback')
    assert.equal(parsed.title, '项目计划')
    const taskBlock = parsed.blocks.find((block) => block.headingPath.includes('任务'))
    assert.ok(taskBlock?.text.includes('解析 PDF'), '缺少任务段落')
    const codeBlock = parsed.blocks.find((block) => block.text.includes('const a = 1'))
    assert.ok(codeBlock, '代码块丢失')
    assert.deepEqual(codeBlock?.headingPath, ['项目计划', '目标'])
  })

  await run('纯文本按段落解析，空内容返回空块', () => {
    const parsed = parsePlainText('第一段内容。\n\n第二段内容。', 'note')
    assert.equal(parsed.title, 'note')
    assert.equal(parsed.blocks.length, 1)
    assert.ok(parsed.blocks[0].text.includes('第二段'))
    assert.equal(parsePlainText('   \n\n  ', 'empty').blocks.length, 0)
  })

  await run('长文本分块不超过上限且编号连续', () => {
    const paragraph = '这是一个用于测试分块的中文段落，包含足够多的文字来触发切分逻辑。'.repeat(30)
    const chunks = chunkBlocks([{ text: paragraph, headingPath: ['测试'] }], {
      docId: 'chunk-doc',
      maxChars: 200,
      overlap: 40
    })
    assert.ok(chunks.length >= 2, '应切出多个块')
    const limit = Math.floor(200 * 1.3)
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= limit, `块超长：${chunk.text.length}`)
      assert.ok(chunk.text.length > 0)
    }
    chunks.forEach((chunk, index) => {
      assert.equal(chunk.index, index)
      assert.equal(chunk.id, `chunk-doc:${index}`)
      assert.equal(chunk.docId, 'chunk-doc')
    })
    const ids = new Set(chunks.map((chunk) => chunk.id))
    assert.equal(ids.size, chunks.length, 'chunk id 不应重复')
  })

  await run('Excel 解析为带表头的表格块，每块重复字段名', async () => {
    const rows: unknown[][] = [['姓名', '部门', '备注']]
    for (let i = 0; i < 30; i++) {
      rows.push([`成员${i + 1}`, i % 2 ? '研发' : '产品', `第 ${i + 1} 条备注`])
    }
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '成员')
    const file = path.join(root, 'members.xlsx')
    XLSX.writeFile(workbook, file)

    const doc = parseSpreadsheetFile(file, 'members')
    assert.ok(doc.blocks.length >= 3, `块数量异常：${doc.blocks.length}`)
    for (const block of doc.blocks) {
      assert.ok(block.text.includes('| 姓名 | 部门 | 备注 |'), '缺少表头')
      assert.equal(block.sheet, '成员')
    }
    assert.ok(doc.blocks[0].text.includes('成员1'))
    assert.ok(doc.blocks[doc.blocks.length - 1].text.includes('成员30'))
  })

  await run('Word 文档转换为带标题结构的文本块', async () => {
    const fixture = path.join(
      PROJECT_ROOT,
      'node_modules',
      'mammoth',
      'test',
      'test-data',
      'single-paragraph.docx'
    )
    const doc = await parseDocxFile(fixture, 'docx')
    assert.ok(doc.blocks.length >= 1, 'docx 未解析出内容')
    assert.ok(doc.blocks.some((block) => block.text.trim().length > 0))
  })

  await run('PDF 按页提取文字并保留页码', async () => {
    const pdfPath = path.join(root, 'sample.pdf')
    await fsp.writeFile(
      pdfPath,
      buildPdf('Hello offline notes. Retrieval augmented generation on device.')
    )
    const doc = await parsePdfFile(pdfPath, 'sample')
    assert.ok(doc.blocks.length >= 1, 'PDF 未解析出内容')
    assert.equal(doc.blocks[0].page, 1)
    assert.ok(doc.blocks[0].text.includes('Hello offline notes'), doc.blocks[0].text)
  })

  await run('知识库保存、向量检索、关键词检索与重载', async () => {
    const kbRoot = path.join(root, 'library')
    const kb = new KnowledgeBase(kbRoot)

    const docA = makeMeta('a', '项目计划')
    const docB = makeMeta('b', '菜谱')
    const blocksA = parsePlainText(
      '项目计划：本月完成离线笔记的检索模块。\n\n风险：显存不足，需要量化模型。',
      '项目计划'
    ).blocks
    const blocksB = parsePlainText(
      '菜谱：番茄炒蛋需要两个鸡蛋和番茄。\n\n步骤：先炒蛋，再放番茄。',
      '菜谱'
    ).blocks

    const chunksA = chunkBlocks(blocksA, { docId: 'a', maxChars: 300, overlap: 40 })
    const chunksB = chunkBlocks(blocksB, { docId: 'b', maxChars: 300, overlap: 40 })
    assert.ok(chunksA.length >= 1 && chunksB.length >= 1)

    const vectorsA = new Float32Array(chunksA.length * 4)
    for (let i = 0; i < chunksA.length; i++) vectorsA.set([1, 0, 0, 0], i * 4)
    const vectorsB = new Float32Array(chunksB.length * 4)
    for (let i = 0; i < chunksB.length; i++) vectorsB.set([0, 1, 0, 0], i * 4)

    await kb.load()
    await kb.saveDoc(docA, chunksA, vectorsA, 4)
    await kb.saveDoc(docB, chunksB, vectorsB, 4)

    const metas = kb.list()
    assert.equal(metas.length, 2)
    assert.ok(metas.every((meta) => meta.status === 'ready'))

    const vectorHits = kb.hybridSearch(
      new Float32Array([0.95, 0.05, 0, 0]),
      '项目计划',
      'test-embed',
      'dashscope',
      5
    )
    assert.ok(vectorHits.length > 0, '向量检索无结果')
    assert.equal(vectorHits[0].chunk.docId, 'a', '最相关结果应来自项目计划')

    const keywordHits = kb.hybridSearch(
      new Float32Array(4),
      '番茄炒蛋',
      'test-embed',
      'dashscope',
      5
    )
    assert.ok(keywordHits.length > 0, '关键词检索无结果')
    assert.equal(keywordHits[0].chunk.docId, 'b', '关键词命中的应是菜谱')

    const wrongModelHits = kb.hybridSearch(
      new Float32Array([1, 0, 0, 0]),
      '完全不存在的词语xyz',
      'other-embed',
      'dashscope',
      5
    )
    assert.ok(
      wrongModelHits.every((hit) => hit.vectorScore === undefined),
      '模型不匹配时不应返回向量结果'
    )

    await fsp.mkdir(path.join(kbRoot, 'docs', 'a'), { recursive: true })
    await fsp.writeFile(path.join(kbRoot, 'docs', 'a', 'source.txt'), 'source', 'utf8')
    assert.equal(sourceExists(kb, docA), true)
    assert.equal(sourceExists(kb, docB), false)
    assert.ok(kb.getContent('a')?.text.includes('检索模块'))

    const reloaded = new KnowledgeBase(kbRoot)
    await reloaded.load()
    assert.equal(reloaded.list().length, 2)
    const reloadedHits = reloaded.hybridSearch(
      new Float32Array([0.9, 0.1, 0, 0]),
      '项目计划',
      'test-embed',
      'dashscope',
      3
    )
    assert.equal(reloadedHits[0]?.chunk.docId, 'a')
    assert.ok(reloaded.getMeta('b')?.chunkCount === chunksB.length)
  })

  await run('目录可创建、重命名、移动文档并在重载后保留', async () => {
    const kbRoot = path.join(root, 'library')
    const kb = new KnowledgeBase(kbRoot)
    await kb.load()

    const work = await kb.createFolder('', '工作')
    const sub = await kb.createFolder(work, '2024')
    assert.equal(kb.listFolders().includes(sub), true)

    let duplicate = ''
    try {
      await kb.createFolder('', '工作')
    } catch (error) {
      duplicate = error instanceof Error ? error.message : String(error)
    }
    assert.ok(duplicate.includes('同名'), '重复目录应被拒绝')

    await kb.moveDocs(['a', 'b'], sub)
    assert.equal(kb.getMeta('a')?.folder, sub)
    assert.equal(kb.getMeta('b')?.folder, sub)

    const renamed = await kb.renameFolder(work, '项目')
    assert.equal(renamed, '项目')
    assert.equal(kb.getMeta('a')?.folder, '项目/2024')

    const reloaded = new KnowledgeBase(kbRoot)
    await reloaded.load()
    assert.equal(reloaded.getMeta('a')?.folder, '项目/2024')
    assert.ok(reloaded.listFolders().includes('项目/2024'))

    // 删除父目录后，文档与子目录上移一级，内容不丢失
    await reloaded.deleteFolder('项目')
    assert.equal(reloaded.getMeta('a')?.folder, '2024')
    assert.equal(reloaded.listFolders().includes('2024'), true)
    assert.equal(reloaded.listFolders().includes('项目'), false)
  })

  await run('删除文档后其内容不再参与检索', async () => {
    const kb = new KnowledgeBase(path.join(root, 'library'))
    await kb.load()
    await kb.removeDoc('b')
    assert.equal(kb.list().length, 1)
    assert.equal(kb.getContent('b'), null)
    const hits = kb.hybridSearch(
      new Float32Array(4),
      '番茄炒蛋',
      'test-embed',
      'dashscope',
      5
    )
    assert.equal(hits.some((hit) => hit.chunk.docId === 'b'), false)
  })

  await run('上次中断的索引状态在加载时恢复为失败待重试', async () => {
    const kb = new KnowledgeBase(path.join(root, 'library'))
    await kb.load()
    const stale = makeMeta('stale', '中断的文档')
    stale.status = 'indexing'
    await kb.upsertMeta(stale)

    const reopened = new KnowledgeBase(path.join(root, 'library'))
    const metas = await reopened.load()
    const restored = metas.find((meta) => meta.id === 'stale')
    assert.equal(restored?.status, 'error')
    assert.ok(restored?.error?.includes('上次索引未完成'))
  })

  await run('DeepSeek 流式回答与百炼向量化客户端可用', async () => {
    const requests: {
      path: string
      authorization: string
      body: Record<string, unknown>
    }[] = []

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body: Record<string, unknown> = {}
        if (raw) {
          try {
            body = JSON.parse(raw) as Record<string, unknown>
          } catch {
            body = {}
          }
        }
        requests.push({
          path: req.url ?? '',
          authorization: String(req.headers.authorization ?? ''),
          body
        })

        if (req.url === '/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }))
          return
        }

        if (req.url === '/chat/completions') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write('data: {"choices":[{"delta":{"reasoning_content":"先想一想"}}]}\n\n')
          res.write('data: {"choices":[{"delta":{"content":"番茄"}}]}\n\n')
          res.write('data: {"choices":[{"delta":{"content":"炒蛋"}}]}\n\n')
          res.end('data: [DONE]\n\n')
          return
        }

        if (req.url === '/embeddings') {
          const input = Array.isArray(body.input)
            ? (body.input as string[])
            : [String(body.input ?? '')]
          const dimensions = Number(body.dimensions ?? 0)
          const data = input.map((_, index) => {
            const embedding = new Array<number>(dimensions).fill(0)
            embedding[index % dimensions] = 1
            return { index, embedding }
          })
          // 故意倒序返回，客户端应按 index 还原顺序
          data.reverse()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data }))
          return
        }

        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'not found' } }))
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('mock server 启动失败')
    const baseUrl = `http://127.0.0.1:${address.port}`

    const settings: AppSettings = {
      theme: 'light',
      chatProvider: 'deepseek',
      chatModel: 'deepseek-flash',
      deepseekApiKey: 'test-deepseek-key',
      deepseekBaseUrl: baseUrl,
      embedProvider: 'dashscope',
      embedModel: 'text-embedding-v4',
      dashscopeApiKey: 'test-dashscope-key',
      dashscopeBaseUrl: baseUrl,
      embedDimensions: 64,
      rerankEnabled: false,
      rerankModel: 'qwen3-rerank',
      openaiBaseUrl: 'http://127.0.0.1:1/v1',
      openaiApiKey: '',
      ollamaUrl: 'http://127.0.0.1:1',
      visionModel: '',
      topK: 8,
      chunkSize: 900,
      chunkOverlap: 120,
      temperature: 0.2,
      maxContextChars: 12000,
      ocrLangs: 'chi_sim+eng'
    }

    try {
      let answer = ''
      await deepseekChatStream(settings, [{ role: 'user', content: '番茄炒蛋怎么做？' }], (delta) => {
        answer += delta
      })
      assert.equal(answer, '番茄炒蛋', '应只拼接 content，不展示 reasoning_content')

      const chat = requests.find((item) => item.path === '/chat/completions')
      assert.ok(chat, '未发出对话请求')
      assert.equal(chat.authorization, 'Bearer test-deepseek-key')
      assert.equal(chat.body.model, 'deepseek-flash')
      assert.equal(chat.body.stream, true)
      assert.deepEqual(chat.body.thinking, { type: 'disabled' })

      const texts = Array.from({ length: 23 }, (_, index) => `第 ${index} 段文本`)
      const vectors = await dashscopeEmbed(settings, texts)
      assert.equal(vectors.length, 23)
      for (const vector of vectors) assert.equal(vector.length, 64)
      assert.ok(Math.abs(vectors[0][0] - 1) < 1e-5)
      assert.ok(Math.abs(vectors[1][1] - 1) < 1e-5)

      const embedRequests = requests.filter((item) => item.path === '/embeddings')
      assert.deepEqual(
        embedRequests.map((item) => (item.body.input as string[]).length),
        [10, 10, 3],
        '应按百炼限制每批最多 10 条'
      )
      assert.equal(embedRequests[0].authorization, 'Bearer test-dashscope-key')
      assert.equal(embedRequests[0].body.model, 'text-embedding-v4')
      assert.equal(embedRequests[0].body.dimensions, 64)

      const status = await getModelStatus(settings)
      assert.equal(status.chatReady, true, status.chatError ?? '对话模型未就绪')
      assert.equal(status.embedReady, true, status.embedError ?? '嵌入模型未就绪')
      assert.ok(status.chatDetail?.includes('deepseek-flash'))
      assert.ok(status.models.includes('deepseek-flash'))
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  await run('LM Studio / OpenAI 兼容服务支持探测、对话与向量化', async () => {
    const requests: {
      path: string
      authorization: string
      body: Record<string, unknown>
    }[] = []

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body: Record<string, unknown> = {}
        if (raw) {
          try {
            body = JSON.parse(raw) as Record<string, unknown>
          } catch {
            body = {}
          }
        }
        requests.push({
          path: req.url ?? '',
          authorization: String(req.headers.authorization ?? ''),
          body
        })

        if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({ data: [{ id: 'qwen3-8b' }, { id: 'text-embedding-bge-m3' }] })
          )
          return
        }

        if (req.url === '/v1/chat/completions') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write('data: {"choices":[{"delta":{"reasoning_content":"思考中"}}]}\n\n')
          res.write('data: {"choices":[{"delta":{"content":"离线"}}]}\n\n')
          res.write('data: {"choices":[{"delta":{"content":"可用"}}]}\n\n')
          res.end('data: [DONE]\n\n')
          return
        }

        if (req.url === '/v1/embeddings') {
          const input = Array.isArray(body.input)
            ? (body.input as string[])
            : [String(body.input ?? '')]
          const data = input.map((_, index) => {
            const embedding = new Array<number>(6).fill(0)
            embedding[index % 6] = 1
            return { index, embedding }
          })
          // 兼容服务可能乱序返回，客户端应按 index 还原顺序
          data.reverse()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data }))
          return
        }

        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'not found' } }))
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('mock server 启动失败')
    const baseUrl = `http://127.0.0.1:${address.port}/v1`

    const settings: AppSettings = {
      theme: 'light',
      chatProvider: 'openai',
      chatModel: 'qwen3-8b',
      deepseekApiKey: '',
      deepseekBaseUrl: 'http://127.0.0.1:1',
      embedProvider: 'openai',
      embedModel: 'text-embedding-bge-m3',
      dashscopeApiKey: '',
      dashscopeBaseUrl: 'http://127.0.0.1:1',
      embedDimensions: 1024,
      rerankEnabled: false,
      rerankModel: 'qwen3-rerank',
      openaiBaseUrl: baseUrl,
      openaiApiKey: 'test-openai-key',
      ollamaUrl: 'http://127.0.0.1:1',
      visionModel: '',
      topK: 8,
      chunkSize: 900,
      chunkOverlap: 120,
      temperature: 0.2,
      maxContextChars: 12000,
      ocrLangs: 'chi_sim+eng'
    }

    try {
      const probe = await openaiProbe(settings)
      assert.deepEqual(probe.models, ['qwen3-8b', 'text-embedding-bge-m3'])

      let answer = ''
      await openaiChatStream(settings, [{ role: 'user', content: '离线可用吗？' }], (delta) => {
        answer += delta
      })
      assert.equal(answer, '离线可用', '应只拼接 content，不展示 reasoning_content')

      const chat = requests.find((item) => item.path === '/v1/chat/completions')
      assert.ok(chat, '未发出兼容对话请求')
      assert.equal(chat.authorization, 'Bearer test-openai-key')
      assert.equal(chat.body.model, 'qwen3-8b')
      assert.equal(chat.body.stream, true)
      assert.equal('thinking' in chat.body, false, '兼容服务不应收到 DeepSeek 专用参数')

      const progress: number[] = []
      const texts = Array.from({ length: 23 }, (_, index) => `第 ${index} 段文本`)
      const vectors = await openaiEmbed(settings, texts, (item) => progress.push(item.done))
      assert.equal(vectors.length, 23)
      for (const vector of vectors) assert.equal(vector.length, 6)
      assert.ok(Math.abs(vectors[0][0] - 1) < 1e-5)
      assert.ok(Math.abs(vectors[1][1] - 1) < 1e-5)
      assert.equal(progress.at(-1), 23)

      const embedRequests = requests.filter((item) => item.path === '/v1/embeddings')
      assert.deepEqual(
        embedRequests.map((item) => (item.body.input as string[]).length),
        [10, 10, 3],
        '兼容服务同样按每批 10 条分批'
      )
      assert.equal(embedRequests[0].authorization, 'Bearer test-openai-key')
      assert.equal(embedRequests[0].body.model, 'text-embedding-bge-m3')
      assert.equal('dimensions' in embedRequests[0].body, false, '维度应由服务返回结果推断')

      const status = await getModelStatus(settings)
      assert.equal(status.chatReady, true, status.chatError ?? '对话模型未就绪')
      assert.equal(status.embedReady, true, status.embedError ?? '嵌入模型未就绪')
      assert.ok(status.chatDetail?.includes('LM Studio / OpenAI 兼容'))
      assert.ok(status.chatModels.includes('qwen3-8b'))
      assert.ok(status.embedModels.includes('text-embedding-bge-m3'))

      // LM Studio 默认不鉴权：留空 Key 时不应发送 Authorization
      const before = requests.length
      await openaiProbe({ ...settings, openaiApiKey: '' })
      const noKeyRequest = requests[before]
      assert.ok(noKeyRequest)
      assert.equal(noKeyRequest.authorization, '')

      const missing = await getModelStatus({
        ...settings,
        chatModel: 'not-loaded',
        embedModel: 'missing-embed'
      })
      assert.equal(missing.chatReady, false)
      assert.equal(missing.embedReady, false)
      assert.ok(missing.chatError?.includes('not-loaded'))
      assert.ok(missing.embedError?.includes('missing-embed'))
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  await run('qwen3-rerank 支持兼容接口并回退原生接口', async () => {
    const requests: {
      path: string
      authorization: string
      body: Record<string, unknown>
    }[] = []
    let nativeOnly = false

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body: Record<string, unknown> = {}
        if (raw) {
          try {
            body = JSON.parse(raw) as Record<string, unknown>
          } catch {
            body = {}
          }
        }
        requests.push({
          path: req.url ?? '',
          authorization: String(req.headers.authorization ?? ''),
          body
        })

        if (req.url === '/compatible-api/v1/reranks') {
          if (nativeOnly) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'not found' } }))
            return
          }
          // 结果按分数倒序返回，但 index 指向原始候选顺序
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              object: 'list',
              results: [
                { index: 2, relevance_score: 0.31 },
                { index: 0, relevance_score: 0.92 }
              ],
              model: 'qwen3-rerank'
            })
          )
          return
        }

        if (req.url === '/api/v1/services/rerank/text-rerank/text-rerank') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              output: {
                results: [
                  { index: 1, relevance_score: 0.75 },
                  { index: 0, relevance_score: 0.4 }
                ]
              },
              request_id: 'mock-rerank'
            })
          )
          return
        }

        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'not found' } }))
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('mock server 启动失败')
    const origin = `http://127.0.0.1:${address.port}`

    const settings: AppSettings = {
      theme: 'light',
      chatProvider: 'deepseek',
      chatModel: 'deepseek-flash',
      deepseekApiKey: '',
      deepseekBaseUrl: 'http://127.0.0.1:1',
      embedProvider: 'dashscope',
      embedModel: 'text-embedding-v4',
      dashscopeApiKey: 'test-dashscope-key',
      dashscopeBaseUrl: `${origin}/compatible-mode/v1`,
      embedDimensions: 64,
      rerankEnabled: true,
      rerankModel: 'qwen3-rerank',
      openaiBaseUrl: 'http://127.0.0.1:1/v1',
      openaiApiKey: '',
      ollamaUrl: 'http://127.0.0.1:1',
      visionModel: '',
      topK: 8,
      chunkSize: 900,
      chunkOverlap: 120,
      temperature: 0.2,
      maxContextChars: 12000,
      ocrLangs: 'chi_sim+eng'
    }

    try {
      const results = await dashscopeRerank(settings, '番茄怎么保存', [
        '番茄冷藏可以保存一周',
        '量子计算简介',
        '番茄酱的做法'
      ])
      assert.deepEqual(
        results.map((item) => item.index),
        [0, 2],
        '应按 relevance_score 从高到低返回'
      )
      assert.equal(results[0].score, 0.92)

      const compatible = requests[0]
      assert.equal(compatible.path, '/compatible-api/v1/reranks')
      assert.equal(compatible.authorization, 'Bearer test-dashscope-key')
      assert.equal(compatible.body.model, 'qwen3-rerank')
      assert.equal(compatible.body.query, '番茄怎么保存')
      assert.deepEqual(compatible.body.documents, [
        '番茄冷藏可以保存一周',
        '量子计算简介',
        '番茄酱的做法'
      ])
      assert.equal(compatible.body.top_n, 3)
      assert.equal(compatible.body.return_documents, false)
      assert.equal('input' in compatible.body, false, '兼容接口使用扁平请求体')

      // 共享域名可能没有兼容路由，客户端应自动回退原生接口
      nativeOnly = true
      const nativeResults = await dashscopeRerank(settings, '番茄怎么保存', ['甲', '乙'])
      assert.deepEqual(
        nativeResults.map((item) => item.index),
        [1, 0]
      )
      const native = requests.at(-1)
      assert.equal(native?.path, '/api/v1/services/rerank/text-rerank/text-rerank')
      const input = native?.body.input as { query: string; documents: string[] } | undefined
      assert.equal(input?.query, '番茄怎么保存')
      assert.deepEqual(input?.documents, ['甲', '乙'])
      assert.equal(
        (native?.body.parameters as { return_documents?: boolean } | undefined)?.return_documents,
        false
      )
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  console.log(`\n全部通过：${passed} 项检查`)
} catch (error) {
  console.error('\n冒烟测试失败：')
  console.error(error)
  process.exitCode = 1
} finally {
  await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined)
  // 避免 tsx 因为残留句柄挂着
  if (process.exitCode) process.exit(process.exitCode)
}
