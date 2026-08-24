/**
 * Choosing which release to grab.
 *
 * This is the judgement Lidarr used to make, and the reason it is now made here:
 * Lidarr picks a canonical MusicBrainz release and then refuses to import
 * anything that does not match it track for track, because its job is a pristine
 * upgradeable library. A request service wants the opposite bias — get the album,
 * accept a rip that is one track short, and try the next candidate rather than
 * stopping. So the scoring below prefers, it does not demand.
 *
 * Filtering is not optional. Prowlarr's search is fuzzy: "ABBA Ring Ring"
 * returned five results of which four were Shabba Ranks. Anything that does not
 * clearly name both the artist and the album is discarded before scoring, because
 * a wrong grab costs Usenet allowance and lands junk in the library.
 */

import type { Candidate } from './prowlarr.js';

export interface Target {
  artist: string;
  album: string;
  /** From MusicBrainz. 0 when unknown, which relaxes the size checks. */
  trackCount: number;
  /** Four-digit year, or ''. */
  year: string;
}

export interface Scored extends Candidate {
  score: number;
  /** Why it scored as it did, kept for the log so a bad pick can be explained. */
  reasons: string[];
}

/** Lowercase, strip punctuation and accents, collapse whitespace. */
export function norm(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Every word of `needle` present in `hay` as a WHOLE WORD.
 *
 * Substring matching is not good enough, and the failure is not theoretical: a
 * search for ABBA's "Ring Ring" scored "Shabba Ranks Featuring Queen Latifah" as
 * a viable release, because "shabba" contains "abba" and "featuring" contains
 * "ring". It ranked second that time, so the right album still won — but with the
 * real release absent it would have been grabbed, spending Usenet allowance to put
 * Shabba Ranks in the library under ABBA.
 *
 * The joined-form fallback exists so a run-together artist name still matches:
 * "ACDC-Back in Black" has no "ac" or "dc" token, but it does have "acdc". Only an
 * exact token is accepted, never a substring, so it does not reopen the hole above.
 */
function containsAllWords(tokens: Set<string>, needle: string): boolean {
  const words = needle.split(' ').filter((w) => w.length > 1);
  if (!words.length) return true;
  if (words.every((w) => tokens.has(w))) return true;
  const joined = words.join('');
  return joined.length > 3 && tokens.has(joined);
}

const LOSSLESS = /\b(flac|alac|ape|wavpack|lossless|24bit|24-bit)\b/i;
const LOSSY_HI = /\b(320|v0|vbr)\b/i;

/**
 * The tunable half of the scoring, set from the admin page.
 *
 * These were constants. They are the numbers an operator actually wants to argue
 * with — what counts as too small, whether a lossy rip is acceptable at all, which
 * title fragments are never the album — so they belong in a form rather than in a
 * rebuild. Defaults live in lib/settings.ts.
 */
export interface Criteria {
  /** Torrents below this many seeders are not offered at all. */
  minSeeders: number;
  /** 'usenet' or 'torrent' — which wins between otherwise equal candidates. */
  preferProtocol: string;
  formats: string[];
  requireLossless: boolean;
  losslessMinMbPerTrack: number;
  losslessMaxMbPerTrack: number;
  lossyMinMbPerTrack: number;
  lossyMaxMbPerTrack: number;
  /** Whole-release ceiling in MB; 0 disables it. */
  maxTotalMb: number;
  disqualify: string[];
}

const MB = 1024 * 1024;

export function score(candidates: Candidate[], t: Target, crit: Criteria): Scored[] {
  const nArtist = norm(t.artist);
  const nAlbum = norm(t.album);
  const out: Scored[] = [];

  // Deduplicated by download URL, not by title.
  //
  // The same release cross-listed on two indexers has two URLs, and trying the
  // second after the first fails is a genuinely useful retry — Usenet retention
  // differs per provider. Only the identical posting is waste.
  const seen = new Set<string>();

  for (const c of candidates) {
    const nTitle = norm(c.title);
    if (seen.has(c.downloadUrl)) continue;
    seen.add(c.downloadUrl);

    const tokens = new Set(nTitle.split(' '));
    const reasons: string[] = [];

    // Both must be named. This is the filter that removes the Shabba Ranks class
    // of result, and it is a hard gate rather than a penalty on purpose.
    if (!containsAllWords(tokens, nArtist) || !containsAllWords(tokens, nAlbum)) continue;

    // Whole-release ceiling, before any scoring. A hard gate rather than a penalty:
    // "no more than this many MB" is a budget, and a budget that can be outvoted by
    // a good quality score is not a budget. Size 0 means the indexer did not say, and
    // an unknown size is not evidence of being over the limit.
    if (crit.maxTotalMb > 0 && c.size > crit.maxTotalMb * MB) continue;

    const bad = crit.disqualify.find((d) => nTitle.includes(norm(d)));
    // A greatest-hits package IS the album when that is what was asked for, so
    // the term only disqualifies when the requested title does not contain it.
    if (bad && !nAlbum.includes(norm(bad))) continue;

    const lossless = LOSSLESS.test(c.title);

    // A hard gate rather than a penalty when the operator has asked for lossless
    // only, because a preference can still be outvoted by size and recency and
    // "lossless only" should not be a suggestion.
    if (crit.requireLossless && !lossless) continue;

    // Format gate. A release naming a format that is not on the accepted list is
    // dropped; one naming none is kept, since most titles do not say.
    const named = crit.formats.filter((f) => new RegExp(`\\b${f}\\b`, 'i').test(c.title));
    const namedAny = /\b(flac|alac|ape|wavpack|mp3|m4a|aac|ogg|opus|wav|wma|aiff)\b/i.test(
      c.title,
    );
    if (namedAny && named.length === 0) continue;

    let s = 0;

    if (lossless) {
      s += 100;
      reasons.push('lossless');
    } else if (LOSSY_HI.test(c.title)) {
      s += 40;
      reasons.push('high-bitrate lossy');
    } else {
      s += 10;
      reasons.push('unknown/low quality');
    }

    // Size sanity, only when both the size and the expected track count are known.
    if (c.size > 0 && t.trackCount > 0) {
      const per = c.size / t.trackCount;
      const min = (lossless ? crit.losslessMinMbPerTrack : crit.lossyMinMbPerTrack) * MB;
      const max = (lossless ? crit.losslessMaxMbPerTrack : crit.lossyMaxMbPerTrack) * MB;
      if (per < min) {
        // Almost always a single or a sampler using the album's name.
        s -= 80;
        reasons.push(`too small (${Math.round(per / 1024 / 1024)}MB/track)`);
      } else if (per > max) {
        s -= 60;
        reasons.push(`too large (${Math.round(per / 1024 / 1024)}MB/track)`);
      } else {
        s += 30;
        reasons.push('size plausible');
      }
    }

    if (t.year && c.title.includes(t.year)) {
      s += 15;
      reasons.push('year matches');
    }

    // Retention: on Usenet an older post is likelier to be incomplete. A mild
    // preference only — a well-seeded old post still beats nothing.
    //
    // Age says much less about a torrent: a decade-old release with a healthy
    // swarm downloads perfectly, while last week's with one seeder does not.
    // Seeders are the equivalent signal, applied below.
    const ageDays = c.publishDate
      ? (Date.now() - new Date(c.publishDate).getTime()) / 86_400_000
      : NaN;
    if (c.protocol !== 'torrent' && Number.isFinite(ageDays)) {
      if (ageDays < 365) {
        s += 10;
        reasons.push('recent post');
      } else if (ageDays > 3650) {
        s -= 10;
        reasons.push('very old post');
      }
    }

    // The crowd's verdict, where the indexer keeps one.
    //
    // Grabs are the single most useful signal an indexer offers and crate was
    // ignoring it. A post with thousands of grabs is one thousands of people
    // successfully unpacked; a post with none may be the obfuscated repost of a
    // broken upload, which is exactly what three wasted attempts on Appetite
    // for Destruction turned out to be.
    if (c.grabs >= 1000) {
      s += 20;
      reasons.push(`${c.grabs} grabs`);
    } else if (c.grabs >= 100) {
      s += 12;
      reasons.push(`${c.grabs} grabs`);
    } else if (c.grabs >= 10) {
      s += 5;
    }

    if (c.protocol === 'torrent') {
      // A swarm too thin to finish is not worth a slot in the candidate list;
      // the stall timeout is a twenty-minute way to learn what seeders say now.
      if (crit.minSeeders > 0 && c.seeders < crit.minSeeders) continue;
      if (c.seeders >= 20) {
        s += 15;
        reasons.push(`${c.seeders} seeders`);
      } else if (c.seeders >= 5) {
        s += 8;
        reasons.push(`${c.seeders} seeders`);
      } else {
        reasons.push(`only ${c.seeders} seeders`);
      }

      reasons.push('torrent');
    }

    out.push({ ...c, score: s, reasons });
  }

  // Highest first; larger breaks a tie, since between two similar releases the
  // bigger one is usually the better rip rather than the worse one.
  out.sort((a, b) => b.score - a.score || b.size - a.size);

  /**
   * The preferred protocol is a FALLBACK ORDER, not a tie-breaker.
   *
   * This began as a score nudge and that was wrong in practice. A well-seeded
   * torrent outscored a perfectly good Usenet post — old posts take an age
   * penalty, healthy swarms take a bonus — so Mezzanine went to a torrent at
   * 35KB/s while eight NZBs sat there unused. "Torrents are the backup" is a
   * statement about order, and a score can always be outvoted.
   *
   * So the preferred protocol is offered ALONE whenever it has anything
   * viable, and the other only when it has nothing. Every candidate stays in
   * the list either way, so a retry still works down the alternatives.
   */
  const wanted = crit.preferProtocol === 'torrent' ? 'torrent' : 'usenet';
  const preferred = out.filter((c) => (c.protocol === 'torrent') === (wanted === 'torrent'));
  return preferred.length ? preferred : out;
}
