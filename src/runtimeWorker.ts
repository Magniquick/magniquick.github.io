/// <reference lib="webworker" />

import { flavors } from '@catppuccin/palette'
import { buildRequests, getFirst } from 'curlconverter/dist/src/Request.js'
import {
  curlLongOpts,
  curlLongOptsShortened,
  curlShortOpts,
  parseArgs,
} from 'curlconverter/dist/src/curl/opts.js'
import { Word } from 'curlconverter/dist/src/shell/Word.js'
import type { Warnings } from 'curlconverter/dist/src/Warnings.js'
import type { PyodideAPI } from 'pyodide'
import { Directory, File } from '@bjorn3/browser_wasi_shim'
import initBrushParser, { parse_shell as parseBrushShell } from './generated/brushParserWasm/brush_parser_wasm'
import brushParserWasmUrl from './generated/brushParserWasm/brush_parser_wasm_bg.wasm?url'
import { runJokeCommand } from './jokeCommands'
import { runWasiTool } from './wasiTools'
import * as fsState from './fsState'
import { CURL_SUPPORTED_ARGS } from './generated/curlMetadata'
import { UUTILS_COMMANDS } from './generated/uutilsMetadata'
import { featuredProjects, projectArchive } from './data/projects'
import { profile } from './data/profile'
import type { RuntimeEvent, RuntimeRequest, ShellMode } from './runtimeProtocol'

declare const self: DedicatedWorkerGlobalScope

type RuntimeCommandResult = {
  stdout: string
  stderr: string
  status: number
  clear?: boolean
}

type CurlRequest = {
  url: string
  method: string
  headers?: Record<string, string | null>
  data?: unknown
  include?: boolean
  auth?: { user: string; password: string }
  follow_redirects?: boolean
  timeout?: number
  connect_timeout?: number
  output?: string
}

type CommandNode = {
  type: 'command'
  words: string[]
  redirections: Array<{ op: '>' | '>>' | '<'; target: string }>
}

type PipelineNode = {
  type: 'pipeline'
  commands: CommandNode[]
}

type LogicalNode = {
  type: 'logical'
  op: '&&' | '||'
  left: AstNode
  right: AstNode
}

type ArithmeticNode = {
  type: 'arithmetic'
  expression: string
}

type SequenceNode = {
  type: 'sequence'
  nodes: AstNode[]
}

type AstNode = PipelineNode | LogicalNode | ArithmeticNode | SequenceNode

type ShellState = {
  cwd: string
  env: Record<string, string>
  aliases: Record<string, string>
  history: string[]
  mode: ShellMode
  pythonContinuation: boolean
  lessLines: string[]
  lessOffset: number
  lessSearch: string
  cols: number
  rows: number
}

const HOME_ROOT = '/home/magni'
const HISTORY_FILE = `${HOME_ROOT}/.jsh_history`
const PYODIDE_INDEX_URL = new URL('/pyodide/', self.location.origin).toString()
const USERNAME = 'magni'
const DEFAULT_PROMPT_USER = 'magniquick'
const DEFAULT_HOSTNAME = 'lab'
const BOOT_TIME = Date.now()
const MOCHA = flavors.mocha.colors

function ansiRgb(name: keyof typeof MOCHA) {
  const { r, g, b } = MOCHA[name].rgb
  return `\u001b[38;2;${r};${g};${b}m`
}

const ANSI = {
  reset: '\u001b[0m',
  dim: ansiRgb('subtext0'),
  pink: ansiRgb('pink'),
  cyan: ansiRgb('teal'),
  blue: ansiRgb('blue'),
  yellow: ansiRgb('yellow'),
  green: ansiRgb('green'),
  red: ansiRgb('red'),
  text: ansiRgb('text'),
} as const

function wrapWords(words: readonly string[], width = 76) {
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line)
      line = word
      continue
    }
    line = line ? `${line} ${word}` : word
  }
  if (line) {
    lines.push(line)
  }
  return lines.join('\n')
}

const HELP_TEXT = `shell builtins

bc [FILE...]
cd <path>
tree [path]
less <file>
grep [options] PATTERN [FILE...]
which COMMAND...
hostname
uptime
neofetch
getconf NAME
xxd [FILE]
jq FILTER [FILE]
curl URL
jsh [-c COMMAND]
ps
kill PID...
env [-u KEY] [KEY=VALUE ...] [COMMAND [ARG...]]
printenv [KEY]
export KEY=VALUE
unset KEY...
rm [-r] <path...>
cp <src> <dst>
mv <src> <dst>
alias [name='value']
history
clear
help
python
python file.py
python -c "print('hi')"

uutils wasm applets

${wrapWords(UUTILS_COMMANDS)}

operators

;
&&
||
|
>
>>
<
`

let pyodide: PyodideAPI | null = null
let ready = false
let pendingStdIn: string[] = []
let interruptBuffer: Int32Array | null = null
let activeCapture: { stdout: string; stderr: string } | null = null
let pyodideBootPromise: Promise<PyodideAPI> | null = null
let lastExitCode = 0
let interruptSerial = 0
let shellParserPromise: Promise<void> | null = null

const state: ShellState = {
  cwd: HOME_ROOT,
  env: {
    HOME: HOME_ROOT,
    PWD: HOME_ROOT,
    OLDPWD: HOME_ROOT,
    USER: USERNAME,
    SHELL: '/bin/jsh-lite',
    TERM: 'xterm-256color',
    HOSTNAME: DEFAULT_HOSTNAME,
  },
  aliases: {
    ll: 'ls',
    python3: 'python',
  },
  history: [],
  mode: 'shell',
  pythonContinuation: false,
  lessLines: [],
  lessOffset: 0,
  lessSearch: '',
  cols: 120,
  rows: 36,
}

function paint(text: string, color: string) {
  return `${color}${text}${ANSI.reset}`
}

function post(event: RuntimeEvent) {
  self.postMessage(event)
}

function emitPrompt() {
  post({ type: 'prompt', value: promptForState(), history: [...state.history] })
}

function promptForState() {
  if (state.mode === 'python') {
    return state.pythonContinuation ? '... ' : '>>> '
  }

  if (state.mode === 'less') {
    return ':'
  }

  const displayCwd = state.cwd === HOME_ROOT ? '~' : state.cwd.startsWith(`${HOME_ROOT}/`) ? `~${state.cwd.slice(HOME_ROOT.length)}` : state.cwd
  const promptColor = lastExitCode === 0 ? ANSI.green : ANSI.red
  return `${paint(`${DEFAULT_PROMPT_USER}@${DEFAULT_HOSTNAME}`, ANSI.cyan)}${paint(':', ANSI.text)}${paint(displayCwd, ANSI.blue)}\r\n${paint('❯', promptColor)} `
}

function writeStdout(data: string) {
  if (data) {
    if (activeCapture) {
      activeCapture.stdout += data
      return
    }
    post({ type: 'stdout', data })
  }
}

function writeStreamingStdout(data: string) {
  if (data) {
    post({ type: 'stdout', data })
  }
}

function writeStderr(data: string) {
  if (data) {
    if (activeCapture) {
      activeCapture.stderr += data
      return
    }
    post({ type: 'stderr', data })
  }
}

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/g, '')
}

function visibleWidth(value: string) {
  return stripAnsi(value).length
}

function resolvePath(input: string, cwd = state.cwd) {
  const raw = input || '.'

  const segments = (raw.startsWith('/') ? raw : `${cwd}/${raw}`).split('/')
  const normalized: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') {
      continue
    }
    if (segment === '..') {
      normalized.pop()
      continue
    }
    normalized.push(segment)
  }
  return `/${normalized.join('/')}`
}

function dirname(path: string) {
  if (path === '/') {
    return '/'
  }
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return `/${parts.join('/')}` || '/'
}

function basename(path: string) {
  if (path === '/') {
    return '/'
  }
  const parts = path.split('/').filter(Boolean)
  return parts.at(-1) ?? path
}

function fileSize(path: string) {
  return fsState.getFileBytes(path)?.byteLength ?? 0
}

