/**
 * Per-user libraries over a shared pool of files, and per-user "do not recommend".
 *
 * The separation this file exists to express: what is on disk and what a person has are
 * different facts. Downloads are album-shaped because Usenet is album-shaped, but
 * somebody who asked for one song should end up with one song. So the album lands, every
 * track joins the pool, and only the requested one joins that user's library.
 *
 * Three consequences worth stating plainly, because each one is a deliberate trade:
 *
 *   - Removing a track from a library never touches the file. One person losing interest
 *     must not cost everyone else a re-download, and the file is what makes the next
 *     request for it instant. Files nobody has are purged by an admin, on purpose.
 *   - A second person wanting a track already in the pool gets it with no download at
 *     all. That is the whole point of keeping the rest of the album.
 *   - "Do not recommend" is not deletion. Somebody can keep one song that is nothing
 *     like the rest of their taste and stop it steering every later suggestion — which
 *     is a thing people actually want and could not previously say.
 *
 * IMPORTANT limitation, recorded here because it is invisible from inside crate:
 * Anything that serves the folder directly from disk knows nothing about any of this:
 * a per-user library is authoritative in crate, and crate's own Subsonic API is what
 * makes it real for phone clients too.
 */

import type Database from 'better-sqlite3';
import { albumIdentity, canonAlbum } from './library.js';
import { norm } from './release.js';
import { materialize, parseRules } from './dynamicpl.js';

export interface PoolTrack {
  /**
   * Named trackId, not id.
   *
   * The client's types call it trackId and the server called it id, which typechecked on both
   * sides independently and produced `undefined` the moment a track crossed the wire — the
   * player would have had nothing to stream. Same name on both ends, so the compiler catches
   * it next time instead of the user.
   */
  trackId: number;
  path: string;
  artistName: string;
  albumTitle: string;
  title: string;
  trackNo: number | null;
  durationS: number | null;
  sizeBytes: number;
  /** From the tags, null when never read or genuinely absent. Only queries that ask fill it. */
  year: number | null;
  /**
   * The artist the ALBUM belongs to, readable. Distinct from artistName, which is who played
   * this track — see the note on Tags in lib/library.ts. Anything that identifies an ALBUM
   * has to use this: keying on the credit splits a record with a guest on it into two.
   */
  albumArtistName: string;
}

/** A track as one particular user sees it. */
export interface UserTrack extends PoolTrack {
  /** In their library already. */
  mine: boolean;
  /** On disk, so adding it is instant. Always true for anything from the pool. */
  onDisk: boolean;
  addedAt: number | null;
}

export interface Playlist {
  id: number;
  name: string;
  description: string;
  tracks: number;
  /** Doubles as the art cache-buster: everything that can change the mosaic bumps it. */
  updatedAt: number;
  /** 1 when the owner uploaded their own cover, so the UI knows Remove will do something. */
  customArt: number;
  /** The dynamic recipe JSON, or null/absent for an ordinary playlist. */
  rules?: string | null;
  /** Convenience flag derived from rules, so clients need not parse to know. */
  dynamic?: boolean;
}

/** Namespaced helpers rather than methods — playlists() maps over rows. */
const Playlists = {
  /** A dynamic playlist has no rows; its "count" is what the recipe deals per open. */
  withDynamicCount(p: Playlist): Playlist {
    if (!p.rules) return p;
    const rules = parseRules(p.rules);
    return { ...p, dynamic: true, tracks: rules?.limit ?? 0 };
  },
};

export type ExcludeKind = 'artist' | 'album' | 'track';

export class UserLibrary {
  constructor(private db: Database.Database) {}

  // ---- the pool -----------------------------------------------------------

  /**
   * Find tracks on disk matching a search.
   *
   * Matches on normalised artist and title so a query does not have to reproduce the
   * tags' punctuation. This is what makes "somebody already has this" instant rather
   * than a download.
   */
  searchPool(query: string, limit = 40): PoolTrack[] {
    const n = norm(query);
    if (!n) return [];
    const like = `%${n}%`;
    const rows = this.db
      .prepare(
        `SELECT id, path, artist_name, album_title, album_artist_name, title, track_no, duration_s, size
           FROM tracks
          WHERE norm_title LIKE ? OR norm_artist LIKE ? OR norm_album LIKE ?
          ORDER BY norm_artist, norm_album, track_no
          LIMIT ?`,
      )
      .all(like, like, like, limit) as RawTrack[];
    return rows.map(toPool);
  }

  /**
   * Artists already on the shelves whose name matches — the instant half of search.
   * Ordered by how much of them is held, because someone typing "ra" wants Radiohead
   * before a one-track guest credit.
   */
  searchLocalArtists(query: string, limit = 12): { name: string }[] {
    const n = norm(query);
    if (!n) return [];
    return this.db
      .prepare(
        `SELECT MIN(artist_name) AS name
           FROM tracks
          WHERE norm_artist LIKE ?
          GROUP BY norm_artist
          ORDER BY COUNT(*) DESC
          LIMIT ?`,
      )
      .all(`%${n}%`, limit) as { name: string }[];
  }

  /**
   * Albums already on the shelves matching by title OR by their artist — typing a band's
   * name should surface their records, not only records named after them.
   */
  searchLocalAlbums(
    query: string,
    limit = 12,
  ): { artistName: string; title: string; mbid: string | null }[] {
    const n = norm(query);
    if (!n) return [];
    return this.db
      .prepare(
        `SELECT MIN(album_artist_name) AS artistName, MIN(album_title) AS title,
                MIN(album_mbid) AS mbid
           FROM tracks
          WHERE (norm_album LIKE ? OR album_artist LIKE ?) AND album_title != ''
          GROUP BY album_artist, norm_album
          ORDER BY COUNT(*) DESC
          LIMIT ?`,
      )
      .all(`%${n}%`, `%${n}%`, limit) as { artistName: string; title: string; mbid: string | null }[];
  }

  /**
   * The pool's copy of one song, by names alone — how a chart entry, which is
   * an artist and a title and nothing else, finds out it is already here.
   * Exact normalised match only: a fuzzy hit that plays the wrong recording is
   * worse than a chart row that offers a download.
   */
  poolMatch(artistName: string, title: string): PoolTrack | null {
    const row = this.db
      .prepare(
        `SELECT id, path, artist_name, album_title, album_artist_name, title, track_no, duration_s, size
           FROM tracks WHERE norm_artist = ? AND norm_title = ? LIMIT 1`,
      )
      .get(norm(artistName), norm(title)) as RawTrack | undefined;
    return row ? toPool(row) : null;
  }

  byId(id: number): PoolTrack | null {
    const row = this.db
      .prepare(
        'SELECT id, path, artist_name, album_title, album_artist_name, title, track_no, duration_s, size FROM tracks WHERE id = ?',
      )
      .get(id) as RawTrack | undefined;
    return row ? toPool(row) : null;
  }

