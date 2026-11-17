import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, nativeTheme, protocol, shell } from 'electron'
import type { ThemeMode } from '../shared/types'
import { registerIpc } from './ipc'
import { LibraryService } from './services/library'
import { loadSettings } from './settings'
import { dataRoot, SOURCE_SCHEME } from './paths'

app.setName('JydNote')

// 库内原件的只读协议：PDF / 图片预览直接由渲染进程加载，避免复制到临时目录
protocol.registerSchemesAsPrivileged([
  {
    scheme: SOURCE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff'
}

function registerSourceProtocol(): void {
  protocol.handle(SOURCE_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      if (url.host !== 'library') return new Response('未找到文件', { status: 404 })
      const root = path.resolve(dataRoot())
      const relative = decodeURIComponent(url.pathname).replace(/^[/\\]+/, '')
      const target = path.resolve(root, relative)
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        return new Response('禁止访问', { status: 403 })
      }
      const data = await fs.promises.readFile(target)
      const ext = path.extname(target).slice(1).toLowerCase()
      return new Response(new Uint8Array(data), {
        headers: {
          'Content-Type': MIME_BY_EXT[ext] ?? 'application/octet-stream',
          'Content-Disposition': 'inline'
        }
      })
    } catch {
      return new Response('文件不存在', { status: 404 })
    }
  })
}

const WINDOW_BACKGROUND: Record<ThemeMode, string> = {
  light: '#f3f0e8',
  dark: '#141a16'
}

function createWindow(theme: ThemeMode): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // 与渲染进程首屏主题一致，避免窗口先闪一下浅色
    backgroundColor: WINDOW_BACKGROUND[theme],
    title: '简阅笔记',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // PDF 预览依赖 Chromium 内置阅读器
      plugins: true
    }
  })

  window.on('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void window.loadURL(devUrl)
  else void window.loadFile(path.join(__dirname, '../renderer/index.html'))
}

const library = new LibraryService()
const hasLock = app.requestSingleInstanceLock()

if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('com.jydnote.app')
    const theme = loadSettings().theme
    // 让原生标题栏、下拉框等跟随应用主题
    nativeTheme.themeSource = theme
    registerSourceProtocol()
    registerIpc(library)
    createWindow(theme)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(loadSettings().theme)
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
