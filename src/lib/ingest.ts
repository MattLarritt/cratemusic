import { mkdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Library } from './library.js';
import type { UserLibrary } from './userlib.js';
import type { AcoustId } from './acoustid.js';
import type { Recommender } from './recommend.js';
import type { Notifier } from './notify.js';
import { moveFile } from './importer.js';
import { safeSegment } from './upload.js';

/**
 * One file into the library, for someone.
 *
 * The upload route already knows how to do this properly for an album — dedupe against the
 * pool, move rather than copy, index only the moved files, write the confirmed identity over
 * whatever the tags say, record the album, grant ownership. A single song arriving from an
 * external source needs exactly that sequence and nothing album-shaped around it, so this is
 * that sequence, once, where a plugin can reach it (ctx.library.ingest) and the external
 * catalog can call it without either of them re-deriving the order.
 *
 * The order is the point, and it is inherited from bugs rather than taste: dedupe BEFORE
 * anything moves (Starboy arrived twice under two filenames), index only the new file (indexing
 * a folder clobbered confirmed metadata on its neighbours), and override AFTER indexing (a
 * file's own tags are the least trustworthy thing about it — doubly so for a video title).
 */

export interface IngestInput {
  /** Absolute path to the file. It is MOVED, so after a successful ingest it no longer exists. */
  file: string;
  artist: string;
  title: string;
  /** Where the song came from, for anything worth filing it under. Absent means "Singles". */
  album?: string;
  trackNo?: number;
}

export interface IngestResult {
  trackId: number;
  /** True when a copy was already on disk and was granted instead of the new file. */
  adopted: boolean;
  /** The identity it was filed under — which a confident fingerprint may have corrected. */
  artist: string;
  title: string;
  album: string;
}

/** Albumless songs land here, one folder per artist, rather than as loose files in the artist dir. */
export const SINGLES_ALBUM = 'Singles';

/**
 * A fingerprint this confident outranks the metadata it arrived with.
 *
 * The audio is the one thing about a downloaded file that cannot be mislabelled, and a video's
 * title is the thing most likely to be — "(Official Video) [HD] ft. …" is not a song name. Below
 * this the fingerprint is a suggestion, and a suggestion does not get to rename somebody's song.
 */
const TRUST_FINGERPRINT = 0.85;

export class Ingester {
  constructor(
    private deps: {
      musicRoot: string;
      library: Library;
      userlib: UserLibrary;
      acoustid: AcoustId;
      recommender: Recommender;
      notifier: Notifier;
      log: FastifyBaseLogger;
    },
  ) {}

  async ingest(input: IngestInput, userId: number): Promise<IngestResult> {
    const d = this.deps;
    let artist = input.artist.trim();
    let title = input.title.trim();
    let album = input.album?.trim() || SINGLES_ALBUM;
    if (!artist || !title) throw new Error('an ingested song needs an artist and a title');
    await stat(input.file); // a missing file should fail here, loudly, not halfway through a move

    if (d.acoustid.enabled()) {
      const match = await d.acoustid.identify(input.file, { artist, title }).catch(() => null);
      if (match && match.score >= TRUST_FINGERPRINT && match.artist && match.title) {
        artist = match.artist;
        title = match.title;
        // An album from the fingerprint is a real release; "Singles" was only ever a stand-in.
        if (match.album) album = match.album;
      }
    }

    /*
     * Already on disk? Then this person gets THAT copy and the download is dropped.
     *
     * Same rule the pool exists for: a second person wanting a song crate already holds gets it
     * for free. It also stops a song you own under a slightly different album name being kept
     * twice because YouTube filed it differently.
     */
    const existing = d.userlib.poolMatch(artist, title);
    if (existing) {
      d.userlib.add(userId, existing.trackId, 'external');
      d.recommender.invalidateAll();
      return { trackId: existing.trackId, adopted: true, artist, title, album };
    }

    const albumDir = join(d.musicRoot, safeSegment(artist), safeSegment(album));
    await mkdir(albumDir, { recursive: true });
    const ext = extname(input.file).toLowerCase() || '.m4a';
    const base =
      input.trackNo && input.trackNo > 0
        ? `${String(input.trackNo).padStart(2, '0')}. ${safeSegment(title)}`
        : safeSegment(title);
    const dest = await freePath(albumDir, base, ext);
    await moveFile(input.file, dest);

    const indexed = await d.library.indexFiles([dest]);
    const row = indexed[0];
    if (!row) throw new Error(`indexed nothing for ${dest}`);
    d.library.overrideTrack(dest, {
      artistName: artist,
      albumTitle: album,
      title,
      trackNo: input.trackNo ?? 0,
      albumMbid: null,
    });
    d.library.record({
      mbid: '',
      artistName: artist,
      albumTitle: album,
      path: albumDir,
      trackFiles: d.userlib.poolForAlbum(artist, album).length,
    });
    d.userlib.add(userId, row.id, 'external');
    d.recommender.invalidateAll();

    d.notifier.emit('library.external', {
      title: 'crate kept a song',
      message: `${artist} — ${title}`,
      data: { artist, title, album, trackId: row.id },
    });
    return { trackId: row.id, adopted: false, artist, title, album };
  }
}

/** `Title.m4a`, or `Title (2).m4a` when that is taken. Never overwrites. */
async function freePath(dir: string, base: string, ext: string): Promise<string> {
  for (let n = 1; n < 100; n += 1) {
    const candidate = join(dir, n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`);
    const taken = await stat(candidate).then(
      () => true,
      () => false,
    );
    if (!taken) return candidate;
  }
  throw new Error(`no free filename for ${base} in ${dir}`);
}

