import type { AppSettings } from '../../shared/types'

/** OpenAI 兼容的对话消息结构 */
export interface ChatTurn {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface EmbedProgress {
  done: number
  total: number
}

/** 百炼 text-embedding-v4 单次最多 10 条文本 */
export const DASHSCOPE_BATCH_LIMIT = 10

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError'
}

function apiRoot(rawUrl: string): string {
  return (rawUrl || '').trim().replace(/\/+$/, '').replace(/\/(chat\/completions|embeddings)$/i, '')
}

function joinUrl(rawUrl: string, endpoint: string): string {
  const base = (rawUrl || '').trim().replace(/\/+$/, '')
  return base.toLowerCase().endsWith(endpoint.toLowerCase()) ? base : `${base}${endpoint}`
}

function networkError(label: string, url: string, error: unknown): Error {
  if (isAbortError(error)) return error as Error
  if (isTimeoutError(error)) {
    return new Error(`连接${label}超时（${url}），请检查网络或 Base URL`)
  }
  return new Error(
    `无法连接${label}（${url}）。请检查网络、Base URL；代理环境下请将该域名加入直连。`
  )
}

export function deepseekApiKey(settings: AppSettings): string {
  return settings.deepseekApiKey.trim() || (process.env['DEEPSEEK_API_KEY'] ?? '').trim()
}

export function dashscopeApiKey(settings: AppSettings): string {
  return settings.dashscopeApiKey.trim() || (process.env['DASHSCOPE_API_KEY'] ?? '').trim()
}

function requireKey(key: string, label: string, envName: string): string {
  if (!key) {
    throw new Error(`未配置 ${label} API Key，请在设置中填写（或设置环境变量 ${envName}）`)
  }
  return key
}

async function apiError(
  response: Response,
  label: string,
  kind: 'chat' | 'embed' | 'rerank' = 'chat'
): Promise<Error> {
  let detail = ''
  let code = ''
  try {
    const text = await response.text()
    detail = text
    try {
      const data = JSON.parse(text) as {
        error?: { message?: string; code?: string }
        message?: string
        code?: string
      }
      detail = data.error?.message ?? data.message ?? text
      code = data.error?.code ?? data.code ?? ''
    } catch {
      // 保留原始文本
    }
  } catch {
    detail = ''
  }

  const haystack = `${code} ${detail}`.toLowerCase()
  if (
    response.status === 401 ||
    /invalid.?api.?key|invalidapikey|incorrect api key|unauthorized/.test(haystack)
  ) {
    return new Error(`${label} API Key 无效或已过期，请在设置中检查`)
  }
  if (response.status === 402 || /insufficient|balance|余额|欠费/.test(haystack)) {
    return new Error(`${label} 账户余额不足或服务未开通`)
  }
  if (response.status === 429) {
    return new Error(`${label} 请求过于频繁或额度受限（HTTP 429），请稍后再试`)
  }
  if (
    response.status === 400 &&
    /8192|too long|max.*token|input.*length|range of input|context/.test(haystack)
  ) {
    if (kind === 'embed') {
      return new Error('文本超出嵌入模型的单条长度上限，请减小分块大小')
    }
    if (kind === 'rerank') {
      return new Error('用于重排序的片段过长，请减小分块大小或关闭重排序')
    }
    return new Error(`${label} 输入内容超出模型上下文上限，请减少引用片段或上下文字符上限`)
  }
  if (
    response.status === 404 ||
    /model.?not.?found|model.?not.?exist|does not exist/.test(haystack)
  ) {
    return new Error(`${label} 模型不存在或不可用：${detail.slice(0, 200) || code}`)
  }
  return new Error(
    `${label} 返回错误（HTTP ${response.status}）：${detail.slice(0, 300) || code || '未知错误'}`
  )
}

function normalizeVector(vector: number[]): Float32Array {
  const result = new Float32Array(vector.length)
  let norm = 0
  for (let i = 0; i < vector.length; i++) {
    const value = Number.isFinite(vector[i]) ? vector[i] : 0
    result[i] = value
    norm += value * value
  }
  if (norm > 0) {
    const scale = 1 / Math.sqrt(norm)
    for (let i = 0; i < result.length; i++) result[i] *= scale
  }
  return result
}

