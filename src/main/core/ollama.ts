import type { AppSettings } from '../../shared/types'
import type { ChatTurn } from './cloud'

export type OllamaMessage = ChatTurn

function baseUrl(url: string): string {
  return (url || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '')
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (typeof error === 'object' && error !== null && 'name' in error && (error as { name?: string }).name === 'AbortError')
  )
}

function connectionError(url: string, error: unknown): Error {
  if (isAbortError(error)) return error as Error
  return new Error(
    `无法连接本地 Ollama（${url}）。请先在终端运行 ollama serve，并确认设置里的地址端口正确。`
  )
}

export function hasOllamaModel(models: string[], target: string): boolean {
  const name = target.trim()
  if (!name) return false
  return models.includes(name) || models.includes(`${name}:latest`)
}

async function readError(response: Response, model: string): Promise<string> {
  let detail = ''
  try {
    detail = await response.text()
  } catch {
    detail = ''
  }
  const lower = detail.toLowerCase()
  if (
    response.status === 404 ||
    lower.includes('not found') ||
    lower.includes('try pulling') ||
    lower.includes('no such model')
  ) {
    return `未找到模型「${model}」。请先在终端执行：ollama pull ${model}`
  }
  return `Ollama 返回错误（HTTP ${response.status}）：${detail.slice(0, 400)}`
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

export interface OllamaProbe {
  version?: string
  models: string[]
}

export async function ollamaProbe(rawUrl: string): Promise<OllamaProbe> {
  const url = baseUrl(rawUrl)
  let response: Response
  try {
    response = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) })
  } catch (error) {
    throw connectionError(url, error)
  }
  if (!response.ok) throw new Error(`Ollama 服务返回 HTTP ${response.status}`)
  const data = (await response.json()) as { models?: { name?: string; model?: string }[] }
  const models = (data.models ?? []).map((item) => item.name ?? item.model ?? '').filter(Boolean)

  let version: string | undefined
  try {
    const versionResponse = await fetch(`${url}/api/version`, {
      signal: AbortSignal.timeout(3000)
    })
    if (versionResponse.ok) {
      version = ((await versionResponse.json()) as { version?: string }).version
    }
  } catch {
    version = undefined
  }

  return { version, models }
}

export interface EmbedProgress {
  done: number
  total: number
}

export async function ollamaEmbed(
  settings: AppSettings,
  texts: string[],
  onProgress?: (progress: EmbedProgress) => void
): Promise<Float32Array[]> {
  if (!texts.length) return []
  const url = baseUrl(settings.ollamaUrl)
  const model = settings.embedModel
  const result: Float32Array[] = []
  const batchSize = 16

  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize).map((text) => text.trim() || ' ')

    let vectors: number[][] | null = null
    try {
      const response = await fetch(`${url}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: batch, truncate: true }),
        signal: AbortSignal.timeout(180_000)
      })
      if (response.ok) {
        const data = (await response.json()) as { embeddings?: number[][] }
        if (Array.isArray(data.embeddings) && data.embeddings.length) {
          vectors = data.embeddings
        }
      } else if (response.status !== 404) {
        throw new Error(await readError(response, model))
      }
    } catch (error) {
      if (error instanceof Error && !/fetch failed|ECONNREFUSED|ENOTFOUND|terminated/i.test(error.message)) {
        throw error
      }
      throw connectionError(url, error)
    }

    // 旧版本 Ollama 没有 /api/embed，退回逐条 /api/embeddings
    if (!vectors) {
      vectors = []
      for (const text of batch) {
        try {
          const response = await fetch(`${url}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt: text }),
            signal: AbortSignal.timeout(120_000)
          })
          if (!response.ok) throw new Error(await readError(response, model))
          const data = (await response.json()) as { embedding?: number[] }
          if (!data.embedding?.length) throw new Error('嵌入接口返回为空')
          vectors.push(data.embedding)
        } catch (error) {
          if (error instanceof Error && !/fetch failed|ECONNREFUSED|ENOTFOUND|terminated/i.test(error.message)) {
            throw error
          }
          throw connectionError(url, error)
        }
      }
    }

    if (vectors.length !== batch.length) {
      throw new Error(`嵌入结果数量不匹配：期望 ${batch.length} 条，实际 ${vectors.length} 条`)
    }
    for (const vector of vectors) result.push(normalizeVector(vector))
    onProgress?.({ done: Math.min(texts.length, start + batch.length), total: texts.length })
  }

  return result
}

export async function ollamaChatStream(
  settings: AppSettings,
  messages: OllamaMessage[],
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const url = baseUrl(settings.ollamaUrl)
  let response: Response
  try {
    response = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.chatModel,
        messages,
        stream: true,
        options: { temperature: settings.temperature }
      }),
      signal
    })
  } catch (error) {
    throw connectionError(url, error)
  }

  if (!response.ok) throw new Error(await readError(response, settings.chatModel))
  if (!response.body) throw new Error('Ollama 返回了空的流式响应')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const consumeLine = (line: string): boolean => {
    const trimmed = line.trim()
    if (!trimmed) return false
    let payload: {
      error?: string
      done?: boolean
      message?: { content?: string }
    }
    try {
      payload = JSON.parse(trimmed)
    } catch {
      return false
    }
    if (payload.error) throw new Error(`Ollama 生成失败：${payload.error}`)
    const piece = payload.message?.content
    if (typeof piece === 'string' && piece) onDelta(piece)
    return Boolean(payload.done)
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
        if (consumeLine(line)) {
          await reader.cancel().catch(() => undefined)
          return
        }
        newline = buffer.indexOf('\n')
      }
    }
    if (buffer.trim()) consumeLine(buffer)
  } finally {
    reader.releaseLock()
  }
}

export async function ollamaGenerate(
  options: { url: string; model: string },
  prompt: string,
  images: string[]
): Promise<string> {
  const url = baseUrl(options.url)
  let response: Response
  try {
    response = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        prompt,
        images,
        stream: false,
        options: { temperature: 0.1 }
      }),
      signal: AbortSignal.timeout(300_000)
    })
  } catch (error) {
    throw connectionError(url, error)
  }
  if (!response.ok) throw new Error(await readError(response, options.model))
  const data = (await response.json()) as { response?: string }
  return data.response ?? ''
}
