import { ipcMain, nativeTheme } from 'electron'
import type { AppSettings, ChatRequest, RagStreamEvent } from '../shared/types'
import type { LibraryService } from './services/library'
import { answerQuestion } from './core/rag'
import { loadSettings, saveSettings } from './settings'

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|network error/i.test(message)) {
    return `无法连接模型服务：${message}`
  }
  return message
}

export function registerIpc(library: LibraryService): void {
  ipcMain.handle('library:list', () => library.list())
  ipcMain.handle('library:list-folders', () => library.listFolders())
  ipcMain.handle('library:create-folder', (_event, parent: unknown, name: unknown) => {
    if (typeof parent !== 'string' || typeof name !== 'string') throw new Error('目录参数错误')
    return library.createFolder(parent, name)
  })
  ipcMain.handle('library:rename-folder', (_event, folder: unknown, name: unknown) => {
    if (typeof folder !== 'string' || typeof name !== 'string') throw new Error('目录参数错误')
    return library.renameFolder(folder, name)
  })
  ipcMain.handle('library:delete-folder', (_event, folder: unknown) => {
    if (typeof folder !== 'string') throw new Error('目录参数错误')
    return library.deleteFolder(folder)
  })
  ipcMain.handle('library:move-docs', (_event, ids: unknown, folder: unknown) => {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      !ids.every((id) => typeof id === 'string') ||
      (folder !== null && typeof folder !== 'string')
    ) {
      throw new Error('移动参数错误')
    }
    return library.moveDocs(ids, folder)
  })
  ipcMain.handle('library:import', (_event, paths: unknown) => {
    if (!Array.isArray(paths) || !paths.every((item) => typeof item === 'string')) {
      throw new Error('导入参数错误')
    }
    return library.importPaths(paths)
  })
  ipcMain.handle('library:pick', () => library.pickAndImport())
  ipcMain.handle('library:pick-folder', () => library.pickFolder())
  ipcMain.handle('library:remove', (_event, id: string) => library.removeDoc(id))
  ipcMain.handle('library:content', (_event, id: string) => library.getContent(id))
  ipcMain.handle('library:reindex', () => library.reindexAll())
  ipcMain.handle('library:reindex-doc', (_event, id: string) => library.reindexDoc(id))
  ipcMain.handle('library:open-source', (_event, id: string) => library.openSource(id))

  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:save', (_event, settings: AppSettings) => {
    const saved = saveSettings(settings)
    nativeTheme.themeSource = saved.theme
    return saved
  })

  ipcMain.handle('models:status', () => library.modelStatus())
  ipcMain.handle('models:test', (_event, settings: AppSettings) => {
    if (!settings || typeof settings !== 'object') throw new Error('模型配置参数错误')
    return library.testModels(settings)
  })

  const controllers = new Map<string, AbortController>()

  ipcMain.handle('rag:ask', async (event, request: ChatRequest) => {
    if (
      !request ||
      typeof request.requestId !== 'string' ||
      typeof request.question !== 'string'
    ) {
      throw new Error('问答参数错误')
    }

    const settings = loadSettings()
    const controller = new AbortController()
    controllers.set(request.requestId, controller)

    const send = (payload: RagStreamEvent): void => {
      if (!event.sender.isDestroyed()) event.sender.send('rag:stream', payload)
    }

    try {
      await library.init()
      await answerQuestion(library.kb, settings, request, {
        onSources: (sources) =>
          send({ requestId: request.requestId, type: 'sources', sources }),
        onDelta: (text) => send({ requestId: request.requestId, type: 'delta', text }),
        signal: controller.signal
      })
      send({ requestId: request.requestId, type: 'done' })
    } catch (error) {
      if (controller.signal.aborted) {
        send({ requestId: request.requestId, type: 'done' })
      } else {
        send({
          requestId: request.requestId,
          type: 'error',
          message: readableError(error)
        })
      }
    } finally {
      controllers.delete(request.requestId)
    }
  })

  ipcMain.handle('rag:abort', (_event, requestId: string) => {
    controllers.get(requestId)?.abort()
    controllers.delete(requestId)
  })
}
