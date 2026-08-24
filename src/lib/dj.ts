import type Database from 'better-sqlite3';
import { ADJACENT, FAMILY_LABEL, familiesOf, familyOf, isJunk, type Family } from './genrefam.js';
import type { Settings } from './settings.js';

/**
 * The DJ (Intelligent Shuffle): a dynamic DJ over the user's own library.
 *
 * Born as the intelligent-shuffle plugin and moved into core once it proved itself — the
 * engine is the plugin's, verbatim where possible, because every constant below was tuned
 * against the real library and its comments are the design record. What changed in the move:
 * the genre taxonomy is imported from lib/genrefam.ts instead of carrying a bundled copy
 * (deleting a KEEP-IN-SYNC hazard), the column probes for pre-genres/pre-energy crates are
 * gone because core owns the schema, and the OpenAI key comes through Settings rather than a
 * raw table read.
 *
 * The idea in one sentence: votes write WEIGHTS, weights DECAY, and the next tracks are drawn
 * from the library scored against whatever the weights say right now.
 *
 * Each "more like this" or "less like this" adds points to the playing track, its album, its
 * artist, its genres, and its era. The decay is the design decision that makes this a DJ
 * rather than a profile: a vote is worth half as much every four hours, so what you loved on
 * Tuesday night does not run Wednesday morning — the weights ARE the current mood, and an
 * empty table is simply an open mind (pure shuffle). Crate's My Algorithm feature already owns
 * long-term taste; this deliberately does not compete with it.
 *
 * WHOSE GENRES? The track's own, when the file names them. artist_genres is Last.fm's opinion
 * of the artist as a whole, and it files the quiet folk ballad on the metal record under nu
 * metal — voting on that ballad should boost FOLK. A vote and a score both read the track
 * first and fall back to the artist's genres only when the file is silent.
 *
 * WHICH GENRES COUNT AS "LIKE THIS"? Exact strings are too sparse to steer with — a vote on a
 * nu metal track used to light up only tracks tagged those exact words, and alt metal next
 * door stayed dark, which read as randomness. Genres now also fold into musicmap-style
 * SUPER-GENRE families (see genrefam.ts): a vote writes the family alongside the exact
 * genres, scoring gives every track in the family a lift and adjacent families (metal ↔
 * industrial ↔ punk...) a smaller one, and the exact-genre weights supply the fine grain on
 * top. One System of a Down vote now means "metal-family, especially these strains" — which
 * is what a person means by it.
 *
 * WHO GETS THE CREDIT? A single vote cannot say whether you liked the band or the vibe, so the
 * default split leans genre (see DELTAS). But the votes themselves disambiguate over a session:
 * voting the same direction on DIFFERENT tracks by one artist is evidence about the ARTIST, and
 * each such repeat escalates the artist's share of the vote (up to ESCALATE_MAX×). One System
 * of a Down vote asks for more nu metal; three System of a Down votes ask for System of a Down.
 * The escalation works both ways — repeatedly vetoing one artist's tracks buries the artist,
 * not the genre their neighbours share.
 *
 * Everything is per user: every table is keyed by user_id and every statement is scoped by it.
 */

/** A vote's worth halves every four hours. Mood, not memory. */
const HALF_LIFE_S = 4 * 3600;

/** Below this a weight is noise; pruned on the next vote so the table stays mood-sized. */
const FLOOR = 0.05;

/**
 * What one vote is worth, per key it touches. Two rules shape these numbers:
 *
 * GENRE IS THE BIGGEST MOVER, both ways. "More like this" means more music LIKE this — the
 * vibe — not more of the same band; an early version weighted artist above genre and dutifully
 * answered a System of a Down vote with more System of a Down, which is a jukebox stuck on
 * repeat, not a DJ. The artist and album still get a nudge (you did like that song, and the
 * per-batch cap plus the no-adjacent rule keep even a liked artist from crowding the queue),
 * but the mood generalises. The artist nudge GROWS when repeated votes single an artist out —
 * see the escalation note in the header.
 *
 * ERA IS A TREND, NOT A TARGET: worth less than genre per vote, because a vote usually means
 * the song, not the decade — but eras accumulate across votes, so a listener working through
 * a 70s mood (or vetoing everything post-2000) is noticed within a few songs.
 *
 * Vetoes bite harder than praise, and the track delta is the exception to the genre rule:
 * a specific song is the one thing a vote names exactly.
 */
const DELTAS = {
  more: { track: 2.5, album: 1, artist: 1, genre: 2.5, style: 2, era: 1.5, energy: 1.5 },
  less: { track: -4, album: -1.5, artist: -1.5, genre: -2.5, style: -2, era: -2, energy: -2 },
} as const;

/** A summed score below this means "the mood says no": excluded outright, not just unlikely. */
const HARD_NO = -3;

/**
 * Softmax temperature for picking. Lower = obeys the mood harder; higher = more adventurous.
 * Dropped from 1.5 when families arrived: back then sharpening meant tunnelling into one
 * exact genre string, so the sampler stayed timid and the queue read as random. With a whole
 * family lit up per vote, the variety comes from the breadth of what scores well — the
 * sampler can afford conviction.
 */
const TEMPERATURE = 0.6;

/**
 * How much each dimension gets to say, once every dimension has been put on the SAME SCALE.
 *
 * This is the fix for the DJ's oldest complaint — that it took a dozen songs to find the mood
 * and then stopped improving. Scores used to be raw weight sums, each hard-clamped. But a mood
 * grows: after ten votes `metal` sat at +30 and plain `rock` at +22, and since both exceeded
 * the clamp of 4 they contributed EXACTLY THE SAME. The clamp erased the distinction at the
 * very moment the listener had made it clearest, and the queue went back to coin-flipping
 * between metal and Coldplay.
 *
 * So each dimension is now normalised across the candidates actually on offer (z-score, capped
 * at ±Z_CAP) before being combined with these importances. What matters is how a track compares
 * to the rest of the library RIGHT NOW, which cannot saturate however long the session runs. A
 * cold start still has zero spread everywhere, so it still collapses to a fair shuffle.
 */
const IMPORTANCE = {
  genre: 1,
  style: 1.1,
  era: 0.45,
  energy: 0.4,
  artist: 0.5,
  album: 0.3,
  track: 0.4,
  /*
   * How close a candidate is to the ghost track. Weighted alongside the genre layer rather than
   * replacing it, for two reasons: most of the library has no characteristic profile yet, so a
   * ghost-only DJ would play only the analysed part of it; and the genre layer measurably works
   * (93–98% on target), so the safe way to add an axis is additively. Scaled by ghostInfluence,
   * so with no votes it contributes nothing at all.
   */
  ghost: 1.2,
} as const;

/** Z-scores past three standard deviations are outliers, not stronger opinions. */
const Z_CAP = 3;

