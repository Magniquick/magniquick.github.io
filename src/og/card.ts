// The social preview card, authored as HTML/CSS and rendered at build time.
//
// It re-creates the site header — VT323 prompt line, Geist Mono wordmark, cyan block
// cursor, VT323 tagline — because that's the part of the page that stays legible once
// WhatsApp or LinkedIn shrink the preview to a few hundred pixels wide.
//
// Constraints worth knowing before editing: satori implements a subset of CSS. Flexbox
// only (no grid, no float), no calc(), no CSS custom properties, and any element with
// more than one child needs an explicit `display:flex`. Hence the inline styles and the
// hardcoded hex — the oklch() tokens in global.css can't be read from here.

import { ONEKO_IDLE } from './oneko-idle';

const ONEKO_URI = `data:image/svg+xml;base64,${Buffer.from(ONEKO_IDLE).toString('base64')}`;

/** Authored size. The PNG is rasterised at a multiple of this — see render.ts. */
export const CARD_W = 1200;
export const CARD_H = 630;

// global.css tokens, resolved to hex
const C = {
  bg: '#141414', // --bg-1
  txt1: '#dedede', // --txt-1
  txt2: '#aeaeae', // --txt-2
  txt3: '#636363', // --txt-3
  accent: '#58d1e5', // --accent
};

export interface CardProps {
  /** Park the cat on the right. */
  cat?: boolean;
  /** Cat position, in card pixels from the top / right edges. See tools/og-cat.html. */
  catTop?: number;
  catRight?: number;
  /** Wordmark size in px — the main lever on how much of the frame the card fills. */
  titleSize?: number;
  /** The prompt line above the wordmark. */
  eyebrow?: string;
  /** The wordmark itself. */
  title?: string;
  /** The tagline under it; `·` separators are tinted with the accent. */
  tagline?: string[];
  /**
   * 'left' hugs the left edge; 'center' centres the block's mass horizontally while the
   * lines stay left-aligned against each other (they share one left edge, the group just
   * sits in the middle). Needs the inner wrapper below — centring the lines directly
   * would centre each one independently.
   */
  align?: 'left' | 'center';
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function cardHtml({
  eyebrow = 'HI, my name is:',
  title = 'Navon John Lukose',
  tagline = ['kernel dev', 'ctf', 'machine learning'],
  cat = true,
  // placed by eye in tools/og-cat.html; 90px is the largest size that keeps the full
  // name on one line (Geist Mono at 0.6em advance vs the 1048px content box)
  catTop = 366,
  catRight = 597,
  titleSize = 90,
  align = 'left',
}: CardProps = {}): string {
  const dots = tagline
    .map(esc)
    .join(`<span style="color:${C.accent};padding:0 10px">·</span>`);

  // The wordmark is emitted word-by-word rather than as one string: the cursor is a
  // separate flex item (it needs its own colour), so on a title long enough to wrap it
  // would otherwise be pushed to the end of the *row* and float away from the text.
  // Per-word items with flex-wrap keep it attached to the last word. The inter-word gap
  // is one character advance — Geist Mono is monospace at 0.6em.
  const words = title.split(/\s+/).filter(Boolean).map(esc);
  const gap = (titleSize * 0.6).toFixed(1);
  const wordmark = words
    .map((w, i) => `<span${i < words.length - 1 ? ` style="padding-right:${gap}px"` : ''}>${w}</span>`)
    .join('');

  return `<div style="position:relative;width:${CARD_W}px;height:${CARD_H}px;background:${C.bg};display:flex;flex-direction:column;justify-content:center;align-items:${align === 'center' ? 'center' : 'flex-start'};padding:0 76px">
  ${cat ? `<img src="${ONEKO_URI}" style="position:absolute;top:${catTop}px;right:${catRight}px;width:48px;height:48px" />` : ''}
  <div style="display:flex;flex-direction:column;align-items:flex-start">
    <div style="display:flex;font-family:VT323;font-size:30px;color:${C.txt3};line-height:1.2">${esc(eyebrow)}</div>
    <div style="display:flex;flex-wrap:wrap;font-family:Geist Mono;font-weight:700;font-size:${titleSize}px;line-height:1.05;letter-spacing:${(titleSize * -0.03).toFixed(1)}px;color:${C.txt1};margin-top:2px">
      ${wordmark}<span style="color:${C.accent}">_</span>
    </div>
    <div style="display:flex;font-family:VT323;font-size:34px;color:${C.txt2};margin-top:10px">${dots}</div>
  </div>
</div>`;
}