function formatSize(bytes: number, humanReadable: boolean) {
  if (!humanReadable) {
    return String(bytes)
  }

  if (bytes < 1024) {
    return `${bytes}B`
  }

  const units = ['K', 'M', 'G', 'T']
  let value = bytes
  let unitIndex = -1
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded}${units[unitIndex]}`
}

function formatBlocks(path: string) {
  const blocks = Math.max(1, Math.ceil(fileSize(path) / 1024))
  return String(blocks)
}

function formatLsTime(path: string, full = false) {
  const timestamp = fsState.mtime(path)
  if (!timestamp) {
    return full ? '1970-01-01 00:00' : 'Jan 01 00:00'
  }
  const date = new Date(timestamp)
  if (full) {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${minutes}`
  }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const month = months[date.getMonth()]
  const day = String(date.getDate()).padStart(2, ' ')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${month} ${day} ${hours}:${minutes}`
}

function stableInode(path: string) {
  let hash = 2166136261
  for (const char of path) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash >>> 0)
}

function colorizeLsName(name: string, path: string) {
  if (name === '.' || name === '..') {
    return paint(name, ANSI.blue)
  }
  if (fsState.isDir(path)) {
    return paint(name, ANSI.blue)
  }
  return paint(name, ANSI.text)
}

function splitArgv(args: string[]) {
  const operands: string[] = []
  let parsingFlags = true
  for (const arg of args) {
    if (parsingFlags && arg === '--') {
      parsingFlags = false
      continue
    }
    operands.push(arg)
  }
  return { operands, parsingFlags }
}

function compareNames(left: string, right: string, versionSort: boolean) {
  return left.localeCompare(right, undefined, { numeric: versionSort, sensitivity: 'base' })
}

function parseEchoEscapes(input: string) {
  let output = ''
  let suppressNewline = false
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (char !== '\\') {
      output += char
      continue
    }

    const next = input[index + 1]
    if (next === undefined) {
      output += '\\'
      continue
    }
    index += 1

    switch (next) {
      case 'a':
        output += '\u0007'
        break
      case 'b':
        output += '\b'
        break
      case 'c':
        suppressNewline = true
        return { output, suppressNewline }
      case 'e':
        output += '\u001b'
        break
      case 'f':
        output += '\f'
        break
      case 'n':
        output += '\n'
        break
      case 'r':
        output += '\r'
        break
      case 't':
        output += '\t'
        break
      case 'v':
        output += '\v'
        break
      case '\\':
        output += '\\'
        break
      case 'x': {
        const hex = input.slice(index + 1, index + 3)
        if (/^[0-9a-fA-F]{1,2}$/.test(hex)) {
          output += String.fromCharCode(Number.parseInt(hex, 16))
          index += hex.length
        } else {
          output += 'x'
        }
        break
      }
      case '0': {
        const octal = input.slice(index, index + 4).match(/^0[0-7]{0,3}/)?.[0] ?? '0'
        output += String.fromCharCode(Number.parseInt(octal, 8))
        index += octal.length - 1
        break
      }
      default:
        output += next
        break
    }
  }
  return { output, suppressNewline }
}

function visualizeCatText(input: string, options: { showNonPrinting: boolean; showEnds: boolean; showTabs: boolean }) {
  const visualized: string[] = []
  for (const char of input) {
    if (char === '\n') {
      if (options.showEnds) {
        visualized.push('$')
      }
      visualized.push('\n')
      continue
    }
    if (char === '\t') {
      visualized.push(options.showTabs ? '^I' : '\t')
      continue
    }
    if (!options.showNonPrinting) {
      visualized.push(char)
      continue
    }
    const code = char.charCodeAt(0)
    if (code < 32) {
      visualized.push(`^${String.fromCharCode(code + 64)}`)
      continue
    }
    if (code === 127) {
      visualized.push('^?')
      continue
    }
    visualized.push(char)
  }
  return visualized.join('')
}

function escapeRegex(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function walkPaths(path: string): string[] {
  if (!fsState.exists(path)) {
    return []
  }
  if (fsState.isFile(path)) {
    return [path]
  }
  const files: string[] = []
  for (const entry of fsState.listDir(path) ?? []) {
    const child = resolvePath(entry, path)
    if (fsState.isDir(child)) {
      files.push(...walkPaths(child))
    } else {
      files.push(child)
    }
  }
  return files
}

const BUILTIN_COMMANDS = [
  'alias', 'bc', 'cd', 'clear', 'curl', 'env', 'export', 'getconf', 'grep', 'help', 'history', 'hostname', 'jq',
  'jsh', 'kill', 'less', 'neofetch', 'printenv', 'ps', 'pwd', 'python', 'tree', 'unset', 'uptime', 'which', 'xxd',
  'nix', 'apt', 'brew', 'yum', 'miku', 'sudo', 'su', 'pacman', 'starwars',
]
const BUILTIN_COMMAND_SET = new Set<string>(BUILTIN_COMMANDS)
const UUTILS_COMMAND_SET = new Set<string>(UUTILS_COMMANDS)
const ALL_COMMANDS = [...BUILTIN_COMMANDS, ...UUTILS_COMMANDS].sort((left, right) => left.localeCompare(right))
const COMPLETABLE_COMMANDS = ALL_COMMANDS
const CURL_SUPPORTED_ARG_SET = new Set<string>(CURL_SUPPORTED_ARGS)

function commonPrefix(values: string[]) {
  if (values.length === 0) {
    return ''
  }
  let prefix = values[0]
  for (const value of values.slice(1)) {
    while (!value.startsWith(prefix) && prefix) {
      prefix = prefix.slice(0, -1)
    }
  }
  return prefix
}

function completePathToken(
  token: string,
  directoriesOnly = false,
  quote: '"' | "'" | null = null,
) {
  const normalizedToken = token.replace(/^['"]/, '').replace(/['"]$/, '')
  const resolved = resolvePath(normalizedToken || '.', state.cwd)
  const parent = normalizedToken.endsWith('/') ? resolved : dirname(resolved)
  const base = normalizedToken.endsWith('/') ? '' : basename(resolved)
  if (!fsState.exists(parent) || !fsState.isDir(parent)) {
    return null
  }

  const quoteIfNeeded = (value: string) => {
    const needsQuoting = value.includes(' ')
    if (quote) {
      if (value.endsWith('/')) {
        return `${quote}${value}`
      }
      return `${quote}${value}${quote}`
    }
    return needsQuoting ? `"${value}"` : value
  }

  const typedPrefix =
    normalizedToken.length === 0
      ? ''
      : normalizedToken.endsWith('/')
        ? normalizedToken
        : normalizedToken.slice(0, Math.max(0, normalizedToken.length - base.length))

  const matches = (fsState.listDir(parent) ?? [])
    .filter((name) => name.startsWith(base))
    .filter((name) => !directoriesOnly || fsState.isDir(resolvePath(name, parent)))
    .map((name) => {
      const suffix = fsState.isDir(resolvePath(name, parent)) ? '/' : ''
      return `${typedPrefix}${name}${suffix}`
    })
  if (matches.length === 0) {
    return null
  }
  if (matches.length === 1) {
    const rawValue = matches[0]
    const quotedValue = quoteIfNeeded(rawValue)
    const value = rawValue.endsWith('/') ? quotedValue : `${quotedValue} `
    return { value, suggestions: undefined as string[] | undefined }
  }
  const prefix = commonPrefix(matches)
  if (prefix.length > normalizedToken.length) {
    return { value: quoteIfNeeded(prefix), suggestions: undefined as string[] | undefined }
  }
  return { value: token, suggestions: matches.map((match) => quoteIfNeeded(match)) }
}

function findCompletionTokenBounds(line: string, cursor: number) {
  let quote: '"' | "'" | null = null
  let tokenStart = 0

  for (let index = 0; index < cursor; index += 1) {
    const char = line[index]
    if ((char === '"' || char === "'") && (index === 0 || line[index - 1] !== '\\')) {
      if (quote === char) {
        quote = null
      } else if (quote === null) {
        quote = char
        tokenStart = index
      }
      continue
    }
    if ((char === ' ' || char === '\t') && quote === null) {
      tokenStart = index + 1
    }
  }

  return { tokenStart, quote }
}

function completeLine(line: string, cursor: number) {
  const left = line.slice(0, cursor)
  const right = line.slice(cursor)
  const { tokenStart, quote } = findCompletionTokenBounds(line, cursor)
  const token = left.slice(tokenStart)
  const words = left.trimStart().split(/\s+/).filter(Boolean)

  if (words.length === 0 || tokenStart === 0 && words.length <= 1) {
    const normalizedToken = token.replace(/^['"]/, '')
    const candidates = [...COMPLETABLE_COMMANDS, ...Object.keys(state.aliases)].filter((name) => name.startsWith(normalizedToken))
    if (candidates.length === 0) {
      return { line, cursor, suggestions: undefined as string[] | undefined }
    }
    const replacement = candidates.length === 1 ? `${candidates[0]} ` : commonPrefix(candidates)
    const suggestions = replacement.length > normalizedToken.length ? undefined : candidates
    return {
      line: `${left.slice(0, tokenStart)}${replacement}${right}`,
      cursor: tokenStart + replacement.length,
      suggestions,
    }
  }

  const command = words[0]
  const directoriesOnly = command === 'cd' || command === 'mkdir' || command === 'rmdir'
  const completed = completePathToken(token, directoriesOnly, quote)
  if (!completed) {
    return { line, cursor, suggestions: undefined as string[] | undefined }
  }
  return {
    line: `${left.slice(0, tokenStart)}${completed.value}${right}`,
    cursor: tokenStart + completed.value.length,
    suggestions: completed.suggestions,
  }
}

function readCommandInput(args: string[], stdin: string, commandName: string) {
  const inputs: Array<{ label: string; text: string }> = []
  if (args.length === 0) {
    inputs.push({ label: '(standard input)', text: stdin })
    return { inputs, error: null as RuntimeCommandResult | null }
  }
  for (const arg of args) {
    if (arg === '-') {
      inputs.push({ label: '(standard input)', text: stdin })
      continue
    }
    const target = resolvePath(arg)
    if (!fsState.exists(target) || !fsState.isFile(target)) {
      return {
        inputs: [],
        error: { stdout: '', stderr: `${commandName}: ${target}: no such file\n`, status: 1 } as RuntimeCommandResult,
      }
    }
    inputs.push({ label: target, text: fsState.getFileText(target) ?? '' })
  }
  return { inputs, error: null as RuntimeCommandResult | null }
}

function maybeReadStdin(stdin: string) {
  return stdin.length > 0 ? stdin : ''
}

async function persistHomeIfAllowed() {
  await fsState.saveToDb()
}

function seedHome() {
  fsState.root.contents.clear()
  fsState.touch('/')
  fsState.mkdirp('/')
  fsState.mkdirp('/bin')
  fsState.mkdirp('/tmp')
  fsState.mkdirp('/home')
  fsState.mkdirp(HOME_ROOT)

  for (const command of ALL_COMMANDS) {
    fsState.putFileText(
      `/bin/${command}`,
      `#!/bin/jsh-lite\n# builtin: ${command}\n`,
    )
  }

  fsState.putFileText(
    `${HOME_ROOT}/README.txt`,
    `${profile.handle}
${profile.fullName}

${profile.intro}

${profile.summary}
`,
  )

  fsState.putFileText(
    `${HOME_ROOT}/PROJECTS.txt`,
    projectArchive
      .map((project) => `${project.name}  ${project.language}  *${project.stars}\n${project.description}`)
      .join('\n\n'),
  )

  fsState.putFileText(
    `${HOME_ROOT}/FEATURED.txt`,
    featuredProjects
      .map((project) => `${project.name}\n${project.description}\n${project.reason}`)
      .join('\n\n'),
  )

  fsState.putFileText(
    `${HOME_ROOT}/welcome.py`,
    `print("Magniquick lab")\nprint("Filesystem root:", "${HOME_ROOT}")\n`,
  )

  fsState.putFileText(HISTORY_FILE, '')
}

