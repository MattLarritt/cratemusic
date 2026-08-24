/**
 * Moving a finished download into the music library.
 *
 * This is the one part of crate that can destroy something irreplaceable, and it
 * has already happened once on this estate: Lidarr had the same directory mounted
 * twice under different names, decided it was importing a file from one path to
 * another, and moved seventeen FLACs onto themselves. So the checks below are not
 * defensive padding — the first one exists because its absence cost real music.
 *
 * The rules:
 *   - source and destination roots must be different trees, verified by real path
 *     AND by device+inode, not by comparing the strings we were handed
 *   - never overwrite an existing file; skip and report it
 *   - a copy is verified by size before the source is unlinked
 *   - nothing is deleted recursively; only files this run actually moved, plus
 *     known junk, and then only an empty directory is removed
 *
 * Deliberately does NOT rename tracks or rewrite tags. The library scanner reads the
 * embedded tags, so filenames are cosmetic — and renaming to match a canonical
 * tracklist is precisely the strictness that made Lidarr refuse an eleven-track
 * rip of a twelve-track album.
 */

import { constants } from 'node:fs';
import { access, copyFile, mkdir, readdir, realpath, rename, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const AUDIO = new Set(['.flac', '.mp3', '.m4a', '.ogg', '.opus', '.wav', '.aac', '.alac', '.ape']);
/**
 * Cover images worth keeping, by NAME not extension.
 *
 * This used to accept any .jpg or .png next to the audio, which is how six crypto-donation
 * QR codes ended up filed in the library as album artwork. A release can ship any number of
 * images; only the ones named like a cover are one.
 */
const ARTWORK_NAMES = [
  /^cover\.(jpe?g|png)$/i,
  /^folder\.(jpe?g|png)$/i,
  /^front\.(jpe?g|png)$/i,
  /^album\.(jpe?g|png)$/i,
  /^albumart.*\.(jpe?g|png)$/i,
];
const isArtwork = (p: string): boolean => ARTWORK_NAMES.some((r) => r.test(basename(p)));
// Removed after a successful move, because leaving them behind accumulates
// forever and none of them is worth keeping.
const JUNK = new Set(['.nfo', '.sfv', '.url', '.par2', '.txt', '.m3u', '.m3u8', '.log', '.cue', '.nzb']);

export interface ImportResult {
  destDir: string;
  moved: string[];
  skipped: { file: string; why: string }[];
}

/** Safe for a CIFS share: no path separators, no reserved characters, no trailing dot. */
export function safeName(s: string): string {
  return (
    s
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/, '')
      .trim()
      .slice(0, 120) || 'Unknown'
  );
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      try {
        out.push(...(await walk(p)));
      } catch (err) {
        // CIFS dirent types lie: a release delivered as a bare .tar was
        // reported as a directory, the recursive readdir threw ENOTDIR, and
        // the import failed on every retry forever. It is a file; treat it
        // as one and let the audio filter decide it is not music.
        if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') out.push(p);
        else throw err;
      }
    } else if (entry.isFile()) out.push(p);
  }
  return out;
}

/** True when `child` is the same path as, or inside, `parent`. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`));
}

/**
 * Refuse to import when the source and the library are the same place.
 *
 * Uses realpath, not resolve. resolve() only normalises the string: it does not
 * follow symlinks, so an aliased path to the library compares as unrelated and
 * slips through. A fixture pointing at the library through a symlinked parent got
 * past an earlier version of this function — the device+inode check did not catch
 * it either, because a subdirectory legitimately has a different inode from the
 * library root. That is the duplicate-mount shape that destroyed files here, so it
 * is checked the way it actually presents.
 */
