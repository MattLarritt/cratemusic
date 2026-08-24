import { getJson } from './http.js';
import type { Settings } from './settings.js';
import type { Store } from './store.js';

/**
 * Last.fm client — the similarity layer.
 *
 * MusicBrainz supplies metadata but has no notion of "sounds like", so one
 * external service is unavoidable. Last.fm was chosen over Spotify because
 * Spotify withdrew Related Artists and Recommendations from new applications in
 * late 2024; artist.getSimilar has been stable for the better part of two
 * decades and needs only a free key.
 *
 * Every read goes through the SQLite cache. Similarity does not change minute to
 * minute, the front page would otherwise make a dozen calls per load, and
 * Last.fm asks that clients not hammer it.
 */

const API = 'https://ws.audioscrobbler.com/2.0/';

/** Similarity is stable; tags and charts drift slowly. Both measured in seconds. */
const TTL_SIMILAR = 14 * 86400;
const TTL_TAGS = 7 * 86400;
const TTL_CHART = 86400;

export interface Similar {
  name: string;
  /** Last.fm's own 0..1 match score. Summed across seeds when ranking. */
  match: number;
}

export class LastFm {
  /**
   * @param key Absent when no key is configured. Every method then returns
   *   empty rather than throwing, so the app runs without one and the discovery
   *   rows simply have nothing to show — see routes/api.ts, which falls back to
   *   library and genre browsing.
   */
  constructor(
    private store: Store,
    private settings: Settings,
  ) {}

  /** Read per call so an admin can paste a key and have it work immediately. */
  private get key(): string | null {
    return this.settings.all().lastfmKey || null;
  }

  get enabled(): boolean {
    return this.key !== null;
  }

  private async call<T>(
    method: string,
    params: Record<string, string>,
    ttl: number,
  ): Promise<T | null> {
    if (!this.key) return null;

    const qs = new URLSearchParams({ ...params, method, api_key: this.key, format: 'json' });
    // The key is deliberately excluded from the cache key: it is a secret, the
    // cache is on disk, and rotating the key should not invalidate every row.
    const ck = `lastfm:${method}:${JSON.stringify(params)}`;

    const hit = this.store.cached<T>(ck, ttl);
    if (hit !== undefined) return hit;

    try {
      const body = await getJson<T & { error?: number; message?: string }>(`${API}?${qs}`, {
        timeoutMs: 15_000,
      });
      // Last.fm signals failure with HTTP 200 and an `error` field, so a
      // status check alone would cache an error object as though it were data.
      if (typeof body.error === 'number') return null;
      this.store.putCache(ck, body);
      return body;
    } catch {
      // A timeout or a DNS blip must degrade the page, not break it.
      return null;
    }
  }

  /** Artists Last.fm considers similar to `artist`, strongest first. */
  async similarArtists(artist: string, limit = 30): Promise<Similar[]> {
    const body = await this.call<{
      similarartists?: { artist?: { name?: string; match?: string }[] };
    }>('artist.getsimilar', { artist, limit: String(limit), autocorrect: '1' }, TTL_SIMILAR);
    return (body?.similarartists?.artist ?? [])
      .map((a) => ({ name: a.name ?? '', match: Number(a.match ?? 0) }))
      .filter((a) => a.name !== '');
  }

  /**
   * Artists similar to a specific track.
   *
   * track.getSimilar returns tracks, not artists, so the artist names are
   * lifted off them and de-duplicated. A track seed is a sharper signal than an
   * artist seed — it says which *part* of an artist's range was wanted.
   */
  async similarFromTrack(artist: string, track: string, limit = 30): Promise<Similar[]> {
    const body = await this.call<{
      similartracks?: { track?: { match?: number; artist?: { name?: string } }[] };
    }>(
      'track.getsimilar',
      { artist, track, limit: String(limit), autocorrect: '1' },
      TTL_SIMILAR,
    );
    const best = new Map<string, number>();
    for (const t of body?.similartracks?.track ?? []) {
      const name = t.artist?.name;
      if (!name) continue;
      const m = Number(t.match ?? 0);
      best.set(name, Math.max(best.get(name) ?? 0, m));
    }
    return [...best].map(([name, match]) => ({ name, match }));
  }

  /**
   * An artist's most-listened tracks — real titles for the songs shelf.
   *
   * Exists because the recommender used to fabricate a placeholder called
   * "Top tracks by X" for artists needing a download, and once tiles became
   * actionable someone clicked one and was told, truthfully and uselessly,
   * that no album contains that song. Real recommendations need real titles.
   */
  async artistTopTracks(
    artist: string,
    limit = 3,
  ): Promise<{ title: string; listeners: number }[]> {
    const body = await this.call<{
      toptracks?: { track?: { name?: string; listeners?: string }[] };
    }>('artist.gettoptracks', { artist, limit: String(limit), autocorrect: '1' }, TTL_TAGS);
    return (body?.toptracks?.track ?? [])
      .map((t) => ({ title: t.name ?? '', listeners: Number(t.listeners ?? 0) }))
      .filter((t) => t.title !== '');
  }