function loadHistoryFromFile() {
  if (!fsState.exists(HISTORY_FILE) || !fsState.isFile(HISTORY_FILE)) {
    fsState.putFileText(HISTORY_FILE, '')
    state.history = []
    return
  }

  const contents = fsState.getFileText(HISTORY_FILE) ?? ''
  state.history = contents
    .split('\n')
    .filter((entry) => entry.length > 0)
}

function appendHistoryEntry(line: string) {
  const existing = fsState.exists(HISTORY_FILE) && fsState.isFile(HISTORY_FILE) ? fsState.getFileText(HISTORY_FILE) ?? '' : ''
  const suffix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
  fsState.putFileText(HISTORY_FILE, `${existing}${suffix}${line}\n`)
  state.history.push(line)
}

function clearPyodidePath(path: string) {
  if (!pyodide) {
    return
  }
  const FS = pyodide.FS
  try {
    const stat = FS.stat(path)
    if (FS.isDir(stat.mode)) {
      for (const entry of FS.readdir(path).filter((entry: string) => entry !== '.' && entry !== '..')) {
        clearPyodidePath(resolvePath(entry, path))
      }
      if (path !== '/') {
        FS.rmdir(path)
      }
      return
    }
    FS.unlink(path)
  } catch {
    // ignore missing path
  }
}

function syncTreeToPyodide() {
  if (!pyodide) {
    return
  }

  clearPyodidePath('/bin')
  clearPyodidePath('/tmp')
  clearPyodidePath('/home')

  const FS = pyodide.FS
  for (const { path, inode } of fsState.walk('/')) {
    if (path === '/') {
      continue
    }
    if (inode instanceof Directory) {
      FS.mkdirTree(path)
      continue
    }
    if (!(inode instanceof File)) {
      continue
    }
    FS.mkdirTree(dirname(path))
    FS.writeFile(path, inode.data)
  }
}

function syncPyodideCwd() {
  if (!pyodide) {
    return
  }
  if (!fsState.isDir(state.cwd)) {
    throw new Error(`${state.cwd}: no such directory`)
  }
  pyodide.FS.chdir(state.cwd)
}

function syncPyodideTreeToFsState(path: string) {
  if (!pyodide) {
    return
  }
  const FS = pyodide.FS
  const stat = FS.stat(path)
  if (FS.isDir(stat.mode)) {
    fsState.mkdirp(path)
    for (const entry of FS.readdir(path).filter((name: string) => name !== '.' && name !== '..')) {
      syncPyodideTreeToFsState(resolvePath(entry, path))
    }
    return
  }
  const data = FS.readFile(path) as Uint8Array
  fsState.putFile(path, data)
}

function syncPyodideToFsState() {
  if (!pyodide) {
    return
  }

  fsState.remove('/bin', { recursive: true })
  fsState.remove('/tmp', { recursive: true })
  fsState.remove('/home', { recursive: true })
  fsState.mkdirp('/')
  syncPyodideTreeToFsState('/bin')
  syncPyodideTreeToFsState('/tmp')
  syncPyodideTreeToFsState('/home')
}

async function bootstrapPython() {
  if (pyodide) {
    syncTreeToPyodide()
    syncPyodideCwd()
    return pyodide
  }

  if (pyodideBootPromise) {
    await pyodideBootPromise
    syncTreeToPyodide()
    syncPyodideCwd()
    if (!pyodide) {
      throw new Error('Python runtime failed to initialize')
    }
    return pyodide
  }

  pyodideBootPromise = (async () => {
    const { loadPyodide } = await import('pyodide')

    const maybeInterruptBuffer =
      typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)) : null
    interruptBuffer = maybeInterruptBuffer

    pyodide = await loadPyodide({
      env: {
        HOME: HOME_ROOT,
        TERM: state.env.TERM,
      },
      indexURL: PYODIDE_INDEX_URL,
      stdin: () => pendingStdIn.shift() ?? '\n',
    })

    pyodide.setStdout({
      raw: (charCode: number) => {
        writeStdout(String.fromCharCode(charCode))
      },
    })

    pyodide.setStderr({
      raw: (charCode: number) => {
        writeStderr(String.fromCharCode(charCode))
      },
    })

    if (interruptBuffer && typeof pyodide.setInterruptBuffer === 'function') {
      pyodide.setInterruptBuffer(interruptBuffer)
    }

    await pyodide.runPythonAsync(`
import code
import runpy

_magni_console = code.InteractiveConsole()

def _magni_push(line: str) -> bool:
    return _magni_console.push(line)

def _magni_run_path(path: str):
    runpy.run_path(path, run_name="__main__")
`)

    syncTreeToPyodide()
    syncPyodideCwd()

    return pyodide
  })()

  try {
    await pyodideBootPromise
    if (!pyodide) {
      throw new Error('Python runtime failed to initialize')
    }
    return pyodide
  } finally {
    pyodideBootPromise = null
  }
}

function resetSessionState() {
  state.cwd = HOME_ROOT
  state.env = {
    HOME: HOME_ROOT,
    PWD: HOME_ROOT,
    OLDPWD: HOME_ROOT,
    USER: USERNAME,
    SHELL: '/bin/jsh-lite',
    TERM: 'xterm-256color',
    HOSTNAME: DEFAULT_HOSTNAME,
  }
  state.aliases = {
    ll: 'ls',
    python3: 'python',
  }
  state.mode = 'shell'
  state.pythonContinuation = false
  state.lessLines = []
  state.lessOffset = 0
}

function expandAlias(line: string) {
  let expanded = line
  const seen = new Set<string>()

  for (;;) {
    const trimmed = expanded.trimStart()
    const first = trimmed.split(/\s+/, 1)[0]
    if (!first || !state.aliases[first] || seen.has(first)) {
      return expanded
    }
    seen.add(first)
    expanded = `${state.aliases[first]}${trimmed.slice(first.length)}`
  }
}

async function parseShellAst(line: string): Promise<AstNode | null> {
  shellParserPromise ??= initBrushParser(brushParserWasmUrl).then(() => undefined)
  await shellParserPromise
  return parseBrushShell(line, state.env, HOME_ROOT) as AstNode | null
}

function matchesGlob(name: string, pattern: string) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(name)
}

