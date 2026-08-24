import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Jimp, rgbaToInt } from 'jimp';

/**
 * Cover art for a playlist: either one the owner uploaded, or a mosaic of what is in it.
 *
 * A playlist is the one thing in crate with no artwork of its own, which left every playlist
 * tile a grey rectangle. The mosaic is built from up to four DISTINCT albums in the list —
 * never the same cover twice, because a 2x2 of one repeated sleeve reads as a rendering bug
 * rather than a design — and the gaps are filled with a tinted disc so a one-album playlist
 * still gets a full square.
 *
 * COMPOSED ONCE, NOT PER REQUEST. The chosen albums are recorded on the playlist row as a
 * seed, and the finished JPEG is written to disk beside it. Two things follow: the art does
 * not shuffle itself every time the page is opened, and Subsonic clients — which expect a
 * real raster file from getCoverArt, not an SVG or a CSS grid — get one for the cost of a
 * local read. The seed is only recomputed when it stops being a valid selection: an album it
 * names has left the playlist, or the list has since grown enough to fill a gap.
 *
 * jimp rather than sharp deliberately. This image is composed once per playlist and then
 * cached, so decode speed is worth nothing here, and sharp would mean a native module and
 * libvips inside an Alpine/musl image that currently compiles only better-sqlite3.
 */

/**
 * Pair separator for the artist|album keys below, written as an escape so it is VISIBLE.
 * It was a literal NUL typed into the template strings, which worked and read as a space.
 */
const SEP = '\u001f';

/** 600 square: the largest size any client asks for, and small enough to compose eagerly. */
const SIZE = 600;
const TILE = SIZE / 2;

/** Uploads are re-encoded to this, so one huge PNG cannot become the served cover. */
const UPLOAD_QUALITY = 88;
export const MAX_ART_BYTES = 8 * 1024 * 1024;

export interface PlaylistImage {
  body: Buffer;
  contentType: string;
  /** 'custom' or 'mosaic', for the UI to know whether Remove will do anything. */
  source: 'custom' | 'mosaic';
}

interface Seed {
  /** [artistName, albumTitle] pairs, in the order they are laid out. */
  albums: [string, string][];
  /** One hue per placeholder gap, so the discs are coloured but not random per request. */
  hues: number[];
}

interface AlbumRef {
  artistName: string;
  albumTitle: string;
  paths: string[];
}

/** Hue 0..360 to a packed jimp colour, at fixed saturation and the given lightness. */
function hsl(h: number, s: number, l: number, a = 255): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  const to = (v: number) => Math.max(0, Math.min(255, Math.round((v + m) * 255)));
  return rgbaToInt(to(r1), to(g1), to(b1), a);
}

/**
 * A compact disc, drawn rather than shipped as an asset.
 *
 * Rendered at double size and scaled down, which is the cheapest anti-aliasing available:
 * a per-pixel radius test at 300px leaves visibly stepped edges on every circle.
 */
function discTile(hue: number): ReturnType<typeof makeTile> {
  return makeTile(hue);
}

function makeTile(hue: number) {
  const n = TILE * 2;
  const img = new Jimp({ width: n, height: n, color: hsl(hue, 0.32, 0.14) });
  const c = n / 2;
  const rOuter = n * 0.4;
  const rInner = n * 0.135;
  const rHole = n * 0.075;

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = x - c;
      const dy = y - c;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > rOuter || d < rHole) continue;
      if (d < rInner) {
        // The clamping ring around the spindle hole: flat and pale.
        img.setPixelColor(hsl(hue, 0.2, 0.5), x, y);
        continue;
      }
      // Two sheens a half-turn apart, plus a faint groove, for something that reads as a
      // disc rather than a flat ring at tile size.
      const ang = Math.atan2(dy, dx);
      const sheen = (Math.cos(ang * 2) + 1) / 2;
      const groove = ((d / n) * 60) % 1 < 0.5 ? 0.02 : 0;
      img.setPixelColor(hsl(hue, 0.55, 0.3 + sheen * 0.34 + groove), x, y);
    }
  }
  img.resize({ w: TILE, h: TILE });
  return img;
}

export class PlaylistArt {
  constructor(
    private db: Database.Database,
    private dir: string,
    /** Injected so this module does not choose where album art comes from. */
    private artcache: {
      album: (
        artist: string,
        album: string,
        paths: string[],
      ) => Promise<{ body: Buffer; contentType: string } | null>;
    },
    private warn: (msg: string) => void = () => {},
  ) {}

