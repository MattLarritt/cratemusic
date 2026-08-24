import { useEffect, useRef, useSyncExternalStore } from 'react';
import { get, post } from './api';
import { usePlayer, type PlayerApi } from './player';

/**
 * The DJ (Intelligent Shuffle), client half — native since it graduated from the plugin.
 *
 * THE UX IN ONE PARAGRAPH. While shuffle is on, the play bar shows two vote buttons. The first
 * vote SILENTLY starts a DJ session: the player's epoch is adopted, the unplayed tail is
 * re-dealt against the vote, and from then on the queue keeps itself topped up against the
 * mood. The only visible sign of a session is an "End DJ session" button. There is no panel,
 * no start screen, and no mood chips in your face — desktop gets an insight sheet for the
 * curious. Playing anything else (an album, a playlist, a search hit) ends the session
 * silently, because play() bumps the epoch and the DJ notices it no longer owns the queue.
 * The user outranks the DJ, always.
 *
 * This file is the session state (module scope — the service and the play bar have different
 * lifetimes), the API slice, the three orchestration verbs the buttons call, and the
 * always-mounted service that keeps a live session fed.
 */

/** How far ahead a deal plans. Small on purpose: the mood may move again before track six. */
const TAIL = 5;

// ---- session state ------------------------------------------------------------------------

let active = false;
/** The player epoch at session start. If it moves, somebody play()ed something else. */
let expectedEpoch = -1;
/** Everything heard this session, so the planner never deals a repeat. */
const played = new Set<number>();
/** True until the session's first vote has re-dealt the tail. */
let firstVotePending = false;
/**
 * What this session has voted, per track — so the button you pressed stays lit while the song
 * plays, and is still lit if you skip back to it. A map rather than a single "last vote"
 * because prev() exists; per-session rather than persistent because the mood it fed decays,
 * and a lit thumb over an expired opinion would be a lie.
 */
const votes = new Map<number, 'more' | 'less'>();
/**
 * The latest mood the server reported, so an OPEN insight panel updates the moment a vote
 * lands rather than on its next mount. Every vote response already carries the whole mood —
 * caching it costs nothing and saves the panel a refetch race.
 */
let moodSnapshot: { mood: Mood; ghost: Ghost | null } | null = null;

let version = 0;
const listeners = new Set<() => void>();
const bump = () => {
  version++;
  for (const fn of listeners) fn();
};

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getVersion(): number {
  return version;
}

export function isActive(): boolean {
  return active;
}

function startSession(epoch: number): void {
  active = true;
  expectedEpoch = epoch;
  played.clear();
  votes.clear();
  firstVotePending = true;
  bump();
}

function stopSession(): void {
  if (!active) return;
  active = false;
  // The lit thumbs describe THIS session's opinions; a session that no longer exists (and
  // whose mood End just wiped) must not leave one glowing.
  votes.clear();
  bump();
}

export function sessionEpoch(): number {
  return expectedEpoch;
}

function notePlayed(trackId: number): void {
  played.add(trackId);
}

function playedIds(): number[] {
  return [...played];
}

/** The play bar's subscription: re-renders on session start/stop. */
export function useDjActive(): boolean {
  useSyncExternalStore(subscribe, getVersion);
  return active;
}

/** The freshest mood, live: updates whenever a vote lands. Null until the first vote. */
export function useDjMood(): { mood: Mood; ghost: Ghost | null } | null {
  useSyncExternalStore(subscribe, getVersion);
  return moodSnapshot;
}

/** How this session voted on a track, so the pressed thumb stays lit. */
export function useDjVote(trackId: number | null): 'more' | 'less' | null {
  useSyncExternalStore(subscribe, getVersion);
  return trackId ? (votes.get(trackId) ?? null) : null;
}

// ---- the API slice (mirrors src/routes/dj.ts; the reasoning lives in src/lib/dj.ts) --------

export interface PlannedTrack {
  trackId: number;
  title: string;
  artistName: string;
  albumTitle: string;
  durationS: number | null;
}