/**
 * Tracks the same artist may occupy in one planned batch. ONE: a DJ plays the room's vibe,
 * not a discography — the artist you voted for earns a slot, not a residency, and the genre
 * weights carry the enthusiasm to their neighbours instead.
 */
const PER_ARTIST_CAP = 1;

/**
 * The most the genre stack may contribute to one candidate, either direction. The cap is the
 * anti-self-reinforcement device: a voted artist matches ALL of its own genres, so an uncapped
 * sum handed it a bonus no genre-mate could reach and the queue tunnelled anyway. Clamped, a
 * strong genre-mate saturates the same bonus, and the voted artist's remaining edge is only
 * its (deliberately small) artist and album nudges.
 */
const GENRE_CLAMP = 4;

/**
 * The most the FAMILY layer may contribute, either direction.
 *
 * Higher than the genre clamp on purpose, which looks backwards until you watch it work:
 * a vote lights SEVERAL families (a rap-metal record writes metal, alt and rock at 2
 * each), and a track is ranked by how many of them it belongs to. At a clamp of 3 a
 * plain-rock track (≈2.9 with adjacency) and a metal+alt+rock track (6, clamped to 3)
 * scored nearly the same — the clamp was erasing exactly the distinction the family layer
 * exists to draw. At 4.5 the strains the vote actually named stay ahead of the broad tent.
 */
const STYLE_CLAMP = 4.5;

/**
 * How much an ADJACENT family's weight counts toward a track. Musicmap's insight: families
 * fade into their neighbours, so a metal mood leans industrial and punk a little — but only
 * a little, or every vote would flood the whole map.
 */
const ADJ_FACTOR = 0.35;

/**
 * The most a track's decade may contribute, either direction. Smaller than the genre clamp on
 * purpose — era seasons the mix, it should not out-vote what the music sounds like. At full
 * negative clamp an era alone reaches HARD_NO, which is the intended reading of somebody who
 * has vetoed a decade twice: stop playing it (until the mood decays).
 */
const ERA_CLAMP = 3;

/**
 * The artist-share escalation: how far back a repeat vote counts, how much each repeat adds,
 * and the ceiling. Repeats are DISTINCT TRACKS by the same artist in the same direction — the
 * signal is "they keep choosing this artist across songs", which one song voted twice is not.
 */
const ESCALATE_WINDOW_S = 6 * 3600;
const ESCALATE_STEP = 0.75;
const ESCALATE_MAX = 3;

/**
 * The most an energy-band weight may contribute. The lightest of the clamps: energy is a
 * feel, not an identity — it nudges the mix toward loud or quiet, it never overrules what
 * the music is.
 */
const ENERGY_CLAMP = 2.5;

/**
 * SPECIFICITY: how much a tag is worth saying.
 *
 * The single biggest reason the DJ used to take a dozen songs to find the mood. "rock" is on
 * 48% of this library and the rock FAMILY on 55%, so liking one stoner-metal record wrote
 * `rock +2.5` and `rock family +2` — at full strength, identical to `metal` — and thereby
 * promoted half the library, Coldplay and Hozier included. A tag that describes half of
 * everything says almost nothing about what you just liked.
 *
 * So a tag's delta scales by its rarity in the listener's OWN library: log(N/df) normalised
 * against SPEC_REF, the coverage at which a tag counts as fully informative. Capped at 1 —
 * this only ever discounts a vague tag, it never amplifies a rare one into a wild swing.
 */
const SPEC_REF = 0.05;
const SPEC_FLOOR = 0.15;

/**
 * Last.fm's opinion of the ARTIST, discounted against what the file itself says.
 *
 * All Them Witches' files say `metal`; Last.fm adds blues, psychedelic, psychedelic rock,
 * rock and stoner rock. Both are useful, but only one of them is about this record — the
 * file's tag is the listener's own metadata, the artist tags are context. Weighting them
 * equally is how a metal vote came out sounding like a rock vote.
 */
const ARTIST_TAG_FACTOR = 0.6;

/**
 * The most any single weight may reach, either direction.
 *
 * This exists for REVERSIBILITY, not for scoring. A twenty-song session used to drive `metal`
 * to +30, and a change of heart then needed a dozen downvotes to climb out of the hole — the
 * DJ could not be argued with. Ceilinged, three or four votes always turn the mood.
 *
 * It is deliberately well above the point where votes stop being distinguishable: the relative
 * scoring below is what stops a big weight from swamping the mix, so this can be generous.
 */
const WEIGHT_CEILING = 10;

/**
 * How much harder a vote lands when it CONTRADICTS the mood.
 *
 * A DJ has to be arguable with. Confirming what the mood already says is cheap information —
 * it is already at or near its ceiling and one more vote changes no ranking. Contradicting it
 * is expensive information: the listener is telling you that you have it wrong. Measured on a
 * replay of a listener building a metal mood and then rejecting it, symmetric votes left the
 * DJ still playing metal eighteen songs later; the mood could be entered but not left.
 *
 * So a vote that pushes a weight back toward zero (or through it) counts for more. Only the
 * part of the delta that undoes existing enthusiasm is boosted — once the weight has crossed
 * zero, the rest lands at normal strength, so this accelerates changing your mind without
 * overshooting into a mood you never asked for.
 */
const REVERSAL_BOOST = 3;

/**
 * An artist just played sits out for a bit, no matter how much the mood loves them.
 *
 * The per-batch cap said "one slot per artist", but batches are five songs and re-dealt
 * continuously, so the top-scoring artist took a slot in EVERY batch — All Them Witches and
 * Rammstein each landed four times in twenty songs, which reads as a stuck jukebox rather
 * than a DJ. This penalty decays over the songs since, so they come back, later.
 */
const ARTIST_COOLDOWN = 6;
const COOLDOWN_HALF_SONGS = 2.5;

/**
 * THE GHOST TRACK: the DJ's target in characteristic space.
 *
 * The genre weights answer "what kind of music"; the ghost answers "what should it FEEL like".
 * It is a point in the same fifty-five dimensional space every analysed track occupies, and the
 * next songs are the ones nearest it.
 *
 * WHERE IT STARTS. Not at 0.5 everywhere, which sounds neutral and is not: all-0.5 is a specific
 * location, and the tracks nearest it are the least distinctive ones in the library — a DJ seeded
 * that way would open with your most forgettable music. It starts as a copy of the track the
 * session began from, and until a vote has shaped it, it has NO say at all (see ghostInfluence) —
 * the same rule the weights table follows, where an empty mood means shuffle rather than a
 * confident opinion about nothing.
 *
 * HOW IT MOVES. Exponentially, toward a liked track and away from a disliked one:
 *
 *     like:    ghost += RATE × (track − ghost)
 *     dislike: ghost −= RATE × (track − ghost)
 *
 * The form matters more than it looks. Because each step is proportional to the DIFFERENCE, a
 * vote moves the ghost most on the dimensions where it and the track already disagree, and not at
 * all where they match. Skipping a track that shared your energy but was far darker therefore
 * gives you "less dark" and leaves energy alone — where a naive "move away on everything" would
 * nudge all fifty-five dimensions from one skip, which is the same mistake the genre layer made
 * before specificity weighting fixed it.
 */
