import type { AppSettings, ChatRequest, SourceItem } from '../../shared/types'
import type { KnowledgeBase, SearchHit } from './kb'
import { chatStream, embedTexts, rerankTexts, type ChatTurn } from './models'

export interface AnswerCallbacks {
  onSources(sources: SourceItem[]): void
  onDelta(text: string): void
  signal?: AbortSignal
}

const SYSTEM_PROMPT = [
  '你是「简阅笔记」的私人知识库助手。用户的问题是围绕其本地笔记提出的，你必须严格依据提供的笔记片段作答。',
  '',
  '规则：',
  '1. 只使用【笔记资料】中的信息，不得引入资料之外的知识，不得编造。',
  '2. 引用资料时在对应句末标注来源编号，例如 [1]、[2][3]，编号必须与资料一致。',
  '3. 如果资料不足以回答问题，直接说明「笔记中没有找到相关内容」，并指出还需要补充哪类资料，不要猜测。',
  '4. 使用简体中文回答；条理清晰，必要的步骤、对比、清单可以用 Markdown 列表或表格。',
  '5. 不要提及「片段」「检索」「上下文」等实现细节，自然地引用即可。'
].join('\n')

export async function answerQuestion(
  kb: KnowledgeBase,
  settings: AppSettings,
  request: ChatRequest,
  callbacks: AnswerCallbacks
): Promise<void> {
  const question = request.question.trim()
  if (!question) throw new Error('请输入问题')

  const readyDocs = kb.list().filter((doc) => doc.status === 'ready')
  if (!readyDocs.length) throw new Error('知识库还是空的，请先在左侧导入笔记文件。')

  const [queryVector] = await embedTexts(settings, [question])
  if (!queryVector) throw new Error('问题向量化失败')

  // 开启重排序时多取一些候选，交给 qwen3-rerank 重新打分后再截断
  const candidateLimit = settings.rerankEnabled
    ? Math.min(50, Math.max(settings.topK * 2, 16))
    : settings.topK
  let hits = kb.hybridSearch(
    queryVector,
    question,
    settings.embedModel,
    settings.embedProvider,
    settings.topK,
    request.docIds,
    candidateLimit
  )

  if (settings.rerankEnabled && hits.length > 1) {
    try {
      const order = await rerankTexts(
        settings,
        question,
        hits.map((hit) => hit.chunk.text),
        callbacks.signal
      )
      const seen = new Set<number>()
      const perDoc = new Map<string, number>()
      const reranked: SearchHit[] = []
      for (const item of order) {
        if (item.index < 0 || item.index >= hits.length || seen.has(item.index)) continue
        seen.add(item.index)
        const hit = hits[item.index]
        // 重排序后仍限制单文档条数，避免答案被同一篇笔记占满
        const used = perDoc.get(hit.chunk.docId) ?? 0
        if (used >= 4) continue
        perDoc.set(hit.chunk.docId, used + 1)
        reranked.push({ ...hit, score: item.score })
      }
      if (reranked.length) hits = reranked
    } catch (error) {
      if (callbacks.signal?.aborted) throw error
      // 重排序只是优化项，失败时退回混合检索顺序，不阻断回答
      console.warn(
        `[rerank] 重排序失败，已退回混合检索：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  if (!hits.length) {
    callbacks.onSources([])
    callbacks.onDelta(
      '没有在这批笔记里检索到相关内容。可以换个问法，或先在左侧导入更多资料再试。'
    )
    return
  }

  const sources: SourceItem[] = []
  const contextParts: string[] = []
  let usedChars = 0

  for (const hit of hits) {
    if (sources.length >= settings.topK) break
    const chunk = hit.chunk
    const doc = kb.getMeta(chunk.docId)
    const docName = doc?.name ?? '未知文档'
    const heading = chunk.headingPath.join(' › ')
    const location = [
      heading,
      chunk.page ? `第 ${chunk.page} 页` : '',
      chunk.sheet ? `工作表「${chunk.sheet}」` : ''
    ]
      .filter(Boolean)
      .join(' · ')
    const body = chunk.text.trim()

    // 至少保留 3 条，之后受上下文字符预算限制
    if (sources.length >= 3 && usedChars + body.length > settings.maxContextChars) break

    const index = sources.length + 1
    sources.push({
      index,
      chunkId: chunk.id,
      docId: chunk.docId,
      docName,
      heading,
      page: chunk.page,
      score: hit.score
    })
    contextParts.push(`[${index}] 来源：《${docName}》${location ? ` ${location}` : ''}\n${body}`)
    usedChars += body.length
  }

  callbacks.onSources(sources)

  const userPrompt = [
    '【问题】',
    question,
    '',
    '【笔记资料】',
    contextParts.join('\n\n---\n\n'),
    '',
    '请依据以上资料作答，并在引用处标注 [编号]。'
  ].join('\n')

  const messages: ChatTurn[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt }
  ]

  await chatStream(settings, messages, callbacks.onDelta, callbacks.signal)
}
