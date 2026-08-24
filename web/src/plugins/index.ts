import { useSyncExternalStore } from 'react';
import type { UiPlugin } from './types.js';
import { getDisabledVersion, getDynamicUiPlugins, isPluginDisabled, subscribeDisabled } from './runtime.js';

/**
 * The client-side plugin registry. Enabling a feature's UI is one line here, matching the one
 * line its server half adds in src/plugins/index.ts.
 *
 * Explicit, not discovered: Vite could glob a directory, but a feature that appears because a
 * file exists is a feature nobody can grep for. Registry order is display order — play-bar
 * buttons and profile nav entries render in this sequence.
 */
export const UI_PLUGINS: UiPlugin[] = [];

/**
 * The plugins whose UI should render right now: registered minus admin-disabled.
 *
 * A hook so a toggle takes effect without a refresh — the admin flips a switch and their own
 * play bar loses the button in the same breath. Everyone else picks the change up on their
 * next /api/me (a refresh or sign-in), which is the honest cost of not pushing state to
 * clients this app does not otherwise push to.
 */
export function useUiPlugins(): UiPlugin[] {
  useSyncExternalStore(subscribeDisabled, getDisabledVersion);
  // Compiled-in first, then installed — and never both for one id: compiled-in wins,
  // matching the server's rule that code tsc checked outranks code that was downloaded.
  const dynamic = getDynamicUiPlugins().filter((d) => !UI_PLUGINS.some((p) => p.id === d.id));
  return [...UI_PLUGINS, ...dynamic].filter((pl) => !isPluginDisabled(pl.id));
}
