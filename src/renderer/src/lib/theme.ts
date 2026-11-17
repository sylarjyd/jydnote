import type { ThemeMode } from '../../../shared/types'

/** 只用于首屏减少闪烁；设置文件仍是主题的唯一持久化来源 */
const CACHE_KEY = 'jyd.theme'

export function applyTheme(theme: ThemeMode, cache = true): void {
  document.documentElement.dataset.theme = theme
  if (!cache) return
  try {
    window.localStorage.setItem(CACHE_KEY, theme)
  } catch {
    // 存储不可用时只是失去首屏缓存，不影响设置本身
  }
}

export function readCachedTheme(): ThemeMode {
  try {
    return window.localStorage.getItem(CACHE_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}
