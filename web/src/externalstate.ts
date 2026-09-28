import { useEffect, useSyncExternalStore } from 'react';
import { api, type ExternalHit } from './api';

/**
 * What the page knows about each external song, shared.
 *
 * A search row and the player bar can show the same YouTube song at once, and asking to keep it
 * from either has to move both: a download button that stays lit after the row beside it says
 * "in your library" looks like two different songs. So there is one copy per id, here, and one
 * poller per id however many components are watching it.
 */

const known = new Map<string, ExternalHit>();
const listeners = new Set<() => void>();
const pollers = new Map<string, { n: number; timer: number }>();
/** Transitions already announced, so two watchers do not both say "it's in your library". */
const announced = new Set<string>();

const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** Record a fresh copy — from a search, a keep response, or a poll. */
export function putExternal(hit: Partial<ExternalHit> & { id: string }): void {
  const prev = known.get(hit.id);
  // A partial (a keep response with no row) never blanks what is already known.
  if (!prev && !hit.title) return;
  known.set(hit.id, { ...(prev as ExternalHit), ...hit });
  notify();
}

const busy = (h: ExternalHit | undefined) => h?.state === 'kept' || h?.state === 'downloading';

type Say = (k: 'good' | 'bad', t: string) => void;

/**
 * One external song, kept current while it is being fetched.
 *
 * Polls every five seconds only while a keep is in flight (or might start: `listening`), and
 * says once when it lands or fails.
 * `seed` is what the caller already has (a search hit), so the first render needs no request.
 */
export function useExternal(
  id: string | null,
  opts: { seed?: ExternalHit; say?: Say; /** Also poll a song not yet kept: it is playing, and listening may keep it. */ listening?: boolean } = {},
): ExternalHit | undefined {
  const { seed, say, listening = false } = opts;
  useEffect(() => {
    if (seed && !known.has(seed.id)) putExternal(seed);
  }, [seed]);

  const hit = useSyncExternalStore(subscribe, () => (id ? known.get(id) : undefined));

  // Nothing to start from — the player bar, say, for a song queued from a page since left.
  useEffect(() => {
    if (!id || seed || known.has(id)) return;
    api.externalState(id).then(putExternal).catch(() => undefined);
  }, [id, seed]);

  const inFlight = busy(hit) || (listening && (hit ?? seed)?.state === 'seen');
  useEffect(() => {
    if (!id || !inFlight) return;
    const p = pollers.get(id) ?? {
      n: 0,
      timer: window.setInterval(() => {
        api
          .externalState(id)
          .then((next) => {
            putExternal(next);
            if (next.state === 'imported' && !announced.has(`${id}:imported`)) {
              announced.add(`${id}:imported`);
              say?.('good', `${next.title} is in your library now`);
            }
            if (next.state === 'failed' && !announced.has(`${id}:failed`)) {
              announced.add(`${id}:failed`);
              say?.('bad', `Could not keep ${next.title}${next.error ? ` — ${next.error}` : ''}`);
            }
          })
          .catch(() => undefined);
      }, 5000),
    };
    p.n += 1;
    pollers.set(id, p);
    return () => {
      p.n -= 1;
      if (p.n <= 0) {
        window.clearInterval(p.timer);
        pollers.delete(id);
      }
    };
  }, [id, inFlight, say]);

  return hit ?? seed;
}

/** In this person's library already: nothing left to keep. */
export const isKeptByMe = (h: ExternalHit | undefined): boolean => Boolean(h && h.state === 'imported' && h.mine);

/**
 * Ask for it to be kept, and say what happened in words.
 *
 * Every entry point — the ⋯ menu, the player's button — goes through here, so they all answer
 * the cap and the "already yours" cases the same way.
 */
export async function keepExternal(id: string, title: string, say: Say): Promise<void> {
  const r = await api.externalKeep(id);
  putExternal({ ...r, id });
  announced.delete(`${id}:failed`);
  if (r.outcome === 'owned') say('good', `${title} is in your library`);
  else if (r.outcome === 'capped') say('bad', r.message ?? 'Over your daily download limit');
  else if (r.outcome === 'queued') say('good', `Downloading ${title} — it joins your library in a moment`);
  else say('bad', `Could not keep ${title}`);
}
