import type Database from 'better-sqlite3';
import {
  CHARACTERISTICS,
  CHARACTERISTIC_BY_KEY,
  type CharacteristicVector,
} from './characteristics.js';

/**
 * How alike two tracks are, from their characteristic vectors.
 *
 * THE PRIMITIVE, NOT THE ANSWER. This deliberately computes similarity and nothing else. It is
 * tempting to fold "what should play next" in here, and it would be wrong: the most similar
 * song is frequently the worst next song — it is the same song again. Recommendation will want
 * to compare against a MODIFIED target ("same but more energy, less dark"), to weight by
 * recency, to avoid the artist just played. All of that belongs above this line. What lives
 * here is one distance function, exposed three ways, so none of those callers has to reimplement
 * the maths and get it subtly different.
 *
 * THE MEASURE. Weighted normalised Euclidean distance over the dimensions the two vectors
 * share:
 *
 *     distance   = sqrt( Σ w[i]·(A[i] − B[i])² / Σ w[i] )
 *     similarity = 1 − distance
 *
 * Normalising by the summed weight is what makes the result comparable across pairs that
 * happen to share different numbers of dimensions — without it, a pair overlapping on fifty
 * dimensions would look systematically less similar than one overlapping on ten, purely from
 * having more terms. Since every score is in 0..1, each squared difference is in 0..1, so the
 * weighted mean is too, and the root of it is as well: similarity lands in 0..1 by construction.
 * It is still clamped, because a future characteristic stored outside its range should degrade
 * to a bad score rather than a negative one.
 *
 * MISSING IS NOT ZERO. A dimension either track lacks is dropped from the numerator AND the
 * denominator. This is the whole reason the old mood model could not do this job: there,
 * "absent" and "scores zero" were the same state. Here an instrumental has no vocal_intimacy
 * row at all, and comparing it to a whispered ballad simply does not consider vocal intimacy —
 * rather than concluding the two are identical on it.
 */

/** Dimensions two vectors must share before a similarity means anything. */
export const MIN_OVERLAP = 8;

export interface Contribution {
  characteristic: string;
  name: string;
  a: number;
  b: number;
  /** Absolute difference, for ranking what is closest and what is furthest apart. */
  delta: number;
  weight: number;
}

export interface SimilarityResult {
  /** 0..1, or null when the two tracks do not share enough scored dimensions to compare. */
  similarity: number | null;
  /** How many dimensions actually took part. */
  overlap: number;
  /** Present only when similarity is null, saying why in a form a UI can show. */
  reason?: string;
  /** The dimensions on which they agree most, strongest agreement first. */
  closest: Contribution[];
  /** Where they differ most, biggest difference first. This is the explanation people want. */
  differences: Contribution[];
}

/** How many contributions to report on each side. Enough to explain, short enough to read. */
const EXPLAIN_N = 5;

const weightOf = (key: string): number => CHARACTERISTIC_BY_KEY.get(key)?.similarityWeight ?? 0;

/**
 * The one distance computation. Everything else in this file is a way of getting two vectors
 * into it.
 *
 * `weights` is injected rather than read from the taxonomy directly so a caller can ask a
 * different question — "how similar are these two ignoring production?" — without a second
 * implementation. It defaults to the taxonomy's own weights, which is what every current caller
 * wants.
 */
