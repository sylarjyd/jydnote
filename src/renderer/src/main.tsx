import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { applyTheme, readCachedTheme } from './lib/theme'
import './styles.css'

// 先按上次主题渲染首屏，设置读取完成后再以设置文件为准
applyTheme(readCachedTheme(), false)

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
