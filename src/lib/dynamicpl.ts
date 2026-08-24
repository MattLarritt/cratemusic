import type Database from 'better-sqlite3';
import { ADJACENT, familiesOf, isJunk, type Family } from './genrefam.js';

/**
 * Dynamic playlists: a playlist that stores a RECIPE instead of rows, and deals fresh
 * tracks from it every time it is opened.
 *
 * Two kinds of recipe share one shape. A hand-built one ("metal + punk, 90s, high
 * energy") is a few terms at default weight; a saved DJ mood is the same thing with the
 * mood's decayed weights carried over — which is what makes "save mood as playlist"
 * one function call rather than a second system. The scoring maths deliberately mirrors
 * the DJ's (same clamps, same family adjacency at 0.35), so a playlist saved from a mood
 * plays like the mood did.
 */

export interface RuleTerm {
  kind: 'genre' | 'style' | 'era' | 'energy' | 'artist' | 'char';
  /** genre: the tag; style: a Family id; era: decade like "1990"; energy: chill|medium|high;
   * artist: norm_artist; char: "<characteristic>|high" or "<characteristic>|low" — see
   * CHAR_BAND_FRACTION for what high and low mean. */
  key: string;
  weight: number;
  /** Display name, for recipe chips ("metal", "1990s", "high energy", "very dark"). */
  label?: string;
}

export interface PlaylistRules {
  v: 1;
  terms: RuleTerm[];
  limit: number;
}

const GENRE_CLAMP = 4;
const STYLE_CLAMP = 4.5;
const ERA_CLAMP = 3;
const ENERGY_CLAMP = 2.5;
/**
 * Song characteristics get era's clamp: precise enough to steer a recipe, not enough to
 * out-vote what the music actually IS. A recipe of nothing but characteristics still works —
 * eligibility only needs one term to hit — it just ranks on feel alone.
 */
const CHAR_CLAMP = 3;
/**
 * What "high" and "low" mean on a characteristic: the top and bottom THIRD of this listener's
 * own analysed library, per dimension, rather than a fixed cut at 0.65/0.35.
 *
 * Fixed cuts were the first design and the data killed it. Measured over 3,366 analysed tracks,
 * the dimensions are nothing like each other: `atmosphere` spans 0.4–1.0, so NOT ONE track sits
 * below 0.35 and a "low atmosphere" chip would have matched nothing at all; `vocal_presence` has
 * 95% of the library above 0.65, so "high vocals" would have matched everything and filtered
 * nothing. A percentile is self-calibrating — "the darkest third of what I own" is a meaningful
 * request on every dimension, whatever the classifier's habits are on that axis, and it stays
 * meaningful as the library grows. Applied by RANK rather than by cutoff value — see charBands
 * for the tie problem that forced that.
 */
const CHAR_BAND_FRACTION = 1 / 3;
const ADJ_FACTOR = 0.35;
const PER_ARTIST_CAP = 3;
const TEMPERATURE = 1.0;
export const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** The DJ's energy bands, shared vocabulary: <0.35 chill, <0.65 medium, else high. */
export function energyBand(energy: number | null): 'chill' | 'medium' | 'high' | null {
  if (energy == null || energy < 0) return null;
  if (energy < 0.35) return 'chill';
  if (energy < 0.65) return 'medium';
  return 'high';
}

export function parseRules(raw: string | null): PlaylistRules | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PlaylistRules;
    if (!Array.isArray(parsed.terms)) return null;
    return {
      v: 1,
      terms: parsed.terms.filter((t) => t && t.kind && t.key && Number.isFinite(t.weight)),
      limit: Math.min(MAX_LIMIT, Math.max(1, Number(parsed.limit) || DEFAULT_LIMIT)),
    };
  } catch {
    return null;
  }
}

interface CandidateRow {
  id: number;
  title: string;
  artist_name: string;
  album_title: string;
  album_artist_name: string;
  path: string;
  size: number;
  track_no: number | null;
  duration_s: number | null;
  norm_artist: string;
  norm_album: string;
  genres: string;
  year: number | null;
  energy: number | null;
}

/** The full UserTrack shape, so every playlist consumer — JSON, queue, Subsonic —
 * can treat a dealt row exactly like a stored one. */
export interface DealtTrack {
  trackId: number;
  path: string;
  title: string;
  artistName: string;
  albumTitle: string;
  albumArtistName: string;
  trackNo: number | null;
  durationS: number | null;
  sizeBytes: number;
  year: number | null;
  onDisk: true;
  mine: true;
  addedAt: null;
}

