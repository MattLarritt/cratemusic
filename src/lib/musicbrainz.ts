import { getJson } from './http.js';
import type { Store } from './store.js';

/**
 * MusicBrainz — the metadata source.
 *
 * This used to be Lidarr's job: its /search endpoint wrapped this same database
 * and added artwork on top. Going direct removes the dependency, at a real cost
 * worth naming: MusicBrainz allows one request per second, where Lidarr's
 * metadata server had no meaningful limit. Every read here is therefore cached
 * in SQLite — a search costs two rate-gated calls the first time and nothing
 * afterwards — and callers should treat a cold lookup as a couple of seconds,
 * not milliseconds.
 *
 * Artwork deliberately does NOT live here: covers come from the Cover Art
 * Archive and artist images from Deezer — see lib/artsource.ts.
 */

const API = 'https://musicbrainz.org/ws/2';

/**
 * How long a mirror is left alone after it fails, and the ceiling that backoff
 * climbs to.
 *
 * A mirror here is somebody's desktop, so being off is its normal state rather
 * than an incident. Without a breaker every single lookup would first spend the
 * connect timeout discovering the machine is asleep, making crate markedly
 * SLOWER with a mirror configured than without one.
 *
 * The window doubles while it stays down because the two cases look identical
 * from here and want opposite things: a machine rebooting should be picked up
 * within the minute, while one switched off for the night should not be probed
 * a thousand times to establish the same fact. Doubling gives the first and
 * avoids the second.
 */
const MIRROR_RETRY_MS = 60_000;
const MIRROR_RETRY_MAX_MS = 10 * 60_000;

/**
 * A mirror is on the LAN, so it either answers promptly or is not there.
 *
 * Kept short because a host that is off does not refuse the connection, it
 * drops it — measured against a machine with no mirror running, every probe
 * cost the full timeout rather than failing fast. That is latency a user pays,
 * so the budget is roughly a hundred times a healthy LAN response and no more.
 */
const MIRROR_TIMEOUT_MS = 1_500;

/**
 * Normalise a mirror base URL.
 *
 * Every MusicBrainz endpoint lives under /ws/2, but the URL an operator has in
 * hand is the one they opened in a browser — the bare host. Appending the path
 * when it is absent turns the likelier of the two mistakes into a working
 * setting instead of a silent 404 on every lookup.
 */
export function mirrorBase(v: string): string {
  const t = v.trim().replace(/\/+$/, '');
  if (!t) return '';
  return /\/ws\/2$/.test(t) ? t : `${t}/ws/2`;
}

/** Discographies barely change; a month is conservative. */
const TTL = 30 * 86400;

/** Searches are cheaper to re-run and staler-feeling when wrong; a week. */
const TTL_SEARCH = 7 * 86400;
/**
 * Answers keyed by an mbid, which do not change.
 *
 * A release group's tracklist and title were settled when the record came out;
 * re-asking MusicBrainz in thirty days buys a byte-identical response at the
 * cost of a request against a one-per-second budget. Together these are about
 * half of all traffic to them. This is not a leak — the sweep evicts on last
 * use, not age, so anything genuinely unused still goes.
 */
const TTL_IMMUTABLE = 100 * 365 * 86400;

/**
 * Normalised result shapes.
 *
 * These carry the field names the client has always seen — they were shaped by
 * the old Lidarr client, and keeping them meant removing Lidarr without
 * rewriting every component that renders a search result. `images` is filled by
 * the API layer with crate's own /api/art URLs rather than anything remote.
 */
export interface Images {
  poster?: string;
  cover?: string;
  fanart?: string;
  banner?: string;
  logo?: string;
}

export interface ArtistHit {
  kind: 'artist';
  mbid: string;
  name: string;
  disambiguation: string;
  overview: string;
  genres: string[];
  images: Images;
  libraryId: number | null;
  trackFiles: number;
}

export interface AlbumHit {
  kind: 'album';
  mbid: string;
  title: string;
  trackFiles: number;
  artistName: string;
  artistMbid: string;
  albumType: string;
  releaseDate: string;
  genres: string[];
  images: Images;
  rating: number | null;
  libraryId: number | null;
}

export type Hit = ArtistHit | AlbumHit;

/**
 * Escape a user-typed term for a Lucene query.
 *
 * MusicBrainz's search syntax treats + - && || ! ( ) { } [ ] ^ " ~ * ? : \ / as
 * operators, and a search for an album with a bracket in its name — half of all
 * remasters — would otherwise be a syntax error, which MusicBrainz reports as
 * HTTP 400 and the user would see as "search is broken".
 */
function lucene(term: string): string {
  return term.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, (c) => '\\' + c);
}

/**
 * Compare-only normalisation: case, accents and punctuation folded away.
 *
 * Local rather than imported from lib/release.ts so this module keeps no
 * dependency on the download side; the rules only need to agree with
 * themselves.
 */