const GHOST_RATE_LIKE = 0.3;
/**
 * A dislike moves the ghost half as far as a like, and deliberately so.
 *
 * The two votes do not carry the same information. "More like this" names a destination; "less
 * like this" only rules out a direction, and says nothing about where to go instead. Measured on
 * a real vote — a quiet Verve track downvoted against a Rammstein ghost — a symmetric rate drove
 * aggression, punch, defiance and intensity all the way to 1.00 from ONE press, because each step
 * is proportional to a gap that was already wide. A ghost pinned to the corners of the space is a
 * caricature, and the tracks nearest it are the most extreme things in the library rather than the
 * ones somebody wants.
 */
const GHOST_RATE_DISLIKE = 0.15;

/**
 * How much say the ghost has, as evidence accumulates.
 *
 * CONFIDENCE decays here, not position. Decaying the position would walk the ghost back toward
 * the bland centre of the library, which is a place nobody asked to go; decaying its influence
 * just makes a stale mood quietly stop having opinions. Half strength at two votes, near full by
 * six — one vote nudges, a session steers.
 */
const ghostInfluence = (votes: number): number =>
  votes <= 0 ? 0 : Math.min(1, 1 - Math.pow(0.5, votes / 2));

type Kind = 'artist' | 'album' | 'track' | 'genre' | 'style' | 'era' | 'energy';

export type VoteDirection = 'more' | 'less';

/** crate's shared energy vocabulary: <0.35 chill, <0.65 medium, else high. */
const energyBandOf = (energy: number | null): 'chill' | 'medium' | 'high' | null => {
  if (energy == null || energy < 0) return null;
  if (energy < 0.35) return 'chill';
  if (energy < 0.65) return 'medium';
  return 'high';
};

interface LibRow {
  id: number;
  title: string;
  artist_name: string;
  album_title: string;
  duration_s: number | null;
  norm_artist: string;
  norm_album: string;
  /** Comma-joined lowercase genres from the FILE's tags; '' when untagged. */
  genres: string;
  year: number | null;
  /** Analyzer's 0..1, or null when unanalysed / failed. */
  energy: number | null;
}

const now = () => Math.floor(Date.now() / 1000);
const decayed = (w: number, at: number) => w * Math.pow(0.5, Math.max(0, now() - at) / HALF_LIFE_S);

/** "1990s" from 1994; null when the year is unknown (0 is crate's "no year tag" sentinel). */
const eraOf = (year: number | null): { key: string; label: string } | null => {
  if (!year || year < 1900) return null;
  const decade = Math.floor(year / 10) * 10;
  return { key: String(decade), label: `${decade}s` };
};

/**
 * How common each tag and family is in THIS listener's library — the denominator
 * specificity needs. Recomputed at most every CORPUS_TTL_S: it moves only when the
 * library does, and a vote must not pay for a full scan.
 */
interface Corpus {
  n: number;
  genreDf: Map<string, number>;
  familyDf: Map<Family, number>;
  at: number;
}
const CORPUS_TTL_S = 600;

/**
 * The narrow window onto Song characteristics the DJ needs — the same shape PluginContext
 * exposed when this was a plugin, kept as an interface so tests can hand in a stub and the
 * engine never couples to the service classes themselves.
 */
export interface DjCharacteristics {
  enabled(): boolean;
  vectorOf(trackId: number): Map<string, number> | null;
  scoreAgainst(profile: Record<string, number>): Map<number, number>;
}

/** The two playlist calls the DJ makes; UserLibrary satisfies this. */
export interface DjPlaylists {
  createPlaylist(userId: number, name: string, rules?: string | null): number;
  setPlaylistDescription(id: number, description: string): void;
}

export interface PlanArgs {
  count: number;
  exclude: Set<number>;
  /** What this session has already played, oldest first — the cooldown needs the ORDER. */
  playedOrder: number[];
  /** The track this batch will play AFTER, for the no-adjacent rule across the seam. */
  afterTrackId: number;
  /** First deal of a session only: place the ghost on this track. */
  seedFrom: number;
}

export interface PlannedTrack {
  trackId: number;
  title: string;
  artistName: string;
  albumTitle: string;
  durationS: number | null;
}

/** A non-2xx outcome an HTTP route should relay: statusCode + message, nothing else. */
export class DjError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export class Dj {
  private corpusCache = new Map<number, Corpus>();
  private readonly putGhost;
  private readonly bump;

