// @ts-check
import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import expressiveCode from 'astro-expressive-code';
import icon from 'astro-icon';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

import remarkToc from 'remark-toc';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import { remarkReadingTime } from './remark-reading-time.mjs';

// https://astro.build/config
export default defineConfig({
  // prototyping: default to the root user-pages domain. If this ever lives under a
  // project repo (e.g. /web-prototypes), set `base` and Astro rewrites asset paths.
  site: 'https://magniquick.github.io',
  // base: '/web-prototypes',
  // inline all CSS into the HTML so first paint needs a single round-trip (14 kB rule)
  build: { inlineStylesheets: 'always' },
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
  ],
  markdown: {
    // Astro 7 API: pass plugins through unified() (keeps gfm/smartypants defaults).
    // EC owns code blocks.
    processor: unified({
      remarkPlugins: [remarkReadingTime, [remarkToc, { heading: 'contents', maxDepth: 3 }]],
      rehypePlugins: [rehypeSlug, [rehypeAutolinkHeadings, { behavior: 'wrap' }]],
    }),
  },
});
