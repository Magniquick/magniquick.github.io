import type { Terminal } from '@xterm/xterm'

declare module '*.wasm?init' {
  const init: (imports?: WebAssembly.Imports) => Promise<WebAssembly.Instance>
  export default init
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