  constructor(
    private db: Database.Database,
    private characteristics: DjCharacteristics,
    private playlists: DjPlaylists,
    private settings: Settings,
    // Only warn() is ever called; the narrow shape lets tests pass console and routes pass app.log.
    private log: { warn: (msg: string) => void },
  ) {
    this.putGhost = db.prepare(
      `INSERT INTO ishuffle_ghost (user_id, key, value, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    this.bump = db.prepare(
      `INSERT INTO ishuffle_weights (user_id, kind, key, label, weight, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, kind, key) DO UPDATE SET
         weight = excluded.weight, label = excluded.label, updated_at = excluded.updated_at`,
    );
  }

  private library(userId: number): LibRow[] {
    return this.db
      .prepare(
        `SELECT t.id, t.title, t.artist_name, t.album_title, t.duration_s,
                t.norm_artist, t.norm_album, t.genres, t.year,
                CASE WHEN t.energy >= 0 THEN t.energy ELSE NULL END AS energy
           FROM user_tracks ut JOIN tracks t ON t.id = ut.track_id
          WHERE ut.user_id = ?`,
      )
      .all(userId) as LibRow[];
  }

  /** Every weight the user has, decayed to this moment. */
  private weights(userId: number) {
    const rows = this.db
      .prepare('SELECT kind, key, label, weight, updated_at FROM ishuffle_weights WHERE user_id = ?')
      .all(userId) as { kind: Kind; key: string; label: string; weight: number; updated_at: number }[];
    const map = new Map<string, { w: number; label: string }>();
    for (const r of rows) map.set(`${r.kind}|${r.key}`, { w: decayed(r.weight, r.updated_at), label: r.label });
    return map;
  }

  /** The ghost's current position and how much evidence stands behind it. */
  private ghost(userId: number): { profile: Record<string, number>; votes: number } {
    const rows = this.db
      .prepare('SELECT key, value FROM ishuffle_ghost WHERE user_id = ?')
      .all(userId) as { key: string; value: number }[];
    const meta = this.db
      .prepare('SELECT votes FROM ishuffle_ghost_meta WHERE user_id = ?')
      .get(userId) as { votes: number } | undefined;
    return {
      profile: Object.fromEntries(rows.map((r) => [r.key, r.value])),
      votes: meta?.votes ?? 0,
    };
  }

  /**
   * Seed the ghost from a track, WITHOUT counting it as a vote.
   *
   * Starting a session from a song says "something like this", which is a position but not yet
   * evidence — so the ghost sits exactly on that track and still has no influence until somebody
   * actually votes. That distinction is what stops a single session start from steering as
   * hard as a deliberate run of likes.
   */
  private seedGhost(userId: number, trackId: number): boolean {
    const v = this.characteristics.vectorOf(trackId);
    if (!v || v.size === 0) return false;
    const t = now();
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM ishuffle_ghost WHERE user_id = ?').run(userId);
      for (const [key, value] of v) this.putGhost.run(userId, key, value, t);
      this.db
        .prepare(
          `INSERT INTO ishuffle_ghost_meta (user_id, votes, seeded_at, updated_at) VALUES (?,0,?,?)
           ON CONFLICT(user_id) DO UPDATE SET votes = 0, seeded_at = excluded.seeded_at, updated_at = excluded.updated_at`,
        )
        .run(userId, t, t);
    });
    tx();
    return true;
  }

  /**
   * Move the ghost toward a liked track, or away from a disliked one.
   *
   * Dimensions the ghost has never held are ADOPTED from the track on a like (there is nothing
   * to move away from yet) and ignored on a dislike — pushing away from a value you have no
   * opinion about would invent one, in whatever direction that track happened to sit.
   */
  private moveGhost(userId: number, trackId: number, direction: VoteDirection): boolean {
    const v = this.characteristics.vectorOf(trackId);
    if (!v || v.size === 0) return false;
    const current = this.ghost(userId).profile;
    const t = now();
    const tx = this.db.transaction(() => {
      for (const [key, score] of v) {
        const held = current[key];
        if (held === undefined) {
          if (direction === 'less') continue;
          this.putGhost.run(userId, key, score, t);
          continue;
        }
        const rate = direction === 'more' ? GHOST_RATE_LIKE : GHOST_RATE_DISLIKE;
        const step = rate * (score - held);
        const next = direction === 'more' ? held + step : held - step;
        this.putGhost.run(userId, key, Math.max(0, Math.min(1, next)), t);
      }
      this.db
        .prepare(
          `INSERT INTO ishuffle_ghost_meta (user_id, votes, seeded_at, updated_at) VALUES (?,1,?,?)
           ON CONFLICT(user_id) DO UPDATE SET votes = votes + 1, updated_at = excluded.updated_at`,
        )
        .run(userId, t, t);
    });
    tx();
    return true;
  }

  /**
   * The ghost, in a form a person can read: the dimensions it has the strongest opinion about.
   *
   * Ranked by distance from the midpoint rather than by value, because a ghost sitting at
   * danceability 0.05 is saying something as loudly as one at atmosphere 0.95 — "definitely not
   * that" is an opinion. `say` is how much of the DJ's decision it currently accounts for, so
   * the insight view can be honest about a ghost that exists but is not yet steering.
   */
  ghostSummary(userId: number): {
    say: number;
    votes: number;
    wants: { key: string; value: number; high: boolean }[];
  } {
    const g = this.ghost(userId);
    const wants = Object.entries(g.profile)
      .map(([key, value]) => ({ key, value, high: value >= 0.5 }))
      .sort((a, b) => Math.abs(b.value - 0.5) - Math.abs(a.value - 0.5))
      .slice(0, 6);
    return { say: Math.round(ghostInfluence(g.votes) * 100) / 100, votes: g.votes, wants };
  }

  /** Genres per artist, for the artists asked about. The fallback when a file names none. */
  private genresOf(artists: string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (!artists.length) return out;
    const marks = artists.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT norm_artist, genre FROM artist_genres WHERE norm_artist IN (${marks})`)
      .all(...artists) as { norm_artist: string; genre: string }[];
    for (const r of rows) {
      const list = out.get(r.norm_artist) ?? [];
      list.push(r.genre);
      out.set(r.norm_artist, list);
    }
    return out;
  }

  /**
   * The genres a vote or a score should read for THIS track: its own file tags MERGED
   * with the artist's Last.fm tags, junk filtered, capped.
   *
   * Merged, not fallback — files are often tagged with one broad word ("rock" covers a
   * third of the library) while the artist tags carry the strain that actually matters:
   * Rage Against the Machine's file says "rock", Last.fm says rap metal and funk metal,
   * and "more like this" means the latter. Junk tags ("seen live") are dropped here so a
   * vote can never turn them into weights that correlate unrelated artists.
   */
  private genresFor(
    t: Pick<LibRow, 'genres' | 'norm_artist'>,
    artistGenres: Map<string, string[]>,
  ): string[] {
    const own = t.genres ? t.genres.split(', ') : [];
    const artist = artistGenres.get(t.norm_artist) ?? [];
    const out: string[] = [];
    for (const g of [...own, ...artist]) {
      const n = g.trim().toLowerCase();
      if (n && !isJunk(n) && !out.includes(n)) out.push(n);
    }
    return out.slice(0, 10);
  }

  private corpus(userId: number): Corpus {
    const cached = this.corpusCache.get(userId);
    if (cached && now() - cached.at < CORPUS_TTL_S) return cached;
    const lib = this.library(userId);
    const ag = this.genresOf([...new Set(lib.map((t) => t.norm_artist))]);
    const genreDf = new Map<string, number>();
    const familyDf = new Map<Family, number>();
    for (const t of lib) {
      const gs = this.genresFor(t, ag);
      for (const g of gs) genreDf.set(g, (genreDf.get(g) ?? 0) + 1);
      for (const f of familiesOf(gs)) familyDf.set(f, (familyDf.get(f) ?? 0) + 1);
    }
    const fresh: Corpus = { n: lib.length, genreDf, familyDf, at: now() };
    this.corpusCache.set(userId, fresh);
    return fresh;
  }

  /** 1 for a tag worth saying, down to SPEC_FLOOR for one that covers half the library. */
  private specificity(df: number, n: number): number {
    if (!df || !n || df >= n) return SPEC_FLOOR;
    const ref = Math.log(1 / SPEC_REF);
    return Math.max(SPEC_FLOOR, Math.min(1, Math.log(n / df) / ref));
  }

  /** Decay-then-add, so old enthusiasm fades at the same rate whether or not you vote. */
  private addWeight(userId: number, kind: Kind, key: string, label: string, delta: number) {
    const row = this.db
      .prepare('SELECT weight, updated_at FROM ishuffle_weights WHERE user_id = ? AND kind = ? AND key = ?')
      .get(userId, kind, key) as { weight: number; updated_at: number } | undefined;
    const current = row ? decayed(row.weight, row.updated_at) : 0;
    /*
     * Undoing costs less than building: the stretch of this delta that walks the weight back
     * toward zero is amplified, the stretch beyond zero is not. See REVERSAL_BOOST.
     */
    let moved = current + delta;
    if (current !== 0 && Math.sign(delta) === -Math.sign(current)) {
      const undo = Math.min(Math.abs(delta), Math.abs(current));
      const past = Math.abs(delta) - undo;
      moved = current + Math.sign(delta) * (undo * REVERSAL_BOOST + past);
    }
    // Ceilinged so the mood always stays somewhere a few votes can move it. See WEIGHT_CEILING.
    const next = Math.max(-WEIGHT_CEILING, Math.min(WEIGHT_CEILING, moved));
    this.bump.run(userId, kind, key, label, next, now());
  }

