import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppSettings,
  ChatRequest,
  ImportProgress,
  JydApi,
  RagStreamEvent
} from '../shared/types'

const api: JydApi = {
  listDocs: () => ipcRenderer.invoke('library:list'),
  listFolders: () => ipcRenderer.invoke('library:list-folders'),
  createFolder: (parent, name) => ipcRenderer.invoke('library:create-folder', parent, name),
  renameFolder: (folder, name) => ipcRenderer.invoke('library:rename-folder', folder, name),
  deleteFolder: (folder) => ipcRenderer.invoke('library:delete-folder', folder),
  moveDocs: (ids, folder) => ipcRenderer.invoke('library:move-docs', ids, folder),
  importPaths: (paths) => ipcRenderer.invoke('library:import', paths),
  pickAndImport: () => ipcRenderer.invoke('library:pick'),
  pickFolder: () => ipcRenderer.invoke('library:pick-folder'),
  removeDoc: (id) => ipcRenderer.invoke('library:remove', id),
  createNote: (input) => ipcRenderer.invoke('library:create-note', input),
  updateNote: (input) => ipcRenderer.invoke('library:update-note', input),
  getDocContent: (id) => ipcRenderer.invoke('library:content', id),
  reindexAll: () => ipcRenderer.invoke('library:reindex'),
  reindexDoc: (id) => ipcRenderer.invoke('library:reindex-doc', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke('settings:save', settings),
  modelStatus: () => ipcRenderer.invoke('models:status'),
  testModels: (settings: AppSettings) => ipcRenderer.invoke('models:test', settings),
  openSource: (id) => ipcRenderer.invoke('library:open-source', id),
  ask: (request: ChatRequest) => ipcRenderer.invoke('rag:ask', request),
  abort: (requestId: string) => ipcRenderer.invoke('rag:abort', requestId),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  onImportProgress: (callback: (progress: ImportProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ImportProgress): void => {
      callback(progress)
    }
    ipcRenderer.on('import:progress', listener)
    return () => ipcRenderer.removeListener('import:progress', listener)
  },
  onStream: (callback: (event: RagStreamEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: RagStreamEvent): void => {
      callback(payload)
    }
    ipcRenderer.on('rag:stream', listener)
    return () => ipcRenderer.removeListener('rag:stream', listener)
  },
  onLibraryChanged: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('library:changed', listener)
    return () => ipcRenderer.removeListener('library:changed', listener)
  }
}

contextBridge.exposeInMainWorld('jyd', api)
