// Build-time track resolver for <SongRecc>. A post names a song by Spotify URL or by
// title + artist; this turns that into art and links for several platforms, so the
// card isn't a Spotify-only link.
//
// Sources, all keyless:
//   - Spotify's embed page (open.spotify.com/embed/track/<id>) carries the track's
//     metadata in __NEXT_DATA__: artists and art. It's
//     unofficial, so oEmbed (official, title + art only) is the fallback.
//   - iTunes Search gives the Apple Music link and art.
//   - song.link's public API is gone (401 PUBLIC_API_ACCESS_DEPRECATED), but its pages
//     still resolve /s/<spotify id> and /i/<itunes id>, so it's the "everything else" link.
//
// Results are cached in src/songs/cache.json and covers in src/songs/art/ (both
// committed), so builds are reproducible and don't hit the network once a song is known.
// <SongRecc> imports the local cover and astro:assets optimises it like any other asset.
// Delete an entry (and its cover) to re-resolve it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Song {
  title: string;
  artist: string;
  art?: string; // source URL of the cover, kept for provenance and as a fallback
  artFile?: string; // the cover saved under src/songs/art/
  links: { spotify: string; apple?: string; ytmusic: string; songlink?: string };
}

export interface SongQuery {
  spotify?: string; // track URL, spotify:track: URI, or bare id
  title?: string;
  artist?: string;
}

// cwd, not import.meta.url: this module is bundled into dist/.prerender/chunks.
const CACHE_PATH = join(process.cwd(), 'src/songs/cache.json');
const ART_DIR = join(process.cwd(), 'src/songs/art');
const cache: Record<string, Song> = existsSync(CACHE_PATH)
  ? JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
  : {};
const inflight = new Map<string, Promise<Song>>();

function saveCache() {
  const sorted = Object.fromEntries(Object.entries(cache).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(CACHE_PATH + '.tmp', JSON.stringify(sorted, null, 2) + '\n');
  renameSync(CACHE_PATH + '.tmp', CACHE_PATH);
}

const spotifyId = (s: string) =>
  s.match(/(?:track[/:])([A-Za-z0-9]{22})/)?.[1] ?? (/^[A-Za-z0-9]{22}$/.test(s) ? s : undefined);

// Loose comparison key: case, accents, "(feat. x)" / "- Remastered" suffixes, punctuation.
const norm = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s*[([].*?[)\]]/g, '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');

async function getJson(url: string) {
  const res = await fetch(url, { headers: { 'User-Agent': 'magniquick.github.io build' } });
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  return res.json();
}

interface SpotifyMeta { title: string; artist?: string; art?: string }

async function fromSpotify(id: string): Promise<SpotifyMeta> {
  try {
    const res = await fetch(`https://open.spotify.com/embed/track/${id}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const html = await res.text();
    const json = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
    const e = json && JSON.parse(json).props?.pageProps?.state?.data?.entity;
    if (e?.name) {
      const images: { url: string; maxWidth: number }[] = e.visualIdentity?.image ?? [];
      return {
        title: e.name,
        artist: e.artists?.map((a: { name: string }) => a.name).join(', '),
        art: images.sort((a, b) => b.maxWidth - a.maxWidth)[0]?.url,
      };
    }
  } catch {
    // fall through to oEmbed
  }
  const o = await getJson(`https://open.spotify.com/oembed?url=https://open.spotify.com/track/${id}`);
  return { title: o.title, art: o.thumbnail_url };
}

interface ITunesTrack {
  trackId: number; trackName: string; artistName: string; trackViewUrl: string;
  artworkUrl100?: string;
}

async function fromITunes(title: string, artist: string): Promise<ITunesTrack | undefined> {
  const term = encodeURIComponent(`${artist} ${title}`);
  const { results } = (await getJson(
    `https://itunes.apple.com/search?term=${term}&entity=song&limit=25`,
  )) as { results: ITunesTrack[] };
  const a = norm(artist.split(',')[0]);
  const t = norm(title);
  const byArtist = results.filter((r) => norm(r.artistName).includes(a));
  return byArtist.find((r) => norm(r.trackName) === t) ?? byArtist.find((r) => norm(r.trackName).startsWith(t));
}

async function resolve(q: SongQuery): Promise<Song> {
  const id = q.spotify ? spotifyId(q.spotify) : undefined;
  if (q.spotify && !id) throw new Error(`<SongRecc>: can't find a track id in "${q.spotify}"`);

  const sp = id ? await fromSpotify(id) : undefined;
  const title = q.title ?? sp?.title;
  const artist = q.artist ?? sp?.artist;
  if (!title || !artist) {
    throw new Error(`<SongRecc>: couldn't work out title + artist for ${JSON.stringify(q)}; pass them explicitly`);
  }

  const it = await fromITunes(title, artist).catch((err) => {
    console.warn(`[songs] iTunes lookup failed for "${artist} - ${title}": ${err.message}`);
    return undefined;
  });
  if (!it) console.warn(`[songs] no Apple Music match for "${artist} - ${title}"`);

  const search = encodeURIComponent(`${artist} ${title}`);
  return {
    title,
    artist,
    // Apple's artwork URLs take any size in the path; 300px covers a 2x thumbnail with room
    // to spare and keeps the committed file small.
    art: it?.artworkUrl100?.replace(/\/\d+x\d+bb\./, '/300x300bb.') ?? sp?.art,
    links: {
      spotify: id ? `https://open.spotify.com/track/${id}` : `https://open.spotify.com/search/${search}`,
      apple: it?.trackViewUrl.replace(/[?&]uo=\d+/, ''),
      ytmusic: `https://music.youtube.com/search?q=${search}`,
      songlink: id ? `https://song.link/s/${id}` : it ? `https://song.link/i/${it.trackId}` : undefined,
    },
  };
}

const IMAGE_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

async function saveArt(key: string, url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  const ext = IMAGE_EXT[res.headers.get('content-type')?.split(';')[0] ?? ''] ?? 'jpg';
  const file = `${key.replace(/[^A-Za-z0-9]+/g, '-')}.${ext}`;
  mkdirSync(ART_DIR, { recursive: true });
  writeFileSync(join(ART_DIR, file), Buffer.from(await res.arrayBuffer()));
  return file;
}

async function load(key: string, q: SongQuery): Promise<Song> {
  let song = cache[key];
  let changed = false;
  if (!song) {
    song = await resolve(q);
    changed = true;
  }
  // Also backfills covers for entries cached before covers were stored locally.
  if (song.art && !(song.artFile && existsSync(join(ART_DIR, song.artFile)))) {
    try {
      song.artFile = await saveArt(key, song.art);
      changed = true;
    } catch (err) {
      console.warn(`[songs] couldn't save cover for "${song.artist} - ${song.title}": ${(err as Error).message}`);
    }
  }
  if (changed) {
    cache[key] = song;
    saveCache();
  }
  return song;
}

export function getSong(q: SongQuery): Promise<Song> {
  const id = q.spotify && spotifyId(q.spotify);
  const key = id ? `spotify:${id}` : `${norm(q.artist ?? '')}:${norm(q.title ?? '')}`;
  let p = inflight.get(key);
  if (!p) {
    p = load(key, q);
    inflight.set(key, p);
  }
  return p;
}
