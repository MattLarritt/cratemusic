import type { AcoustCandidate } from './acoustid.js';
import { norm } from './release.js';

/**
 * Where an uploaded file might belong, and what the batch as a whole looks like.
 *
 * Three sources answer the question and none of them is authoritative on its own:
 *
 *   ondisk    somebody already has this exact song. The best possible answer, because it
 *             costs nothing and it is the one crate used to hide until you clicked.
 *   acoustid  what the audio IS. Right about the recording, and blind to whether you want
 *             the record it came out on or the compilation you ripped it from.
 *   tags      what the rip CAME FROM. Often a hits compilation, which is sometimes exactly
 *             what somebody means and sometimes the reason a Lady Gaga track got filed
 *             under Audiogroove.
 *
 * So all three are offered, ranked, and the person picks. That is the whole design: the
 * ranking is a judgement, and a judgement should be visible rather than silently applied.
 */

export type MatchMethod = 'ondisk' | 'acoustid' | 'tags';

export interface MatchOption {
  method: MatchMethod;
  /** The song, as this option believes it is titled. */
  title: string;
  artist: string;
  album: string;
  releaseGroupMbid: string | null;
  /** Album, EP, Single… only AcoustID knows this. */
  albumType?: string;
  secondaryTypes?: string[];
  /** Set for 'ondisk': the pool track that already holds this song. */
  trackId?: number;
  /** 0..1, for ordering and for showing how sure this is. */
  confidence: number;
  /** One short phrase explaining the row, shown under the method. */
  why: string;
}

export interface FileSuggestion {
  name: string;
  options: MatchOption[];
}

export type VerdictKind = 'album' | 'compilation' | 'split';

export interface Verdict {
  kind: VerdictKind;
  /** The album the whole batch belongs to, when there is one. */
  artist?: string;
  album?: string;
  releaseGroupMbid?: string | null;
  reason: string;
}

/** A pool track already holding this song, as the caller's library sees it. */
export interface PoolHit {
  trackId: number;
  artistName: string;
  albumTitle: string;
  title: string;
  /** Whether the person asking already owns it — changes the row from a gift to a no-op. */
  mine: boolean;
}

/** How many AcoustID rows are worth showing. Ninety-three is not a choice, it is a list. */
const MAX_ACOUSTID = 4;

/**
 * Rank the options for one file.
 *
 * An on-disk hit the person does not own goes first unconditionally: it is free, instant, and
 * the thing they were asking for. Everything else falls in behind the fingerprint's own
 * ranking, with the tags offered last because they describe the rip rather than the song —
 * last is still VISIBLE, which is the point.
 */
export function optionsFor(
  file: { name: string; tags?: { artist?: string; album?: string; title?: string } | null },
  candidates: AcoustCandidate[],
  poolHit: PoolHit | null,
): MatchOption[] {
  const out: MatchOption[] = [];

  if (poolHit) {
    out.push({
      method: 'ondisk',
      title: poolHit.title,
      artist: poolHit.artistName,
      album: poolHit.albumTitle,
      releaseGroupMbid: null,
      trackId: poolHit.trackId,
      confidence: 1,
      why: poolHit.mine
        ? 'already on disk and in your library'
        : 'already on disk — added to your library, nothing uploaded',
    });
  }

  for (const c of candidates.slice(0, MAX_ACOUSTID)) {
    const secondary = c.secondaryTypes ?? [];
    out.push({
      method: 'acoustid',
      title: c.title,
      artist: c.artist,
      album: c.album,
      releaseGroupMbid: c.releaseGroupMbid,
      albumType: c.albumType,
      secondaryTypes: secondary,
      // Ranks run about 1 to 4; mapped into 0..1 only so the UI has one scale to show.
      confidence: Math.max(0, Math.min(1, (c.rank - 1) / 3)),
      why: secondary.length
        ? `fingerprint · ${c.albumType.toLowerCase()}, ${secondary.join(', ').toLowerCase()}`
        : `fingerprint · ${(c.albumType || 'release').toLowerCase()}`,
    });
  }

  const tagArtist = file.tags?.artist?.trim();
  const tagAlbum = file.tags?.album?.trim();
  if (tagArtist && tagAlbum) {
    // Only when it says something the fingerprint did not, or there is nothing else at all.
    const known = out.some(
      (o) => norm(o.artist) === norm(tagArtist) && norm(o.album) === norm(tagAlbum),
    );
    if (!known) {
      out.push({
        method: 'tags',
        title: file.tags?.title?.trim() || file.name,
        artist: tagArtist,
        album: tagAlbum,
        releaseGroupMbid: null,
        confidence: 0.3,
        why: 'from the file’s own tags — usually what it was ripped from',
      });
    }
  }

  return out;
}

