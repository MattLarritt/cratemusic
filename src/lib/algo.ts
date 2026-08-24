import type Database from 'better-sqlite3';
import type { MusicBrainz } from './musicbrainz.js';
import { norm } from './release.js';
import { albumIdentity } from './library.js';

/**
 * Algorithm profiles: named sets of WARMTH values that shape what the library
 * shows and what discovery offers.
 *
 * Warmth is 0–5 per (genre | artist | album | track). 0 means "prefer none of
 * this", 5 means "prefer most of this", and the absence of a value is
 * deliberate silence — neutral, not zero. Profiles exist so the values can be
 * moods: a Default always exists, and switching is one pointer on the user
 * row, so there is never a moment with two actives.
 *
 * Effective warmth for a SONG resolves by specificity: an explicit track
 * value beats its album's, which beats its artist's, which beats the average
 * of the artist's genre values. A parent's silence falls through; a parent's
 * ZERO does not get overridden upward by silence below it — only an explicit
 * more-specific value can rescue a song from a frozen genre.
 */

export type WarmthKind = 'genre' | 'artist' | 'album' | 'track';

export interface WarmthEntry {
  kind: WarmthKind;
  normKey: string;
  label: string;
  warmth: number;
}

export interface AlgoProfile {
  id: number;
  name: string;
  active: boolean;
  entries: number;
}

const nowSec = () => Math.floor(Date.now() / 1000);

export class Algo {
  constructor(private db: Database.Database) {}

  /** The user's Default profile id, created on first touch. */
  private defaultProfile(userId: number): number {
    const row = this.db
      .prepare("SELECT id FROM algo_profiles WHERE user_id = ? AND name = 'Default'")
      .get(userId) as { id: number } | undefined;
    if (row) return row.id;
    const r = this.db
      .prepare("INSERT INTO algo_profiles (user_id, name, created_at) VALUES (?, 'Default', ?)")
      .run(userId, nowSec());
    return Number(r.lastInsertRowid);
  }

  /** The ACTIVE profile id — the pointer, validated, falling back to Default. */
  activeProfile(userId: number): number {
    const u = this.db
      .prepare('SELECT algo_profile_id FROM users WHERE id = ?')
      .get(userId) as { algo_profile_id: number | null } | undefined;
    if (u?.algo_profile_id) {
      const owns = this.db
        .prepare('SELECT 1 FROM algo_profiles WHERE id = ? AND user_id = ?')
        .get(u.algo_profile_id, userId);
      if (owns) return u.algo_profile_id;
    }
    return this.defaultProfile(userId);
  }

  profiles(userId: number): AlgoProfile[] {
    const active = this.activeProfile(userId);
    return (
      this.db
        .prepare(
          `SELECT p.id, p.name,
                  (SELECT COUNT(*) FROM algo_warmth w WHERE w.profile_id = p.id) AS entries
             FROM algo_profiles p WHERE p.user_id = ? ORDER BY p.name = 'Default' DESC, p.name`,
        )
        .all(userId) as { id: number; name: string; entries: number }[]
    ).map((p) => ({ ...p, active: p.id === active }));
  }

  createProfile(userId: number, name: string): number {
    const r = this.db
      .prepare('INSERT INTO algo_profiles (user_id, name, created_at) VALUES (?, ?, ?)')
      .run(userId, name, nowSec());
    return Number(r.lastInsertRowid);
  }

  /** Default cannot go: it is the fallback everything else assumes. */
  deleteProfile(userId: number, id: number): boolean {
    const row = this.db
      .prepare('SELECT name FROM algo_profiles WHERE id = ? AND user_id = ?')
      .get(id, userId) as { name: string } | undefined;
    if (!row || row.name === 'Default') return false;
    this.db.prepare('DELETE FROM algo_warmth WHERE profile_id = ?').run(id);
    this.db.prepare('DELETE FROM algo_profiles WHERE id = ? AND user_id = ?').run(id, userId);
    // A deleted active profile must not leave a dangling pointer.
    this.db
      .prepare('UPDATE users SET algo_profile_id = NULL WHERE id = ? AND algo_profile_id = ?')
      .run(userId, id);
    return true;
  }

  activate(userId: number, id: number): boolean {
    const owns = this.db
      .prepare('SELECT 1 FROM algo_profiles WHERE id = ? AND user_id = ?')
      .get(id, userId);
    if (!owns) return false;
    this.db.prepare('UPDATE users SET algo_profile_id = ? WHERE id = ?').run(id, userId);
    return true;
  }

  entries(profileId: number): WarmthEntry[] {
    return (
      this.db
        .prepare(
          'SELECT kind, norm_key AS normKey, label, warmth FROM algo_warmth WHERE profile_id = ? ORDER BY kind, label',
        )
        .all(profileId) as WarmthEntry[]
    );
  }

