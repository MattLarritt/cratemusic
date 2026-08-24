/**
 * What crate actually owns, recorded by crate.
 *
 * Lidarr used to answer this, and it answered it badly: it attaches an artist's
 * whole discography as metadata rows and gives every one an id, so "is this in the
 * library" came out true for albums that were not on disk. Rage Against the
 * Machine read as four albums held when one was, and the Request button was greyed
 * out on the three that were missing.
 *
 * Identity comes from the audio TAGS, not from folder names. That is not
 * fastidiousness: the pre-existing library here is flat — Music/ABBA/*.flac with no
 * album directory — so an earlier folder-based version of this file invented one
 * album per artist and reported ABBA's "Ring Ring" as not held while its eleven
 * files sat on disk. A request service that does not know what it owns re-downloads
 * it, which costs metered Usenet allowance.
 *
 * Tags also occasionally carry MUSICBRAINZ_ALBUMID, which upgrades a name match to
 * an exact one for free.
 */

import type Database from 'better-sqlite3';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFile } from 'music-metadata';
import { norm } from './release.js';

const AUDIO = /\.(flac|mp3|m4a|ogg|opus|wav|aac|alac|ape)$/i;
/** Deep enough for Artist/Album/Disc, shallow enough not to wander a whole NAS. */
const MAX_DEPTH = 4;

/**
 * Generation of the tag reader. Bump this whenever readTags starts extracting something new
 * from the same bytes, and rows written by an older generation are re-read once.
 *
 *   1  split the performer from the album artist, which earlier rows had collapsed
 *   2  album identity keeps its edition, so norm_album has to be recomputed
 *   3  the file's own genre tags, so a track can carry a vibe its artist page doesn't
 */
const TAG_VERSION = 3;

export interface Held {
  mbid: string | null;
  artistName: string;
  albumTitle: string;
  path: string;
  trackFiles: number;
}

interface Tags {
  /** Who PERFORMED this track. What the songs list shows and what search matches. */
  artistName: string;
  /**
   * Which artist the ALBUM belongs to — the shelf it lives on.
   *
   * Separate from artistName because collapsing them lost the performer: readTags used to
   * return `albumartist || artist` as one value and feed it to both, so every track of a
   * compilation was credited to "Various Artists" and searching the performer found nothing.
   * This field keeps the old value exactly, so nothing that groups albums is re-keyed.
   */
  albumArtistName: string;
  albumTitle: string;
  albumMbid: string | null;
  year: number | null;
  /**
   * The compilation flag — TCMP in ID3, `cpil` in MP4, COMPILATION in Vorbis.
   *
   * The one signal that says "this record is by many people" outright, and crate ignored it.
   * Without it a various-artists album with no albumartist tag has to be guessed at from the
   * shape of its credits, which is what reconcileAlbumArtists now does as a fallback.
   */
  compilation: boolean;
  /**
   * The track's OWN genres, from the file's genre tag — normalised, lowercase, deduped.
   *
   * Per-track, not per-artist, which is the whole point: artist_genres says what Last.fm
   * thinks of the artist as a whole, and files it under nu metal even when this particular
   * track is a folk ballad. The tag on the file is the only place that knows the difference.
   */
  genres: string[];
}

/**
 * One tag value like "Contemporary R&B/Indie Pop/Pop/Pop Soul" is four genres wearing one
 * coat. Split on the separators taggers actually use, lowercase, trim, dedupe — and cap it,
 * because a tag listing twelve genres is describing the tagger, not the track.
 */
function normGenres(raw: string[] | undefined): string[] {
  const out: string[] = [];
  for (const entry of raw ?? []) {
    // Both slashes: the library really holds "Contemporary R&B/Indie Pop" AND "Rap\Hip-Hop".
    for (const part of entry.split(/[/\\;,|]/)) {
      const g = part.trim().toLowerCase();
      if (g && g.length <= 48 && !out.includes(g)) out.push(g);
    }
  }
  return out.slice(0, 8);
}

/** What a compilation's album artist is called when the tags do not name one. */
const VARIOUS = 'Various Artists';

export class Library {
  constructor(private db: Database.Database) {}

