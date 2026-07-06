// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  // prototyping: default to the root user-pages domain. If this ever lives under a
  // project repo (e.g. /web-prototypes), set `base` and Astro rewrites asset paths.
  site: 'https://magniquick.github.io',
  // base: '/web-prototypes',
  integrations: [mdx(), sitemap()],
  markdown: {
    // deuteranopia-friendly dark theme; wrap long lines in code blocks
    shikiConfig: { theme: 'github-dark-default', wrap: true },
  },
});
