/**
 * Library imports: an Apple Music (or similar) export becomes this library.
 *
 * The export is a list of songs — track, artist, album, playlist — and the
 * import honours exactly that list. Songs the pool already holds join the
 * person's library instantly. Everything else is grouped by album and each
 * missing album is downloaded ONCE through the ordinary pipeline; when the
 * files land, only the songs named in the export are added, because "I had
 * these eleven songs" is not "I want this artist's whole record".
 *
 * The processor is a poll, not a callback. Every tick it: settles pooled
 * songs, creates the next few album requests (a handful per tick so a
 * thousand-song import queues downloads at a humane pace), reflects failed
 * requests onto their songs, and re-checks in-flight albums against the pool.
 * A restart loses nothing — every decision reads current state.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import { canonAlbum } from './library.js';
import type { MusicBrainz } from './musicbrainz.js';
import type { Pipeline } from './pipeline.js';
import type { Recommender } from './recommend.js';
import { norm } from './release.js';
import type { Store } from './store.js';
import type { UserLibrary } from './userlib.js';

export interface ImportRow {
  title: string;
  artist: string;
  album: string;
  playlist: string;
  isrc: string;
}

export interface ImportItem {
  id: number;
  title: string;
  artist: string;
  album: string;
  playlist: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  detail: string;
}

/** Albums to start downloading per tick — enough to keep SAB busy, not enough to flood. */
const ALBUMS_PER_TICK = 3;

/**
 * The lead artist of a multi-artist credit.
 *
 * Exports write "Post Malone & Swae Lee"; MusicBrainz credits the release
 * group to Post Malone and mentions Swae Lee elsewhere. Matching on the whole
 * string failed every collaboration in a real import, which is a lot of any
 * modern library.
 */
function primaryArtist(a: string): string {
  const first = a.split(/\s*(?:,|&|\bfeat\.?\b|\bfeaturing\b|\bwith\b|\bx\b|\bvs\.?\b)\s*/i)[0];
  return (first ?? a).trim() || a;
}

/** A title with every parenthetical stripped: "(Radio Edit)", "(feat. …)". */
function bareTitle(t: string): string {
  return t.replace(/\s*[([][^)\]]*[)\]]/g, ' ').replace(/\s+/g, ' ').trim() || t;
}

export class MusicImport {
  constructor(
    private db: Database.Database,
    private store: Store,
    private userlib: UserLibrary,
    private mb: MusicBrainz,
    private pipeline: Pipeline,
    private recommender: Recommender,
    private log: FastifyBaseLogger,
  ) {}

