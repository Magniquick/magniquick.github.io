import { defineConfig } from 'vite'
import { sveltekit } from '@sveltejs/kit/vite'

const emptyNodeModule = new URL('./src/shims/node-empty.ts', import.meta.url).pathname
const nodeOnlyModules = [
  'fs/promises',
  'module',
  'node:child_process',
  'node:crypto',
  'node:fs/promises',
  'node:fs',
  'node:path',
  'node:url',
  'node:vm',
]

export default defineConfig({
  plugins: [sveltekit()],
  resolve: {
    alias: {
      ...Object.fromEntries(nodeOnlyModules.map((id) => [id, emptyNodeModule])),
    },
  },
  optimizeDeps: {
    exclude: ['pyodide'],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return
          }
          if (id.includes('@xterm')) {
            return 'xterm'
          }
          if (id.includes('pyodide')) {
            return 'pyodide-host'
          }
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
})