/** 读取 OpenAI 风格的 SSE 流，按事件回调 data 内容 */
export async function consumeSseData(
  response: Response,
  onData: (data: string) => boolean | void
): Promise<void> {
  if (!response.body) throw new Error('服务返回了空的流式响应')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines: string[] = []
  let stopped = false

  const dispatch = (): boolean => {
    if (!dataLines.length) return false
    const data = dataLines.join('\n')
    dataLines = []
    return onData(data) === false
  }

  const handleLine = (rawLine: string): boolean => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line) return dispatch()
    if (line.startsWith(':')) return false
    if (!line.startsWith('data:')) return false
    dataLines.push(line.slice(5).trimStart())
    return false
  }

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (handleLine(line)) {
          stopped = true
          break
        }
        newline = buffer.indexOf('\n')
      }
      if (stopped) break
    }
    if (!stopped) {
      if (buffer) handleLine(buffer)
      dispatch()
    }
  } finally {
    if (stopped) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** 解析 OpenAI 兼容的 SSE 对话流；思考内容不展示给用户 */
async function consumeOpenAiChat(
  response: Response,
  label: string,
  onDelta: (text: string) => void
): Promise<void> {
  await consumeSseData(response, (data) => {
    if (data.trim() === '[DONE]') return false
    let payload: {
      error?: { message?: string }
      choices?: {
        delta?: { content?: string | null }
        message?: { content?: string | null }
      }[]
    }
    try {
      payload = JSON.parse(data)
    } catch {
      return true
    }
    if (payload.error) {
      throw new Error(`${label} 生成失败：${payload.error.message ?? '未知错误'}`)
    }
    const choice = payload.choices?.[0]
    const piece = choice?.delta?.content ?? choice?.message?.content
    if (typeof piece === 'string' && piece) onDelta(piece)
    return true
  })
}

export async function deepseekProbe(
  settings: AppSettings
): Promise<{ models: string[] }> {
  const key = requireKey(deepseekApiKey(settings), 'DeepSeek', 'DEEPSEEK_API_KEY')
  const url = joinUrl(apiRoot(settings.deepseekBaseUrl), '/models')
  let response: Response
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000)
    })
  } catch (error) {
    throw networkError('DeepSeek', url, error)
  }
  if (!response.ok) throw await apiError(response, 'DeepSeek')
  const data = (await response.json()) as { data?: { id?: string }[] }
  const models = (data.data ?? []).map((item) => item.id ?? '').filter(Boolean)
  return { models }
}

export async function deepseekChatStream(
  settings: AppSettings,
  messages: ChatTurn[],
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const key = requireKey(deepseekApiKey(settings), 'DeepSeek', 'DEEPSEEK_API_KEY')
  const url = joinUrl(apiRoot(settings.deepseekBaseUrl), '/chat/completions')
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: settings.chatModel,
        messages,
        stream: true,
        temperature: settings.temperature,
        // 笔记问答不需要长时间思考，关闭思考模式以降低首字延迟
        thinking: { type: 'disabled' }
      }),
      signal
    })
  } catch (error) {
    throw networkError('DeepSeek', url, error)
  }

  if (!response.ok) throw await apiError(response, 'DeepSeek')

  // 思考内容不展示给用户，只拼接最终回答
  await consumeOpenAiChat(response, 'DeepSeek', onDelta)
}

