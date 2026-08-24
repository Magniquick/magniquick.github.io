// HTML string → satori element tree.
//
// satori wants React-shaped nodes ({ type, props: { style, children } }) with camelCased
// style objects, so authoring the card as markup needs a parse step. The obvious wrapper
// for this, satori-html, is broken against current ultrahtml (its selector transformer
// throws on any input), so this maps ultrahtml's AST directly — it's the same parser
// Astro itself uses, minus the layer that doesn't work.
import { parse, ELEMENT_NODE, TEXT_NODE } from 'ultrahtml';

export interface SatoriNode {
  type: string;
  props: Record<string, unknown> & { children?: (SatoriNode | string)[] };
}

/** `font-size:12px;color:red` → `{ fontSize: '12px', color: 'red' }` */
function styleObject(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim();
    if (prop) out[prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = decl.slice(i + 1).trim();
  }
  return out;
}

function convert(node: any): SatoriNode | string | null {
  if (node.type === TEXT_NODE) {
    // indentation between tags would otherwise render as stray spaces
    return /^\s*$/.test(node.value) ? null : node.value;
  }
  if (node.type !== ELEMENT_NODE) return null;
  const { style, ...attrs } = node.attributes ?? {};
  const children = (node.children ?? []).map(convert).filter((c: unknown) => c !== null);
  return { type: node.name, props: { ...attrs, style: styleObject(style ?? ''), children } };
}

export function toSatori(markup: string): SatoriNode {
  const root = parse(markup).children.map(convert).find((c: unknown) => c !== null && typeof c !== 'string');
  if (!root) throw new Error('og: markup has no root element');
  return root as SatoriNode;
}