export function compareVectors(
  a: CharacteristicVector,
  b: CharacteristicVector,
  opts: { weights?: (key: string) => number; minOverlap?: number } = {},
): SimilarityResult {
  const weight = opts.weights ?? weightOf;
  const minOverlap = opts.minOverlap ?? MIN_OVERLAP;

  const contributions: Contribution[] = [];
  let weightedSquares = 0;
  let totalWeight = 0;

  for (const [key, av] of a) {
    const bv = b.get(key);
    // Missing on either side: excluded from BOTH sums. Never coerced to zero.
    if (bv === undefined) continue;
    const w = weight(key);
    if (w <= 0) continue;
    const delta = av - bv;
    weightedSquares += w * delta * delta;
    totalWeight += w;
    contributions.push({
      characteristic: key,
      name: CHARACTERISTIC_BY_KEY.get(key)?.name ?? key,
      a: av,
      b: bv,
      delta: Math.abs(delta),
      weight: w,
    });
  }

  if (contributions.length < minOverlap || totalWeight <= 0) {
    return {
      similarity: null,
      overlap: contributions.length,
      reason:
        contributions.length === 0
          ? 'neither track has been analysed'
          : `only ${contributions.length} shared characteristic${contributions.length === 1 ? '' : 's'} — not enough to compare`,
      closest: [],
      differences: [],
    };
  }

  const distance = Math.sqrt(weightedSquares / totalWeight);
  const similarity = Math.max(0, Math.min(1, 1 - distance));

  /*
   * The explanation. Ranked by the WEIGHTED difference rather than the raw one, because that is
   * what actually moved the number: a 0.4 gap on harmonic richness matters less to the score
   * than a 0.3 gap on energy, and an explanation that claimed otherwise would mislead exactly
   * the person trying to understand a recommendation.
   */
  const byImpact = [...contributions].sort((x, y) => y.delta * y.weight - x.delta * x.weight);
  const byAgreement = [...contributions].sort(
    (x, y) => x.delta * y.weight - y.delta * x.weight || x.delta - y.delta,
  );

  return {
    similarity,
    overlap: contributions.length,
    closest: byAgreement.slice(0, EXPLAIN_N),
    differences: byImpact.slice(0, EXPLAIN_N).filter((c) => c.delta > 0),
  };
}

/** A partial target — "the same but more energy" — as the vector type the maths wants. */
export function toVector(profile: Record<string, number>): CharacteristicVector {
  const v: CharacteristicVector = new Map();
  for (const [k, s] of Object.entries(profile)) {
    if (!CHARACTERISTIC_BY_KEY.has(k)) continue;
    const n = Number(s);
    if (!Number.isFinite(n)) continue;
    v.set(k, Math.max(0, Math.min(1, n)));
  }
  return v;
}

export interface SimilarTrack {
  trackId: number;
  title: string;
  artistName: string;
  albumTitle: string;
  similarity: number;
  overlap: number;
}

/**
 * Similarity as a service over the library.
 *
 * PERFORMANCE SHAPE. Vectors are read once and held in memory, not fetched per comparison. At
 * fifty-five dimensions a track's vector is a few hundred bytes, so a ten-thousand-track library
 * is a handful of megabytes — small enough that the honest v1 is a full scan over a warm cache,
 * and a full scan over 10k tracks is a few milliseconds of arithmetic. What matters is that the
 * SHAPE leaves room: the cache is behind a method, the distance function takes plain vectors,
 * and nothing above this layer knows how the rows are stored. Swapping in database-side
 * pre-filtering, a denormalised vector column or an ANN index later touches this file only.
 *
 * The cache is invalidated by writers (see SongCharacteristics.persist), not by a timer, because
 * a stale vector is a wrong answer rather than a slow one.
 */
export class Similarity {
  private vectors: Map<number, CharacteristicVector> | null = null;

  constructor(private db: Database.Database) {}

  /** Drop the cache. Called whenever any track's scores change. */
  invalidate(): void {
    this.vectors = null;
  }

  /**
   * Every analysed track's merged vector, built in one query.
   *
   * Manual scores win over AI ones for the same dimension, matching what a reader sees — the
   * ordering in the query does the merge, so the last row written per key is the one kept.
   */
  private all(): Map<number, CharacteristicVector> {
    if (this.vectors) return this.vectors;
    const rows = this.db
      .prepare(
        `SELECT track_id, characteristic_key, score, source FROM track_characteristics
          ORDER BY track_id,
                   CASE source WHEN 'manual' THEN 3 WHEN 'imported' THEN 2 ELSE 1 END`,
      )
      .all() as { track_id: number; characteristic_key: string; score: number }[];
    const out = new Map<number, CharacteristicVector>();
    for (const r of rows) {
      let v = out.get(r.track_id);
      if (!v) {
        v = new Map();
        out.set(r.track_id, v);
      }
      v.set(r.characteristic_key, r.score);
    }
    this.vectors = out;
    return out;
  }