function norm(v: string): string {
  return v
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The lead of a multi-artist credit: "Post Malone & Swae Lee" -> "Post Malone". */
function primary(a: string): string {
  const first = a.split(/\s*(?:,|&|\bfeat\.?\b|\bfeaturing\b|\bwith\b|\bvs\.?\b)\s*/i)[0];
  return (first ?? a).trim() || a;
}

/** Escape for the inside of a quoted Lucene phrase, where only \ and " bite. */
function quoted(term: string): string {
  return term.replace(/[\\"]/g, (c) => '\\' + c);
}

/**
 * MusicBrainz asks for one request per second and a descriptive User-Agent, and
 * enforces both — a generic agent gets blocked outright. Requests are therefore
 * serialised through a single promise chain with a minimum gap, rather than
 * fired in parallel.
 */
const MIN_GAP_MS = 1100;

export interface Track {
  position: number;
  title: string;
  /** Milliseconds, or null when MusicBrainz does not know. */
  lengthMs: number | null;
}

export interface StudioAlbum {
  mbid: string;
  title: string;
  firstReleased: string;
  /**
   * The release group's own artist credit, joined ("Eminem", "Stretch Armstrong, Eminem").
   *
   * Carried because a browse by artist returns everything the artist is CREDITED on, which
   * includes other people's mixtapes. The artist page is happy to list those; a download
   * target must not be one. See albumContainingTrack.
   */
  artistCredit: string;
}

/**
 * A partial MusicBrainz date, padded so string comparison orders it honestly.
 *
 * MusicBrainz dates come as "2000", "2000-05" or "2000-05-22", and a plain string sort puts
 * "2000" BEFORE "2000-05-22". That is how The Marshall Mathers LP Snippet Tape — dated just
 * "2000" — beat The Marshall Mathers LP (2000-05-22) when resolving "The Real Slim Shady", and
 * crate went looking for a snippet tape at the indexers. Unofficial releases are exactly the
 * ones with vague dates, so the sort was systematically biased toward bootlegs.
 *
 * Padded to the END of the period: if all we know is the year, it does not get to claim it came
 * out in January and win a race against a release with a real date.
 */
function dateKey(d: string): string {
  if (!d) return '9999-12-31';
  if (/^\d{4}$/.test(d)) return `${d}-12-31`;
  if (/^\d{4}-\d{2}$/.test(d)) return `${d}-31`;
  return d;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ArtistInfo {
  mbid: string;
  name: string;
  disambiguation: string;
  genres: string[];
  country: string;
  began: string;
  ended: string;
}

export interface AlbumInfo {
  title: string;
  artistName: string;
  releaseDate: string | null;
  artistMbid: string | null;
}

/**
 * Which queue a request waits in.
 *
 * One rate limit, three audiences, and strict priority between them:
 *
 *   fg   — somebody is waiting on this: a search, an artist page, a request.
 *   bg   — artwork, filling a cache for a page already on screen.
 *   idle — bulk work with no reader: a library import chewing through a
 *          thousand rows.
 *
 * The three-lane split is not theoretical. With imports sharing the artwork
 * lane, a running import kept hundreds of lookups queued at one per second, so
 * NO artwork could resolve inside its request budget: every tile held a
 * connection for the full five seconds then 404ed, dozens at a time, until the
 * browser's connection pool was full of doomed requests and the page appeared
 * to hang — blamed on the browser twice before the access log named it. Bulk
 * work must never be able to do that.
 */
export type Lane = 'fg' | 'bg' | 'idle';

export class MusicBrainz {
  private queues: Record<Lane, (() => Promise<void>)[]> = { fg: [], bg: [], idle: [] };
  private pumping = false;
  private lastAt = 0;

  /**
   * @param warn Where to report a failed lookup. A silent failure here is
   *   indistinguishable from an artist genuinely having no albums, which is the
   *   difference between "cannot size this" and "nothing to download" — so it
   *   must be visible rather than swallowed.
   */
  /**
   * @param mirror Base URL of a local MusicBrainz mirror, or '' for none. Read
   *   through a function rather than captured, so switching it on in the admin
   *   page takes effect without a restart.
   */
  constructor(
    private store: Store,
    private userAgent: string,
    private warn: (msg: string) => void = () => {},
    private mirror: () => string = () => '',
  ) {}

  private mirrorDownUntil = 0;
  private mirrorFails = 0;

  /** Whether the mirror is configured and not currently in its backoff window. */
  mirrorLive(): boolean {
    return Boolean(mirrorBase(this.mirror())) && Date.now() >= this.mirrorDownUntil;
  }

  /**
   * The mirror's state, for the admin screen.
   *
   * This exists because a mirror that quietly stopped answering is EXPENSIVE and INVISIBLE.
   * Falling back to the public API is correct — it is why the breaker exists — but it also
   * means every uncached lookup goes from instant to a second in a queue, and the only trace
   * was a warn line in the container log. A configured mirror sitting in backoff is worth
   * saying out loud where somebody will read it.
   */
  mirrorStatus(): { configured: boolean; live: boolean; downForS: number; fails: number } {
    const configured = Boolean(mirrorBase(this.mirror()));
    const downForS = Math.max(0, Math.round((this.mirrorDownUntil - Date.now()) / 1000));
    return { configured, live: configured && downForS === 0, downForS, fails: this.mirrorFails };
  }

  /**
   * One MusicBrainz call, preferring a local mirror.
   *
   * The mirror is deliberately NOT rate limited or queued — removing the one
   * request per second is the entire reason to run one, and a mirror that
   * inherited the gate would be no faster than the public API. It also means a
   * bulk import stops competing with somebody's search.
   *
   * Falling back has to distinguish three answers that look alike.
   *
   * A transport error means the machine is off, so the breaker trips and every
   * later call goes public until it opens. An HTTP error means the mirror
   * answered and had nothing useful to say, so this call falls back but the
   * breaker stays shut — one 404 is not an outage.
   *
   * The third is the dangerous one: HTTP 200 carrying an EMPTY result. A mirror
   * whose search indexes are still building answers `count: 0` for every query,
   * which is not "this artist does not exist" but "I have no index for that
   * yet" — and the two are indistinguishable in the response. Believing it cost
   * a real outage: searching Bastille returned nothing and the artist page said
   * there was no metadata, because an empty answer from a mirror mid-import had
   * been cached as fact for a week. So `usable` lets each caller say what a
   * real answer looks like, and anything short of one is re-asked upstream.
   * A genuine miss costs one extra public call; believing a false one breaks
   * the app until the cache expires.
   */
  private async json<T>(url: string, lane: Lane, usable?: (v: T) => boolean): Promise<T> {
    const base = mirrorBase(this.mirror());
    if (base && Date.now() >= this.mirrorDownUntil) {
      try {
        const out = await getJson<T>(url.replace(API, base), {
          headers: { 'User-Agent': this.userAgent },
          timeoutMs: MIRROR_TIMEOUT_MS,
        });
        // Back to healthy: the next outage starts its backoff from one minute
        // again rather than from wherever the last one left off. Reaching here
        // at all means the mirror is up, so an unusable answer below does NOT
        // count as a failure — it is still serving everything it has imported.
        this.mirrorFails = 0;
        if (!usable || usable(out)) return out;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.startsWith('HTTP ')) {
          const wait = Math.min(MIRROR_RETRY_MS * 2 ** this.mirrorFails, MIRROR_RETRY_MAX_MS);
          this.mirrorFails += 1;
          this.mirrorDownUntil = Date.now() + wait;
          this.warn(
            `MusicBrainz mirror unreachable (${msg}); using the public API, ` +
              `next probe in ${Math.round(wait / 1000)}s`,
          );
        }
      }
    }
    return this.gate(() => getJson<T>(url, { headers: { 'User-Agent': this.userAgent } }), lane);
  }

  private gate<T>(fn: () => Promise<T>, lane: Lane = 'fg'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queues[lane].push(() => fn().then(resolve, reject));
      void this.pump();
    });
  }

  /**
   * How many lookups are waiting at or above a lane's priority.
   *
   * The artwork endpoint reads this to decide whether waiting is worth it at
   * all: with a deep queue the answer cannot arrive inside a request budget,
   * so 404ing immediately and letting the background fill catch up beats
   * holding a browser connection open to no purpose.
   */
  depth(lane: Lane): number {
    const fg = this.queues.fg.length;
    if (lane === 'fg') return fg;
    const bg = fg + this.queues.bg.length;
    return lane === 'bg' ? bg : bg + this.queues.idle.length;
  }

  /** One pump drains all queues, interactive first, one request per gap. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const next = this.queues.fg.shift() ?? this.queues.bg.shift() ?? this.queues.idle.shift();
        if (!next) break;
        const wait = Math.max(0, this.lastAt + MIN_GAP_MS - Date.now());
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.lastAt = Date.now();
        // Serial on purpose: the next request starts only when this one is
        // done, so a burst can never exceed the limit however slow the
        // responses. The catch keeps one failure from stopping the pump —
        // the caller already got its rejection through gate()'s promise.
        await next().catch(() => undefined);
      }
    } finally {
      this.pumping = false;
    }
  }


  /**
   * Search artists and albums for the search box.
   *
   * Two queries rather than MusicBrainz's combined index, because the combined
   * one cannot filter release-groups by type — and without `primarytype:Album`
   * the first result for "Toxicity" is the single, not the album. Both hit the
   * cache, so a repeated search costs nothing.
   */
  async search(term: string): Promise<Hit[]> {
    const [artists, albums] = await Promise.all([
      this.searchArtists(term, 8),
      this.searchAlbums(term, 10),
    ]);
    return [...artists, ...albums];
  }

  async searchArtists(term: string, limit = 8, lane: Lane = 'fg'): Promise<ArtistHit[]> {
    const ck = `mb:sa:${limit}:${term.toLowerCase()}`;
    const hit = this.store.cached<ArtistHit[]>(ck, TTL_SEARCH);
    if (hit !== undefined) return hit;

    const url =
      `${API}/artist?fmt=json&limit=${limit}` +
      `&query=${encodeURIComponent(lucene(term))}`;
    try {
      const body = await this.json<{
        artists?: {
          id?: string;
          name?: string;
          disambiguation?: string;
          score?: number;
          tags?: { name?: string; count?: number }[];
        }[];
      }>(url, lane, (b) => Boolean(b.artists?.length));
      const out: ArtistHit[] = (body.artists ?? [])
        // Below 50 the index is free-associating; "bulls on parade" scores the
        // actual match 100 and a coincidental word-overlap artist 43.
        .filter((a) => a.id && a.name && (a.score ?? 0) >= 50)
        .map((a) => ({
          kind: 'artist' as const,
          mbid: a.id ?? '',
          name: a.name ?? '',
          disambiguation: a.disambiguation ?? '',
          overview: '',
          genres: (a.tags ?? [])
            .filter((t) => (t.count ?? 0) > 0 && t.name)
            .slice(0, 5)
            .map((t) => t.name ?? ''),
          images: {},
          libraryId: null,
          trackFiles: 0,
        }));
      this.store.putCache(ck, out);
      return out;
    } catch (err) {
      this.warn(`musicbrainz artist search failed for "${term}": ${msg(err)}`);
      return [];
    }
  }

  async searchAlbums(term: string, limit = 10, lane: Lane = 'fg'): Promise<AlbumHit[]> {
    const ck = `mb:sg:${limit}:${term.toLowerCase()}`;
    const hit = this.store.cached<AlbumHit[]>(ck, TTL_SEARCH);
    if (hit !== undefined) return hit;

    // Albums and EPs only. Without the filter the first "Toxicity" is a single,
    // and a search surface full of singles buries the records people mean.
    const url =
      `${API}/release-group?fmt=json&limit=${limit}` +
      `&query=${encodeURIComponent(`(${lucene(term)}) AND (primarytype:Album OR primarytype:EP)`)}`;
    try {
      const body = await this.json<{
        'release-groups'?: {
          id?: string;
          title?: string;
          score?: number;
          'primary-type'?: string;
          'first-release-date'?: string;
          'artist-credit'?: { name?: string; artist?: { id?: string; name?: string } }[];
        }[];
      }>(url, lane, (b) => Boolean(b['release-groups']?.length));
      const out: AlbumHit[] = (body['release-groups'] ?? [])
        .filter((rg) => rg.id && rg.title && (rg.score ?? 0) >= 50)
        .map((rg) => ({
          kind: 'album' as const,
          mbid: rg.id ?? '',
          title: rg.title ?? '',
          trackFiles: 0,
          artistName: rg['artist-credit']?.[0]?.name ?? rg['artist-credit']?.[0]?.artist?.name ?? '',
          artistMbid: rg['artist-credit']?.[0]?.artist?.id ?? '',
          albumType: rg['primary-type'] ?? 'Album',
          releaseDate: (rg['first-release-date'] ?? '').slice(0, 10),
          genres: [],
          images: {},
          rating: null,
          libraryId: null,
        }));
      this.store.putCache(ck, out);
      return out;
    } catch (err) {
      this.warn(`musicbrainz album search failed for "${term}": ${msg(err)}`);
      return [];
    }
  }

  /**
   * The year an album first came out, by artist and title.
   *
   * Exists because the TAGS cannot answer this. A scene rip stamps the year the RIP was
   * made, so Nebraska arrives tagged 2023 and Sweet Baby James 2023; only a release that
   * happens to carry an originalyear frame gives up the real date. MusicBrainz's
   * first-release-date is the actual answer, and a release GROUP is the right thing to ask:
   * the group IS the album, and its first release is the album's year however many
   * reissues came later.
   *
   * Both names must match before the date is trusted. A loose search returns something
   * plausible for an album MusicBrainz has never heard of, and a confidently wrong year is
   * worse than none — the caller falls back to the tag.
   *
   * Cached immortally. An album's first release date is a fact about the past.
   */
  async albumYear(artistName: string, albumTitle: string, lane: Lane = 'fg'): Promise<number | null> {
    const ck = `mb:year:${norm(artistName)}|${norm(albumTitle)}`;
    const hit = this.store.cached<number | null>(ck, TTL_IMMUTABLE);
    if (hit !== undefined) return hit;

    const query =
      `artist:"${lucene(artistName)}" AND releasegroup:"${lucene(albumTitle)}"` +
      ` AND (primarytype:Album OR primarytype:EP)`;
    const url = `${API}/release-group?fmt=json&limit=8&query=${encodeURIComponent(query)}`;

    try {
      const body = await this.json<{
        'release-groups'?: {
          title?: string;
          'first-release-date'?: string;
          'secondary-types'?: string[];
          'artist-credit'?: { name?: string; artist?: { name?: string } }[];
        }[];
        // The lane only decides where this sits when falling back to the public API (the
        // mirror path skips the queue altogether). It defaults to 'fg' because somebody is
        // usually waiting on an album page; the page warmer passes 'idle' so a backfill of
        // three hundred albums can never queue ahead of a live one.
      }>(url, lane, (b) => Boolean(b['release-groups']?.length));

      const wantArtist = norm(artistName);
      const wantAlbum = norm(albumTitle);

      /*
       * A plain album ahead of a live record or compilation sharing its name, then earliest
       * first — "Nebraska" the album, not "Nebraska" some later live set.
       *
       * UNLESS the album artist is Various Artists, in which case a compilation is exactly
       * what is being looked for and preferring a plain album would take some unrelated
       * studio record's year instead.
       */
      const wantCompilation = norm(artistName) === norm('Various Artists');
      const ranked = (body['release-groups'] ?? [])
        .filter((rg) => rg['first-release-date'])
        .sort((a, b) => {
          const rank = (rg: (typeof a)) => {
            const secondary = rg['secondary-types'] ?? [];
            if (wantCompilation) return secondary.some((t) => /compilation/i.test(t)) ? 0 : 1;
            return secondary.length;
          };
          const sec = rank(a) - rank(b);
          return sec !== 0 ? sec : (a['first-release-date'] ?? '').localeCompare(b['first-release-date'] ?? '');
        });

      for (const rg of ranked) {
        const credit = rg['artist-credit']?.[0];
        const gotArtist = norm(credit?.name ?? credit?.artist?.name ?? '');
        if (norm(rg.title ?? '') !== wantAlbum) continue;
        // Containment either way, so "Bruce Springsteen" matches a credit of "Bruce
        // Springsteen & The E Street Band" without matching an unrelated act.
        if (!gotArtist.includes(wantArtist) && !wantArtist.includes(gotArtist)) continue;
        const year = Number((rg['first-release-date'] ?? '').slice(0, 4));
        if (!Number.isInteger(year) || year < 1877) continue;
        this.store.putCache(ck, year);
        return year;
      }
      // A confident "MusicBrainz does not have this album" is worth caching too, or every
      // page view re-asks about the same unknown record.
      this.store.putCache(ck, null);
      return null;
    } catch (err) {
      // NOT cached: a transient failure must not become a month of a blank year.
      this.warn(`musicbrainz year lookup failed for "${artistName} — ${albumTitle}": ${msg(err)}`);
      return null;
    }
  }

  /**
   * One artist by mbid — the artist page's identity, genres and lifespan.
   *
   * A direct lookup, not a search: the mbid is already known, and lookups are
   * both exact and cheaper on MusicBrainz's side.
   */
  async artistInfo(mbid: string, lane: Lane = 'fg'): Promise<ArtistInfo | null> {
    const ck = `mb:artist:${mbid}`;
    const hit = this.store.cached<ArtistInfo | null>(ck, TTL);
    if (hit !== undefined) return hit;

    const url = `${API}/artist/${encodeURIComponent(mbid)}?fmt=json&inc=genres`;
    try {
      const body = await this.json<{
        id?: string;
        name?: string;
        disambiguation?: string;
        country?: string;
        'life-span'?: { begin?: string; end?: string };
        genres?: { name?: string; count?: number }[];
      }>(url, lane, (b) => Boolean(b.id && b.name));
      if (!body.id || !body.name) return null;
      const info = {
        mbid: body.id,
        name: body.name,
        disambiguation: body.disambiguation ?? '',
        genres: (body.genres ?? [])
          .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
          .slice(0, 6)
          .map((g) => g.name ?? '')
          .filter(Boolean),
        country: body.country ?? '',
        began: body['life-span']?.begin ?? '',
        ended: body['life-span']?.end ?? '',
      };
      this.store.putCache(ck, info);
      return info;
    } catch (err) {
      this.warn(`musicbrainz artist lookup failed for ${mbid}: ${msg(err)}`);
      return null;
    }
  }

  /**
   * One album (release group) by mbid — what the pipeline needs to search for
   * it: whose record it is, what it is called, and roughly when it came out.
   */
  async albumInfo(mbid: string): Promise<AlbumInfo | null> {
    const ck = `mb:rginfo:${mbid}`;
    const hit = this.store.cached<AlbumInfo | null>(ck, TTL_IMMUTABLE);
    if (hit !== undefined) return hit;

    const url = `${API}/release-group/${encodeURIComponent(mbid)}?fmt=json&inc=artists`;
    try {
      const body = await this.json<{
        title?: string;
        'first-release-date'?: string;
        'artist-credit'?: { name?: string; artist?: { id?: string; name?: string } }[];
      }>(url, 'fg', (b) => Boolean(b.title));
      if (!body.title) return null;
      const credit = body['artist-credit']?.[0];
      const info = {
        title: body.title,
        artistName: credit?.name ?? credit?.artist?.name ?? '',
        releaseDate: body['first-release-date'] || null,
        artistMbid: credit?.artist?.id ?? null,
      };
      this.store.putCache(ck, info);
      return info;
    } catch (err) {
      this.warn(`musicbrainz album lookup failed for ${mbid}: ${msg(err)}`);
      return null;
    }
  }

  /**
   * Which of an artist's studio albums contains a song, by walking them.
   *
   * Slower than a recording search and far more reliable: studioAlbums already
   * excludes live records, compilations and remix albums, so a hit here is the
   * record the song belongs to rather than the fortieth compilation it was
   * licensed to. Every call is cached, and the tracklists are shared with the
   * album pages, so a second song by the same artist is usually free.
   */
  async albumContainingTrack(
    artist: string,
    title: string,
    lane: Lane = 'fg',
  ): Promise<{ albumMbid: string; albumTitle: string } | null> {
    const artists = await this.searchArtists(artist, 3, lane);
    const want = new Set([norm(artist), norm(primary(artist))]);
    const found = artists.find((a) => want.has(norm(a.name))) ?? artists[0];
    if (!found?.mbid) return null;
    if (!want.has(norm(found.name))) return null;

    const albums = await this.studioAlbums(found.mbid);
    const wantTitle = norm(title);
    /*
     * THE RELEASE GROUP MUST BE THE ARTIST'S OWN, not merely something they appear on.
     *
     * Browsing release groups by artist returns everything they are credited on, and
     * MusicBrainz types plenty of other people's mixtapes as plain Albums. Resolving "The Real
     * Slim Shady" walked into "The Marshall Mathers LP Snippet Tape", credited to "Stretch
     * Armstrong, Eminem" — a DJ's promo tape — and crate then went looking for a Stretch
     * Armstrong release at the indexers and found nothing, which is the correct outcome for the
     * wrong question.
     *
     * The test is the FIRST credited artist: a record is filed under whoever leads its credit.
     * That keeps "Eminem, Dr. Dre" and drops "Stretch Armstrong, Eminem", which is exactly the
     * distinction between a collaboration and a guest appearance. The artist page is
     * deliberately unaffected — it may list everything; only a download target must be strict.
     */
    const leads = (credit: string): boolean => {
      const first = credit.split(',')[0]?.trim() ?? '';
      return first === '' || want.has(norm(first)) || want.has(norm(primary(first)));
    };
    const own = albums.filter((a) => leads(a.artistCredit));
    // Oldest first: a song belongs to the record it debuted on, and a later
    // album occasionally re-records or reprises it.
    for (const a of [...own].reverse()) {
      const tracks = await this.tracks(a.mbid);
      if (tracks.some((t) => norm(t.title) === wantTitle)) {
        return { albumMbid: a.mbid, albumTitle: a.title };
      }
    }
    return null;
  }

  /**
   * Songs matching a free-typed search, each with the album it lives on.
   *
   * A recording search, not a release-group search — the difference is the
   * whole feature. Searching albums for "the scientist" finds albums CALLED
   * The Scientist and never Coldplay's song, which lives on A Rush of Blood
   * to the Head. People search for songs by song name.
   */
  async searchRecordings(
    term: string,
    limit = 12,
    lane: Lane = 'fg',
  ): Promise<
    { title: string; artistName: string; albumMbid: string; albumTitle: string; lengthMs: number | null }[]
  > {
    const ck = `mb:sr:${limit}:${term.toLowerCase()}`;
    type Out = Awaited<ReturnType<MusicBrainz['searchRecordings']>>;
    const hit = this.store.cached<Out>(ck, TTL_SEARCH);
    if (hit !== undefined) return hit;

    const url =
      `${API}/recording?fmt=json&limit=${Math.min(limit * 3, 40)}` +
      `&query=${encodeURIComponent(lucene(term))}`;

    interface Rec {
      title?: string;
      score?: number;
      length?: number;
      'artist-credit'?: { name?: string; artist?: { name?: string } }[];
      releases?: {
        'release-group'?: {
          id?: string;
          title?: string;
          'primary-type'?: string;
          'secondary-types'?: string[];
        };
      }[];
    }

    try {
      const body = await this.json<{ recordings?: Rec[] }>(url, lane, (b) =>
        Boolean(b.recordings?.length),
      );

      // One entry per (artist, title), keeping the BEST-homed one, not the
      // first. The same song exists as many recordings — studio, live,
      // remaster — and the first hit for The Scientist was a Glastonbury
      // bootleg. A studio album beats an EP beats everything else, same
      // preference as albumForTrack: downloading the containing album should
      // fetch the record.
      const best = new Map<
        string,
        { entry: Out[number]; tier: number; order: number }
      >();
      let order = 0;
      for (const rec of body.recordings ?? []) {
        if ((rec.score ?? 0) < 60 || !rec.title) continue;
        const artist = rec['artist-credit']?.[0]?.name ?? rec['artist-credit']?.[0]?.artist?.name;
        if (!artist) continue;

        let home: { id: string; title: string; tier: number } | null = null;
        for (const rel of rec.releases ?? []) {
          const rg = rel['release-group'];
          if (!rg?.id || !rg.title) continue;
          const secondary = (rg['secondary-types'] ?? []).length > 0;
          const tier =
            rg['primary-type'] === 'Album' && !secondary ? 0
            : rg['primary-type'] === 'EP' && !secondary ? 1
            : 2;
          if (!home || tier < home.tier) home = { id: rg.id, title: rg.title, tier };
          if (home.tier === 0) break;
        }
        if (!home) continue;

        const key = `${artist.toLowerCase()}|${rec.title.toLowerCase()}`;
        const cur = best.get(key);
        if (cur && cur.tier <= home.tier) continue;
        best.set(key, {
          entry: {
            title: rec.title,
            artistName: artist,
            albumMbid: home.id,
            albumTitle: home.title,
            lengthMs: typeof rec.length === 'number' ? rec.length : null,
          },
          tier: home.tier,
          order: cur?.order ?? order++,
        });
      }
      const out: Out = [...best.values()]
        .sort((a, b) => a.order - b.order)
        .slice(0, limit)
        .map((b) => b.entry);
      this.store.putCache(ck, out);
      return out;
    } catch (err) {
      this.warn(`musicbrainz recording search failed for "${term}": ${msg(err)}`);
      return [];
    }
  }

  /**
   * The album (release group) a track lives on, by names alone.
   *
   * This is what turns "download this song" into an album the pipeline can
   * fetch when the caller has no ids at all — a Last.fm chart entry is an
   * artist name and a title, nothing more. Prefers a proper studio album over
   * singles and compilations, because the point of downloading the containing
   * album is that the rest of it is worth having in the pool too.
   */
  async albumForTrack(
    artist: string,
    title: string,
    lane: Lane = 'fg',
  ): Promise<{ albumMbid: string; albumTitle: string } | null> {
    const ck = `mb:rec2:${artist.toLowerCase()}|${title.toLowerCase()}`;
    const hit = this.store.cached<{ albumMbid: string; albumTitle: string } | null>(ck, TTL);
    if (hit !== undefined) return hit;

    interface Rec {
      score?: number;
      title?: string;
      'artist-credit'?: { name?: string; artist?: { name?: string } }[];
      releases?: {
        status?: string;
        'release-group'?: {
          id?: string;
          title?: string;
          'primary-type'?: string;
          'secondary-types'?: string[];
        };
      }[];
    }

    const lookup = async (query: string): Promise<{ recordings?: Rec[] }> =>
      this.json<{ recordings?: Rec[] }>(
        `${API}/recording?fmt=json&limit=10&query=${encodeURIComponent(query)}`,
        lane,
        (b) => Boolean(b.recordings?.length),
      );

    const base = `artist:"${quoted(artist)}" AND recording:"${quoted(title)}"`;

    /**
     * Does this recording actually belong to the artist asked about?
     *
     * MusicBrainz's query syntax SCORES, it does not filter: a search for
     * artist:"Massive Attack" AND recording:"Teardrop" happily returns a
     * Teardrop by somebody else with a passing score. Without this check the
     * first such hit with a studio album won, and Massive Attack's Teardrop
     * resolved to "Bubu! / I Set My Pixels on Fire" — which then found nothing
     * at any indexer, because of course it did. Wrong metadata is worse than
     * none: it sends a download after music nobody asked for.
     */
    const wanted = new Set([norm(artist), norm(primary(artist))]);
    const artistMatches = (rec: Rec): boolean =>
      (rec['artist-credit'] ?? []).some((c) => {
        const n = c.name ?? c.artist?.name ?? '';
        return n !== '' && (wanted.has(norm(n)) || wanted.has(norm(primary(n))));
      });

    try {
      // Two passes, strict first. Popular songs drown in bootlegs and tribute
      // compilations: the unfiltered lookup for Coldplay's The Scientist chose
      // "Life Is for Living", an unofficial compilation typed as a plain
      // Album, while filtering to official studio albums returned exactly
      // A Rush of Blood to the Head. The loose pass remains for songs that
      // genuinely have no studio album — soundtrack- or single-only releases.
      const strict = { recordings: [] as Rec[] };

      let best: { albumMbid: string; albumTitle: string; tier: number; official: boolean } | null =
        null;
      const consider = (recs: Rec[] | undefined, officialOnly: boolean): void => {
        for (const rec of recs ?? []) {
          if ((rec.score ?? 0) < 60) continue;
          if (!artistMatches(rec)) continue;
          if (!titleMatches(rec)) continue;
          for (const rel of rec.releases ?? []) {
            if (officialOnly && rel.status !== 'Official') continue;
            const rg = rel['release-group'];
            if (!rg?.id || !rg.title) continue;
            /*
             * FIVE TIERS, not three, because the old tier 2 was a bin.
             *
             * "Lose Yourself" is on no Eminem studio album — it belongs to the 8 Mile
             * soundtrack — so every candidate landed in tier 2 and the winner was whichever
             * MusicBrainz happened to return first. That produced "Eminem — My Favorite 20", an
             * obscure compilation, and the indexers had nothing for it.
             *
             * A soundtrack or a hits compilation is a perfectly good download target for a song
             * that only exists there; a mixtape, a demo or a single is not what somebody asking
             * for a song wants filed in their library. Separating those two is the difference
             * between finding the record and searching for a phantom.
             */
            const secondaries = rg['secondary-types'] ?? [];
            const secondary = secondaries.length > 0;
            const releaseLike = secondaries.some((t) => t === 'Soundtrack' || t === 'Compilation');
            const tier =
              rg['primary-type'] === 'Album' && !secondary ? 0
              : rg['primary-type'] === 'EP' && !secondary ? 1
              : rg['primary-type'] === 'Album' && releaseLike ? 2
              : rg['primary-type'] === 'Album' ? 3
              : 4;
            const official = rel.status === 'Official';
            const candidate = { albumMbid: rg.id, albumTitle: rg.title, tier, official };
            /*
             * Within a tier, an Official release beats a bootleg — the 8 Mile soundtrack is
             * listed both ways, and the bootleg copy is not what to go looking for.
             */
            if (!best || tier < best.tier || (tier === best.tier && official && !best.official)) {
              best = candidate;
            }
            if (best.tier === 0 && best.official) return;
          }
        }
      };

      // Only a recording whose TITLE is the wanted title, not a remix or a dub
      // of it. Massive Attack's Teardrop matched "Teardrop (Bubu Chiptune
      // remix)" at score 100, which is genuinely credited to Massive Attack
      // and genuinely a different recording — it downloaded a chiptune split
      // release. A parenthetical is meaningful here; it cannot be stripped.
      const wantTitle = norm(title);
      const titleMatches = (rec: Rec): boolean => norm(rec.title ?? '') === wantTitle;

      // The discography walk goes FIRST, because a recording search cannot be
      // trusted for a famous song and there is no cheap way to tell when it is
      // wrong. Teardrop's every top hit was a compilation or a live bootleg,
      // with Mezzanine nowhere in the results; Smells Like Teen Spirit came
      // back on In Utero, scored 100, artist and title both matching exactly.
      // Nothing about those answers looks wrong from the outside — so the
      // search stopped being the first choice and became the fallback for
      // songs that are genuinely not on a studio album.
      const viaDisc = await this.albumContainingTrack(artist, title, lane);
      if (viaDisc) {
        this.store.putCache(ck, viaDisc);
        return viaDisc;
      }

      // Not on any studio album: a single, a soundtrack, a one-off. Now the
      // recording search earns its place — strict first, then anything.
      strict.recordings = (
        await lookup(`${base} AND status:official AND primarytype:album AND NOT secondarytype:*`)
      ).recordings ?? [];
      consider(strict.recordings, true);
      // TS cannot see assignments made inside `consider`, so re-read through a
      // widened binding rather than the narrowed `best`.
      let found = best as
        | { albumMbid: string; albumTitle: string; tier: number; official: boolean }
        | null;
      if (!found) {
        const loose = await lookup(base);
        consider(loose.recordings, false);
        found = best as
          | { albumMbid: string; albumTitle: string; tier: number; official: boolean }
          | null;
      }

      const out = found ? { albumMbid: found.albumMbid, albumTitle: found.albumTitle } : null;
      this.store.putCache(ck, out);
      return out;
    } catch (err) {
      this.warn(`musicbrainz recording lookup failed for "${artist} — ${title}": ${msg(err)}`);
      return null;
    }
  }

  /**
   * Track listing for a release group, in one request.
   *
   * A release group can have many releases (pressings, regions, reissues) with
   * different track counts. Asking for `limit=1` with `inc=recordings` takes
   * the earliest OFFICIAL release, smallest edition on a tie.
   *
   * This used to take limit=1 — whatever release MusicBrainz listed first —
   * on the theory that any release in the group shows the same record. It
   * does not: for Deftones' White Pony the first listed release is an
   * unofficial demo pressing, so the page showed working titles ("new
   * murderer", "nightrider") for one of the best-known albums there is.
   * Filtering to official and preferring the earliest, smallest edition gets
   * the canonical tracklist and skips deluxe reissues; groups with no
   * official release at all (bootleg-only) fall back to whatever exists.
   */
  async tracks(releaseGroupMbid: string): Promise<Track[]> {
    const ck = `mb:tracks:${releaseGroupMbid}`;
    const hit = this.store.cached<Track[]>(ck, TTL_IMMUTABLE);
    if (hit !== undefined) return hit;

    interface Rel {
      status?: string;
      date?: string;
      media?: { tracks?: { position?: number; title?: string; length?: number }[] }[];
    }
    const fetchReleases = (officialOnly: boolean) =>
      this.json<{ releases?: Rel[] }>(
        `${API}/release?release-group=${encodeURIComponent(releaseGroupMbid)}` +
          `&inc=recordings&limit=25${officialOnly ? '&status=official' : ''}&fmt=json`,
        'fg',
        (b) => Boolean(b.releases?.length),
      );

    try {
      let body: { releases?: Rel[] };
      try {
        body = await fetchReleases(true);
      } catch {
        body = { releases: [] };
      }
      if (!body.releases?.length) body = await fetchReleases(false);

      const count = (r: Rel) =>
        (r.media ?? []).reduce((n, m) => n + (m.tracks?.length ?? 0), 0);
      const best = [...(body.releases ?? [])]
        .filter((r) => count(r) > 0)
        .sort(
          (a, b) =>
            (a.date || '9999').localeCompare(b.date || '9999') || count(a) - count(b),
        )[0];

      const out: Track[] = [];
      for (const m of best?.media ?? []) {
        for (const t of m.tracks ?? []) {
          if (!t.title) continue;
          out.push({
            position: t.position ?? out.length + 1,
            title: t.title,
            lengthMs: typeof t.length === 'number' ? t.length : null,
          });
        }
      }
      this.store.putCache(ck, out);
      return out;
    } catch (err) {
      this.warn(
        `musicbrainz tracks failed for ${releaseGroupMbid}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return [];
    }
  }

  /**
   * Studio albums for an artist, newest information first.
   *
   * Filters to `primary-type=Album` with no secondary types, which excludes
   * live albums, compilations, remixes and soundtracks. Without that filter a
   * well-documented artist looks like hundreds of releases — Radiohead returns
   * 384 release groups but has 10 studio albums, and sizing a request off 384
   * would make every artist look unaffordable.
   */
  async studioAlbums(artistMbid: string, lane: Lane = 'fg'): Promise<StudioAlbum[]> {
    const ck = `mb:rg:${artistMbid}`;
    const hit = this.store.cached<StudioAlbum[]>(ck, TTL);
    if (hit !== undefined) return hit;

    const url =
      `${API}/release-group?artist=${encodeURIComponent(artistMbid)}` +
      // artist-credits costs nothing extra — same request, one more field — and it is the only
      // way to tell "Eminem's album" from "a DJ mixtape Eminem is credited on". A browse by
      // artist returns both.
      `&type=album&limit=100&fmt=json&inc=artist-credits`;

    interface Body {
      'release-groups'?: {
        id?: string;
        title?: string;
        'primary-type'?: string;
        'secondary-types'?: string[];
        'first-release-date'?: string;
        'artist-credit'?: { name?: string; artist?: { name?: string } }[];
      }[];
    }

    try {
      // One retry, because MusicBrainz load-sheds with a 503 "currently busy"
      // rather than a rate-limit error, and it does so often enough to see on
      // two consecutive requests. Since an empty result is treated as "cannot
      // size this" and blocks a back-catalogue request, a single retry is the
      // difference between a working button and a confusing refusal.
      let body: Body | null = null;
      for (let attempt = 0; attempt < 2 && body === null; attempt++) {
        try {
          body = await this.json<Body>(url, lane, (b) =>
            Boolean(b['release-groups']?.length),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const transient = /HTTP 5\d\d|timed out/.test(msg);
          if (!transient || attempt === 1) throw err;
          this.warn(`musicbrainz busy for ${artistMbid}, retrying once: ${msg.slice(0, 120)}`);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      if (body === null) throw new Error('musicbrainz returned nothing');

      const out: StudioAlbum[] = (body['release-groups'] ?? [])
        .filter(
          (rg) =>
            rg['primary-type'] === 'Album' &&
            (rg['secondary-types'] ?? []).length === 0 &&
            rg.id,
        )
        .map((rg) => ({
          mbid: rg.id ?? '',
          title: rg.title ?? '',
          firstReleased: (rg['first-release-date'] ?? '').slice(0, 10),
          artistCredit: (rg['artist-credit'] ?? [])
            .map((c) => c.name ?? c.artist?.name ?? '')
            .filter(Boolean)
            .join(', '),
        }))
        // Newest first, on a padded date so "2000" does not pose as 1 January — see dateKey.
        .sort((a, b) => dateKey(b.firstReleased).localeCompare(dateKey(a.firstReleased)));

      this.store.putCache(ck, out);
      return out;
    } catch (err) {
      // A MusicBrainz outage must not block requests. An empty list means the
      // caller sees zero albums, and the cap logic treats "unknown size" as a
      // refusal for the back-catalogue path — see routes/api.ts.
      //
      // Deliberately not cached: caching a failure would turn a transient blip
      // into a month of an artist appearing to have no albums.
      this.warn(
        `musicbrainz lookup failed for ${artistMbid}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return [];
    }
  }
}
