/// <reference lib="webworker" />

import {
  WASI,
  WASIProcExit,
  File,
  Directory,
  OpenFile,
  PreopenDirectory,
  ConsoleStdout,
  type Inode,
} from '@bjorn3/browser_wasi_shim'

export type WasiResult = {
  stdout: string
  stderr: string
  status: number
}

export type VfsEntry =
  | { type: 'dir'; mtime?: number }
  | { type: 'file'; data: string; mtime?: number }

export type Vfs = Record<string, VfsEntry>

let modulePromise: Promise<WebAssembly.Module> | null = null
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

function decodeVfsFile(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/**
 * Build an in-memory WASI directory tree from the shell's flat-path VFS.
 * Paths in vfs are absolute strings keyed by "/home/magni/foo/bar".
 */
function vfsToInodes(vfs: Vfs): Map<string, Inode> {
  const root = new Map<string, Inode>()

  // ensure every directory exists before we attach children
  const dirs = new Map<string, Directory>()
  dirs.set('/', new Directory(root))

  const ensureDir = (path: string): Directory => {
    if (path === '/' || path === '') {
      return dirs.get('/')!
    }
    const existing = dirs.get(path)
    if (existing) {
      return existing
    }
    const parts = path.split('/').filter(Boolean)
    const name = parts[parts.length - 1]!
    const parentPath = '/' + parts.slice(0, -1).join('/')
    const parent = ensureDir(parentPath === '/' ? '/' : parentPath)
    const dir = new Directory(new Map())
    parent.contents.set(name, dir)
    dirs.set(path, dir)
    return dir
  }

  const sortedPaths = Object.keys(vfs).sort()

  for (const path of sortedPaths) {
    if (path === '/' || path === '') continue
    const entry = vfs[path]
    const parts = path.split('/').filter(Boolean)
    const name = parts[parts.length - 1]!
    const parentPath = '/' + parts.slice(0, -1).join('/')
    const parent = ensureDir(parentPath === '/' ? '/' : parentPath)

    if (entry.type === 'dir') {
      if (!parent.contents.has(name)) {
        const dir = new Directory(new Map())
        parent.contents.set(name, dir)
        dirs.set(path, dir)
      }
    } else {
      parent.contents.set(name, new File(decodeVfsFile(entry.data)))
    }
  }

  return root
}

/**
 * Run a uutils/coreutils applet by name against the given VFS.
 * Read-only (no write-back to vfs). stdin is a UTF-8 string.
 */
export async function runWasiTool(
  tool: string,
  args: string[],
  stdin: string,
  cwd: string,
  vfs: Vfs,
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

  const contents = vfsToInodes(vfs)
  const preopen = new PreopenDirectory('/', contents)

  const env = [
    'PATH=/bin',
    'HOME=/home/magni',
    `PWD=${cwd}`,
    'USER=magni',
    'TERM=xterm-256color',
    'NO_COLOR=',
    'LC_ALL=C.UTF-8',
  ]

  // argv[0] is the multicall name; coreutils dispatches by argv[1] when argv[0] is "coreutils".
  const wasi = new WASI(['coreutils', tool, ...args], env, [stdinFd, stdoutFd, stderrFd, preopen])

  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport as WebAssembly.ModuleImports,
  })

  let status = 0
  try {
    wasi.start(
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

  return { stdout: stdoutBuf, stderr: stderrBuf, status }
}
