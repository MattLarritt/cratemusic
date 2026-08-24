import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getJson } from './http.js';
import type { Settings } from './settings.js';

const run = promisify(execFile);

/**
 * Identify audio by what it sounds like, not what its tags claim.
 *
 * Two halves with very different privacy profiles, and the split is the point:
 * fpcalc (Chromaprint) computes the fingerprint LOCALLY — the audio never
 * leaves the machine. Matching that fingerprint to a MusicBrainz recording
 * means asking api.acoustid.org, because the fingerprint database lives there,
 * not in MusicBrainz — a recording page's Fingerprints tab on musicbrainz.org
 * is a live call to AcoustID dressed up as local data, which is exactly the
 * confusion that prompted this comment. What crosses the network is a hash and
 * a duration, nothing else.
 *
 * Key-gated and off by default, like Last.fm: no key, no network call, and
 * uploads simply fall back to tags.
 */

const API = 'https://api.acoustid.org/v2/lookup';

/** AcoustID asks for no more than 3 requests per second per application. */
const MIN_GAP_MS = 350;

export interface AcoustMatch {
  recordingMbid: string;
  title: string;
  artist: string;
  releaseGroupMbid: string | null;
  album: string;
  /** 0..1 from AcoustID — how confident the fingerprint match itself is. */
  score: number;
}

/** One place this recording could belong, with crate's own opinion of how likely it is. */
export interface AcoustCandidate extends AcoustMatch {
  /** Album, EP, Single, Broadcast… as MusicBrainz types it. */
  albumType: string;
  /** Compilation, Live, Soundtrack… empty for a plain release. */
  secondaryTypes: string[];
  /** crate's ranking, not AcoustID's. Higher is likelier. See identifyAll. */
  rank: number;
}

interface LookupBody {
  status?: string;
  error?: { message?: string };
  results?: {
    score?: number;
    recordings?: {
      id?: string;
      title?: string;
      artists?: { name?: string }[];
      releasegroups?: { id?: string; title?: string; type?: string; secondarytypes?: string[] }[];
    }[];
  }[];
}

type Group = { id?: string; title?: string; type?: string; secondarytypes?: string[] };

/**
 * How much a release group recommends its recording, highest first.
 *
 *   Album  the record it came out on — what a listener means by "the album"
 *   EP     often the real home of a single: Bad Romance lives on The Fame Monster
 *   Single what it was released as, better than a hits compilation
 *   other  soundtracks, live albums, broadcasts
 *   comp   last resort. A track appears on dozens of these and none of them is
 *          where anyone looks for it.
 */
function groupBonus(g: Group | undefined): number {
  if (!g) return -1;
  const secondary = g.secondarytypes ?? [];
  if (secondary.some((t) => /compilation/i.test(t))) return -0.5;
  if (secondary.length) return 0;
  if (g.type === 'Album') return 1;
  if (g.type === 'EP') return 0.9;
  if (g.type === 'Single') return 0.6;
  return 0.2;
}

/** The most album-like of a recording's release groups. */
function bestGroup(groups: Group[]): Group | undefined {
  let best: Group | undefined;
  for (const g of groups) {
    if (!g.id) continue;
    if (!best || groupBonus(g) > groupBonus(best)) best = g;
  }
  return best;
}