export async function dashscopeEmbed(
  settings: AppSettings,
  texts: string[],
  onProgress?: (progress: EmbedProgress) => void
): Promise<Float32Array[]> {
  if (!texts.length) return []
  const key = requireKey(dashscopeApiKey(settings), '阿里云百炼', 'DASHSCOPE_API_KEY')
  const url = joinUrl(apiRoot(settings.dashscopeBaseUrl), '/embeddings')
  const dimensions = settings.embedDimensions
  const result: Float32Array[] = []

  for (let start = 0; start < texts.length; start += DASHSCOPE_BATCH_LIMIT) {
    const batch = texts
      .slice(start, start + DASHSCOPE_BATCH_LIMIT)
      .map((text) => text.trim() || ' ')

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify({
          model: settings.embedModel,
          input: batch,
          dimensions,
          encoding_format: 'float'
        }),
        signal: AbortSignal.timeout(120_000)
      })
    } catch (error) {
      throw networkError('阿里云百炼', url, error)
    }
    if (!response.ok) throw await apiError(response, '阿里云百炼', 'embed')

    const data = (await response.json()) as {
      data?: { embedding?: number[]; index?: number }[]
    }
    const items = Array.isArray(data.data) ? [...data.data] : []
    if (items.length !== batch.length) {
      throw new Error(`嵌入结果数量不匹配：期望 ${batch.length} 条，实际 ${items.length} 条`)
    }
    if (items.every((item) => typeof item.index === 'number')) {
      items.sort((a, b) => (a.index as number) - (b.index as number))
    }

    for (const item of items) {
      const vector = item.embedding
      if (!Array.isArray(vector) || !vector.length) {
        throw new Error('阿里云百炼返回了空向量')
      }
      if (vector.length !== dimensions) {
        throw new Error(
          `嵌入维度不匹配：请求 ${dimensions} 维，返回 ${vector.length} 维，请检查嵌入模型与维度设置`
        )
      }
      result.push(normalizeVector(vector))
    }

    onProgress?.({ done: Math.min(texts.length, start + batch.length), total: texts.length })
  }

  return result
}

export async function dashscopeProbe(settings: AppSettings): Promise<void> {
  // 用一次最小请求验证 Key、地址和维度参数，启动时也只产生几 KB 流量
  await dashscopeEmbed(settings, ['连接测试'])
}

export interface RerankResult {
  /** 对应输入 documents 数组中的下标，从 0 开始 */
  index: number
  /** 本次请求内的相对相关性，越高越相关 */
  score: number
}

/** qwen3-rerank 单次最多 500 条候选；单条 query / 文档上限 4000 tokens */
const RERANK_MAX_DOCS = 500
/** 片块可能接近 4000 tokens，重排序只需要语义概要，先按字符保守截断 */
const RERANK_DOC_CHARS = 3000
const RERANK_QUERY_CHARS = 2000

/** 从 embeddings 的 Base URL 还原百炼根地址，兼容共享域名和业务空间专属域名 */
function dashscopeOrigin(rawUrl: string): string {
  return (rawUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(compatible-mode|compatible-api)\/v\d+$/i, '')
    .replace(/\/api\/v\d+$/i, '')
}

function readRerankResults(payload: unknown): RerankResult[] {
  const data = payload as {
    results?: { index?: unknown; relevance_score?: unknown }[]
    output?: { results?: { index?: unknown; relevance_score?: unknown }[] }
  }
  const raw = Array.isArray(data.results) ? data.results : data.output?.results
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => ({
      index: Number(item?.index),
      score: Number(item?.relevance_score)
    }))
    .filter((item) => Number.isInteger(item.index) && Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score)
}

/**
 * 用百炼 qwen3-rerank 重新排序候选片段。
 * 优先走 OpenAI 兼容的 /compatible-api/v1/reranks；共享域名返回 404 时回退原生接口。
 */
export async function dashscopeRerank(
  settings: AppSettings,
  query: string,
  documents: string[],
  signal?: AbortSignal
): Promise<RerankResult[]> {
  const prepared = documents
    .slice(0, RERANK_MAX_DOCS)
    .map((text) => text.trim().slice(0, RERANK_DOC_CHARS) || ' ')
  if (!prepared.length) return []

  const key = requireKey(dashscopeApiKey(settings), '阿里云百炼', 'DASHSCOPE_API_KEY')
  const origin = dashscopeOrigin(settings.dashscopeBaseUrl)
  if (!origin) throw new Error('百炼 Base URL 无效，请检查重排序使用的地址')
  const model = settings.rerankModel.trim() || 'qwen3-rerank'
  const queryText = query.trim().slice(0, RERANK_QUERY_CHARS) || ' '

  const post = async (url: string, body: Record<string, unknown>): Promise<Response> => {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(30_000)
      })
    } catch (error) {
      throw networkError('阿里云百炼重排序', url, error)
    }
  }

  let response = await post(`${origin}/compatible-api/v1/reranks`, {
    model,
    query: queryText,
    documents: prepared,
    top_n: prepared.length,
    return_documents: false
  })

  // 部分域名没有兼容路由，回退到 DashScope 原生重排序接口
  if (response.status === 404 || response.status === 405) {
    response = await post(`${origin}/api/v1/services/rerank/text-rerank/text-rerank`, {
      model,
      input: { query: queryText, documents: prepared },
      parameters: { top_n: prepared.length, return_documents: false }
    })
  }

  if (!response.ok) throw await apiError(response, '阿里云百炼重排序', 'rerank')

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('阿里云百炼重排序返回了无法解析的结果')
  }
  const results = readRerankResults(payload)
  if (!results.length) throw new Error('阿里云百炼重排序没有返回有效结果')
  return results
}

