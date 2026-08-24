/**
 * "Open this panel for whatever starts playing next."
 *
 * A one-slot latch rather than an event, and for a timing reason: the panels live inside the
 * play bar, and the play bar does not exist until something is playing. Somebody clicking a
 * song in a plugin's list starts playback and asks for the panel in the same breath — an event
 * dispatched then would be shouted at a component that has not mounted yet and heard by nobody.
 * A latch waits to be collected.
 *
 * Generalised from the chords feature's requestChords(), which was the same mechanism keyed to
 * one hard-wired panel. The play bar consumes it whenever the current track changes.
 */

let wanted: string | null = null;

export function requestPanel(id: string): void {
  wanted = id;
}

export function consumePanelRequest(): string | null {
  const v = wanted;
  wanted = null;
  return v;
}

import type { UiPlugin } from './types.js';

/*
 * Which plugins the admin has switched OFF, mirrored from /api/me (and updated in place when
 * an admin flips a toggle). A tiny external store rather than React context, because the two
 * consumers — the play bar and the profile page — are far apart in the tree and neither has a
 * natural provider above it. useSyncExternalStore keys re-renders off the version counter.
 *
 * Lives here and not beside the registry: the registry's index imports every plugin, plugins
 * import this module (requestPanel), and a registry import from here would close that loop.
 */
let disabledIds = new Set<string>();
let disabledVersion = 0;
const disabledListeners = new Set<() => void>();

export function setDisabledPlugins(ids: string[]): void {
  const next = new Set(ids);
  if (next.size === disabledIds.size && [...next].every((id) => disabledIds.has(id))) return;
  disabledIds = next;
  disabledVersion++;
  for (const fn of disabledListeners) fn();
}

export function isPluginDisabled(id: string): boolean {
  return disabledIds.has(id);
}

export function subscribeDisabled(fn: () => void): () => void {
  disabledListeners.add(fn);
  return () => disabledListeners.delete(fn);
}

export function getDisabledVersion(): number {
  return disabledVersion;
}

/*
 * The UI halves of INSTALLED plugins, import()ed from /plugins/<id>/client.js after sign-in.
 * Kept beside the disabled set because they share the listeners: registering a plugin and
 * disabling one are the same event from a consumer's point of view — "the plugin list changed,
 * render again".
 */
let dynamicUi: UiPlugin[] = [];

export function registerDynamicUiPlugins(plugins: UiPlugin[]): void {
  dynamicUi = plugins;
  disabledVersion++;
  for (const fn of disabledListeners) fn();
}

export function getDynamicUiPlugins(): UiPlugin[] {
  return dynamicUi;
}

/**
 * Fetch and import the client bundles of installed plugins. Called once after sign-in — the
 * list is session-gated, and window.crateHost (see host.ts) is set at module load, long
 * before any of these imports run.
 *
 * Every failure is contained per plugin: a bundle that fails to fetch, parse or export the
 * right shape is skipped with a console warning, because a broken download must degrade to
 * "that feature is missing", never to a blank app.
 */
let uiLoadStarted = false;
export async function loadDynamicUiPlugins(): Promise<void> {
  if (uiLoadStarted) return;
  uiLoadStarted = true;
  let list: { plugins: { id: string; client: string; css: string | null }[] };
  try {
    const res = await fetch('/api/plugins/ui');
    if (!res.ok) return;
    list = (await res.json()) as typeof list;
  } catch {
    return;
  }
  const loaded: UiPlugin[] = [];
  for (const entry of list.plugins) {
    try {
      if (entry.css && !document.querySelector(`link[data-plugin="${entry.id}"]`)) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = entry.css;
        link.dataset.plugin = entry.id;
        document.head.appendChild(link);
      }
      const mod = (await import(/* @vite-ignore */ entry.client)) as { default?: UiPlugin };
      if (!mod.default || mod.default.id !== entry.id) {
        throw new Error('client.js must default-export a UiPlugin whose id matches');
      }
      loaded.push(mod.default);
    } catch (err) {
      console.warn(`plugin ${entry.id} failed to load:`, err);
    }
  }
  if (loaded.length) registerDynamicUiPlugins(loaded);
}
