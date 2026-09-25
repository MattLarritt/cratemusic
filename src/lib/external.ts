import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import type { Store } from './store.js';
import type { UserLibrary } from './userlib.js';
import type { Ingester } from './ingest.js';
import type { ExternalHit, ExternalSource, ExternalStream, PluginState } from './plugin.js';
import { norm } from './release.js';

/**
 * Songs from outside the library, and the promise that their ids keep working.
 *
 * An external source (a plugin — YouTube is the first) can find songs crate does not hold,
 * say where their audio is, and fetch one to a file. This module is everything around that
 * which has to behave the same whichever source it is:
 *
 *   ids        x-<source>-<key>, e.g. x-youtube-dQw4w9WgXcQ. Collides with nothing: the
 *              library uses t-, albums al-, artists ar-, playlists pl-.
 *   the map    external_tracks remembers every song a source has offered, and — once it has
 *              been kept — which library track it became. After that, the x- id IS that
 *              track to every caller. Subsonic clients cache ids and will ask for this one
 *              again months from now; the map is what makes the answer "here it is" rather
 *              than "not found".
 *   keeping    a song streams straight from the source, and is only downloaded once someone
 *              has actually listened. See keep policy below.
 *
 * Nothing here knows what YouTube is.
 */

export type ExternalState = 'seen' | 'kept' | 'downloading' | 'imported' | 'failed';

export interface ExternalRow {
  /** The id a client sees: x-<source>-<key>. */
  id: string;
  source: string;
  key: string;
  title: string;
  artist: string;
  album: string | null;
  durationS: number | null;
  coverUrl: string | null;
  state: ExternalState;
  error: string | null;
  /** The library track it became, once kept and imported. */
  trackId: number | null;
}

export type Resolved = { kind: 'track'; trackId: number } | { kind: 'external'; row: ExternalRow };

/** 'off' is a listen that would have kept the song, from somebody who keeps only by asking. */
export type KeepOutcome = 'queued' | 'owned' | 'capped' | 'unknown' | 'off';

const ID_RE = /^x-([a-z0-9]+)-(.+)$/;

export const idFor = (source: string, key: string): string => `x-${source}-${key}`;

export function parseId(id: string): { source: string; key: string } | null {
  const m = ID_RE.exec(id);
  return m ? { source: m[1]!, key: m[2]! } : null;
}

/**
 * How long a search is remembered, per source and normalised query.
 *
 * A week, misses included. Voice clients repeat the same handful of requests, and each real
 * lookup is several seconds of a subprocess talking to somebody else's servers — the second
 * "play Song 2" should not cost what the first did.
 */
const SEARCH_TTL_S = 7 * 24 * 3600;

/** A search taking longer than this is abandoned: a slow fallback must not hang a client's search. */
const SEARCH_TIMEOUT_MS = 20_000;

/** Reuse a resolved stream URL until shortly before it expires, or this long when it does not say. */
const STREAM_DEFAULT_TTL_S = 30 * 60;

/**
 * THE KEEP POLICY — when a streamed song becomes a downloaded one.
 *
 * Always when somebody asks: the web page's ⋯ menu and download button, or starring the song
 * in a Subsonic client, which is the only "keep this" gesture a phone client has.
 *
 * Automatically only for people who turn it on (it is off by default), and then only after the
 * song has been LISTENED to, so a skip, an accidental tap or a misheard voice request never
 * puts the wrong thing in somebody's library. Any one of three signals counts:
 *
 *   1. the web player reports this many seconds of actual playback;
 *   2. a Subsonic client scrobbles it (submission=true — "this was played");
 *   3. a Subsonic stream has been going this long and the same person has not started a
 *      DIFFERENT song since. Best effort, and needed because the server cannot see where
 *      playback is: a client may buffer the whole song in two seconds and never ask again.
 *
 * Starting another song inside the window is the skip that cancels (3).
 */
export const KEEP_AFTER_S = 30;