  /**
   * Distinct albums in a playlist, each with the file paths art can be read out of.
   *
   * Grouped on the album's own identity — album_artist and norm_album, the same key the album
   * page uses — NOT on who each track is credited to. Those differ per track on a
   * compilation, so keying on the credit hands the mosaic several slots holding the same
   * sleeve: the exact repeat the no-duplicate-covers rule exists to prevent. It only became
   * reachable once the performer stopped being overwritten by the album artist.
   *
   * The display artist is the first track's, because the art has to be fetched under a name.
   */
  private albumsIn(playlistId: number): AlbumRef[] {
    const rows = this.db
      .prepare(
        `SELECT t.artist_name AS artistName, t.album_title AS albumTitle, t.path,
                t.album_artist AS albumKey, t.norm_album AS albumNorm
           FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
          WHERE pt.playlist_id = ? AND t.album_title != ''
          ORDER BY pt.position, pt.added_at`,
      )
      .all(playlistId) as {
      artistName: string;
      albumTitle: string;
      path: string;
      albumKey: string;
      albumNorm: string;
    }[];

    const by = new Map<string, AlbumRef>();
    for (const r of rows) {
      const k = `${r.albumKey}|${r.albumNorm}`;
      const at = by.get(k);
      if (at) at.paths.push(r.path);
      else by.set(k, { artistName: r.artistName, albumTitle: r.albumTitle, paths: [r.path] });
    }
    return [...by.values()];
  }

  /**
   * The four slots to draw, stable across requests.
   *
   * Kept as-is unless it has gone stale, which means one of its albums has left the playlist
   * or the playlist can now fill a gap the seed left empty. Anything else — a track added to
   * an album already pictured, a reorder, a rename — leaves the art alone.
   */
  private seedFor(playlistId: number, albums: AlbumRef[]): Seed {
    const row = this.db
      .prepare('SELECT art_seed FROM playlists WHERE id = ?')
      .get(playlistId) as { art_seed: string | null } | undefined;

    const available = new Set(albums.map((a) => `${a.artistName}${SEP}${a.albumTitle}`));
    const want = Math.min(4, albums.length);

    if (row?.art_seed) {
      try {
        const s = JSON.parse(row.art_seed) as Seed;
        const intact =
          Array.isArray(s.albums) &&
          s.albums.length === want &&
          s.albums.every(([ar, al]) => available.has(`${ar}${SEP}${al}`));
        if (intact && Array.isArray(s.hues) && s.hues.length === 4 - want) return s;
      } catch {
        // A seed we cannot read is a seed worth replacing.
      }
    }

    const pool = [...albums];
    const picked: [string, string][] = [];
    // Random pick, but only ever from albums not already chosen, so no cover repeats.
    while (picked.length < want && pool.length) {
      const i = Math.floor(Math.random() * pool.length);
      const a = pool.splice(i, 1)[0]!;
      picked.push([a.artistName, a.albumTitle]);
    }
    const hues = Array.from({ length: 4 - picked.length }, () => Math.floor(Math.random() * 360));
    const seed: Seed = { albums: picked, hues };
    this.db.prepare('UPDATE playlists SET art_seed = ? WHERE id = ?').run(JSON.stringify(seed), playlistId);
    return seed;
  }

  private file(playlistId: number, tag: string, ext = 'jpg'): string {
    return join(this.dir, `pl-${playlistId}-${tag}.${ext}`);
  }

