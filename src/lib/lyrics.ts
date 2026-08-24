/**
 * Lyrics: fetched while the album downloads, embedded as it is imported.
 *
 * The old arrangement was a nightly cron that walked the whole library. That works,
 * but it means a freshly requested album has no lyrics until the small hours, which
 * is precisely when somebody is least likely to be listening to it. A download takes
 * anywhere from thirty seconds to several minutes and spends all of it waiting on
 * Usenet, so there is a free window to do the lookups in — by the time the files land,
 * the words are already sitting in SQLite waiting to be written.
 *
 * Embedded, not .lrc sidecars: sidecar support is inconsistent across players, proven here
 * by embedding one artist and watching only that artist gain lyrics.
 *
 * Writing tags into somebody's music library is the kind of thing that has gone wrong
 * on this estate before, so node-taglib-sharp was checked rather than trusted: on a
 * real FLAC and a real MP3, the audio payload — everything after the metadata blocks —
 * came back byte-identical by sha256 after a write, twice. The per-file check below is
 * the cheap version of that same idea, run on every file this touches.
 */

import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import { parseFile } from 'music-metadata';
import { File as TagFile } from 'node-taglib-sharp';
import { basename } from 'node:path';
import { norm } from './release.js';

/**
 * LRCLIB is community-run, asks clients to identify themselves, and asks them not to
 * hammer it. One request per second with a real contact is the polite floor.
 */
const LRCLIB = 'https://lrclib.net/api/get';
const USER_AGENT = 'crate/0.1 ( https://github.com/MattLarritt/cratemusic )';
const MIN_GAP_MS = 1100;

export interface LyricLine {
  text: string;
  synced: boolean;
}

/**
 * Strip edition decorations off a title before asking LRCLIB.
 *
 * Its lookup is an exact match, and a library tagged "Second Hand News
 * (2001 Remaster)" finds nothing while the song itself is right there under
 * its own name. Applied as a fallback, not first — a parenthetical is
 * occasionally part of the real title.
 */
function undecorated(title: string): string {
  return title
    .replace(/\s*[([][^)\]]*(remaster(ed)?|version|edition|deluxe|expanded|mono|stereo|reissue|anniversary|bonus)[^)\]]*[)\]]\s*$/i, '')
    .replace(/\s+[-–—]\s+\d{4}\s+remaster(ed)?\s*$/i, '')
    .trim();
}

export class Lyrics {
  /** Promise chain, so concurrent prefetches still respect one request per second. */
  private gate: Promise<void> = Promise.resolve();

  constructor(
    private db: Database.Database,
    private log: FastifyBaseLogger,
  ) {}

  private key(artist: string, title: string): string {
    return `${norm(artist)}|${norm(title)}`;
  }

  /** Cached lyrics for one track, or null. */
  get(artist: string, title: string): LyricLine | null {
    const row = this.db
      .prepare('SELECT text, synced FROM lyrics WHERE key = ?')
      .get(this.key(artist, title)) as { text: string; synced: number } | undefined;
    if (!row || !row.text) return null;
    return { text: row.text, synced: Boolean(row.synced) };
  }

  private remember(artist: string, title: string, text: string, synced: boolean): void {
    this.db
      .prepare(
        `INSERT INTO lyrics (key, artist_name, title, text, synced, fetched_at)
         VALUES (?,?,?,?,?,unixepoch())
         ON CONFLICT(key) DO UPDATE SET
           text = excluded.text, synced = excluded.synced, fetched_at = unixepoch()`,
      )
      .run(this.key(artist, title), artist, title, text, synced ? 1 : 0);
  }

  /**
   * Lyrics for one track, cached or fetched on demand.
   *
   * The prefetch path covers everything crate imports; this covers everything
   * else — files that predate crate, or songs whose lookup failed during the
   * download window. Same cache, same rate gate, so a song is looked up once
   * ever regardless of which path asked first.
   */
  async forTrack(
    artist: string,
    title: string,
    album: string,
    durationS: number,
  ): Promise<LyricLine | null> {
    return this.fetchOne(artist, title, album, durationS);
  }