function expandGlobs(word: string) {
  if (!word.includes('*')) {
    return [word]
  }
  const targetPath = resolvePath(word)
  const parentPath = dirname(targetPath)
  const pattern = basename(targetPath)

  if (!fsState.exists(parentPath) || !fsState.isDir(parentPath)) {
    return [word]
  }

  const matches = (fsState.listDir(parentPath) ?? [])
    .filter((entry) => matchesGlob(entry, pattern))
    .map((entry) => {
      const fullPath = resolvePath(entry, parentPath)
      if (word.startsWith('/')) {
        return fullPath
      }
      const relativeParent = parentPath === state.cwd ? '.' : parentPath.startsWith(`${state.cwd}/`) ? parentPath.slice(state.cwd.length + 1) : fullPath
      return relativeParent === '.'
        ? entry
        : `${relativeParent.replace(/^\.\//, '')}/${entry}`.replace(/^\.\//, '')
    })

  return matches.length > 0 ? matches : [word]
}

function evaluateArithmeticExpression(expression: string, opts: { integer?: boolean } = {}): number {
  const withVariables = expression.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, (name) => {
    const value = Number.parseInt(state.env[name] ?? '0', 10)
    return Number.isFinite(value) ? String(value) : '0'
  })
  if (!/^[\d\s()+\-*/%<>=!&|^~?:.,]+$/.test(withVariables)) {
    throw new Error(`unsupported arithmetic expression: ${expression}`)
  }
  // Bash arithmetic and JavaScript share the operators this shell accepts here.
  const result = Function(`"use strict"; return Number((${withVariables}))`)()
  if (typeof result !== 'number' || Number.isNaN(result)) {
    return 0
  }
  return opts.integer ? Math.trunc(result) : result
}

async function executeAst(node: AstNode, stdin = ''): Promise<RuntimeCommandResult> {
  if (node.type === 'sequence') {
    let result: RuntimeCommandResult = { stdout: '', stderr: '', status: 0 }
    for (const child of node.nodes) {
      result = await executeAst(child, '')
      if (result.stdout) {
        writeStdout(result.stdout)
      }
      if (result.stderr) {
        writeStderr(result.stderr)
      }
      if (result.clear) {
        post({ type: 'clear' })
      }
    }
    return { stdout: '', stderr: '', status: result.status }
  }

  if (node.type === 'arithmetic') {
    try {
      return { stdout: '', stderr: '', status: evaluateArithmeticExpression(node.expression, { integer: true }) === 0 ? 1 : 0 }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { stdout: '', stderr: `${message}\n`, status: 1 }
    }
  }

  if (node.type === 'logical') {
    const left = await executeAst(node.left, stdin)
    if (node.op === '&&' && left.status !== 0) {
      return left
    }
    if (node.op === '||' && left.status === 0) {
      return left
    }
    return await executeAst(node.right, '')
  }

  let pipeInput = stdin
  let lastResult: RuntimeCommandResult = { stdout: '', stderr: '', status: 0 }
  for (const command of node.commands) {
    lastResult = await executeCommand(command, pipeInput)
    pipeInput = lastResult.stdout
    if (lastResult.stderr && node.commands.length > 1) {
      writeStderr(lastResult.stderr)
      lastResult = { ...lastResult, stderr: '' }
    }
    if (lastResult.status !== 0) {
      break
    }
  }
  return lastResult
}

async function executeCommand(command: CommandNode, stdin: string): Promise<RuntimeCommandResult> {
  const expandedWords = command.words.flatMap(expandGlobs)
  const redirections = command.redirections.map((entry) => ({
    ...entry,
    target: resolvePath(entry.target),
  }))

  let input = stdin
  for (const redirect of redirections) {
    if (redirect.op === '<') {
      if (!fsState.exists(redirect.target)) {
        return { stdout: '', stderr: `<: ${redirect.target}: no such file\n`, status: 1 }
      }
      input = fsState.getFileText(redirect.target) ?? ''
    }
  }

  const previousCapture = activeCapture
  activeCapture = { stdout: '', stderr: '' }

  let result: RuntimeCommandResult
  let buffered = activeCapture
  try {
    result = await runSimpleCommand(expandedWords, input)
  } finally {
    buffered = activeCapture
    activeCapture = previousCapture
  }

  result = {
    ...result,
    stdout: `${result.stdout}${buffered?.stdout ?? ''}`,
    stderr: `${result.stderr}${buffered?.stderr ?? ''}`,
  }

  let wroteRedirect = false
  for (const redirect of redirections) {
    if (redirect.op === '>' || redirect.op === '>>') {
      const previous = redirect.op === '>>' && fsState.exists(redirect.target) ? fsState.getFileText(redirect.target) ?? '' : ''
      fsState.putFileText(redirect.target, `${previous}${result.stdout}`)
      result = { ...result, stdout: '' }
      wroteRedirect = true
    }
  }

  if (result.status === 0 && (wroteRedirect || didMutateFilesystem(expandedWords))) {
    await persistHomeIfAllowed()
  }

  return result
}

function didMutateFilesystem(words: string[]) {
  const command = unwrapEnvCommand(words) ?? ''
  if (['mkdir', 'touch', 'rm', 'cp', 'mv', 'python', 'rmdir', 'ln', 'chmod'].includes(command)) {
    return true
  }
  if (command === 'curl') {
    return words.includes('-o') || words.includes('--output')
  }
  return false
}

function unwrapEnvCommand(words: string[]) {
  if ((words[0] ?? '') !== 'env') {
    return words[0]
  }

  let index = 1
  while (index < words.length) {
    const word = words[index]
    if (word === '-u') {
      index += 2
      continue
    }
    if (word.includes('=') && !word.startsWith('=')) {
      index += 1
      continue
    }
    return word
  }

  return 'env'
}

async function runSimpleCommand(words: string[], stdin: string): Promise<RuntimeCommandResult> {
  if (words.length === 0) {
    return { stdout: '', stderr: '', status: 0 }
  }

  const [command, ...args] = words
  if (['nix', 'apt', 'brew', 'yum', 'miku', 'sudo', 'su', 'pacman', 'starwars'].includes(command)) {
    const serialAtStart = interruptSerial
    const result = await runJokeCommand(
      command,
      writeStreamingStdout,
      state.cols,
      state.rows,
      () => interruptSerial !== serialAtStart,
    )
    if (result) {
      return result
    }
  }

  if (UUTILS_COMMAND_SET.has(command) && !BUILTIN_COMMAND_SET.has(command)) {
    return await runWasiTool(command, args, stdin, state.cwd)
  }

  switch (command) {
    case 'pwd':
      return { stdout: `${state.cwd}\n`, stderr: '', status: 0 }
    case 'cd':
      return builtinCd(args)
    case 'bc':
      return builtinBc(args, stdin)
    case 'tree':
      return builtinTree(args)
    case 'less':
      return builtinLess(args, stdin)
    case 'grep':
      return builtinGrep(args, stdin)
    case 'which':
      return builtinWhich(args)
    case 'hostname':
      return builtinHostname(args)
    case 'uptime':
      return builtinUptime()
    case 'neofetch':
      return builtinNeofetch()
    case 'getconf':
      return builtinGetconf(args)
    case 'xxd':
      return builtinXxd(args, stdin)
    case 'jq':
      return builtinJq(args, stdin)
    case 'curl':
      return await builtinCurl(args, stdin)
    case 'jsh':
      return await builtinJsh(args, stdin)
    case 'ps':
      return builtinPs()
    case 'kill':
      return builtinKill(args)
    case 'env':
      return await builtinEnv(args, stdin)
    case 'printenv':
      return builtinPrintenv(args)
    case 'export':
      return builtinExport(args)
    case 'unset':
      return builtinUnset(args)
    case 'clear':
      return { stdout: '', stderr: '', status: 0, clear: true }
    case 'help':
      return { stdout: HELP_TEXT, stderr: '', status: 0 }
    case 'alias':
      return builtinAlias(args)
    case 'history':
      return {
        stdout: `${state.history.map((entry, index) => `${index + 1}  ${entry}`).join('\n')}\n`,
        stderr: '',
        status: 0,
      }
    case 'python':
      return await builtinPython(args, stdin)
    default:
      return { stdout: '', stderr: `${command}: command not found\n`, status: 127 }
  }
}

function builtinCd(args: string[]): RuntimeCommandResult {
  let physical = false
  const operands: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') {
      operands.push(...args.slice(index + 1))
      break
    }
    if (arg === '-L') {
      physical = false
      continue
    }
    if (arg === '-P') {
      physical = true
      continue
    }
    if (arg.startsWith('-') && arg !== '-') {
      return { stdout: '', stderr: `cd: invalid option -- ${arg.slice(1)}\n`, status: 1 }
    }
    operands.push(arg)
  }

  if (operands.length > 1) {
    return { stdout: '', stderr: 'cd: too many arguments\n', status: 1 }
  }

  const requested = operands[0] ?? HOME_ROOT
  const target = requested === '-' ? state.env.OLDPWD || HOME_ROOT : resolvePath(requested ?? HOME_ROOT)
  if (!fsState.exists(target) || !fsState.isDir(target)) {
    return { stdout: '', stderr: `cd: ${target}: no such directory\n`, status: 1 }
  }
  const previous = state.cwd
  state.cwd = target
  state.env.OLDPWD = previous
  state.env.PWD = target
  if (physical) {
    state.env.PWD = resolvePath(target, '/')
  }
  return { stdout: requested === '-' ? `${target}\n` : '', stderr: '', status: 0 }
}

function formatBcNumber(value: number) {
  if (!Number.isFinite(value)) {
    return String(value)
  }
  if (Object.is(value, -0)) {
    return '0'
  }
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)))
}

