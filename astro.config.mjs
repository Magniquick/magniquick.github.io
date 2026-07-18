// @ts-check
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import expressiveCode from 'astro-expressive-code';
import icon from 'astro-icon';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import svelte from '@astrojs/svelte';

import remarkToc from 'remark-toc';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import { remarkReadingTime } from './remark-reading-time.mjs';

// The ./shell terminal loads Pyodide from same-origin /pyodide/*. Those ~12 MB of
// runtime files ship inside the pinned `pyodide` npm package, so we copy them out of
// node_modules on dev-server start and build instead of committing them. buildStart
// fires for both `astro dev` and `astro build`, and public/ is emitted to dist after.
const PYODIDE_FILES = ['pyodide.asm.js', 'pyodide.asm.wasm', 'pyodide-lock.json', 'python_stdlib.zip'];
function copyPyodideAssets() {
  const from = fileURLToPath(new URL('./node_modules/pyodide/', import.meta.url));
  const to = fileURLToPath(new URL('./public/pyodide/', import.meta.url));
  mkdirSync(to, { recursive: true });
  for (const file of PYODIDE_FILES) cpSync(from + file, to + file);
}

// The WASI coreutils multicall binary the shell's w* commands call. Not on npm — it's
// a uutils release asset — so fetch+verify+extract it once (cached if already present).
const COREUTILS_VERSION = '0.9.0';
const COREUTILS_URL = `https://github.com/uutils/coreutils/releases/download/${COREUTILS_VERSION}/coreutils-${COREUTILS_VERSION}-wasm32-wasip1.tar.gz`;
const COREUTILS_TARBALL_SHA256 = 'e5efa8a1c10bd0ac09eb780d46aff6d8a4ea0be07d41f4dd9a102b266c6eb69f';
async function ensureCoreutilsWasm() {
  const to = fileURLToPath(new URL('./public/coreutils.wasm', import.meta.url));
  if (existsSync(to)) return; // cached from a previous run / CI restore
  const res = await fetch(COREUTILS_URL);
  if (!res.ok) throw new Error(`coreutils.wasm: download failed (${res.status}) from ${COREUTILS_URL}`);
  const tarball = Buffer.from(await res.arrayBuffer());
  const digest = createHash('sha256').update(tarball).digest('hex');
  if (digest !== COREUTILS_TARBALL_SHA256) {
    throw new Error(`coreutils.wasm: sha256 mismatch (got ${digest}, want ${COREUTILS_TARBALL_SHA256})`);
  }
  const cache = fileURLToPath(new URL('./node_modules/.cache/coreutils/', import.meta.url));
  mkdirSync(cache, { recursive: true });
  const tgz = cache + 'coreutils.tar.gz';
  writeFileSync(tgz, tarball);
  execFileSync('tar', ['-xzf', tgz, '-C', cache, '--strip-components=1',
    `coreutils-${COREUTILS_VERSION}-wasm32-wasip1/coreutils.wasm`]);
  mkdirSync(fileURLToPath(new URL('./public/', import.meta.url)), { recursive: true });
  cpSync(cache + 'coreutils.wasm', to);
  rmSync(tgz, { force: true });
}

// https://astro.build/config
export default defineConfig({
  // prototyping: default to the root user-pages domain. If this ever lives under a
  // project repo (e.g. /web-prototypes), set `base` and Astro rewrites asset paths.
  site: 'https://magniquick.github.io',
  // base: '/web-prototypes',
  // inline all CSS into the HTML so first paint needs a single round-trip (14 kB rule)
  build: { inlineStylesheets: 'always' },
  // allow astro:assets to optimize the remote GitHub avatar at build time
  image: { domains: ['avatars.githubusercontent.com'] },
  integrations: [
    // expressiveCode must precede mdx() so it handles md/mdx code fences.
    // Code blocks render in terminal/editor frames — same window-chrome motif.
    expressiveCode({
      themes: ['github-dark-default'],
      styleOverrides: {
        borderRadius: '5px',
        borderColor: 'var(--line)',
        codeFontFamily: '"IBM Plex Mono", ui-monospace, monospace',
        uiFontFamily: '"IBM Plex Mono", ui-monospace, monospace',
        frames: { shadowColor: 'transparent' },
      },
    }),
    mdx(),
    sitemap(),
    // build-time SVG (Iconify sets: octicon + lucide); auto-sprited, zero runtime JS
    icon(),
    // Svelte island host for the ./shell --wasm terminal (xterm + pyodide worker)
    svelte(),
  ],
  vite: {
    plugins: [
      {
        name: 'shell-runtime-assets',
        async buildStart() {
          copyPyodideAssets();
          await ensureCoreutilsWasm();
        },
      },
    ],
    // pyodide must not be pre-bundled or it fails to load inside the worker
    optimizeDeps: { exclude: ['pyodide'] },
    // the runtime worker is authored as an ES module (import.meta.url, top-level import)
    worker: { format: 'es' },
    // Cross-origin isolation → SharedArrayBuffer → pyodide's Ctrl-C interrupt.
    // Dev/preview get real headers here; production (GitHub Pages, no header control)
    // relies on the coi-serviceworker shim registered in Base.astro.
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
  },
  markdown: {
    // Astro 7 API: pass plugins through unified() (keeps gfm/smartypants defaults).
    // EC owns code blocks.
    processor: unified({
      remarkPlugins: [remarkReadingTime, [remarkToc, { heading: 'contents', maxDepth: 3 }]],
      rehypePlugins: [rehypeSlug, [rehypeAutolinkHeadings, { behavior: 'wrap' }]],
    }),
  },
});
