import { norm } from './release.js';

/**
 * Choosing WHICH tracks the curator gets to see.
 *
 * The AI playlist builder sent the entire library in one request. That works at demo
 * scale and then stops: a few thousand tracks is tens of thousands of tokens, and an
 * OpenAI account has a per-minute ceiling well below that. Every build then fails with
 * HTTP 429 "Request too large" — not a flaky rate limit but a request that could never
 * have succeeded, and one that only gets worse as the library grows.
 *
 * Trimming the line format does not save it. Stripping album, year and genres still
 * leaves most of the payload, which clears the ceiling only until the next few hundred
 * tracks arrive. The payload has to be bounded by TRACK COUNT, and the tracks that
 * survive have to be the RELEVANT ones — otherwise the model curates from an arbitrary
 * slice and quietly returns a worse playlist, which is a nastier failure than an error.
 *
 * So the model is asked twice: once for a plan (what genres, artists and years is this
 * request about?) against a summary small enough to fit easily, and once for the actual
 * picks against only the tracks that plan selects. Everything here is the pure middle
 * step — no model, no database — so the rules about widening, sampling and budget can be
 * tested directly rather than inferred from a playlist that came out wrong.
 */

export interface CatalogTrack {
  id: number;
  artist: string;
  title: string;
  album: string;
  year: number | null;
  genres: string;
}

/** What the model asks for in stage one. Every field is guidance, not a contract. */
export interface SelectionPlan {
  genres: string[];
  artists: string[];
  fromYear: number | null;
  toYear: number | null;
}

/**
 * Roughly 20,000 tokens at four characters each.
 *
 * The stage-one call, the system prompt and the model's own reply all draw on the same
 * per-minute budget, so this deliberately leaves a good share of it spare.
 */
export const CATALOG_CHAR_BUDGET = 80_000;

/**
 * Below this, a plan has narrowed to something too thin to curate from — usually because
 * the model named a genre the library spells differently. Widening beats handing the
 * curator twelve tracks and asking for twenty.
 */
export const MIN_POOL = 40;

export function line(t: CatalogTrack): string {
  const year = t.year ? `, ${t.year}` : '';
  const genres = t.genres ? ` [${t.genres}]` : '';
  return `${t.id}\t${t.artist} — ${t.title} (${t.album}${year})${genres}`;
}

const splitGenreValues = (s: string): string[] =>
  s
    .split(',')
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);

function matches(t: CatalogTrack, plan: SelectionPlan): boolean {
  if (plan.fromYear && (!t.year || t.year < plan.fromYear)) return false;
  if (plan.toYear && (!t.year || t.year > plan.toYear)) return false;

  const wantGenres = plan.genres.map((g) => g.trim().toLowerCase()).filter(Boolean);
  const wantArtists = new Set(plan.artists.map(norm).filter(Boolean));
  // A plan naming neither is a pure year filter, not a request for nothing.
  if (!wantGenres.length && !wantArtists.size) return true;

  if (wantArtists.has(norm(t.artist))) return true;
  const mine = splitGenreValues(t.genres);
  return wantGenres.some((g) => mine.includes(g));
}

/**
 * Take one track from each artist in turn, then a second from each, and so on.
 *
 * The obvious trim — slice the first N — is sorted by artist, so it would hand the
 * curator every track by the first few dozen artists alphabetically and nothing at all
 * by the rest. Round-robin spends the budget on breadth instead, and being deterministic
 * it can be tested and gives the same library the same candidate pool every time.
 */
function roundRobinByArtist(tracks: CatalogTrack[], budget: number): CatalogTrack[] {
  const byArtist = new Map<string, CatalogTrack[]>();
  for (const t of tracks) {
    const k = norm(t.artist);
    const bucket = byArtist.get(k);
    if (bucket) bucket.push(t);
    else byArtist.set(k, [t]);
  }
  const queues = [...byArtist.values()];
  const out: CatalogTrack[] = [];
  let spent = 0;
  for (let round = 0; ; round += 1) {
    let placedAny = false;
    for (const q of queues) {
      const t = q[round];
      if (!t) continue;
      const cost = line(t).length + 1;
      if (spent + cost > budget) return out;
      out.push(t);
      spent += cost;
      placedAny = true;
    }
    if (!placedAny) return out;
  }
}

export interface Narrowed {
  tracks: CatalogTrack[];
  /** True when the budget forced tracks out of an otherwise-eligible pool. */
  sampled: boolean;
  /** How many tracks the plan actually selected, before any budget trim. */
  matched: number;
  /** True when the plan matched too little and the whole library was used instead. */
  widened: boolean;
}

/**
 * Reduce a library to a candidate pool that fits `budget` characters of catalog lines.
 *
 * A null plan (stage one failed, or was skipped) is not an error: the library is simply
 * used whole and the budget does the work. Failing a build because the cheap planning
 * call hiccuped would be a worse trade than curating from a broad sample.
 */
export function narrow(
  catalog: CatalogTrack[],
  plan: SelectionPlan | null,
  opts: { budget?: number; minPool?: number } = {},
): Narrowed {
  const budget = opts.budget ?? CATALOG_CHAR_BUDGET;
  const minPool = opts.minPool ?? MIN_POOL;
  const selected = plan ? catalog.filter((t) => matches(t, plan)) : catalog;
  const widened = selected.length < minPool && catalog.length > selected.length;
  const pool = widened ? catalog : selected;

  const total = pool.reduce((n, t) => n + line(t).length + 1, 0);
  if (total <= budget) {
    return { tracks: pool, sampled: false, matched: selected.length, widened };
  }
  return {
    tracks: roundRobinByArtist(pool, budget),
    sampled: true,
    matched: selected.length,
    widened,
  };
}
