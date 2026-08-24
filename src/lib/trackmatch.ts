import { norm } from './release.js';

/**
 * Match a pile of audio files to an official tracklist.
 *
 * The old logic was exact-equality-or-give-up: a file called
 * "01 - Starboy (feat. Daft Punk).flac" against the MusicBrainz title
 * "Starboy" matched nothing and fell back to file order, which is how albums
 * came out shuffled. Real release names carry track numbers, artist prefixes,
 * feat credits, remaster tags and rip-group suffixes — all noise this strips
 * or scores through rather than tripping over.
 *
 * Deterministic and dependency-free on purpose. An optional AI pass can
 * arbitrate the leftovers, but the rules must stand alone: matching cannot
 * become a feature that stops working when an API key expires.
 */

export interface MatchFile {
  name: string;
  tagTitle?: string | null;
  tagTrackNo?: number | null;
  durationS?: number | null;
}

export interface MatchTrack {
  position: number;
  title: string;
  lengthMs?: number | null;
}

export interface Assignment {
  name: string;
  /** Tracklist position, or null for "leave this file out". */
  position: number | null;
  /** 0..1 — how sure the rules are. Below ~0.6 is a guess worth arbitrating. */
  confidence: number;
}

/** "03 - Artist - Some Song (2011 Remaster).flac" -> its useful fragments. */
function fragments(file: MatchFile): { names: string[]; fileNo: number | null } {
  const stem = file.name.replace(/\.[a-z0-9]{2,5}$/i, '');

  // A leading number is almost always the track number: "03.", "03 -", "3-03",
  // "A3" (vinyl side). Capture it, then strip it from the matching text.
  const noMatch = stem.match(/^\s*(?:[A-D]|\d{1,2}[-.])?\s*(\d{1,2})\s*[-._)\s]/);
  const fileNo = noMatch ? Number(noMatch[1]) : null;

  let cleaned = stem
    .replace(/^\s*(?:[A-D]|\d{1,2}[-.])?\s*\d{1,2}\s*[-._)\s]+/, '')
    // Rip-group and edition suffixes contribute nothing to identity.
    .replace(/[-_]\w{2,12}$/i, (m) => (/(flac|web|cd|vinyl|remaster)/i.test(m) ? '' : m))
    .trim();

  const names = new Set<string>();
  if (cleaned) names.add(cleaned);
  if (file.tagTitle) names.add(file.tagTitle);
  // "Artist - Title" filenames: the part after the last separator is usually
  // the title; offer both halves rather than guessing which.
  for (const base of [...names]) {
    const parts = base.split(/\s+-\s+/);
    if (parts.length > 1) names.add(parts[parts.length - 1]!);
    // Parenthetical-stripped variant: "(feat. X)" and "(Remastered)" both go,
    // and the SCORER decides whether the stripped or full form fits better.
    const bare = base.replace(/[([].*$/, '').trim();
    if (bare) names.add(bare);
  }
  return { names: [...names].filter(Boolean), fileNo };
}

/** Dice coefficient over character bigrams: robust to word order and small edits. */
function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      hits++;
      grams.set(g, n - 1);
    }
  }
  return (2 * hits) / (a.length - 1 + (b.length - 1));
}

function titleScore(names: string[], trackTitle: string): number {
  const want = norm(trackTitle);
  if (!want) return 0;
  let best = 0;
  for (const n of names) {
    const got = norm(n);
    if (!got) continue;
    if (got === want) return 1;
    // Containment either way is strong: "Starboy feat Daft Punk" contains
    // "Starboy"; short titles inside long release names still count.
    const contains =
      got.includes(want) || want.includes(got)
        ? Math.min(want.length, got.length) / Math.max(want.length, got.length)
        : 0;
    best = Math.max(best, 0.55 + contains * 0.4, dice(got, want));
  }
  return Math.min(best, 1);
}

/**
 * Greedy assignment, best pair first, both sides unique.
 *
 * Greedy rather than optimal because ties here are decided by the bonuses
 * (track number, duration) long before the ordering matters, and a wrong
 * greedy pick at 0.9 confidence would have been wrong under Hungarian too —
 * the inputs, not the algorithm, are the limit.
 */
export function matchTracks(files: MatchFile[], tracks: MatchTrack[]): Assignment[] {
  const parsed = files.map((f) => ({ f, ...fragments(f) }));

  const pairs: { fi: number; ti: number; score: number }[] = [];
  for (let fi = 0; fi < parsed.length; fi++) {
    const p = parsed[fi]!;
    for (let ti = 0; ti < tracks.length; ti++) {
      const t = tracks[ti]!;
      let score = titleScore(p.names, t.title);
      // The number in the FILENAME outranks the tag: tags lie in bulk (a
      // whole album tagged track 1), filenames rarely do.
      const no = p.fileNo ?? p.f.tagTrackNo ?? null;
      if (no !== null && no === t.position) score += 0.25;
      else if (no !== null && no !== t.position) score -= 0.05;
      if (
        p.f.durationS &&
        t.lengthMs &&
        Math.abs(p.f.durationS - Math.round(t.lengthMs / 1000)) <= 3
      ) {
        score += 0.15;
      }
      pairs.push({ fi, ti, score: Math.min(score, 1) });
    }
  }

  pairs.sort((a, b) => b.score - a.score);
  const fileTaken = new Set<number>();
  const trackTaken = new Set<number>();
  const out: Assignment[] = files.map((f) => ({ name: f.name, position: null, confidence: 0 }));

  for (const p of pairs) {
    if (fileTaken.has(p.fi) || trackTaken.has(p.ti)) continue;
    // Below this the pairing is noise; leaving the file out is more honest
    // than filing it somewhere it does not belong.
    if (p.score < 0.45) break;
    fileTaken.add(p.fi);
    trackTaken.add(p.ti);
    out[p.fi] = { name: files[p.fi]!.name, position: tracks[p.ti]!.position, confidence: p.score };
  }
  return out;
}
