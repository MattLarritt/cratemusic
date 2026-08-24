import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { parseFile } from 'music-metadata';
import { moveFile } from './importer.js';
import type { MatchOption } from './uploadsuggest.js';

/**
 * Albums people bring themselves.
 *
 * Downloads arrive through the pipeline with an identity already attached; an
 * upload is a pile of files whose identity the uploader has to confirm. So
 * this is a two-step affair: files land in a STAGING batch and are read for
 * tags, the person confirms (or corrects, or invents) what the album is, and
 * only finalize moves anything into the music root. Nothing half-identified
 * ever touches the library.
 *
 * Staging lives on the NAS next to the downloads, not in the container —
 * an album of FLAC is hundreds of megabytes and the container's disk is the
 * smallest one on the estate. Moves into the music root cross CIFS mounts, so
 * they go through the importer's moveFile, which survives EXDEV and verifies
 * the copy by size before removing the source.
 */

// Matches the library scanner's list exactly: adopting a file the scanner
// would not index strands it in /music, visible to nothing.
const AUDIO = new Set(['.mp3', '.flac', '.m4a', '.ogg', '.opus', '.wav', '.aac', '.alac', '.ape']);
const IMAGE = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/** Per file and per batch. An album is not a discography. */
export const MAX_FILE_BYTES = 400 * 1024 * 1024;
export const MAX_BATCH_FILES = 40;

/** Batches nobody finalized are abandoned uploads, swept after a day. */
const STALE_AFTER_S = 24 * 3600;

/** Present in a batch dir when its files were adopted rather than uploaded. */
const ORIGIN_MARKER = '.origin';

/** Tags, or the filename standing in for them — never a refusal. */
async function readAudioTags(path: string, filename: string): Promise<StagedFile['tags']> {
  const ext = extname(filename).toLowerCase();
  try {
    const m = await parseFile(path);
    return {
      // albumartist first, matching the scanner. This is the guess the confirm screen shows
      // as the album's artist, and reading `artist` first meant a compilation proposed its
      // first performer where the index would have said Various Artists — the same files
      // described two different ways depending on which door they came in.
      artist:
        m.common.albumartist ??
        (m.common.compilation ? 'Various Artists' : undefined) ??
        m.common.artist ??
        '',
      album: m.common.album ?? '',
      title: m.common.title ?? basename(filename, ext),
      trackNo: m.common.track?.no ?? null,
      durationS: m.format.duration ? Math.round(m.format.duration) : null,
    };
  } catch {
    return { artist: '', album: '', title: basename(filename, ext), trackNo: null, durationS: null };
  }
}

export interface StagedFile {
  name: string;
  size: number;
  kind: 'audio' | 'image';
  /** Fingerprint identification, when AcoustID is configured and matched. */
  match?: {
    recordingMbid: string;
    title: string;
    artist: string;
    releaseGroupMbid: string | null;
    album: string;
    score: number;
  } | null;
  tags: {
    artist: string;
    album: string;
    title: string;
    trackNo: number | null;
    durationS: number | null;
  } | null;
  /** Ranked places this file could belong — fingerprint, tags, and already-on-disk. */
  options?: MatchOption[];
}

/** A path segment that cannot escape, empty out, or upset a filesystem. */
export function safeSegment(v: string): string {
  const s = v
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return s || 'Unknown';
}

export class Uploads {
  constructor(
    private stagingRoot: string,
    private musicRoot: string,
    private warn: (msg: string) => void = () => {},
  ) {}

  /**
   * Batch ids carry their owner, so one user can never finalize — or even
   * list — another's staging. The random tail keeps them unguessable anyway.
   */
  newBatchId(userId: number): string {
    return `${userId}-${randomBytes(8).toString('hex')}`;
  }

  /** Owner-checked and shape-checked before any path is built from it. */
  batchDir(userId: number, batchId: string): string | null {
    if (!/^\d+-[a-f0-9]{16}$/.test(batchId)) return null;
    if (!batchId.startsWith(`${userId}-`)) return null;
    return join(this.stagingRoot, batchId);
  }

