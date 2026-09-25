import { norm } from './release.js';

/**
 * Find songs by the words of a query, spread across title, artist and album.
 *
 * OpenSubsonic's search3 matches the WHOLE query as a substring of one field, which is right
 * for a search box ("linkin park", "numb") and wrong for anything spoken. A voice request
 * arrives as "song 2 by blur" or "numb linkin park" — title and artist run together — and no
 * single field contains that string, so a song you own reads as missing.
 *
 * That used to cost nothing worse than "no results". With an external source behind search3
 * it would cost much more: a song you own falling through to YouTube and playing somebody
 * else's upload instead of your copy. So before the fallback is allowed, this looks again,
 * word by word, and owning the song always wins.
 *
 * Whole words, via norm(), so "on" does not match "Only". A few joining words are dropped
 * because nobody means them as part of the song — "by" in particular is how people ask.
 */

const FILLER = new Set(['by', 'feat', 'ft', 'featuring', 'and', 'the', 'a', 'of']);

export interface MatchFields {
  title: string;
  artistName: string;
  albumArtistName?: string;
  albumTitle?: string;
}

export function wordsOf(q: string): string[] {
  const words = norm(q).split(' ').filter(Boolean);
  const meaningful = words.filter((w) => !FILLER.has(w));
  // "The The" is a band. A query made of nothing but filler keeps its words.
  return meaningful.length ? meaningful : words;
}

/**
 * Songs containing every word somewhere across their fields, best first.
 *
 * Best means most of the words are in the TITLE: for "song 2 blur", a song called Song 2 by
 * Blur beats a song called Blur by somebody on an album called Song 2. Ties keep library order.
 */
export function matchWords<T extends MatchFields>(rows: T[], q: string): T[] {
  const words = wordsOf(q);
  if (!words.length) return [];
  const scored: { row: T; titleHits: number; i: number }[] = [];
  rows.forEach((row, i) => {
    const title = new Set(norm(row.title).split(' '));
    const all = new Set(
      norm([row.title, row.artistName, row.albumArtistName ?? '', row.albumTitle ?? ''].join(' ')).split(' '),
    );
    if (!words.every((w) => all.has(w))) return;
    scored.push({ row, titleHits: words.filter((w) => title.has(w)).length, i });
  });
  return scored.sort((a, b) => b.titleHits - a.titleHits || a.i - b.i).map((s) => s.row);
}
