// /og.png — the social preview card, rendered at build time into dist/.
// Static endpoint: Astro writes the Response body to disk, so no server is involved.
// (Astro strips the query string from prerendered routes, which is why the composition
// tool in tools/ runs its own server instead of parameterising this one.)
import type { APIRoute } from 'astro';
import { cardPng } from '../og/render';

export const GET: APIRoute = async () =>
  new Response(await cardPng(), { headers: { 'Content-Type': 'image/png' } });
