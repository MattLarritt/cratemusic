import type Database from 'better-sqlite3';
import { nowSec } from '../db/schema.js';
import type { LastFm } from './lastfm.js';
import type { MusicBrainz } from './musicbrainz.js';

/**
 * Page warming: pay for an artist or album page BEFORE somebody opens it.
 *
 * THE PROBLEM, MEASURED. An artist page is two MusicBrainz calls (artistInfo, studioAlbums)
 * plus a Last.fm biography, and MusicBrainz asks for no more than one request per second. On
 * the live library that made a first visit take 3.3s at the median and 8.9s at worst, while
 * every visit after it took 15ms — the caches work, nobody had filled them. 336 of 385 artists
 * had never been opened, so almost every artist page was somebody's first.
 *
 * So this walks the library and makes those calls with nobody waiting. Two rules keep it
 * invisible:
 *
 * IDLE LANE, ALWAYS. Every lookup goes through MusicBrainz's idle queue, which yields to
 * anything a person is waiting on. This is not a nicety — lib/musicbrainz.ts documents an
 * earlier incident where bulk work shared the artwork lane and starved it until pages appeared
 * to hang. A three-hundred-artist backfill is exactly that shape of work.
 *
 * ONE ITEM PER TICK. A trickle, like the analyser and the importer: no batch, no parallelism,
 * no completion pressure. The queue is ordered by PLAY COUNT, so the artists somebody actually
 * listens to are ready first and the long tail fills in over the following hour.
 *
 * WHAT IT DOES NOT DO. Artwork: covers have their own cache, their own lane and their own
 * retry ladder (lib/artcache.ts), and the artist page already kicks them off on arrival. This
 * is about the metadata that blocks the response.
 *
 * KEEPING IN STEP WITH THE PAGES. `warmArtist` and `warmAlbum` deliberately call the same
 * service methods routes/api.ts calls, in the same order. If a page grows a fourth lookup and
 * this does not, the page simply gets slower again — so the two lists belong together, and
 * that is the one thing to check when either changes.
 */

/** Give up on an item after this many failed attempts. */
const MAX_ATTEMPTS = 3;
/** Re-warm an artist this long after a successful pass, so a mood-shifting cache TTL is met. */
const REFRESH_S = 25 * 86400;

export type WarmKind = 'artist' | 'album';
export type WarmTick = 'disabled' | 'idle' | 'warmed' | 'failed' | 'busy';

export interface WarmProgress {
  artists: { total: number; warm: number; pending: number; failed: number };
  albums: { total: number; warm: number; pending: number; failed: number };
  /** What the worker is on right now, for a status line. */
  current: string;
  enabled: boolean;
  /**
   * The MusicBrainz mirror's state, reported here because this is where its absence is felt:
   * with the mirror live, warming is limited only by how fast it answers; without it, every
   * lookup queues behind the public API's one per second and the backfill takes an hour.
   */
  mirror: { configured: boolean; live: boolean; downForS: number; fails: number };
}

interface Row {
  kind: WarmKind;
  key: string;
  name: string;
  album: string;
  attempts: number;
}

export class PageWarmer {
  /** Set while a tick is in flight, so a slow lookup cannot overlap the next interval. */
  private working = '';

  constructor(
    private db: Database.Database,
    private mb: MusicBrainz,
    private lastfm: LastFm,
    private enabled: () => boolean,
    private log: { info: (msg: string) => void; warn: (msg: string) => void },
  ) {}