  /**
   * The mood, human-readable: what it is leaning into and steering away from.
   *
   * Track weights are deliberately NOT shown — "leaning into: Saturnine & Iron Jaw" tells
   * a person nothing actionable; the mood is about vibes, and a single song is not a vibe.
   * The weight still steers scoring (a loved song resurfaces), it just isn't a chip.
   */
  mood(userId: number) {
    const all = [...this.weights(userId).entries()]
      .map(([k, v]) => ({ kind: k.split('|')[0] as Kind, label: v.label || k.split('|')[1]!, weight: v.w }))
      .filter((e) => e.kind !== 'track' && Math.abs(e.weight) >= FLOOR);
    all.sort((a, b) => b.weight - a.weight);
    /*
     * One chip per label. A genre and its family are often the same word — "rock" the tag and
     * "rock" the family — and "leaning into: rock, rock" tells a person nothing twice. The
     * strongest of the pair survives, which is also the one that is actually steering.
     */
    const seenLabels = new Set<string>();
    const deduped = all.filter((e) => {
      const key = e.label.toLowerCase();
      if (seenLabels.has(key)) return false;
      seenLabels.add(key);
      return true;
    });
    return {
      into: deduped.filter((e) => e.weight > 0).slice(0, 8),
      outOf: deduped.filter((e) => e.weight < 0).slice(-8).reverse(),
    };
  }

  /**
   * Plan the next tracks: score everything, gate the hard no's, then SAMPLE rather than
   * take the top — softmax over the scores, so a strong mood steers firmly while a mild one
   * merely leans. An empty weights table makes every score the same and this collapses to a
   * fair shuffle, which is exactly the right cold start.
   */
  plan(userId: number, args: PlanArgs): PlannedTrack[] {
    const { exclude, playedOrder, afterTrackId, seedFrom } = args;
    /*
     * A session starting from a song places the ghost on that song — a position, not evidence,
     * so it still has no influence until somebody votes. Sent only on the first deal of a
     * session; a top-up must not keep re-seeding and wiping the votes that have shaped it.
     */
    if (seedFrom && this.characteristics.enabled()) this.seedGhost(userId, seedFrom);
    const count = Math.min(Math.max(args.count || 6, 1), 30);
    const afterArtist = afterTrackId
      ? ((this.db.prepare('SELECT norm_artist FROM tracks WHERE id = ?').get(afterTrackId) as
          | { norm_artist: string }
          | undefined)?.norm_artist ?? '')
      : '';

    const lib = this.library(userId);
    const w = this.weights(userId);
    /*
     * How long ago this session last played each artist, as a penalty. Recency comes from
     * the played ORDER rather than a clock, because "three songs ago" is what a listener
     * notices — an hour of one artist at two songs an hour is not the complaint.
     */
    const cooldown = new Map<string, number>();
    if (playedOrder.length) {
      const marks = playedOrder.map(() => '?').join(',');
      const artistOf = new Map<number, string>();
      for (const r of this.db
        .prepare(`SELECT id, norm_artist FROM tracks WHERE id IN (${marks})`)
        .all(...playedOrder) as { id: number; norm_artist: string }[]) {
        artistOf.set(r.id, r.norm_artist);
      }
      playedOrder.forEach((id, i) => {
        const a = artistOf.get(id);
        if (!a) return;
        const songsAgo = playedOrder.length - i;
        cooldown.set(a, ARTIST_COOLDOWN * Math.pow(0.5, (songsAgo - 1) / COOLDOWN_HALF_SONGS));
      });
    }
    const genres = this.genresOf([...new Set(lib.map((t) => t.norm_artist))]);
    // Recently finished songs sit out for a while even unvoted — a DJ does not replay the
    // last hour. Softened automatically when the library is too small to afford it.
    const recent = new Set(
      (
        this.db
          .prepare('SELECT track_id FROM plays WHERE user_id = ? AND last_played > ?')
          .all(userId, now() - 4 * 3600) as { track_id: number }[]
      ).map((r) => r.track_id),
    );

    let pool = lib.filter((t) => !exclude.has(t.id));
    if (pool.filter((t) => !recent.has(t.id)).length >= count * 2) {
      pool = pool.filter((t) => !recent.has(t.id));
    }

    /*
     * Each candidate's raw agreement with the mood, dimension by dimension. Raw and
     * UNCLAMPED on purpose: the clamps below serve the veto, and the normalisation that
     * follows serves the ranking. Two jobs that used to be one, badly.
     */
    /*
     * Every candidate's closeness to the ghost, in one pass over the cached vectors.
     *
     * Absent from this map = the track has no profile, or too little overlap to judge. Those
     * candidates take the pool MEAN below rather than a zero, so an unanalysed track is neither
     * rewarded nor punished for it — with most of the library still unanalysed, penalising them
     * would quietly reduce the DJ to the part that has been through the classifier.
     */
    const g = this.ghost(userId);
    const ghostSay = ghostInfluence(g.votes);
    const ghostScores =
      ghostSay > 0 && this.characteristics.enabled()
        ? this.characteristics.scoreAgainst(g.profile)
        : new Map<number, number>();

    const raw = pool.map((t) => {
      const gs = this.genresFor(t, genres);
      // Sum of matched genre weights, not an average: averaging diluted a two-of-four match
      // to half strength, which punished exactly the "other music LIKE this" candidates the
      // feature exists to surface.
      const gw = gs.reduce((sum, g2) => sum + (w.get(`genre|${g2}`)?.w ?? 0), 0);
      /*
       * The family layer: this track's own families at full strength, their musicmap
       * neighbours at ADJ_FACTOR. This is what makes one System of a Down vote reach
       * every strain of metal in the library rather than only its exact tag twins.
       */
      const fams = familiesOf(gs);
      let sw = 0;
      const counted = new Set<Family>();
      for (const f of fams) {
        sw += w.get(`style|${f}`)?.w ?? 0;
        counted.add(f);
      }
      for (const f of fams) {
        for (const adj of ADJACENT[f]) {
          if (counted.has(adj)) continue;
          counted.add(adj);
          sw += ADJ_FACTOR * (w.get(`style|${adj}`)?.w ?? 0);
        }
      }
      const era = eraOf(t.year);
      const ew = era ? (w.get(`era|${era.key}`)?.w ?? 0) : 0;
      const band = energyBandOf(t.energy);
      const nw = band ? (w.get(`energy|${band}`)?.w ?? 0) : 0;
      return {
        t,
        gw,
        sw,
        ew,
        nw,
        gh: ghostScores.get(t.id),
        aw: w.get(`artist|${t.norm_artist}`)?.w ?? 0,
        alw: w.get(`album|${t.norm_artist}|${t.norm_album}`)?.w ?? 0,
        tw: w.get(`track|${String(t.id)}`)?.w ?? 0,
        cool: cooldown.get(t.norm_artist) ?? 0,
      };
    });

    /*
     * The veto: "the mood says no to THIS track".
     *
     * A PENALTY EVERY CANDIDATE SHARES IS NOT A REASON TO REJECT ANY OF THEM. That sounds
     * obvious and this code got it wrong in a way that took the library down to 3% of itself.
     *
     * Era and energy are LOW-CARDINALITY: three energy bands, six decades. A handful of
     * downvotes drives every value of both negative — at which point they have stopped
     * discriminating entirely, because every candidate carries the same penalty. But applied
     * as absolute numbers, era(−2) + energy(−2) = −4 clears HARD_NO(−3) on its own, so two
     * dimensions that now contain no information vetoed everything that had a year and an
     * analysed energy. Measured against the real library in exactly that state: 2,701 tracks
     * became 82, none of them newer than 1989, and the DJ played the fourteen surviving Pixies
     * tracks over and over because they also held the only positive artist and album weights.
     * Genre never showed this because there are hundreds of genres and you cannot downvote
     * them all.
     *
     * So the discriminating dimensions are CENTRED on the pool before they may veto: what
     * counts is how much worse this track is than the alternatives, not its absolute score.
     * When every candidate is penalised equally the term is zero and the dimension simply
     * stops voting, which is the honest reading of "no information".
     *
     * Track, artist and album stay ABSOLUTE and uncentred. Those are specific and
     * high-cardinality — "I vetoed this exact song twice" is a statement about that song and
     * must keep working however the rest of the pool looks. This is the same principle the
     * scoring below already applied by z-normalising every dimension across the candidates;
     * the veto simply never got it, and that asymmetry was the bug.
     */
    const clamp = (v: number, c: number) => Math.max(-c, Math.min(c, v));
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const mgw = mean(raw.map((e) => clamp(e.gw, GENRE_CLAMP)));
    const msw = mean(raw.map((e) => clamp(e.sw, STYLE_CLAMP)));
    const mew = mean(raw.map((e) => clamp(e.ew, ERA_CLAMP)));
    const mnw = mean(raw.map((e) => clamp(e.nw, ENERGY_CLAMP)));
    const vetoed = raw.filter(
      (e) =>
        clamp(e.gw, GENRE_CLAMP) -
          mgw +
          (clamp(e.sw, STYLE_CLAMP) - msw) +
          (clamp(e.ew, ERA_CLAMP) - mew) +
          (clamp(e.nw, ENERGY_CLAMP) - mnw) +
          e.aw +
          e.alw +
          e.tw >
        HARD_NO,
    );

    /**
     * Put a dimension on a scale the others can be compared with: how many standard
     * deviations from the pool's average this candidate is. A dimension nobody differs on
     * (a cold start, or an unanalysed library with no energy at all) has no spread and so
     * contributes nothing rather than noise.
     */
    const normaliser = (values: number[]) => {
      const m = values.reduce((a, b) => a + b, 0) / (values.length || 1);
      const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length || 1);
      const sd = Math.sqrt(variance);
      if (sd < 1e-9) return () => 0;
      return (v: number) => clamp((v - m) / sd, Z_CAP);
    };
    const zg = normaliser(vetoed.map((e) => e.gw));
    const zs = normaliser(vetoed.map((e) => e.sw));
    const ze = normaliser(vetoed.map((e) => e.ew));
    const zn = normaliser(vetoed.map((e) => e.nw));
    const za = normaliser(vetoed.map((e) => e.aw));
    const zal = normaliser(vetoed.map((e) => e.alw));
    const zt = normaliser(vetoed.map((e) => e.tw));
    /*
     * The ghost dimension is normalised over the candidates that HAVE a profile, and anything
     * without one is handed the mean — which is exactly "no information", the neutral position
     * in a z-scored dimension.
     */
    const withGhost = vetoed.map((e) => e.gh).filter((x): x is number => x !== undefined);
    const zgh = normaliser(withGhost);

