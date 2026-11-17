import fs from 'node:fs'
import path from 'node:path'
import type { ParsedDoc } from './base'
import { ollamaGenerate } from '../ollama'

const VISION_PROMPT = [
  '请读取这张图片中的所有文字，尽量保持原有的段落和层级结构。',
  '如果图片是图表、表格或截图，请同时用中文概括关键信息。',
  '只输出图片的内容本身，不要添加与图片无关的解释。'
].join('\n')

function hasTraineddata(dir: string, langs: string): boolean {
  return langs
    .split('+')
    .filter(Boolean)
    .every((lang) => {
      const base = path.join(dir, `${lang}.traineddata`)
      return fs.existsSync(base) || fs.existsSync(`${base}.gz`)
    })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function parseImageFile(context: {
  filePath: string
  title: string
  visionModel: string
  ollamaUrl: string
  ocrLangs: string
  tessdataDir: string
  ocrCacheDir: string
}): Promise<ParsedDoc> {
  const buffer = await fs.promises.readFile(context.filePath)
  let visionError: unknown = null

  if (context.visionModel.trim()) {
    try {
      const description = await ollamaGenerate(
        { url: context.ollamaUrl, model: context.visionModel.trim() },
        VISION_PROMPT,
        [buffer.toString('base64')]
      )
      if (description.trim()) {
        return {
          title: context.title,
          blocks: [{ text: description.trim(), headingPath: ['图片内容'] }]
        }
      }
    } catch (error) {
      visionError = error
    }
  }

  if (!hasTraineddata(context.tessdataDir, context.ocrLangs)) {
    const visionHint = visionError ? `视觉模型调用失败：${errorMessage(visionError)}。` : ''
    throw new Error(
      `${visionHint}未找到本地 OCR 语言数据（${context.ocrLangs}）。请先在项目目录运行 npm run fetch-ocr，或在设置中填写可用的本地视觉模型（如 qwen2.5vl:3b）。`
    )
  }

  try {
    const { createWorker, OEM } = await import('tesseract.js')
    const worker = await createWorker(context.ocrLangs, OEM.LSTM_ONLY, {
      langPath: context.tessdataDir,
      cachePath: context.ocrCacheDir,
      gzip: true
    })
    try {
      const { data } = await worker.recognize(buffer)
      const text = (data.text ?? '').trim()
      if (!text) {
        throw new Error(
          '图片中没有识别到文字。若想理解图片内容，可在设置中配置本地视觉模型（如 qwen2.5vl:3b）。'
        )
      }
      return {
        title: context.title,
        blocks: [{ text, headingPath: ['图片文字（OCR）'] }]
      }
    } finally {
      await worker.terminate()
    }
  } catch (error) {
    const visionHint = visionError ? `视觉模型调用失败：${errorMessage(visionError)}。` : ''
    throw new Error(`${visionHint}OCR 失败：${errorMessage(error)}`)
  }
}
