import type Database from 'better-sqlite3';
import { nowSec } from '../db/schema.js';
import { DUMMY_HASH, hash, randomToken, verify } from './crypto.js';

export type Kind = 'artist' | 'album' | 'track';
export type Status = 'queued' | 'fulfilled' | 'failed';
export type SeedSource = 'library' | 'request' | 'listen';

import type { Scored } from './release.js';
import type { PoolTrack } from './userlib.js';

export interface RequestRow {
  id: number;
  kind: Kind;
  mbid: string;
  title: string;
  artist_name: string;
  asked_for: string;
  requested_by: string;
  requested_at: number;
  album_count: number;
  status: Status;
  lidarr_id: number | null;
  error: string | null;
  /** 'user' when a person asked, 'import' when a library import did. */
  source?: string;
  /** Which download client holds nzo_id: 'usenet' or 'torrent'. */
  download_via?: string;
  // The native pipeline's state. Optional because rows created before it existed
  // do not have them, and because the Lidarr fallback path never sets them.
  nzo_id?: string | null;
  progress?: number;
  note?: string | null;
  progress_at?: number;
  /** For a track request: what the person asked for, inside the album that arrived. */
  wanted_title?: string;
  /** Numeric requester, since requested_by holds a username which is not a stable key. */
  requester_id?: number | null;
  /** Playlist the requested track should join once it lands. */
  wanted_playlist?: number | null;
  attempt?: number;
  candidates?: string | null;
  album_title?: string;
}

export interface User {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  is_admin: number;
  /** Separate credential for Subsonic token auth. See the schema comment. */
  stream_password: string;
  /** Which page '/' opens: 'discover', 'mylibrary' or 'playlists'. */
  home_page: string;
  enabled: number;
  created_at: number;
  last_login_at: number | null;
}

/** Failed logins tolerated per (ip, username) inside the window. */
const MAX_FAILS = 6;
const FAIL_WINDOW_S = 900; // 15 minutes
/** How long a session lasts without being renewed. */
const SESSION_TTL_S = 30 * 86400;

export interface Seed {
  name: string;
  source: SeedSource;
  weight: number;
  updated_at: number;
}

/**
 * How much each signal counts when ranking discovery suggestions.
 *
 * A play is the strongest signal because it is the only one that proves the
 * music was actually wanted after it arrived. Merely holding a file says
 * somebody asked for it once; a request here says so too, but more recently.
 */
const SEED_WEIGHT: Record<SeedSource, number> = {
  listen: 3,
  request: 1.5,
  library: 1,
};

export class Store {
  constructor(private db: Database.Database) {}

// ---- users -------------------------------------------------------------

  userByName(username: string): User | undefined {
    return this.db
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(username.trim().toLowerCase()) as User | undefined;
  }

