/// <reference lib="webworker" />

import {
  WASI,
  WASIProcExit,
  File,
  OpenFile,
  PreopenDirectory,
  ConsoleStdout,
} from '@bjorn3/browser_wasi_shim'
import { root, saveToDb } from './fsState'

export type WasiResult = {
  stdout: string
  stderr: string
  status: number
}

let modulePromise: Promise<WebAssembly.Module> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
const WASM_URL = '/coreutils.wasm'

function loadModule(): Promise<WebAssembly.Module> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const response = await fetch(WASM_URL)
      if (!response.ok) {
        throw new Error(`failed to fetch ${WASM_URL}: ${response.status}`)
      }
      if (typeof WebAssembly.compileStreaming === 'function') {
        return WebAssembly.compileStreaming(response)
      }
      const bytes = await response.arrayBuffer()
      return WebAssembly.compile(bytes)
    })()
  }
  return modulePromise
}

function scheduleSave() {
  if (saveTimer) {
    clearTimeout(saveTimer)
  }
  saveTimer = setTimeout(() => {
    saveTimer = null
    void saveToDb()
  }, 100)
}

export async function runWasiTool(
  tool: string,
  args: string[],
  stdin: string,
  cwd: string,
): Promise<WasiResult> {
  const module = await loadModule()

  const stdinBytes = new TextEncoder().encode(stdin)
  const stdinFile = new File(stdinBytes, { readonly: true })

  const decoder = new TextDecoder()
  let stdoutBuf = ''
  let stderrBuf = ''

  const stdinFd = new OpenFile(stdinFile)
  const stdoutFd = new ConsoleStdout((chunk) => {
    stdoutBuf += decoder.decode(chunk, { stream: true })
  })
  const stderrFd = new ConsoleStdout((chunk) => {
    stderrBuf += decoder.decode(chunk, { stream: true })
  })
  const preopen = new PreopenDirectory('/', root.contents)

  const env = [
    'PATH=/bin',
    'HOME=/home/magni',
    `PWD=${cwd}`,
    'USER=magni',
    'TERM=xterm-256color',
    'NO_COLOR=',
    'LC_ALL=C.UTF-8',
  ]

  const wasi = new WASI(['coreutils', tool, ...args], env, [stdinFd, stdoutFd, stderrFd, preopen])

  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport as WebAssembly.ModuleImports,
  })

  let status = 0
  try {
    status = wasi.start(
      instance as unknown as {
        exports: { memory: WebAssembly.Memory; _start: () => unknown }
      },
    )
  } catch (error) {
    if (error instanceof WASIProcExit) {
      status = error.code
    } else {
      stderrBuf += `${error instanceof Error ? error.message : String(error)}\n`
      status = 1
    }
  }

  scheduleSave()

  return { stdout: stdoutBuf, stderr: stderrBuf, status }
}
