import type { Terminal } from '@xterm/xterm'

declare module '*.wasm?url' {
  const url: string
  export default url
}

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