function runBcSource(source: string) {
  const output: string[] = []
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    for (const expression of line.split(';').map((part) => part.trim()).filter(Boolean)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(expression)) {
        continue
      }
      output.push(formatBcNumber(evaluateArithmeticExpression(expression)))
    }
  }
  return output
}

function builtinBc(args: string[], stdin: string): RuntimeCommandResult {
  const operands: string[] = []
  for (const arg of args) {
    if (arg === '-q' || arg === '-l') {
      continue
    }
    if (arg.startsWith('-')) {
      return { stdout: '', stderr: `bc: unsupported option ${arg}\n`, status: 1 }
    }
    operands.push(arg)
  }

  const { inputs, error } = readCommandInput(operands, stdin, 'bc')
  if (error) {
    return error
  }

  try {
    const lines = inputs.flatMap((input) => runBcSource(input.text))
    return { stdout: lines.length > 0 ? `${lines.join('\n')}\n` : '', stderr: '', status: 0 }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { stdout: '', stderr: `bc: ${message}\n`, status: 1 }
  }
}

function builtinTree(args: string[]): RuntimeCommandResult {
  let showAll = false
  const targets: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') {
      targets.push(...args.slice(index + 1))
      break
    }
    if (arg.startsWith('-') && arg !== '-') {
      for (const flag of arg.slice(1)) {
        if (flag === 'a') {
          showAll = true
          continue
        }
        return { stdout: '', stderr: `tree: invalid option -- ${flag}\n`, status: 1 }
      }
      continue
    }
    targets.push(arg)
  }

  const target = resolvePath(targets[0] ?? '.')
  if (!fsState.exists(target)) {
    return { stdout: '', stderr: `tree: ${target}: No such file or directory\n`, status: 1 }
  }

  let directoryCount = 0
  let fileCount = 0
  const lines: string[] = []

  const renderNode = (path: string, prefix: string, isLast: boolean) => {
    const name = basename(path)
    const branch = prefix ? `${prefix}${isLast ? '└── ' : '├── '}` : ''
    lines.push(`${branch}${colorizeLsName(name, path)}`)

    if (fsState.isDir(path)) {
      directoryCount += 1
      const childEntries = (fsState.listDir(path) ?? [])
        .filter((entry) => showAll || !entry.startsWith('.'))
        .map((entry) => resolvePath(entry, path))
        .sort((left, right) => compareNames(basename(left), basename(right), false))

      const nextPrefix = prefix ? `${prefix}${isLast ? '    ' : '│   '}` : ''
      childEntries.forEach((childPath, childIndex) => {
        renderNode(childPath, nextPrefix, childIndex === childEntries.length - 1)
      })
      return
    }

    fileCount += 1
  }

  if (fsState.isDir(target)) {
    renderNode(target, '', true)
  } else {
    lines.push(colorizeLsName(basename(target), target))
    fileCount = 1
  }

  lines.push('')
  lines.push(`${directoryCount} director${directoryCount === 1 ? 'y' : 'ies'}, ${fileCount} file${fileCount === 1 ? '' : 's'}`)

  return { stdout: `${lines.join('\n')}\n`, stderr: '', status: 0 }
}

function builtinGrep(args: string[], stdin: string): RuntimeCommandResult {
  let ignoreCase = false
  let lineNumbers = false
  let countOnly = false
  let listMatching = false
  let listNonMatching = false
  let onlyMatching = false
  let quiet = false
  let suppressErrors = false
  let invertMatch = false
  let wordRegexp = false
  let lineRegexp = false
  let recursive = false
  let fixedStrings = false
  let extended = false
  let noFilename = false
  let withFilename = false
  let maxCount: number | null = null
  const patterns: string[] = []
  const targets: string[] = []
  let stopFlags = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!stopFlags && arg === '--') {
      stopFlags = true
      continue
    }
    if (!stopFlags && arg.startsWith('-') && arg !== '-') {
      if (arg === '-e' || arg === '-f' || arg === '-m') {
        const value = args[index + 1]
        if (!value) {
          return { stdout: '', stderr: `grep: option requires an argument -- ${arg.slice(1)}\n`, status: 2 }
        }
        if (arg === '-e') {
          patterns.push(value)
        } else if (arg === '-f') {
          const path = resolvePath(value)
          if (!fsState.exists(path) || !fsState.isFile(path)) {
            return { stdout: '', stderr: `grep: ${path}: no such file\n`, status: 2 }
          }
          patterns.push(
            ...(fsState.getFileText(path) ?? '')
              .split('\n')
              .filter(Boolean),
          )
        } else {
          maxCount = Number.parseInt(value, 10)
          if (!Number.isFinite(maxCount) || maxCount < 0) {
            return { stdout: '', stderr: `grep: invalid max count -- ${value}\n`, status: 2 }
          }
        }
        index += 1
        continue
      }

      for (const flag of arg.slice(1)) {
        if (flag === 'i') ignoreCase = true
        else if (flag === 'n') lineNumbers = true
        else if (flag === 'c') countOnly = true
        else if (flag === 'l') listMatching = true
        else if (flag === 'L') listNonMatching = true
        else if (flag === 'o') onlyMatching = true
        else if (flag === 'q') quiet = true
        else if (flag === 's') suppressErrors = true
        else if (flag === 'v') invertMatch = true
        else if (flag === 'w') wordRegexp = true
        else if (flag === 'x') lineRegexp = true
        else if (flag === 'r' || flag === 'R') recursive = true
        else if (flag === 'F') fixedStrings = true
        else if (flag === 'E') extended = true
        else if (flag === 'h') noFilename = true
        else if (flag === 'H') withFilename = true
        else if (flag === 'm') {
          const value = args[index + 1]
          if (!value) {
            return { stdout: '', stderr: 'grep: option requires an argument -- m\n', status: 2 }
          }
          maxCount = Number.parseInt(value, 10)
          if (!Number.isFinite(maxCount) || maxCount < 0) {
            return { stdout: '', stderr: `grep: invalid max count -- ${value}\n`, status: 2 }
          }
          index += 1
          break
        } else if (flag === 'e' || flag === 'f') {
          const value = args[index + 1]
          if (!value) {
            return { stdout: '', stderr: `grep: option requires an argument -- ${flag}\n`, status: 2 }
          }
          if (flag === 'e') {
            patterns.push(value)
          } else {
            const path = resolvePath(value)
            if (!fsState.exists(path) || !fsState.isFile(path)) {
              return { stdout: '', stderr: `grep: ${path}: no such file\n`, status: 2 }
            }
            patterns.push(
              ...(fsState.getFileText(path) ?? '')
                .split('\n')
                .filter(Boolean),
            )
          }
          index += 1
          break
        } else {
          return { stdout: '', stderr: `grep: invalid option -- ${flag}\n`, status: 2 }
        }
      }
      continue
    }
    targets.push(arg)
  }

  if (patterns.length === 0) {
    if (targets.length === 0) {
      return { stdout: '', stderr: 'grep: missing pattern\n', status: 2 }
    }
    patterns.push(targets.shift()!)
  }

  const regexes = patterns.map((pattern) => {
    const source = fixedStrings ? escapeRegex(pattern) : pattern
    const wrapped = `${wordRegexp ? '\\b' : ''}${lineRegexp ? '^' : ''}${source}${lineRegexp ? '$' : ''}${wordRegexp ? '\\b' : ''}`
    return new RegExp(wrapped, ignoreCase ? 'gi' : 'g')
  })

  const inputs: Array<{ label: string; text: string }> = []
  if (targets.length === 0) {
    inputs.push({ label: '(standard input)', text: stdin })
  } else {
    for (const rawTarget of targets) {
      const target = resolvePath(rawTarget)
      if (!fsState.exists(target)) {
        if (!suppressErrors) {
          return { stdout: '', stderr: `grep: ${target}: no such file or directory\n`, status: 2 }
        }
        continue
      }
      if (fsState.isDir(target)) {
        if (!recursive) {
          if (!suppressErrors) {
            return { stdout: '', stderr: `grep: ${target}: Is a directory\n`, status: 2 }
          }
          continue
        }
        for (const file of walkPaths(target)) {
          inputs.push({ label: file, text: fsState.getFileText(file) ?? '' })
        }
        continue
      }
      inputs.push({ label: target, text: fsState.getFileText(target) ?? '' })
    }
  }

  const showFilename = withFilename || (!noFilename && inputs.length > 1)
  const output: string[] = []
  let hadMatch = false

  for (const input of inputs) {
    let matchedLines = 0
    const perFileOutput: string[] = []
    const lines = input.text.split('\n')
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]
      let lineMatched = false
      const lineMatches: string[] = []
      for (const regex of regexes) {
        regex.lastIndex = 0
        if (onlyMatching) {
          for (const match of line.matchAll(regex)) {
            lineMatches.push(match[0])
          }
          if (lineMatches.length > 0) {
            lineMatched = true
          }
        } else if (regex.test(line)) {
          lineMatched = true
        }
      }
      if (invertMatch) {
        lineMatched = !lineMatched
      }
      if (!lineMatched) {
        continue
      }
      hadMatch = true
      matchedLines += 1
      if (maxCount !== null && matchedLines > maxCount) {
        break
      }
      if (quiet) {
        return { stdout: '', stderr: '', status: 0 }
      }
      if (listMatching || listNonMatching) {
        continue
      }
      const prefixParts = [showFilename ? input.label : null, lineNumbers ? String(lineIndex + 1) : null].filter(Boolean)
      const prefix = prefixParts.length > 0 ? `${prefixParts.join(':')}:` : ''
      if (countOnly) {
        continue
      }
      if (onlyMatching && !invertMatch) {
        for (const match of lineMatches) {
          perFileOutput.push(`${prefix}${match}`)
        }
      } else {
        perFileOutput.push(`${prefix}${line}`)
      }
    }

    if (listMatching && matchedLines > 0) {
      output.push(input.label)
      continue
    }
    if (listNonMatching && matchedLines === 0) {
      output.push(input.label)
      continue
    }
    if (countOnly) {
      const prefix = showFilename ? `${input.label}:` : ''
      output.push(`${prefix}${matchedLines}`)
      continue
    }
    output.push(...perFileOutput)
  }

  return { stdout: output.length > 0 ? `${output.join('\n')}\n` : '', stderr: '', status: hadMatch ? 0 : 1 }
}