  /** One track's vector, or null when it has never been analysed. */
  vectorOf(trackId: number): CharacteristicVector | null {
    return this.all().get(trackId) ?? null;
  }

  /** How many tracks currently have a profile. */
  analysedCount(): number {
    return this.all().size;
  }

  /**
   * How close every analysed track is to a target profile, in one pass.
   *
   * For callers that need to RANK the library rather than inspect one pair — the DJ scores every
   * candidate against its target vector on every deal. Returns only tracks with enough overlap
   * to judge, so an absent id means "cannot say", never "scored zero".
   */
  scoreAgainst(profile: Record<string, number>): Map<number, number> {
    const target = toVector(profile);
    const out = new Map<number, number>();
    if (target.size === 0) return out;
    for (const [trackId, vector] of this.all()) {
      const r = compareVectors(target, vector);
      if (r.similarity !== null) out.set(trackId, r.similarity);
    }
    return out;
  }

  compareTracks(a: number, b: number): SimilarityResult {
    const va = this.vectorOf(a);
    const vb = this.vectorOf(b);
    if (!va || !vb) {
      return {
        similarity: null,
        overlap: 0,
        reason: !va && !vb ? 'neither track has been analysed' : 'one track has not been analysed',
        closest: [],
        differences: [],
      };
    }
    return compareVectors(va, vb);
  }

  /**
   * Compare a track against an arbitrary target profile.
   *
   * This is the entry point recommendation will actually use: take the current track's vector,
   * push energy up and darkness down, and rank against THAT rather than against the song
   * playing. Same distance function, no duplication — which is the entire reason the maths is
   * a free function taking two Maps.
   */
  compareToProfile(trackId: number, target: Record<string, number>): SimilarityResult {
    const v = this.vectorOf(trackId);
    if (!v) {
      return {
        similarity: null,
        overlap: 0,
        reason: 'track has not been analysed',
        closest: [],
        differences: [],
      };
    }
    return compareVectors(v, toVector(target));
  }

  /**
   * The nearest tracks to a track, or to a target profile.
   *
   * `exclude` covers the obvious "not the song itself" and lets a caller drop what it has
   * already played. `sameArtist: false` is here because the nearest neighbours of a track are
   * very often the rest of its own album, which is true and useless.
   */
  findSimilar(
    seed: number | Record<string, number>,
    opts: { limit?: number; exclude?: Iterable<number>; sameArtist?: boolean } = {},
  ): { results: SimilarTrack[]; reason?: string } {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const exclude = new Set(opts.exclude ?? []);
    const target = typeof seed === 'number' ? this.vectorOf(seed) : toVector(seed);
    if (!target || target.size === 0) {
      return { results: [], reason: 'no characteristic profile to search from' };
    }
    if (typeof seed === 'number') exclude.add(seed);

    // Artist filtering needs names, which the vectors do not carry. One query, whole library.
    const meta = new Map(
      (
        this.db
          .prepare('SELECT id, title, artist_name, album_title, norm_artist FROM tracks').all() as {
          id: number;
          title: string;
          artist_name: string;
          album_title: string;
          norm_artist: string;
        }[]
      ).map((t) => [t.id, t]),
    );
    const seedArtist =
      typeof seed === 'number' ? (meta.get(seed)?.norm_artist ?? '') : '';

    const scored: SimilarTrack[] = [];
    for (const [trackId, vector] of this.all()) {
      if (exclude.has(trackId)) continue;
      const t = meta.get(trackId);
      if (!t) continue;
      if (opts.sameArtist === false && seedArtist && t.norm_artist === seedArtist) continue;
      const r = compareVectors(target, vector);
      if (r.similarity === null) continue;
      scored.push({
        trackId,
        title: t.title,
        artistName: t.artist_name,
        albumTitle: t.album_title,
        similarity: r.similarity,
        overlap: r.overlap,
      });
    }
    scored.sort((x, y) => y.similarity - x.similarity);
    return { results: scored.slice(0, limit) };
  }
}

/** The taxonomy's weights, as the API exposes them for tuning and debugging. */
export const defaultWeights = (): Record<string, number> =>
  Object.fromEntries(CHARACTERISTICS.map((c) => [c.key, c.similarityWeight]));