  /** Record an album crate imported, where the MusicBrainz id is known exactly. */
  record(e: {
    mbid: string;
    artistName: string;
    albumTitle: string;
    path: string;
    trackFiles: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO library
           (norm_key, mbid, artist_name, album_title, norm_artist, path, track_files, added_at)
         VALUES (?,?,?,?,?,?,?,unixepoch())
         ON CONFLICT(norm_key) DO UPDATE SET
           mbid = COALESCE(excluded.mbid, library.mbid),
           path = excluded.path,
           track_files = excluded.track_files`,
      )
      .run(
        key(e.artistName, e.albumTitle),
        e.mbid,
        e.artistName,
        e.albumTitle,
        norm(e.artistName),
        e.path,
        e.trackFiles,
      );
  }

  /**
   * Walk the music root and rebuild the index from the files' own tags.
   *
   * Two levels of result, because two different questions get asked. `tracks` is the
   * pool — every file on disk, which is what a per-user library is assembled from and
   * what makes "somebody already downloaded this" answerable instantly. `library` is the
   * album rollup, which is what the artist page and the held flags need.
   *
   * Grouping is by tagged album artist and album, so a flat Artist/track layout and a
   * nested Artist/Album/track layout produce the same answer — the pre-existing library
   * here is flat, and an earlier folder-based version of this got it wrong.
   *
   * Reading tags means opening every file, so a row is reused unless its size or mtime
   * changed.
   */
  async scan(musicRoot: string): Promise<{ albums: number; tracks: number; parsed: number }> {
    const files = await this.walk(musicRoot, 0);
    let parsed = 0;

    const upsertTrack = this.db.prepare(
      `INSERT INTO tracks
         (path, size, mtime, artist_name, album_title, title,
          norm_artist, norm_album, norm_title, track_no, duration_s, album_mbid, year,
          album_artist, album_artist_name, canon_album, genres, tags_v, first_seen)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch())
       ON CONFLICT(path) DO UPDATE SET
         size = excluded.size, mtime = excluded.mtime,
         artist_name = excluded.artist_name, album_title = excluded.album_title,
         title = excluded.title, norm_artist = excluded.norm_artist,
         norm_album = excluded.norm_album, norm_title = excluded.norm_title,
         track_no = excluded.track_no, duration_s = excluded.duration_s,
         album_mbid = COALESCE(excluded.album_mbid, tracks.album_mbid),
         -- Written straight from the albumartist tag now, rather than left blank for
         -- reconcileAlbumArtists to guess at. Same VALUE as before the split, because
         -- albumArtistName is byte-for-byte what artistName used to be.
         album_artist = excluded.album_artist,
         album_artist_name = excluded.album_artist_name,
         canon_album = excluded.canon_album,
         genres = excluded.genres,
         tags_v = excluded.tags_v,
         -- Three-way, and the trailing 0 matters. NULLIF unwraps the sentinel so a re-parse
         -- that found no year does not wipe one an earlier scan managed to read; the final 0
         -- records "checked, none there" when there was no earlier year either. Without it a
         -- backfilled row with no year tag stays NULL and is re-parsed on every future scan.
         year = COALESCE(NULLIF(excluded.year, 0), tracks.year, 0)`,
    );

    const existing = new Map(
      (
        this.db.prepare('SELECT path, size, mtime FROM tracks').all() as {
          path: string;
          size: number;
          mtime: number;
        }[]
      ).map((r) => [r.path, r]),
    );

    const seenPaths: string[] = [];
    const groups = new Map<
      string,
      { artistName: string; albumTitle: string; mbid: string | null; path: string; count: number }
    >();

    for (const f of files) {
      let info: { size: number; mtimeMs: number };
      try {
        info = await stat(f.path);
      } catch {
        continue;
      }
      const mtime = Math.round(info.mtimeMs);
      seenPaths.push(f.path);

      const known = existing.get(f.path);
      let tags: Tags & { title: string; trackNo: number | null; durationS: number | null };

      const cached =
        known && known.size === info.size && known.mtime === mtime
          ? (this.db
              .prepare(
                'SELECT artist_name, album_title, title, track_no, duration_s, album_mbid, year, album_artist, album_artist_name, genres, tags_v FROM tracks WHERE path = ?',
              )
              .get(f.path) as {
              artist_name: string;
              album_title: string;
              title: string;
              track_no: number | null;
              duration_s: number | null;
              album_mbid: string | null;
              year: number | null;
              album_artist: string;
              album_artist_name: string;
              genres: string;
              tags_v: number;
            })
          : null;

      /*
       * Reuse the row only if it holds everything we now want from it.
       *
       * A null year on an unchanged file means the row predates the year column, not that the
       * file has no year tag — the two are indistinguishable from the row alone. Re-parsing
       * those once backfills the whole library over a single scan and costs nothing after,
       * which beats both a full reindex and a year that stays permanently blank on anything
       * imported before today.
       */
      if (cached && cached.year !== null && cached.tags_v >= TAG_VERSION) {
        tags = {
          artistName: cached.artist_name,
          albumArtistName: cached.album_artist_name,
          // Already reflected in album_artist_name, so the flag itself is not needed again.
          compilation: false,
          albumTitle: cached.album_title,
          albumMbid: cached.album_mbid,
          title: cached.title,
          trackNo: cached.track_no,
          durationS: cached.duration_s,
          year: cached.year,
          genres: cached.genres ? cached.genres.split(', ') : [],
        };
      } else {
        tags = await readTags(f.path, f.fallbackAlbum, f.fallbackArtist);
        parsed++;
        upsertTrack.run(
          f.path,
          info.size,
          mtime,
          tags.artistName,
          tags.albumTitle,
          tags.title,
          norm(tags.artistName),
          albumIdentity(tags.albumTitle),
          norm(tags.title),
          tags.trackNo,
          tags.durationS,
          tags.albumMbid,
          // 0, not null: see the year column's note in schema.ts. Null means "never looked",
          // and writing it for a file with no year tag would re-parse that file on every
          // future scan forever.
          tags.year ?? 0,
          norm(tags.albumArtistName),
          tags.albumArtistName,
          canonAlbum(tags.albumTitle),
          tags.genres.join(', '),
          TAG_VERSION,
        );
      }

      // The rollup is a shelf, so it groups on the album artist. Using the performer here
      // would split a compilation into one library row per guest.
      if (!tags.albumArtistName || !tags.albumTitle) continue;
      const k = key(tags.albumArtistName, tags.albumTitle);
      const g = groups.get(k);
      if (g) {
        g.count++;
        if (!g.mbid && tags.albumMbid) g.mbid = tags.albumMbid;
      } else {
        groups.set(k, {
          artistName: tags.albumArtistName,
          albumTitle: tags.albumTitle,
          mbid: tags.albumMbid,
          path: f.dir,
          count: 1,
        });
      }
    }

    const upsert = this.db.prepare(
      `INSERT INTO library
         (norm_key, mbid, artist_name, album_title, norm_artist, path, track_files, added_at)
       VALUES (?,?,?,?,?,?,?,unixepoch())
       ON CONFLICT(norm_key) DO UPDATE SET
         -- A scan must never discard an mbid an import established.
         mbid = COALESCE(library.mbid, excluded.mbid),
         artist_name = excluded.artist_name,
         album_title = excluded.album_title,
         norm_artist = excluded.norm_artist,
         path = excluded.path,
         track_files = excluded.track_files`,
    );

    let trackCount = 0;
    const keys: string[] = [];
    for (const [k, g] of groups) {
      upsert.run(k, g.mbid, g.artistName, g.albumTitle, norm(g.artistName), g.path, g.count);
      keys.push(k);
      trackCount += g.count;
    }

    // Forget what is gone, so a deleted album stops claiming to be held. Skipped when
    // the scan found nothing at all, since an unmounted share must not be mistaken for
    // an empty library.
    if (seenPaths.length) {
      const tq = seenPaths.map(() => '?').join(',');
      // user_tracks rows for vanished files go too, or somebody's library would point at
      // nothing. The track row is the only handle on them.
      // Everything keyed on a track has to go with it, or a library entry, a play count or
      // a playlist row would point at a file that no longer exists.
      for (const table of ['user_tracks', 'plays', 'playlist_tracks']) {
        this.db
          .prepare(
            `DELETE FROM ${table} WHERE track_id IN
               (SELECT id FROM tracks WHERE path NOT IN (${tq}))`,
          )
          .run(...seenPaths);
      }
      this.db.prepare(`DELETE FROM tracks WHERE path NOT IN (${tq})`).run(...seenPaths);
    }
    if (keys.length) {
      const q = keys.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM library WHERE norm_key NOT IN (${q})`).run(...keys);
    }

    this.reconcileAlbumArtists();

    return { albums: groups.size, tracks: trackCount, parsed };
  }

  /**
   * Index one directory into the pool and return its tracks.
   *
   * Used right after an import. A full scan would also work but walks the whole share on
   * a CIFS mount to learn about eleven files that just landed, and the import path is
   * exactly where latency is visible to somebody watching a progress bar.
   */
  /**
   * Re-unite albums split apart by featured-artist tags.
   *
   * An album's identity is `normalised artist | normalised album`, and a file
   * with no albumartist tag falls back to its `artist` — which on a
   * collaboration reads "Eminem, Beyoncé". That is a different artist key, so
   * it becomes a different album, and Revival appeared seven times: once for
   * the twenty solo tracks and once per guest.
   *
   * The fix acts only where there is an actual CONFLICT. Within one album
   * title, the artist key holding the most tracks is taken as the album's
   * artist, and any other key that is that key plus more words is folded into
   * it. Nothing is stripped speculatively, which is what keeps a genuine duo
   * safe: "Danger Mouse & Black Thought" is only ever rewritten if that same
   * album ALSO has tracks credited to "Danger Mouse" alone — and in that case
   * they belong together anyway.
   *
   * The track's own artist_name is left alone. What it is CREDITED to is a
   * fact about the recording; what album it belongs to is a fact about the
   * shelf, and only the second one is being corrected here.
   */
  reconcileAlbumArtists(): number {
    /*
     * Only albums whose artist was NOT stated by the tags.
     *
     * album_artist is written straight from the albumartist tag now, so when it differs from
     * norm_artist the file said outright which artist the album belongs to — and guessing
     * over the top of that is how a compilation tagged "Various Artists" would get re-filed
     * under whichever performer happened to hold the most tracks. Where the two agree,
     * nothing was stated and the prefix rule below is the best available answer.
     */
    const rows = this.db
      .prepare(
        `SELECT norm_album, norm_artist, COUNT(*) AS n, MIN(album_artist_name) AS display
           FROM tracks
          WHERE norm_album != '' AND norm_artist != '' AND album_artist = norm_artist
          GROUP BY norm_album, norm_artist`,
      )
      .all() as { norm_album: string; norm_artist: string; n: number; display: string }[];

    const byAlbum = new Map<string, { norm_artist: string; n: number; display: string }[]>();
    for (const r of rows) {
      const list = byAlbum.get(r.norm_album) ?? [];
      list.push({ norm_artist: r.norm_artist, n: r.n, display: r.display });
      byAlbum.set(r.norm_album, list);
    }

    /*
     * Both halves of the album artist move together.
     *
     * album_artist is the key and album_artist_name is what gets displayed and linked with.
     * Updating only the key left them disagreeing after a fold — Skrillex's album keyed on
     * "skrillex" while two of its rows still read "Skrillex & Penny", which put the album
     * back into three on the Subsonic surface and made the album tile's link correct only by
     * the luck of MIN() picking the shortest credit.
     *
     * The album_artist = norm_artist condition matches the SELECT: without it a row whose
     * album artist WAS stated could be overwritten, because it shares a norm_artist with an
     * untagged one.
     */
    const fix = this.db.prepare(
      `UPDATE tracks SET album_artist = ?, album_artist_name = ?
        WHERE norm_album = ? AND norm_artist = ? AND album_artist = norm_artist`,
    );
    let moved = 0;
    const run = this.db.transaction(() => {
      for (const [album, list] of byAlbum) {
        /*
         * Every album is processed, not just the conflicted ones.
         *
         * Skipping single-artist albums here left their rows at the column's '' default, and
         * since poolForAlbum keys on album_artist those tracks vanished from the album page.
         * It stayed hidden because the migration that added the column backfilled every row
         * that existed then — so only music indexed AFTER it was affected, a few tracks at a
         * time. Kanye's album showed 13 of 20 and nothing anywhere said why.
         */
        const sorted = [...list].sort((a, b) => b.n - a.n || a.norm_artist.length - b.norm_artist.length);
        const main = sorted[0]!;

        /*
         * An album whose tags never named its artist falls into one of three shapes, and the
         * prefix rule alone only ever handled the first.
         *
         *   "Eminem" + "Eminem, Beyoncé"          a guest folded into the credit
         *   Elton John ×9 + seven guests ×1       HIS album, guests on most tracks
         *   four acts, a track each               a genuine various-artists compilation
         *
         * The second is what filed The Lockdown Sessions as eight albums: none of those guest
         * credits is a prefix of "elton john", so nothing folded them, and each became its own
         * record. It is not a compilation either — nine of its sixteen tracks are his, and
         * calling it Various Artists would be just as wrong in the other direction.
         *
         * So: a DOMINANT credit takes the album. Absent one, three or more unrelated credits
         * mean nobody owns it and it is Various Artists. Three rather than two because two is
         * far more often a duo or a feature than a compilation.
         */
        const total = sorted.reduce((n, a) => n + a.n, 0);
        const unrelated = sorted.filter((a) => !a.norm_artist.startsWith(main.norm_artist + ' '));
        const dominant = main.n > 1 && main.n * 2 > total;

        if (!dominant && unrelated.length >= 3) {
          for (const a of sorted) {
            fix.run(norm(VARIOUS), VARIOUS, album, a.norm_artist);
            moved += a.n;
          }
          continue;
        }

        for (const stray of sorted.slice(1)) {
          // A prefix stray always folds. An unrelated one folds only behind a dominant
          // credit — otherwise a two-artist split album would be handed to whichever side
          // happened to have one more track on it.
          if (!dominant && !stray.norm_artist.startsWith(main.norm_artist + ' ')) continue;
          fix.run(main.norm_artist, main.display, album, stray.norm_artist);
          moved += stray.n;
        }
        // The main key names itself, so every row in the album has one.
        fix.run(main.norm_artist, main.display, album, main.norm_artist);
      }
    });
    run();
    return moved;
  }

  /**
   * Overwrite one indexed row with metadata a person confirmed.
   *
   * Exists for uploads, where the files' own tags may be wrong or missing and
   * the uploader has just stated the truth. The scanner skips unchanged files
   * by size and mtime, so a correction written here holds across rescans
   * without rewriting the audio. If the FILE later changes, its tags win
   * again — which is right, because a changed file is new information.
   */
  overrideTrack(
    path: string,
    meta: {
      artistName: string;
      albumTitle: string;
      title: string;
      trackNo: number;
      albumMbid: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE tracks SET
           artist_name = ?, album_title = ?, title = ?, track_no = ?,
           norm_artist = ?, norm_album = ?, norm_title = ?,
           album_artist = ?, album_artist_name = ?, canon_album = ?,
           album_mbid = COALESCE(?, album_mbid)
         WHERE path = ?`,
      )
      .run(
        meta.artistName,
        meta.albumTitle,
        meta.title,
        meta.trackNo,
        norm(meta.artistName),
        albumIdentity(meta.albumTitle),
        norm(meta.title),
        /*
         * The ALBUM columns have to move too, and forgetting them was a real bug.
         *
         * A confirmation is the strongest statement there is about a file, but these three
         * were left holding whatever the tags said at index time. Uploading a track ripped
         * from a various-artists compilation — albumartist "Various Artists", album "2000s
         * Best of by uDiscover" — and confirming it as Afroman's The Good Times produced a
         * row whose artist and title were right and whose album KEY still said Various
         * Artists. The album page keys on that pair, so it found nothing and reported the
         * track as not in the library, while the track sat there plainly owned.
         *
         * reconcileAlbumArtists could not repair it either: its guard skips rows whose album
         * artist differs from the credit, on the grounds that the tags stated one — which is
         * exactly the state this left behind.
         */
        norm(meta.artistName),
        meta.artistName,
        canonAlbum(meta.albumTitle),
        meta.albumMbid,
        path,
      );
  }

  /**
   * Index EXACTLY these files, touching nothing else.
   *
   * Exists because finalize used to call indexDir on the album folder, which
   * re-read every EXISTING file's embedded tags and clobbered metadata a
   * person had already confirmed — merging a second copy of Starboy into the
   * album reverted the first copy's rows to whatever the audio's tags said.
   * An additive operation must only write rows for what it added.
   */
  async indexFiles(paths: string[]): Promise<{ id: number; path: string; title: string }[]> {
    const out: { id: number; path: string; title: string }[] = [];
    for (const path of paths) {
      let info;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      const tags = await readTags(path, '', '');
      this.db
        .prepare(
          `INSERT INTO tracks
             (path, size, mtime, artist_name, album_title, title,
              norm_artist, norm_album, norm_title, track_no, duration_s, album_mbid,
              year, album_artist, album_artist_name, canon_album, genres, tags_v, first_seen)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch())
           ON CONFLICT(path) DO UPDATE SET
             size = excluded.size, mtime = excluded.mtime,
             artist_name = excluded.artist_name, album_title = excluded.album_title,
             title = excluded.title, norm_artist = excluded.norm_artist,
             norm_album = excluded.norm_album, norm_title = excluded.norm_title,
             track_no = excluded.track_no, duration_s = excluded.duration_s,
             album_mbid = COALESCE(excluded.album_mbid, tracks.album_mbid),
             year = COALESCE(NULLIF(excluded.year, 0), tracks.year, 0),
             album_artist = excluded.album_artist,
             album_artist_name = excluded.album_artist_name,
             canon_album = excluded.canon_album,
             genres = excluded.genres,
             tags_v = excluded.tags_v`,
        )
        .run(
          path,
          info.size,
          Math.round(info.mtimeMs),
          tags.artistName,
          tags.albumTitle,
          tags.title,
          norm(tags.artistName),
          albumIdentity(tags.albumTitle),
          norm(tags.title),
          tags.trackNo,
          tags.durationS,
          tags.albumMbid,
          tags.year ?? 0,
          norm(tags.albumArtistName),
          tags.albumArtistName,
          canonAlbum(tags.albumTitle),
          tags.genres.join(', '),
          TAG_VERSION,
        );
      const row = this.db.prepare('SELECT id FROM tracks WHERE path = ?').get(path) as
        | { id: number }
        | undefined;
      if (row) out.push({ id: row.id, path, title: tags.title });
    }
    // New rows arrive with no album_artist; reconciling here means an upload
    // or adoption groups correctly at once rather than after the next scan.
    this.reconcileAlbumArtists();
    return out;
  }

  async indexDir(dir: string): Promise<{ id: number; path: string; title: string }[]> {
    const files = await this.walk(dir, 0);
    const out: { id: number; path: string; title: string }[] = [];

    for (const f of files) {
      let info;
      try {
        info = await stat(f.path);
      } catch {
        continue;
      }
      const tags = await readTags(f.path, f.fallbackAlbum, f.fallbackArtist);
      this.db
        .prepare(
          `INSERT INTO tracks
             (path, size, mtime, artist_name, album_title, title,
              norm_artist, norm_album, norm_title, track_no, duration_s, album_mbid,
              year, album_artist, album_artist_name, canon_album, genres, tags_v, first_seen)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch())
           ON CONFLICT(path) DO UPDATE SET
             size = excluded.size, mtime = excluded.mtime,
             artist_name = excluded.artist_name, album_title = excluded.album_title,
             title = excluded.title, norm_artist = excluded.norm_artist,
             norm_album = excluded.norm_album, norm_title = excluded.norm_title,
             track_no = excluded.track_no, duration_s = excluded.duration_s,
             album_mbid = COALESCE(excluded.album_mbid, tracks.album_mbid),
             year = COALESCE(NULLIF(excluded.year, 0), tracks.year, 0),
             album_artist = excluded.album_artist,
             album_artist_name = excluded.album_artist_name,
             canon_album = excluded.canon_album,
             genres = excluded.genres,
             tags_v = excluded.tags_v`,
        )
        .run(
          f.path,
          info.size,
          Math.round(info.mtimeMs),
          tags.artistName,
          tags.albumTitle,
          tags.title,
          norm(tags.artistName),
          albumIdentity(tags.albumTitle),
          norm(tags.title),
          tags.trackNo,
          tags.durationS,
          tags.albumMbid,
          tags.year ?? 0,
          norm(tags.albumArtistName),
          tags.albumArtistName,
          canonAlbum(tags.albumTitle),
          tags.genres.join(', '),
          TAG_VERSION,
        );
      const row = this.db.prepare('SELECT id FROM tracks WHERE path = ?').get(f.path) as
        | { id: number }
        | undefined;
      if (row) out.push({ id: row.id, path: f.path, title: tags.title });
    }
    this.reconcileAlbumArtists();
    return out;
  }

  private async walk(
    dir: string,
    depth: number,
    fallbackArtist = '',
  ): Promise<{ path: string; dir: string; fallbackArtist: string; fallbackAlbum: string }[]> {
    if (depth > MAX_DEPTH) return [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: { path: string; dir: string; fallbackArtist: string; fallbackAlbum: string }[] = [];
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        // The first level under the root is the artist by convention, which is the only
        // thing used if a file turns out to have no usable tags at all.
        out.push(...(await this.walk(p, depth + 1, depth === 0 ? e.name : fallbackArtist)));
      } else if (e.isFile() && AUDIO.test(e.name)) {
        out.push({
          path: p,
          dir,
          fallbackArtist,
          fallbackAlbum: dir === '' ? '' : (dir.split('/').pop() ?? ''),
        });
      }
    }
    return out;
  }

  /** Exact match on the MusicBrainz id, for albums crate imported itself. */
  byMbid(mbid: string): Held | null {
    const row = this.db.prepare('SELECT * FROM library WHERE mbid = ?').get(mbid) as
      | RawRow
      | undefined;
    return row ? toHeld(row) : null;
  }

  /** Name match, for music that was on disk before crate existed. */
  byName(artistName: string, albumTitle: string): Held | null {
    const row = this.db.prepare('SELECT * FROM library WHERE norm_key = ?').get(
      key(artistName, albumTitle),
    ) as RawRow | undefined;
    return row ? toHeld(row) : null;
  }

  /**
   * Every album with its files on disk, for the admin library pane.
   *
   * Reads the directory rather than trusting the stored count, because the pane's whole
   * job is to let somebody act on what is actually there.
   */
  async albumsWithFiles(): Promise<
    {
      normKey: string;
      mbid: string | null;
      artistName: string;
      albumTitle: string;
      path: string;
      files: { name: string; sizeBytes: number }[];
      /** True when the folder holds other albums too, so a delete must be per file. */
      sharedFolder: boolean;
    }[]
  > {
    const rows = this.db
      .prepare('SELECT * FROM library WHERE track_files > 0 ORDER BY artist_name, album_title')
      .all() as (RawRow & { norm_key: string })[];

    // How many library rows point at each directory. More than one means a flat layout
    // where several albums share an artist folder.
    const perDir = new Map<string, number>();
    for (const r of rows) perDir.set(r.path, (perDir.get(r.path) ?? 0) + 1);

    const out = [];
    for (const r of rows) {
      const wanted = new Set(
        (
          this.db
            .prepare('SELECT path FROM tracks WHERE artist_name = ? AND album_title = ?')
            .all(r.artist_name, r.album_title) as { path: string }[]
        ).map((t) => t.path),
      );

      let files: { name: string; sizeBytes: number }[] = [];
      try {
        const entries = await readdir(r.path, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isFile() || !AUDIO.test(e.name)) continue;
          const full = join(r.path, e.name);
          // In a shared folder only this album's tagged files belong to this row.
          if (wanted.size && !wanted.has(full)) continue;
          const st = await stat(full).catch(() => null);
          files.push({ name: e.name, sizeBytes: st?.size ?? 0 });
        }
      } catch {
        files = [];
      }

      out.push({
        normKey: r.norm_key,
        mbid: r.mbid,
        artistName: r.artist_name,
        albumTitle: r.album_title,
        path: r.path,
        files: files.sort((a, b) => a.name.localeCompare(b.name)),
        sharedFolder: (perDir.get(r.path) ?? 1) > 1,
      });
    }
    return out;
  }

  byKey(normKey: string): (Held & { normKey: string }) | null {
    const row = this.db.prepare('SELECT * FROM library WHERE norm_key = ?').get(normKey) as
      | (RawRow & { norm_key: string })
      | undefined;
    return row ? { ...toHeld(row), normKey: row.norm_key } : null;
  }

  forget(normKey: string): void {
    this.db.prepare('DELETE FROM library WHERE norm_key = ?').run(normKey);
  }

  /**
   * Drop pool rows for files that no longer exist.
   *
   * The user_tracks rows go with them: a per-user library entry whose file is gone would
   * point at nothing, and the track row is the only handle on it.
   */
  forgetTags(paths: string[]): void {
    if (!paths.length) return;
    const q = paths.map(() => '?').join(',');
    for (const table of ['user_tracks', 'plays', 'playlist_tracks']) {
      this.db
        .prepare(
          `DELETE FROM ${table} WHERE track_id IN (SELECT id FROM tracks WHERE path IN (${q}))`,
        )
        .run(...paths);
    }
    this.db.prepare(`DELETE FROM tracks WHERE path IN (${q})`).run(...paths);
  }

  /** Either identity, preferring the exact one. */
  held(mbid: string, artistName: string, albumTitle: string): Held | null {
    return this.byMbid(mbid) ?? this.byName(artistName, albumTitle);
  }

  /**
   * Artists with at least one album on disk, most tracks first.
   *
   * Grouped by the normalised name, because tags and metadata disagree on case —
   * the files say "System Of A Down" and MusicBrainz says "System of a Down".
   * Grouping on the raw string would list the same artist twice.
   */
  artists(limit = 60): { name: string; trackFiles: number; albums: number }[] {
    return this.db
      .prepare(
        `SELECT MIN(artist_name) AS name, SUM(track_files) AS trackFiles, COUNT(*) AS albums
           FROM library
          WHERE track_files > 0
          GROUP BY norm_artist
          ORDER BY trackFiles DESC
          LIMIT ?`,
      )
      .all(limit) as { name: string; trackFiles: number; albums: number }[];
  }

  /**
   * Every held album for one artist, for the artist page's held count.
   *
   * Matched on the normalised name for the same reason: "Rage Against The Machine"
   * in the tags against "Rage Against the Machine" from MusicBrainz would otherwise
   * return nothing and report zero albums held.
   */
  albumsFor(artistName: string): Held[] {
    const rows = this.db
      .prepare('SELECT * FROM library WHERE norm_artist = ? AND track_files > 0')
      .all(norm(artistName)) as RawRow[];
    return rows.map(toHeld);
  }
}

interface RawRow {
  mbid: string | null;
  artist_name: string;
  album_title: string;
  path: string;
  track_files: number;
}

/**
 * Tags for one file, falling back to the folder when they are missing.
 *
 * albumartist is preferred over artist so a compilation groups as one album rather
 * than splitting into one album per featured performer.
 */
async function readTags(
  path: string,
  fallbackAlbum: string,
  fallbackArtist: string,
): Promise<Tags & { title: string; trackNo: number | null; durationS: number | null }> {
  try {
    const { common, format } = await parseFile(path, { duration: true });
    return {
      // artist FIRST here: this is the performer.
      artistName: common.artist || common.albumartist || fallbackArtist,
      /*
       * albumartist first here — byte-for-byte what artistName used to be, so album keys came
       * out identical when the performer was split off.
       *
       * The compilation flag is the exception: a flagged record with no albumartist tag is
       * many artists on one album, and taking the first track's performer as the album artist
       * is what filed those as one album per guest.
       */
      albumArtistName:
        common.albumartist ||
        (common.compilation ? VARIOUS : '') ||
        common.artist ||
        fallbackArtist,
      albumTitle: common.album || fallbackAlbum,
      albumMbid: (common.musicbrainz_releasegroupid as string | undefined) ?? null,
      // Falls back to the filename so a track with no title tag is still selectable
      // rather than invisible.
      title: common.title || path.split('/').pop()?.replace(/\.[^.]+$/, '') || '',
      trackNo: common.track?.no ?? null,
      durationS: format.duration ? Math.round(format.duration) : null,
      // originalyear before year: a 2015 remaster of a 1994 record tags the reissue date in
      // `year` and the real one in `originalyear`, and the year a listener means is 1994.
      year: sensibleYear(common.originalyear) ?? sensibleYear(common.year),
      compilation: common.compilation === true,
      genres: normGenres(common.genre),
    };
  } catch {
    // An unreadable header should not lose the file entirely.
    return {
      artistName: fallbackArtist,
      albumArtistName: fallbackArtist,
      albumTitle: fallbackAlbum,
      albumMbid: null,
      title: path.split('/').pop()?.replace(/\.[^.]+$/, '') || '',
      trackNo: null,
      durationS: null,
      year: null,
      genres: [],
      compilation: false,
    };
  }
}

/**
 * A year, or nothing. Tags carry 0, 1, and 9999 often enough that an unchecked value ends up
 * rendered on the page as "Released 0".
 */
function sensibleYear(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1877 || n > new Date().getFullYear() + 1) return null;
  return n;
}

function toHeld(r: RawRow): Held {
  return {
    mbid: r.mbid,
    artistName: r.artist_name,
    albumTitle: r.album_title,
    path: r.path,
    trackFiles: r.track_files,
  };
}

/**
 * Album titles as tagged and as MusicBrainz reports them are not the same string.
 *
 * The ABBA album on disk is tagged "Ring Ring (2022 Remastered)"; MusicBrainz calls
 * it "Ring Ring". An exact comparison said the album was not held while eleven of
 * its tracks sat on disk, which is an invitation to re-download it.
 *
 * So bracketed and parenthesised segments are dropped, and a trailing edition
 * suffix after a dash. This is applied to BOTH sides of every comparison, so a
 * title that legitimately contains brackets — "(What's the Story) Morning Glory?" —
 * still matches itself even though the canonical form is lossy. Consistency is what
 * matters here, not fidelity.
 */
export function canonAlbum(title: string): string {
  const withoutBrackets = title.replace(/[([][^)\]]*[)\]]/g, ' ');
  const withoutEdition = withoutBrackets.replace(
    /\s[-–—]\s.*\b(remaster(ed)?|deluxe|expanded|edition|reissue|anniversary|mono|stereo|version)\b.*$/i,
    ' ',
  );
  return norm(withoutEdition) || norm(title);
}

/**
 * What album this IS, locally. Keeps the edition; canonAlbum throws it away.
 *
 * The two exist because one function was doing two incompatible jobs. Stripping is right for
 * MATCHING a foreign title — a local "Rumours (2001 Remaster)" has to find MusicBrainz's
 * "Rumours" — and wrong for IDENTITY, because it made every edition the same record. Held
 * together that meant "Wish You Were Here" and "Wish You Were Here (2011 Remastered Version)"
 * were one album page with both rips interleaved, and worse, "Urban Flora" was merged with
 * "Urban Flora (Remixes)" — a different record entirely, not an edition of anything.
 *
 * So: identity keeps the edition, matching still strips it. Every local key uses this;
 * artsource.ts and musicimport.ts keep using canonAlbum to compare against remote titles.
 *
 * Deliberately just norm(): the whole title, punctuation folded. Anything cleverer would be
 * another rule about which suffixes "count", and that judgement is exactly what went wrong.
 */
export function albumIdentity(title: string): string {
  return norm(title);
}

/** The name-match key. Both halves normalised so punctuation cannot split a match. */
function key(artist: string, album: string): string {
  return `${norm(artist)}|${albumIdentity(album)}`;
}


