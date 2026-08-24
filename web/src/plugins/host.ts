import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { del, get, post, put } from '../api';
import { playable, usePlayer } from '../player';
import { Svg } from '../icons';
import { WORDMARK } from '../logo';
import { requestPanel } from './runtime';

/**
 * The host surface installed plugins are built against.
 *
 * An installed plugin's bundle contains none of this — its build (see the crate-plugins repo)
 * aliases `react`, `crate/api` and friends onto shims that read window.crateHost, so a plugin
 * runs on the app's OWN React and the app's own helpers. That is the single-React rule dynamic
 * React plugins live or die by: hooks dispatch through the instance that rendered the tree,
 * and a plugin carrying its own copy renders once and then every hook call throws.
 *
 * This object is therefore a CONTRACT. Removing or renaming a field breaks every installed
 * plugin at runtime, where no compiler is watching — the mirror of this list lives in
 * crate-plugins/types/crate-modules.d.ts, and the two move together or not at all. Adding
 * fields is always safe.
 */
declare global {
  interface Window {
    crateHost?: unknown;
  }
}

window.crateHost = {
  React,
  jsxRuntime,
  api: { get, post, put, del },
  player: { usePlayer, playable },
  plugins: { requestPanel },
  icons: { Svg },
  logo: { WORDMARK },
};