  /**
   * Stream one part into the batch, byte-capped as it arrives.
   *
   * The cap is enforced while writing rather than after, because "reject a
   * 4 GB file" must not mean "receive a 4 GB file first". On breach the
   * partial file is removed and the stream destroyed, which multipart
   * surfaces to the route as an error for that part alone.
   */
  async stage(dir: string, filename: string, source: Readable): Promise<StagedFile> {
    const ext = extname(filename).toLowerCase();
    const kind = AUDIO.has(ext) ? 'audio' : IMAGE.has(ext) ? 'image' : null;
    if (!kind) throw new Error(`${basename(filename)}: not an audio or cover-image type`);

    await mkdir(dir, { recursive: true });
    const name = safeSegment(basename(filename, ext)) + ext;
    const path = join(dir, name);

    let size = 0;
    await new Promise<void>((resolvePromise, reject) => {
      const out = createWriteStream(path);
      source.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_FILE_BYTES) {
          source.destroy();
          out.destroy();
          reject(new Error(`${name} is over the ${Math.round(MAX_FILE_BYTES / 1e6)} MB limit`));
        }
      });
      source.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolvePromise);
      source.pipe(out);
    }).catch(async (err) => {
      await unlink(path).catch(() => {});
      throw err;
    });

    const tags = kind === 'audio' ? await readAudioTags(path, filename) : null;
    return { name, size, kind, tags };
  }

  /**
   * Adopt files already on this machine — a manual SAB download, a folder
   * someone dropped on the share — into a staging batch, so they flow through
   * the same identify-and-confirm step an upload does.
   *
   * The batch remembers where everything CAME FROM, and that changes what
   * cancel means: an uploaded batch is a copy whose original lives on the
   * uploader's machine, so discarding it costs nothing — but an adopted batch
   * IS the only copy, so discarding must put it back, not delete it. The
   * origin marker is what discard and the sweep read to know which kind of
   * batch they are holding.
   */
  async adopt(dir: string, sources: string[]): Promise<StagedFile[]> {
    await mkdir(dir, { recursive: true });
    const out: StagedFile[] = [];
    const seen = new Set<string>();
    for (const src of sources) {
      const ext = extname(src).toLowerCase();
      const kind = AUDIO.has(ext) ? 'audio' : IMAGE.has(ext) ? 'image' : null;
      if (!kind) continue;
      let name = safeSegment(basename(src, ext)) + ext;
      // Two discs can both have "01. Intro"; a suffix beats a silent overwrite.
      for (let i = 2; seen.has(name); i++) name = `${safeSegment(basename(src, ext))} (${i})${ext}`;
      seen.add(name);
      await moveFile(src, join(dir, name));
      const info = await stat(join(dir, name));
      out.push({
        name,
        size: info.size,
        kind,
        tags: kind === 'audio' ? await readAudioTags(join(dir, name), basename(src)) : null,
      });
    }
    return out;
  }

  /** Where an adopted batch's files must return to on cancel. */
  async markOrigin(dir: string, origin: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ORIGIN_MARKER), origin, 'utf-8');
  }

  /**
   * Move confirmed files into the music root, named from the CONFIRMED
   * metadata rather than whatever the files were called. Returns the album
   * directory and the moved audio paths in track order; the caller owns
   * indexing, because the library owns that SQL.
   */
  async finalize(opts: {
    dir: string;
    artistName: string;
    albumTitle: string;
    files: { name: string; title: string; trackNo: number }[];
    cover?: string;
  }): Promise<{ albumDir: string; moved: { path: string; title: string; trackNo: number }[] }> {
    const albumDir = join(this.musicRoot, safeSegment(opts.artistName), safeSegment(opts.albumTitle));
    await mkdir(albumDir, { recursive: true });

    const moved: { path: string; title: string; trackNo: number }[] = [];
    for (const f of opts.files) {
      // basename() strips any traversal the client might smuggle into a name;
      // the file must already exist in THIS batch to be movable at all.
      const from = join(opts.dir, basename(f.name));
      const ext = extname(f.name).toLowerCase();
      const to = join(
        albumDir,
        `${String(f.trackNo).padStart(2, '0')}. ${safeSegment(f.title)}${ext}`,
      );
      await moveFile(from, to);
      moved.push({ path: to, title: f.title, trackNo: f.trackNo });
    }

    if (opts.cover) {
      const from = join(opts.dir, basename(opts.cover));
      const ext = extname(opts.cover).toLowerCase();
      // Named cover.* because that is the first thing the art cache's
      // cover-file step looks for — custom art works with no extra plumbing.
      await moveFile(from, join(albumDir, `cover${ext}`)).catch(() => {});
    }

    // discard, not rm: for an uploaded batch they are the same, but an adopted
    // batch may hold files deliberately LEFT OUT — the second disc, say — and
    // those must go back where they came from, not to oblivion.
    await this.discard(opts.dir);
    return { albumDir, moved };
  }

  async discard(dir: string): Promise<void> {
    // An adopted batch is the only copy of somebody's download: walking away
    // from the confirm screen must return it, not destroy it.
    const origin = await readFile(join(dir, ORIGIN_MARKER), 'utf-8').catch(() => null);
    if (origin) {
      await mkdir(origin, { recursive: true }).catch(() => {});
      const entries = await readdir(dir).catch(() => [] as string[]);
      for (const e of entries) {
        if (e === ORIGIN_MARKER) continue;
        await moveFile(join(dir, e), join(origin, e)).catch(() => {});
      }
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  /** Abandoned staging is disk somebody forgot about; a day is plenty. */
  async sweep(): Promise<number> {
    let removed = 0;
    const entries = await readdir(this.stagingRoot).catch(() => [] as string[]);
    const cutoff = Date.now() - STALE_AFTER_S * 1000;
    for (const e of entries) {
      const p = join(this.stagingRoot, e);
      try {
        const s = await stat(p);
        if (s.mtimeMs < cutoff) {
          // discard, not rm: an abandoned ADOPTED batch goes home instead of away.
          await this.discard(p);
          removed++;
        }
      } catch {
        /* raced with a finalize; fine */
      }
    }
    if (removed) this.warn(`upload sweep: removed ${removed} abandoned batch(es)`);
    return removed;
  }
}