  /**
   * Tracks of one album already on disk, so an album page can show what is available.
   *
   * EXACT first, canonical only if that finds nothing. Callers arrive from two worlds: an
   * album page knows the full local title including its edition, while an importer or a
   * request only knows MusicBrainz's — "Rumours", never "Rumours (2001 Remaster)". Trying
   * identity first keeps two editions apart for anyone who can name one; falling back to the
   * canonical column keeps every by-name caller working, which is what stops this change
   * making imports harder.
   *
   * NOT an OR of the two: that would match the other edition's rows through the canonical
   * column even when the caller named one exactly, undoing the split.
   */
  poolForAlbum(artistName: string, albumTitle: string): PoolTrack[] {
    const sql = (col: string) =>
      `SELECT id, path, artist_name, album_title, album_artist_name, title, track_no,
              duration_s, size, year
         FROM tracks WHERE album_artist = ? AND ${col} = ? ORDER BY track_no, title`;
    const artist = norm(artistName);
    const exact = this.db.prepare(sql('norm_album')).all(artist, albumIdentity(albumTitle)) as RawTrack[];
    if (exact.length) return exact.map(toPool);
    const loose = this.db.prepare(sql('canon_album')).all(artist, canonAlbum(albumTitle)) as RawTrack[];
    return loose.map(toPool);
  }

  /**
   * The album's year: the one most of its tracks agree on.
   *
   * Mode rather than min, because one mistagged bonus track should not date the record, and
   * a genuine compilation is better described by its bulk than by its oldest song. Ties go to
   * the earlier year, which is the safer guess for a reissue with mixed tags.
   */
  albumYear(artistName: string, albumTitle: string): number | null {
    // Same exact-then-canonical fallback as poolForAlbum, and for the same reason.
    const sql = (col: string) =>
      `SELECT year, COUNT(*) AS n FROM tracks
        WHERE album_artist = ? AND ${col} = ? AND year > 0
        GROUP BY year ORDER BY n DESC, year ASC LIMIT 1`;
    const artist = norm(artistName);
    const hit =
      (this.db.prepare(sql('norm_album')).get(artist, albumIdentity(albumTitle)) as
        | { year: number }
        | undefined) ??
      (this.db.prepare(sql('canon_album')).get(artist, canonAlbum(albumTitle)) as
        | { year: number }
        | undefined);
    return hit?.year ?? null;
  }

  /**
   * Tracks this user holds where the artist PERFORMS but owns no album.
   *
   * A guest exists in a library only as a credit: Kylie Minogue is on one track of Sia's
   * *Reasonable Woman*, so she appears in the artists list while every album query — which
   * keys on album_artist — finds nothing for her, and her page came out empty. This is what
   * fills it, and it is the reason keeping the credit was worth doing at all.
   *
   * Matched as a WHOLE WORD inside norm_artist, so "Hilltop Hoods, Sia" is found by "Sia" as
   * well as by "Hilltop Hoods" — a combined credit is one string in the tags and the guest
   * has no separate row to match exactly. Bare containment would have made "Sia" match
   * Anastasia; norm() has already collapsed punctuation to spaces, so the three patterns
   * below cover the name at the start, the end, and the middle of a credit.
   */
  appearsOn(userId: number, artistName: string, limit = 60): UserTrack[] {
    const n = norm(artistName);
    if (!n) return [];
    const rows = this.db
      .prepare(
        `SELECT t.id, t.path, t.artist_name, t.album_title, t.album_artist_name, t.title,
                t.track_no, t.duration_s, t.size, t.year, ut.added_at
           FROM user_tracks ut JOIN tracks t ON t.id = ut.track_id
          WHERE ut.user_id = ?
            AND t.album_artist != ?
            AND (t.norm_artist = ?
                 OR t.norm_artist LIKE ?
                 OR t.norm_artist LIKE ?
                 OR t.norm_artist LIKE ?)
          ORDER BY t.norm_artist, t.norm_album, t.track_no
          LIMIT ?`,
      )
      .all(userId, n, n, `${n} %`, `% ${n}`, `% ${n} %`, limit) as (RawTrack & {
      added_at: number;
    })[];
    return rows.map((r) => ({ ...toPool(r), mine: true, onDisk: true, addedAt: r.added_at }));
  }

  /**
   * Best match in the pool for a title within an album.
   *
   * Used at import to work out which of the arrived files is the one that was asked for.
   * Exact normalised title first, then a containment match, because a rip's title can
   * carry a suffix MusicBrainz does not have — "(Album Version)" and the like.
   */
  matchInAlbum(artistName: string, albumTitle: string, wantedTitle: string): PoolTrack | null {
    const candidates = this.poolForAlbum(artistName, albumTitle);
    if (!candidates.length) return null;
    const want = norm(wantedTitle);
    if (!want) return null;

    const exact = candidates.find((t) => norm(t.title) === want);
    if (exact) return exact;
    const contains = candidates.find(
      (t) => norm(t.title).includes(want) || want.includes(norm(t.title)),
    );
    return contains ?? null;
  }

  // ---- one user's library -------------------------------------------------

  add(userId: number, trackId: number, source: 'request' | 'add' | 'import' = 'add'): void {
    this.db
      .prepare(
        `INSERT INTO user_tracks (user_id, track_id, added_at, source)
         VALUES (?,?,unixepoch(),?)
         ON CONFLICT(user_id, track_id) DO NOTHING`,
      )
      .run(userId, trackId, source);
    // Adding it back is somebody changing their mind, so it stops being suppressed.
    this.db.prepare('DELETE FROM user_removed WHERE user_id = ? AND track_id = ?').run(userId, trackId);
  }

  /**
   * Remove from this user's library. Never touches the file — see the header.
   *
   * The removal is recorded so the recommender does not offer it straight back. The pool still
   * has the file, which is what makes a track eligible to be recommended, so without this a
   * deliberate deletion reappears as a suggestion within the hour.
   *
   * It also leaves this user's PLAYLISTS, because streaming is gated on library membership:
   * a playlist row for a track you no longer hold is one that renders, invites a click and
   * then 404s. Removing it is the only state that stays honest. Other users' playlists keep
   * their own rows — this is a per-user removal, not a deletion from the pool.
   */
  remove(userId: number, trackId: number): void {
    this.db.prepare('DELETE FROM user_tracks WHERE user_id = ? AND track_id = ?').run(userId, trackId);
    this.db
      .prepare('INSERT INTO user_removed (user_id, track_id, at) VALUES (?,?,unixepoch()) ON CONFLICT DO NOTHING')
      .run(userId, trackId);
    // Stamped before the delete, while the join can still see which playlists held it.
    this.db
      .prepare(
        `UPDATE playlists SET updated_at = unixepoch()
          WHERE user_id = ?
            AND id IN (SELECT playlist_id FROM playlist_tracks WHERE track_id = ?)`,
      )
      .run(userId, trackId);
    this.db
      .prepare(
        `DELETE FROM playlist_tracks
          WHERE track_id = ?
            AND playlist_id IN (SELECT id FROM playlists WHERE user_id = ?)`,
      )
      .run(trackId, userId);
  }

  /** Tracks this user has taken out, which must not be recommended back to them. */
  removedTracks(userId: number): Set<number> {
    const rows = this.db
      .prepare('SELECT track_id FROM user_removed WHERE user_id = ?')
      .all(userId) as { track_id: number }[];
    return new Set(rows.map((r) => r.track_id));
  }