/**
 * Which tracks are in the top and bottom third of this listener's library, per dimension.
 *
 * MEMBERSHIP BY RANK, NOT BY THRESHOLD VALUE — and that distinction is the whole function.
 *
 * The first version computed a cutoff score and compared against it, which quietly broke on
 * exactly the dimensions this design exists to handle. `vocal_presence` has 95% of the real
 * library at or near 1.0; the bottom-third cutoff therefore LANDS on that saturated value, and
 * "score <= cutoff" then matched the entire library. A test with 28 of 30 tracks tied at 0.98
 * caught it. Ranking sidesteps ties completely: the bottom third is the bottom third however
 * many tracks share a score, so "the least vocal third of what I own" is always exactly that.
 *
 * Only the dimensions the recipe names are read, and the tie-break is track id, so a recipe
 * deals the same band every time even though the deal within it is random.
 */
function charBands(
  db: Database.Database,
  userId: number,
  keys: Set<string>,
): Map<string, { high: Set<number>; low: Set<number> }> {
  const out = new Map<string, { high: Set<number>; low: Set<number> }>();
  if (!keys.size) return out;
  const marks = [...keys].map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT tc.track_id AS id, tc.characteristic_key AS k, tc.score AS score, tc.source AS source
         FROM track_characteristics tc
         JOIN user_tracks ut ON ut.track_id = tc.track_id
        WHERE ut.user_id = ? AND tc.characteristic_key IN (${marks})`,
    )
    .all(userId, ...keys) as { id: number; k: string; score: number; source: string }[];

  // One score per (track, dimension): a hand-set value outranks the classifier's, matching
  // lib/similarity.ts so a playlist and a similarity search never disagree about a track.
  const rank = (src: string) => (src === 'manual' ? 3 : src === 'imported' ? 2 : 1);
  const best = new Map<string, Map<number, { score: number; src: number }>>();
  for (const r of rows) {
    let dim = best.get(r.k);
    if (!dim) {
      dim = new Map();
      best.set(r.k, dim);
    }
    const held = dim.get(r.id);
    if (!held || rank(r.source) >= held.src) dim.set(r.id, { score: r.score, src: rank(r.source) });
  }

  for (const [key, scores] of best) {
    const ordered = [...scores.entries()]
      .map(([id, v]) => ({ id, score: v.score }))
      .sort((a, b) => a.score - b.score || a.id - b.id);
    // Too little analysed to speak of thirds: no band rather than a guess at one.
    if (ordered.length < 3) continue;
    const size = Math.max(1, Math.floor(ordered.length * CHAR_BAND_FRACTION));
    out.set(key, {
      low: new Set(ordered.slice(0, size).map((r) => r.id)),
      high: new Set(ordered.slice(-size).map((r) => r.id)),
    });
  }
  return out;
}

/**
 * Deal a fresh set from the recipe, over the user's own library.
 *
 * Eligibility is score > 0 — a dynamic playlist only ever contains music its recipe can
 * name a reason for. Within the eligible pool, picks are softmax-weighted (better matches
 * more likely, never certain) with a per-artist cap, so every deal differs while staying
 * on-recipe. When the recipe matches fewer tracks than it asks for, that IS the playlist.
 */
export function materialize(db: Database.Database, userId: number, rules: PlaylistRules): DealtTrack[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.artist_name, t.album_title, t.album_artist_name,
              t.path, t.size, t.track_no, t.duration_s,
              t.norm_artist, t.norm_album, t.genres, NULLIF(t.year, 0) AS year,
              CASE WHEN t.energy >= 0 THEN t.energy ELSE NULL END AS energy
         FROM user_tracks ut JOIN tracks t ON t.id = ut.track_id
        WHERE ut.user_id = ?`,
    )
    .all(userId) as CandidateRow[];

  // Artist genres, merged with the file's own like the DJ does — files are often tagged
  // one broad word while the artist tags carry the strain a recipe actually names.
  const artistGenres = new Map<string, string[]>();
  for (const r of db.prepare('SELECT norm_artist, genre FROM artist_genres').all() as {
    norm_artist: string;
    genre: string;
  }[]) {
    const list = artistGenres.get(r.norm_artist) ?? [];
    list.push(r.genre);
    artistGenres.set(r.norm_artist, list);
  }

  const weights = new Map<string, number>();
  for (const term of rules.terms) {
    weights.set(`${term.kind}|${term.key.toLowerCase()}`, term.weight);
  }

  /*
   * Song characteristics, for the dimensions this recipe names and no others.
   *
   * `charKeys` is the dimension ("darkness"), stripped of the |high / |low suffix the term
   * carries: both bands of one dimension read the same column, so asking for "dark" and "not
   * dark" in one recipe (which is contradictory but permitted) still costs one scan.
   */
  const charKeys = new Set<string>();
  for (const term of rules.terms) {
    if (term.kind !== 'char') continue;
    const dim = term.key.split('|')[0]?.toLowerCase();
    if (dim) charKeys.add(dim);
  }
  const bands = charBands(db, userId, charKeys);

  /*
   * Eligibility needs a DIRECT hit, not just a nearby one.
   *
   * Adjacency exists so a metal recipe ranks industrial and punk neighbours above
   * unrelated music — but on its own it also let anything merely NEXT DOOR in. A "metal"
   * playlist collected Alanis Morissette, because "alt. rock" is the alt family and alt
   * borders metal: 0.35 × 2 = 0.7, and 0.7 was greater than zero. A hand-written recipe
   * is a statement about what belongs, so a track must match one of its terms outright —
   * its own genre, its own family, its decade, its energy band, its artist — and
   * adjacency then only decides the running order among things that already qualify.
   */
  const scored: { row: CandidateRow; score: number }[] = [];
  for (const row of rows) {
    let directHit = false;
    const merged: string[] = [];
    for (const g of [...(row.genres ? row.genres.split(', ') : []), ...(artistGenres.get(row.norm_artist) ?? [])]) {
      const n = g.trim().toLowerCase();
      if (n && !isJunk(n) && !merged.includes(n)) merged.push(n);
    }

    let genreScore = 0;
    for (const g of merged) {
      const w = weights.get(`genre|${g}`) ?? 0;
      genreScore += w;
      if (w > 0) directHit = true;
    }
    genreScore = clamp(genreScore, GENRE_CLAMP);

    const fams = familiesOf(merged);
    let styleScore = 0;
    const counted = new Set<Family>();
    for (const f of fams) {
      const w = weights.get(`style|${f}`) ?? 0;
      styleScore += w;
      if (w > 0) directHit = true;
      counted.add(f);
    }
    for (const f of fams) {
      for (const adj of ADJACENT[f]) {
        if (counted.has(adj)) continue;
        counted.add(adj);
        // Adjacency adjusts the ranking only — deliberately NOT a directHit.
        styleScore += ADJ_FACTOR * (weights.get(`style|${adj}`) ?? 0);
      }
    }
    styleScore = clamp(styleScore, STYLE_CLAMP);

    let eraScore = 0;
    if (row.year && row.year >= 1900) {
      const decade = String(Math.floor(row.year / 10) * 10);
      eraScore = clamp(weights.get(`era|${decade}`) ?? 0, ERA_CLAMP);
      if (eraScore > 0) directHit = true;
    }

    let energyScore = 0;
    const band = energyBand(row.energy);
    if (band) {
      energyScore = clamp(weights.get(`energy|${band}`) ?? 0, ENERGY_CLAMP);
      if (energyScore > 0) directHit = true;
    }

    const artistScore = weights.get(`artist|${row.norm_artist}`) ?? 0;
    if (artistScore > 0) directHit = true;

    /*
     * The characteristic layer: is this track in the band the recipe asked for?
     *
     * A track with no score on a named dimension simply does not match that term — it is not
     * penalised for it. That covers two real cases: a track the classifier has not reached
     * yet, and an instrumental, which deliberately has NO row for the vocal dimensions rather
     * than a zero (see characteristics.ts on why absent and zero must not be the same thing).
     * "Quiet vocals" therefore means quiet vocals, not "instrumental" — asking for one and
     * getting the other would be the surprise.
     */
    let charScore = 0;
    for (const term of rules.terms) {
      if (term.kind !== 'char') continue;
      const [dim, side] = term.key.toLowerCase().split('|');
      if (!dim || !side) continue;
      const band = bands.get(dim);
      if (!band) continue;
      const inBand = side === 'high' ? band.high.has(row.id) : band.low.has(row.id);
      if (!inBand) continue;
      charScore += term.weight;
      if (term.weight > 0) directHit = true;
    }
    charScore = clamp(charScore, CHAR_CLAMP);

    const score = genreScore + styleScore + eraScore + energyScore + artistScore + charScore;
    if (directHit && score > 0) scored.push({ row, score });
  }

  // Softmax sample without replacement, per-artist capped.
  const picked: CandidateRow[] = [];
  const perArtist = new Map<string, number>();
  const candidates = [...scored];
  while (picked.length < rules.limit && candidates.length) {
    const max = Math.max(...candidates.map((e) => e.score));
    const expWeights = candidates.map((e) => Math.exp((e.score - max) / TEMPERATURE));
    const total = expWeights.reduce((a, x) => a + x, 0);
    let roll = Math.random() * total;
    let idx = 0;
    for (; idx < candidates.length - 1; idx++) {
      roll -= expWeights[idx]!;
      if (roll <= 0) break;
    }
    const [chosen] = candidates.splice(idx, 1);
    if (!chosen) break;
    const count = perArtist.get(chosen.row.norm_artist) ?? 0;
    if (count >= PER_ARTIST_CAP) continue;
    perArtist.set(chosen.row.norm_artist, count + 1);
    picked.push(chosen.row);
  }

  return picked.map((row) => ({
    trackId: row.id,
    path: row.path,
    title: row.title,
    artistName: row.artist_name,
    albumTitle: row.album_title,
    albumArtistName: row.album_artist_name,
    trackNo: row.track_no,
    durationS: row.duration_s,
    sizeBytes: row.size,
    year: row.year,
    onDisk: true,
    mine: true,
    addedAt: null,
  }));
}

function clamp(x: number, bound: number): number {
  return Math.max(-bound, Math.min(bound, x));
}
