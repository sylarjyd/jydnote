import type { AppSettings, ModelStatus } from '../../shared/types'
import {
  dashscopeEmbed,
  dashscopeProbe,
  dashscopeRerank,
  deepseekChatStream,
  deepseekProbe,
  openaiChatStream,
  openaiEmbed,
  openaiProbe,
  type ChatTurn,
  type EmbedProgress,
  type RerankResult
} from './cloud'
import {
  hasOllamaModel,
  ollamaChatStream,
  ollamaEmbed,
  ollamaProbe
} from './ollama'

export type { ChatTurn, EmbedProgress }
export { ollamaGenerate } from './ollama'

interface SegmentStatus {
  ready: boolean
  detail?: string
  error?: string
  models: string[]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hasModel(models: string[], target: string): boolean {
  const name = target.trim().toLowerCase()
  if (!name) return false
  return models.some((model) => model.trim().toLowerCase() === name)
}

async function chatStatus(settings: AppSettings): Promise<SegmentStatus> {
  if (settings.chatProvider === 'deepseek') {
    try {
      const { models } = await deepseekProbe(settings)
      return {
        ready: true,
        detail: `DeepSeek · ${settings.chatModel}`,
        models
      }
    } catch (error) {
      return { ready: false, error: messageOf(error), models: [] }
    }
  }

  if (settings.chatProvider === 'openai') {
    try {
      const { models } = await openaiProbe(settings)
      if (!settings.chatModel.trim()) {
        return {
          ready: false,
          error: '请填写或从模型列表选择 LM Studio / OpenAI 兼容对话模型',
          models
        }
      }
      if (!hasModel(models, settings.chatModel)) {
        return {
          ready: false,
          error: `未在 OpenAI 兼容服务中找到对话模型「${settings.chatModel}」，请确认模型已加载或从列表选择`,
          models
        }
      }
      return {
        ready: true,
        detail: `LM Studio / OpenAI 兼容 · ${settings.chatModel}`,
        models
      }
    } catch (error) {
      return { ready: false, error: messageOf(error), models: [] }
    }
  }

  try {
    const probe = await ollamaProbe(settings.ollamaUrl)
    if (!hasOllamaModel(probe.models, settings.chatModel)) {
      return {
        ready: false,
        error: `本地 Ollama 未安装对话模型「${settings.chatModel}」，请运行 ollama pull ${settings.chatModel}`,
        models: probe.models
      }
    }
    return {
      ready: true,
      detail: `Ollama${probe.version ? ` v${probe.version}` : ''} · ${settings.chatModel}`,
      models: probe.models
    }
  } catch (error) {
    return { ready: false, error: messageOf(error), models: [] }
  }
}

async function embedStatus(settings: AppSettings): Promise<SegmentStatus> {
  if (settings.embedProvider === 'dashscope') {
    try {
      await dashscopeProbe(settings)
      return {
        ready: true,
        detail: `阿里云百炼 · ${settings.embedModel} · ${settings.embedDimensions} 维`,
        models: []
      }
    } catch (error) {
      return { ready: false, error: messageOf(error), models: [] }
    }
  }

  if (settings.embedProvider === 'openai') {
    try {
      const { models } = await openaiProbe(settings)
      if (!settings.embedModel.trim()) {
        return {
          ready: false,
          error: '请填写或从模型列表选择 LM Studio / OpenAI 兼容嵌入模型',
          models
        }
      }
      if (!hasModel(models, settings.embedModel)) {
        return {
          ready: false,
          error: `未在 OpenAI 兼容服务中找到嵌入模型「${settings.embedModel}」，请确认模型已加载或从列表选择`,
          models
        }
      }
      return {
        ready: true,
        detail: `LM Studio / OpenAI 兼容 · ${settings.embedModel}`,
        models
      }
    } catch (error) {
      return { ready: false, error: messageOf(error), models: [] }
    }
  }

  try {
    const probe = await ollamaProbe(settings.ollamaUrl)
    if (!hasOllamaModel(probe.models, settings.embedModel)) {
      return {
        ready: false,
        error: `本地 Ollama 未安装嵌入模型「${settings.embedModel}」，请运行 ollama pull ${settings.embedModel}`,
        models: probe.models
      }
    }
    return {
      ready: true,
      detail: `Ollama${probe.version ? ` v${probe.version}` : ''} · ${settings.embedModel}`,
      models: probe.models
    }
  } catch (error) {
    return { ready: false, error: messageOf(error), models: [] }
  }
}

async function rerankStatus(settings: AppSettings): Promise<SegmentStatus | null> {
  if (!settings.rerankEnabled) return null
  try {
    await dashscopeRerank(settings, '连接测试', ['重排序连接测试'])
    return {
      ready: true,
      detail: `阿里云百炼 · ${settings.rerankModel}`,
      models: []
    }
  } catch (error) {
    return { ready: false, error: messageOf(error), models: [] }
  }
}

export async function getModelStatus(settings: AppSettings): Promise<ModelStatus> {
  const [chat, embed, rerank] = await Promise.all([
    chatStatus(settings),
    embedStatus(settings),
    rerankStatus(settings)
  ])
  const chatModels = [...new Set(chat.models)]
  const embedModels = [...new Set(embed.models)]
  return {
    chatReady: chat.ready,
    embedReady: embed.ready,
    chatDetail: chat.detail,
    embedDetail: embed.detail,
    chatError: chat.error,
    embedError: embed.error,
    models: [...new Set([...chatModels, ...embedModels])],
    chatModels,
    embedModels,
    ...(rerank
      ? {
          rerankReady: rerank.ready,
          rerankDetail: rerank.detail,
          rerankError: rerank.error
        }
      : {})
  }
}

export async function embedTexts(
  settings: AppSettings,
  texts: string[],
  onProgress?: (progress: EmbedProgress) => void
): Promise<Float32Array[]> {
  if (settings.embedProvider === 'dashscope') {
    return dashscopeEmbed(settings, texts, onProgress)
  }
  if (settings.embedProvider === 'openai') {
    return openaiEmbed(settings, texts, onProgress)
  }
  return ollamaEmbed(settings, texts, onProgress)
}

export async function rerankTexts(
  settings: AppSettings,
  query: string,
  documents: string[],
  signal?: AbortSignal
): Promise<RerankResult[]> {
  return dashscopeRerank(settings, query, documents, signal)
}

export async function chatStream(
  settings: AppSettings,
  messages: ChatTurn[],
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<void> {
  if (settings.chatProvider === 'deepseek') {
    return deepseekChatStream(settings, messages, onDelta, signal)
  }
  if (settings.chatProvider === 'openai') {
    return openaiChatStream(settings, messages, onDelta, signal)
  }
  return ollamaChatStream(settings, messages, onDelta, signal)
}