  userById(id: number): User | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
  }

  users(): User[] {
    return this.db.prepare('SELECT * FROM users ORDER BY username').all() as User[];
  }

  /** How many requests carry this username — shown before a purge deletes them. */
  requestCountBy(username: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM requests WHERE requested_by = ?')
      .get(username) as { n: number };
    return r.n;
  }

  /** Import volume for one user: how many batches, how many rows. */
  importSummary(userId: number): { batches: number; items: number } {
    return this.db
      .prepare(
        'SELECT COUNT(DISTINCT batch_id) AS batches, COUNT(*) AS items FROM import_items WHERE user_id = ?',
      )
      .get(userId) as { batches: number; items: number };
  }

  userCount(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    return r.n;
  }

  /**
   * Playlists across all users, for the admin dashboard.
   *
   * Returns a plain number rather than `number | null`: crate owns its playlists,
   * so "cannot tell" stopped being one of the possible answers. This used to ask
   * Navidrome over the Subsonic API and reported null whenever it was unreachable
   * or unconfigured — which, since it was never configured here, meant the
   * dashboard permanently showed "no Navidrome" instead of a count crate had all
   * along.
   */
  playlistCount(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM playlists').get() as { n: number };
    return r.n;
  }

  async addUser(u: {
    username: string;
    password: string;
    displayName?: string;
    isAdmin?: boolean;
  }): Promise<number> {
    const info = this.db
      .prepare(
        `INSERT INTO users (username,display_name,password_hash,is_admin,enabled,created_at)
         VALUES (?,?,?,?,1,?)`,
      )
      .run(
        u.username.trim().toLowerCase(),
        (u.displayName ?? u.username).trim(),
        await hash(u.password),
        u.isAdmin ? 1 : 0,
        nowSec(),
      );
    return Number(info.lastInsertRowid);
  }

  async setPassword(id: number, password: string): Promise<void> {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hash(password), id);
    // Every existing session for this user dies with the old password. A password
    // change that left sessions alive would not actually lock anyone out.
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }

  setUserEnabled(id: number, enabled: boolean): void {
    this.db.prepare('UPDATE users SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    if (!enabled) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }

  /**
   * Check a password, in constant-ish time whether or not the user exists.
   *
   * A missing account is verified against a dummy hash so the response time
   * cannot be used to enumerate who has an account here.
   */
  async checkPassword(username: string, password: string): Promise<User | null> {
    const u = this.userByName(username);
    const ok = await verify(u?.password_hash ?? DUMMY_HASH, password);
    if (!u || !ok || !u.enabled) return null;
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowSec(), u.id);
    return u;
  }

  /**
   * Set or clear the separate streaming password.
   *
   * Stored as given, which is the only way Subsonic token auth can work — see the schema
   * comment. Deliberately not the account password, so the recoverable credential grants
   * access to that person's music and nothing else.
   */
  setStreamPassword(userId: number, password: string): void {
    this.db.prepare('UPDATE users SET stream_password = ? WHERE id = ?').run(password, userId);
  }

  setHomePage(userId: number, page: string): void {
    this.db.prepare('UPDATE users SET home_page = ? WHERE id = ?').run(page, userId);
  }

  // ---- sessions ----------------------------------------------------------

  createSession(userId: number): { token: string; expiresAt: number } {
    const token = randomToken();
    const now = nowSec();
    const expiresAt = now + SESSION_TTL_S;
    this.db
      .prepare('INSERT INTO sessions (token,user_id,created_at,expires_at,seen_at) VALUES (?,?,?,?,?)')
      .run(token, userId, now, expiresAt, now);
    return { token, expiresAt };
  }

  /** The user behind a session token, or undefined if absent, expired or disabled. */
  userForSession(token: string): User | undefined {
    if (!token) return undefined;
    const row = this.db
      .prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?')
      .get(token) as { user_id: number; expires_at: number } | undefined;
    if (!row || row.expires_at <= nowSec()) return undefined;
    const u = this.userById(row.user_id);
    if (!u || !u.enabled) return undefined;
    this.db.prepare('UPDATE sessions SET seen_at = ? WHERE token = ?').run(nowSec(), token);
    return u;
  }

  endSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  // ---- login rate limiting ------------------------------------------------

  recordFail(ip: string, username: string): void {
    this.db
      .prepare('INSERT INTO login_attempts (ip,username,at) VALUES (?,?,?)')
      .run(ip, username.trim().toLowerCase(), nowSec());
  }

  clearFails(ip: string, username: string): void {
    this.db
      .prepare('DELETE FROM login_attempts WHERE ip = ? AND username = ?')
      .run(ip, username.trim().toLowerCase());
  }

  /** Seconds remaining on a lockout, or 0 when not locked out. */
  lockoutRemaining(ip: string, username: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n, MAX(at) AS last FROM login_attempts
         WHERE ip = ? AND username = ? AND at > ?`,
      )
      .get(ip, username.trim().toLowerCase(), nowSec() - FAIL_WINDOW_S) as {
      n: number;
      last: number | null;
    };
    if (row.n < MAX_FAILS || !row.last) return 0;
    return Math.max(0, row.last + FAIL_WINDOW_S - nowSec());
  }

  // ---- cache -------------------------------------------------------------

  /** Cached value if it is younger than `ttlSec`, otherwise undefined. */
  cached<T>(key: string, ttlSec: number): T | undefined {
    const row = this.db
      .prepare('SELECT v, fetched_at FROM cache WHERE k = ?')
      .get(key) as { v: string; fetched_at: number } | undefined;
    if (!row) return undefined;
    if (nowSec() - row.fetched_at > ttlSec) return undefined;
    // Stamp the read. The sweep works on last use rather than age, so a tracklist for
    // music somebody still has does not expire just because it was fetched long ago.
    this.db.prepare('UPDATE cache SET last_used_at = ? WHERE k = ?').run(nowSec(), key);
    try {
      return JSON.parse(row.v) as T;
    } catch {
      // A corrupt row is indistinguishable from a miss, and treating it as one
      // means the next fetch overwrites it.
      return undefined;
    }
  }

  putCache(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO cache (k,v,fetched_at,last_used_at) VALUES (?,?,?,?)
         ON CONFLICT(k) DO UPDATE SET
           v = excluded.v, fetched_at = excluded.fetched_at, last_used_at = excluded.last_used_at`,
      )
      .run(key, JSON.stringify(value), nowSec(), nowSec());
  }

  // ---- requests ----------------------------------------------------------

  addRequest(r: {
    kind: Kind;
    mbid: string;
    title: string;
    artistName: string;
    askedFor: string;
    requestedBy: string;
    albumCount: number;
    lidarrId?: number | null;
    wantedTitle?: string;
    requesterId?: number | null;
    wantedPlaylist?: number | null;
    /** Defaults to 'user'; the importer passes 'import'. */
    source?: 'user' | 'import';
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO requests
           (kind,mbid,title,artist_name,asked_for,requested_by,requested_at,album_count,
            lidarr_id,wanted_title,requester_id,wanted_playlist,source)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.kind,
        r.mbid,
        r.title,
        r.artistName,
        r.askedFor,
        r.requestedBy,
        nowSec(),
        r.albumCount,
        r.lidarrId ?? null,
        r.wantedTitle ?? '',
        r.requesterId ?? null,
        r.wantedPlaylist ?? null,
        r.source ?? 'user',
      );
    return Number(info.lastInsertRowid);
  }

  settleRequest(id: number, status: Status, error?: string): void {
    this.db
      .prepare('UPDATE requests SET status = ?, error = ? WHERE id = ?')
      .run(status, error ?? null, id);
  }

  /**
   * Store the ranked candidate list and the resolved names for a request.
   *
   * Kept so a failed grab can move to the next release without searching again:
   * indexers are rate limited, and a second search could return a different list
   * than the one that was scored, making a retry unrepeatable.
   */
  setCandidates(
    id: number,
    ranked: unknown[],
    names: { artistName: string; albumTitle: string },
  ): void {
    this.db
      .prepare('UPDATE requests SET candidates = ?, artist_name = ?, album_title = ? WHERE id = ?')
      .run(JSON.stringify(ranked), names.artistName, names.albumTitle, id);
  }

  candidates(id: number): Scored[] {
    const row = this.db.prepare('SELECT candidates FROM requests WHERE id = ?').get(id) as
      | { candidates: string | null }
      | undefined;
    if (!row?.candidates) return [];
    try {
      return JSON.parse(row.candidates) as Scored[];
    } catch {
      return [];
    }
  }

  requestNames(id: number): { artistName: string; albumTitle: string } {
    const row = this.db
      .prepare('SELECT artist_name, album_title, title FROM requests WHERE id = ?')
      .get(id) as { artist_name: string; album_title: string; title: string } | undefined;
    return {
      artistName: row?.artist_name ?? '',
      albumTitle: row?.album_title || row?.title || '',
    };
  }

  setDownload(
    id: number,
    d: { nzoId: string; attempt: number; note: string; via?: 'usenet' | 'torrent' },
  ): void {
    this.db
      .prepare(
        'UPDATE requests SET nzo_id = ?, attempt = ?, note = ?, download_via = ?, progress = 0, ' +
          'progress_at = unixepoch() WHERE id = ?',
      )
      .run(d.nzoId, d.attempt, d.note, d.via ?? 'usenet', id);
  }

  /**
   * Record progress, touching progress_at only when something actually moved.
   *
   * The distinction is the point: a poll every fifteen seconds would otherwise keep
   * the timestamp fresh forever and no stall could ever be detected.
   */
  setProgress(id: number, percent: number, note: string | null): void {
    this.db
      .prepare(
        `UPDATE requests
            SET progress_at = CASE
                  WHEN progress <> ? OR COALESCE(note,'') <> COALESCE(?,'') THEN unixepoch()
                  ELSE progress_at END,
                progress = ?,
                note = ?
          WHERE id = ?`,
      )
      .run(Math.round(percent), note, Math.round(percent), note, id);
  }

  /**
   * Requests the pipeline still has work to do on.
   *
   * Only rows with a SABnzbd job: a queued row without one is either waiting for
   * its search to finish or is on the Lidarr fallback path, and in both cases the
   * pipeline poll has nothing to advance.
   */
  downloadingRequests(limit = 50): RequestRow[] {
    return this.db
      .prepare(
        "SELECT * FROM requests WHERE status = 'queued' AND nzo_id IS NOT NULL " +
          'ORDER BY requested_at LIMIT ?',
      )
      .all(limit) as RequestRow[];
  }

  /** Queued rows that have never been given a candidate list, for recovery on boot. */
  unstartedRequests(limit = 50): RequestRow[] {
    return this.db
      .prepare(
        "SELECT * FROM requests WHERE status = 'queued' AND nzo_id IS NULL " +
          "AND kind = 'album' AND candidates IS NULL ORDER BY requested_at LIMIT ?",
      )
      .all(limit) as RequestRow[];
  }

  /** Drop every cache entry under a prefix, for invalidating a computed set. */
  dropCachePrefix(prefix: string): void {
    this.db.prepare("DELETE FROM cache WHERE k LIKE ? || '%'").run(prefix);
  }

  // ---- pool lookups for the recommender ----------------------------------

  /** Everything on disk by one artist, by normalised name. */
  poolByNormArtist(normArtist: string, limit = 40): PoolTrack[] {
    const rows = this.db
      .prepare(
        `SELECT id, path, artist_name, album_title, title, track_no, duration_s, size
           FROM tracks WHERE norm_artist = ? ORDER BY norm_album, track_no LIMIT ?`,
      )
      .all(normArtist, limit) as RawPoolRow[];
    return rows.map(toPoolTrack);
  }

  /** One specific song on disk, or null. */
  poolByNormTitle(normArtist: string, normTitle: string): PoolTrack | null {
    const row = this.db
      .prepare(
        `SELECT id, path, artist_name, album_title, title, track_no, duration_s, size
           FROM tracks WHERE norm_artist = ? AND norm_title = ? LIMIT 1`,
      )
      .get(normArtist, normTitle) as RawPoolRow | undefined;
    return row ? toPoolTrack(row) : null;
  }

  /**
   * How an artist's name is actually spelled, for a normalised key.
   *
   * Last.fm and the tags disagree on case and punctuation, and a recommendation card showing
   * "rage against the machine" looks like a bug even though the match is right.
   */
  artistDisplayName(normArtist: string): string | null {
    const row = this.db
      .prepare('SELECT artist_name FROM tracks WHERE norm_artist = ? LIMIT 1')
      .get(normArtist) as { artist_name: string } | undefined;
    return row?.artist_name ?? null;
  }

  /** Requests still waiting on a download, oldest first. */
  queuedRequests(limit = 200): RequestRow[] {
    return this.db
      .prepare("SELECT * FROM requests WHERE status = 'queued' ORDER BY requested_at LIMIT ?")
      .all(limit) as RequestRow[];
  }

  /** Request totals by status, for the admin statistics page. */
  requestCounts(): { total: number; queued: number; fulfilled: number; failed: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(status = 'queued')    AS queued,
                SUM(status = 'fulfilled') AS fulfilled,
                SUM(status = 'failed')    AS failed
           FROM requests`,
      )
      .get() as { total: number; queued: number; fulfilled: number; failed: number };
    return {
      total: row.total ?? 0,
      queued: row.queued ?? 0,
      fulfilled: row.fulfilled ?? 0,
      failed: row.failed ?? 0,
    };
  }

  /**
   * Requests, newest first, narrowed by who asked and how it went.
   *
   * `trouble` means "did not succeed": failed outright, or queued with an
   * error recorded against it — a download that has actually stopped but still
   * says 'queued'. Filtering in SQL rather than in the client matters because
   * the client only ever holds the most recent hundred rows, and with a couple
   * of thousand from an import the handful that failed are never among them.
   */
  requests(
    opts: {
      limit?: number;
      user?: string;
      source?: 'user' | 'import';
      trouble?: boolean;
    } = {},
  ): RequestRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.user !== undefined) {
      where.push('requested_by = ?');
      args.push(opts.user);
    }
    if (opts.source) {
      where.push('source = ?');
      args.push(opts.source);
    }
    if (opts.trouble) where.push("(status = 'failed' OR (error IS NOT NULL AND error <> ''))");
    args.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));

    return this.db
      .prepare(
        `SELECT * FROM requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY requested_at DESC, id DESC LIMIT ?`,
      )
      .all(...args) as RequestRow[];
  }

  requestById(id: number): RequestRow | null {
    return (this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as RequestRow) ?? null;
  }

  /**
   * Delete requests that failed, so somebody can tidy their own history.
   *
   * FAILED ONLY, deliberately narrower than the page's "trouble" filter. That filter also
   * shows QUEUED rows carrying an error, and those are still in flight and still count
   * toward the daily album cap — clearing one would drop a live job out of sight.
   *
   * Safe for the cap either way: albumsQueuedSince already excludes failed rows, because
   * nothing was downloaded so nothing was spent. The schema's "never deleted on failure"
   * note means crate does not discard them by itself, which is still true — this only ever
   * runs when someone asks it to.
   */
  clearFailedRequests(user?: string): number {
    return user === undefined
      ? this.db.prepare("DELETE FROM requests WHERE status = 'failed'").run().changes
      : this.db.prepare("DELETE FROM requests WHERE status = 'failed' AND requested_by = ?").run(user)
          .changes;
  }

  /**
   * Put a request back to the start: queued, no error, no SAB job, attempt 0.
   *
   * Candidates are cleared too, so a retry searches again rather than working
   * down a stale list — the whole point of retrying after a metadata fix is
   * that the search itself was looking for the wrong thing.
   */
  /** Point a request at a different album, after re-resolving its metadata. */
  repointRequest(id: number, mbid: string, title: string): void {
    this.db.prepare('UPDATE requests SET mbid = ?, title = ? WHERE id = ?').run(mbid, title, id);
  }

  resetRequest(id: number): void {
    this.db
      .prepare(
        `UPDATE requests SET status = 'queued', error = NULL, note = NULL, nzo_id = NULL,
              attempt = 0, progress = 0, candidates = NULL WHERE id = ?`,
      )
      .run(id);
  }

  /** True if this mbid has already been asked for and did not fail. */
  alreadyRequested(mbid: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM requests WHERE mbid = ? AND status <> 'failed' LIMIT 1")
      .get(mbid);
    return row !== undefined;
  }

  /**
   * Albums this user has queued in the last 24 hours.
   *
   * Counts albums rather than requests: one artist request can queue a whole
   * discography, and a cap that counted clicks would not bound anything.
   * Failed requests are excluded — nothing was downloaded, so nothing was spent.
   */
  albumsQueuedSince(user: string, sinceSec: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(album_count), 0) AS n FROM requests
         WHERE requested_by = ? AND requested_at >= ? AND status <> 'failed'`,
      )
      .get(user, sinceSec) as { n: number };
    return row.n;
  }

  // ---- seeds -------------------------------------------------------------

  /**
   * Record interest in an artist, keeping the strongest signal seen.
   *
   * A play must not be downgraded to a library hit on the next library refresh,
   * which is why the weight only ever moves up.
   */
  noteSeed(name: string, source: SeedSource): void {
    const clean = name.trim();
    if (!clean) return;
    this.db
      .prepare(
        `INSERT INTO seeds (name, source, weight, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET
           source     = CASE WHEN excluded.weight > seeds.weight THEN excluded.source ELSE seeds.source END,
           weight     = MAX(seeds.weight, excluded.weight),
           updated_at = excluded.updated_at`,
      )
      .run(clean, source, SEED_WEIGHT[source], nowSec());
  }

  seeds(limit = 40): Seed[] {
    return this.db
      .prepare('SELECT * FROM seeds ORDER BY weight DESC, updated_at DESC LIMIT ?')
      .all(limit) as Seed[];
  }

  seedCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM seeds').get() as { n: number };
    return row.n;
  }

  // ---- dismissals --------------------------------------------------------

  dismiss(name: string, byUser: string): void {
    this.db
      .prepare(
        `INSERT INTO dismissed (name, by_user, at) VALUES (?,?,?)
         ON CONFLICT(name) DO UPDATE SET at = excluded.at`,
      )
      .run(name.trim(), byUser, nowSec());
  }

  dismissedNames(): Set<string> {
    const rows = this.db.prepare('SELECT name FROM dismissed').all() as { name: string }[];
    return new Set(rows.map((r) => r.name.toLowerCase()));
  }
}

interface RawPoolRow {
  id: number;
  path: string;
  artist_name: string;
  album_title: string;
  title: string;
  track_no: number | null;
  duration_s: number | null;
  size: number;
  year?: number | null;
  album_artist_name?: string;
}

function toPoolTrack(r: RawPoolRow): PoolTrack {
  return {
    trackId: r.id,
    path: r.path,
    artistName: r.artist_name,
    albumTitle: r.album_title,
    title: r.title,
    trackNo: r.track_no,
    durationS: r.duration_s,
    sizeBytes: r.size,
    // Neither is selected by these queries; the album page reads both through userlib.
    year: r.year ?? null,
    albumArtistName: r.album_artist_name || r.artist_name,
  };
}