async function assertDistinct(sourceDir: string, musicRoot: string): Promise<void> {
  const [src, lib] = await Promise.all([
    realpath(resolve(sourceDir)),
    realpath(resolve(musicRoot)),
  ]);

  if (within(lib, src) || within(src, lib)) {
    throw new Error(
      `refusing to import: ${src} and the library ${lib} are the same tree — ` +
        'this is the duplicate-mount case that destroyed files here before',
    );
  }

  const [a, b] = await Promise.all([stat(src), stat(lib)]);
  if (a.dev === b.dev && a.ino === b.ino) {
    throw new Error(
      `refusing to import: ${src} and ${lib} are the same directory (dev ${a.dev}, inode ${a.ino}) ` +
        'under different names',
    );
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move one file, preferring a rename and falling back to a verified copy.
 *
 * Exported because deletion needs exactly the same care and there should not be two
 * implementations of the one operation that can lose data.
 *
 * The EXDEV path is not hypothetical: /music and /downloads are separate bind mounts
 * inside this container, so the kernel refuses a rename between them even though they
 * are the same share on the host. When that happens the copy is verified by size before
 * the source is removed, because a partial destination is bad and a partial destination
 * with a deleted source is unrecoverable.
 */
export async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }

  await copyFile(from, to);
  const [a, b] = await Promise.all([stat(from), stat(to)]);
  if (a.size !== b.size) {
    // Leave both copies. A partial destination is bad; a partial destination and
    // a deleted source is unrecoverable.
    await rm(to, { force: true });
    throw new Error(`copy of ${basename(from)} came out ${b.size} bytes, expected ${a.size}`);
  }
  await rm(from, { force: true });
}

export async function importAlbum(opts: {
  sourceDir: string;
  musicRoot: string;
  artist: string;
  album: string;
  /**
   * Copy instead of moving, leaving the source where it is.
   *
   * True for torrents: those files are what other people are downloading from
   * you, and moving them out from under the client stops the seed dead. A
   * finished Usenet download has no such obligation, so it still moves.
   */
  keepSource?: boolean;
}): Promise<ImportResult> {
  const { sourceDir, musicRoot } = opts;

  await assertDistinct(sourceDir, musicRoot);

  // SABnzbd's completed path is normally a directory, but a release delivered
  // as a bare archive it does not unpack (plain .tar) arrives as the file
  // itself. Say so once, clearly — walking it produced twelve identical
  // ENOTDIR retries before anything gave up.
  if (!(await stat(sourceDir)).isDirectory()) {
    throw new Error(`release arrived as a bare archive, not extracted audio: ${basename(sourceDir)}`);
  }

  const all = await walk(sourceDir);
  const audio = all.filter((f) => AUDIO.has(ext(f)));
  if (!audio.length) throw new Error(`no audio files under ${sourceDir}`);

  const destDir = join(musicRoot, safeName(opts.artist), safeName(opts.album));
  await mkdir(destDir, { recursive: true });

  // Guard again with the real destination: mkdir may have followed a link.
  await assertDistinct(sourceDir, destDir);

  const moved: string[] = [];
  const skipped: { file: string; why: string }[] = [];

  // Artwork travels with the album; anything else is left where it is.
  for (const from of [...audio, ...all.filter(isArtwork)]) {
    const name = basename(from);
    const to = join(destDir, name);
    if (await exists(to)) {
      skipped.push({ file: name, why: 'already in the library' });
      continue;
    }
    try {
      if (opts.keepSource) await copyFile(from, to);
      else await moveFile(from, to);
      moved.push(name);
    } catch (err) {
      skipped.push({ file: name, why: err instanceof Error ? err.message : String(err) });
    }
  }

  await tidy(sourceDir, all);
  return { destDir, moved, skipped };
}

function ext(p: string): string {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i).toLowerCase();
}

/**
 * Remove what is definitely rubbish and then any directory that is now empty.
 *
 * Never recursive and never forced on anything unrecognised: if a file is not a
 * known junk extension it stays, and a directory with anything left in it stays
 * too. Worst case a folder is left behind, which is untidy rather than harmful.
 */
async function tidy(sourceDir: string, originally: string[]): Promise<void> {
  for (const f of originally) {
    if (JUNK.has(ext(f))) await rm(f, { force: true }).catch(() => {});
  }
  const dirs = new Set(originally.map((f) => dirname(f)));
  // Deepest first, so a parent becomes empty only after its children are gone.
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    if (!within(sourceDir, d)) continue;
    await rmdir(d).catch(() => {});
  }
  await rmdir(sourceDir).catch(() => {});
}
