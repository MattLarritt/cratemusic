import type { ComponentType } from 'react';

/**
 * The client half of a compiled-in plugin: which slots in the UI it claims.
 *
 * Mirror of the server contract in src/lib/plugin.ts, and the same philosophy — a plugin is an
 * ordinary module that happens to be enumerated, and this interface lists only the places the
 * shell has to render FOR it: a button on the play bar with a full-screen panel behind it, and
 * a page on the profile. Everything else (its fetch calls, its CSS, its own components) the
 * plugin owns outright and imports like any other code.
 *
 * The id must match the server plugin's id: it becomes the profile URL (/profile/<id>), so the
 * two halves of a feature agree on their name by construction.
 */

export type Say = (k: 'good' | 'bad', t: string) => void;

/** What a play-bar panel is told about the world. It remounts when the track changes. */
export interface PanelProps {
  trackId: number;
  title: string;
  artistName: string;
  onClose: () => void;
  say: Say;
}

export interface UiPlugin {
  id: string;

  /**
   * A button on the play bar (both the desktop cluster and the touch row), and the panel it
   * opens. Panels are portalled to document.body by the shell — the play bar's backdrop-filter
   * makes it a containing block, so anything rendered inside it positions against the BAR
   * rather than the screen. Only one panel is open at a time; the shell arbitrates.
   */
  playbar?: {
    /** Tooltip and aria-label for the button. */
    title: string;
    icon: ComponentType;
    Panel: ComponentType<PanelProps>;
  };

  /** A page on the profile: a nav entry and the pane it shows, at /profile/<id>. */
  profile?: {
    label: string;
    hint: string;
    Pane: ComponentType<{ say: Say }>;
  };

  /**
   * A component that is ALWAYS mounted (and renders nothing visible): the plugin's running
   * half. Panels and panes exist only while looked at, which is right for UI and wrong for
   * behaviour — a plugin that keeps a queue fed, watches playback, or syncs something needs to
   * exist while its UI is closed. Mounted inside PlayerProvider, so usePlayer works; unmounted
   * when the plugin is switched off, so the admin toggle stops the behaviour too.
   */
  Service?: ComponentType;
}