  /**
   * Ask LRCLIB for one track, rate limited and cached.
   *
   * A miss is cached as an empty string so a track nothing has lyrics for is not looked
   * up again on every import. A network failure is NOT cached, because that would turn
   * one bad minute into a permanent absence.
   */
  private async fetchOne(
    artist: string,
    title: string,
    album: string,
    durationS: number,
  ): Promise<LyricLine | null> {
    const cached = this.db
      .prepare('SELECT text, synced FROM lyrics WHERE key = ?')
      .get(this.key(artist, title)) as { text: string; synced: number } | undefined;
    if (cached) return cached.text ? { text: cached.text, synced: Boolean(cached.synced) } : null;

    const run = this.gate.then(() => new Promise<void>((r) => setTimeout(r, MIN_GAP_MS)));
    this.gate = run;
    await run;

    const ask = async (trackName: string, albumName: string) => {
      const qs = new URLSearchParams({
        artist_name: artist,
        track_name: trackName,
        album_name: albumName,
        duration: String(Math.round(durationS)),
      });
      const res = await fetch(`${LRCLIB}?${qs.toString()}`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { syncedLyrics?: string; plainLyrics?: string };
      const synced = Boolean(body.syncedLyrics?.trim());
      const text = (body.syncedLyrics || body.plainLyrics || '').trim();
      return text ? { text, synced } : null;
    };

    /**
     * Provider chain, in order of trust. LRCLIB has the best-curated catalogue
     * but has been unreachable from here (Cloudflare 403s this IP, and it has
     * outages); NetEase's public API is deep and reliably synced; SimpMusic is
     * community/auto-transcribed and comes last with the strictest filtering.
     * The first SYNCED answer wins outright; a plain-only answer is held as
     * the fallback while the rest of the chain is tried.
     */
    const lrclib = async (): Promise<LyricLine | null> => {
      let found = await ask(title, album);
      if (!found) {
        // Exact title missed — retry without the "(2001 Remaster)"-style
        // decorations, on both the track and the album.
        const bareTitle = undecorated(title);
        const bareAlbum = undecorated(album);
        if (bareTitle !== title || bareAlbum !== album) {
          found = await ask(bareTitle, bareAlbum);
        }
        // Last resort: artist and title alone. The get endpoint accepts it,
        // and it matched a track the album-qualified lookups missed.
        if (!found) found = await ask(undecorated(title), '');
      }
      return found;
    };

    const providers: [string, () => Promise<LyricLine | null>][] = [
      ['lrclib', lrclib],
      ['netease', () => this.netease(artist, undecorated(title))],
      ['simpmusic', () => this.simpmusic(artist, undecorated(title), durationS)],
    ];

    let plainFallback: LyricLine | null = null;
    let anyFailed = false;
    for (const [name, run] of providers) {
      try {
        const found = await run();
        if (found?.synced) {
          this.remember(artist, title, found.text, true);
          return found;
        }
        if (found && !plainFallback) plainFallback = found;
      } catch (err) {
        anyFailed = true;
        this.log.warn(
          { artist, title, provider: name, err: err instanceof Error ? err.message : String(err) },
          'lyrics provider failed',
        );
      }
    }

    if (plainFallback) {
      this.remember(artist, title, plainFallback.text, false);
      return plainFallback;
    }
    // Only a full round of honest "not found" answers is worth caching; a
    // provider that ERRORED might have had the words, so the next open of the
    // panel deserves a fresh try.
    if (!anyFailed) this.remember(artist, title, '', false);
    return null;
  }

  /**
   * NetEase Cloud Music. Its public search and lyric endpoints need no key,
   * answer from this network, and carry synced LRC for a very deep catalogue.
   * The match is checked — its search happily returns covers — and the credit
   * lines it prepends (作词/作曲/编曲…) are stripped before use.
   */
  private async netease(artist: string, title: string): Promise<LyricLine | null> {
    const search = await fetch(
      `https://music.163.com/api/search/get?type=1&limit=8&s=${encodeURIComponent(`${artist} ${title}`)}`,
      { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) },
    );
    if (!search.ok) throw new Error(`netease search HTTP ${search.status}`);
    const sd = (await search.json()) as {
      result?: { songs?: { id?: number; name?: string; artists?: { name?: string }[] }[] };
    };

    const wantTitle = norm(title);
    const wantArtist = norm(artist);
    const song = (sd.result?.songs ?? []).find(
      (t) =>
        t.id &&
        norm(t.name ?? '') === wantTitle &&
        (t.artists ?? []).some((a) => norm(a.name ?? '') === wantArtist),
    );
    if (!song) return null;

    const lyr = await fetch(`https://music.163.com/api/song/lyric?id=${song.id}&lv=1&kv=1&tv=-1`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!lyr.ok) throw new Error(`netease lyric HTTP ${lyr.status}`);
    const ld = (await lyr.json()) as { lrc?: { lyric?: string } };
    const raw = (ld.lrc?.lyric ?? '').trim();
    if (!raw) return null;

    // Drop the production-credit lines NetEase prepends.
    const lines = raw
      .split('\n')
      .filter((l) => !/(作词|作曲|编曲|制作|混音|母带|录音|出品|监制|发行)\s*[:：]/.test(l));
    const text = lines.join('\n').trim();
    if (!text) return null;
    const synced = /\[\d+:\d+/.test(text);
    return { text, synced };
  }

  /**
   * SimpMusic's community lyrics API. Last in the chain because much of it is
   * auto-transcribed — hence the strict artist and duration match, and the
   * junk check: a "lyric" that is mostly [Music] markers is a transcription of
   * silence, and no lyrics beat wrong ones.
   */
  private async simpmusic(
    artist: string,
    title: string,
    durationS: number,
  ): Promise<LyricLine | null> {
    const search = await fetch(
      `https://api-lyrics.simpmusic.org/v1/search?q=${encodeURIComponent(`${artist} ${title}`)}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!search.ok) throw new Error(`simpmusic search HTTP ${search.status}`);
    const sd = (await search.json()) as {
      data?: { videoId?: string; artistName?: string; durationSeconds?: number }[];
    };

    const wantArtist = norm(artist);
    const hit = (sd.data ?? []).find(
      (d) =>
        d.videoId &&
        norm(d.artistName ?? '') === wantArtist &&
        (durationS <= 0 ||
          d.durationSeconds === undefined ||
          Math.abs(d.durationSeconds - durationS) <= 5),
    );
    if (!hit) return null;

    const lyr = await fetch(`https://api-lyrics.simpmusic.org/v1/${hit.videoId}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!lyr.ok) throw new Error(`simpmusic lyric HTTP ${lyr.status}`);
    const ld = (await lyr.json()) as {
      data?: { syncedLyrics?: string; plainLyric?: string }[];
    };
    const item = ld.data?.[0];
    const text = (item?.syncedLyrics || item?.plainLyric || '').trim();
    if (!text) return null;

    const lines = text.split('\n').filter((l) => l.trim() !== '');
    const junk = lines.filter((l) => /\[music\]/i.test(l)).length;
    if (lines.length < 8 || junk / lines.length > 0.2) return null;

    const synced = /\[\d+:\d+/.test(text);
    return { text, synced };
  }

  /**
   * Warm the cache for an album while its download is in flight.
   *
   * Titles come from MusicBrainz, which is not always what the rip's tags say — so this
   * is a head start, not a guarantee. Anything that misses is looked up at import time
   * using the tags actually on disk.
   */
  async prefetch(
    artist: string,
    album: string,
    tracks: { title: string; lengthMs: number | null }[],
  ): Promise<{ found: number; missing: number }> {
    let found = 0;
    let missing = 0;
    for (const t of tracks) {
      if (!t.title) continue;
      const got = await this.fetchOne(artist, t.title, album, (t.lengthMs ?? 0) / 1000);
      if (got) found++;
      else missing++;
    }
    this.log.info({ artist, album, found, missing }, 'lyrics prefetched during download');
    return { found, missing };
  }

  /**
   * Embed lyrics into files that have just been imported.
   *
   * Reads each file's own tags for the lookup, because the rip's titles are what has to
   * match, and falls back to a live LRCLIB call when the prefetch missed. A file that
   * already has lyrics is left alone, so this is free to re-run.
   */
  async embedInto(files: string[]): Promise<{ embedded: number; already: number; missing: number; failed: number }> {
    let embedded = 0;
    let already = 0;
    let missing = 0;
    let failed = 0;

    for (const path of files) {
      let meta;
      try {
        meta = await parseFile(path, { duration: true });
      } catch {
        failed++;
        continue;
      }

      if (meta.common.lyrics && JSON.stringify(meta.common.lyrics).length > 8) {
        already++;
        continue;
      }

      const artist = meta.common.artist || meta.common.albumartist || '';
      const title = meta.common.title || '';
      const album = meta.common.album || '';
      if (!artist || !title) {
        missing++;
        continue;
      }

      const got =
        this.get(artist, title) ??
        (await this.fetchOne(artist, title, album, meta.format.duration ?? 0));
      if (!got) {
        missing++;
        continue;
      }

      // Integrity net. node-taglib-sharp was verified byte-exact on both formats, but
      // this runs on files that cannot be re-downloaded for free, so the cheap version
      // of that check runs every time: a metadata write must not move the audio.
      const fpBefore = fingerprint(meta);
      try {
        const f = TagFile.createFromPath(path);
        f.tag.lyrics = got.text;
        f.save();
        f.dispose();
      } catch (err) {
        failed++;
        this.log.warn(
          { file: basename(path), err: err instanceof Error ? err.message : String(err) },
          'could not write lyrics',
        );
        continue;
      }

      try {
        const after = await parseFile(path, { duration: true });
        if (fingerprint(after) !== fpBefore) {
          // Loud, because this is the case that matters.
          failed++;
          this.log.error(
            { file: basename(path), before: fpBefore, after: fingerprint(after) },
            'AUDIO STREAM CHANGED after writing lyrics — investigate before running again',
          );
          continue;
        }
      } catch {
        failed++;
        continue;
      }

      embedded++;
    }

    return { embedded, already, missing, failed };
  }
}

/** Identity of the audio stream, independent of any tag. */
function fingerprint(meta: Awaited<ReturnType<typeof parseFile>>): string {
  return [
    meta.format.duration?.toFixed(3) ?? '?',
    meta.format.sampleRate ?? '?',
    meta.format.numberOfChannels ?? '?',
    meta.format.bitsPerSample ?? '?',
  ].join('/');
}
