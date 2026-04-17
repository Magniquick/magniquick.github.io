import type { Terminal } from '@xterm/xterm'

declare global {
  interface Window {
    __labTerminal?: Terminal
    __labRuntimeState?: {
      busy: boolean
      promptSerial: number
    }
  }
}

export {}
