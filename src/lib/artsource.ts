/**
 * Remote artwork, from services that ask for no key and no account.
 *
 * Lidarr used to supply every image through its metadata server. Its
 * replacement is two sources with different strengths:
 *
 *   - **Cover Art Archive** for album covers — the community-maintained archive
 *     keyed by the same MusicBrainz ids everything else here uses. front-500 is
 *     a server-side thumbnail, so the cache stores ~100KB, not a 5MB scan.
 *   - **Deezer** for artist photos — CAA has no artist images at all, and
 *     Deezer's public search returns a 1000×1000 picture for everyone tried,
 *     including "Daron Malakian and Scars on Broadway".
 *
 * Both were probed live before this module was written. Everything returned
 * from here is stored by ArtCache, so each lookup happens once per subject
 * rather than once per page load.
 *
 * URL RESOLUTION is cached separately from the bytes (misses included):
 * an album with no cover anywhere must not cost a rate-limited MusicBrainz
 * search on every page that shows its letter-tile fallback.
 */

import { getBytes, getJson } from './http.js';
import { canonAlbum } from './library.js';
import type { MusicBrainz } from './musicbrainz.js';
import { norm } from './release.js';
import type { Store } from './store.js';

/** A resolved lookup lasts a week; art rarely appears or moves faster than that. */
const TTL_RESOLVE = 7 * 86400;

export interface RemoteArt {
  body: Buffer;
  contentType: string;
  source: string;
}

export class ArtSource {
  constructor(
    private mb: MusicBrainz,
    private store: Store,
    private warn: (msg: string) => void = () => {},
  ) {}

  /**
   * An artist photo, or null.
   *
   * Deezer's search is fuzzy, so the name has to be checked on the way out:
   * its best guess for a misspelt or unknown artist is a real, wrong artist,
   * and a stranger's face on the card is worse than a letter.
   */
  async artistImage(name: string): Promise<RemoteArt | null> {
    const ck = `artsrc:artist:${norm(name)}`;
    let url = this.store.cached<string | null>(ck, TTL_RESOLVE);

    if (url === undefined) {
      url = null;
      try {
        const body = await getJson<{
          data?: { name?: string; picture_xl?: string; picture_big?: string }[];
        }>(`https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=5`);
        const want = norm(name);
        const hit =
          (body.data ?? []).find((d) => norm(d.name ?? '') === want) ??
          (body.data ?? []).find((d) => norm(d.name ?? '').startsWith(want));
        url = hit?.picture_xl ?? hit?.picture_big ?? null;
        // Deezer's placeholder for artists it has no photo of is a generic
        // silhouette served from /images/artist//; a letter tile beats it.
        if (url && /\/artist\/\//.test(url)) url = null;
      } catch (err) {
        this.warn(`deezer artist image failed for "${name}": ${msgOf(err)}`);
        // Not cached: a Deezer blip should not blank an artist for a week.
        return null;
      }
      this.store.putCache(ck, url);
    }

    if (!url) return null;
    const img = await getBytes(url).catch(() => null);
    return img ? { ...img, source: 'deezer' } : null;
  }

  /**
   * A cover by release-group id — no search, no rate limit, no waiting.
   *
   * Cover Art Archive is keyed by exactly the MusicBrainz id crate already has
   * whenever it is showing a real release: an artist page, a search result, an
   * album page. Resolving those by NAME meant a rate-limited search per tile,
   * which under any load cannot finish inside a request budget — every
   * uncached cover on an artist page 404ed after 1.2 seconds while a cached one
   * answered in 3ms. When the id is known, ask the archive directly.
   */
  async albumImageByMbid(mbid: string): Promise<RemoteArt | null> {
    const img = await getBytes(`https://coverartarchive.org/release-group/${mbid}/front-500`).catch(
      () => null,
    );
    return img && img.contentType.startsWith('image/') ? { ...img, source: 'caa' } : null;
  }

  /**
   * An album cover, or null. Cover Art Archive first, Deezer as the fallback.
   *
   * The title check on the MusicBrainz search exists because of a real wrong
   * answer: taking the first search hit once served the same cover for two
   * different Rage Against the Machine albums. No cover beats the wrong cover.
   */
  async albumImage(artist: string, album: string): Promise<RemoteArt | null> {
    const ck = `artsrc:album:${norm(artist)}|${canonAlbum(album)}`;
    let rgMbid = this.store.cached<string | null>(ck, TTL_RESOLVE);

    if (rgMbid === undefined) {
      // Background lane: an artwork lookup fills a cache, and must never make
      // a person's search or artist click wait behind it.
      const hits = await this.mb.searchAlbums(`${artist} ${album}`, 8, 'bg');
      const wantAlbum = canonAlbum(album);
      const wantArtist = norm(artist);
      const best = hits.find(
        (h) => canonAlbum(h.title) === wantAlbum && norm(h.artistName) === wantArtist,
      ) ??
        hits.find(
          (h) =>
            norm(h.artistName) === wantArtist &&
            (canonAlbum(h.title).startsWith(wantAlbum) || wantAlbum.startsWith(canonAlbum(h.title))),
        );
      rgMbid = best?.mbid ?? null;
      this.store.putCache(ck, rgMbid);
    }

    if (rgMbid) {
      const img = await getBytes(
        `https://coverartarchive.org/release-group/${rgMbid}/front-500`,
      ).catch(() => null);
      if (img && img.contentType.startsWith('image/')) return { ...img, source: 'caa' };
    }

    // Deezer knows plenty of covers CAA does not, particularly newer releases.
    try {
      const body = await getJson<{
        data?: {
          title?: string;
          cover_xl?: string;
          cover_big?: string;
          artist?: { name?: string };
        }[];
      }>(
        `https://api.deezer.com/search/album?q=${encodeURIComponent(`${artist} ${album}`)}&limit=5`,
      );
      const wantAlbum = canonAlbum(album);
      const wantArtist = norm(artist);
      const hit = (body.data ?? []).find(
        (d) => canonAlbum(d.title ?? '') === wantAlbum && norm(d.artist?.name ?? '') === wantArtist,
      );
      const url = hit?.cover_xl ?? hit?.cover_big;
      if (url) {
        const img = await getBytes(url).catch(() => null);
        if (img) return { ...img, source: 'deezer' };
      }
    } catch (err) {
      this.warn(`deezer album cover failed for "${artist} — ${album}": ${msgOf(err)}`);
    }
    return null;
  }
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