  /**
   * Add every artist and album in the library that is not already on the worklist.
   *
   * Idempotent by primary key, so this is safe to call on every scan and at boot. Cheap enough
   * to do unconditionally: four grouped queries over `tracks`/`plays` and one upsert per row.
   *
   * ARTISTS COME FROM TWO PLACES on purpose. `album_artist` is who owns an album page's tiles;
   * `norm_artist` is who a song row credits. Both are reachable as an artist page — a featured
   * guest has a page showing "Appears on" and nothing else — so both are enrolled, and the
   * union is why the count exceeds the album-artist count.
   */
  enrol(): { artists: number; albums: number } {
    const ins = this.db.prepare(
      `INSERT INTO page_warm (kind, key, name, album, weight, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, key) DO UPDATE SET
         -- Keep the worklist's weight current: an artist played a lot since enrolment should
         -- move up the queue, and nothing else about the row changes.
         weight = excluded.weight`,
    );
    const t = nowSec();

    /*
     * Three plain queries merged in JS rather than one clever join. The first attempt UNIONed
     * the two artist sources and joined plays in SQL, which double-counted every track whose
     * credited and album artist agree — most of them — and made the sort order quietly wrong.
     * A Map is easier to be sure about than a GROUP BY over a UNION.
     */
    const names = new Map<string, string>();
    for (const r of this.db
      .prepare(
        `SELECT norm_artist AS artist, MIN(artist_name) AS name FROM tracks
          WHERE norm_artist <> '' GROUP BY norm_artist`,
      )
      .all() as { artist: string; name: string }[]) {
      names.set(r.artist, r.name);
    }
    for (const r of this.db
      .prepare(
        `SELECT album_artist AS artist, MIN(album_artist_name) AS name FROM tracks
          WHERE album_artist <> '' GROUP BY album_artist`,
      )
      .all() as { artist: string; name: string }[]) {
      // Only when the credited pass has not already named them: an album artist string is the
      // same artist, and the first name found is as good as the second.
      if (!names.has(r.artist)) names.set(r.artist, r.name);
    }
    const plays = new Map<string, number>();
    for (const r of this.db
      .prepare(
        `SELECT t.norm_artist AS artist, SUM(p.plays) AS weight
           FROM plays p JOIN tracks t ON t.id = p.track_id
          GROUP BY t.norm_artist`,
      )
      .all() as { artist: string; weight: number }[]) {
      plays.set(r.artist, r.weight ?? 0);
    }
    for (const [artist, name] of names) {
      ins.run('artist', artist, name, '', plays.get(artist) ?? 0, t);
    }
    const artists = { length: names.size };

    const albums = this.db
      .prepare(
        `SELECT album_artist AS artist, norm_album AS ident, MIN(album_title) AS title,
                MIN(album_artist_name) AS name, COUNT(*) AS weight
           FROM tracks
          WHERE album_artist <> '' AND norm_album <> ''
          GROUP BY album_artist, norm_album`,
      )
      .all() as { artist: string; ident: string; title: string; name: string; weight: number }[];
    for (const al of albums) {
      ins.run('album', `${al.artist}|${al.ident}`, al.name || al.artist, al.title, al.weight, t);
    }
    return { artists: artists.length, albums: albums.length };
  }

