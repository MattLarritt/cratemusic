/**
 * Recommendations: one mixed set of songs, scored against what somebody actually plays.
 *
 * THE SIGNAL. Play counts, not library membership. Adding a track is a guess somebody made
 * once; playing it forty times is a fact. So the profile comes from `plays`, weighted by
 * count with a mild recency lean and reduced by skips — a track reached for and abandoned is
 * evidence, and counting it as a preference would make the suggestions worse the more
 * somebody skipped.
 *
 * FOUR SOURCES, deliberately. Scoring one candidate pool and taking the top 50 produces 50
 * variations on whatever Last.fm is most confident about, which reads as a broken feature
 * even when every individual pick is defensible. So candidates come from four genuinely
 * different places and are interleaved:
 *
 *   pool-similar  on disk already, by artists close to what they play — instant to add, and
 *                 therefore the most valuable thing here: no download, no wait, no bandwidth
 *   deep-cut      on disk, by an artist they ALREADY play, from an album they do not hold.
 *                 The safest recommendation there is, and free
 *   similar       artists Last.fm places near their favourites; needs downloading
 *   track-similar seeded from individual most-played songs rather than artists, which finds
 *                 things an artist-level lookup misses — the one dance track a rock listener
 *                 loves leads somewhere an artist graph will not
 *
 * SCORING sums affinity across seeds rather than taking the best match. An artist that three
 * of your favourites all point at is a better bet than one a single favourite points at
 * strongly, and summing is what expresses that. Availability in the pool is a real bonus
 * because "instant" is a genuine property of a recommendation, not a technicality.
 *
 * DIVERSITY CAPS are what make it a mix rather than a ranking: at most three tracks by one
 * artist and two from one album, then round-robin across the four sources. Without the caps
 * the list collapses; with them it stays varied even when the scores do not.
 *
 * Computed sets are cached per user, because this is a dozen Last.fm calls and the front page
 * should not pay for them on every load.
 */

import type { LastFm } from './lastfm.js';
import type { Store } from './store.js';
import type { Algo } from './algo.js';
import { norm } from './release.js';
import type { PoolTrack, UserLibrary } from './userlib.js';

export type RecSource = 'pool-similar' | 'deep-cut' | 'similar' | 'track-similar';

export interface RecTrack {
  /** 0 when it is not on disk and would have to be downloaded. */
  trackId: number;
  title: string;
  artistName: string;
  /** Who the ALBUM belongs to — what an album tile must show. A compilation track is
   * credited to its performer (Gorillaz), but the record is Elton John's. */
  albumArtistName?: string;
  albumTitle: string;
  durationS: number | null;
  onDisk: boolean;
  score: number;
  source: RecSource;
  /** Human reason, shown on the card. Recommendations people cannot interrogate feel random. */
  because: string;
}

export interface RecSet {
  tracks: RecTrack[];
  artists: { name: string; score: number; because: string }[];
  albums: { artistName: string; albumTitle: string; onDisk: boolean; because: string }[];
  /** True when there was nothing to reason from and this is a generic answer. */
  cold: boolean;
}

/** Seeds beyond this add latency and little signal — the tail is already well covered. */
const MAX_SEEDS = 8;
const MAX_TRACK_SEEDS = 5;
const PER_ARTIST_CAP = 3;
const PER_ALBUM_CAP = 2;
const CACHE_TTL_S = 6 * 3600;

export class Recommender {
  constructor(
    private store: Store,
    private userlib: UserLibrary,
    private algo: Algo,
    private lastfm: LastFm,
  ) {}

  /**
   * A mixed set for one user.
   *
   * `size` is the number of songs asked for; artists and albums are derived from the same
   * scoring so the three rows on the front page agree with each other rather than telling
   * three unrelated stories.
   */
  async forUser(userId: number, size = 50): Promise<RecSet> {
    const cacheKey = `rec:v3:${userId}:${size}`;
    const cached = this.store.cached<RecSet>(cacheKey, CACHE_TTL_S);
    if (cached) return cached;

    const built = await this.build(userId, size);
    this.store.putCache(cacheKey, built);
    return built;
  }

  /**
   * Throw away a user's cached set.
   *
   * Called from every mutation that changes what should be recommended: a play, a skip, a
   * library add or remove, an exclude, a completed download. The TTL alone is not enough —
   * six hours of a stale set is how a deleted album keeps reappearing on the front page.
   */
  invalidate(userId: number): void {
    this.store.dropCachePrefix(`rec:v3:${userId}:`);
  }

