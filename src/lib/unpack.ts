import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Open the archives a scene release arrives in.
 *
 * Usenet music releases are still shipped as RAR sets — "Artist-Album-2025-GRP" holds
 * name.rar plus name.r00, r01, r02 and an .sfv, and nothing in crate could read them. The
 * adopt list said "unpack it first" and meant it: the only way through was a shell on the NAS.
 *
 * 7z rather than unrar: one binary covers rar, zip, 7z and tar, and Alpine carries p7zip in
 * community while unrar is non-free and absent. It also handles both RAR4 and RAR5, which
 * matters because releases in the wild are still a mix of the two.
 *
 * MULTI-VOLUME SETS ARE ONE ARCHIVE. Handing 7z the first volume extracts the whole set, so
 * the continuation parts must be recognised and skipped — running it once per .r00 would
 * either fail or extract the same album a dozen times.
 */

/** A single-file archive, or the base name of a set. */
const PLAIN = /\.(rar|zip|7z|tar|tgz|tar\.gz)$/i;

/**
 * Volume naming, which is where this gets fiddly and worth spelling out rather than encoding
 * in one unreadable regex.
 *
 *   name.rar + name.r00, r01, …   classic RAR — the .rar is the entry point
 *   name.part1.rar, part2.rar …   RAR5 — part ONE is the entry point, zero-padded or not
 *   name.7z.001, .002, …          split archive — .001 is the entry point
 *
 * Getting this wrong is not harmless in either direction: treat a continuation as an entry
 * point and 7z errors or extracts the same album repeatedly, treat an entry point as a
 * continuation and the set is silently skipped. Both happened before this was tested.
 */
const SPLIT = /\.(?:rar|zip|7z|tar)\.(\d{3})$/i;
const PART = /\.part(\d+)\.rar$/i;
const CLASSIC_CONTINUATION = /\.[rs]\d{2}$/i;

export interface UnpackResult {
  /** Archive entry points actually handed to 7z. */
  archives: string[];
  /** Audio files present after, minus those present before. */
  audioGained: number;
  errors: string[];
}

/** Part of an archive at all, entry point or not — used to tell a RAR set from a dud folder. */
export function isArchive(name: string): boolean {
  return PLAIN.test(name) || SPLIT.test(name) || PART.test(name) || CLASSIC_CONTINUATION.test(name);
}

/** True only for the one file in a set that 7z should be pointed at. */
export function isFirstVolume(name: string): boolean {
  const split = SPLIT.exec(name);
  if (split) return Number(split[1]) === 1;
  const part = PART.exec(name);
  if (part) return Number(part[1]) === 1;
  if (CLASSIC_CONTINUATION.test(name)) return false;
  return PLAIN.test(name);
}

/** Is p7zip actually in the image? Reported to the UI so the button can explain itself. */
export async function unpackerAvailable(): Promise<boolean> {
  try {
    await run('7z', ['i'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every archive entry point under a directory, deepest-first so a nested set is opened before
 * the directory holding it is re-read.
 */
async function findArchives(dir: string, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await findArchives(p, depth + 1)));
    else if (isFirstVolume(e.name)) out.push(p);
  }
  return out;
}

async function countAudio(dir: string, audioExt: RegExp, depth = 0): Promise<number> {
  if (depth > 3) return 0;
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) n += await countAudio(join(dir, e.name), audioExt, depth + 1);
    else if (audioExt.test(e.name)) n++;
  }
  return n;
}

/**
 * Refuse an archive whose members would land outside the target directory.
 *
 * 7z strips a leading slash but will happily honour "../" on the way out, so a hostile or
 * simply broken release could write into /music or over the database. Listing first costs one
 * cheap pass and turns that from a possibility into a refusal.
 */
type Inspection = { ok: true } | { ok: false; why: string };

async function inspect(archive: string): Promise<Inspection> {
  let stdout: string;
  try {
    ({ stdout } = await run('7z', ['l', '-ba', '-slt', archive], {
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    }));
  } catch (err) {
    // An archive that cannot even be listed must not be extracted — but the overwhelmingly
    // common cause is a set with a volume missing, not anything sinister, and saying
    // "refused" about an incomplete download sends the reader looking in the wrong place.
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      why: /missing volume|cannot find|unexpected end|is not supported|headers error/i.test(msg)
        ? 'cannot be read — the set looks incomplete or corrupt'
        : `cannot be read — ${msg.split('\n').find((l) => /error/i.test(l))?.trim().slice(0, 160) ?? 'unknown error'}`,
    };
  }

  for (const line of stdout.split('\n')) {
    if (!line.startsWith('Path = ')) continue;
    const p = line.slice(7).trim().replace(/\\/g, '/');
    if (!p) continue;
    if (p.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(p)) {
      return { ok: false, why: `refused — it would write outside its own folder (${p})` };
    }
  }
  return { ok: true };
}

/**
 * Extract every archive in a download folder, in place.
 *
 * In place, not into a subfolder, because the adopt step and the track matcher both read the
 * entry directory itself — burying the audio one level down would trade one manual step for
 * another. Nothing is deleted: the archives stay put, and the caller decides whether the
 * folder is worth keeping once it can see what came out.
 */
export async function unpackDir(
  dir: string,
  audioExt: RegExp,
  warn: (msg: string) => void = () => {},
): Promise<UnpackResult> {
  const before = await countAudio(dir, audioExt);
  const archives = await findArchives(dir);
  const errors: string[] = [];
  const opened: string[] = [];

  for (const a of archives) {
    const verdict = await inspect(a);
    if (!verdict.ok) {
      const why = `${basename(a)}: ${verdict.why}`;
      warn(why);
      errors.push(why);
      continue;
    }
    try {
      // -y to accept overwrite prompts, -o to pin the destination. Extraction happens beside
      // the archive rather than in the process's cwd, which is what `x` alone would do.
      await run('7z', ['x', '-y', `-o${dir}`, a], {
        timeout: 15 * 60_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      opened.push(a);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const why = `${basename(a)}: ${
        /missing volume|unexpected end/i.test(msg)
          ? 'incomplete set — a volume is missing'
          : (msg.split('\n').find((l) => /error/i.test(l))?.trim().slice(0, 160) ?? 'extraction failed')
      }`;
      warn(why);
      errors.push(why);
    }
  }

  const after = await countAudio(dir, audioExt);
  return { archives: opened, audioGained: Math.max(0, after - before), errors };
}