/** What the ghost track currently wants, and how much of the DJ's decision it accounts for. */
export interface Ghost {
  /** 0..1 — the share of the choice the ghost is responsible for right now. */
  say: number;
  votes: number;
  wants: { key: string; value: number; high: boolean }[];
}

export interface MoodEntry {
  kind: 'artist' | 'album' | 'track' | 'genre' | 'style' | 'era' | 'energy';
  label: string;
  weight: number;
}

export interface Mood {
  into: MoodEntry[];
  outOf: MoodEntry[];
}

/**
 * afterTrackId = the track this batch will play after, so no artist repeats across the seam.
 * played = what the session has already played, OLDEST FIRST — the planner cools an artist
 * down by how many songs ago they were on, which `exclude` cannot say because it mixes the
 * played tracks with the ones still queued.
 * seedFrom places the GHOST TRACK on a song at the start of a session — a position to steer
 * from, not evidence, so it does not count as a vote. Sent on the first deal only: a top-up
 * that re-seeded would wipe the votes that have shaped it since.
 */
const plan = (count: number, exclude: number[], afterTrackId?: number, played2?: number[], seedFrom?: number) =>
  post<{ tracks: PlannedTrack[] }>('/api/ishuffle/plan', {
    count,
    exclude,
    afterTrackId,
    played: played2,
    seedFrom,
  });

export interface VoteResult {
  ok: true;
  // genres are the TRACK's own when its file names them; era is its decade ("1990s"),
  // energy the analyzer's band — both null when unknown.
  applied: {
    artist: string;
    album: string;
    genres: string[];
    era: string | null;
    energy?: 'chill' | 'medium' | 'high' | null;
  };
  mood: Mood;
  /** Null when the voted track has no characteristic profile, so the ghost did not move. */
  ghost?: Ghost | null;
}

const voteApi = (trackId: number, direction: 'more' | 'less') =>
  post<VoteResult>('/api/ishuffle/vote', { trackId, direction });

export const moodNow = () => get<{ mood: Mood; ghost: Ghost | null }>('/api/ishuffle/mood');

const resetApi = (seedFrom?: number) => post<{ ok: true }>('/api/ishuffle/reset', { seedFrom });

/** Freeze the mood as a dynamic playlist — it keeps dealing this vibe after the mood fades. */
export const saveMoodPlaylist = (name?: string) =>
  post<{ ok: true; id: number; name: string }>('/api/ishuffle/save-playlist', { name });

// ---- the three verbs the play bar calls -----------------------------------------------------

/** A fresh tail against the mood as it stands now. */
async function redeal(p: PlayerApi, seedFrom?: number): Promise<void> {
  const exclude = [...playedIds(), ...(p.current ? [p.current.trackId] : [])];
  const r = await plan(TAIL, exclude, p.current?.trackId, playedIds(), seedFrom);
  if (r.tracks.length) p.replaceUpcoming(r.tracks);
}

/**
 * A vote from the play bar. The whole auto-start UX lives here:
 *
 * No session yet → one begins, silently, adopting the player's current EPOCH (the count of
 * play() calls). That is the exit mechanism: the moment the user play()s anything else — an
 * album, a playlist, even another shuffle of the same library — the epoch moves and the
 * service ends the session. The old plugin watched the queue LABEL instead, and labels
 * collide: a session adopted over "my library" survived a fresh "Play all" that stamped the
 * identical label, and the DJ kept topping up a queue the user had deliberately replaced.
 *
 * The FIRST vote of a session also re-deals the unplayed tail seeded from the current track —
 * the queue audibly becomes the DJ's, whichever direction the vote went. After that, only a
 * "less" re-deals: you said "not this vibe", the queue changing is the expected answer. A
 * "more" leaves the promised up-next alone and reaches the speakers through the next top-up,
 * which is how a human DJ works a request in too.
 */
