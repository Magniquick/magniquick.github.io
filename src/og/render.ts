// HTML → SVG → PNG, all at build time. satori lays the card out and emits SVG with the
// glyphs already converted to paths; resvg rasterises that vector at 2×, so the text is
// genuinely sharp on the DPR-2/3 phones where these previews are actually seen. A 1× PNG
// gets upscaled and smeared by the scraper instead.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { toSatori } from './html';
import { cardHtml, CARD_W, CARD_H, type CardProps } from './card';

/** Rasterisation factor over the authored 1200×630. */
export const SCALE = 2;
export const OG_WIDTH = CARD_W * SCALE;
export const OG_HEIGHT = CARD_H * SCALE;

// The card must use the *same* faces the page does, so read them straight out of the
// @fontsource packages Base.astro imports — no vendored copy to drift out of sync.
// satori parses ttf/otf/woff but not woff2; fontsource ships both, so .woff it is.
// Package resolution, not a path relative to this file: at build the module is bundled
// into dist/.prerender/chunks, where a relative path no longer points at node_modules.
// (Named anything but `require` — that identifier collides with Rollup's CJS interop.)
const resolve = createRequire(import.meta.url).resolve;
const font = (pkg: string, file: string) => readFileSync(resolve(`@fontsource/${pkg}/files/${file}`));

const FONTS = [
  { name: 'Geist Mono', data: font('geist-mono', 'geist-mono-latin-700-normal.woff'), weight: 700 as const, style: 'normal' as const },
  { name: 'VT323', data: font('vt323', 'vt323-latin-400-normal.woff'), weight: 400 as const, style: 'normal' as const },
];

export async function cardSvg(props?: CardProps): Promise<string> {
  return satori(toSatori(cardHtml(props)), { width: CARD_W, height: CARD_H, fonts: FONTS });
}

export async function cardPng(props?: CardProps): Promise<Buffer> {
  const svg = await cardSvg(props);
  // satori embeds glyphs as <path>, so resvg needs no font config of its own
  return new Resvg(svg, { fitTo: { mode: 'width', value: OG_WIDTH } }).render().asPng();
}
