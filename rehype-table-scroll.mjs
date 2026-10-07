// Build-time rehype plugin for post tables.
//
// 1. Wrap every <table> in a horizontally scrollable div so wide tables scroll inside the
//    post column instead of overflowing it on narrow screens. The wrapper scrolls because
//    `display:block` on the table itself makes some screen readers stop announcing it as
//    a table. tabindex lets keyboard users scroll it.
// 2. Size columns by content. Browsers share width out in proportion to each column's
//    longest cell, so one long notes column squeezes "double dqn" onto two lines. Columns
//    that are short (every cell <= NOWRAP_MAX chars) or unbreakable anyway (no spaces:
//    paths, hashes, numbers) get .nw and never wrap. Prose columns get .wrap: they take
//    whatever width is left, but never less than a readable minimum, so a row of long
//    hashes makes the table scroll instead of crushing the notes to one word per line.
const NOWRAP_MAX = 30;

const textOf = (node) =>
  node.type === 'text' ? node.value : (node.children ?? []).map(textOf).join('');

function rowsOf(node, out = []) {
  for (const child of node.children ?? []) {
    if (child.type !== 'element') continue;
    if (child.tagName === 'tr') out.push(child.children.filter((c) => c.type === 'element'));
    else rowsOf(child, out);
  }
  return out;
}

function sizeColumns(table) {
  const rows = rowsOf(table);
  const cols = Math.max(0, ...rows.map((r) => r.length));
  for (let c = 0; c < cols; c++) {
    const texts = rows.map((r) => (r[c] ? textOf(r[c]).trim() : ''));
    const short = texts.every((t) => t.length <= NOWRAP_MAX);
    const unbreakable = texts.every((t) => !/\s/.test(t));
    const tag = short || unbreakable ? 'nw' : 'wrap';
    for (const r of rows) {
      const cell = r[c];
      if (cell) cell.properties.className = [...(cell.properties.className ?? []), tag];
    }
  }
}

export function rehypeTableScroll() {
  const wrap = (node) => {
    if (!node.children) return;
    node.children = node.children.map((child) => {
      if (child.type === 'element' && child.tagName === 'table') {
        sizeColumns(child);
        return {
          type: 'element',
          tagName: 'div',
          properties: { className: ['table-scroll'], tabIndex: 0 },
          children: [child],
        };
      }
      wrap(child);
      return child;
    });
  };
  return wrap;
}
