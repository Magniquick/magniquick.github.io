// The dirtiest site in the repo: `bun tools/og-cat.ts`, open the URL it prints, drag the
// cat, copy the numbers into cardHtml()'s defaults in src/og/card.ts.
//
// It exists because the backdrop has to be the *real* renderer, not an HTML mock-up —
// otherwise you'd be positioning against something that isn't what ships. Astro's own
// dev server can't do it: it strips the query string from prerendered routes, so there's
// no way to ask /og.png for a variant. Twenty lines of Bun.serve calling cardPng()
// directly sidesteps that entirely, and nothing about it reaches the built site.
import { cardPng } from '../src/og/render';

const PORT = 4330;
// re-read per request so editing the HTML just needs a refresh, not a restart
const page = () => Bun.file(new URL('./og-cat.html', import.meta.url)).text();

const num = (v: string | null) =>
  v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/render.png') {
      const q = url.searchParams;
      const png = await cardPng({
        cat: q.get('cat') !== '0',
        catTop: num(q.get('catTop')),
        catRight: num(q.get('catRight')),
        titleSize: num(q.get('titleSize')),
        title: q.get('title') ?? undefined,
        align: q.get('align') === 'center' ? 'center' : 'left',
      });
      return new Response(png, { headers: { 'Content-Type': 'image/png' } });
    }
    return new Response(await page(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  },
});

console.log(`og cat placer → http://localhost:${PORT}`);