/** Compare-only normalisation, local so this module depends on nothing else. */
function norm(v: string): string {
  return v
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export class AcoustId {
  private chain: Promise<unknown> = Promise.resolve();
  private lastAt = 0;
  /** fpcalc missing from the image is a build problem, warned once not per file. */
  private fpcalcBroken = false;

  constructor(
    private settings: Settings,
    private warn: (msg: string) => void = () => {},
  ) {}

  enabled(): boolean {
    return Boolean(this.settings.all().acoustidKey);
  }

  private gate<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      const wait = Math.max(0, this.lastAt + MIN_GAP_MS - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastAt = Date.now();
      return fn();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** The local half: hash the audio. Null when fpcalc cannot read the file. */
  async fingerprint(path: string): Promise<{ fingerprint: string; duration: number } | null> {
    if (this.fpcalcBroken) return null;
    try {
      const { stdout } = await run('fpcalc', ['-json', path], { timeout: 30_000 });
      const d = JSON.parse(stdout) as { fingerprint?: string; duration?: number };
      if (!d.fingerprint || !d.duration) return null;
      return { fingerprint: d.fingerprint, duration: Math.round(d.duration) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/ENOENT/.test(msg)) {
        this.fpcalcBroken = true;
        this.warn('fpcalc is not in the image — AcoustID identification is off');
      }
      return null;
    }
  }

  /**
   * The network half: fingerprint to the best recording match.
   *
   * RANKING IS THE WHOLE PROBLEM HERE, so it is worth spelling out. A fingerprint of Lady
   * Gaga's "Bad Romance" comes back with dozens of recordings — the original, a Glee Cast
   * cover, and karaoke acts — and the best fingerprint score belonged to "Audiogroove", whose
   * only release group is a compilation called "100% Top 40". Ranking on score alone chose
   * exactly that, so an upload of Bad Romance offered to file it under Audiogroove.
   *
   * The correct answer was in the same response the whole time: Lady Gaga's own recordings
   * list "The Fame Monster" and "The Fame" as plain release groups. Two things were needed to
   * reach it — a nudge toward the artist the FILE claims to be, and a release-group
   * preference that treats a compilation as the last resort rather than the first thing
   * `rgs[0]` happens to hand back.
   *
   * @param hint What the file's own tags or name say. Only a tie-break: a fingerprint is
   *   better evidence than a tag, but it cannot tell an original from a cover, and the tag
   *   can.
   */
  async identify(path: string, hint?: { artist?: string; title?: string }): Promise<AcoustMatch | null> {
    return (await this.identifyAll(path, hint))[0] ?? null;
  }

  /**
   * Every place the fingerprint says this could belong, best first.
   *
   * The upload screen shows these rather than only the winner, because the ranking below is a
   * judgement and judgements should be visible. A karaoke label outscoring Lady Gaga is
   * obvious the moment both are on screen and invisible when one has been silently chosen.
   *
   * Deduplicated by release group: one recording can be listed under the same album by
   * several AcoustID results, and the same album twice is not a choice.
   */
  async identifyAll(
    path: string,
    hint?: { artist?: string; title?: string },
  ): Promise<AcoustCandidate[]> {
    const key = this.settings.all().acoustidKey;
    if (!key) return [];
    const fp = await this.fingerprint(path);
    if (!fp) return [];

    try {
      const body = await this.gate(() =>
        getJson<LookupBody>(
          `${API}?client=${encodeURIComponent(key)}&meta=recordings+releasegroups+compress` +
            `&duration=${fp.duration}&fingerprint=${encodeURIComponent(fp.fingerprint)}`,
          { timeoutMs: 10_000 },
        ),
      );
      if (body.status !== 'ok') {
        this.warn(`acoustid: ${body.error?.message ?? 'lookup failed'}`);
        return [];
      }

      const wantArtist = norm(hint?.artist ?? '');
      const byGroup = new Map<string, AcoustCandidate>();

      for (const r of body.results ?? []) {
        const score = r.score ?? 0;
        // Below this the fingerprint barely agrees; wrong identification is
        // worse than none, because it files the track under a stranger.
        if (score < 0.6) continue;
        for (const rec of r.recordings ?? []) {
          if (!rec.id || !rec.title) continue;
          const artist = rec.artists?.[0]?.name ?? '';
          // Every group, not just the best one — the caller wants the alternatives.
          for (const album of (rec.releasegroups ?? []).filter((g) => g.id)) {

            /*
             * Rank, highest wins. The fingerprint score is the base but deliberately the
             * SMALLEST term: every serious candidate scores 0.98-something, so on its own it
             * is noise that happened to favour a karaoke label.
             */
            let rank = score;
            // Agreeing with the file's own artist is worth more than any score difference
            // between near-identical fingerprints. This is what separates Lady Gaga from a
            // cover act, and it only applies when the file actually claims an artist.
            if (wantArtist && artist) {
              const got = norm(artist);
              if (got === wantArtist) rank += 2;
              else if (got.includes(wantArtist) || wantArtist.includes(got)) rank += 1;
              else rank -= 1;
            }
            // A record beats a hits compilation the track merely appears on.
            rank += groupBonus(album);

            const candidate: AcoustCandidate = {
              recordingMbid: rec.id,
              title: rec.title,
              artist,
              releaseGroupMbid: album.id ?? null,
              album: album.title ?? '',
              albumType: album.type ?? '',
              secondaryTypes: album.secondarytypes ?? [],
              score,
              rank,
            };
            const seen = byGroup.get(candidate.releaseGroupMbid ?? candidate.recordingMbid);
            if (!seen || rank > seen.rank) {
              byGroup.set(candidate.releaseGroupMbid ?? candidate.recordingMbid, candidate);
            }
          }
        }
      }
      return [...byGroup.values()].sort((a, b) => b.rank - a.rank);
    } catch (err) {
      this.warn(`acoustid lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
}