interface RawRow {
  source: string;
  key: string;
  title: string;
  artist: string;
  album: string | null;
  duration_s: number | null;
  cover_url: string | null;
  state: ExternalState;
  error: string | null;
  track_id: number | null;
}

const toRow = (r: RawRow): ExternalRow => ({
  id: idFor(r.source, r.key),
  source: r.source,
  key: r.key,
  title: r.title,
  artist: r.artist,
  album: r.album,
  durationS: r.duration_s,
  coverUrl: r.cover_url,
  state: r.state,
  error: r.error,
  trackId: r.track_id,
});

type Timer = { cancel(): void };

export class ExternalCatalog {
  private sources = new Map<string, { pluginId: string; source: ExternalSource }>();
  private streams = new Map<string, { stream: ExternalStream; until: number }>();
  /** Per person, the one external stream the heuristic is currently timing. */
  private pending = new Map<number, { id: string; timer: Timer }>();
  /** Acquisitions run one at a time: each is a download plus a fingerprint, and order is fair. */
  private queue: Promise<void> = Promise.resolve();
  private keepAfterMs: number;
  private schedule: (fn: () => void, ms: number) => Timer;
  private now: () => number;

  constructor(
    private db: Database.Database,
    private store: Store,
    private userlib: UserLibrary,
    private ingester: Pick<Ingester, 'ingest'>,
    private pluginState: Pick<PluginState, 'isEnabled'>,
    private log: FastifyBaseLogger,
    private opts: {
      /** Why this person may not keep another song today, or null when they may. */
      capCheck?: (userId: number) => string | null;
      /**
       * Whether listening keeps a song for this person, or only asking does. Covers the two
       * automatic signals — thirty seconds, a scrobble — and never `keep()` itself.
       */
      autoKeep?: (userId: number) => boolean;
      keepAfterMs?: number;
      schedule?: (fn: () => void, ms: number) => Timer;
      now?: () => number;
    } = {},
  ) {
    this.keepAfterMs = opts.keepAfterMs ?? KEEP_AFTER_S * 1000;
    this.now = opts.now ?? (() => Date.now());
    this.schedule =
      opts.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref();
        return { cancel: () => clearTimeout(t) };
      });
    db.exec(`
      CREATE TABLE IF NOT EXISTS external_tracks (
        source     TEXT NOT NULL,
        key        TEXT NOT NULL,
        title      TEXT NOT NULL,
        artist     TEXT NOT NULL,
        album      TEXT,
        duration_s INTEGER,
        cover_url  TEXT,
        state      TEXT NOT NULL DEFAULT 'seen',
        error      TEXT,
        -- The library track this became. ON DELETE SET NULL so deleting the song from the
        -- library frees the id to be fetched again rather than pointing at nothing.
        track_id   INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source, key)
      );
      CREATE INDEX IF NOT EXISTS external_tracks_track ON external_tracks (track_id);

      -- Everyone who has kept a song, so a second person keeping it while the first
      -- download is still running also gets it, and so keeps can count against daily caps.
      CREATE TABLE IF NOT EXISTS external_wants (
        source    TEXT NOT NULL,
        key       TEXT NOT NULL,
        user_id   INTEGER NOT NULL,
        wanted_at INTEGER NOT NULL,
        PRIMARY KEY (source, key, user_id)
      );
      CREATE INDEX IF NOT EXISTS external_wants_user ON external_wants (user_id, wanted_at);
    `);
  }

  // ---- sources ---------------------------------------------------------------

  register(pluginId: string, source: ExternalSource): void {
    if (!/^[a-z0-9]+$/.test(source.id)) {
      this.log.warn({ plugin: pluginId, source: source.id }, 'external source id must be [a-z0-9]+ — ignored');
      return;
    }
    if (this.sources.has(source.id)) {
      this.log.warn({ plugin: pluginId, source: source.id }, 'external source id already registered — ignored');
      return;
    }
    this.sources.set(source.id, { pluginId, source });
  }

  /** Sources whose plugin is switched on. A disabled plugin offers nothing new. */
  private active(): { pluginId: string; source: ExternalSource }[] {
    return [...this.sources.values()].filter((s) => this.pluginState.isEnabled(s.pluginId));
  }

  private sourceFor(id: string): ExternalSource | null {
    const s = this.sources.get(id);
    return s && this.pluginState.isEnabled(s.pluginId) ? s.source : null;
  }

  enabled(): boolean {
    return this.active().length > 0;
  }

  labels(): Record<string, string> {
    return Object.fromEntries(this.active().map((s) => [s.source.id, s.source.label]));
  }

  // ---- rows --------------------------------------------------------------------

  get(source: string, key: string): ExternalRow | null {
    const r = this.db.prepare('SELECT * FROM external_tracks WHERE source = ? AND key = ?').get(source, key) as
      | RawRow
      | undefined;
    return r ? toRow(r) : null;
  }

  private upsert(source: string, h: ExternalHit): void {
    const t = Math.floor(this.now() / 1000);
    // Metadata refreshes from the source, but a row's STATE and TRACK are ours and a fresh
    // search must never reset a song that is downloading or already kept.
    this.db
      .prepare(
        `INSERT INTO external_tracks (source, key, title, artist, album, duration_s, cover_url, state, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,'seen',?,?)
         ON CONFLICT(source, key) DO UPDATE SET
           title = excluded.title, artist = excluded.artist, album = excluded.album,
           duration_s = excluded.duration_s, cover_url = excluded.cover_url, updated_at = excluded.updated_at`,
      )
      .run(source, h.key, h.title, h.artist, h.album ?? null, h.durationS ?? null, h.coverUrl ?? null, t, t);
  }

  /** Change a row's state, and optionally its error and track, in one statement. */
  private setState(
    row: { source: string; key: string },
    state: ExternalState,
    patch: { error?: string | null; trackId?: number } = {},
  ): void {
    const sets = ['state = ?', 'updated_at = ?'];
    const args: (string | number | null)[] = [state, Math.floor(this.now() / 1000)];
    if ('error' in patch) {
      sets.push('error = ?');
      args.push(patch.error ?? null);
    }
    if (patch.trackId !== undefined) {
      sets.push('track_id = ?');
      args.push(patch.trackId);
    }
    this.db
      .prepare(`UPDATE external_tracks SET ${sets.join(', ')} WHERE source = ? AND key = ?`)
      .run(...args, row.source, row.key);
  }

  // ---- search --------------------------------------------------------------------

  /**
   * Ask every active source, in parallel, and remember what they said.
   *
   * A source that throws or times out contributes nothing and is logged — it never fails the
   * search, because this is always a FALLBACK behind the library and a broken fallback must
   * look like "nothing extra", not like a broken search box.
   */
  async search(q: string, limit = 5): Promise<ExternalRow[]> {
    const term = q.trim();
    // Nothing a person could be searching for — no letter or digit in it — is never sent out.
    // Defence in depth behind the callers' own checks: this is the one door every source shares.
    if (!norm(term)) return [];
    const per = await Promise.all(
      this.active().map(async ({ source }) => {
        const ck = `ext:${source.id}:${norm(term)}:${limit}`;
        let keys = this.store.cached<string[]>(ck, SEARCH_TTL_S);
        if (!keys) {
          try {
            const hits = await withTimeout(source.search(term, limit), SEARCH_TIMEOUT_MS);
            for (const h of hits) this.upsert(source.id, h);
            keys = hits.map((h) => h.key);
            this.store.putCache(ck, keys);
          } catch (err) {
            this.log.warn({ source: source.id, err: (err as Error).message }, 'external search failed');
            return [];
          }
        }
        return keys.map((k) => this.get(source.id, k)).filter((r): r is ExternalRow => r !== null);
      }),
    );
    return per.flat();
  }

  /**
   * What an x- id is now: a library track (once kept), an external song, or nothing.
   *
   * A song we have never seen — the database was restored, or a client kept an id from a
   * different server — is described by its source rather than refused, so a cached id can
   * still play.
   */
  async resolve(id: string): Promise<Resolved | null> {
    const p = parseId(id);
    if (!p) return null;
    let row = this.get(p.source, p.key);
    if (row?.trackId && this.userlib.byId(row.trackId)) return { kind: 'track', trackId: row.trackId };
    // Past here it would come from the source, so a disabled source means it is not there —
    // even for a song it offered before, whose row is still in the table.
    const src = this.sourceFor(p.source);
    if (!src) return null;
    if (!row) {
      const hit = await withTimeout(src.describe(p.key), SEARCH_TIMEOUT_MS).catch(() => null);
      if (!hit) return null;
      this.upsert(p.source, hit);
      row = this.get(p.source, p.key);
      if (!row) return null;
    }
    return { kind: 'external', row };
  }

  /**
   * The library track an x- id became, if it has been kept and the track still exists.
   *
   * Synchronous and database-only, so the Subsonic access check can use it: once a song is
   * kept, its x- id should behave exactly like its t- id for the person who owns it, through
   * every endpoint, with no special cases downstream.
   */
  trackIdFor(id: string): number | null {
    const p = parseId(id);
    if (!p) return null;
    const row = this.get(p.source, p.key);
    return row?.trackId && this.userlib.byId(row.trackId) ? row.trackId : null;
  }

  /** Where the audio is right now, reusing a resolved URL until just before it expires. */
  async streamFor(row: ExternalRow): Promise<ExternalStream> {
    const src = this.sourceFor(row.source);
    if (!src) throw new Error(`the ${row.source} source is not enabled`);
    const nowS = Math.floor(this.now() / 1000);
    const hit = this.streams.get(row.id);
    if (hit && hit.until > nowS) return hit.stream;
    const stream = await src.resolveStream(row.key);
    const until = stream.expiresAt ? stream.expiresAt - 120 : nowS + STREAM_DEFAULT_TTL_S;
    this.streams.set(row.id, { stream, until });
    return stream;
  }

  /** Drop a cached URL — after the far end refused it, say, so the next attempt resolves afresh. */
  forgetStream(id: string): void {
    this.streams.delete(id);
  }

  // ---- the keep policy --------------------------------------------------------------

  /**
   * A Subsonic stream has started — of anything. Signal 3 of the keep policy.
   *
   * Clients make several requests per playback — a probe, then Range requests while seeking —
   * so the SAME id arriving again must not restart the clock. A different id is a skip: it
   * cancels the one being timed, and starts timing the new one if that is external too.
   * Library songs count as skips, which is the common case: a voice request plays the wrong
   * thing from YouTube, and the next song is one you own.
   */
  streamStarted(userId: number, id: string): void {
    const prev = this.pending.get(userId);
    if (prev?.id === id) return;
    prev?.timer.cancel();
    this.pending.delete(userId);
    if (!parseId(id) || !this.autoKeeps(userId)) return;
    const timer = this.schedule(() => {
      this.pending.delete(userId);
      void this.keep(userId, id);
    }, this.keepAfterMs);
    this.pending.set(userId, { id, timer });
  }

  /** Signals 1 and 2: the web player's listened report, or a Subsonic scrobble. Keeps now. */
  async listened(userId: number, id: string): Promise<KeepOutcome> {
    const prev = this.pending.get(userId);
    if (prev?.id === id) {
      prev.timer.cancel();
      this.pending.delete(userId);
    }
    if (!this.autoKeeps(userId)) return 'off';
    return this.keep(userId, id);
  }

  private autoKeeps(userId: number): boolean {
    return this.opts.autoKeep?.(userId) ?? true;
  }

  /** Keeps counted against the daily cap: every song this person asked to keep since then. */
  keptSince(userId: number, sinceS: number): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM external_wants WHERE user_id = ? AND wanted_at >= ?')
      .get(userId, sinceS) as { n: number };
    return r.n;
  }

  /**
   * Keep a song for this person: the ⋯ menu, the player's download button, a Subsonic star, or
   * one of the automatic signals above for somebody who has them on.
   */
  async keep(userId: number, id: string): Promise<KeepOutcome> {
    const p = parseId(id);
    const row = p ? this.get(p.source, p.key) : null;
    if (!row) return 'unknown';

    // Already a library track: this person simply gets it, no download and no cap.
    if (row.trackId && this.userlib.byId(row.trackId)) {
      if (!this.userlib.has(userId, row.trackId)) this.userlib.add(userId, row.trackId, 'external');
      return 'owned';
    }

    const already = this.db
      .prepare('SELECT 1 FROM external_wants WHERE source = ? AND key = ? AND user_id = ?')
      .get(row.source, row.key, userId);
    if (!already) {
      const why = this.opts.capCheck?.(userId) ?? null;
      if (why) {
        this.log.info({ user: userId, id, why }, 'external song not kept: over the daily cap');
        return 'capped';
      }
      this.db
        .prepare('INSERT OR IGNORE INTO external_wants (source, key, user_id, wanted_at) VALUES (?,?,?,?)')
        .run(row.source, row.key, userId, Math.floor(this.now() / 1000));
    }

    if (row.state === 'kept' || row.state === 'downloading') return 'queued';
    this.setState(row, 'kept', { error: null });
    this.queue = this.queue.then(() => this.acquire(row, userId)).catch(() => undefined);
    return 'queued';
  }

  /** Wait for everything queued so far. For tests and graceful shutdown. */
  idle(): Promise<void> {
    return this.queue;
  }

  /**
   * Fetch, import, and grant to everyone who asked. Retried once, because the most common
   * failure — the source's URL went stale between resolving and downloading — is transient.
   */
  private async acquire(row: ExternalRow, firstUser: number): Promise<void> {
    const src = this.sourceFor(row.source);
    if (!src) {
      this.setState(row, 'failed', { error: `the ${row.source} source is not enabled` });
      return;
    }
    this.setState(row, 'downloading');
    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const got = await src.acquire(row.key, {
          key: row.key,
          title: row.title,
          artist: row.artist,
          ...(row.album ? { album: row.album } : {}),
          ...(row.durationS ? { durationS: row.durationS } : {}),
          ...(row.coverUrl ? { coverUrl: row.coverUrl } : {}),
        });
        const result = await this.ingester.ingest(
          {
            file: got.file,
            artist: got.artist,
            title: got.title,
            ...(got.album ? { album: got.album } : {}),
            ...(got.trackNo ? { trackNo: got.trackNo } : {}),
          },
          firstUser,
        );
        this.setState(row, 'imported', { trackId: result.trackId, error: null });
        const wanting = this.db
          .prepare('SELECT user_id FROM external_wants WHERE source = ? AND key = ?')
          .all(row.source, row.key) as { user_id: number }[];
        for (const w of wanting) {
          if (!this.userlib.has(w.user_id, result.trackId)) this.userlib.add(w.user_id, result.trackId, 'external');
        }
        this.log.warn(
          { id: row.id, trackId: result.trackId, adopted: result.adopted, song: `${result.artist} — ${result.title}` },
          'external song kept',
        );
        return;
      } catch (err) {
        lastError = (err as Error).message;
        this.forgetStream(row.id);
        this.log.warn({ id: row.id, attempt, err: lastError }, 'external acquire failed');
      }
    }
    this.setState(row, 'failed', { error: lastError.slice(0, 300) });
  }

  /** Everything that has been kept or tried, newest first, for the admin page. */
  recent(limit = 50): ExternalRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM external_tracks WHERE state <> 'seen' ORDER BY updated_at DESC LIMIT ?`)
        .all(limit) as RawRow[]
    ).map(toRow);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    t.unref();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