    const scored = vetoed.map((e) => ({
      t: e.t,
      score:
        IMPORTANCE.genre * zg(e.gw) +
        IMPORTANCE.style * zs(e.sw) +
        IMPORTANCE.era * ze(e.ew) +
        IMPORTANCE.energy * zn(e.nw) +
        IMPORTANCE.artist * za(e.aw) +
        IMPORTANCE.album * zal(e.alw) +
        IMPORTANCE.track * zt(e.tw) +
        // Scaled by evidence: nothing at zero votes, full say after about six.
        IMPORTANCE.ghost * ghostSay * (e.gh === undefined ? 0 : zgh(e.gh)) -
        e.cool,
    }));

    // Softmax sample without replacement, with the per-artist cap keeping variety honest.
    const picked: LibRow[] = [];
    const perArtist = new Map<string, number>();
    const candidates = [...scored];
    while (picked.length < count && candidates.length) {
      const max = Math.max(...candidates.map((e) => e.score));
      const expWeights = candidates.map((e) => Math.exp((e.score - max) / TEMPERATURE));
      const total = expWeights.reduce((a, x) => a + x, 0);
      let roll = Math.random() * total;
      let idx = 0;
      for (; idx < candidates.length - 1; idx++) {
        roll -= expWeights[idx]!;
        if (roll <= 0) break;
      }
      const [chosen] = candidates.splice(idx, 1);
      if (!chosen) break;
      const artistCount = perArtist.get(chosen.t.norm_artist) ?? 0;
      if (artistCount >= PER_ARTIST_CAP) continue;
      perArtist.set(chosen.t.norm_artist, artistCount + 1);
      picked.push(chosen.t);
    }

    /*
     * No artist twice in a row, IF POSSIBLE. The sampled order is kept as priority and the
     * first pick that breaks an adjacency is pulled forward; when every remaining pick is
     * the same artist there is nothing to pull, and playing them beats silence — "if
     * possible" is the honest rule for a four-track library night.
     */
    const ordered: LibRow[] = [];
    let lastArtist = afterArtist;
    const unplaced = [...picked];
    while (unplaced.length) {
      let at = unplaced.findIndex((t) => t.norm_artist !== lastArtist);
      if (at === -1) at = 0;
      const [t] = unplaced.splice(at, 1);
      if (!t) break;
      ordered.push(t);
      lastArtist = t.norm_artist;
    }

