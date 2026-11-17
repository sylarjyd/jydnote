/// <reference types="vite/client" />
import type { JydApi } from '../../shared/types'

declare global {
  interface Window {
    jyd: JydApi
  }
}

export {}
