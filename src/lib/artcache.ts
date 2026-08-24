/**
 * Artwork, stored locally and fetched remotely only when it has to be.
 *
 * Every image crate shows used to be proxied from images.lidarr.audio on every page load.
 * That is a request per card per visitor, to somebody else's server, for a file that never
 * changes — and when it is slow or down, the front page looks broken. Now the first fetch
 * writes the bytes to disk and every later one is a local read.
 *
 * Resolution order, cheapest and most trustworthy first:
 *
 *   1. the local cache
 *   2. a cover image sitting beside the album's audio files
 *   3. artwork embedded in the audio itself — which is where most of it actually is: of
 *      eleven albums here, six carry embedded art and only one has a usable cover file
 *   4. the remote sources — Cover Art Archive and Deezer, see lib/artsource.ts
 *
 * Anything found at 2, 3 or 4 is written into the cache, so each of those paths is walked
 * once per album rather than once per page load.
 *
 * RETENTION. Every read stamps last_used_at, and the sweep deletes what has not been used
 * for the configured period — except anything PINNED, which is never deleted. Pinned means
 * the artist or album still exists in the pool on disk, which by definition covers
 * everything in anybody's library, since a library entry points at a file. So art for music
 * that is actually here survives indefinitely no matter how long since anyone looked at it,
 * and only art for things that have been browsed past and never returned to is reclaimed.
 */

import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { parseFile } from 'music-metadata';
import { albumIdentity } from './library.js';
import { norm } from './release.js';
import type { RemoteArt } from './artsource.js';
import type { Settings } from './settings.js';

/**
 * Cover filenames worth trusting, in order.
 *
 * Deliberately a whitelist. An earlier importer copied any .jpg or .png next to the audio,
 * which is how six crypto-donation QR codes ended up filed as album artwork — and a
 * "take the first image you find" rule would then serve one of them as the cover.
 */
const COVER_NAMES = [
  /^cover\.(jpe?g|png)$/i,
  /^folder\.(jpe?g|png)$/i,
  /^front\.(jpe?g|png)$/i,
  /^album\.(jpe?g|png)$/i,
  /^albumart.*\.(jpe?g|png)$/i,
];

export interface Art {
  body: Buffer;
  contentType: string;
  /** Where it came from, for the admin page and for debugging a wrong cover. */
  source: string;
}

export class ArtCache {
  /**
   * Resolutions already running, by cache key.
   *
   * A shelf renders the same artist on several tiles, and each tile asks for
   * its own artwork — without this, three tiles meant three identical remote
   * resolutions queued behind one another. Now they all await the same one.
   */
  private inflight = new Map<string, Promise<Art | null>>();

  constructor(
    private db: Database.Database,
    private dir: string,
    private settings: Settings,
    private log: FastifyBaseLogger,
    /** Remote lookup, injected so this module does not choose the art sources. */
    private remote: {
      albumImage: (artist: string, album: string) => Promise<RemoteArt | null>;
      /** By release-group id: direct, unqueued, and the fast path wherever an
       *  id is known. */
      albumImageByMbid: (mbid: string) => Promise<RemoteArt | null>;
      artistImage: (artist: string) => Promise<RemoteArt | null>;
    },
  ) {}

  private key(kind: 'album' | 'artist', artist: string, album?: string): string {
    // Identity, not the canonical form: a remaster is its own album and gets its own cover
    // entry. The remote LOOKUP still matches loosely — see artsource.ts — so it can find the
    // original release's art when the reissue has none of its own.
    return kind === 'album' ? `album:${norm(artist)}|${albumIdentity(album ?? '')}` : `artist:${norm(artist)}`;
  }

  private fileFor(key: string, contentType: string): string {
    const ext = contentType.includes('png') ? '.png' : '.jpg';
    return join(this.dir, createHash('sha1').update(key).digest('hex') + ext);
  }

  /** Serve from the cache, stamping last_used_at so the sweep can tell what is live. */
  private async fromCache(key: string): Promise<Art | null> {
    const row = this.db
      .prepare('SELECT path, content_type, source FROM art_cache WHERE k = ?')
      .get(key) as { path: string; content_type: string; source: string } | undefined;
    if (!row) return null;
    try {
      const body = await readFile(row.path);
      this.db.prepare('UPDATE art_cache SET last_used_at = unixepoch() WHERE k = ?').run(key);
      return { body, contentType: row.content_type, source: row.source };
    } catch {
      // The row outlived its file — treat as a miss and let the next fetch replace it.
      this.db.prepare('DELETE FROM art_cache WHERE k = ?').run(key);
      return null;
    }
  }

