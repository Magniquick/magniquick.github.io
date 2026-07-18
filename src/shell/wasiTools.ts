/// <reference lib="webworker" />

import {
  WASI,
  WASIProcExit,
  File,
  OpenFile,
  PreopenDirectory,
  ConsoleStdout,
  type Inode,
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
const LS_COLORS = [
  'di=01;34',
  'ln=01;36',
  'ex=01;32',
  '*.txt=00;33',
  '*.md=00;33',
  '*.json=00;36',
  '*.js=00;32',
  '*.mjs=00;32',
  '*.py=00;35',
  '*.wasm=00;36',
].join(':')
const UUTILS_COMMANDS_WITH_DEFAULT_COLOR = new Set(['dir', 'ls', 'vdir'])
const textEncoder = new TextEncoder()

function normalizeAbsolutePath(input: string) {
  const parts: string[] = []
  for (const part of input.split('/')) {
    if (!part || part === '.') {
      continue
    }
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return `/${parts.join('/')}`
}

function normalizeRelativeToRoot(input: string) {
  const normalized = normalizeAbsolutePath(input)
  return normalized === '/' ? '.' : normalized.slice(1)
}

function joinPath(base: string, path: string) {
  return normalizeAbsolutePath(path.startsWith('/') ? path : `${base}/${path}`)
}

function prepareWasiArgs(command: string, args: string[]) {
  const resolved: string[] = []
  const forceDefaultColor = UUTILS_COMMANDS_WITH_DEFAULT_COLOR.has(command)
    && !args.some((arg) => arg === '--color' || arg.startsWith('--color='))
  if (forceDefaultColor) {
    resolved.push('--color=auto')
  }
  return [...resolved, ...args]
}

function relativePathKey(path: string) {
  return normalizeRelativeToRoot(path)
}

function collectAbsoluteArgPaths(args: string[]) {
  const paths = new Set<string>()
  const add = (value: string) => {
    if (value.startsWith('/')) {
      paths.add(relativePathKey(value))
    }
  }

  for (const arg of args) {
    add(arg)
    if (arg.startsWith('--') && arg.includes('=')) {
      add(arg.split(/=(.*)/s, 2)[1] ?? '')
    }
  }

  return paths
}

class CwdAwarePreopenDirectory extends PreopenDirectory {
  constructor(
    name: string,
    contents: Map<string, Inode>,
    private readonly getCwd: () => string,
    private readonly absoluteArgPaths: Set<string>,
  ) {
    super(name, contents)
  }

  private resolveShellPath(path: string) {
    const rootRelative = relativePathKey(path)
    if (this.absoluteArgPaths.has(rootRelative)) {
      return rootRelative
    }
    return normalizeRelativeToRoot(joinPath(this.getCwd(), path))
  }

  path_create_directory(path: string) {
    return super.path_create_directory(this.resolveShellPath(path))
  }

  path_filestat_get(flags: number, path: string) {
    return super.path_filestat_get(flags, this.resolveShellPath(path))
  }

  path_filestat_set_times(flags: number, path: string, atim: bigint, mtim: bigint, fstFlags: number) {
    return super.path_filestat_set_times(flags, this.resolveShellPath(path), atim, mtim, fstFlags)
  }

  path_link(path: string, inode: Inode, allowDir: boolean) {
    return super.path_link(this.resolveShellPath(path), inode, allowDir)
  }

  path_lookup(path: string, dirflags: number) {
    return super.path_lookup(this.resolveShellPath(path), dirflags)
  }

  path_open(
    dirflags: number,
    path: string,
    oflags: number,
    rightsBase: bigint,
    rightsInheriting: bigint,
    fdFlags: number,
  ) {
    return super.path_open(dirflags, this.resolveShellPath(path), oflags, rightsBase, rightsInheriting, fdFlags)
  }

  path_readlink(path: string) {
    return super.path_readlink(this.resolveShellPath(path))
  }

  path_remove_directory(path: string) {
    return super.path_remove_directory(this.resolveShellPath(path))
  }

  path_unlink(path: string) {
    return super.path_unlink(this.resolveShellPath(path))
  }

  path_unlink_file(path: string) {
    return super.path_unlink_file(this.resolveShellPath(path))
  }
}

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

  const decoder = new TextDecoder()
  let stdoutBuf = ''
  let stderrBuf = ''

  const stdinFd = new OpenFile(new File(textEncoder.encode(stdin), { readonly: true }))
  const stdoutFd = new ConsoleStdout((chunk) => {
    stdoutBuf += decoder.decode(chunk, { stream: true })
  })
  const stderrFd = new ConsoleStdout((chunk) => {
    stderrBuf += decoder.decode(chunk, { stream: true })
  })
  const wasiArgs = prepareWasiArgs(tool, args)
  const preopen = new CwdAwarePreopenDirectory('/', root.contents, () => cwd, collectAbsoluteArgPaths(wasiArgs))

  const env = [
    'PATH=/bin',
    'HOME=/home/magni',
    `PWD=${cwd}`,
    'USER=magni',
    'TERM=xterm-256color',
    'LC_ALL=C.UTF-8',
    'COLORTERM=truecolor',
    `LS_COLORS=${LS_COLORS}`,
  ]

  const wasi = new WASI(['coreutils', tool, ...wasiArgs], env, [stdinFd, stdoutFd, stderrFd, preopen], { debug: false })

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