  /** Every generated file for this playlist except the one just written. */
  private async prune(playlistId: number, keep: string): Promise<void> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    for (const n of names) {
      if (!n.startsWith(`pl-${playlistId}-`) || n === keep) continue;
      if (n.includes('-custom.')) continue;
      await unlink(join(this.dir, n)).catch(() => {});
    }
  }

  /**
   * The playlist's image. Custom upload wins; otherwise the mosaic, composed on the first
   * request after the seed changes and read from disk on every one after that.
   */
  async get(playlistId: number): Promise<PlaylistImage | null> {
    const row = this.db
      .prepare('SELECT art_custom FROM playlists WHERE id = ?')
      .get(playlistId) as { art_custom: string | null } | undefined;
    if (!row) return null;

    if (row.art_custom) {
      const body = await readFile(join(this.dir, row.art_custom)).catch(() => null);
      // A missing file means the volume was replaced under us; fall through to a mosaic
      // rather than serving a 404 for a playlist that plainly has art configured.
      if (body) return { body, contentType: 'image/jpeg', source: 'custom' };
      this.db.prepare('UPDATE playlists SET art_custom = NULL WHERE id = ?').run(playlistId);
    }

    const albums = this.albumsIn(playlistId);
    const seed = this.seedFor(playlistId, albums);
    const tag = createHash('sha1').update(JSON.stringify(seed)).digest('hex').slice(0, 12);
    const path = this.file(playlistId, tag);

    const cached = await readFile(path).catch(() => null);
    if (cached) return { body: cached, contentType: 'image/jpeg', source: 'mosaic' };

    const body = await this.compose(seed, albums);
    await mkdir(this.dir, { recursive: true });
    await writeFile(path, body).catch((e: Error) => this.warn(`playlist art write failed: ${e.message}`));
    await this.prune(playlistId, `pl-${playlistId}-${tag}.jpg`);
    return { body, contentType: 'image/jpeg', source: 'mosaic' };
  }

  private async compose(seed: Seed, albums: AlbumRef[]): Promise<Buffer> {
    const canvas = new Jimp({ width: SIZE, height: SIZE, color: rgbaToInt(14, 14, 17, 255) });
    const slots: (Buffer | null)[] = [];

    for (const [artistName, albumTitle] of seed.albums) {
      const ref = albums.find((a) => a.artistName === artistName && a.albumTitle === albumTitle);
      const art = await this.artcache
        .album(artistName, albumTitle, ref?.paths ?? [])
        .catch(() => null);
      slots.push(art?.body ?? null);
    }

    // An album whose art could not be found becomes a disc too, so a failed lookup degrades
    // to the placeholder instead of leaving a black square.
    let hue = 0;
    const hueAt = () => seed.hues[hue++] ?? Math.floor(Math.random() * 360);

    for (let i = 0; i < 4; i++) {
      const x = (i % 2) * TILE;
      const y = Math.floor(i / 2) * TILE;
      const buf = slots[i] ?? null;
      let tile: Awaited<ReturnType<typeof Jimp.read>> | ReturnType<typeof makeTile> | null = null;
      if (buf) {
        tile = await Jimp.read(buf).catch(() => null);
        // cover, not resize: album art is square in principle and rectangular in practice,
        // and squashing a 1400x1000 scan looks worse than cropping it.
        if (tile) tile.cover({ w: TILE, h: TILE });
      }
      canvas.composite(tile ?? discTile(hueAt()), x, y);
    }

    return Buffer.from(await canvas.getBuffer('image/jpeg', { quality: UPLOAD_QUALITY }));
  }

  /**
   * Replace the art with an uploaded image, normalised to the same square JPEG the mosaic
   * produces so nothing downstream has to care which kind it is holding.
   */
  async setCustom(playlistId: number, body: Buffer): Promise<void> {
    const img = await Jimp.read(body).catch(() => null);
    if (!img) throw new Error('That file is not a JPEG or PNG image');
    img.cover({ w: SIZE, h: SIZE });
    const out = Buffer.from(await img.getBuffer('image/jpeg', { quality: UPLOAD_QUALITY }));

    const name = `pl-${playlistId}-custom.jpg`;
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, name), out);
    // updated_at is what the client hangs its cache-busting query on, so it has to move even
    // though nothing about the track list changed.
    this.db
      .prepare('UPDATE playlists SET art_custom = ?, updated_at = unixepoch() WHERE id = ?')
      .run(name, playlistId);
  }

  /** Drop the upload and reroll the mosaic, which is what Remove means to the user. */
  async clearCustom(playlistId: number): Promise<void> {
    const row = this.db
      .prepare('SELECT art_custom FROM playlists WHERE id = ?')
      .get(playlistId) as { art_custom: string | null } | undefined;
    if (row?.art_custom) await unlink(join(this.dir, row.art_custom)).catch(() => {});
    // art_seed goes too, so Remove genuinely rerolls rather than restoring the previous mosaic.
    this.db
      .prepare(
        'UPDATE playlists SET art_custom = NULL, art_seed = NULL, updated_at = unixepoch() WHERE id = ?',
      )
      .run(playlistId);
    await this.prune(playlistId, '');
  }

  /** Files for playlists that no longer exist — called from the same sweep as the art cache. */
  async sweep(): Promise<number> {
    const live = new Set(
      (this.db.prepare('SELECT id FROM playlists').all() as { id: number }[]).map((r) => String(r.id)),
    );
    let removed = 0;
    for (const n of await readdir(this.dir).catch(() => [] as string[])) {
      const m = n.match(/^pl-(\d+)-/);
      if (!m || live.has(m[1]!)) continue;
      await unlink(join(this.dir, n)).catch(() => {});
      removed++;
    }
    return removed;
  }
}