  private async store(key: string, body: Buffer, contentType: string, source: string): Promise<Art> {
    await mkdir(this.dir, { recursive: true });
    const path = this.fileFor(key, contentType);
    await writeFile(path, body);
    this.db
      .prepare(
        `INSERT INTO art_cache (k, path, content_type, bytes, source, fetched_at, last_used_at)
         VALUES (?,?,?,?,?,unixepoch(),unixepoch())
         ON CONFLICT(k) DO UPDATE SET
           path = excluded.path, content_type = excluded.content_type,
           bytes = excluded.bytes, source = excluded.source,
           fetched_at = unixepoch(), last_used_at = unixepoch()`,
      )
      .run(key, path, contentType, body.length, source);
    return { body, contentType, source };
  }

  /** A cover file beside the audio, if there is a trustworthy one. */
  private async coverFile(dir: string): Promise<Art | null> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return null;
    }
    for (const pattern of COVER_NAMES) {
      const hit = names.find((n) => pattern.test(n));
      if (!hit) continue;
      try {
        const body = await readFile(join(dir, hit));
        return {
          body,
          contentType: extname(hit).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg',
          source: `file:${hit}`,
        };
      } catch {
        /* try the next pattern */
      }
    }
    return null;
  }

  /** Artwork embedded in one of the album's files. Where most of it really is. */
  private async embedded(paths: string[]): Promise<Art | null> {
    for (const p of paths.slice(0, 3)) {
      try {
        const { common } = await parseFile(p, { duration: false });
        const pic = common.picture?.[0];
        if (pic?.data?.length) {
          return {
            body: Buffer.from(pic.data),
            contentType: pic.format || 'image/jpeg',
            source: 'embedded',
          };
        }
      } catch {
        /* next file */
      }
    }
    return null;
  }

  /**
   * Album art.
   *
   * `trackPaths` are the album's files on disk when it is held, which is what makes the
   * cover-file and embedded steps possible. Pass none for an album crate does not have and
   * it falls through to the remote lookup.
   */
  async album(
    artist: string,
    album: string,
    trackPaths: string[] = [],
    mbid?: string,
  ): Promise<Art | null> {
    const key = this.key('album', artist, album);
    const hit = await this.fromCache(key);
    if (hit) return hit;
    return this.shared(key, async () => {
      if (trackPaths.length) {
        const dir = trackPaths[0]?.replace(/\/[^/]+$/, '') ?? '';
        const file = dir ? await this.coverFile(dir) : null;
        if (file) return this.store(key, file.body, file.contentType, file.source);

        const emb = await this.embedded(trackPaths);
        if (emb) return this.store(key, emb.body, emb.contentType, emb.source);
      }

      // A known id skips the search entirely — see albumImageByMbid.
      if (mbid) {
        const direct = await this.remote.albumImageByMbid(mbid).catch(() => null);
        if (direct) return this.store(key, direct.body, direct.contentType, direct.source);
      }

      const found = await this.remote.albumImage(artist, album).catch(() => null);
      if (found) return this.store(key, found.body, found.contentType, found.source);
      return null;
    });
  }

  async artist(name: string): Promise<Art | null> {
    const key = this.key('artist', name);
    const hit = await this.fromCache(key);
    if (hit) return hit;
    return this.shared(key, async () => {
      const found = await this.remote.artistImage(name).catch(() => null);
      if (found) return this.store(key, found.body, found.contentType, found.source);
      return null;
    });
  }

  /** Run one resolution per key, however many callers are waiting on it. */
  private shared(key: string, resolve: () => Promise<Art | null>): Promise<Art | null> {
    const running = this.inflight.get(key);
    if (running) return running;
    const p = resolve().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /**
   * Delete cached art nobody has used for the configured period, except what is pinned.
   *
   * Pinned is computed rather than stored, so it stays true as the library changes: an
   * artist or album still present in the pool keeps its art indefinitely. A retention of 0
   * disables the sweep entirely, for somebody who would rather spend the disk.
   */
  /**
   * Drop one album's cached art, so the next request re-resolves it.
   *
   * Exists for the admin cover-replacement flow: without this, a new cover.jpg
   * sits beside the audio while every page keeps serving the cached old one
   * until the retention sweep happens to reap it — which, for a pinned album,
   * is never.
   */
  async forgetAlbum(artist: string, album: string): Promise<void> {
    const key = this.key('album', artist, album);
    const row = this.db.prepare('SELECT path FROM art_cache WHERE k = ?').get(key) as
      | { path: string }
      | undefined;
    if (row) await rm(row.path, { force: true }).catch(() => {});
    this.db.prepare('DELETE FROM art_cache WHERE k = ?').run(key);
  }

  async sweep(): Promise<{
    removed: number;
    keptPinned: number;
    orphanFiles: number;
    freedBytes: number;
  }> {
    const days = this.settings.all().artRetentionDays;
    // Retention 0 means keep art forever, but unreferenced FILES are a consistency problem
    // rather than an age one, so that pass still runs below.
    const cutoff0 = days <= 0;

    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const stale = cutoff0
      ? []
      : (this.db
          .prepare('SELECT k, path, bytes FROM art_cache WHERE last_used_at < ?')
          .all(cutoff) as { k: string; path: string; bytes: number }[]);

    const pinnedAlbums = new Set(
      (
        this.db
          .prepare('SELECT DISTINCT norm_artist, norm_album FROM tracks')
          .all() as { norm_artist: string; norm_album: string }[]
      ).map((r) => `album:${r.norm_artist}|${r.norm_album}`),
    );
    const pinnedArtists = new Set(
      (this.db.prepare('SELECT DISTINCT norm_artist FROM tracks').all() as { norm_artist: string }[]).map(
        (r) => `artist:${r.norm_artist}`,
      ),
    );

    let removed = 0;
    let keptPinned = 0;
    let freedBytes = 0;
    for (const row of stale) {
      if (pinnedAlbums.has(row.k) || pinnedArtists.has(row.k)) {
        keptPinned++;
        // Stamp it so it is not reconsidered on every sweep. It is pinned, not unused.
        this.db.prepare('UPDATE art_cache SET last_used_at = unixepoch() WHERE k = ?').run(row.k);
        continue;
      }
      await rm(row.path, { force: true }).catch(() => {});
      this.db.prepare('DELETE FROM art_cache WHERE k = ?').run(row.k);
      removed++;
      freedBytes += row.bytes;
    }

    // Files with no row at all.
    //
    // The row-driven pass above can only delete what it knows about, so a file whose row
    // vanished — a crash between the write and the insert, a table cleared by hand — would
    // sit there forever taking space nothing accounts for. The cache is regenerable, so
    // anything unreferenced is safe to drop.
    let orphanFiles = 0;
    try {
      const known = new Set(
        (this.db.prepare('SELECT path FROM art_cache').all() as { path: string }[]).map((r) => r.path),
      );
      for (const name of await readdir(this.dir)) {
        const full = join(this.dir, name);
        if (known.has(full)) continue;
        const st = await stat(full).catch(() => null);
        await rm(full, { force: true }).catch(() => {});
        orphanFiles++;
        freedBytes += st?.size ?? 0;
      }
    } catch {
      /* directory not created yet */
    }

    if (removed || keptPinned || orphanFiles) {
      this.log.info(
        {
          removed,
          keptPinned,
          orphanFiles,
          freedMb: Math.round(freedBytes / 1024 / 1024),
          retentionDays: days,
        },
        'artwork cache swept',
      );
    }
    return { removed, keptPinned, orphanFiles, freedBytes };
  }

  /** Counts for the admin page. */
  async stats(): Promise<{ entries: number; bytes: number; pinned: number; onDiskBytes: number }> {
    const row = this.db.prepare('SELECT COUNT(*) n, COALESCE(SUM(bytes),0) b FROM art_cache').get() as {
      n: number;
      b: number;
    };
    const pinned = this.db
      .prepare(
        `SELECT COUNT(*) n FROM art_cache
          WHERE k IN (SELECT 'artist:' || norm_artist FROM tracks)
             OR k IN (SELECT 'album:' || norm_artist || '|' || norm_album FROM tracks)`,
      )
      .get() as { n: number };

    // Measured rather than summed, so a cache directory that has drifted from the table
    // shows up instead of being quietly reported as correct.
    let onDiskBytes = 0;
    try {
      for (const f of await readdir(this.dir)) {
        const st = await stat(join(this.dir, f)).catch(() => null);
        onDiskBytes += st?.size ?? 0;
      }
    } catch {
      /* directory not created yet */
    }
    return { entries: row.n, bytes: row.b, pinned: pinned.n, onDiskBytes };
  }
}