function openaiHeaders(settings: AppSettings): Record<string, string> {
  const key = settings.openaiApiKey.trim()
  // LM Studio 默认不鉴权；兼容云端 API 时按需带上 Bearer
  return key ? { Authorization: `Bearer ${key}` } : {}
}

/** 查询 LM Studio / OpenAI 兼容服务的可用模型 */
export async function openaiProbe(settings: AppSettings): Promise<{ models: string[] }> {
  const url = joinUrl(apiRoot(settings.openaiBaseUrl), '/models')
  let response: Response
  try {
    response = await fetch(url, {
      headers: openaiHeaders(settings),
      signal: AbortSignal.timeout(8000)
    })
  } catch (error) {
    throw networkError('OpenAI 兼容服务', url, error)
  }
  if (!response.ok) throw await apiError(response, 'OpenAI 兼容服务')
  const data = (await response.json()) as {
    data?: { id?: string; name?: string }[]
    models?: { id?: string; name?: string }[]
  }
  const entries = data.data ?? data.models ?? []
  const models = entries.map((item) => item.id ?? item.name ?? '').filter(Boolean)
  return { models }
}

export async function openaiChatStream(
  settings: AppSettings,
  messages: ChatTurn[],
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const url = joinUrl(apiRoot(settings.openaiBaseUrl), '/chat/completions')
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...openaiHeaders(settings)
      },
      body: JSON.stringify({
        model: settings.chatModel,
        messages,
        stream: true,
        temperature: settings.temperature
      }),
      signal
    })
  } catch (error) {
    throw networkError('OpenAI 兼容服务', url, error)
  }

  if (!response.ok) throw await apiError(response, 'OpenAI 兼容服务')
  await consumeOpenAiChat(response, 'OpenAI 兼容服务', onDelta)
}

export async function openaiEmbed(
  settings: AppSettings,
  texts: string[],
  onProgress?: (progress: EmbedProgress) => void
): Promise<Float32Array[]> {
  if (!texts.length) return []
  const url = joinUrl(apiRoot(settings.openaiBaseUrl), '/embeddings')
  const result: Float32Array[] = []
  const batchSize = 10
  let dimension = 0

  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts
      .slice(start, start + batchSize)
      .map((text) => text.trim() || ' ')

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...openaiHeaders(settings)
        },
        // 维度由模型决定，LM Studio / 兼容服务不一定支持 dimensions 参数
        body: JSON.stringify({
          model: settings.embedModel,
          input: batch,
          encoding_format: 'float'
        }),
        signal: AbortSignal.timeout(180_000)
      })
    } catch (error) {
      throw networkError('OpenAI 兼容服务', url, error)
    }
    if (!response.ok) throw await apiError(response, 'OpenAI 兼容服务', 'embed')

    const data = (await response.json()) as {
      data?: { embedding?: number[]; index?: number }[]
    }
    const items = Array.isArray(data.data) ? [...data.data] : []
    if (items.length !== batch.length) {
      throw new Error(`嵌入结果数量不匹配：期望 ${batch.length} 条，实际 ${items.length} 条`)
    }
    if (items.every((item) => typeof item.index === 'number')) {
      items.sort((a, b) => (a.index as number) - (b.index as number))
    }

    for (const item of items) {
      const vector = item.embedding
      if (!Array.isArray(vector) || !vector.length) {
        throw new Error('OpenAI 兼容服务返回了空向量')
      }
      if (!dimension) dimension = vector.length
      if (vector.length !== dimension) {
        throw new Error(
          `嵌入维度不一致：同一模型返回了 ${dimension} 维和 ${vector.length} 维向量`
        )
      }
      result.push(normalizeVector(vector))
    }

    onProgress?.({ done: Math.min(texts.length, start + batch.length), total: texts.length })
  }

  return result
}
