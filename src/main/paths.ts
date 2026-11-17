import path from 'node:path'
import { app } from 'electron'

/** 库内原件的自定义协议，供 PDF / 图片预览直接加载 */
export const SOURCE_SCHEME = 'jyd-file'

export function dataRoot(): string {
  return path.join(app.getPath('userData'), 'library')
}

export function sourceUrlFor(relPath: string): string {
  const encoded = relPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `${SOURCE_SCHEME}://library/${encoded}`
}

export function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

export function ocrCacheDir(): string {
  return path.join(app.getPath('userData'), 'ocr-cache')
}

export function tessdataDir(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'tessdata')
  return path.join(app.getAppPath(), 'resources', 'tessdata')
}