  /** How much is ready, for the admin screen. */
  progress(): WarmProgress {
    const counts = (kind: WarmKind) => {
      const r = this.db
        .prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN state = 'warm' THEN 1 ELSE 0 END) AS warm,
                  SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
                  SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed
             FROM page_warm WHERE kind = ?`,
        )
        .get(kind) as { total: number; warm: number; pending: number; failed: number };
      return {
        total: r.total ?? 0,
        warm: r.warm ?? 0,
        pending: r.pending ?? 0,
        failed: r.failed ?? 0,
      };
    };
    return {
      artists: counts('artist'),
      albums: counts('album'),
      current: this.working,
      enabled: this.enabled(),
      mirror: this.mb.mirrorStatus(),
    };
  }

  /**
   * The next thing to warm: most-played first, fewest attempts first, artists before albums.
   *
   * Artists first because an artist page is the slow one (three lookups against an album's
   * one) and the one Matt noticed. A row warmed longer ago than REFRESH_S comes back around,
   * because the underlying MusicBrainz caches expire at thirty days and a page whose cache
   * lapsed is slow again — re-warming just before that keeps the promise true.
   */
  private next(): Row | null {
    /*
     * `failed` is included deliberately, and MAX_ATTEMPTS is what makes that safe.
     *
     * The first version selected only 'pending' and stale 'warm', which quietly made the
     * attempts cap dead code: one failure moved a row to 'failed' and nothing ever looked at it
     * again, so a five-minute MusicBrainz outage would have marked the entire library failed at
     * one attempt each and left it that way until somebody found the sweep button. Failures here
     * are overwhelmingly transient — a network blip, a 503 — so they belong back in the queue,
     * just not forever.
     *
     * `attempts` ascending before `weight` so a fresh row is always tried before a second
     * attempt at an old one; otherwise a popular artist MusicBrainz cannot answer for would
     * spend all three of its attempts ahead of everything else.
     */
    return (this.db
      .prepare(
        `SELECT kind, key, name, album, attempts FROM page_warm
          WHERE (state IN ('pending', 'failed') OR (state = 'warm' AND warmed_at < ?))
            AND attempts < ?
          ORDER BY CASE kind WHEN 'artist' THEN 0 ELSE 1 END, attempts, weight DESC
          LIMIT 1`,
      )
      .get(nowSec() - REFRESH_S, MAX_ATTEMPTS) ?? null) as Row | null;
  }

  private mark(row: Row, state: 'warm' | 'failed', detail: string): void {
    this.db
      .prepare(
        `UPDATE page_warm
            SET state = ?, detail = ?, attempts = attempts + ?, warmed_at = ?, updated_at = ?
          WHERE kind = ? AND key = ?`,
      )
      .run(
        state,
        detail.slice(0, 200),
        state === 'warm' ? 0 : 1,
        state === 'warm' ? nowSec() : 0,
        nowSec(),
        row.kind,
        row.key,
      );
  }

  /**
   * Warm one page. Returns what happened, so the caller's log stays a single line.
   *
   * Errors are recorded rather than thrown: an artist MusicBrainz has never heard of is a fact
   * about that artist, not a fault in the worker, and after MAX_ATTEMPTS it stops being asked.
   */
  async tick(): Promise<WarmTick> {
    if (!this.enabled()) return 'disabled';
    if (this.working) return 'busy';
    const row = this.next();
    if (!row) return 'idle';
    this.working = row.kind === 'album' ? `${row.name} — ${row.album}` : row.name;
    try {
      const detail =
        row.kind === 'artist' ? await this.warmArtist(row.name) : await this.warmAlbum(row);
      this.mark(row, 'warm', detail);
      return 'warmed';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.mark(row, 'failed', msg);
      this.log.warn(`page warm failed for ${this.working}: ${msg}`);
      return 'failed';
    } finally {
      this.working = '';
    }
  }

  /**
   * Everything GET /api/artist/:mbid awaits, in the same order — see the note in the header
   * about keeping these in step. The resolve step is included because the client cannot reach
   * the page without it: /api/artist/resolve searches by name to find the mbid.
   */
  private async warmArtist(name: string): Promise<string> {
    if (!name) return 'no name';
    const hits = await this.mb.searchArtists(name, 3, 'idle');
    const exact = hits.find((h) => h.name.toLowerCase() === name.toLowerCase()) ?? hits[0];
    if (!exact) return 'MusicBrainz has no such artist';
    // Sequential, not Promise.all: the gate serialises them anyway, and letting them queue
    // together would hold two idle slots while a foreground request waits for one.
    await this.mb.artistInfo(exact.mbid, 'idle');
    await this.mb.studioAlbums(exact.mbid, 'idle');
    if (this.lastfm.enabled) {
      // A missing biography is normal and must not fail the page's warm.
      await this.lastfm.artistBio(name).catch(() => '');
      // The album page's sidebar, keyed per ARTIST — warmed here so it is shared by every one
      // of their albums rather than fetched once per album row.
      await this.lastfm.similarArtists(name, 12).catch(() => []);
    }
    return exact.mbid;
  }

  /** What GET /api/album awaits that the artist pass has not already covered. */
  private async warmAlbum(row: Row): Promise<string> {
    if (!row.album) return 'no title';
    const year = await this.mb.albumYear(row.name, row.album, 'idle');
    return year === null ? 'no release year' : String(year);
  }

  /**
   * Put everything back in the queue — the retroactive sweep.
   *
   * Clears `failed` too: a failure is usually MusicBrainz being unreachable rather than an
   * artist not existing, and an explicit "warm everything" is a request to try those again.
   */
  sweepAll(): number {
    this.enrol();
    const r = this.db
      .prepare(
        `UPDATE page_warm SET state = 'pending', attempts = 0, detail = '', warmed_at = 0,
                              updated_at = ?`,
      )
      .run(nowSec());
    return r.changes;
  }

  /** Queue just what has never been warmed — the cheap "fill the gaps" pass. */
  sweepCold(): number {
    this.enrol();
    const r = this.db
      .prepare(
        `UPDATE page_warm SET state = 'pending', attempts = 0, detail = '', updated_at = ?
          WHERE state <> 'warm'`,
      )
      .run(nowSec());
    return r.changes;
  }
}