  /**
   * Take a parsed export in. Creates the playlists up front — they are cheap,
   * and a person watching the progress page should see the structure appear
   * immediately even while the songs are still arriving.
   */
  addBatch(
    userId: number,
    username: string,
    rows: ImportRow[],
  ): { batchId: string; items: number; playlists: number } {
    const batchId = randomUUID().slice(0, 8);

    // Unique playlist names, existing ones reused case-insensitively so a
    // re-import does not mint "Gym 2" next to "gym".
    const have = new Map(this.userlib.playlists(userId).map((p) => [p.name.toLowerCase(), p.id]));
    const wanted = new Set(
      rows.map((r) => r.playlist.trim()).filter((name) => name !== ''),
    );
    let created = 0;
    for (const name of wanted) {
      if (!have.has(name.toLowerCase())) {
        have.set(name.toLowerCase(), this.userlib.createPlaylist(userId, name.slice(0, 100)));
        created++;
      }
    }

    const insert = this.db.prepare(
      `INSERT INTO import_items (user_id, batch_id, artist, title, album, playlist, isrc, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,unixepoch(),unixepoch())`,
    );
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        if (!r.title.trim() || !r.artist.trim()) continue;
        insert.run(
          userId,
          batchId,
          r.artist.trim(),
          r.title.trim(),
          r.album.trim(),
          r.playlist.trim(),
          r.isrc.trim(),
        );
      }
    });
    tx();

    this.log.info(
      { userId, username, batchId, rows: rows.length, playlistsCreated: created },
      'library import queued',
    );
    // First pass immediately, so the pooled part of the import lands before
    // the person has finished reading the summary.
    void this.tick().catch(() => undefined);
    return { batchId, items: rows.length, playlists: created };
  }

  /**
   * Import runs, newest first — one row per batch with its outcome so far.
   * With a userId it is that person's history; without, everyone's, for the
   * admin portal.
   */
  history(userId?: number): {
    batchId: string;
    userId: number;
    username: string;
    startedAt: number;
    updatedAt: number;
    total: number;
    done: number;
    failed: number;
    open: number;
  }[] {
    const where = userId === undefined ? '' : 'WHERE i.user_id = ?';
    const args = userId === undefined ? [] : [userId];
    return this.db
      .prepare(
        `SELECT i.batch_id AS batchId, i.user_id AS userId,
                COALESCE(u.username, 'deleted') AS username,
                MIN(i.created_at) AS startedAt, MAX(i.updated_at) AS updatedAt,
                COUNT(*) AS total,
                SUM(CASE WHEN i.status = 'done' THEN 1 ELSE 0 END) AS done,
                SUM(CASE WHEN i.status = 'failed' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN i.status IN ('pending','processing') THEN 1 ELSE 0 END) AS open
           FROM import_items i LEFT JOIN users u ON u.id = i.user_id
          ${where}
          GROUP BY i.user_id, i.batch_id
          ORDER BY MIN(i.created_at) DESC LIMIT 100`,
      )
      .all(...args) as ReturnType<MusicImport['history']>;
  }

  /**
   * The person's most recent batch, sectioned for the progress page.
   *
   * Sections rather than one big list, because a thousand-row import buried
   * every completion and failure under hundreds of "waiting" rows. What is
   * downloading right now comes grouped by album with the download percentage
   * from its request; failures are complete (they are what the person needs
   * to act on); completions are the newest few; waiting is just a number and
   * a taste.
   */
  status(
    userId: number,
    batchId?: string,
  ): {
    batchId: string | null;
    counts: Record<string, number>;
    total: number;
    albums: { album: string; artist: string; progress: number; state: string; songs: number }[];
    failed: ImportItem[];
    recentDone: ImportItem[];
    waitingPreview: ImportItem[];
  } {
    const empty = {
      batchId: null,
      counts: {},
      total: 0,
      albums: [],
      failed: [],
      recentDone: [],
      waitingPreview: [],
    };
    // A named batch (from the history list) or the latest. Scoped to the
    // caller either way — a batch id is not a capability.
    const batch = batchId
      ? (this.db
          .prepare('SELECT batch_id FROM import_items WHERE user_id = ? AND batch_id = ? LIMIT 1')
          .get(userId, batchId) as { batch_id: string } | undefined)
      : (this.db
          .prepare(
            'SELECT batch_id FROM import_items WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
          )
          .get(userId) as { batch_id: string } | undefined);
    if (!batch) return empty;
    const b = batch.batch_id;

    const counts: Record<string, number> = {};
    for (const r of this.db
      .prepare(
        'SELECT status, COUNT(*) AS n FROM import_items WHERE user_id = ? AND batch_id = ? GROUP BY status',
      )
      .all(userId, b) as { status: string; n: number }[]) {
      counts[r.status] = r.n;
    }
    const total = Object.values(counts).reduce((a, n) => a + n, 0);

    // Albums in flight: one row per request, with its live download state.
    const albums = this.db
      .prepare(
        `SELECT i.album, i.artist, COUNT(*) AS songs,
                COALESCE(r.progress, 0) AS progress,
                COALESCE(r.error, r.status) AS state
           FROM import_items i JOIN requests r ON r.id = i.request_id
          WHERE i.user_id = ? AND i.batch_id = ? AND i.status = 'processing'
          GROUP BY i.request_id ORDER BY r.progress DESC`,
      )
      .all(userId, b) as { album: string; artist: string; progress: number; state: string; songs: number }[];

    const pick = (where: string, order: string, limit: number): ImportItem[] =>
      this.db
        .prepare(
          `SELECT id, artist, title, album, playlist, status, detail
             FROM import_items WHERE user_id = ? AND batch_id = ? AND ${where}
            ORDER BY ${order} LIMIT ${limit}`,
        )
        .all(userId, b) as ImportItem[];

    return {
      batchId: b,
      counts,
      total,
      albums,
      failed: pick("status = 'failed'", 'updated_at DESC, id', 500),
      recentDone: pick("status = 'done'", 'updated_at DESC, id DESC', 40),
      waitingPreview: pick("status = 'pending'", 'id', 6),
    };
  }

  /**
   * Re-open the import items that were riding on one request.
   *
   * Called when that request is retried: their album is being fetched again, so
   * "album downloaded, but this song was not in it" is no longer the answer —
   * they go back to pending and are re-matched by the normal tick.
   */
  reopenForRequest(requestId: number): number {
    return this.db
      .prepare(
        `UPDATE import_items SET status = 'pending', detail = '', request_id = NULL,
              updated_at = unixepoch()
          WHERE request_id = ? AND status = 'failed'`,
      )
      .run(requestId).changes;
  }

  /**
   * Put a batch's failures back in the queue, for a retry after fixes.
   *
   * The tick deliberately refuses to re-request an album whose download failed,
   * so this is where a failed download gets its second chance: the linked
   * requests are reset and re-run, and the items are re-opened to be matched
   * against whatever arrives. An explicit human retry may spend bandwidth; an
   * automatic loop may not.
   */
  retryFailed(userId: number, opts: { reasons?: string[] } = {}): number {
    const batch = this.db
      .prepare(
        'SELECT batch_id FROM import_items WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      )
      .get(userId) as { batch_id: string } | undefined;
    if (!batch) return 0;

    /**
     * Optionally narrow to particular failure reasons.
     *
     * Failures are not equal and retrying them in one undifferentiated mass
     * wastes the most promising ones. An album that was FOUND and then broke on
     * missing repair blocks now has a torrent to fall back on and is very
     * likely to succeed; one that found nothing while the indexer was returning
     * 500s deserves a try but proves less; one whose album never resolved is a
     * metadata question. Retrying in that order gets music into the library
     * soonest and keeps the evidence readable.
     */
    const like = (opts.reasons ?? []).filter((r) => r.trim() !== '');
    const reasonSql = like.length
      ? ' AND (' + like.map(() => 'lower(detail) LIKE ?').join(' OR ') + ')'
      : '';
    const reasonArgs = like.map((r) => `%${r.toLowerCase()}%`);

    // Requests worth re-running: linked to this batch's failures and failed
    // themselves. A fulfilled one is not retried — its album is already here.
    const requestIds = (
      this.db
        .prepare(
          `SELECT DISTINCT i.request_id AS id FROM import_items i JOIN requests r ON r.id = i.request_id
            WHERE i.user_id = ? AND i.batch_id = ? AND i.status = 'failed' AND r.status = 'failed'` +
            reasonSql.replace(/detail/g, 'i.detail'),
        )
        .all(userId, batch.batch_id, ...reasonArgs) as { id: number }[]
    ).map((r) => r.id);

    const n = this.db
      .prepare(
        `UPDATE import_items SET status = 'pending', detail = '', request_id = NULL, updated_at = unixepoch()
          WHERE user_id = ? AND batch_id = ? AND status = 'failed'` + reasonSql,
      )
      .run(userId, batch.batch_id, ...reasonArgs).changes;

    for (const id of requestIds) {
      const row = this.store.requestById(id);
      if (!row) continue;
      this.store.resetRequest(id);
      void this.pipeline.start({ ...row, status: 'queued', error: null }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.store.settleRequest(id, 'failed', msg);
      });
    }

    if (n > 0) void this.tick().catch(() => undefined);
    return n;
  }

  /** A tick in progress. Ticks are slow (rate-gated MusicBrainz lookups) and
   *  the interval keeps firing — without this they stacked, multiplying the
   *  lookup queue and starving the event loop until health checks failed. */
  private ticking = false;

  /**
   * One pass over everything unsettled, for every user. Called on an interval
   * and after a batch arrives.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickOnce();
    } finally {
      this.ticking = false;
    }
  }

  private async tickOnce(): Promise<void> {
    const open = this.db
      .prepare(
        `SELECT id, user_id, batch_id, artist, title, album, playlist, request_id, status
           FROM import_items WHERE status IN ('pending','processing') ORDER BY id LIMIT 2000`,
      )
      .all() as {
      id: number;
      user_id: number;
      batch_id: string;
      artist: string;
      title: string;
      album: string;
      playlist: string;
      request_id: number | null;
      status: string;
    }[];
    if (!open.length) return;

    const setStatus = this.db.prepare(
      'UPDATE import_items SET status = ?, detail = ?, updated_at = unixepoch() WHERE id = ?',
    );
    const setRequest = this.db.prepare(
      'UPDATE import_items SET request_id = ?, status = ?, updated_at = unixepoch() WHERE id = ?',
    );

    const touchedUsers = new Set<number>();

    // Playlist ids per user, resolved once per tick.
    const playlistIds = new Map<number, Map<string, number>>();
    const playlistId = (userId: number, name: string): number | null => {
      if (!name) return null;
      let m = playlistIds.get(userId);
      if (!m) {
        m = new Map(this.userlib.playlists(userId).map((p) => [p.name.toLowerCase(), p.id]));
        playlistIds.set(userId, m);
      }
      return m.get(name.toLowerCase()) ?? null;
    };

    /** Song is on disk: into the library (and its playlist), settled. */
    const settleFromPool = (item: (typeof open)[number]): boolean => {
      // Exact first, then fuzzy within the album, then the lead artist alone:
      // exports say "B.Y.O.B." where the rip's tag says "B.Y.O.B. (Explicit
      // Album Version)", and collaborations credit everyone where tags credit
      // the lead. A miss on decoration re-downloads an album already here.
      const lead = primaryArtist(item.artist);
      const t =
        this.userlib.poolMatch(item.artist, item.title) ??
        (item.album ? this.userlib.matchInAlbum(item.artist, item.album, item.title) : null) ??
        (lead !== item.artist
          ? (this.userlib.poolMatch(lead, item.title) ??
             (item.album ? this.userlib.matchInAlbum(lead, item.album, item.title) : null))
          : null);
      if (!t) return false;
      this.userlib.add(item.user_id, t.trackId, 'import');
      const pl = playlistId(item.user_id, item.playlist);
      if (pl !== null) this.userlib.addToPlaylist(pl, t.trackId);
      setStatus.run('done', '', item.id);
      touchedUsers.add(item.user_id);
      return true;
    };

    // ---- 1. anything already here settles immediately ----------------------
    const remaining: typeof open = [];
    for (const item of open) {
      if (!settleFromPool(item)) remaining.push(item);
    }

    // ---- 2. reflect settled requests onto their songs ----------------------
    const requestState = new Map<number, { status: string; error: string | null }>();
    for (const item of remaining) {
      if (item.request_id === null) continue;
      let st = requestState.get(item.request_id);
      if (!st) {
        const row = this.db
          .prepare('SELECT status, error FROM requests WHERE id = ?')
          .get(item.request_id) as { status: string; error: string | null } | undefined;
        st = row ?? { status: 'failed', error: 'request row vanished' };
        requestState.set(item.request_id, st);
      }
      if (st.status === 'failed') {
        setStatus.run('failed', st.error ?? 'download failed', item.id);
      } else if (st.status === 'fulfilled') {
        // Album landed but this song did not match the pool above — a rip
        // whose tags disagree with the export. Named honestly.
        setStatus.run('failed', 'album downloaded, but this song was not in it', item.id);
      }
    }

    // ---- 3. start the next few album downloads -----------------------------
    const need = remaining.filter((i) => i.request_id === null);
    const byAlbum = new Map<string, typeof need>();
    for (const item of need) {
      const key = `${norm(item.artist)}|${canonAlbum(item.album || item.title)}`;
      const g = byAlbum.get(key) ?? [];
      g.push(item);
      byAlbum.set(key, g);
    }

    let started = 0;
    // Rate-gated lookups are the expensive part, not request creation: a tick
    // that kept resolving albums it was not going to start yet ran for minutes
    // and queued hundreds of MusicBrainz calls. Bounded, the rest simply wait
    // their turn on a later tick.
    let resolutions = 0;
    for (const group of byAlbum.values()) {
      if (started >= ALBUMS_PER_TICK || resolutions >= ALBUMS_PER_TICK * 2) break;
      const first = group[0];
      if (!first) continue;

      // The album is already on disk and these songs STILL failed both the
      // exact and fuzzy match above — downloading it again would change
      // nothing. Fail them honestly instead.
      if (first.album && this.userlib.poolForAlbum(first.artist, first.album).length > 0) {
        for (const item of group) {
          setStatus.run('failed', 'album is on the server but no track matched this title', item.id);
        }
        continue;
      }

      // Resolve the album to a release group. An album name gets a search
      // (accepting the lead artist's credit, since collaborations rarely
      // match whole); failing that — or with no album at all — the song's own
      // recording finds its studio home, which also rescues export rows whose
      // "album" is really a single: Sunflower's album is Hollywood's Bleeding.
      const lead = primaryArtist(first.artist);
      let mbid: string | null = null;
      let albumTitle = first.album;
      resolutions++;
      try {
        if (first.album) {
          const hits = await this.mb.searchAlbums(`${lead} ${first.album}`, 8, 'idle');
          const wantAlbum = canonAlbum(first.album);
          const artists = new Set([norm(first.artist), norm(lead)]);
          // The album TITLE has to match, not merely the artist. Accepting an
          // artist-only hit is how "Massive Attack — Teardrop" downloaded a
          // 1998 compilation called "Massive Attack" and then reported that
          // Teardrop was not in it. When the title does not match — which is
          // most of the time for an export that names a single as its own
          // album — the recording lookup below finds the real home (Mezzanine).
          const best = hits.find(
            (h) => canonAlbum(h.title) === wantAlbum && artists.has(norm(h.artistName)),
          );
          mbid = best?.mbid ?? null;
          albumTitle = best?.title ?? first.album;
        }
        if (!mbid) {
          // 'idle': an import must never make somebody's page wait, and it
          // must never starve artwork — see the Lane docs in musicbrainz.ts.
          const found =
            (await this.mb.albumForTrack(lead, first.title, 'idle')) ??
            (bareTitle(first.title) !== first.title
              ? await this.mb.albumForTrack(lead, bareTitle(first.title), 'idle')
              : null);
          mbid = found?.albumMbid ?? null;
          albumTitle = found?.albumTitle ?? first.album;
        }
      } catch {
        mbid = null;
      }

      if (!mbid) {
        for (const item of group) {
          setStatus.run('failed', 'no matching album found in MusicBrainz', item.id);
        }
        continue;
      }

      /**
       * One download per album, ever — not one per tick.
       *
       * This used to look only for a QUEUED request, which meant any album
       * whose request had already finished got requested again the next time a
       * song from it came round: 49 requests for one EP, and the same NZB
       * pulled nine times for an Elton John record, on a metered account. A
       * finished request is the answer to "should this download", whichever way
       * it finished.
       */
      const prior = this.db
        .prepare(
          `SELECT id, status, error FROM requests WHERE mbid = ?
            ORDER BY CASE status WHEN 'queued' THEN 0 WHEN 'fulfilled' THEN 1 ELSE 2 END,
                     requested_at DESC LIMIT 1`,
        )
        .get(mbid) as { id: number; status: string; error: string | null } | undefined;

      if (prior && prior.status === 'fulfilled') {
        // The album is already here and the pool match above still did not find
        // this song, so downloading it again cannot help.
        for (const item of group) {
          setStatus.run('failed', 'album was downloaded, but this song was not in it', item.id);
        }
        continue;
      }
      if (prior && prior.status === 'failed') {
        // Tried and failed. Say why, and leave it — retrying is a decision for
        // a person, through Retry failed, not something to redo every tick.
        for (const item of group) {
          setStatus.run('failed', prior.error || 'the download for this album failed', item.id);
        }
        continue;
      }

      let requestId = prior?.id ?? null;

      if (requestId === null) {
        const username = (
          this.db.prepare('SELECT username FROM users WHERE id = ?').get(first.user_id) as
            | { username: string }
            | undefined
        )?.username;
        requestId = this.store.addRequest({
          kind: 'album',
          mbid,
          title: `${first.artist} — ${albumTitle || first.title}`,
          artistName: first.artist,
          askedFor: `import: ${first.artist} — ${albumTitle || first.title}`,
          requestedBy: username ?? 'import',
          albumCount: 1,
          // No requesterId: the album lands in the POOL only, and step 1 of a
          // later tick adds just the export's songs to the person's library.
          requesterId: null,
          source: 'import',
        });
        const row = { id: requestId, mbid, title: `${first.artist} — ${albumTitle}` };
        void this.pipeline
          .start({
            kind: 'album',
            artist_name: first.artist,
            asked_for: '',
            requested_by: username ?? 'import',
            requested_at: 0,
            album_count: 1,
            status: 'queued',
            lidarr_id: null,
            error: null,
            ...row,
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.store.settleRequest(row.id, 'failed', msg);
          });
        started++;
      }

      for (const item of group) setRequest.run(requestId, 'processing', item.id);
    }

    for (const u of touchedUsers) this.recommender.invalidate(u);
  }
}
