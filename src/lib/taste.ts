import type { LastFm, Similar } from './lastfm.js';
import type { Library } from './library.js';
import type { Store, Seed } from './store.js';

/**
 * The taste layer: what this listener likes, and what to suggest next.
 *
 * Everything joins on artist NAME rather than MusicBrainz ID. That is not a
 * shortcut — the files in this library carry no MusicBrainz tags at all, so a name
 * is the only key the library, MusicBrainz and Last.fm all share. Names are
 * normalised for comparison only; the
 * display form is always whatever the source gave us.
 */

/** Case and punctuation differences are not real differences between artists. */
export function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface Suggestion {
  name: string;
  /** Summed Last.fm match across every seed that pointed here. */
  score: number;
  /** Which held or played artists led to this suggestion, for "because you like…". */
  because: string[];
}

/**
 * Refresh the seed table from what is actually on disk.
 *
 * Reads crate's own library index rather than Lidarr's. Lidarr's library holds a
 * row for every album of every artist it has been told about, so seeding from it
 * let a single request snowball into a page of suggestions derived from albums
 * that were never downloaded. The index counts audio files, so only music that
 * exists can influence taste.
 *
 * Called on a timer rather than per request, and recording a seed only ever raises
 * its weight, so a refresh cannot demote something the user played.
 */
export function refreshSeedsFromLibrary(library: Library, store: Store): { artists: number } {
  const artists = library.artists(500);
  for (const a of artists) {
    if (a.name && a.trackFiles > 0) store.noteSeed(a.name, 'library');
  }
  return { artists: artists.length };
}

/**
 * Rank candidate artists from a set of seeds.
 *
 * Scores are summed rather than maxed: an artist that several of your seeds
 * point at is a better bet than one that a single seed points at strongly, and
 * summing is what expresses that.
 */
export async function suggest(
  lastfm: LastFm,
  seeds: { name: string; weight: number }[],
  exclude: Set<string>,
  opts: { perSeed?: number; limit?: number } = {},
): Promise<Suggestion[]> {
  const perSeed = opts.perSeed ?? 25;
  const limit = opts.limit ?? 40;

  const scored = new Map<string, { name: string; score: number; because: Set<string> }>();

  // Sequential rather than parallel: these are nearly all cache hits after the
  // first load, and a burst of parallel misses is exactly the traffic pattern
  // Last.fm asks clients to avoid.
  for (const seed of seeds) {
    const similar = await lastfm.similarArtists(seed.name, perSeed);
    for (const s of similar) {
      const key = normalise(s.name);
      if (!key || exclude.has(key)) continue;
      const cur = scored.get(key) ?? { name: s.name, score: 0, because: new Set<string>() };
      cur.score += s.match * seed.weight;
      cur.because.add(seed.name);
      scored.set(key, cur);
    }
  }

  return [...scored.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => ({ name: s.name, score: Number(s.score.toFixed(4)), because: [...s.because] }));
}

/** Seeds plus everything dismissed — the set discovery must never surface. */
export function excludeSet(seeds: Seed[], held: { name: string }[], store: Store): Set<string> {
  const out = store.dismissedNames();
  for (const s of seeds) out.add(normalise(s.name));
  for (const h of held) out.add(normalise(h.name));
  return out;
}

/**
 * Rank similar artists from an arbitrary caller-supplied set of seeds.
 *
 * This backs POST /api/similar, which exists so the recommendation engine is
 * usable from outside the front end — a script can post a list of artists and
 * tracks and get suggestions back without a browser session.
 */
export async function suggestFromInput(
  lastfm: LastFm,
  input: { artists?: string[]; tracks?: { artist: string; title: string }[] },
  exclude: Set<string>,
  limit = 40,
): Promise<Suggestion[]> {
  const scored = new Map<string, { name: string; score: number; because: Set<string> }>();

  const add = (from: string, list: Similar[], weight: number) => {
    for (const s of list) {
      const key = normalise(s.name);
      if (!key || exclude.has(key)) continue;
      const cur = scored.get(key) ?? { name: s.name, score: 0, because: new Set<string>() };
      cur.score += s.match * weight;
      cur.because.add(from);
      scored.set(key, cur);
    }
  };

  for (const a of input.artists ?? []) {
    if (!a.trim()) continue;
    add(a, await lastfm.similarArtists(a), 1);
  }
  // Track seeds weigh more: naming a specific track says which part of an
  // artist's range was meant, which an artist name alone cannot.
  for (const t of input.tracks ?? []) {
    if (!t.artist?.trim() || !t.title?.trim()) continue;
    add(`${t.artist} — ${t.title}`, await lastfm.similarFromTrack(t.artist, t.title), 1.5);
  }

  return [...scored.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => ({ name: s.name, score: Number(s.score.toFixed(4)), because: [...s.because] }));
}
