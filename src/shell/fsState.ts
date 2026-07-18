/// <reference lib="webworker" />

import { Directory, File, type Inode } from '@bjorn3/browser_wasi_shim'

type PersistedNode =
  | { type: 'dir'; mtime?: number; children?: Record<string, PersistedNode> }
  | { type: 'file'; data: string; mtime?: number }

type PersistedSnapshot = {
  v: 2
  tree: PersistedNode
}

const DB_NAME = 'magniquick-lab'
const STORE_NAME = 'snapshots'
const SNAPSHOT_KEY = 'home'
const DB_VERSION = 2

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const mtimes = new WeakMap<Inode, number>()

export const root = new Directory(new Map())
mtimes.set(root, Date.now())

function nowTimestamp() {
  return Date.now()
}

function encodeBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

function decodeBase64(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function normalizePath(input: string) {
  const raw = input || '/'
  const normalized: string[] = []
  for (const segment of raw.split('/')) {
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

function partsFor(path: string) {
  return normalizePath(path).split('/').filter(Boolean)
}

function dirname(path: string) {
  const normalized = normalizePath(path)
  if (normalized === '/') {
    return '/'
  }
  const parts = partsFor(normalized)
  parts.pop()
  return `/${parts.join('/')}` || '/'
}

function basename(path: string) {
  const normalized = normalizePath(path)
  if (normalized === '/') {
    return '/'
  }
  return partsFor(normalized).at(-1) ?? normalized
}

function setParent(inode: Inode, parent: Directory) {
  ;(inode as Inode & { parent?: Directory }).parent = parent
}

function setMtime(inode: Inode, timestamp = nowTimestamp()) {
  mtimes.set(inode, timestamp)
}

function cloneInode(inode: Inode): Inode {
  if (inode instanceof File) {
    const file = new File(inode.data.slice())
    setMtime(file, mtimeForInode(inode))
    return file
  }
  if (inode instanceof Directory) {
    const dir = new Directory(new Map())
    setMtime(dir, mtimeForInode(inode))
    for (const [name, child] of inode.contents) {
      const cloned = cloneInode(child)
      setParent(cloned, dir)
      dir.contents.set(name, cloned)
    }
    return dir
  }
  throw new Error('unsupported inode type')
}

function mtimeForInode(inode: Inode) {
  return mtimes.get(inode) ?? 0
}

function parentDir(path: string, create = false): Directory | null {
  const parentPath = dirname(path)
  if (create) {
    return mkdirp(parentPath)
  }
  const parent = getInode(parentPath)
  return parent instanceof Directory ? parent : null
}

export function getInode(path: string): Inode | null {
  const parts = partsFor(path)
  let current: Inode = root
  for (const part of parts) {
    if (!(current instanceof Directory)) {
      return null
    }
    const next = current.contents.get(part)
    if (!next) {
      return null
    }
    current = next
  }
  return current
}

export function getFileBytes(path: string): Uint8Array | null {
  const inode = getInode(path)
  return inode instanceof File ? inode.data.slice() : null
}

export function getFileText(path: string): string | null {
  const bytes = getFileBytes(path)
  return bytes ? textDecoder.decode(bytes) : null
}

export function isFile(path: string): boolean {
  return getInode(path) instanceof File
}

export function isDir(path: string): boolean {
  return getInode(path) instanceof Directory
}

export function exists(path: string): boolean {
  return Boolean(getInode(path))
}

export function listDir(path: string): string[] | null {
  const inode = getInode(path)
  if (!(inode instanceof Directory)) {
    return null
  }
  return [...inode.contents.keys()].sort()
}

export function mkdirp(path: string): Directory {
  let current = root
  for (const part of partsFor(path)) {
    const existing = current.contents.get(part)
    if (existing instanceof Directory) {
      current = existing
      continue
    }
    if (existing) {
      throw new Error(`${path}: not a directory`)
    }
    const next = new Directory(new Map())
    setParent(next, current)
    setMtime(next)
    current.contents.set(part, next)
    setMtime(current)
    current = next
  }
  return current
}

export function putFile(path: string, bytes: Uint8Array): void {
  const target = normalizePath(path)
  const parent = parentDir(target, true)
  if (!parent) {
    throw new Error(`${dirname(target)}: no such directory`)
  }
  const file = new File(bytes.slice())
  setParent(file, parent)
  setMtime(file)
  parent.contents.set(basename(target), file)
  setMtime(parent)
}

export function putFileText(path: string, text: string): void {
  putFile(path, textEncoder.encode(text))
}

export function remove(path: string, opts: { recursive?: boolean } = {}): boolean {
  const target = normalizePath(path)
  if (target === '/') {
    return false
  }
  const parent = parentDir(target)
  const name = basename(target)
  const inode = parent?.contents.get(name)
  if (!parent || !inode) {
    return false
  }
  if (inode instanceof Directory && inode.contents.size > 0 && !opts.recursive) {
    return false
  }
  parent.contents.delete(name)
  setMtime(parent)
  return true
}

export function move(src: string, dst: string): boolean {
  const source = normalizePath(src)
  const target = normalizePath(dst)
  if (source === '/' || source === target) {
    return false
  }
  const srcParent = parentDir(source)
  const inode = srcParent?.contents.get(basename(source))
  const dstParent = parentDir(target, true)
  if (!srcParent || !inode || !dstParent) {
    return false
  }
  srcParent.contents.delete(basename(source))
  setMtime(srcParent)
  setParent(inode, dstParent)
  dstParent.contents.set(basename(target), inode)
  setMtime(dstParent)
  return true
}

export function copy(src: string, dst: string): boolean {
  const inode = getInode(src)
  if (!inode) {
    return false
  }
  const target = normalizePath(dst)
  const parent = parentDir(target, true)
  if (!parent) {
    return false
  }
  const cloned = cloneInode(inode)
  setParent(cloned, parent)
  setMtime(cloned)
  parent.contents.set(basename(target), cloned)
  setMtime(parent)
  return true
}

export function mtime(path: string): number {
  const inode = getInode(path)
  return inode ? mtimeForInode(inode) : 0
}

export function touch(path: string): void {
  const inode = getInode(path)
  if (inode) {
    setMtime(inode)
  }
}

export function* walk(path: string): Iterable<{ path: string; inode: Inode }> {
  const startPath = normalizePath(path)
  const inode = getInode(startPath)
  if (!inode) {
    return
  }
  yield { path: startPath, inode }
  if (!(inode instanceof Directory)) {
    return
  }
  for (const [name, child] of [...inode.contents.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const childPath = startPath === '/' ? `/${name}` : `${startPath}/${name}`
    yield* walk(childPath)
  }
}

function serializeInode(inode: Inode): PersistedNode {
  if (inode instanceof File) {
    return { type: 'file', data: encodeBase64(inode.data), mtime: mtimeForInode(inode) }
  }
  if (inode instanceof Directory) {
    const children: Record<string, PersistedNode> = {}
    for (const [name, child] of inode.contents) {
      children[name] = serializeInode(child)
    }
    return { type: 'dir', mtime: mtimeForInode(inode), children }
  }
  throw new Error('unsupported inode type')
}

function hydrateNode(node: PersistedNode): Inode {
  if (node.type === 'file') {
    const file = new File(decodeBase64(node.data))
    setMtime(file, node.mtime ?? nowTimestamp())
    return file
  }
  const dir = new Directory(new Map())
  setMtime(dir, node.mtime ?? nowTimestamp())
  for (const [name, childNode] of Object.entries(node.children ?? {})) {
    const child = hydrateNode(childNode)
    setParent(child, dir)
    dir.contents.set(name, child)
  }
  return dir
}

function replaceRoot(node: PersistedNode) {
  root.contents.clear()
  if (node.type !== 'dir') {
    setMtime(root)
    return
  }
  setMtime(root, node.mtime ?? nowTimestamp())
  for (const [name, childNode] of Object.entries(node.children ?? {})) {
    const child = hydrateNode(childNode)
    setParent(child, root)
    root.contents.set(name, child)
  }
}

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME)
      }
      db.createObjectStore(STORE_NAME)
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
}

export async function loadFromDb(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const request = store.get(SNAPSHOT_KEY)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const snapshot = request.result as PersistedSnapshot | undefined
      if (snapshot?.v === 2) {
        replaceRoot(snapshot.tree)
      }
      resolve()
    }
  })
}

export async function saveToDb(): Promise<void> {
  const snapshot: PersistedSnapshot = { v: 2, tree: serializeInode(root) }
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.put(snapshot, SNAPSHOT_KEY)
    request.onerror = () => reject(request.error)
    tx.onerror = () => reject(tx.error)
    tx.oncomplete = () => resolve()
  })
}