  /** Every user's set, for a change that can affect all of them — an admin purge. */
  invalidateAll(): void {
    this.store.dropCachePrefix('rec:v3:');
  }

  private async build(userId: number, size: number): Promise<RecSet> {
    const profile = this.userlib.listeningProfile(userId, MAX_SEEDS);
    // Fall back to what they have chosen when they have not played anything yet. A guess
    // beats an empty page, and the `cold` flag lets the UI say so honestly.
    const seeds = profile.length
      ? profile
      : this.userlib.seedArtists(userId, MAX_SEEDS).map((a) => ({ name: a.name, weight: a.tracks }));
    const cold = profile.length === 0;

    const excludedArtists = this.userlib.excludedArtists(userId);
    /*
     * The active algorithm profile speaks here too. Warmth 0 on an artist is
     * "prefer zero songs like this" — an exclusion in different clothes — and
     * high warmth multiplies the artist's similarity weight, so a mood
     * profile tilts discovery the same direction it tilts the library.
     */
    const warmth = this.algo.artistWarmths(userId);
    for (const [key, w] of warmth) if (w === 0) excludedArtists.add(key);
    const warmthBoost = (key: string): number => {
      const w = warmth.get(key);
      // 2.5 is neutral; the range works out to ×0.4 at warmth 1, ×1.6 at 5.
      return w === undefined ? 1 : 0.4 + w * 0.24;
    };
    // Artists already in the library, not just already played.
    //
    // The filter used to test the play profile alone, so somebody with no play history was
    // recommended the artists sitting in their own library — "you might like Limp Bizkit" to
    // a listener who owns Limp Bizkit. Having it is reason enough not to suggest it.
    const ownedArtists = new Set(this.userlib.seedArtists(userId, 500).map((a) => norm(a.name)));
    const mine = new Set(this.userlib.mine(userId, 20_000).map((t) => t.trackId));
    // Anything they took out of their library on purpose. The file is still in the pool, which
    // is exactly what would otherwise make it a candidate again — so a deliberate removal
    // would come straight back as a suggestion.
    const removed = this.userlib.removedTracks(userId);
    const rejected = (id: number): boolean => mine.has(id) || removed.has(id);
    const playedArtists = new Set(profile.map((p) => norm(p.name)));

    const candidates = new Map<string, RecTrack>();
    const add = (c: RecTrack): void => {
      const key = `${norm(c.artistName)}|${norm(c.title)}`;
      const prior = candidates.get(key);
      // Same song reached from two sources: keep the higher score but remember the cheaper
      // source, since "already on disk" is the more useful thing to tell somebody.
      if (prior) {
        prior.score += c.score * 0.5;
        if (c.onDisk && !prior.onDisk) {
          prior.onDisk = true;
          prior.trackId = c.trackId;
          prior.source = c.source;
          prior.because = c.because;
        }
        return;
      }
      candidates.set(key, c);
    };

    // ---- similarity graph, once ------------------------------------------
    // display carries Last.fm's own spelling. The key has to be normalised to merge hits
    // across seeds, but showing that key to somebody renders "daron malakian and scars on
    // broadway" as a recommendation, which reads as a bug even when the match is right.
    const similarity = new Map<string, { score: number; display: string; because: Set<string> }>();
    if (this.lastfm.enabled && seeds.length) {
      const total = seeds.reduce((n, s) => n + s.weight, 0) || 1;
      for (const seed of seeds) {
        const share = seed.weight / total;
        const similar = await this.lastfm.similarArtists(seed.name).catch(() => []);
        for (const s of similar.slice(0, 25)) {
          const key = norm(s.name);
          if (!key || excludedArtists.has(key)) continue;
          if (playedArtists.has(key) || ownedArtists.has(key)) continue;
          const cur = similarity.get(key) ?? {
            score: 0,
            display: s.name,
            because: new Set<string>(),
          };
          // match is Last.fm's 0..1 confidence; share weights it by how much this listener
          // actually cares about the seed.
          cur.score += s.match * share;
          cur.because.add(seed.name);
          similarity.set(key, cur);
        }
      }
    }

    // ---- 1. pool-similar: on disk, by a similar artist -------------------
    for (const [artistKey, sim] of similarity) {
      for (const t of this.poolByArtist(artistKey)) {
        if (rejected(t.trackId)) continue;
        add({
          trackId: t.trackId,
          title: t.title,
          artistName: t.artistName,
          albumArtistName: t.albumArtistName,
          albumTitle: t.albumTitle,
          durationS: t.durationS,
          onDisk: true,
          // Availability is worth a lot: no download, no wait, nothing metered.
          score: sim.score * 100 + 40,
          source: 'pool-similar',
          because: `already here · like ${[...sim.because][0]}`,
        });
      }
    }

    // ---- 2. deep cuts: on disk, by an artist they already play -----------
    for (const p of profile) {
      for (const t of this.poolByArtist(norm(p.name))) {
        if (rejected(t.trackId)) continue;
        add({
          trackId: t.trackId,
          title: t.title,
          artistName: t.artistName,
          albumArtistName: t.albumArtistName,
          albumTitle: t.albumTitle,
          durationS: t.durationS,
          onDisk: true,
          // Below a strong similarity hit, above a weak one: safe, free, but not discovery.
          score: 60 + Math.min(30, p.weight),
          source: 'deep-cut',
          because: `more ${p.name}, already here`,
        });
      }
    }

    // ---- 3. similar artists, needing a download --------------------------
    // Real song titles from artist.getTopTracks, one cached call per artist.
    // This used to add a placeholder called "Top tracks by X", which was fine
    // while the shelf was display-only and became a lie the moment tiles could
    // act: someone clicked one and was told no album contains that song —
    // correctly, because it was never a song. Nothing fabricated goes in the
    // candidate list any more; an artist whose lookup fails is simply carried
    // by the artists row instead.
    // Warmth tilts the whole ranking in one place, after the graph is built:
    // every consumer below — tracks, artists, albums — inherits the same lean.
    for (const [key, sim] of similarity) sim.score *= warmthBoost(key);
    const ranked = [...similarity.entries()].sort((a, b) => b[1].score - a[1].score);
    /*
     * The one loop here that costs a network call per iteration, so it is the
     * one that does NOT simply scale with `size`. Thirty artists at three
     * tracks yields ninety candidates, enough to fill a hundred-song set
     * alongside the other sources, for fifty per cent more Last.fm calls
     * rather than five times as many.
     */
    for (const [key, sim] of ranked.slice(0, 30)) {
      // Prefer the pool's spelling when crate holds the artist, else Last.fm's. Never the key.
      const display = this.displayName(key) ?? sim.display;
      const tops = await this.lastfm.artistTopTracks(display, 3).catch(() => []);
      for (const tt of tops) {
        add({
          trackId: 0,
          title: tt.title,
          artistName: display,
          albumTitle: '',
          durationS: null,
          onDisk: false,
          score: sim.score * 100,
          source: 'similar',
          because: `like ${[...sim.because].slice(0, 2).join(' and ')}`,
        });
      }
    }

    // ---- 4. artists similar to individual most-played SONGS --------------
    //
    // Last.fm's track.getSimilar returns artists, not track titles, so this widens the
    // similarity graph rather than naming songs directly. It is worth its own source anyway:
    // an artist-level lookup averages somebody's whole taste, while this follows one song —
    // which is how the single dance track a rock listener loves leads somewhere an artist
    // graph will not.
    if (this.lastfm.enabled) {
      const top = this.userlib.mostPlayed(userId, MAX_TRACK_SEEDS);
      for (const t of top) {
        const similar = await this.lastfm.similarFromTrack(t.artistName, t.title).catch(() => []);
        for (const s of similar.slice(0, 10)) {
          const artistKey = norm(s.name);
          if (!artistKey || excludedArtists.has(artistKey) || ownedArtists.has(artistKey)) continue;

          // Prefer something of theirs already on disk; otherwise recommend the artist.
          const inPool = this.poolByArtist(artistKey).find((p) => !rejected(p.trackId));
          if (inPool) {
            add({
              trackId: inPool.trackId,
              title: inPool.title,
              artistName: inPool.artistName,
              albumArtistName: inPool.albumArtistName,
              albumTitle: inPool.albumTitle,
              durationS: inPool.durationS,
              onDisk: true,
              score: s.match * 90 + 40,
              source: 'track-similar',
              because: `because you play ${t.title}`,
            });
          } else {
            // Same rule as source 3: a real title or nothing. One track per
            // artist here — this source exists to widen the graph, not fill
            // the shelf, and each lookup is a (cached) Last.fm call.
            const [tt] = await this.lastfm.artistTopTracks(s.name, 1).catch(() => []);
            if (tt) {
              add({
                trackId: 0,
                title: tt.title,
                artistName: s.name,
                albumTitle: '',
                durationS: null,
                onDisk: false,
                score: s.match * 80,
                source: 'track-similar',
                because: `because you play ${t.title}`,
              });
            }
          }
        }
      }
    }

    const tracks = this.mix([...candidates.values()], size);

    // Artists and albums come off the same scoring, so the three front-page rows agree.
    const artists = ranked.slice(0, size).map(([key, sim]) => ({
      name: this.displayName(key) ?? sim.display,
      score: Math.round(sim.score * 100),
      because: `like ${[...sim.because].slice(0, 2).join(' and ')}`,
    }));

    /*
     * Albums come from the WHOLE candidate pool, not just the mixed track list.
     *
     * The mix exists to be a varied SONG list, so it caps itself at three tracks per
     * artist and two per album — which starved the albums row: a hundred candidates
     * collapsed to a couple of dozen albums by a handful of artists. The pool has no such
     * caps, so scanning it by score surfaces far more records while the mix keeps doing
     * its own job.
     */
    const albumSeen = new Set<string>();
    const albums: RecSet['albums'] = [];
    for (const t of [...candidates.values()].sort((a, b) => b.score - a.score)) {
      if (!t.albumTitle) continue;
      // The album belongs to its ALBUM artist. Keying and labelling on the track credit
      // filed The Lockdown Sessions under Gorillaz because one featured track was.
      const owner = t.albumArtistName || t.artistName;
      const key = `${norm(owner)}|${norm(t.albumTitle)}`;
      if (albumSeen.has(key)) continue;
      albumSeen.add(key);
      albums.push({
        artistName: owner,
        albumTitle: t.albumTitle,
        onDisk: t.onDisk,
        because: t.because,
      });
      if (albums.length >= size) break;
    }

    return { tracks, artists, albums, cold };
  }