function builtinWhich(args: string[]): RuntimeCommandResult {
  if (args.length === 0) {
    return { stdout: '', stderr: 'which: missing operand\n', status: 1 }
  }
  const builtins = new Set(ALL_COMMANDS)
  const lines: string[] = []
  let status = 0
  for (const name of args) {
    if (state.aliases[name]) {
      lines.push(`${name}: aliased to ${state.aliases[name]}`)
    } else if (builtins.has(name)) {
      lines.push(`/bin/${name}`)
    } else {
      status = 1
    }
  }
  return { stdout: lines.length > 0 ? `${lines.join('\n')}\n` : '', stderr: '', status }
}

function builtinHostname(args: string[]): RuntimeCommandResult {
  if (args.length === 0) {
    return { stdout: `${state.env.HOSTNAME ?? DEFAULT_HOSTNAME}\n`, stderr: '', status: 0 }
  }
  state.env.HOSTNAME = args[0]
  return { stdout: '', stderr: '', status: 0 }
}

function builtinUptime(): RuntimeCommandResult {
  const seconds = Math.floor((Date.now() - BOOT_TIME) / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remaining = seconds % 60
  return { stdout: `up ${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}\n`, stderr: '', status: 0 }
}

function builtinNeofetch(): RuntimeCommandResult {
  const uptime = builtinUptime().stdout.trim()
  const art = [
    { text: '        /\\', color: ANSI.blue },
    { text: '       /  \\\\', color: ANSI.blue },
    { text: '      / /\\ \\\\', color: ANSI.cyan },
    { text: '     / ____ \\\\', color: ANSI.cyan },
    { text: '    /_/    \\_\\\\', color: ANSI.pink },
    { text: '      magniquick', color: ANSI.yellow },
  ]
  const info = [
    ['user', `${DEFAULT_PROMPT_USER}@${state.env.HOSTNAME ?? DEFAULT_HOSTNAME}`],
    ['os', 'Magniquick Runtime Lab'],
    ['host', 'Browser Worker / Shared VFS'],
    ['shell', state.env.SHELL],
    ['term', 'xterm.js'],
    ['python', 'Pyodide'],
    ['uptime', uptime],
    ['langs', profile.stats.find((stat) => stat.label === 'Primary lanes')?.value ?? 'Python / Go / Rust / TS'],
    ['cwd', state.cwd],
  ] as const
  const leftWidth = Math.max(...art.map((entry) => entry.text.length)) + 4
  const labelWidth = Math.max(...info.map(([label]) => label.length))
  const formatInfo = (label: string, value: string) =>
    `${paint(label.padEnd(labelWidth, ' '), ANSI.pink)}${paint(' : ', ANSI.dim)}${paint(value, ANSI.text)}`
  const lines = Array.from({ length: Math.max(art.length, info.length) }, (_, index) => {
    const leftEntry = art[index]
    const left = leftEntry
      ? `${paint(leftEntry.text, leftEntry.color)}${' '.repeat(leftWidth - leftEntry.text.length)}`
      : ' '.repeat(leftWidth)
    const rightEntry = info[index]
    const right = rightEntry ? formatInfo(rightEntry[0], rightEntry[1]) : ''
    return `${left}${right}`
  })
  const swatches = [
    ANSI.pink,
    ANSI.cyan,
    ANSI.blue,
    ANSI.green,
    ANSI.yellow,
    ANSI.text,
  ]
  lines.push('')
  lines.push(swatches.map((color) => `${color}██${ANSI.reset}`).join(' '))
  return { stdout: `${lines.join('\n')}\n`, stderr: '', status: 0 }
}

function builtinGetconf(args: string[]): RuntimeCommandResult {
  if (args.length === 0) {
    return { stdout: '', stderr: 'getconf: missing operand\n', status: 1 }
  }
  const table: Record<string, string> = {
    ARG_MAX: '2097152',
    PATH: '/bin:/usr/bin',
    PAGESIZE: '4096',
    PAGE_SIZE: '4096',
    _NPROCESSORS_ONLN: '1',
    HOST_NAME_MAX: '255',
  }
  const key = args[0]
  if (!(key in table)) {
    return { stdout: '', stderr: `getconf: unspecified variable '${key}'\n`, status: 1 }
  }
  return { stdout: `${table[key]}\n`, stderr: '', status: 0 }
}

function builtinXxd(args: string[], stdin: string): RuntimeCommandResult {
  const source = args[0]
  let text = maybeReadStdin(stdin)
  if (source && source !== '-') {
    const target = resolvePath(source)
    if (!fsState.exists(target) || !fsState.isFile(target)) {
      return { stdout: '', stderr: `xxd: ${target}: No such file\n`, status: 1 }
    }
    text = fsState.getFileText(target) ?? ''
  }
  const bytes = new TextEncoder().encode(text)
  const lines: string[] = []
  for (let index = 0; index < bytes.length; index += 16) {
    const chunk = bytes.slice(index, index + 16)
    const hex = Array.from(chunk, (value) => value.toString(16).padStart(2, '0')).join(' ')
    const ascii = Array.from(chunk, (value) => (value >= 32 && value <= 126 ? String.fromCharCode(value) : '.')).join('')
    lines.push(`${index.toString(16).padStart(8, '0')}: ${hex.padEnd(47, ' ')}  ${ascii}`)
  }
  return { stdout: `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`, stderr: '', status: 0 }
}

function parseJqFilter(filter: string, value: unknown): unknown {
  if (filter === '.' || filter === '') {
    return value
  }
  if (!filter.startsWith('.')) {
    throw new Error(`unsupported jq filter: ${filter}`)
  }
  let current: unknown = value
  const path = filter.slice(1)
  const tokens = path.match(/([A-Za-z0-9_-]+)|\[(\d+)\]/g) ?? []
  for (const token of tokens) {
    if (token.startsWith('[')) {
      const index = Number.parseInt(token.slice(1, -1), 10)
      if (!Array.isArray(current)) {
        return null
      }
      current = current[index]
    } else {
      if (current === null || typeof current !== 'object') {
        return null
      }
      current = (current as Record<string, unknown>)[token]
    }
  }
  return current
}

function builtinJq(args: string[], stdin: string): RuntimeCommandResult {
  let raw = false
  const operands: string[] = []
  for (const arg of args) {
    if (arg === '-r') {
      raw = true
      continue
    }
    operands.push(arg)
  }
  if (operands.length === 0) {
    return { stdout: '', stderr: 'jq: missing filter\n', status: 1 }
  }
  const filter = operands[0]
  const { inputs, error } = readCommandInput(operands.slice(1), stdin, 'jq')
  if (error) {
    return error
  }
  const source = inputs.length > 0 ? inputs[0].text : stdin
  try {
    const parsed = JSON.parse(source)
    const result = parseJqFilter(filter, parsed)
    if (raw && typeof result === 'string') {
      return { stdout: `${result}\n`, stderr: '', status: 0 }
    }
    return { stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: '', status: 0 }
  } catch (error) {
    return { stdout: '', stderr: `jq: ${error instanceof Error ? error.message : String(error)}\n`, status: 1 }
  }
}

async function builtinCurl(args: string[], _stdin: string): Promise<RuntimeCommandResult> {
  try {
    const warnings: Warnings = []
    const argv = ['curl', ...args].map((arg) => new Word(arg))
    const [globalConfig] = parseArgs(argv, curlLongOpts, curlLongOptsShortened, curlShortOpts, CURL_SUPPORTED_ARG_SET, warnings)
    const parsedRequests = buildRequests(globalConfig)
    const requestConfig = getFirst(parsedRequests, warnings)
    const requestUrl = requestConfig.urls[0]
    const request: CurlRequest = {
      url: requestUrl.url.toString().replace(/\/$/, ''),
      method: requestUrl.method.toString().toLowerCase(),
    }
    if (requestConfig.headers.length) {
      request.headers = Object.fromEntries(
        requestConfig.headers.headers
          .filter((header) => header[1] !== null)
          .map((header) => [header[0].toString(), header[1]?.toString() ?? null]),
      )
    }
    if (requestConfig.data) {
      request.data = requestConfig.data.toString()
    }
    if (requestConfig.include) {
      request.include = true
    }
    if (requestUrl.auth) {
      request.auth = { user: requestUrl.auth[0].toString(), password: requestUrl.auth[1].toString() }
    }
    if (Object.prototype.hasOwnProperty.call(requestConfig, 'followRedirects')) {
      request.follow_redirects = requestConfig.followRedirects
    }
    if (requestConfig.timeout) {
      request.timeout = Number.parseFloat(requestConfig.timeout.toString())
    }
    if (requestConfig.connectTimeout) {
      request.connect_timeout = Number.parseFloat(requestConfig.connectTimeout.toString())
    }
    if (requestUrl.output) {
      request.output = requestUrl.output.toString()
    }

    if (!request.url) {
      return { stdout: '', stderr: 'curl: no URL specified\n', status: 2 }
    }

    const method = request.method.toUpperCase()
    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers ?? {})) {
      if (value !== null) {
        headers.set(key, value)
      }
    }
    if (request.auth && !headers.has('authorization')) {
      headers.set('authorization', `Basic ${btoa(`${request.auth.user}:${request.auth.password}`)}`)
    }

    const controller = new AbortController()
    const timeoutSeconds = request.timeout ?? request.connect_timeout
    const timeout = timeoutSeconds ? setTimeout(() => controller.abort(), timeoutSeconds * 1000) : null
    const response = await fetch(request.url, {
      body: method === 'GET' || method === 'HEAD' ? undefined : request.data === undefined ? undefined : String(request.data),
      cache: 'no-store',
      method,
      headers,
      redirect: request.follow_redirects ? 'follow' : 'manual',
      signal: controller.signal,
    }).finally(() => {
      if (timeout) {
        clearTimeout(timeout)
      }
    })

    let output = ''
    if (request.include || method === 'HEAD') {
      output += `HTTP ${response.status} ${response.statusText}\n`
      response.headers.forEach((value, key) => {
        output += `${key}: ${value}\n`
      })
      output += '\n'
    }
    if (method !== 'HEAD') {
      output += await response.text()
    }

    if (request.output) {
      fsState.putFileText(resolvePath(request.output), output)
      return { stdout: '', stderr: '', status: response.ok ? 0 : 22 }
    }
    return { stdout: output, stderr: '', status: response.ok ? 0 : 22 }
  } catch (error) {
    return { stdout: '', stderr: `curl: ${error instanceof Error ? error.message : String(error)}\n`, status: 6 }
  }
}

