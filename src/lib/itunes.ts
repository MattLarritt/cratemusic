import { getJson } from './http.js';
import type { Store } from './store.js';

/**
 * iTunes previews — thirty seconds of a song before you commit to fetching it.
 *
 * Apple's Search API needs no key and no account, which is the whole reason it
 * is here rather than Spotify: a preview is worth having only if it works for
 * everyone with no setup, and Spotify withdrew its preview URLs from new
 * applications. Deezer also publishes previews and is already a dependency for
 * artist images, but its catalogue is thinner for the back catalogue crate
 * deals in, and Apple returns a usable match for more of it.
 *
 * The audio itself is NOT proxied. Apple serves the clips over HTTPS from
 * audio-ssl.itunes.apple.com and the browser can fetch them directly, so
 * putting crate in the middle would spend its bandwidth to no purpose.
 */

const API = 'https://itunes.apple.com/search';

/**
 * A month.
 *
 * Preview URLs are stable but not permanent — Apple re-encodes and the asset
 * path moves — so unlike a MusicBrainz tracklist these cannot be kept forever.
 * A stale URL is a preview that 404s, which reads as a broken button.
 */
const TTL = 30 * 86400;

/**
 * Apple does not publish a rate limit; the widely reported figure is around
 * twenty calls a minute per address, and a burst earns a 403. Previews are
 * clicked one at a time by a person, so the realistic risk is not a user but
 * a page that fires a lookup per row on render — which is why nothing here is
 * called until somebody actually presses play.
 */
const MIN_GAP_MS = 250;

export interface Preview {
  url: string;
  /** What Apple matched, so the UI can admit when it is not quite the same take. */
  trackName: string;
  artistName: string;
  albumName: string;
}

interface Result {
  previewUrl?: string;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  kind?: string;
}

/** Case, accents and punctuation folded away, for comparing two titles. */
function norm(v: string): string {
  return v
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Drop the parenthetical tail: "Song (Remastered 2011)" -> "song".
 *
 * Used only to RANK, never to match. A remaster is the same performance and a
 * fine preview; a remix is not, so the full title still wins when it is there.
 */
function bare(v: string): string {
  return norm(v.replace(/[([].*$/, ''));
}

export class ITunes {
  private chain: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  constructor(
    private store: Store,
    private warn: (msg: string) => void = () => {},
  ) {}

  /** Serialise and space out calls, so a page of previews cannot burst into a 403. */
  private gate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = Math.max(0, this.lastAt + MIN_GAP_MS - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastAt = Date.now();
      return fn();
    });
    // The chain must survive a rejection or every later preview inherits it.
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * The best preview for a song, or null when Apple has nothing.
   *
   * Null is cached too. A song Apple does not carry will still not be carried
   * tomorrow, and without caching the miss every hover over an obscure B-side
   * would spend a call to be told the same thing.
   */
  async preview(artist: string, title: string): Promise<Preview | null> {
    const ck = `itunes:${norm(artist)}|${norm(title)}`;
    const hit = this.store.cached<Preview | null>(ck, TTL);
    if (hit !== undefined) return hit;

    const wantArtist = norm(artist);
    const wantTitle = norm(title);
    const wantBare = bare(title);

    /** Rank Apple's results against the title actually asked for. */
    const pick = (results: Result[]): Preview | null => {
      let best: { r: Result; score: number } | null = null;
      for (const r of results) {
        if (!r.previewUrl || !r.trackName || !r.artistName) continue;
        const gotArtist = norm(r.artistName);
        const gotTitle = norm(r.trackName);

        // The artist has to be right. Apple's search is a relevance ranking
        // over the whole catalogue, so a title-only match happily returns a
        // covers-album version by somebody else — which is a worse outcome
        // than no preview, because it sounds like the library is wrong.
        if (gotArtist !== wantArtist && !gotArtist.startsWith(wantArtist + ' ')) continue;

        /*
         * Four tiers, and the middle two are the ones that earn their keep.
         *
         * A library tagged "Milk It (Album Version)" wants Apple's plain
         * "Milk It" — the same recording under a tidier name — and must NOT
         * settle for "Milk It (Live in Seattle)", which also survives having
         * its parenthetical stripped and is a different performance. Ranking
         * a clean title above a merely-same-stem one separates them; without
         * that they tie and whichever Apple listed first wins.
         */
        const score =
          gotTitle === wantTitle ? 4
          : gotTitle === wantBare ? 3
          : bare(gotTitle) === wantBare ? 2
          : gotTitle.startsWith(wantBare) ? 1
          : 0;
        if (score === 0) continue;
        if (!best || score > best.score) best = { r, score };
        if (score === 4) break;
      }
      return best
        ? {
            url: best.r.previewUrl!,
            trackName: best.r.trackName!,
            artistName: best.r.artistName!,
            albumName: best.r.collectionName ?? '',
          }
        : null;
    };

    const search = async (term: string): Promise<Result[]> => {
      const clean = term.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if (!clean) return [];
      const body = await this.gate(() =>
        getJson<{ results?: Result[] }>(
          `${API}?media=music&entity=song&limit=12&term=${encodeURIComponent(clean)}`,
          { timeoutMs: 8_000 },
        ),
      );
      return body.results ?? [];
    };

    try {
      let out = pick(await search(`${artist} ${title}`));

      /*
       * Retry without the parenthetical, because Apple's search is unforgiving
       * of it in a way that is easy to mistake for a missing song. Measured:
       * "Nirvana Milk It Album Version" returns ZERO results, "Nirvana Milk It"
       * returns four including the one wanted. Tags like "(Album Version)",
       * "(Remastered 2011)" and "(feat. …)" are all over an exported library,
       * so without this a large slice of rows would show no preview for a song
       * Apple plainly has. The second call happens only on a miss.
       */
      if (!out) {
        const stripped = title.replace(/[([].*$/, '').trim();
        if (stripped && norm(stripped) !== wantTitle) {
          out = pick(await search(`${artist} ${stripped}`));
        }
      }

      this.store.putCache(ck, out);
      return out;
    } catch (err) {
      // A failed preview is not worth failing a page over, and must not be
      // cached: unlike "Apple has no such song", this says nothing about
      // whether it does.
      this.warn(
        `itunes preview failed for "${artist} — ${title}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }
}
