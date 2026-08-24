/**
 * Deleting albums and tracks.
 *
 * Nothing here unlinks anything. A delete MOVES files to a trash directory, and the
 * reason is not squeamishness: this estate has already lost seventeen FLACs to a path
 * bug, and the difference between that being an annoyance and being a disaster is
 * whether the bytes still exist somewhere afterwards.
 *
 * The trash lives outside the music root on purpose. Inside it, the library scanner
 * would index the trash and deleted albums would reappear under a slightly different
 * path — so it goes next to the downloads instead.
 *
 * That means the move is a copy: /music and /downloads are separate bind mounts inside
 * this container, so the kernel refuses a rename between them with EXDEV even though
 * they are one share on the host. A probe found that rather than an assumption holding.
 * Deletion therefore reuses the importer's moveFile, which verifies a copy by size
 * before removing the source — the same operation deserves the same care, and there
 * should not be two implementations of it.
 *
 * Every path is checked against the music root by real path before anything happens,
 * for the same reason the importer does it: resolve() normalises a string but does not
 * follow symlinks, and a path that leaves the library is a path that can delete
 * something else entirely.
 */

import { mkdir, readdir, realpath, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { moveFile } from './importer.js';

const AUDIO = /\.(flac|mp3|m4a|ogg|opus|wav|aac|alac|ape)$/i;

export interface Removal {
  movedTo: string;
  files: string[];
}

/** True when `child` is inside `parent` — both already real paths. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`);
}

/**
 * Resolve a path and refuse it unless it is genuinely inside the library.
 *
 * Refuses the root itself as well as anything outside it, so a bad request cannot ask
 * for the whole library to be moved in one call.
 */
async function assertInsideLibrary(target: string, musicRoot: string): Promise<string> {
  const [real, lib] = await Promise.all([realpath(resolve(target)), realpath(resolve(musicRoot))]);
  if (!within(lib, real)) {
    throw new Error(`refusing to delete ${real}: it is not inside the library at ${lib}`);
  }
  return real;
}

/** A timestamped folder so two deletions of the same album cannot collide. */
function trashDir(trashRoot: string, label: string, stamp: number): string {
  const safe = label.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return join(trashRoot, `${stamp}-${safe || 'deleted'}`);
}

/**
 * Move one track out of the library.
 *
 * Leaves an album directory in place even when it becomes empty, because an empty
 * directory is harmless and removing one is an extra thing that can go wrong on a CIFS
 * share. The library scan counts audio files, so an empty folder stops being held.
 */
export async function removeTrack(opts: {
  path: string;
  musicRoot: string;
  trashRoot: string;
  stamp: number;
}): Promise<Removal> {
  const real = await assertInsideLibrary(opts.path, opts.musicRoot);
  const info = await stat(real);
  if (!info.isFile()) throw new Error(`${real} is not a file`);
  if (!AUDIO.test(real)) throw new Error(`${basename(real)} is not an audio file`);

  const dest = trashDir(opts.trashRoot, basename(dirname(real)), opts.stamp);
  await mkdir(dest, { recursive: true });
  await moveFile(real, join(dest, basename(real)));
  return { movedTo: dest, files: [basename(real)] };
}

/**
 * Move a whole album out of the library.
 *
 * Always file by file, never a directory rename. One code path for both layouts: the
 * album-per-folder case and the flat pre-existing case where several albums share an
 * artist folder and renaming it would take the whole discography. It also has to be
 * file by file because the trash is on a different mount, where a directory rename
 * fails outright.
 *
 * The now-empty directories are tidied afterwards, and only if they really are empty.
 */
export async function removeAlbum(opts: {
  dir: string;
  musicRoot: string;
  trashRoot: string;
  stamp: number;
  /** File names belonging to this album, when the directory holds more than one. */
  onlyFiles?: string[];
}): Promise<Removal> {
  const real = await assertInsideLibrary(opts.dir, opts.musicRoot);
  const info = await stat(real);
  if (!info.isDirectory()) throw new Error(`${real} is not a directory`);

  const dest = trashDir(opts.trashRoot, basename(real), opts.stamp);
  await mkdir(dest, { recursive: true });

  // basename() on every name so a caller cannot smuggle a traversal through the list.
  const names =
    opts.onlyFiles && opts.onlyFiles.length
      ? opts.onlyFiles.map((n) => basename(n))
      : (await readdir(real, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name);

  const moved: string[] = [];
  for (const name of names) {
    try {
      await moveFile(join(real, name), join(dest, name));
      moved.push(name);
    } catch {
      // A file already gone is not a failure; the goal state is that it is absent.
    }
  }

  // Tidy up, deepest first, and only what is genuinely empty. rmdir on a non-empty
  // directory fails, which is exactly the guard wanted here.
  await rmdir(real).catch(() => {});
  await rmdir(dirname(real)).catch(() => {});
  return { movedTo: dest, files: moved };
}
