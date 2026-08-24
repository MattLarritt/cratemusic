/**
 * The audio player: one element, one queue, shared by every view.
 *
 * The `<audio>` element is created once here and never re-rendered, which is the whole reason
 * this is a context rather than a component per page. Anything that lived inside the view
 * switch would be torn down and rebuilt on navigation, and audio that stops when you click a
 * link is not a music player.
 *
 * PLAY COUNTING follows the Last.fm rule: a play is recorded once a track has run for thirty
 * seconds or half its length, whichever comes first. Counting at play() would make skipping
 * through a queue look like enthusiasm, and every recommendation is built on this number — so
 * a skip before the threshold is reported as a skip instead, which is genuine negative
 * evidence rather than an absence.
 *
 * SHUFFLE keeps the queue intact and shuffles an index order alongside it, with the current
 * track moved to the front. Shuffling the queue itself would make turning shuffle off
 * impossible to undo, and jumping to a random track first would interrupt what is playing.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, type MyTrack } from './api.js';
import { registerAudioElement } from './analyser.js';

export type RepeatMode = 'off' | 'all' | 'one';

/** Anything playable. A queue is built from these and nothing else. */
export interface PlayableTrack {
  trackId: number;
  title: string;
  artistName: string;
  albumTitle: string;
  durationS: number | null;
}

export interface PlayerApi {
  queue: PlayableTrack[];
  current: PlayableTrack | null;
  index: number;
  playing: boolean;
  /**
   * Playback position and length are NOT here.
   *
   * They change four times a second, and everything that touches this context
   * — every song row, every tile — would re-render at that rate. On a page of
   * a few hundred rows that saturates the main thread: the tab hangs and the
   * browser eventually kills the renderer, reporting nothing because the
   * process itself died. They live in their own context; see usePosition.
   */
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  /** A-B repeat bounds in seconds; null when unset. */
  abA: number | null;
  abB: number | null;
  /** Queue label, so the bar can say what is playing. */
  source: string;
  /** Bumped by every play(). "Has somebody started a new queue since X?" in one integer. */
  epoch: number;

  play: (
    tracks: PlayableTrack[],
    startAt?: number,
    source?: string,
    /** true = shuffle this queue; 'held' = the caller already shuffled it, just own the flag. */
    opts?: { shuffle?: boolean | 'held' },
  ) => void;
  toggle: () => void;
  next: (userInitiated?: boolean) => void;
  prev: () => void;
  seek: (seconds: number) => void;
  setVolume: (v: number) => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  /** Sets A, then B, then clears — one button, three states. */
  markAb: () => void;
  clearAb: () => void;
  enqueue: (tracks: PlayableTrack[]) => void;
  /**
   * Swap everything AFTER the playing track for a new tail, without touching what is
   * playing. What a dynamic queue needs and enqueue cannot do: enqueue only appends, so a
   * plugin deciding "actually, play these instead" had no move that did not restart the
   * current song.
   */
  replaceUpcoming: (tracks: PlayableTrack[]) => void;
}

const PlayerContext = createContext<PlayerApi | null>(null);

/** The fast-moving half, kept apart so only the two components that draw it re-render. */
export interface PlayerPosition {
  position: number;
  duration: number;
}
const PositionContext = createContext<PlayerPosition>({ position: 0, duration: 0 });

export function usePlayer(): PlayerApi {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer outside PlayerProvider');
  return ctx;
}

/**
 * Position and duration, for the scrubber and the lyrics panel.
 *
 * Anything else calling this re-renders four times a second, which is exactly
 * the cost this split exists to contain — so call it as low in the tree as it
 * can go, never in something that renders a list.
 */
export function usePosition(): PlayerPosition {
  return useContext(PositionContext);
}