/**
 * What the BATCH is: one album, one compilation, or unrelated songs.
 *
 * The question only has a good answer collectively. Five files that each fingerprint to a
 * different record are five singles, however confidently each one was identified — and
 * forcing them into one album, which is all the confirm screen could previously express, is
 * how a folder of favourites became a fictional record.
 *
 * Two kinds of agreement are looked for, in order, because they carry different weight. The
 * AUDIO agreeing — every file's best match being the same record — is a rip of one album. The
 * TAGS agreeing is what says a pile of different artists arrived together as one release.
 * Neither agreeing means these are separate songs.
 */
export function verdictFor(
  files: { name: string; candidates: AcoustCandidate[]; tags?: { album?: string } | null }[],
): Verdict {
  const identified = files.filter((f) => f.candidates.length);
  if (files.length <= 1) {
    const top = identified[0]?.candidates[0];
    return top
      ? {
          kind: 'album',
          artist: top.artist,
          album: top.album,
          releaseGroupMbid: top.releaseGroupMbid,
          reason: 'one song, filed with the record it came from',
        }
      : { kind: 'split', reason: 'one song, and the fingerprint did not recognise it' };
  }
  if (!identified.length) {
    return { kind: 'split', reason: 'nothing here was recognised by fingerprint' };
  }

  /*
   * 1. The audio agrees. Every file's BEST match is the same record, which is what a rip of
   *    one album looks like and is the strongest evidence available.
   */
  const tops = identified.map((f) => f.candidates[0]!);
  const firstTop = tops[0]!;
  if (
    firstTop.releaseGroupMbid &&
    tops.every((t) => t.releaseGroupMbid === firstTop.releaseGroupMbid)
  ) {
    return {
      kind: 'album',
      artist: firstTop.artist,
      album: firstTop.album,
      releaseGroupMbid: firstTop.releaseGroupMbid,
      reason: `all ${identified.length} songs are on this record`,
    };
  }

  /*
   * 2. The tags agree. A compilation rip carries one album tag across every file, and that —
   *    not the fingerprint — is what says these arrived together.
   *
   * The fingerprint CANNOT establish this, and an earlier version of this function tried:
   * it looked for any release group present in every file's candidate list. Hit songs appear
   * on dozens of hits compilations, so two unrelated singles almost always share one, and
   * Bad Romance plus Let Her Go were confidently declared a compilation. The audio says what
   * each song IS; only the tags say what they came from together.
   */
  const albumTags = identified.map((f) => norm(f.tags?.album ?? ''));
  const sharedTag = albumTags[0]!;
  if (sharedTag && albumTags.every((t) => t === sharedTag)) {
    const artists = new Set(tops.map((t) => norm(t.artist)).filter(Boolean));
    const rawTag = identified.find((f) => f.tags?.album)?.tags?.album ?? '';
    if (artists.size > 1) {
      // Named from the tag, because the shared release the files claim is the compilation
      // itself — whichever of its many pressings MusicBrainz happens to rank first.
      return {
        kind: 'compilation',
        artist: 'Various Artists',
        album: rawTag,
        releaseGroupMbid: null,
        reason: `${identified.length} songs by ${artists.size} artists, all tagged as this release`,
      };
    }
    return {
      kind: 'album',
      artist: tops[0]!.artist,
      album: rawTag,
      releaseGroupMbid: null,
      reason: `all ${identified.length} songs are tagged as this release`,
    };
  }

  /*
   * 3. Neither agrees, so these are separate songs. Each keeps the record its own fingerprint
   *    named, which is the case the confirm screen could not previously express at all.
   */
  const distinct = new Set(tops.map((t) => t.releaseGroupMbid ?? t.album)).size;
  return {
    kind: 'split',
    reason: `${identified.length} songs from ${distinct} different records — filed separately`,
  };
}