  /**
   * Interleave the sources and apply the diversity caps.
   *
   * Round-robin rather than sort-by-score, because the point of the caps is defeated if the
   * first fifteen entries are all one source. Each source contributes its own best first, so
   * the list opens with something instant, something familiar and something new.
   */
  private mix(all: RecTrack[], size: number): RecTrack[] {
    const bySource = new Map<RecSource, RecTrack[]>();
    for (const c of all) {
      const list = bySource.get(c.source) ?? [];
      list.push(c);
      bySource.set(c.source, list);
    }
    for (const list of bySource.values()) list.sort((a, b) => b.score - a.score);

    // Instant things first in the rotation: they cost nothing to accept.
    const order: RecSource[] = ['pool-similar', 'deep-cut', 'track-similar', 'similar'];
    const perArtist = new Map<string, number>();
    const perAlbum = new Map<string, number>();
    const out: RecTrack[] = [];
    const cursor = new Map<RecSource, number>();

    while (out.length < size) {
      let progressed = false;
      for (const source of order) {
        if (out.length >= size) break;
        const list = bySource.get(source) ?? [];
        let i = cursor.get(source) ?? 0;

        while (i < list.length) {
          const c = list[i];
          i++;
          if (!c) continue;
          const aKey = norm(c.artistName);
          const alKey = `${aKey}|${norm(c.albumTitle)}`;
          if ((perArtist.get(aKey) ?? 0) >= PER_ARTIST_CAP) continue;
          if (c.albumTitle && (perAlbum.get(alKey) ?? 0) >= PER_ALBUM_CAP) continue;

          perArtist.set(aKey, (perArtist.get(aKey) ?? 0) + 1);
          if (c.albumTitle) perAlbum.set(alKey, (perAlbum.get(alKey) ?? 0) + 1);
          out.push(c);
          progressed = true;
          break;
        }
        cursor.set(source, i);
      }
      // Every source is exhausted or capped out; padding further would only repeat artists.
      if (!progressed) break;
    }
    return out;
  }

  private poolByArtist(normArtist: string): PoolTrack[] {
    return this.store.poolByNormArtist(normArtist);
  }

  private poolByTitle(normArtist: string, normTitle: string): PoolTrack | null {
    return this.store.poolByNormTitle(normArtist, normTitle);
  }

  private displayName(normArtist: string): string | null {
    return this.store.artistDisplayName(normArtist);
  }
}