/** Fisher-Yates over indices, with `first` pulled to the front. */
function shuffledOrder(length: number, first: number): number[] {
  const order = Array.from({ length }, (_, i) => i).filter((i) => i !== first);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j] as number, order[i] as number];
  }
  return [first, ...order];
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  if (!audio.current && typeof Audio !== 'undefined') {
    audio.current = new Audio();
    audio.current.preload = 'metadata';
    // The visualizer taps this element through Web Audio. Registered at
    // creation because createMediaElementSource binds to one element for
    // life — see analyser.ts for the ordering rules.
    registerAudioElement(audio.current);
  }

  const [queue, setQueue] = useState<PlayableTrack[]>([]);
  /** Playback order as indices into `queue`. Identity when shuffle is off. */
  const [order, setOrder] = useState<number[]>([]);
  const [orderPos, setOrderPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVol] = useState(() => Number(localStorage.getItem('crate.volume') ?? '1'));
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>('off');
  const [abA, setAbA] = useState<number | null>(null);
  const [abB, setAbB] = useState<number | null>(null);
  const [source, setSource] = useState('');
  /*
   * Counts every play() — every time somebody DELIBERATELY started a new queue. The DJ's
   * auto-stop watches this rather than the source label, because labels collide: a session
   * adopted over "my library" and a fresh "Play all" are both labelled "my library", and the
   * label sentinel read the user's replacement queue as its own. An epoch cannot collide.
   */
  const [epoch, setEpoch] = useState(0);

  /** Whether the current track has already been counted, so it is counted once. */
  const counted = useRef(false);

  const index = order[orderPos] ?? -1;
  const current = queue[index] ?? null;

  /** Report a play or a skip. Fire and forget: a failed count must not interrupt audio. */
  const report = useCallback((trackId: number, skipped: boolean) => {
    void api.notePlay(trackId, skipped).catch(() => {});
  }, []);

  const loadAndPlay = useCallback(
    (q: PlayableTrack[], ord: number[], pos: number) => {
      const el = audio.current;
      const t = q[ord[pos] ?? -1];
      if (!el || !t) return;
      counted.current = false;
      // Reset the clock HERE, where the track changes, rather than trusting the
      // first timeupdate of the new song to correct it. If playback fails to
      // start — an unplayable track, a stalled stream — no timeupdate ever
      // arrives and the scrubber sits frozen at the previous song's position.
      setPosition(0);
      setDuration(0);
      el.src = `/api/stream/${t.trackId}`;
      el.volume = volume;
      void el.play().then(
        () => setPlaying(true),
        () => setPlaying(false),
      );
    },
    [volume],
  );

  /**
   * `opts.shuffle` forces shuffle on for this queue rather than reading the
   * current setting.
   *
   * A caller that wanted a shuffled queue used to call toggleShuffle() and then
   * play(), which cannot work: the state update is asynchronous, so play() still
   * saw shuffle off and started at track one in alphabetical order. Shuffling
   * the library reliably began with All Them Witches.
   *
   * `'held'` is for callers that ALREADY shuffled the deck — the library page and the artist
   * shuffle both deal their own Fisher–Yates so the list on screen and the play order are one
   * array. The transport flag still turns ON (p.shuffle is the honest answer to "is this a
   * shuffle?", and it is what gates the DJ's vote buttons), but the given order plays verbatim
   * — re-shuffling a held deal would desync the screen from the speakers.
   */
  const play = useCallback(
    (
      tracks: PlayableTrack[],
      startAt = 0,
      label = '',
      opts: { shuffle?: boolean | 'held' } = {},
    ) => {
      const playable = tracks.filter((t) => t.trackId > 0);
      if (!playable.length) return;
      const wantShuffle = opts.shuffle === 'held' ? false : (opts.shuffle ?? shuffle);
      const wantFlag = opts.shuffle === undefined ? shuffle : Boolean(opts.shuffle);
      if (wantFlag !== shuffle) setShuffle(wantFlag);
      // startAt refers to the caller's list; map it through the filter so clicking the third
      // row plays the third row even when an unplayable entry sits above it.
      const wanted = tracks[startAt];
      const realStart = Math.max(
        0,
        playable.findIndex((t) => t.trackId === wanted?.trackId),
      );
      /**
       * Where a shuffled queue begins.
       *
       * shuffledOrder pins its `first` to the front, which is right when
       * somebody picked a song and wants the rest shuffled after it. But
       * "Shuffle my library" picks nothing, so it arrived as index 0 and the
       * queue opened with the alphabetically first song every single time —
       * random from track two onwards, which reads as broken.
       *
       * So a shuffle with no chosen song starts somewhere random.
       */
      const anchor =
        opts.shuffle === true && startAt === 0
          ? Math.floor(Math.random() * playable.length)
          : realStart;

      const ord = wantShuffle
        ? shuffledOrder(playable.length, anchor)
        : playable.map((_, i) => i);
      const pos = wantShuffle ? 0 : realStart;
      setQueue(playable);
      setOrder(ord);
      setOrderPos(pos);
      setSource(label);
      setEpoch((e) => e + 1);
      setAbA(null);
      setAbB(null);
      loadAndPlay(playable, ord, pos);
    },
    [shuffle, loadAndPlay],
  );

  const enqueue = useCallback(
    (tracks: PlayableTrack[]) => {
      const playable = tracks.filter((t) => t.trackId > 0);
      if (!playable.length) return;
      /*
       * TWO INDEPENDENT UPDATERS, and that is the whole point.
       *
       * This used to call setOrder INSIDE the setQueue updater. A state updater must be pure —
       * React is free to invoke it more than once to recompute state, and does — so every extra
       * invocation appended the same indices to `order` again while `queue` merged only once.
       * The result was duplicate positions in the play order pointing at the same tracks: a song
       * heard, then heard again a few songs later, which is exactly how a DJ session appears to
       * loop. Caught from a play_log showing one track played twice fifty-six seconds apart.
       *
       * `order` is always a permutation of queue indices, so order.length === queue.length is an
       * invariant (play() and replaceUpcoming() both set the pair together). That means the new
       * indices are derivable from `o` alone — no need to read the queue at all — and each
       * updater is now idempotent under re-invocation.
       */
      setQueue((q) => [...q, ...playable]);
      setOrder((o) => [...o, ...playable.map((_, i) => o.length + i)]);
    },
    [],
  );

  const replaceUpcoming = useCallback(
    (tracks: PlayableTrack[]) => {
      if (!queue.length) return; // Nothing playing: starting a queue is play()'s job.
      const playable = tracks.filter((t) => t.trackId > 0);
      /*
       * History is LINEARISED: the kept part becomes the queue in the order it was heard,
       * regardless of how shuffle scrambled it, so prev still walks back through what actually
       * played. The new tail plays in exactly the order given — a dynamic queue chooses its own
       * order, and the shuffle map has nothing left to say about it. The current track keeps
       * its OBJECT identity and its position, which is what guarantees the audio element is
       * never touched: nothing here calls loadAndPlay.
       */
      const seq = order.length ? order : queue.map((_, i) => i);
      const heard = seq
        .slice(0, orderPos + 1)
        .map((i) => queue[i])
        .filter((t): t is PlayableTrack => Boolean(t));
      const rebuilt = [...heard, ...playable];
      setQueue(rebuilt);
      setOrder(rebuilt.map((_, i) => i));
      setOrderPos(heard.length - 1);
    },
    [queue, order, orderPos],
  );

  const next = useCallback(
    (userInitiated = false) => {
      const el = audio.current;
      // A manual skip before the counting threshold is negative evidence, not a play.
      if (userInitiated && current && !counted.current) report(current.trackId, true);

      if (repeat === 'one' && el && current) {
        el.currentTime = 0;
        counted.current = false;
        void el.play();
        return;
      }
      const last = orderPos >= order.length - 1;
      if (last && repeat !== 'all') {
        setPlaying(false);
        if (el) el.pause();
        return;
      }
      const pos = last ? 0 : orderPos + 1;
      setOrderPos(pos);
      setAbA(null);
      setAbB(null);
      loadAndPlay(queue, order, pos);
    },
    [current, repeat, orderPos, order, queue, loadAndPlay, report],
  );

  const prev = useCallback(() => {
    const el = audio.current;
    // Restart before going back, which is what every player does and what people expect.
    if (el && el.currentTime > 3) {
      el.currentTime = 0;
      return;
    }
    const pos = orderPos > 0 ? orderPos - 1 : 0;
    setOrderPos(pos);
    setAbA(null);
    setAbB(null);
    loadAndPlay(queue, order, pos);
  }, [orderPos, order, queue, loadAndPlay]);

  const toggle = useCallback(() => {
    const el = audio.current;
    if (!el || !current) return;
    if (el.paused) {
      void el.play().then(() => setPlaying(true));
    } else {
      el.pause();
      setPlaying(false);
    }
  }, [current]);

  const seek = useCallback((seconds: number) => {
    const el = audio.current;
    if (el && Number.isFinite(seconds)) el.currentTime = Math.max(0, seconds);
  }, []);

  const setVolume = useCallback((v: number) => {
    const el = audio.current;
    const clamped = Math.min(1, Math.max(0, v));
    if (el) el.volume = clamped;
    setVol(clamped);
    localStorage.setItem('crate.volume', String(clamped));
  }, []);

  const toggleShuffle = useCallback(() => {
    /*
     * The next value is computed here rather than inside a setShuffle updater, for the same
     * reason enqueue() no longer nests its updates: React may invoke an updater more than once,
     * and this one built a RANDOM order and called setOrder from inside it. Each invocation
     * produced a different permutation and the last one silently won — harmless in effect, since
     * the setters are absolute, but it is the same impurity that made enqueue duplicate tracks.
     * `shuffle` is only ever toggled from a click, so reading it from the closure is safe.
     */
    const next = !shuffle;
    setShuffle(next);
    // Rebuild the order around whatever is playing, so toggling never interrupts it.
    if (queue.length) {
      const cur = order[orderPos] ?? 0;
      setOrder(next ? shuffledOrder(queue.length, cur) : queue.map((_, i) => i));
      setOrderPos(next ? 0 : cur);
    }
  }, [shuffle, queue, order, orderPos]);

  const cycleRepeat = useCallback(() => {
    setRepeat((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off'));
  }, []);

  /**
   * One button for A-B: first press marks A, second marks B, third clears.
   *
   * A B before A is a user mistake rather than an error state, so the two are swapped instead
   * of refused.
   */
  const markAb = useCallback(() => {
    const el = audio.current;
    if (!el) return;
    const at = el.currentTime;
    if (abA === null) {
      setAbA(at);
      return;
    }
    if (abB === null) {
      if (at < abA) {
        setAbB(abA);
        setAbA(at);
      } else {
        setAbB(at);
      }
      return;
    }
    setAbA(null);
    setAbB(null);
  }, [abA, abB]);

  const clearAb = useCallback(() => {
    setAbA(null);
    setAbB(null);
  }, []);

  // ---- element events -----------------------------------------------------
  useEffect(() => {
    const el = audio.current;
    if (!el) return;

    const onTime = () => {
      setPosition(el.currentTime);

      // A-B repeat, checked here because timeupdate is the only place the position is known
      // often enough to loop tightly.
      if (abA !== null && abB !== null && el.currentTime >= abB) {
        el.currentTime = abA;
        return;
      }

      // The Last.fm threshold: thirty seconds, or half the track if it is shorter.
      if (!counted.current && current) {
        const half = (el.duration || 0) / 2;
        const threshold = Math.min(30, half > 0 ? half : 30);
        if (el.currentTime >= threshold) {
          counted.current = true;
          report(current.trackId, false);
        }
      }
    };
    const onMeta = () => setDuration(el.duration || 0);
    const onEnd = () => next(false);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);

    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('ended', onEnd);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('ended', onEnd);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
    };
  }, [abA, abB, current, next, report]);

  // Media keys and the lock screen, which is most of what makes this feel like a player.
  useEffect(() => {
    if (!('mediaSession' in navigator) || !current) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title,
      artist: current.artistName,
      album: current.albumTitle,
    });
    navigator.mediaSession.setActionHandler('play', () => toggle());
    navigator.mediaSession.setActionHandler('pause', () => toggle());
    navigator.mediaSession.setActionHandler('nexttrack', () => next(true));
    navigator.mediaSession.setActionHandler('previoustrack', () => prev());
  }, [current, toggle, next, prev]);

  // Space to play/pause, but never while somebody is typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  const value = useMemo<PlayerApi>(
    () => ({
      queue,
      current,
      index: orderPos,
      playing,
      volume,
      shuffle,
      repeat,
      abA,
      abB,
      source,
      epoch,
      play,
      toggle,
      next,
      prev,
      seek,
      setVolume,
      toggleShuffle,
      cycleRepeat,
      markAb,
      clearAb,
      enqueue,
      replaceUpcoming,
    }),
    [
      queue,
      current,
      orderPos,
      playing,
      volume,
      shuffle,
      repeat,
      abA,
      abB,
      source,
      epoch,
      play,
      toggle,
      next,
      prev,
      seek,
      setVolume,
      toggleShuffle,
      cycleRepeat,
      markAb,
      clearAb,
      enqueue,
      replaceUpcoming,
    ],
  );

  // Its own memo and its own provider: this object is replaced on every
  // timeupdate, and the point is that nothing above it is.
  const positionValue = useMemo<PlayerPosition>(() => ({ position, duration }), [position, duration]);

  return (
    <PlayerContext.Provider value={value}>
      <PositionContext.Provider value={positionValue}>{children}</PositionContext.Provider>
    </PlayerContext.Provider>
  );
}

/** Convert a library track into the minimum the player needs. */
export function playable(t: MyTrack | PlayableTrack): PlayableTrack {
  return {
    trackId: t.trackId,
    title: t.title,
    artistName: t.artistName,
    albumTitle: t.albumTitle,
    durationS: t.durationS,
  };
}