  /** Forget a removal, so the track can be suggested again. */
  unremove(userId: number, trackId: number): void {
    this.db.prepare('DELETE FROM user_removed WHERE user_id = ? AND track_id = ?').run(userId, trackId);
  }

  /**
   * Artists this user has removed tracks by — the artists their
   * recommendations are quietly suppressing. Surfaced so "recommend this
   * again" can exist: without it, a removal was a one-way door nobody was
   * told about.
   */
  removedArtistNames(userId: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT t.artist_name FROM user_removed ur
           JOIN tracks t ON t.id = ur.track_id
          WHERE ur.user_id = ?`,
      )
      .all(userId) as { artist_name: string }[];
    return rows.map((r) => r.artist_name);
  }

  /** Forget every removal of one artist's tracks, so they can be suggested again. */
  unremoveByArtist(userId: number, artistName: string): number {
    return this.db
      .prepare(
        `DELETE FROM user_removed WHERE user_id = ? AND track_id IN
           (SELECT id FROM tracks WHERE norm_artist = ?)`,
      )
      .run(userId, norm(artistName)).changes;
  }

  has(userId: number, trackId: number): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM user_tracks WHERE user_id = ? AND track_id = ?')
        .get(userId, trackId) !== undefined
    );
  }

  mine(userId: number, limit = 2000): UserTrack[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.path, t.artist_name, t.album_title, t.title, t.track_no,
                t.duration_s, t.size, t.album_artist_name, ut.added_at
           FROM user_tracks ut JOIN tracks t ON t.id = ut.track_id
          WHERE ut.user_id = ?
          ORDER BY t.norm_artist, t.norm_album, t.track_no
          LIMIT ?`,
      )
      .all(userId, limit) as (RawTrack & { added_at: number })[];
    return rows.map((r) => ({ ...toPool(r), mine: true, onDisk: true, addedAt: r.added_at }));
  }

  /** Which of these track ids the user already has, for annotating a result list. */
  minesOf(userId: number, ids: number[]): Set<number> {
    if (!ids.length) return new Set();
    const q = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT track_id FROM user_tracks WHERE user_id = ? AND track_id IN (${q})`)
      .all(userId, ...ids) as { track_id: number }[];
    return new Set(rows.map((r) => r.track_id));
  }

  counts(userId: number): { tracks: number; artists: number; albums: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS tracks,
                COUNT(DISTINCT t.norm_artist) AS artists,
                COUNT(DISTINCT t.norm_artist || '|' || t.norm_album) AS albums
           FROM user_tracks ut JOIN tracks t ON t.id = ut.track_id
          WHERE ut.user_id = ?`,
      )
      .get(userId) as { tracks: number; artists: number; albums: number };
    return { tracks: row.tracks ?? 0, artists: row.artists ?? 0, albums: row.albums ?? 0 };
  }

  /**
   * Artists in this user's library, weighted by how many of their tracks it holds.
   *
   * This replaces the global seed table as the basis for suggestions, which is what makes
   * recommendations actually personal — and what makes an exclude meaningful, since one
   * person's odd song no longer feeds everybody's front page.
   */
  seedArtists(userId: number, limit = 40): { name: string; tracks: number }[] {
    return this.db
      .prepare(
        `SELECT MIN(t.artist_name) AS name, COUNT(*) AS tracks
           FROM user_tracks ut JOIN tracks t ON t.id = ut.track_id
          WHERE ut.user_id = ?
            AND t.norm_artist NOT IN (
              SELECT norm_key FROM user_excludes WHERE user_id = ? AND kind = 'artist'
            )
          GROUP BY t.norm_artist
          ORDER BY tracks DESC
          LIMIT ?`,
      )
      .all(userId, userId, limit) as { name: string; tracks: number }[];
  }

  // ---- paginated library views --------------------------------------------

  /**
   * Sort clauses shared by the three library pages.
   *
   * Alphabetical is the default because it is the only ordering somebody can navigate by
   * memory — you know roughly where D is. Plays and recently-added are the two questions
   * people actually ask of their own library, and both are secondary sorts on name so the
   * order is stable when the counts tie.
   */
  private static order(
    sort: string,
    alphaCol: string,
    opts: { seed?: number; idCol?: string } = {},
  ): string {
    switch (sort) {
      case 'plays':
        return `plays DESC, ${alphaCol}`;
      case 'added':
        return `added DESC, ${alphaCol}`;
      // Highest rated first, most played within each band. The rating is a
      // deliberate act and outranks the habit, but among equally-rated (or
      // unrated) songs the play count is the honest signal.
      case 'fav':
        return `rating DESC, plays DESC, ${alphaCol}`;
      case 'shuffle': {
        /*
         * A shuffle that is DETERMINISTIC for a given seed, rather than ORDER BY RANDOM().
         *
         * The listing is paged, and each page is its own query. Random ordering would deal a
         * fresh hand for page 2, so some songs would appear on both pages and others on
         * neither — a shuffle that loses songs. Ordering by an arithmetic hash of the row id
         * and the seed gives one fixed permutation that every page agrees on, and a new seed
         * from the client is what deals again.
         *
         * Both constants derive from the seed so that changing it changes the ORDER and not
         * merely its rotation: adding a seed alone would shift every song by the same amount
         * and leave neighbours together. Kept small so the product cannot overflow.
         */
        if (!opts.idCol) return alphaCol;
        const P = 1000003;
        const seed = Math.abs(Math.floor(opts.seed ?? 0)) % P;
        const mul = (seed % (P - 1)) + 1;
        const add = (seed * 7919) % P;
        return `(((${opts.idCol} + ${add}) * ${mul}) % ${P}), ${alphaCol}`;
      }
      default:
        return alphaCol;
    }
  }

  /** 0 clears, 1..5 rates. The row must already be in their library. */
  setRating(userId: number, trackId: number, rating: number): boolean {
    const r = this.db
      .prepare('UPDATE user_tracks SET rating = ?, favorite = ? WHERE user_id = ? AND track_id = ?')
      .run(rating, rating > 0 ? 1 : 0, userId, trackId);
    return r.changes > 0;
  }

  rating(userId: number, trackId: number): number | null {
    const r = this.db
      .prepare('SELECT rating FROM user_tracks WHERE user_id = ? AND track_id = ?')
      .get(userId, trackId) as { rating: number } | undefined;
    return r ? r.rating : null;
  }

  /** One page of this user's songs, optionally filtered. */
  songsPage(
    userId: number,
    opts: {
      q?: string;
      sort?: string;
      offset?: number;
      limit?: number;
      algoProfile?: number;
      /** Which deal of the shuffle to serve. Only read when sort is 'shuffle'. */
      seed?: number;
    } = {},
  ): { tracks: (UserTrack & { plays: number })[]; total: number } {
    /*
     * The ceiling is high because this method serves two callers, and only one of them is
     * asking for a page. The listing asks for 60 and is separately clamped to 200 by its route;
     * the queue asks for the WHOLE library, and a 500 cap here meant "Play these" quietly
     * queued 500 of a 610-song library and dropped the rest.
     */
    const limit = Math.min(Math.max(opts.limit ?? 60, 1), 5000);
    const offset = Math.max(opts.offset ?? 0, 0);
    const q = norm(opts.q ?? '');
    const like = `%${q}%`;
    const where = q
      ? 'ut.user_id = ? AND (t.norm_title LIKE ? OR t.norm_artist LIKE ? OR t.norm_album LIKE ?)'
      : 'ut.user_id = ?';
    const args = q ? [userId, like, like, like] : [userId];

    /*
     * The algorithm sort resolves each song's EFFECTIVE WARMTH by specificity
     * — track beats album beats artist beats the average of the artist's
     * genre warmths, silence falls through, nothing set means neutral 2.5 —
     * then hides warmth 0 outright ("prefer zero songs like this" is a
     * statement about presence, not position) and orders warm-first. Wrapped
     * in a subquery because SQLite will not let WHERE see the alias, and the
     * expression is far too long to write twice.
     */
    const algoMode = opts.sort === 'algo' && opts.algoProfile;
    const warmthExpr = `COALESCE(
      (SELECT w.warmth FROM algo_warmth w WHERE w.profile_id = @ap AND w.kind = 'track'
        AND w.norm_key = t.norm_artist || '|' || t.norm_title),
      (SELECT w.warmth FROM algo_warmth w WHERE w.profile_id = @ap AND w.kind = 'album'
        AND w.norm_key = t.norm_artist || '|' || t.norm_album),
      (SELECT w.warmth FROM algo_warmth w WHERE w.profile_id = @ap AND w.kind = 'artist'
        AND w.norm_key = t.norm_artist),
      (SELECT AVG(w.warmth) FROM algo_warmth w
         JOIN artist_genres g ON g.genre = w.norm_key AND g.norm_artist = t.norm_artist
        WHERE w.profile_id = @ap AND w.kind = 'genre'),
      2.5
    )`.replace(/@ap/g, String(Number(opts.algoProfile ?? 0)));

    const inner = `SELECT t.id, t.path, t.artist_name, t.album_title, t.title, t.track_no,
                t.duration_s, t.size, t.album_artist_name, ut.added_at, ut.favorite, ut.rating,
                COALESCE(p.plays, 0) AS plays, ut.added_at AS added
                ${algoMode ? `, ${warmthExpr} AS warmth_eff` : ''}
           FROM user_tracks ut
           JOIN tracks t ON t.id = ut.track_id
           LEFT JOIN plays p ON p.track_id = t.id AND p.user_id = ut.user_id
          WHERE ${where}`;

    const total = algoMode
      ? (this.db
          .prepare(`SELECT COUNT(*) AS n FROM (${inner}) WHERE warmth_eff > 0`)
          .get(...args) as { n: number }).n
      : (this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM user_tracks ut JOIN tracks t ON t.id = ut.track_id WHERE ${where}`,
          )
          .get(...args) as { n: number }).n;

    const rows = (
      algoMode
        ? this.db.prepare(
            `SELECT * FROM (${inner}) WHERE warmth_eff > 0
              ORDER BY warmth_eff DESC, plays DESC, artist_name COLLATE NOCASE
              LIMIT ? OFFSET ?`,
          )
        : this.db.prepare(
            `${inner} ORDER BY ${UserLibrary.order(opts.sort ?? 'alpha', 't.norm_title', {
              seed: opts.seed,
              // The ORDER BY is appended to the inner SELECT, so the join's aliases are still
              // in scope and the track's own id is available as the shuffle's stable key.
              idCol: 't.id',
            })} LIMIT ? OFFSET ?`,
          )
    ).all(...args, limit, offset) as (RawTrack & { added_at: number; plays: number })[];

    return {
      total,
      tracks: rows.map((r) => ({
        ...toPool(r),
        mine: true,
        onDisk: true,
        addedAt: r.added_at,
        plays: r.plays,
        favorite: ((r as { rating?: number }).rating ?? 0) > 0,
        rating: (r as { rating?: number }).rating ?? 0,
      })),
    };
  }

  /** One page of the artists in this user's library. */
  artistsPage(
    userId: number,
    opts: { sort?: string; offset?: number; limit?: number } = {},
  ): {
    artists: { name: string; tracks: number; albums: number; plays: number; added: number }[];
    total: number;
  } {
    const limit = Math.min(Math.max(opts.limit ?? 48, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);

    const total = (
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT t.norm_artist) AS n
             FROM user_tracks ut JOIN tracks t ON t.id = ut.track_id WHERE ut.user_id = ?`,
        )
        .get(userId) as { n: number }
    ).n;

    const artists = this.db
      .prepare(
        `SELECT MIN(t.artist_name) AS name,
                COUNT(*) AS tracks,
                COUNT(DISTINCT t.norm_album) AS albums,
                COALESCE(SUM(p.plays), 0) AS plays,
                MAX(ut.added_at) AS added,
                MIN(t.norm_artist) AS norm_artist
           FROM user_tracks ut
           JOIN tracks t ON t.id = ut.track_id
           LEFT JOIN plays p ON p.track_id = t.id AND p.user_id = ut.user_id
          WHERE ut.user_id = ?
          GROUP BY t.norm_artist
          ORDER BY ${UserLibrary.order(opts.sort ?? 'alpha', 'norm_artist')}
          LIMIT ? OFFSET ?`,
      )
      .all(userId, limit, offset) as {
      name: string;
      tracks: number;
      albums: number;
      plays: number;
      added: number;
    }[];

    return { artists, total };
  }

  /** One page of the albums in this user's library. */
  albumsPage(
    userId: number,
    opts: { sort?: string; offset?: number; limit?: number } = {},
  ): {
    albums: {
      artistName: string;
      albumTitle: string;
      tracks: number;
      plays: number;
      added: number;
    }[];
    total: number;
  } {
    const limit = Math.min(Math.max(opts.limit ?? 48, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);

    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
             SELECT 1 FROM user_tracks ut JOIN tracks t ON t.id = ut.track_id
              WHERE ut.user_id = ? GROUP BY t.album_artist, t.norm_album)`,
        )
        .get(userId) as { n: number }
    ).n;

    const albums = this.db
      .prepare(
        // album_artist_name, NOT artist_name: this row is grouped by album_artist and its
        // artist is what the tile links with, so it has to be the name whose normalised form
        // IS that key. Using the performer would send a compilation's tile to an album page
        // keyed on a different artist, which returns nothing.
        `SELECT MIN(t.album_artist_name) AS artistName,
                MIN(t.album_title) AS albumTitle,
                COUNT(*) AS tracks,
                COALESCE(SUM(p.plays), 0) AS plays,
                MAX(ut.added_at) AS added,
                MIN(t.norm_album) AS norm_album
           FROM user_tracks ut
           JOIN tracks t ON t.id = ut.track_id
           LEFT JOIN plays p ON p.track_id = t.id AND p.user_id = ut.user_id
          WHERE ut.user_id = ?
          GROUP BY t.album_artist, t.norm_album
          ORDER BY ${UserLibrary.order(opts.sort ?? 'alpha', 'norm_album')}
          LIMIT ? OFFSET ?`,
      )
      .all(userId, limit, offset) as {
      artistName: string;
      albumTitle: string;
      tracks: number;
      plays: number;
      added: number;
    }[];

    return { albums, total };
  }

  // ---- plays --------------------------------------------------------------

  /**
   * Record a completed play.
   *
   * "Completed" is the caller's judgement, and the client only calls this once a track has
   * been listened to for thirty seconds or half its length — the Last.fm rule. Counting a
   * play the moment audio starts would make every skip through a queue look like a
   * preference, and the recommendations are built on this number.
   */
  notePlay(userId: number, trackId: number): void {
    this.db
      .prepare(
        `INSERT INTO plays (user_id, track_id, plays, first_played, last_played)
         VALUES (?,?,1,unixepoch(),unixepoch())
         ON CONFLICT(user_id, track_id) DO UPDATE SET
           plays = plays.plays + 1, last_played = unixepoch()`,
      )
      .run(userId, trackId);
    // And the timeline, which the aggregate above cannot reconstruct.
    this.db.prepare('INSERT INTO play_log (user_id, track_id, at) VALUES (?,?,unixepoch())').run(userId, trackId);
  }

  /** Record an abandoned track. Negative evidence, kept apart from plays. */
  noteSkip(userId: number, trackId: number): void {
    this.db
      .prepare(
        `INSERT INTO plays (user_id, track_id, skips, first_played, last_played)
         VALUES (?,?,1,unixepoch(),unixepoch())
         ON CONFLICT(user_id, track_id) DO UPDATE SET skips = plays.skips + 1`,
      )
      .run(userId, trackId);
  }

  /** Most played, for the front page and as the strongest taste signal there is. */
  mostPlayed(userId: number, limit = 30): (UserTrack & { plays: number })[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.path, t.artist_name, t.album_title, t.title, t.track_no,
                t.duration_s, t.size, t.album_artist_name, ut.added_at, p.plays
           FROM plays p
           JOIN tracks t ON t.id = p.track_id
           JOIN user_tracks ut ON ut.track_id = t.id AND ut.user_id = p.user_id
          WHERE p.user_id = ? AND p.plays > 0
          ORDER BY p.plays DESC, p.last_played DESC
          LIMIT ?`,
      )
      .all(userId, limit) as (RawTrack & { added_at: number; plays: number })[];
    return rows.map((r) => ({
      ...toPool(r),
      mine: true,
      onDisk: true,
      addedAt: r.added_at,
      plays: r.plays,
    }));
  }

  /** Recently added to this person's library. */
  newest(userId: number, limit = 30): UserTrack[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.path, t.artist_name, t.album_title, t.title, t.track_no,
                t.duration_s, t.size, t.album_artist_name, ut.added_at
           FROM user_tracks ut JOIN tracks t ON t.id = ut.track_id
          WHERE ut.user_id = ?
          ORDER BY ut.added_at DESC, t.id DESC
          LIMIT ?`,
      )
      .all(userId, limit) as (RawTrack & { added_at: number })[];
    return rows.map((r) => ({ ...toPool(r), mine: true, onDisk: true, addedAt: r.added_at }));
  }

  /** Play counts for a set of tracks, for annotating a list. */
  playsOf(userId: number, ids: number[]): Map<number, number> {
    if (!ids.length) return new Map();
    const q = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT track_id, plays FROM plays WHERE user_id = ? AND track_id IN (${q})`)
      .all(userId, ...ids) as { track_id: number; plays: number }[];
    return new Map(rows.map((r) => [r.track_id, r.plays]));
  }

  /**
   * Artists weighted by listening, with a recency lean.
   *
   * Plays beat library membership as a signal — adding a track is a guess, playing it forty
   * times is a fact — so this is what the recommender seeds from. Recency is a mild
   * multiplier rather than a hard window: taste drifts, but something loved two years ago is
   * still evidence.
   */
  listeningProfile(userId: number, limit = 40): { name: string; weight: number }[] {
    const rows = this.db
      .prepare(
        `SELECT MIN(t.artist_name) AS name,
                SUM(p.plays) AS plays,
                SUM(p.skips) AS skips,
                MAX(p.last_played) AS last_played
           FROM plays p
           JOIN tracks t ON t.id = p.track_id
           -- Only tracks STILL in the library seed the profile.
           --
           -- Without this join, removing something leaves its play history seeding
           -- recommendations forever: delete every Spice Girls track and crate carries on
           -- suggesting artists "like Spice Girls", because the plays row outlived the library
           -- entry. The history is deliberately kept — re-adding the track brings its weight
           -- straight back — it just stops counting while the track is not held.
           JOIN user_tracks ut ON ut.track_id = p.track_id AND ut.user_id = p.user_id
          WHERE p.user_id = ?
            AND t.norm_artist NOT IN (
              SELECT norm_key FROM user_excludes WHERE user_id = ? AND kind = 'artist'
            )
          GROUP BY t.norm_artist
          -- Spelled out, NOT the bare alias. "HAVING plays > 0" resolved to the plays COLUMN
          -- of one arbitrary row in the group, so an artist whose arbitrary row was a
          -- skip-only row (plays = 0) vanished from the profile entirely — 40 Radiohead plays
          -- gone, and every recommendation read "like All Them Witches" because that was the
          -- heaviest seed left standing.
          HAVING SUM(p.plays) > 0`,
      )
      .all(userId, userId) as {
      name: string;
      plays: number;
      skips: number;
      last_played: number;
    }[];

    const now = Math.floor(Date.now() / 1000);
    return rows
      .map((r) => {
        const ageDays = Math.max(0, (now - r.last_played) / 86400);
        // Halves over a year. Old favourites still count, just less than current ones.
        const recency = 1 / (1 + ageDays / 365);
        // Skips subtract, but cannot drive a weight negative — an artist played 30 times and
        // skipped twice is still a favourite.
        const net = Math.max(1, r.plays - r.skips * 0.5);
        return { name: r.name, weight: net * (0.5 + 0.5 * recency) };
      })
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit);
  }

  // ---- playlists ----------------------------------------------------------

  /**
   * Albums the caller owns only PART of, where the pool already holds the rest.
   *
   * The gap is free to close — the files are on disk, they are simply not in this
   * person's library — which is what makes this worth a screen: every row is one click
   * from complete, with no download and no waiting.
   */
  incompleteAlbums(
    userId: number,
    limit = 200,
  ): { artistName: string; albumTitle: string; mine: number; onDisk: number }[] {
    return this.db
      .prepare(
        `SELECT MIN(t.album_artist_name) AS artistName, MIN(t.album_title) AS albumTitle,
                SUM(CASE WHEN ut.track_id IS NOT NULL THEN 1 ELSE 0 END) AS mine,
                COUNT(*) AS onDisk
           FROM tracks t
           LEFT JOIN user_tracks ut ON ut.track_id = t.id AND ut.user_id = ?
          WHERE t.album_title != ''
          GROUP BY t.album_artist, t.norm_album
         HAVING mine > 0 AND mine < onDisk
          ORDER BY (onDisk - mine) ASC, mine DESC
          LIMIT ?`,
      )
      .all(userId, limit) as { artistName: string; albumTitle: string; mine: number; onDisk: number }[];
  }

  /**
   * Add every pooled track of one album the caller does not already hold.
   *
   * Goes through add() rather than its own INSERT, so a track the user once removed
   * stops being suppressed exactly as it would if they had added it by hand.
   * Returns how many were added, so the UI can say something true.
   */
  fillAlbum(userId: number, artistName: string, albumTitle: string): number {
    const missing = this.poolForAlbum(artistName, albumTitle).filter((t) => !this.has(userId, t.trackId));
    const tx = this.db.transaction((ids: number[]) => {
      for (const id of ids) this.add(userId, id, 'add');
    });
    tx(missing.map((t) => t.trackId));
    return missing.length;
  }

  /** Analyzer results for one track. The -1 failure sentinel reads as "unknown" here. */
  analysisOf(trackId: number): { bpm: number | null; energy: number | null } {
    const row = this.db.prepare('SELECT bpm, energy FROM tracks WHERE id = ?').get(trackId) as
      | { bpm: number | null; energy: number | null }
      | undefined;
    return {
      bpm: row?.bpm != null && row.bpm > 0 ? row.bpm : null,
      energy: row?.energy != null && row.energy >= 0 ? row.energy : null,
    };
  }

  /**
   * The library as a curator would read it: one compact row per track, with the track's own
   * genres and year alongside the names. This is what gets shipped to the model when somebody
   * asks for a playlist in words — everything it may pick from, and nothing it may not.
   */
  aiCatalog(userId: number): { id: number; artist: string; title: string; album: string; year: number | null; genres: string }[] {
    return this.db
      .prepare(
        `SELECT t.id, t.artist_name AS artist, t.title, t.album_title AS album,
                NULLIF(t.year, 0) AS year, t.genres
           FROM user_tracks ut JOIN tracks t ON t.id = ut.track_id
          WHERE ut.user_id = ?
          ORDER BY t.norm_artist, t.norm_album, t.track_no`,
      )
      .all(userId) as { id: number; artist: string; title: string; album: string; year: number | null; genres: string }[];
  }

  createPlaylist(userId: number, name: string, rules: string | null = null): number {
    const info = this.db
      .prepare(
        'INSERT INTO playlists (user_id, name, rules, created_at, updated_at) VALUES (?,?,?,unixepoch(),unixepoch())',
      )
      .run(userId, name, rules);
    return Number(info.lastInsertRowid);
  }

  playlists(userId: number): Playlist[] {
    return (
      this.db
        .prepare(
          `SELECT p.id, p.name, p.description, p.updated_at AS updatedAt,
                p.art_custom IS NOT NULL AS customArt, p.rules,
                (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS tracks
           FROM playlists p WHERE p.user_id = ? ORDER BY p.name`,
        )
        .all(userId) as Playlist[]
    ).map((p) => Playlists.withDynamicCount(p));
  }

  /** Owned by this user, or null — which is the authorisation check for every playlist call. */
  playlist(userId: number, id: number): Playlist | null {
    const row = this.db
      .prepare(
        `SELECT p.id, p.name, p.description, p.updated_at AS updatedAt,
                  p.art_custom IS NOT NULL AS customArt, p.rules,
                  (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS tracks
             FROM playlists p WHERE p.id = ? AND p.user_id = ?`,
      )
      .get(id, userId) as Playlist | undefined;
    return row ? Playlists.withDynamicCount(row) : null;
  }

  /** Swap a dynamic playlist's recipe. The next open deals from the new one. */
  setPlaylistRules(playlistId: number, rules: string): void {
    this.db
      .prepare('UPDATE playlists SET rules = ?, updated_at = unixepoch() WHERE id = ?')
      .run(rules, playlistId);
  }

  /** Description only; the name goes through renamePlaylist, which validates differently. */
  setPlaylistDescription(playlistId: number, description: string): void {
    this.db
      .prepare('UPDATE playlists SET description = ?, updated_at = unixepoch() WHERE id = ?')
      .run(description, playlistId);
  }

  /**
   * A playlist's tracks, each honest about whether the OWNER still holds it.
   *
   * mine is derived from the playlist's own user_id rather than taken as a parameter, so an
   * admin looking at someone else's playlist gets that person's ownership rather than their
   * own, and no caller can get it wrong by passing the viewer. It used to be hardcoded true,
   * which meant a track removed from the library still rendered as playable here.
   */
  /**
   * The playable content of a playlist: its stored rows, or — for a dynamic one — a
   * fresh deal from its recipe. Every consumer (JSON API, queue, Subsonic) goes through
   * here so a dynamic playlist behaves like a playlist everywhere.
   */
  playlistContent(userId: number, pl: Playlist): UserTrack[] {
    const rules = pl.rules ? parseRules(pl.rules) : null;
    if (rules) return materialize(this.db, userId, rules);
    return this.playlistTracks(pl.id);
  }

  playlistTracks(playlistId: number): UserTrack[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.path, t.artist_name, t.album_title, t.title, t.track_no,
                t.duration_s, t.size, t.album_artist_name, pt.added_at,
                EXISTS (
                  SELECT 1 FROM user_tracks ut
                   WHERE ut.track_id = t.id
                     AND ut.user_id = (SELECT user_id FROM playlists WHERE id = pt.playlist_id)
                ) AS mine
           FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
          WHERE pt.playlist_id = ? ORDER BY pt.position, pt.added_at`,
      )
      .all(playlistId) as (RawTrack & { added_at: number; mine: number })[];
    return rows.map((r) => ({ ...toPool(r), mine: r.mine === 1, onDisk: true, addedAt: r.added_at }));
  }

  addToPlaylist(playlistId: number, trackId: number): void {
    const next = this.db
      .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM playlist_tracks WHERE playlist_id = ?')
      .get(playlistId) as { n: number };
    this.db
      .prepare(
        `INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
         VALUES (?,?,?,unixepoch()) ON CONFLICT DO NOTHING`,
      )
      .run(playlistId, trackId, next.n);
    this.touchPlaylist(playlistId);
  }

  removeFromPlaylist(playlistId: number, trackId: number): void {
    this.db
      .prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?')
      .run(playlistId, trackId);
    this.touchPlaylist(playlistId);
  }

  /** Reorder wholesale. Simpler and safer than shuffling individual positions. */
  reorderPlaylist(playlistId: number, trackIds: number[]): void {
    const set = this.db.prepare(
      'UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?',
    );
    const tx = this.db.transaction(() => {
      trackIds.forEach((id, i) => set.run(i, playlistId, id));
    });
    tx();
    this.touchPlaylist(playlistId);
  }

  deletePlaylist(userId: number, id: number): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(id);
      this.db.prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').run(id, userId);
    });
    tx();
  }

  renamePlaylist(userId: number, id: number, name: string): void {
    this.db
      .prepare('UPDATE playlists SET name = ?, updated_at = unixepoch() WHERE id = ? AND user_id = ?')
      .run(name, id, userId);
  }

  private touchPlaylist(playlistId: number): void {
    this.db.prepare('UPDATE playlists SET updated_at = unixepoch() WHERE id = ?').run(playlistId);
  }

  // ---- queues -------------------------------------------------------------

  /**
   * Every track this user holds by one artist, in album order — a "play this artist" queue.
   */
  byArtist(userId: number, artistName: string): UserTrack[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.path, t.artist_name, t.album_title, t.title, t.track_no,
                t.duration_s, t.size, t.album_artist_name, ut.added_at
           FROM user_tracks ut JOIN tracks t ON t.id = ut.track_id
          WHERE ut.user_id = ? AND t.norm_artist = ?
          ORDER BY t.norm_album, t.track_no`,
      )
      .all(userId, norm(artistName)) as (RawTrack & { added_at: number })[];
    return rows.map((r) => ({ ...toPool(r), mine: true, onDisk: true, addedAt: r.added_at }));
  }

  /** One album from this user's library, in track order. */
  byAlbum(userId: number, artistName: string, albumTitle: string): UserTrack[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.path, t.artist_name, t.album_title, t.title, t.track_no,
                t.duration_s, t.size, t.album_artist_name, ut.added_at
           FROM user_tracks ut JOIN tracks t ON t.id = ut.track_id
          WHERE ut.user_id = ? AND t.album_artist = ? AND t.norm_album = ?
          ORDER BY t.track_no`,
      )
      .all(userId, norm(artistName), albumIdentity(albumTitle)) as (RawTrack & { added_at: number })[];
    return rows.map((r) => ({ ...toPool(r), mine: true, onDisk: true, addedAt: r.added_at }));
  }

  /**
   * Albums by one artist, with how much of each this user holds.
   *
   * Covers the pool as well as the library, so an album page can offer "you have 3 of 11 —
   * add the rest" instead of pretending the other eight do not exist.
   */
  albumsByArtist(
    userId: number,
    artistName: string,
  ): { albumTitle: string; mine: number; onDisk: number }[] {
    return this.db
      .prepare(
        `SELECT MIN(t.album_title) AS albumTitle,
                COUNT(*) AS onDisk,
                SUM(CASE WHEN ut.user_id IS NULL THEN 0 ELSE 1 END) AS mine
           FROM tracks t
           LEFT JOIN user_tracks ut ON ut.track_id = t.id AND ut.user_id = ?
          -- album_artist, so an artist page lists an album once even when a
          -- guest performer sits in some tracks' artist tag.
          WHERE t.album_artist = ?
          GROUP BY t.norm_album
          ORDER BY mine DESC, albumTitle`,
      )
      .all(userId, norm(artistName)) as { albumTitle: string; mine: number; onDisk: number }[];
  }

  // ---- do not recommend ---------------------------------------------------

  /** The key an exclude is stored under. Normalised so punctuation cannot defeat it. */
  static excludeKey(kind: ExcludeKind, a: string, b?: string): string {
    if (kind === 'artist') return norm(a);
    if (kind === 'album') return `${norm(a)}|${albumIdentity(b ?? '')}`;
    return `${norm(a)}|${norm(b ?? '')}`;
  }

  exclude(userId: number, kind: ExcludeKind, key: string, label: string): void {
    this.db
      .prepare(
        `INSERT INTO user_excludes (user_id, kind, norm_key, label, at)
         VALUES (?,?,?,?,unixepoch())
         ON CONFLICT(user_id, kind, norm_key) DO UPDATE SET label = excluded.label`,
      )
      .run(userId, kind, key, label);
  }

  unexclude(userId: number, kind: ExcludeKind, key: string): void {
    this.db
      .prepare('DELETE FROM user_excludes WHERE user_id = ? AND kind = ? AND norm_key = ?')
      .run(userId, kind, key);
  }

  excludes(userId: number): { kind: ExcludeKind; key: string; label: string; at: number }[] {
    return (
      this.db
        .prepare('SELECT kind, norm_key, label, at FROM user_excludes WHERE user_id = ? ORDER BY kind, label')
        .all(userId) as { kind: ExcludeKind; norm_key: string; label: string; at: number }[]
    ).map((r) => ({ kind: r.kind, key: r.norm_key, label: r.label, at: r.at }));
  }

  /** Excluded artist names, normalised, for filtering a suggestion list. */
  excludedArtists(userId: number): Set<string> {
    const rows = this.db
      .prepare("SELECT norm_key FROM user_excludes WHERE user_id = ? AND kind = 'artist'")
      .all(userId) as { norm_key: string }[];
    return new Set(rows.map((r) => r.norm_key));
  }

  // ---- admin --------------------------------------------------------------

  /**
   * Tracks on disk that nobody has in a library.
   *
   * The purge candidates: everything that arrived because it happened to be on an album
   * somebody wanted one song from. Kept by default, because keeping them is what makes
   * the next request for one instant, and deleted only when somebody decides the space
   * matters more.
   */
  orphans(): (PoolTrack & { firstSeen: number })[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.path, t.artist_name, t.album_title, t.title, t.track_no,
                t.duration_s, t.size, t.album_artist_name, t.first_seen
           FROM tracks t
          WHERE NOT EXISTS (SELECT 1 FROM user_tracks ut WHERE ut.track_id = t.id)
          ORDER BY t.norm_artist, t.norm_album, t.track_no`,
      )
      .all() as (RawTrack & { first_seen: number })[];
    return rows.map((r) => ({ ...toPool(r), firstSeen: r.first_seen }));
  }

  /**
   * Tracks only this user holds — what purging them would take off disk.
   *
   * Computed fresh rather than stored, because it changes every time anyone
   * else adds or removes a track. This is the number an admin needs BEFORE
   * deciding to purge: "12 GB goes" reads very differently from "nothing
   * goes, everything they had is shared".
   */
  exclusiveTracks(userId: number): PoolTrack[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.path, t.artist_name, t.album_title, t.title, t.track_no,
                t.duration_s, t.size, t.album_artist_name
           FROM tracks t
           JOIN user_tracks ut ON ut.track_id = t.id AND ut.user_id = ?
          WHERE NOT EXISTS (
            SELECT 1 FROM user_tracks o
             WHERE o.track_id = t.id AND o.user_id != ?
          )
          ORDER BY t.norm_artist, t.norm_album, t.track_no`,
      )
      .all(userId, userId) as RawTrack[];
    return rows.map(toPool);
  }

  /**
   * Every row that is THEIRS, in one transaction.
   *
   * Requests and dismissals are keyed by username rather than id — they
   * predate accounts being the identity — so the caller passes both. Files
   * are deliberately not touched here: rows are instant and reversible-ish
   * (a restore from backup), disk is neither, so the caller decides about
   * files with this already done and the holder counts already honest.
   */
  purgeUserRows(userId: number, username: string): Record<string, number> {
    const out: Record<string, number> = {};
    const run = this.db.transaction(() => {
      out.playlistTracks = this.db
        .prepare(
          'DELETE FROM playlist_tracks WHERE playlist_id IN (SELECT id FROM playlists WHERE user_id = ?)',
        )
        .run(userId).changes;
      out.playlists = this.db.prepare('DELETE FROM playlists WHERE user_id = ?').run(userId).changes;
      out.libraryTracks = this.db.prepare('DELETE FROM user_tracks WHERE user_id = ?').run(userId).changes;
      out.plays = this.db.prepare('DELETE FROM plays WHERE user_id = ?').run(userId).changes;
      out.removed = this.db.prepare('DELETE FROM user_removed WHERE user_id = ?').run(userId).changes;
      out.excludes = this.db.prepare('DELETE FROM user_excludes WHERE user_id = ?').run(userId).changes;
      out.importItems = this.db.prepare('DELETE FROM import_items WHERE user_id = ?').run(userId).changes;
      out.sessions = this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
      out.requests = this.db.prepare('DELETE FROM requests WHERE requested_by = ?').run(username).changes;
      out.dismissed = this.db.prepare('DELETE FROM dismissed WHERE by_user = ?').run(username).changes;
      out.loginAttempts = this.db.prepare('DELETE FROM login_attempts WHERE username = ?').run(username).changes;
    });
    run();
    return out;
  }

  /**
   * The same song, more than once, inside one album.
   *
   * Two rips of a record merged into one folder — an adoption landing on top
   * of an import, mostly — leave every track doubled. Grouping is by album
   * and normalised title, so it cannot mistake two genuinely different songs
   * for each other, and it deliberately does NOT compare across albums: a
   * track that appears on a studio album and a compilation is two legitimate
   * copies of different records.
   */
  duplicateSets(): {
    albumArtist: string;
    album: string;
    title: string;
    files: { trackId: number; path: string; sizeBytes: number; holders: string[] }[];
  }[] {
    const rows = this.db
      .prepare(
        `SELECT t.album_artist, t.album_title, t.title, t.norm_album, t.norm_title,
                t.id, t.path, t.size, t.duration_s, t.track_no
           FROM tracks t
          WHERE t.norm_album != '' AND t.norm_title != ''
          GROUP BY t.id
          ORDER BY t.album_artist, t.norm_album, t.norm_title, t.size DESC`,
      )
      .all() as {
      album_artist: string;
      album_title: string;
      title: string;
      norm_album: string;
      norm_title: string;
      id: number;
      path: string;
      size: number;
      duration_s: number | null;
      track_no: number | null;
    }[];

    /*
     * Two tiers, because the same recording is often filed under two titles:
     * "Walk On Water" from one rip and "Walk On Water (Feat. Beyonce)" from
     * another.
     *
     * The second tier is where this gets dangerous, and the guard is chosen
     * from evidence rather than instinct. Duration alone is NOT enough — an
     * instrumental runs exactly as long as the vocal, and a first attempt
     * using it proposed deleting "Faded (Instrumental)" as a copy of "Faded",
     * one remix as a copy of another, and a live take as a copy of the studio
     * cut. What actually separates a second RIP from a second VERSION is the
     * track number: two rips of one album agree on it, while an alternate
     * take is a different track on the record. So a bare-title pairing needs
     * the same track number AND a duration that agrees, and every one of
     * those false pairs disagreed on the number.
     */
    // Stripped from the RAW title, then normalised — norm() has already
    // eaten the brackets, so "walk on water (feat. beyonce)" arrives as
    // "walk on water feat beyonce" with nothing left to cut.
    const bare = (t: string) => norm(t.replace(/[([].*$/, ''));
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const album = `${r.album_artist}|${r.norm_album}`;
      const exact = `${album}|${r.norm_title}`;
      // Join an existing group whose bare title matches AND whose recording
      // agrees; otherwise stand alone under the exact key.
      let key = exact;
      for (const [k, list] of groups) {
        if (!k.startsWith(album + '|')) continue;
        const other = list[0]!;
        if (!bare(r.title) || bare(other.title) !== bare(r.title)) continue;
        const samePosition =
          r.track_no != null && other.track_no != null && r.track_no === other.track_no;
        const sameLength =
          r.duration_s == null || other.duration_s == null
            ? true
            : Math.abs(r.duration_s - other.duration_s) <= 3;
        if (samePosition && sameLength) {
          key = k;
          break;
        }
      }
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }

    const out: ReturnType<UserLibrary['duplicateSets']> = [];
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      out.push({
        albumArtist: list[0]!.album_artist,
        album: list[0]!.album_title,
        title: list[0]!.title,
        files: list.map((r) => ({
          trackId: r.id,
          path: r.path,
          sizeBytes: r.size,
          holders: this.holders(r.id),
        })),
      });
    }
    return out;
  }

  /**
   * Move every library, play and playlist reference from one track to another.
   *
   * Deleting a duplicate must not cost somebody the song. If the copy being
   * removed is in a library and the keeper is not, the reference moves rather
   * than dying with the file — INSERT OR IGNORE first so a user holding BOTH
   * copies ends up holding one, not violating a primary key.
   */
  transferReferences(fromId: number, toId: number): void {
    const run = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO user_tracks (user_id, track_id, added_at, source, favorite, rating)
             SELECT user_id, ?, added_at, source, favorite, rating FROM user_tracks WHERE track_id = ?`,
        )
        .run(toId, fromId);
      this.db.prepare('DELETE FROM user_tracks WHERE track_id = ?').run(fromId);

      this.db
        .prepare(
          `INSERT OR IGNORE INTO plays (user_id, track_id, plays, skips, first_played, last_played)
             SELECT user_id, ?, plays, skips, first_played, last_played FROM plays WHERE track_id = ?`,
        )
        .run(toId, fromId);
      this.db.prepare('DELETE FROM plays WHERE track_id = ?').run(fromId);

      this.db
        .prepare(
          `INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, added_at)
             SELECT playlist_id, ?, position, added_at FROM playlist_tracks WHERE track_id = ?`,
        )
        .run(toId, fromId);
      this.db.prepare('DELETE FROM playlist_tracks WHERE track_id = ?').run(fromId);
    });
    run();
  }

  /** How many people hold each track, so a UI can warn before an admin purges one. */
  holders(trackId: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT u.username FROM user_tracks ut JOIN users u ON u.id = ut.user_id
          WHERE ut.track_id = ? ORDER BY u.username`,
      )
      .all(trackId) as { username: string }[];
    return rows.map((r) => r.username);
  }
}

interface RawTrack {
  id: number;
  path: string;
  artist_name: string;
  album_title: string;
  album_artist_name?: string;
  title: string;
  track_no: number | null;
  duration_s: number | null;
  size: number;
  year?: number | null;
}

function toPool(r: RawTrack): PoolTrack {
  return {
    // 0 is the scanner's "looked, none there" marker; the API says null either way.
    year: r.year && r.year > 0 ? r.year : null,
    // Falls back to the credit for the few queries that do not select it, which is what it
    // held before the two were separated.
    albumArtistName: r.album_artist_name || r.artist_name,
    trackId: r.id,
    path: r.path,
    artistName: r.artist_name,
    albumTitle: r.album_title,
    title: r.title,
    trackNo: r.track_no,
    durationS: r.duration_s,
    sizeBytes: r.size,
  };
}