export async function voteFromBar(p: PlayerApi, direction: 'more' | 'less'): Promise<VoteResult> {
  const current = p.current;
  if (!current) throw new Error('nothing is playing');
  const starting = !active;
  if (starting) {
    startSession(p.epoch);
    notePlayed(current.trackId);
  }
  const r = await voteApi(current.trackId, direction);
  votes.set(current.trackId, direction);
  // A null ghost means "did not move" (unanalysed track), not "gone" — keep the last one.
  moodSnapshot = { mood: r.mood, ghost: r.ghost ?? moodSnapshot?.ghost ?? null };
  bump();
  if (firstVotePending) {
    firstVotePending = false;
    await redeal(p, current.trackId);
  } else if (direction === 'less') {
    await redeal(p);
  }
  return r;
}

/**
 * End DJ session: the sole button a session shows. The session stops (top-ups stop, the queue
 * keeps playing whatever is already dealt, shuffle stays on) and the server forgets the whole
 * mood — weights, votes, ghost. Deliberately everything: ending is "back to normal shuffle",
 * not "pause the DJ".
 */
export function endSession(): void {
  moodSnapshot = null;
  stopSession();
  // Fire-and-forget: a failed wipe leaves stale weights that decay to nothing in hours anyway.
  void resetApi().catch(() => {});
}

/**
 * Reset DJ session (larger displays and CarPlay): fresh ears, keep playing. The mood is wiped
 * AND re-seeded from the current track, the session keeps running with its played history (a
 * heard song is queue hygiene, not mood), and the tail re-deals so the reset is audible.
 */
export async function resetSession(p: PlayerApi): Promise<void> {
  await resetApi(p.current?.trackId);
  moodSnapshot = { mood: { into: [], outOf: [] }, ghost: null };
  firstVotePending = false;
  await redeal(p);
  bump();
}

// ---- the always-mounted service -------------------------------------------------------------

/**
 * The DJ's always-running half: keeps a live session's queue topped up, and notices when the
 * user has moved on. Mounted beside the plugin services in App.tsx — inside PlayerProvider,
 * after the sign-in gate. Renders nothing.
 */
export function DjService() {
  const p = usePlayer();
  useSyncExternalStore(subscribe, getVersion);
  const fetching = useRef(false);

  // Everything that reaches the speakers this session is off the menu afterwards.
  const currentId = p.current?.trackId ?? 0;
  useEffect(() => {
    if (isActive() && currentId) notePlayed(currentId);
  }, [currentId]);

  /*
   * The user outranks the DJ, silently. play() bumps the epoch, so an epoch past the
   * session's means somebody started an album, a playlist, a search result — a choice. The
   * session ends itself rather than fighting the queue back. The mood is deliberately NOT
   * wiped here: drifting away mid-evening and coming back is not "end my session", and
   * unclaimed weights decay to nothing in a few hours anyway.
   */
  useEffect(() => {
    if (isActive() && p.epoch !== sessionEpoch()) stopSession();
  }, [p.epoch]);

  // Top up before the tank is empty: when fewer than three tracks remain ahead, plan five
  // more against the mood as it stands NOW — later votes shape later batches.
  const remaining = p.queue.length - p.index - 1;
  useEffect(() => {
    if (!isActive() || remaining >= 3 || fetching.current) return;
    fetching.current = true;
    const queued = p.queue.map((t) => t.trackId);
    // The new batch plays after whatever is currently last, so tell the planner — the
    // no-same-artist-twice rule has to hold across that seam too.
    const lastQueued = p.queue[p.queue.length - 1]?.trackId;
    void plan(TAIL, [...playedIds(), ...queued], lastQueued, playedIds())
      .then((r) => {
        if (isActive() && r.tracks.length) p.enqueue(r.tracks);
      })
      .catch(() => {
        /* a failed top-up is a shorter queue, not an error worth a toast */
      })
      .finally(() => {
        fetching.current = false;
      });
  }, [remaining, p]);

  return null;
}
