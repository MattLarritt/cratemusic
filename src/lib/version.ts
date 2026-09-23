/**
 * crate's version, in one place.
 *
 * It was written out by hand in four: package.json, the Subsonic `serverVersion`
 * (twice), and two User-Agent strings. They drifted, as hand-copied constants do —
 * package.json said 0.1.0 while everything on the wire said a bare "0.1". A version a
 * client reads off the wire is worth nothing if it is a literal somebody forgot to
 * edit, so bumping package.json now moves all of them.
 *
 * Read from package.json at startup rather than baked in at build time: tsc emits plain
 * ESM with no bundler to substitute a constant, and the Dockerfile already copies
 * package.json next to dist/.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function read(): string {
  try {
    // dist/lib/version.js -> ../../package.json in the image, and
    // src/lib/version.ts  -> ../../package.json when running from source.
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    // Never fatal. A package.json that cannot be read is a cosmetic problem; refusing
    // to start over it would turn one into an outage.
    return '0.0.0';
  }
}

/** Full semver, e.g. "0.1.1". */
export const VERSION = read();

/**
 * Major.minor only, e.g. "0.1".
 *
 * What the Subsonic `serverVersion` attribute carries. Keeping the shape it already had
 * means no client sees the field change underneath it.
 */
export const VERSION_SHORT = VERSION.split('.').slice(0, 2).join('.');

/**
 * The User-Agent for outbound metadata requests.
 *
 * MusicBrainz asks that clients identify themselves and blocks generic agents, so this
 * is functional rather than decorative. If you run a fork, point the URL at yours —
 * `CRATE_MB_USER_AGENT` overrides it without touching code.
 */
export const USER_AGENT = `crate/${VERSION_SHORT} ( https://github.com/MattLarritt/cratemusic )`;
