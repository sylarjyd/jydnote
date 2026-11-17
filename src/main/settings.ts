import fs from 'node:fs'
import path from 'node:path'
import {
  DASHSCOPE_EMBED_DIMENSIONS,
  DEFAULT_CHAT_MODELS,
  DEFAULT_EMBED_MODELS,
  DEFAULT_SETTINGS,
  type AppSettings,
  type ChatProvider,
  type EmbedProvider,
  type ThemeMode
} from '../shared/types'
import { settingsPath } from './paths'

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

export function normalizeSettings(input: Partial<AppSettings>): AppSettings {
  const dimensions = Math.round(
    clampNumber(input.embedDimensions, DEFAULT_SETTINGS.embedDimensions, 64, 2048)
  )
  const chatProvider = pick<ChatProvider>(
    input.chatProvider,
    ['deepseek', 'openai', 'ollama'],
    DEFAULT_SETTINGS.chatProvider
  )
  const embedProvider = pick<EmbedProvider>(
    input.embedProvider,
    ['dashscope', 'openai', 'ollama'],
    DEFAULT_SETTINGS.embedProvider
  )
  const theme = pick<ThemeMode>(input.theme, ['light', 'dark'], DEFAULT_SETTINGS.theme)
  return {
    theme,

    chatProvider,
    chatModel: text(input.chatModel, DEFAULT_CHAT_MODELS[chatProvider]),
    deepseekApiKey: typeof input.deepseekApiKey === 'string' ? input.deepseekApiKey.trim() : '',
    deepseekBaseUrl: text(input.deepseekBaseUrl, DEFAULT_SETTINGS.deepseekBaseUrl),

    embedProvider,
    embedModel: text(input.embedModel, DEFAULT_EMBED_MODELS[embedProvider]),
    dashscopeApiKey:
      typeof input.dashscopeApiKey === 'string' ? input.dashscopeApiKey.trim() : '',
    dashscopeBaseUrl: text(input.dashscopeBaseUrl, DEFAULT_SETTINGS.dashscopeBaseUrl),
    embedDimensions: (DASHSCOPE_EMBED_DIMENSIONS as readonly number[]).includes(dimensions)
      ? dimensions
      : DEFAULT_SETTINGS.embedDimensions,

    rerankEnabled:
      typeof input.rerankEnabled === 'boolean'
        ? input.rerankEnabled
        : DEFAULT_SETTINGS.rerankEnabled,
    rerankModel: text(input.rerankModel, DEFAULT_SETTINGS.rerankModel),

    openaiBaseUrl: text(input.openaiBaseUrl, DEFAULT_SETTINGS.openaiBaseUrl),
    openaiApiKey: typeof input.openaiApiKey === 'string' ? input.openaiApiKey.trim() : '',

    ollamaUrl: text(input.ollamaUrl, DEFAULT_SETTINGS.ollamaUrl),
    visionModel: typeof input.visionModel === 'string' ? input.visionModel.trim() : '',

    topK: Math.round(clampNumber(input.topK, DEFAULT_SETTINGS.topK, 1, 30)),
    chunkSize: Math.round(clampNumber(input.chunkSize, DEFAULT_SETTINGS.chunkSize, 200, 4000)),
    chunkOverlap: Math.round(
      clampNumber(input.chunkOverlap, DEFAULT_SETTINGS.chunkOverlap, 0, 1000)
    ),
    temperature: clampNumber(input.temperature, DEFAULT_SETTINGS.temperature, 0, 1.5),
    maxContextChars: Math.round(
      clampNumber(input.maxContextChars, DEFAULT_SETTINGS.maxContextChars, 2000, 64000)
    ),
    ocrLangs: text(input.ocrLangs, DEFAULT_SETTINGS.ocrLangs)
  }
}

export function loadSettings(): AppSettings {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    // 旧版本只有 Ollama 配置，升级后继续用本地模式，避免误用云端默认模型
    const legacy =
      !parsed.chatProvider && !parsed.embedProvider && typeof parsed.chatModel === 'string'
    return normalizeSettings({
      ...DEFAULT_SETTINGS,
      ...parsed,
      ...(legacy ? { chatProvider: 'ollama', embedProvider: 'ollama' } : {})
    })
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(input: Partial<AppSettings>): AppSettings {
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...input })
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8')
  return settings
}