  setWarmth(profileId: number, kind: WarmthKind, label: string, warmth: number): void {
    const normKey =
      kind === 'genre' ? label.trim().toLowerCase() : normKeyFor(kind, label);
    this.db
      .prepare(
        `INSERT INTO algo_warmth (profile_id, kind, norm_key, label, warmth, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(profile_id, kind, norm_key) DO UPDATE SET
           warmth = excluded.warmth, label = excluded.label, updated_at = excluded.updated_at`,
      )
      .run(profileId, kind, normKey, label.trim(), warmth, nowSec());
  }

  removeWarmth(profileId: number, kind: WarmthKind, normKey: string): void {
    this.db
      .prepare('DELETE FROM algo_warmth WHERE profile_id = ? AND kind = ? AND norm_key = ?')
      .run(profileId, kind, normKey);
  }

  /** Artist warmths of the active profile, for the recommender: key -> 0..5. */
  artistWarmths(userId: number): Map<string, number> {
    const id = this.activeProfile(userId);
    const rows = this.db
      .prepare("SELECT norm_key, warmth FROM algo_warmth WHERE profile_id = ? AND kind = 'artist'")
      .all(id) as { norm_key: string; warmth: number }[];
    return new Map(rows.map((r) => [r.norm_key, r.warmth]));
  }

  // ---- genres ---------------------------------------------------------------

  /** Genres known for the library, for the add-a-genre picker. */
  knownGenres(): { genre: string; artists: number }[] {
    return this.db
      .prepare(
        'SELECT genre, COUNT(*) AS artists FROM artist_genres GROUP BY genre ORDER BY artists DESC, genre',
      )
      .all() as { genre: string; artists: number }[];
  }

  /**
   * Materialise genres for library artists that have none yet.
   *
   * One MusicBrainz search + one lookup per artist, so this runs against the
   * mirror in milliseconds each and against the public API at one per second —
   * which is why it is capped per call and reports what is left, rather than
   * being a fire-and-forget that might hold a request open for ten minutes.
   */
  async fillGenres(
    mb: MusicBrainz,
    cap = 50,
  ): Promise<{ filled: number; genreless: number; remaining: number }> {
    const missing = this.db
      .prepare(
        `SELECT DISTINCT t.norm_artist AS na, MIN(t.artist_name) AS name
           FROM tracks t
          WHERE t.norm_artist != ''
            AND NOT EXISTS (SELECT 1 FROM artist_genres g WHERE g.norm_artist = t.norm_artist)
            AND NOT EXISTS (SELECT 1 FROM artist_genres_checked c WHERE c.norm_artist = t.norm_artist)
          GROUP BY t.norm_artist`,
      )
      .all() as { na: string; name: string }[];

    let filled = 0;
    let genreless = 0;
    const batch = missing.slice(0, cap);
    for (const a of batch) {
      let genres: string[] = [];
      try {
        const hits = await mb.searchArtists(a.name, 3, 'idle');
        const hit = hits.find((h) => norm(h.name) === a.na) ?? hits[0];
        genres = (hit?.genres ?? []).slice(0, 5).map((g) => g.toLowerCase());
      } catch {
        // Left unchecked on purpose: a transient failure should be retried by
        // the next fill, where a genuinely genreless artist should not be.
        continue;
      }
      if (genres.length) {
        const ins = this.db.prepare(
          'INSERT OR IGNORE INTO artist_genres (norm_artist, genre) VALUES (?, ?)',
        );
        for (const g of genres) ins.run(a.na, g);
        filled++;
      } else {
        genreless++;
      }
      this.db
        .prepare('INSERT OR REPLACE INTO artist_genres_checked (norm_artist, checked_at) VALUES (?, ?)')
        .run(a.na, nowSec());
    }
    return { filled, genreless, remaining: Math.max(0, missing.length - batch.length) };
  }

  genreCoverage(): { artists: number; withGenres: number } {
    const artists = (
      this.db.prepare("SELECT COUNT(DISTINCT norm_artist) AS c FROM tracks WHERE norm_artist != ''").get() as {
        c: number;
      }
    ).c;
    const withGenres = (
      this.db.prepare('SELECT COUNT(DISTINCT norm_artist) AS c FROM artist_genres').get() as { c: number }
    ).c;
    return { artists, withGenres };
  }
}

/**
 * The same key shapes the library uses, so warmth joins straight onto tracks.
 * Albums canonicalise their title half the way the scanner does — norm() alone
 * would make "Ring Ring (2022 Remaster)" a different key from the row it must
 * match.
 */
function normKeyFor(kind: WarmthKind, label: string): string {
  if (kind === 'artist') return norm(label);
  const [a = '', b = ''] = label.split('—').map((v) => v.trim());
  if (!b) return norm(label);
  return kind === 'album' ? `${norm(a)}|${albumIdentity(b)}` : `${norm(a)}|${norm(b)}`;
}