async function builtinJsh(args: string[], stdin: string): Promise<RuntimeCommandResult> {
  if (args.length === 0) {
    return { stdout: '', stderr: '', status: 0 }
  }
  if (args[0] === '-c') {
    const command = args.slice(1).join(' ')
    if (!command) {
      return { stdout: '', stderr: 'jsh: option requires an argument -- c\n', status: 1 }
    }
    return await handleShellLine(command)
  }
  return { stdout: '', stderr: `jsh: unsupported option ${args[0]}\n`, status: 1 }
}

function builtinPs(): RuntimeCommandResult {
  const lines = ['PID TTY          TIME CMD', '1 pts/0    00:00:00 jsh-lite']
  if (state.mode === 'python') {
    lines.push('2 pts/0    00:00:00 python')
  }
  return { stdout: `${lines.join('\n')}\n`, stderr: '', status: 0 }
}

function builtinKill(args: string[]): RuntimeCommandResult {
  if (args.length === 0) {
    return { stdout: '', stderr: 'kill: usage: kill PID...\n', status: 1 }
  }
  if (args[0] === '-l') {
    return { stdout: 'HUP INT QUIT KILL TERM\n', stderr: '', status: 0 }
  }
  for (const pid of args) {
    if (pid === '2' && state.mode === 'python') {
      if (interruptBuffer) {
        Atomics.store(interruptBuffer, 0, 2)
      }
      state.mode = 'shell'
      state.pythonContinuation = false
      continue
    }
    if (pid !== '1') {
      return { stdout: '', stderr: `kill: ${pid}: no such process\n`, status: 1 }
    }
  }
  return { stdout: '', stderr: '', status: 0 }
}

function renderLessPage() {
  const pageSize = Math.max(1, state.rows - 2)
  const page = state.lessLines.slice(state.lessOffset, state.lessOffset + pageSize).join('\n')
  const suffix = page ? '\n' : ''
  const nextOffset = state.lessOffset + pageSize
  const percent = state.lessLines.length === 0 ? 100 : Math.min(100, Math.round((Math.min(nextOffset, state.lessLines.length) / state.lessLines.length) * 100))
  const modeLabel = nextOffset < state.lessLines.length ? '-- less --' : '-- end --'
  const footer = `\n${paint(modeLabel, ANSI.pink)} ${paint(`${percent}%`, ANSI.yellow)} ${paint('(space: next, enter: line, b: back, g/G: ends, q: quit)', ANSI.dim)}\n`

  return `${page}${suffix}${footer}`
}

function findLessMatchOffset(pattern: string, startOffset: number, direction: 1 | -1 = 1) {
  if (!pattern) {
    return null
  }

  const regex = new RegExp(pattern, 'i')
  if (direction === 1) {
    for (let index = Math.max(0, startOffset); index < state.lessLines.length; index += 1) {
      if (regex.test(state.lessLines[index])) {
        return index
      }
    }
  } else {
    for (let index = Math.min(state.lessLines.length - 1, startOffset); index >= 0; index -= 1) {
      if (regex.test(state.lessLines[index])) {
        return index
      }
    }
  }

  return null
}

function builtinLess(args: string[], stdin: string): RuntimeCommandResult {
  let contents = ''

  if (args.length === 0) {
    contents = stdin
  } else {
    const target = resolvePath(args[0])
    if (!fsState.exists(target) || !fsState.isFile(target)) {
      return { stdout: '', stderr: `less: ${target}: no such file\n`, status: 1 }
    }
    contents = fsState.getFileText(target) ?? ''
  }

  if (!contents) {
    return { stdout: '', stderr: 'less: nothing to display\n', status: 1 }
  }

  state.mode = 'less'
  state.lessLines = contents.replace(/\r\n/g, '\n').split('\n')
  if (state.lessLines.at(-1) === '') {
    state.lessLines.pop()
  }
  state.lessOffset = 0
  state.lessSearch = ''
  return { stdout: renderLessPage(), stderr: '', status: 0 }
}