  /**
   * Song search ranked by listeners — the relevance MusicBrainz cannot supply.
   *
   * MusicBrainz scores every exact title match 100, so "the scientist" put a
   * dozen obscurities and bootlegs above the song with three million
   * listeners. Last.fm's index knows what people actually play; MusicBrainz
   * then supplies ids when a result needs downloading.
   */
  async trackSearch(
    term: string,
    limit = 12,
  ): Promise<{ title: string; artistName: string; listeners: number }[]> {
    type Row = { title: string; artistName: string; listeners: number };

    const one = async (track: string, artist?: string): Promise<Row[]> => {
      const body = await this.call<{
        results?: {
          trackmatches?: { track?: { name?: string; artist?: string; listeners?: string }[] };
        };
      }>(
        'track.search',
        { track, ...(artist ? { artist } : {}), limit: String(limit) },
        TTL_CHART,
      );
      return (body?.results?.trackmatches?.track ?? [])
        .map((t) => ({
          title: t.name ?? '',
          artistName: t.artist ?? '',
          listeners: Number(t.listeners ?? 0),
        }))
        .filter((t) => t.title !== '' && t.artistName !== '');
    };

    // People type "the scientist coldplay" as one string, and Last.fm's
    // combined match for that is a page of covers with the original nowhere.
    // Its artist parameter fixes it — but nothing marks where the song ends
    // and the artist begins, so every split from the end is tried (up to
    // three words of artist) alongside the unsplit query. All variants are
    // cached, merged, and ranked by listeners — the popularity order the
    // search box was missing.
    const words = term.trim().split(/\s+/);
    const attempts: Promise<Row[]>[] = [one(term)];
    for (let i = 1; i <= Math.min(3, words.length - 1); i++) {
      const track = words.slice(0, words.length - i).join(' ');
      const artist = words.slice(words.length - i).join(' ');
      attempts.push(one(track, artist));
    }

    const merged = new Map<string, Row>();
    for (const rows of await Promise.all(attempts)) {
      for (const r of rows) {
        const k = `${r.artistName.toLowerCase()}|${r.title.toLowerCase()}`;
        const cur = merged.get(k);
        if (!cur || r.listeners > cur.listeners) merged.set(k, r);
      }
    }
    return [...merged.values()]
      .sort((a, b) => b.listeners - a.listeners)
      .slice(0, limit);
  }

  /**
   * The most-listened tracks for a tag — a genre, a decade ("90s") or a year.
   *
   * This is the one place a chart by *time* exists anywhere in the stack:
   * MusicBrainz can list what came out in 1997 but has no idea what mattered,
   * and Last.fm's tag corpus does. Year and decade tags are applied by
   * listeners, so they mean "music people associate with 1997" rather than
   * strictly "released in 1997" — which is the more useful of the two answers.
   */
  async tagTopTracks(
    tag: string,
    limit = 40,
  ): Promise<{ title: string; artistName: string; listeners: number }[]> {
    const body = await this.call<{
      tracks?: { track?: { name?: string; listeners?: string; artist?: { name?: string } }[] };
    }>('tag.gettoptracks', { tag, limit: String(limit) }, TTL_CHART);
    return (body?.tracks?.track ?? [])
      .map((t) => ({
        title: t.name ?? '',
        artistName: t.artist?.name ?? '',
        listeners: Number(t.listeners ?? 0),
      }))
      .filter((t) => t.title !== '' && t.artistName !== '');
  }

  /**
   * The most-listened artists for a tag — the artist twin of tagTopTracks, feeding the
   * "Top artists by genre/year" shelves on Discover. Same day-long chart cache.
   */
  async tagTopArtists(tag: string, limit = 40): Promise<{ name: string; listeners: number }[]> {
    const body = await this.call<{
      topartists?: { artist?: { name?: string; listeners?: string }[] };
    }>('tag.gettopartists', { tag, limit: String(limit) }, TTL_CHART);
    return (body?.topartists?.artist ?? [])
      .map((a) => ({ name: a.name ?? '', listeners: Number(a.listeners ?? 0) }))
      .filter((a) => a.name !== '');
  }

  /**
   * A biography, when Last.fm has one.
   *
   * Exists because Lidarr's overview is empty for a great many artists — System of a Down among
   * them — and an artist page whose "useful info" section is blank for half the library is not
   * useful. Last.fm's summary is shorter but far more consistently present.
   *
   * The trailing "Read more on Last.fm" link and its markup are stripped: it is boilerplate on
   * every single response and renders as raw HTML in a text node.
   */
  async artistBio(artist: string): Promise<string> {
    const body = await this.call<{ artist?: { bio?: { summary?: string } } }>(
      'artist.getinfo',
      { artist, autocorrect: '1' },
      TTL_SIMILAR,
    );
    const raw = body?.artist?.bio?.summary ?? '';
    return raw
      .replace(/<a\b[^>]*>.*?<\/a>/gis, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s*Read more on Last\.fm.*$/is, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** The tags Last.fm's listeners apply to an artist — our stand-in for genre. */
  async topTags(artist: string, limit = 5): Promise<string[]> {
    const body = await this.call<{ toptags?: { tag?: { name?: string }[] } }>(
      'artist.gettoptags',
      { artist, autocorrect: '1' },
      TTL_TAGS,
    );
    return (body?.toptags?.tag ?? [])
      .map((t) => t.name ?? '')
      .filter(Boolean)
      .slice(0, limit);
  }

  /** Top artists for a tag. Drives the genre rows, and the cold-start page. */
  async tagArtists(tag: string, limit = 20): Promise<string[]> {
    const body = await this.call<{ topartists?: { artist?: { name?: string }[] } }>(
      'tag.gettopartists',
      { tag, limit: String(limit) },
      TTL_TAGS,
    );
    return (body?.topartists?.artist ?? []).map((a) => a.name ?? '').filter(Boolean);
  }

  /**
   * Global chart.
   *
   * Only used when there are too few seeds to personalise anything — a brand
   * new library has nothing to reason from, and an empty front page is worse
   * than a generic one.
   */
  async chartArtists(limit = 30): Promise<string[]> {
    const body = await this.call<{ artists?: { artist?: { name?: string }[] } }>(
      'chart.gettopartists',
      { limit: String(limit) },
      TTL_CHART,
    );
    return (body?.artists?.artist ?? []).map((a) => a.name ?? '').filter(Boolean);
  }
}
