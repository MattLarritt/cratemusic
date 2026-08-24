import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * Thirty-second previews, for songs crate does not have yet.
 *
 * Deliberately NOT part of the main player. The player owns a queue, a
 * position, scrobbles and the media session; a preview is a disposable clip of
 * something you do not own, and threading it through all of that would mean
 * every one of those had to learn about a track with no id and no file. A
 * second, much simpler audio element keeps the two apart.
 *
 * There is exactly one element for the whole app, module scope rather than
 * per-row, because the alternative is a page of rows each able to start its
 * own audio — press three previews and hear three at once.
 */

let el: HTMLAudioElement | null = null;
/** Key of the row currently sounding, so only that row shows itself as playing. */
let currentKey: string | null = null;
const listeners = new Set<(key: string | null) => void>();

function announce(key: string | null): void {
  currentKey = key;
  for (const fn of listeners) fn(key);
}

function audio(): HTMLAudioElement {
  if (!el) {
    el = new Audio();
    el.preload = 'none';
    // Apple's clips are mastered loud next to a typical library rip.
    el.volume = 0.8;
    el.addEventListener('ended', () => announce(null));
    el.addEventListener('error', () => announce(null));
  }
  return el;
}

export function stopPreview(): void {
  if (el) {
    el.pause();
    el.currentTime = 0;
  }
  if (currentKey !== null) announce(null);
}

/**
 * Start a preview, stopping whatever else was previewing.
 *
 * `onBusy` fires around the lookup, which is a network round trip the first
 * time a song is previewed and instant afterwards — without it the button
 * looks unresponsive for the second or so Apple takes to answer.
 */
export async function playPreview(
  key: string,
  artist: string,
  title: string,
): Promise<'playing' | 'none' | 'error'> {
  stopPreview();
  try {
    const { preview } = await api.preview(artist, title);
    if (!preview) return 'none';
    const a = audio();
    a.src = preview.url;
    await a.play();
    announce(key);
    return 'playing';
  } catch {
    announce(null);
    return 'error';
  }
}

/** The sounding row, readable without subscribing — for cleanup on unmount. */
export function currentPreviewKey(): string | null {
  return currentKey;
}

/** Which row is currently previewing, re-rendering only the rows that care. */
export function usePreviewing(): string | null {
  const [key, setKey] = useState<string | null>(currentKey);
  useEffect(() => {
    listeners.add(setKey);
    return () => {
      listeners.delete(setKey);
    };
  }, []);
  return key;
}