    return ordered.map((t) => ({
      trackId: t.id,
      title: t.title,
      artistName: t.artist_name,
      albumTitle: t.album_title,
      durationS: t.duration_s,
    }));
  }

  /** A vote: the mood moves, and the response says what moved so the UI can show it. */
  vote(userId: number, trackId: number, direction: VoteDirection) {
    const t = this.db
      .prepare(
        `SELECT id, title, artist_name, album_title, norm_artist, norm_album, genres, year,
                CASE WHEN energy >= 0 THEN energy ELSE NULL END AS energy
           FROM tracks WHERE id = ?`,
      )
      .get(trackId) as LibRow | undefined;
    if (!t) throw new DjError(404, 'no such track');

    const d = DELTAS[direction];
    // The adaptive split: distinct OTHER tracks by this artist, voted the same way inside
    // the window. Zero repeats = the default genre-heavy split; each repeat shifts credit
    // toward the artist, because the listener keeps naming them (see the header).
    const repeats = (
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT track_id) AS n FROM ishuffle_votes
            WHERE user_id = ? AND norm_artist = ? AND direction = ? AND at > ? AND track_id != ?`,
        )
        .get(userId, t.norm_artist, direction, now() - ESCALATE_WINDOW_S, t.id) as { n: number }
    ).n;
    const artistShare = Math.min(ESCALATE_MAX, 1 + ESCALATE_STEP * repeats);

    this.addWeight(userId, 'track', String(t.id), t.title, d.track);
    this.addWeight(userId, 'album', `${t.norm_artist}|${t.norm_album}`, t.album_title, d.album);
    this.addWeight(userId, 'artist', t.norm_artist, t.artist_name, d.artist * artistShare);

    const gs = this.genresFor(t, this.genresOf([t.norm_artist])).slice(0, 6);
    /*
     * How loudly each tag gets to speak: rarer tags say more (specificity), and the FILE's
     * own tags say more than Last.fm's view of the artist. Together these are what stop a
     * stoner-metal vote from reading as a vote for the 55% of the library filed under rock.
     */
    const cp = this.corpus(userId);
    const ownTags = new Set(
      (t.genres ? t.genres.split(', ') : []).map((g) => g.trim().toLowerCase()).filter(Boolean),
    );
    const pull = (g: string) =>
      this.specificity(cp.genreDf.get(g) ?? 0, cp.n) * (ownTags.has(g) ? 1 : ARTIST_TAG_FACTOR);
    for (const g of gs) this.addWeight(userId, 'genre', g, g, d.genre * pull(g));
    /*
     * The family layer: the same vote at the super-genre scale, so kin genres light up. A
     * family is discounted by its OWN coverage, and by whether the file or only the artist
     * tags put the track there — so [metal, blues, rock] stops being three equal claims.
     */
    const famPull = new Map<Family, number>();
    for (const g of gs) {
      const f = familyOf(g);
      if (!f) continue;
      const p = this.specificity(cp.familyDf.get(f) ?? 0, cp.n) * (ownTags.has(g) ? 1 : ARTIST_TAG_FACTOR);
      famPull.set(f, Math.max(famPull.get(f) ?? 0, p));
    }
    const fams = [...famPull.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    for (const [f, p] of fams) this.addWeight(userId, 'style', f, FAMILY_LABEL[f], d.style * p);
    const era = eraOf(t.year);
    if (era) this.addWeight(userId, 'era', era.key, era.label, d.era);
    const band = energyBandOf(t.energy);
    if (band) this.addWeight(userId, 'energy', band, `${band} energy`, d.energy);

    /*
     * The ghost moves on the same vote that writes the weights. Two axes from one press: the
     * weights learn what KIND of music, the ghost learns what it should feel like. A track with
     * no characteristic profile simply leaves the ghost alone — the genre half still works, which
     * is why the two are additive rather than one replacing the other.
     */
    const ghostMoved = this.characteristics.enabled() && this.moveGhost(userId, t.id, direction);

    this.db
      .prepare(
        'INSERT INTO ishuffle_votes (user_id, track_id, norm_artist, direction, at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(userId, t.id, t.norm_artist, direction, now());

    // Prune while we are here — cosmetic for weights, and votes beyond the escalation
    // window are dead weight for everyone.
    this.db
      .prepare('DELETE FROM ishuffle_weights WHERE user_id = ? AND abs(weight) < ? AND updated_at < ?')
      .run(userId, FLOOR, now() - 24 * 3600);
    this.db.prepare('DELETE FROM ishuffle_votes WHERE at < ?').run(now() - ESCALATE_WINDOW_S);

    return {
      ok: true,
      ghost: ghostMoved ? this.ghostSummary(userId) : null,
      applied: {
        artist: t.artist_name,
        album: t.album_title,
        genres: gs,
        styles: fams.map(([f]) => FAMILY_LABEL[f]),
        era: era?.label ?? null,
        energy: band,
      },
      mood: this.mood(userId),
    };
  }

  moodNow(userId: number) {
    return {
      mood: this.mood(userId),
      ghost: this.characteristics.enabled() ? this.ghostSummary(userId) : null,
    };
  }

  /**
   * Freeze the mood as a DYNAMIC PLAYLIST.
   *
   * The decayed weights become the playlist's recipe verbatim (crate's dynamicpl rules
   * shape), so the playlist deals the way the DJ was dealing at this moment — but
   * frozen: the mood keeps decaying, the playlist does not. Track and album weights
   * stay out of the recipe for the same reason they stay off the mood chips: a recipe
   * is a vibe, not a setlist.
   */
  savePlaylist(userId: number, requestedName: string): { ok: true; id: number; name: string } {
    const terms = [...this.weights(userId).entries()]
      .map(([k, v]) => {
        const [kind, ...keyParts] = k.split('|');
        return { kind: kind as Kind, key: keyParts.join('|'), weight: v.w, label: v.label };
      })
      .filter((t) => t.kind !== 'track' && t.kind !== 'album' && Math.abs(t.weight) >= FLOOR)
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
      .slice(0, 30)
      .map((t) => ({
        kind: t.kind,
        key: t.key,
        weight: Math.round(t.weight * 100) / 100,
        label: t.label || t.key,
      }));
    if (!terms.length) {
      throw new DjError(400, 'the mood is empty — vote on a few songs first');
    }

    /*
     * Named after what it leans into, unless the caller chose: "metal · 1990s · high
     * energy". Labels are deduped — a genre and its family are often the same word
     * ("rock" and "rock"), and "rock · electronic · rock" is not a name.
     */
    const nameParts: string[] = [];
    for (const t of terms) {
      if (t.weight <= 0) continue;
      const label = t.label.toLowerCase();
      if (nameParts.some((p) => p.toLowerCase() === label)) continue;
      nameParts.push(t.label);
      if (nameParts.length === 3) break;
    }
    const name = requestedName || nameParts.join(' · ') || 'DJ mood';
    const rules = JSON.stringify({ v: 1, terms, limit: 50 });
    const id = this.playlists.createPlaylist(userId, name.slice(0, 120), rules);
    this.playlists.setPlaylistDescription(id, 'Saved from an Intelligent Shuffle mood — deals fresh songs every time.');
    return { ok: true, id, name };
  }

  /**
   * Talk to the DJ: free text in, weight deltas out.
   *
   * "90s and heavier, no ballads" is a mood statement, and the model's only job is
   * translating it into the SAME vocabulary votes use — genres the library actually
   * contains, families, decades, energy bands, artists. The deltas are clamped and go
   * through addWeight like any vote; the model steers nothing directly. No key
   * configured degrades to an honest 503. Votes remain the steering wheel; this is
   * the megaphone.
   *
   * Currently API-only: the web UI hides it because a sentence never re-deals the queue and
   * its ±3 deltas are quiet against a worked-in mood — restoring it means a redeal() in the
   * client's success path, not a server change.
   */
  async say(userId: number, text: string): Promise<{ ok: true; summary: string; mood: ReturnType<Dj['mood']> }> {
    if (text.length < 2) throw new DjError(400, 'say something');
    if (text.length > 300) throw new DjError(400, 'keep it under 300 characters');

    const key = this.settings.all().openaiKey;
    if (!key) {
      throw new DjError(503, 'no OpenAI key configured (Admin → Settings)');
    }

    // The vocabulary the model may use: what this library actually contains.
    const genreCounts = new Map<string, number>();
    for (const r of this.db.prepare("SELECT genres FROM tracks WHERE genres != ''").all() as {
      genres: string;
    }[]) {
      for (const g of r.genres.split(', ')) genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
    }
    const genreVocab = [...genreCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([g]) => g);
    const familyVocab = Object.keys(FAMILY_LABEL);
    const eras = (
      this.db
        .prepare('SELECT DISTINCT (year/10)*10 AS d FROM tracks WHERE year >= 1900 ORDER BY d')
        .all() as { d: number }[]
    ).map((r) => String(r.d));

    let parsed: {
      genres?: Record<string, number>;
      styles?: Record<string, number>;
      eras?: Record<string, number>;
      energy?: Record<string, number>;
      artists?: Record<string, number>;
      summary?: string;
    };
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4.1-mini',
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'You steer a music DJ by translating a listener\'s words into weight deltas ' +
                '(-3 to +3; positive = more of it, negative = less). Use ONLY these vocabularies. ' +
                `genres: ${genreVocab.join(', ')}. styles: ${familyVocab.join(', ')}. ` +
                `eras (decades): ${eras.join(', ')}. energy: chill, medium, high. ` +
                'artists: any artist name the listener mentions, lowercase. ' +
                'Reply with JSON only: {"genres":{},"styles":{},"eras":{},"energy":{},"artists":{},' +
                '"summary":"<under 10 words, what you did>"} — omit empty maps.',
            },
            { role: 'user', content: text },
          ],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`openai ${res.status}`);
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      parsed = JSON.parse(body.choices?.[0]?.message?.content ?? '{}');
    } catch (err) {
      this.log.warn(`dj say failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new DjError(502, "the DJ didn't catch that — try again");
    }

    const clampDelta = (n: unknown) => Math.max(-3, Math.min(3, Number(n) || 0));
    let applied = 0;
    /*
     * A named genre also moves its FAMILY, at the same reduced ratio a vote uses
     * (style delta 2 against genre 2.5). Without this, "more metal" would light only
     * tracks tagged the exact word while alt metal next door stayed dark — the very
     * sparseness families were introduced to fix. Words and votes write the same
     * shape of weight, so the two can never disagree.
     */
    const familyBump = new Map<Family, number>();
    for (const [g, d] of Object.entries(parsed.genres ?? {})) {
      const delta = clampDelta(d);
      if (!delta) continue;
      const key2 = g.toLowerCase();
      this.addWeight(userId, 'genre', key2, key2, delta);
      applied++;
      const fam = familyOf(key2);
      if (fam) {
        const ratio = 0.8; // 2 / 2.5, the vote's own style:genre ratio
        familyBump.set(fam, (familyBump.get(fam) ?? 0) + delta * ratio);
      }
    }
    for (const [fam, delta] of familyBump) {
      this.addWeight(userId, 'style', fam, FAMILY_LABEL[fam], Math.max(-3, Math.min(3, delta)));
    }
    for (const [f, d] of Object.entries(parsed.styles ?? {})) {
      const fam = f.toLowerCase() as Family;
      const delta = clampDelta(d);
      if (delta && fam in FAMILY_LABEL) {
        this.addWeight(userId, 'style', fam, FAMILY_LABEL[fam], delta);
        applied++;
      }
    }
    for (const [e, d] of Object.entries(parsed.eras ?? {})) {
      const delta = clampDelta(d);
      const decade = String(parseInt(e, 10));
      if (delta && /^\d{4}$/.test(decade)) {
        this.addWeight(userId, 'era', decade, `${decade}s`, delta);
        applied++;
      }
    }
    for (const [band, d] of Object.entries(parsed.energy ?? {})) {
      const delta = clampDelta(d);
      const b = band.toLowerCase();
      if (delta && ['chill', 'medium', 'high'].includes(b)) {
        this.addWeight(userId, 'energy', b, `${b} energy`, delta);
        applied++;
      }
    }
    for (const [artist, d] of Object.entries(parsed.artists ?? {})) {
      const delta = clampDelta(d);
      if (delta) {
        this.addWeight(userId, 'artist', artist.toLowerCase(), artist, delta);
        applied++;
      }
    }
    if (!applied) {
      throw new DjError(422, "the DJ couldn't map that onto your library");
    }

    return { ok: true, summary: String(parsed.summary ?? 'noted').slice(0, 80), mood: this.mood(userId) };
  }

  /**
   * A fresh mind: wipe the mood entirely. The DJ forgets, the library does not.
   *
   * `seedFrom` is the "Reset DJ session" half of the story: the mood is wiped AND the ghost is
   * re-seeded on the currently playing track, so a session that keeps running starts over from
   * here rather than from nowhere. Ending a session sends no seed — a fresh mind with no target,
   * which is different from a target of 0.5.
   */
  reset(userId: number, seedFrom?: number): { ok: true } {
    this.db.prepare('DELETE FROM ishuffle_weights WHERE user_id = ?').run(userId);
    // The vote log seeds the artist escalation; a fresh mind forgets that pattern too.
    this.db.prepare('DELETE FROM ishuffle_votes WHERE user_id = ?').run(userId);
    // And the ghost: a fresh mind has no target, which is different from a target of 0.5.
    this.db.prepare('DELETE FROM ishuffle_ghost WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM ishuffle_ghost_meta WHERE user_id = ?').run(userId);
    if (seedFrom && this.characteristics.enabled()) this.seedGhost(userId, seedFrom);
    return { ok: true };
  }
}