function builtinPrintenv(args: string[]): RuntimeCommandResult {
  if (args.length === 0) {
    return {
      stdout: `${Object.entries(state.env)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
      stderr: '',
      status: 0,
    }
  }

  const key = args[0]
  return { stdout: state.env[key] ? `${state.env[key]}\n` : '', stderr: '', status: state.env[key] ? 0 : 1 }
}

async function builtinEnv(args: string[], stdin: string): Promise<RuntimeCommandResult> {
  const nextEnv = { ...state.env }
  let index = 0

  while (index < args.length) {
    const arg = args[index]

    if (arg === '-u') {
      const key = args[index + 1]
      if (!key) {
        return { stdout: '', stderr: 'env: option requires an argument -- u\n', status: 1 }
      }
      delete nextEnv[key]
      index += 2
      continue
    }

    if (arg.includes('=') && !arg.startsWith('=')) {
      const [key, ...rest] = arg.split('=')
      if (!key) {
        return { stdout: '', stderr: `env: invalid assignment: ${arg}\n`, status: 1 }
      }
      nextEnv[key] = rest.join('=')
      index += 1
      continue
    }

    break
  }

  if (index >= args.length) {
    return {
      stdout: `${Object.entries(nextEnv)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
      stderr: '',
      status: 0,
    }
  }

  const previousEnv = state.env
  state.env = nextEnv
  try {
    return await runSimpleCommand(args.slice(index), stdin)
  } finally {
    state.env = previousEnv
  }
}

function builtinExport(args: string[]): RuntimeCommandResult {
  if (args.length === 0) {
    return builtinPrintenv([])
  }
  for (const arg of args) {
    const [key, ...rest] = arg.split('=')
    if (!key) {
      return { stdout: '', stderr: `export: invalid assignment: ${arg}\n`, status: 1 }
    }
    state.env[key] = rest.join('=')
  }
  return { stdout: '', stderr: '', status: 0 }
}

function builtinUnset(args: string[]): RuntimeCommandResult {
  for (const key of args) {
    delete state.env[key]
  }
  return { stdout: '', stderr: '', status: 0 }
}

function builtinAlias(args: string[]): RuntimeCommandResult {
  if (args.length === 0) {
    return {
      stdout: `${Object.entries(state.aliases)
        .map(([key, value]) => `alias ${key}='${value}'`)
        .join('\n')}\n`,
      stderr: '',
      status: 0,
    }
  }

  for (const arg of args) {
    const [name, ...rest] = arg.split('=')
    if (!name || rest.length === 0) {
      return { stdout: '', stderr: `alias: invalid alias: ${arg}\n`, status: 1 }
    }
    state.aliases[name] = rest.join('=').replace(/^['"]|['"]$/g, '')
  }
  return { stdout: '', stderr: '', status: 0 }
}

async function enterPythonRepl() {
  state.mode = 'python'
  state.pythonContinuation = false
  return { stdout: 'Python 3.12 (Pyodide)\nType exit() or quit() to return to shell.\n', stderr: '', status: 0 }
}

async function runPythonScript(scriptPath: string) {
  if (!pyodide) {
    throw new Error('Python runtime not ready')
  }
  syncPyodideCwd()
  pyodide.globals.set('_magni_run_path_target', scriptPath)
  await pyodide.runPythonAsync('_magni_run_path(_magni_run_path_target)')
}

async function runPythonCode(code: string) {
  if (!pyodide) {
    throw new Error('Python runtime not ready')
  }
  syncPyodideCwd()
  await pyodide.runPythonAsync(code)
}

async function pushPythonReplLine(line: string) {
  if (!pyodide) {
    throw new Error('Python runtime not ready')
  }
  pyodide.globals.set('_magni_line', line)
  const result = pyodide.runPython('_magni_push(_magni_line)')
  state.pythonContinuation = Boolean(result)
}

async function builtinPython(args: string[], stdin: string): Promise<RuntimeCommandResult> {
  try {
    await bootstrapPython()

    if (args.length === 0) {
      if (stdin.trim()) {
        await runPythonCode(stdin)
        syncPyodideToFsState()
        return { stdout: '', stderr: '', status: 0 }
      }
      return await enterPythonRepl()
    }

    if (args[0] === '-c') {
      const code = args.slice(1).join(' ')
      if (!code) {
        return { stdout: '', stderr: 'python: expected code after -c\n', status: 1 }
      }
      await runPythonCode(code)
      syncPyodideToFsState()
      return { stdout: '', stderr: '', status: 0 }
    }

    const path = resolvePath(args[0])
    if (!fsState.exists(path) || !fsState.isFile(path)) {
      return { stdout: '', stderr: `python: ${path}: no such file\n`, status: 1 }
    }
    await runPythonScript(path)
    syncPyodideToFsState()
    return { stdout: '', stderr: '', status: 0 }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { stdout: '', stderr: `${message}\n`, status: 1 }
  }
}

async function handleShellLine(line: string): Promise<RuntimeCommandResult> {
  const expanded = expandAlias(line)
  const ast = await parseShellAst(expanded)
  if (!ast) {
    return { stdout: '', stderr: '', status: 0 }
  }
  return await executeAst(ast)
}

async function handlePythonLine(line: string): Promise<RuntimeCommandResult> {
  const trimmed = line.trim()
  if (trimmed === 'exit()' || trimmed === 'quit()') {
    state.mode = 'shell'
    state.pythonContinuation = false
    return { stdout: '', stderr: '', status: 0 }
  }

  try {
    await pushPythonReplLine(line)
    syncPyodideToFsState()
    await persistHomeIfAllowed()
    return { stdout: '', stderr: '', status: 0 }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { stdout: '', stderr: `${message}\n`, status: 1 }
  }
}

async function handleLessLine(line: string): Promise<RuntimeCommandResult> {
  const command = line.trim()
  const pageSize = Math.max(1, state.rows - 2)

  if (command === 'q' || command === ':q') {
    state.mode = 'shell'
    state.lessLines = []
    state.lessOffset = 0
    state.lessSearch = ''
    return { stdout: '', stderr: '', status: 0 }
  }

  if (command === 'b') {
    state.lessOffset = Math.max(0, state.lessOffset - pageSize)
    return { stdout: renderLessPage(), stderr: '', status: 0, clear: true }
  }

  if (command === 'g') {
    state.lessOffset = 0
    return { stdout: renderLessPage(), stderr: '', status: 0, clear: true }
  }

  if (command === 'G') {
    state.lessOffset = Math.max(0, state.lessLines.length - pageSize)
    return { stdout: renderLessPage(), stderr: '', status: 0, clear: true }
  }

  if (command.startsWith('/')) {
    const pattern = command.slice(1)
    if (!pattern) {
      return { stdout: '', stderr: 'less: missing search pattern\n', status: 1 }
    }
    try {
      new RegExp(pattern, 'i')
    } catch (error) {
      return { stdout: '', stderr: `less: ${error instanceof Error ? error.message : String(error)}\n`, status: 1 }
    }
    state.lessSearch = pattern
    const match = findLessMatchOffset(pattern, state.lessOffset + 1)
    if (match === null) {
      return { stdout: '', stderr: `Pattern not found: ${pattern}\n`, status: 1 }
    }
    state.lessOffset = match
    return { stdout: renderLessPage(), stderr: '', status: 0, clear: true }
  }

  if (command === 'n') {
    if (!state.lessSearch) {
      return { stdout: '', stderr: 'less: no active search\n', status: 1 }
    }
    const match = findLessMatchOffset(state.lessSearch, state.lessOffset + 1)
    if (match === null) {
      return { stdout: '', stderr: `Pattern not found: ${state.lessSearch}\n`, status: 1 }
    }
    state.lessOffset = match
    return { stdout: renderLessPage(), stderr: '', status: 0, clear: true }
  }

  if (command === 'N') {
    if (!state.lessSearch) {
      return { stdout: '', stderr: 'less: no active search\n', status: 1 }
    }
    const match = findLessMatchOffset(state.lessSearch, state.lessOffset - 1, -1)
    if (match === null) {
      return { stdout: '', stderr: `Pattern not found: ${state.lessSearch}\n`, status: 1 }
    }
    state.lessOffset = match
    return { stdout: renderLessPage(), stderr: '', status: 0, clear: true }
  }

  if (command === '') {
    state.lessOffset = Math.min(state.lessLines.length, state.lessOffset + 1)
    return { stdout: renderLessPage(), stderr: '', status: 0, clear: true }
  }

  state.lessOffset = Math.min(state.lessLines.length, state.lessOffset + pageSize)
  return { stdout: renderLessPage(), stderr: '', status: 0, clear: true }
}

async function handleInput(line: string) {
  const trimmed = line.trim()
  if (trimmed && state.mode === 'shell') {
    appendHistoryEntry(line)
    await persistHomeIfAllowed()
  }

  post({ type: 'busy', value: true })
  try {
    const result =
      state.mode === 'python'
        ? await handlePythonLine(line)
        : state.mode === 'less'
          ? await handleLessLine(line)
          : await handleShellLine(line)
    if (result.clear) {
      post({ type: 'clear' })
    }
    if (result.stdout) {
      writeStdout(result.stdout)
    }
    if (result.stderr) {
      writeStderr(result.stderr)
    }
    lastExitCode = result.status
    post({ type: 'exit', code: result.status })
  } catch (error) {
    writeStderr(`${error instanceof Error ? error.message : String(error)}\n`)
    lastExitCode = 1
    post({ type: 'exit', code: 1 })
  } finally {
    post({ type: 'busy', value: false })
    emitPrompt()
  }
}

async function initializeRuntime() {
  if (ready) {
    return
  }
  seedHome()
  await fsState.loadFromDb()
  loadHistoryFromFile()
  ready = true
  post({ type: 'ready' })
  post({ type: 'stdout', data: 'Magniquick runtime lab\nShared VFS + shell + Pyodide\n\n' })
  emitPrompt()
}

self.onmessage = async (event: MessageEvent<RuntimeRequest>) => {
  const message = event.data

  try {
    switch (message.type) {
      case 'init':
        await initializeRuntime()
        return
      case 'input':
        await handleInput(message.line)
        return
      case 'complete': {
        const completion = completeLine(message.line, message.cursor)
        post({
          type: 'completion',
          line: completion.line,
          cursor: completion.cursor,
          suggestions: completion.suggestions,
        })
        return
      }
      case 'clear':
        post({ type: 'clear' })
        emitPrompt()
        return
      case 'reset-session':
        resetSessionState()
        post({ type: 'stdout', data: 'shell session reset\n' })
        emitPrompt()
        return
      case 'resize':
        state.cols = message.cols
        state.rows = message.rows
        return
      case 'interrupt':
        interruptSerial += 1
        if (interruptBuffer) {
          interruptBuffer[0] = 2
        }
        if (state.mode === 'python') {
          state.mode = 'shell'
          state.pythonContinuation = false
          writeStderr('KeyboardInterrupt\n')
          emitPrompt()
        } else {
          writeStderr('^C\n')
        }
        return
      case 'search':
        return
    }
  } catch (error) {
    post({
      type: 'fatal',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
