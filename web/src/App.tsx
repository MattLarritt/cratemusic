import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { PlayerProvider, playable, usePlayer, usePosition } from './player.js';
import { currentPreviewKey, playPreview, stopPreview, usePreviewing } from './preview.js';
import { Artwork } from './artwork.js';
import { applyTheme, readTheme, setTheme, type Theme } from './theme.js';
import { Orbs } from './visualizer.js';
import { STACKED, WORDMARK } from './logo.js';
import { InfoRow, Modal, WithMenu, type MenuItem } from './menu.js';
import { consumePanelRequest, loadDynamicUiPlugins, setDisabledPlugins } from './plugins/runtime.js';
import { UI_PLUGINS, useUiPlugins } from './plugins/index.js';
import {
  DjService,
  endSession,
  moodNow,
  resetSession,
  saveMoodPlaylist,
  useDjActive,
  useDjMood,
  useDjVote,
  voteFromBar,
  type Ghost,
  type Mood,
  type MoodEntry,
} from './dj.js';

/**
 * The always-mounted halves of plugins that have one — see UiPlugin.Service. Its own
 * component so the registry hook re-renders THIS leaf when plugins register or toggle,
 * not the whole App.
 */
function PluginServices() {
  const plugins = useUiPlugins();
  return (
    <>
      {plugins.map((pl) => pl.Service && <pl.Service key={pl.id} />)}
    </>
  );
}
import {
  IconAb,
  IconLyrics,
  IconVolume,
  IconVolumeMute,
  IconNext,
  IconPause,
  IconPlay,
  IconInfo,
  IconPlus,
  IconPrev,
  IconRepeat,
  IconRepeatOne,
  IconShuffle,
} from './icons.js';
import { IconDjEnd, IconDjReset, IconInsight, IconThumbDown, IconThumbUp } from './icons.js';
import {
  api,
  NeedsLogin,
  playlistArtUrl,
  type AdminSettings,
  type AvailablePlugin,
  type PluginSwitchboard,
  type ChartTrack,
  type AdminStats,
  type AlbumPage,
  type AlbumTrack,
  type CrateUser,
  type ArtistDetail,
  type HomePage,
  type ImportItem,
  type ImportRun,
  type Release,
  type Images,
  type LocalSearch,
  type ListeningSummary,
  type GenreVocab,
  type PlaylistRules,
  type RuleTerm,
  type Me,
  type RequestRow,
  type EventInfo,
  type Exclusion,
  type LibraryAlbum,
  type LibraryAlbumRow,
  type LibraryArtist,
  type LibrarySort,
  type MyTrack,
  type Orphan,
  type Playlist,
  type RecSet,
  type TrackHit,
  type TrackInfo,
  type AnalysisProgress,
  type WarmProgress,
  type CharacteristicDef,
  type SimilarTrack,
  type TrackAnalysisStatus,
  type TrackCharacteristic,
  type SearchProbe,
  type Webhook,
  type SearchAlbum,
  type UploadedFile,
  type AdoptableEntry,
  type AlgoProfile,
  type WarmthEntry,
  type WarmthKind,
  type SearchResult,
} from './api.js';

/**
 * Real URLs, so the browser Back button works and pages can be linked.
 *
 * This started as plain state, which meant Back left the site entirely — the
 * history stack had no entries for anything inside the app. Five routes does not
 * justify a router dependency, but it does need the History API used properly:
 * pushState on navigation, a popstate listener to follow the browser, and real
 * <a href> elements so middle-click and "open in new tab" behave.
 *
 * Deep links survive a refresh because the server already serves index.html for
 * any non-/api path — see the SPA fallback in main.ts.
 */
type View =
  | { name: 'home' }
  | { name: 'search'; q: string }
  | { name: 'artist'; mbid: string; album?: string }
  /**
   * An artist known only by name, with the id still to be looked up.
   *
   * The front page's tiles come from Last.fm, which gives a name and no id, so
   * opening one needs a search first. Doing that BEFORE navigating meant the
   * tile dimmed and the app sat still for as long as the lookup took. This is a
   * real address for "that artist, id pending": the page opens at once, shows
   * the name it already has, and swaps itself for the id URL once it knows it.
   */
  | { name: 'artistByName'; artist: string }
  | { name: 'requests' }
  | { name: 'listening' }
  | { name: 'gaps' }
  | { name: 'mylibrary' }
  | { name: 'librarysongs' }
  | { name: 'libraryartists' }
  | { name: 'libraryalbums' }
  | { name: 'playlists' }
  /** An album page, keyed on names because nothing here has a numeric album id. */
  | { name: 'albumpage'; artist: string; album: string; mbid?: string }
  | { name: 'playlist'; id: number }
  /** Discover is the recommendation-and-charts page; '/' shows whichever page
   *  the account chose as home, so both need to be addressable. */
  | { name: 'discover' }
  | { name: 'profile'; page: ProfilePage }
  /** The admin section. `page` selects which pane the left nav has open. */
  | { name: 'admin'; page: AdminPage };

/*
 * A string rather than a literal union, because plugins add pages at runtime — INSTALLED
 * plugins after the first URL parse — so neither a union nor a static allowlist can enumerate
 * them. The honest cost: a typo in a navigate() call stops being a compile error. The real
 * validation lives in ProfileView, which renders a page only if something claims it and falls
 * back to preferences otherwise — reactively, so a plugin page bookmarked and hard-refreshed
 * shows preferences for the instant before the plugin registers, then its own pane.
 */
export type ProfilePage = string;

export type AdminPage =
  | 'statistics'
  | 'library'
  | 'users'
  | 'imports'
  | 'downloading'
  | 'adopt'
  | 'lastfm'
  | 'plugins'
  | 'webhooks';
const ADMIN_PAGES: AdminPage[] = [
  'statistics',
  'library',
  'users',
  'imports',
  'downloading',
  'adopt',
  'lastfm',
  'plugins',
  'webhooks',
];

/** The URL for a view. One place, so links and navigation cannot disagree. */
/**
 * The mark, drawn rather than fetched.
 *
 * Inline so `fill: currentColor` resolves against the page — an SVG behind an
 * <img> is its own document and would resolve it to black, which is why the
 * PNG version needed an invert filter to survive a dark theme. Colour now
 * comes from `color` like any other text, and the logo is present in the first
 * paint instead of arriving with a later request.
 */
function Logo({ of }: { of: { w: number; h: number; d: string } }) {
  return (
    <svg
      viewBox={`0 0 ${of.w} ${of.h}`}
      role="img"
      aria-label="Crate"
      preserveAspectRatio="xMidYMid meet"
    >
      <path fill="currentColor" fillRule="evenodd" d={of.d} />
    </svg>
  );
}

function hrefFor(v: View): string {
  switch (v.name) {
    case 'home':
      return '/';
    case 'search':
      return `/search?q=${encodeURIComponent(v.q)}`;
    case 'artist':
      return v.album
        ? `/artist/${encodeURIComponent(v.mbid)}/album/${encodeURIComponent(v.album)}`
        : `/artist/${encodeURIComponent(v.mbid)}`;
    case 'artistByName':
      return `/artist/by-name/${encodeURIComponent(v.artist)}`;
    case 'requests':
      return '/requests';
    case 'listening':
      return '/listening';
    case 'gaps':
      return '/gaps';
    case 'mylibrary':
      return '/library';
    case 'librarysongs':
      return '/library/songs';
    case 'libraryartists':
      return '/library/artists';
    case 'libraryalbums':
      return '/library/albums';
    case 'playlists':
      return '/playlists';
    case 'albumpage':
      return (
        `/album/${encodeURIComponent(v.artist)}/${encodeURIComponent(v.album)}` +
        (v.mbid ? `?mb=${encodeURIComponent(v.mbid)}` : '')
      );
    case 'playlist':
      return `/playlists/${v.id}`;
    case 'discover':
      return '/discover';
    case 'profile':
      return `/profile/${v.page}`;
    case 'admin':
      return `/admin/${v.page}`;
  }
}

/** The view for the current URL. Anything unrecognised falls back to home. */
function viewFromUrl(): View {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const q = new URLSearchParams(window.location.search);

  if (path === '/') return { name: 'home' };
  if (path === '/search') return { name: 'search', q: q.get('q') ?? '' };
  if (path === '/requests') return { name: 'requests' };
  if (path === '/listening') return { name: 'listening' };
  if (path === '/gaps') return { name: 'gaps' };
  if (path === '/library') return { name: 'mylibrary' };
  if (path === '/library/songs') return { name: 'librarysongs' };
  if (path === '/library/artists') return { name: 'libraryartists' };
  if (path === '/library/albums') return { name: 'libraryalbums' };
  if (path === '/playlists') return { name: 'playlists' };
  const ap = path.match(/^\/album\/([^/]+)\/([^/]+)$/);
  if (ap && ap[1] && ap[2]) {
    return {
      name: 'albumpage',
      artist: decodeURIComponent(ap[1]),
      album: decodeURIComponent(ap[2]),
      // Carried in the URL so a link to an album crate does not hold yet can
      // still render its MusicBrainz tracklist after a reload.
      mbid: q.get('mb') ?? undefined,
    };
  }
  const pl = path.match(/^\/playlists\/(\d+)$/);
  if (pl) return { name: 'playlist', id: Number(pl[1]) };
  if (path === '/discover') return { name: 'discover' };
  // /users was the old account page; old links land on the profile.
  if (path === '/profile' || path === '/users') return { name: 'profile', page: 'preferences' };
  const pp = path.match(/^\/profile\/([a-z]+)$/);
  if (pp) {
    const page = pp[1] as ProfilePage;
    // Any slug is accepted here; ProfileView decides what actually renders (see ProfilePage).
    return { name: 'profile', page };
  }
  // /admin lands on Statistics; an unknown sub-page does the same rather than
  // rendering an empty pane.
  if (path === '/admin') return { name: 'admin', page: 'statistics' };
  const admin = path.match(/^\/admin\/([a-z.]+)$/);
  if (admin) {
    const page = admin[1] as AdminPage;
    return { name: 'admin', page: ADMIN_PAGES.includes(page) ? page : 'statistics' };
  }

  const byName = path.match(/^\/artist\/by-name\/([^/]+)$/);
  if (byName && byName[1]) return { name: 'artistByName', artist: decodeURIComponent(byName[1]) };

  const m = path.match(/^\/artist\/([^/]+)(?:\/album\/([^/]+))?$/);
  if (m && m[1]) {
    return { name: 'artist', mbid: decodeURIComponent(m[1]), album: m[2] ? decodeURIComponent(m[2]) : undefined };
  }
  return { name: 'home' };
}

type Toast = { kind: 'good' | 'bad'; text: string } | null;

/**
 * Navigate, and keep the history stack useful.
 *
 * `replace` exists for search-as-you-type: pushing an entry per keystroke would
 * fill the stack with a dozen half-typed queries and make Back useless, which is
 * the very thing this routing was added to fix.
 */
function navigate(v: View, opts: { replace?: boolean } = {}): void {
  const url = hrefFor(v);
  if (opts.replace) window.history.replaceState({}, '', url);
  else window.history.pushState({}, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/**
 * A real link that routes internally.
 *
 * The href is genuine so middle-click, cmd-click and "copy link" all work; the
 * click handler only intercepts a plain left click, which is what keeps those
 * behaviours intact instead of swallowing every interaction.
 */
function Link({
  to,
  children,
  className,
  onNavigate,
}: {
  to: View;
  children: React.ReactNode;
  className?: string;
  onNavigate?: () => void;
}) {
  return (
    <a
      href={hrefFor(to)}
      className={className}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
          return;
        }
        e.preventDefault();
        onNavigate?.();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}


/**
 * Best available artwork, largest first, with a letter as the last resort.
 *
 * `byName` is for cards that have only an artist name — Last.fm suggestions —
 * where the server resolves artwork on demand and caches it. Doing that per card
 * rather than up front means the page paints immediately instead of waiting on
 * dozens of lookups.
 */
function Art({
  images,
  label,
  byName,
  shape = 'square',
}: {
  images?: Images;
  label: string;
  byName?: string;
  /**
   * Albums and songs are squares with a 15px radius; artists are circles.
   *
   * One rule applied everywhere, so a cover is recognisably the same object on the home page,
   * an album page, a search result and the play bar — and a person is never mistaken for a
   * record, which is what a single rounded box for both used to allow.
   */
  shape?: 'square' | 'circle';
}) {
  const direct = images?.cover ?? images?.poster ?? images?.fanart ?? images?.banner;
  const src = direct ?? (byName ? `/api/art/artist?name=${encodeURIComponent(byName)}` : undefined);

  return (
    <div className={`art ${shape}`}>
      <Artwork src={src} kind={shape === 'circle' ? 'artist' : 'album'} alt={label} />
    </div>
  );
}

/**
 * Sign-in screen.
 *
 * crate has its own accounts. gatekeeper, if it is in front of this host, is a
 * separate gate the browser has already passed before reaching this form — it
 * does not replace it.
 */
function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hasUsers, setHasUsers] = useState<boolean | null>(null);

  useEffect(() => {
    api.setup().then((s) => setHasUsers(s.hasUsers)).catch(() => setHasUsers(null));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.login(username, password);
      onSignedIn();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="loginwrap">
      <form className="logincard" onSubmit={(e) => void submit(e)}>
        <div className="brand stacked">
          <Logo of={STACKED} />
        </div>

        {hasUsers === false && (
          <div className="note bad">
            No accounts exist yet. Set <code>CRATE_BOOTSTRAP_USER</code> and{' '}
            <code>CRATE_BOOTSTRAP_PASSWORD</code> in <code>.env</code> and restart the container.
          </div>
        )}

        <label className="field">
          <span>Username</span>
          <input
            autoFocus
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {err && <div className="note bad" style={{ marginBottom: 12 }}>{err}</div>}

        <button className="btn" style={{ width: '100%' }} disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  // null = still checking. Distinguishing "not yet known" from "signed out"
  // stops the login form flashing on every load for a signed-in user.
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  // The URL is the source of truth for which view is showing. Local state would
  // drift from the address bar the moment the browser navigated on its own.
  const [view, setView] = useState<View>(() => viewFromUrl());
  const initial = view.name === 'search' ? view.q : '';
  const [q, setQ] = useState(initial);
  const [toast, setToast] = useState<Toast>(null);

  // navigate() dispatches popstate itself, so this one listener handles both our
  // own navigation and the browser's Back and Forward buttons.
  /*
   * True only while OUR OWN typing-driven navigate() is running.
   *
   * navigate() dispatches popstate synchronously so one listener serves both our navigation and
   * the browser's buttons — which meant typing a single letter erased itself: one character is
   * below the two-character search threshold, so the debounce navigated HOME, and the listener
   * below dutifully cleared the box the user was still typing into. A genuine Back or Forward
   * has this flag false and still resyncs the box, which is what the listener is for.
   */
  const typingNav = useRef(false);

  useEffect(() => {
    const sync = () => {
      const next = viewFromUrl();
      setView(next);
      // Keep the search box in step when arriving via Back, otherwise it shows a
      // query that no longer matches the results below it. Never while the user is mid-word.
      if (!typingNav.current) setQ(next.name === 'search' ? next.q : '');
    };
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const loadMe = useCallback(() => {
    api
      .me()
      .then((m) => {
        setMe(m);
        // The plugin store feeds the play bar and the profile page; see plugins/runtime.ts.
        setDisabledPlugins(m.disabledPlugins ?? []);
        // Installed plugins' client bundles, import()ed once per session. Idempotent.
        void loadDynamicUiPlugins();
        setSignedIn(true);
      })
      .catch((e) => {
        setMe(null);
        setSignedIn(!(e instanceof NeedsLogin) ? true : false);
      });
  }, []);

  useEffect(() => loadMe(), [loadMe]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  /*
   * Short debounce now, because typing only drives the LOCAL search — a SQLite lookup the
   * server answers in milliseconds. The expensive MusicBrainz half no longer rides on every
   * keystroke: SearchView fires it once the query has sat still (or Enter says "now").
   */
  const timer = useRef<number | undefined>(undefined);
  const onType = (value: string) => {
    setQ(value);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const next: View =
        value.trim().length >= 2 ? { name: 'search', q: value.trim() } : { name: 'home' };
      // Entering search pushes once; refining an existing search replaces, so a
      // dozen half-typed queries do not bury the page Back should return to.
      typingNav.current = true;
      try {
        navigate(next, { replace: window.location.pathname === '/search' });
      } finally {
        // navigate() dispatches popstate synchronously, so the listener has already run by here.
        typingNav.current = false;
      }
    }, 250);
  };
  /** Enter skips both waits: the search page now, the wide search immediately on it. */
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || q.trim().length < 2) return;
    window.clearTimeout(timer.current);
    requestWideSearch();
    navigate({ name: 'search', q: q.trim() }, { replace: window.location.pathname === '/search' });
  };

  const say = useCallback((kind: 'good' | 'bad', text: string) => setToast({ kind, text }), []);

  // Fold the search row away once the page is scrolled, so the sticky header on
  // a phone is just brand, tabs and avatar. The CSS only applies this under
  // 820px; tracking scroll on desktop costs nothing and changes nothing.
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const onScroll = () => setCompact(window.scrollY > 64);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (signedIn === null) return <div className="spinner">Loading…</div>;
  if (signedIn === false) {
    return <Login onSignedIn={() => { setSignedIn(null); loadMe(); }} />;
  }

  return (
    <>
      {/* Behind everything, reacting to the music. Sits above the theme's
          static glow (later in the tree, same z-index) and below all content. */}
      <Orbs />
      {/* Invisible: plugins' always-running halves. After the sign-in gate on purpose —
          a service acts as the user, so it exists only while somebody is signed in. */}
      <PluginServices />
      {/* The DJ's always-running half: same rules, but native — see dj.tsx. */}
      <DjService />
      <header className={`top${compact ? ' compact' : ''}`}>
        <Link to={{ name: 'home' }} className="brand" onNavigate={() => setQ('')}>
          <Logo of={WORDMARK} />
        </Link>
        <input
          type="search"
          placeholder="Search for an artist, album or song…"
          value={q}
          onChange={(e) => onType(e.target.value)}
          onKeyDown={onSearchKey}
        />
        {/* Three places, styled as tabs rather than buttons: these are where you
            ARE, not things you do. Everything account-shaped lives behind the
            avatar on the right. */}
        <nav className="tabs">
          <Link
            to={{ name: 'mylibrary' }}
            className={`tab${
              view.name === 'mylibrary' ||
              view.name === 'librarysongs' ||
              (view.name === 'home' && me?.homePage === 'mylibrary')
                ? ' active'
                : ''
            }`}
          >
            My Library
          </Link>
          <Link
            to={{ name: 'playlists' }}
            className={`tab${
              view.name === 'playlists' ||
              view.name === 'playlist' ||
              (view.name === 'home' && me?.homePage === 'playlists')
                ? ' active'
                : ''
            }`}
          >
            Playlists
          </Link>
          <Link
            to={{ name: 'discover' }}
            className={`tab${
              view.name === 'discover' ||
              (view.name === 'home' && (me?.homePage ?? 'discover') === 'discover')
                ? ' active'
                : ''
            }`}
          >
            Discover
          </Link>
        </nav>
        {me && (
          <UserMenu
            me={me}
            onSignOut={() => void api.logout().then(() => { setMe(null); setSignedIn(false); })}
          />
        )}
      </header>

      <main>
        {/* '/' is whichever page this account calls home; Discover keeps its
            own address so the tab still works when home is something else. */}
        {view.name === 'home' && (me?.homePage === 'mylibrary' ? (
          <MyLibraryView say={say} />
        ) : me?.homePage === 'playlists' ? (
          <PlaylistsView say={say} />
        ) : (
          <HomeView say={say} />
        ))}
        {view.name === 'discover' && <HomeView say={say} />}
        {view.name === 'search' && <SearchView q={view.q} say={say} />}
        {view.name === 'artist' && (
          <ArtistView
            key={view.mbid}
            mbid={view.mbid}
            openAlbum={view.album}
            me={me}
            say={say}
          />
        )}
        {view.name === 'artistByName' && (
          <ArtistByName key={view.artist} artist={view.artist} say={say} />
        )}
        {view.name === 'requests' && <RequestsView say={say} admin={!!me?.admin} />}
        {view.name === 'listening' && <ListeningView say={say} />}
        {view.name === 'gaps' && <GapsView say={say} />}
        {view.name === 'mylibrary' && <MyLibraryView say={say} />}
        {view.name === 'librarysongs' && <LibrarySongsView say={say} />}
        {view.name === 'libraryartists' && <LibraryArtistsView say={say} />}
        {view.name === 'libraryalbums' && <LibraryAlbumsView say={say} />}
        {view.name === 'playlists' && <PlaylistsView say={say} />}
        {view.name === 'albumpage' && (
          <AlbumPageView
            key={`${view.artist}/${view.album}`}
            artist={view.artist}
            album={view.album}
            mbid={view.mbid}
            say={say}
          />
        )}
        {view.name === 'playlist' && <PlaylistView id={view.id} say={say} />}
        {view.name === 'profile' && (
          <ProfileView
            me={me}
            page={view.page}
            say={say}
            onPrefsChanged={loadMe}
            onSignedOut={() => {
              setMe(null);
              setSignedIn(false);
            }}
          />
        )}
        {view.name === 'admin' && (
          <AdminView
            page={view.page}
            me={me}
            say={say}
            onSignedOut={() => {
              setMe(null);
              setSignedIn(false);
            }}
          />
        )}
      </main>

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}

      {/* Outside the view switch on purpose: the audio element it drives must survive
          navigation, or playback stops every time somebody clicks a link. */}
      <PlayBar say={say} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

/**
 * The tag charts on offer. Genres are a curated set rather than everything
 * Last.fm knows, because a wall of two hundred chips is a worse picker than
 * twelve good ones. Eras are decades — the best-populated time tags — and the
 * year box takes any specific year, since those tags exist too.
 */
const CHART_GENRES = [
  'rock', 'pop', 'metal', 'nu metal', 'hip-hop', 'electronic',
  'indie', 'punk', 'alternative', 'jazz', 'folk', 'soul',
];
const CHART_ERAS = ['60s', '70s', '80s', '90s', '2000s', '2010s', '2020s'];

/** One page of a Discover shelf, and the ceiling paging stops at. */
const PAGE = 20;
const PAGE_MAX = 100;

/**
 * Reveal a shelf twenty at a time.
 *
 * Every Discover shelf used to take a different arbitrary slice — 18 here, 14
 * there — with no way past it, so a recommendation ranked twentieth may as well
 * not have existed. One hook means every shelf pages the same way and the
 * counts in each button are honest about what is left.
 */
function usePaged<T>(
  items: T[],
  /** Changing this starts the shelf over — a new genre is a new chart. */
  resetKey?: string,
): {
  shown: T[];
  more: number;
  /** True once expanded, so the shelf can stop being a sideways scroller. */
  expanded: boolean;
  showMore: () => void;
} {
  const [n, setN] = useState(PAGE);
  useEffect(() => {
    setN(PAGE);
  }, [resetKey]);
  const cap = Math.min(items.length, PAGE_MAX);
  const shown = items.slice(0, Math.min(n, cap));
  return {
    shown,
    more: Math.max(0, cap - shown.length),
    expanded: n > PAGE,
    showMore: () => setN((v) => Math.min(v + PAGE, PAGE_MAX)),
  };
}

/**
 * A horizontally scrolling row, navigable with a mouse.
 *
 * The row was built for a thumb and works for one. A desktop has no swipe,
 * and the scrollbar is deliberately hidden — so everything past the viewport
 * edge, including the Show-more tile at the end, was simply unreachable.
 *
 * Arrows fix that WITHOUT touching the phone: they only exist under
 * `hover: hover`, so a touch device renders the same markup and shows
 * nothing. They page by roughly a screenful, and each hides itself at its own
 * end of the travel rather than sitting there disabled — an arrow that cannot
 * do anything is noise on a page that is mostly artwork.
 *
 * An expanded shelf wraps instead of scrolling, so it gets no arrows at all.
 */
function Shelf({ open = false, children }: { open?: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [reach, setReach] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // A pixel of slack: fractional scroll widths mean scrollLeft rarely lands
    // exactly on the maximum, which would leave the right arrow up forever.
    setReach({
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    });
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    // Contents arrive asynchronously — art, extra pages — and each changes
    // whether there is anywhere left to go.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure, children]);

  const page = (dir: -1 | 1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(el.clientWidth - 120, 200), behavior: 'smooth' });
  };

  return (
    <div className="shelfwrap">
      {!open && reach.left && (
        <button className="shelfnav left" aria-label="Scroll left" onClick={() => page(-1)}>
          ‹
        </button>
      )}
      <div className={`shelf2${open ? ' open' : ''}`} ref={ref} onScroll={measure}>
        {children}
      </div>
      {!open && reach.right && (
        <button className="shelfnav right" aria-label="Scroll right" onClick={() => page(1)}>
          ›
        </button>
      )}
    </div>
  );
}

/**
 * Show more, shaped to sit as the LAST ITEM of the shelf it belongs to.
 *
 * A control parked underneath a horizontally scrolling row is easy to miss —
 * you scroll to the end of the tiles and the row simply stops. As the final
 * tile it is where the eye already is. Same shape as the Show-more tile on My
 * Library, so both pages teach the same gesture; the difference is that this
 * one reveals in place rather than navigating.
 */
function ShowMore({ more, onClick }: { more: number; onClick: () => void }) {
  if (more <= 0) return null;
  return (
    <button className="showall tileform shelfmore" onClick={onClick}>
      Show {Math.min(more, PAGE)} more
      <span className="muted">{more} left</span>
    </button>
  );
}

function HomeView({ say }: { say: (k: 'good' | 'bad', t: string) => void }) {
  const p = usePlayer();
  const [home, setHome] = useState<HomePage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [genre, setGenre] = useState('rock');
  const [era, setEra] = useState('90s');
  const [yearBox, setYearBox] = useState('');

  useEffect(() => {
    api.home().then(setHome).catch((e: Error) => setErr(e.message));
  }, []);

  // Above the early returns, because hooks cannot be called conditionally and
  // both returns below are conditional. Each reads through the optional chain
  // so it is simply empty until the page arrives.
  const recTracks = usePaged(home?.rec?.tracks ?? []);
  const recArtists = usePaged(home?.rec?.artists ?? []);
  const recAlbums = usePaged(home?.rec?.albums ?? []);

  if (err) return <div className="note bad">{err}</div>;
  if (!home) return <div className="spinner">Loading your crate…</div>;

  const rec = home.rec;

  // The hero leads with whatever is playing, then the top of most-played, then the
  // newest arrival — so the page always opens with a record rather than a heading.
  const heroTrack = p.current ?? home.mostPlayed[0] ?? home.newest[0] ?? null;

  return (
    <>
      {heroTrack && (
        <Hero
          title={heroTrack.title}
          artist={heroTrack.artistName}
          album={heroTrack.albumTitle}
          kicker={
            p.current ? 'Now playing' : home.mostPlayed[0] ? 'Your most played' : 'Just added'
          }
          {...(() => {
            /*
             * The hero's buttons ask the server for the queue rather than
             * replaying the page's payload. That payload now carries only
             * enough rows to name the hero, since Discover stopped listing
             * these — without this the buttons would quietly play a dozen
             * songs and stop.
             */
            const kind = home.mostPlayed.length ? 'mostplayed' : 'newest';
            const label = home.mostPlayed.length ? 'most played' : 'recently added';
            const start = (shuffle: boolean) => {
              void api.queue({ kind }).then((r) => {
                if (!r.tracks.length) return;
                // The race-free form: play() flips the transport itself (player.tsx explains
                // why toggling first was a lost race), and it keeps p.shuffle the honest gate
                // for the DJ's vote buttons.
                p.play(r.tracks.map(playable), 0, shuffle ? 'shuffled' : label, { shuffle });
              });
            };
            return { onPlay: () => start(false), onShuffle: () => start(true) };
          })()}
        />
      )}

      {!home.lastfm && (
        <div className="note">
          No Last.fm key is configured, so there are no recommendations. Search, requests and
          playback all work regardless — add a key under Admin → Last.fm.
        </div>
      )}
      {home.cold && (
        <div className="note">
          Nothing played yet. Play a few things and this page starts following what you actually
          listen to rather than what you happen to own.
        </div>
      )}

      {/* Most played and Recently added used to sit here. They are the
          library looking at itself, which is My Library's job — Discover is
          for what you do NOT already have. The hero still leans on them,
          because opening with a record you love beats opening with a
          heading. */}

      {rec && rec.tracks.length > 0 && (
        <>
          <div className="sechead">
            <h2>Songs for you</h2>
            <span className="sub">from what you play</span>
          </div>
          {/* One shelf, one rule: a song is in your library or it is not. Whether
              adding it is instant (the pool already has it) or a download is the
              server's business — the tile just says Add either way. This used to
              be two shelves, "Ready to play" and "Worth downloading", and the
              first of them offered play buttons for songs that were not in the
              library and therefore could not stream. */}
          <Shelf open={recTracks.expanded}>
            {recTracks.shown.map((t, i) => (
              <SongTile
                key={`${t.artistName}-${t.title}-${i}`}
                title={t.title}
                artist={t.artistName}
                album={t.albumTitle}
                why={t.because}
                say={say}
                instantAddId={t.onDisk && t.trackId > 0 ? t.trackId : null}
                downloadable={!t.onDisk}
              />
            ))}
            <ShowMore more={recTracks.more} onClick={recTracks.showMore} />
          </Shelf>
        </>
      )}

      {rec && rec.artists.length > 0 && (
        <>
          <div className="sechead">
            <h2>Artists for you</h2>
            <span className="sub">from what you play</span>
          </div>
          <Shelf open={recArtists.expanded}>
            {recArtists.shown.map((a) => (
              <ArtistTile key={a.name} name={a.name} why={a.because} say={say} />
            ))}
            <ShowMore more={recArtists.more} onClick={recArtists.showMore} />
          </Shelf>
        </>
      )}

      {rec && rec.albums.length > 0 && (
        <>
          <div className="sechead">
            <h2>Albums for you</h2>
            <span className="sub">from what you play</span>
          </div>
          {/* No play button here: these are recommendations, so by definition
              they are not in the library yet, and a play control on something
              that cannot stream is a lie. The album page is where the tracks
              get added. Whether the files happen to be pooled already is not
              the listener's concern. */}
          <Shelf open={recAlbums.expanded}>
            {recAlbums.shown.map((a) => (
              <AlbumTile
                key={`${a.artistName}-${a.albumTitle}`}
                artist={a.artistName}
                album={a.albumTitle}
                subtitle={a.artistName}
                why={a.because}
                say={say}
              />
            ))}
            <ShowMore more={recAlbums.more} onClick={recAlbums.showMore} />
          </Shelf>
        </>
      )}

      {home.lastfm && (
        <>
          <div className="sechead">
            <h2>Top tracks by genre</h2>
            <span className="sub">what the world plays</span>
          </div>
          <div className="chips">
            {CHART_GENRES.map((g) => (
              <button
                key={g}
                className={`chip${g === genre ? ' on' : ''}`}
                onClick={() => setGenre(g)}
              >
                {g}
              </button>
            ))}
          </div>
          <ChartShelf tag={genre} say={say} />

          <div className="sechead">
            <h2>Top artists by genre</h2>
            <span className="sub">who the world plays</span>
          </div>
          <ArtistChartShelf tag={genre} />

          <div className="sechead">
            <h2>Top tracks by year</h2>
            <span className="sub">pick a decade, or type a year</span>
          </div>
          <div className="chips">
            {CHART_ERAS.map((e) => (
              <button
                key={e}
                className={`chip${e === era ? ' on' : ''}`}
                onClick={() => setEra(e)}
              >
                {e}
              </button>
            ))}
            <input
              className="chip yearbox"
              inputMode="numeric"
              placeholder="year…"
              value={yearBox}
              onChange={(e) => setYearBox(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && yearBox.length === 4) setEra(yearBox);
              }}
              onBlur={() => {
                if (yearBox.length === 4) setEra(yearBox);
              }}
            />
          </div>
          <ChartShelf tag={era} say={say} />

          <div className="sechead">
            <h2>Top artists by year</h2>
            <span className="sub">who defined it</span>
          </div>
          <ArtistChartShelf tag={era} />
        </>
      )}

      {home.mostPlayed.length === 0 && home.newest.length === 0 && (
        <div className="empty">
          Your library is empty. Search for a song and either add it — if somebody already
          downloaded it — or download it.
        </div>
      )}
    </>
  );
}

/** Album art by name, which is what every tile and the hero backdrop resolve through. */
function albumArtUrl(artist: string, album: string): string {
  return `/api/art/album?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`;
}

/** Group a flat track list into albums, preserving the order they first appear. */
function albumsOf(tracks: MyTrack[]): { artistName: string; albumTitle: string; tracks: MyTrack[] }[] {
  const out: { artistName: string; albumTitle: string; tracks: MyTrack[] }[] = [];
  const seen = new Map<string, number>();
  for (const t of tracks) {
    const key = `${t.artistName}|${t.albumTitle}`;
    const at = seen.get(key);
    if (at === undefined) {
      seen.set(key, out.length);
      out.push({ artistName: t.artistName, albumTitle: t.albumTitle, tracks: [t] });
    } else {
      out[at]?.tracks.push(t);
    }
  }
  return out;
}

/**
 * The hero.
 *
 * The backdrop is the record's own cover, blown up and blurred, which gives every hero a
 * palette taken from the music rather than one fixed gradient — and costs nothing, since the
 * same cached image is already being fetched for the tile.
 */
function Hero({
  title,
  artist,
  album,
  kicker,
  onPlay,
  onShuffle,
}: {
  title: string;
  artist: string;
  album: string;
  kicker: string;
  onPlay: () => void;
  onShuffle: () => void;
}) {
  const p = usePlayer();
  const url = albumArtUrl(artist, album);
  const [failed, setFailed] = useState(false);

  return (
    <div className="hero2">
      {/* The blurred backdrop is pure decoration, so it simply goes when the
          image will not load — a placeholder blown up and blurred is noise. */}
      {!failed && <div className="backdrop" style={{ backgroundImage: `url("${url}")` }} />}
      <div className="cover">
        {/* Probe the same URL so the backdrop learns about a failure too. */}
        <img
          src={url}
          alt=""
          style={{ display: 'none' }}
          onError={() => setFailed(true)}
        />
        <Artwork src={url} kind="album" alt={album} />
      </div>
      <div className="words">
        <div className="kicker">{kicker}</div>
        <h1>{title}</h1>
        <div className="by">
          {artist}
          {album ? ` · ${album}` : ''}
        </div>
        <div className="acts">
          <button className="btn" onClick={p.current ? p.toggle : onPlay}>
            {p.current && p.playing ? (
              <>
                <IconPause /> Pause
              </>
            ) : (
              <>
                <IconPlay /> Play
              </>
            )}
          </button>
          <button className="btn sec" onClick={onShuffle}>
            <IconShuffle /> Shuffle
          </button>
        </div>
      </div>
    </div>
  );
}

/** Artwork tile with the play button revealed on hover. */
function Tile({
  src,
  label,
  title,
  subtitle,
  why,
  here,
  round,
  onPlay,
  onAdd,
  adding,
  corner,
  to,
}: {
  src?: string;
  label: string;
  title: string;
  subtitle?: string;
  why?: string;
  here?: boolean;
  round?: boolean;
  onPlay?: () => void;
  onAdd?: () => void;
  /**
   * A small control in the artwork's corner, out of the centre button's way.
   * Used for the preview button, which is a different kind of act from the
   * overlay: the overlay commits (play it, add it), the corner only auditions.
   */
  corner?: React.ReactNode;
  /**
   * The add is in flight. Requesting a song resolves its album through MusicBrainz and
   * can take seconds — a button that looks untouched for that long reads as a click that
   * never registered, and people click it again.
   */
  adding?: boolean;
  to?: View;
}) {
  const art = (
    <div className="tileart">
      <Artwork src={src} kind={round ? 'artist' : 'album'} alt={label} />
      {onPlay && (
        <button
          className="playover"
          title="Play"
          onClick={(e) => {
            // The tile itself may be a link; playing should not also navigate.
            e.preventDefault();
            e.stopPropagation();
            onPlay();
          }}
        >
          <IconPlay />
        </button>
      )}
      {!onPlay && (onAdd || adding) && (
        <button
          className={`playover${adding ? ' working' : ''}`}
          title={adding ? 'Working…' : 'Add to your library'}
          disabled={adding}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onAdd?.();
          }}
        >
          {adding ? <span className="tinyspin" aria-label="working" /> : <IconPlus />}
        </button>
      )}
      {corner && <div className="tilecorner">{corner}</div>}
    </div>
  );

  const body = (
    <>
      {art}
      <div className="tilemeta">
        <div className="t">{title}</div>
        {subtitle && <div className="s">{subtitle}</div>}
        {why && <div className={`why${here ? ' here' : ''}`}>{why}</div>}
      </div>
    </>
  );

  const cls = `tile${round ? ' round' : ''}`;
  return to ? (
    <Link to={to} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/**
 * An album, linking to its page.
 *
 * `to` is only set for albums crate actually holds some of — an album page for something with
 * no tracks on disk would be an empty list, so those stay as plain tiles.
 */
function AlbumTile({
  artist,
  album,
  subtitle,
  why,
  here,
  onPlay,
  mine = 0,
  say,
  onChanged,
}: {
  artist: string;
  album: string;
  subtitle?: string;
  why?: string;
  here?: boolean;
  onPlay?: () => void;
  mine?: number;
  say?: (k: 'good' | 'bad', t: string) => void;
  onChanged?: () => void;
}) {
  /*
   * Every album tile opens the album page, whether or not crate holds the record. It used to
   * detour to the ARTIST page when nothing was on disk — click an album, land somewhere else —
   * because the album page could not render an absent album. It can now (it resolves the
   * release group itself and shows the tracklist, previews and Request), so the one consistent
   * gesture wins: tap an album, see that album.
   */
  const tile = (
    <Tile
      src={albumArtUrl(artist, album)}
      label={album || artist}
      title={album || artist}
      subtitle={subtitle}
      why={why}
      here={here}
      onPlay={onPlay}
      to={{ name: 'albumpage', artist, album }}
    />
  );
  // The menu needs a callback to report through, so a tile without one stays plain rather
  // than swallowing errors silently.
  if (!say) return tile;

  // No album page to open (nothing of it is on disk), so a tap goes to the
  // artist, whose page lists this album with its Request button. A tile that
  // answers a tap with nothing reads as broken — that lesson is paid for.
  return (
    <div className="menuhost">
      {tile}
      <AlbumMenu artist={artist} album={album} mine={mine} say={say} onChanged={onChanged} />
    </div>
  );
}

function SongTile({
  title,
  artist,
  album,
  why,
  here,
  onPlay,
  onAdd,
  say,
  downloadable,
  instantAddId,
  libraryTrackId,
}: {
  title: string;
  artist: string;
  album: string;
  why?: string;
  here?: boolean;
  onPlay?: () => void;
  onAdd?: () => void;
  /** Needed for the add and download actions to have somewhere to report. */
  say?: (k: 'good' | 'bad', t: string) => void;
  /**
   * The song is not in the library and has to be fetched. The tile then acts:
   * the overlay button and a tap both start the download, and the … menu
   * offers the playlist and artist routes. This exists because a shelf
   * literally called "Worth downloading" used to render tiles that did
   * nothing at all when clicked.
   */
  downloadable?: boolean;
  /**
   * The song is not in the library but the pool already holds it, so adding
   * is instant. The tile behaves identically to the downloadable one — Add is
   * Add — it just finishes now instead of after a download. The pool is the
   * server's business, which is why neither the label nor the actions mention
   * it.
   */
  instantAddId?: number | null;
  /**
   * The song IS in the library — this is its track id. Gives the tile the
   * same … menu every other song surface has (playlist, info), instead of
   * being the one kind of song tile with no menu at all.
   */
  libraryTrackId?: number | null;
}) {
  const [picking, setPicking] = useState(false);
  const [asked, setAsked] = useState(false);
  const [added, setAdded] = useState(false);
  const [preview, setPreview] = useState(false);
  /** Set the instant the button is pressed, so the tile acknowledges the click before
   * the network does. Cleared on success (the outcome flags take over) or on failure. */
  const [working, setWorking] = useState(false);

  const instant =
    say && instantAddId
      ? (playlistId?: number) => {
          setWorking(true);
          void (async () => {
            await api.addTrack(instantAddId);
            if (playlistId) await api.addToPlaylist(playlistId, [instantAddId]);
            setAdded(true);
            say(
              'good',
              playlistId ? `Added ${title} to the playlist` : `Added ${title} to your library`,
            );
          })()
            .catch((e: Error) => say('bad', e.message))
            .finally(() => setWorking(false));
        }
      : undefined;

  const download = say
    ? (playlistId?: number) => {
        setWorking(true);
        void api
          .requestTrackByName(artist, title, playlistId)
          .then(() => {
            setAsked(true);
            say(
              'good',
              playlistId
                ? `Getting ${title}. It joins the playlist when it lands.`
                : `Getting ${title}. The album downloads in the background; only this song is added.`,
            );
          })
          .catch((e: Error) => say('bad', e.message))
          .finally(() => setWorking(false));
      }
    : undefined;

  const acquire = instant ?? download;
  const [info, setInfo] = useState(false);

  // In the library already: the overlay plays, the menu does the rest.
  if (libraryTrackId && say && !downloadable && !instantAddId) {
    return (
      <div className="menuhost">
        <div
          style={{ cursor: album ? 'pointer' : undefined }}
          onClick={() => album && navigate({ name: 'albumpage', artist, album })}
        >
          <Tile
            src={album ? albumArtUrl(artist, album) : `/api/art/artist?name=${encodeURIComponent(artist)}`}
            label={title}
            title={title}
            subtitle={artist}
            why={why}
            here={here}
            onPlay={onPlay}
          />
        </div>
        <WithMenu
          items={[
            { label: 'Add to playlist', onSelect: () => setPicking(true) },
            { label: 'Info', onSelect: () => setInfo(true) },
          ]}
        >
          <span />
        </WithMenu>
        {picking && (
          <PlaylistPicker
            title={`“${title}”`}
            say={say}
            onClose={() => setPicking(false)}
            onPick={async (id) => {
              await api.addToPlaylist(id, [libraryTrackId]);
              say('good', `Added ${title}`);
            }}
          />
        )}
        {info && <TrackInfoModal trackId={libraryTrackId} onClose={() => setInfo(false)} />}
      </div>
    );
  }

  const tile = (
    <Tile
      src={album ? albumArtUrl(artist, album) : `/api/art/artist?name=${encodeURIComponent(artist)}`}
      label={title}
      title={title}
      subtitle={artist}
      why={
        added ? 'in your library' : asked ? 'requested' : working ? 'adding…' : why
      }
      here={here || asked || added}
      onPlay={onPlay}
      onAdd={
        onAdd ??
        ((downloadable || instantAddId) && acquire && !asked && !added && !working
          ? () => acquire()
          : undefined)
      }
      adding={working}
      /* Hear it before deciding.

         These tiles are the one song surface with nothing to play: the song is
         not in the library, so the overlay adds instead of playing, and the
         only way to judge a recommendation was to spend a download on it. The
         preview machinery already existed for absent albums' tracklists — this
         is the same button, on the shelf where the question is actually asked.
         Apple is only called on the first press, so a shelf of twenty costs
         nothing until one is used. */
      corner={
        downloadable || instantAddId ? (
          <PreviewButton artist={artist} title={title} k={`tile:${artist}:${title}`} />
        ) : undefined
      }
    />
  );

  if ((!downloadable && !instantAddId) || !say || !acquire) return tile;

  const items: MenuItem[] = [
    ...(downloadable ? [{ label: 'What is this?', onSelect: () => setPreview(true) }] : []),
    {
      label: 'Add to library',
      ...(downloadable ? { hint: 'downloads' } : {}),
      disabled: asked || added,
      onSelect: () => acquire(),
    },
    {
      label: 'Add to playlist',
      ...(downloadable ? { hint: 'downloads' } : {}),
      onSelect: () => setPicking(true),
    },
    {
      label: 'Go to artist',
      onSelect: () => {
        void api
          .search(artist)
          .then((r) => {
            const exact =
              r.artists.find((a) => a.name.toLowerCase() === artist.toLowerCase()) ?? r.artists[0];
            if (exact) {
              rememberArtist(exact.mbid, exact.name);
              navigate({ name: 'artist', mbid: exact.mbid });
            }
            else say('bad', `No metadata for ${artist}`);
          })
          .catch((e: Error) => say('bad', e.message));
      },
    },
  ];

  return (
    <div className="menuhost">
      {/* Tapping the tile face always shows, never acquires: a downloadable
          tile opens the album preview, a pooled one opens the album page. The
          explicit + button (and the menu) is what adds — a tap that silently
          modified the library was reported as exactly the surprise it is. */}
      <div
        style={{ cursor: 'pointer' }}
        onClick={() =>
          downloadable
            ? setPreview(true)
            : album
              ? navigate({ name: 'albumpage', artist, album })
              : acquire()
        }
      >
        {tile}
      </div>
      <WithMenu items={items}>
        <span />
      </WithMenu>
      {picking && (
        <PlaylistPicker
          title={`“${title}”`}
          say={say}
          onClose={() => setPicking(false)}
          onPick={(id) => acquire(id)}
        />
      )}
      {preview && (
        <SongPreviewModal
          artist={artist}
          title={title}
          say={say}
          onClose={() => setPreview(false)}
          onGot={() => setAsked(true)}
        />
      )}
    </div>
  );
}

/**
 * What clicking a downloadable song actually opens: the album behind it.
 *
 * A recommendation is a title and an artist; the thing that downloads is an
 * album. This modal closes that gap — it resolves the containing album, shows
 * its cover and complete track list with the recommended song marked, and only
 * then offers the actions. Nobody should have to request a song to find out
 * what it drags in with it.
 */
function SongPreviewModal({
  artist,
  title,
  say,
  onClose,
  onGot,
}: {
  artist: string;
  title: string;
  say: (k: 'good' | 'bad', t: string) => void;
  onClose: () => void;
  /** Lets the opening tile mark itself requested. */
  onGot?: () => void;
}) {
  const [album, setAlbum] = useState<{ albumMbid: string; albumTitle: string } | null>(null);
  const [missing, setMissing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.resolveTrack(artist, title).then(setAlbum).catch(() => setMissing(true));
  }, [artist, title]);

  const getSong = async (playlistId?: number) => {
    if (!album) return;
    setBusy(true);
    try {
      await api.requestTrack(album.albumMbid, title, `${artist} — ${title}`, playlistId);
      say(
        'good',
        playlistId
          ? `Getting ${title}. It joins the playlist when it lands.`
          : `Getting ${title}. The album downloads in the background; only this song is added.`,
      );
      onGot?.();
      onClose();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const getAlbum = async () => {
    if (!album) return;
    setBusy(true);
    try {
      const r = await api.request({
        kind: 'album',
        mbid: album.albumMbid,
        askedFor: `${artist} — ${album.albumTitle}`,
      });
      say(
        'good',
        r.instant
          ? `${album.albumTitle} is in your library.`
          : `Requested ${album.albumTitle}. Searching indexers now.`,
      );
      onGot?.();
      onClose();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${title} — ${artist}`} onClose={onClose}>
      {missing && (
        <div className="note bad">
          MusicBrainz has no album containing this song, so it cannot be downloaded from here.
        </div>
      )}
      {!missing && !album && <div className="spinner">Finding the album…</div>}
      {album && (
        <>
          <div className="previewhead">
            <Artwork src={albumArtUrl(artist, album.albumTitle)} kind="album" alt={album.albumTitle} />
            <div>
              <div className="t">{album.albumTitle}</div>
              <div className="muted">
                Downloads arrive as whole albums — this is what comes with the song. Only the
                song joins your library; the rest stays in the pool.
              </div>
            </div>
          </div>
          <TrackList mbid={album.albumMbid} highlight={title} />
          <div className="acts" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <button className="btn" disabled={busy} onClick={() => void getSong()}>
              Get this song
            </button>
            <button className="btn sec" disabled={busy} onClick={() => setPicking(true)}>
              Add to playlist
            </button>
            <button className="btn sec" disabled={busy} onClick={() => void getAlbum()}>
              Get the whole album
            </button>
          </div>
        </>
      )}
      {picking && (
        <PlaylistPicker
          title={`“${title}”`}
          say={say}
          onClose={() => setPicking(false)}
          onPick={(id) => void getSong(id)}
        />
      )}
    </Modal>
  );
}

/**
 * One tag chart — a genre, a decade or a year — as a shelf of song tiles.
 *
 * From the listener's side there are exactly two states: in your library
 * (plays) or not (Add). Whether an add is instant or a download is the
 * server's business and is deliberately not surfaced — a play button on a
 * song that could not stream is how this used to be wrong.
 */
/** The artist twin of ChartShelf: who the world plays for a tag. Tiles open the artist
 * page by name (the page resolves the mbid on arrival), so held and unheld alike work. */
function ArtistChartShelf({ tag }: { tag: string }) {
  const [artists, setArtists] = useState<
    { name: string; listeners: number; images: Images; held: boolean }[] | null
  >(null);
  const paged = usePaged(artists ?? [], tag);

  useEffect(() => {
    let dead = false;
    setArtists(null);
    api
      .topArtists(tag)
      .then((r) => !dead && setArtists(r.artists))
      .catch(() => !dead && setArtists([]));
    return () => {
      dead = true;
    };
  }, [tag]);

  if (artists === null) return <div className="spinner">Loading the chart…</div>;
  if (!artists.length) return <div className="muted">Last.fm has no chart for “{tag}”.</div>;

  return (
    <Shelf open={paged.expanded}>
      {paged.shown.map((a) => (
        <Link
          key={a.name}
          to={{ name: 'artistByName', artist: a.name }}
          className="card"
        >
          <Art images={a.images} label={a.name} shape="circle" />
          <div className="meta">
            <div className="t">{a.name}</div>
            <div className="s">
              {a.held ? <span className="tag held">in library</span> : `top ${tag}`}
            </div>
          </div>
        </Link>
      ))}
      <ShowMore more={paged.more} onClick={paged.showMore} />
    </Shelf>
  );
}

function ChartShelf({ tag, say }: { tag: string; say: (k: 'good' | 'bad', t: string) => void }) {
  // No usePlayer() here any more: it existed only to play an owned track, and owned tracks no
  // longer reach this shelf. Dropping it also drops a player-context subscription, so switching
  // songs stops re-rendering a shelf that cannot change because of it.
  const [tracks, setTracks] = useState<ChartTrack[] | null>(null);
  // Keyed on the tag, so switching from rock to jazz shows twenty jazz tracks
  // rather than however many rock ones happened to be revealed.
  const paged = usePaged(tracks ?? [], tag);

  useEffect(() => {
    let dead = false;
    setTracks(null);
    api
      .topTracks(tag)
      .then((r) => !dead && setTracks(r.tracks))
      .catch(() => !dead && setTracks([]));
    return () => {
      dead = true;
    };
  }, [tag]);

  if (tracks === null) return <div className="spinner">Loading the chart…</div>;
  if (!tracks.length) return <div className="muted">Last.fm has no chart for “{tag}”.</div>;

  return (
    <>
    <Shelf open={paged.expanded}>
      {/*
        * No owned-track branch here: /api/toptracks drops what the caller already has, so a
        * tile is always either an instant add (in the pool, not in this library) or something
        * to download. The endpoint used to flag them instead and this rendered a play button
        * and an "in your library" caption — a slot spent on a record you already own, on a
        * shelf whose whole purpose is the ones you do not.
        */}
      {paged.shown.map((t, i) => (
        <SongTile
          key={`${t.artistName}-${t.title}-${i}`}
          title={t.title}
          artist={t.artistName}
          album={t.albumTitle}
          say={say}
          instantAddId={t.onDisk ? t.trackId : null}
          downloadable={!t.onDisk}
        />
      ))}
      <ShowMore more={paged.more} onClick={paged.showMore} />
    </Shelf>
    </>
  );
}

/**
 * An artist, round, resolving to their page on click.
 *
 * Last.fm gives a name and no id, so opening one means a search lookup — done on click rather
 * than for every tile up front, which keeps a shelf of fourteen at zero extra requests until
 * one is wanted.
 */
function ArtistTile({
  name,
  why,
  say,
  onPlay,
  inLibrary = false,
  onChanged,
}: {
  name: string;
  why: string;
  say: (k: 'good' | 'bad', t: string) => void;
  /** Present for artists in the library, where there is something to play. */
  onPlay?: () => void;
  /** Holdings decide the menu — see ArtistMenu. */
  inLibrary?: boolean;
  /** Called after the menu changes the library, so the surrounding list can refresh. */
  onChanged?: () => void;
}) {
  /*
   * Navigate first and resolve on the other side.
   *
   * This used to await a search and only then navigate, so the tile dimmed and
   * nothing happened for as long as the lookup took — four or five seconds
   * against a cold artist. The lookup is the same either way; what changed is
   * that it now happens under a page that has already opened.
   */
  const open = () => {
    navigate({ name: 'artistByName', artist: name });
  };

  return (
    // No busy state left to dim for: the click navigates synchronously and the
    // waiting now happens on the artist page, where it looks like loading
    // rather than like a tile that has stopped responding.
    <div className="menuhost">
      <div onClick={open}>
        <Tile
          round
          src={`/api/art/artist?name=${encodeURIComponent(name)}`}
          label={name}
          title={name}
          why={why}
          onPlay={onPlay}
        />
      </div>
      <ArtistMenu name={name} say={say} inLibrary={inLibrary} onChanged={onChanged} />
    </div>
  );
}

/** A numbered row in the most-played list. Carries the same … menu as every
 *  other song surface — it was the only one without, for no reason. */
function TopRow({
  rank,
  track,
  plays,
  onPlay,
  say,
}: {
  rank: number;
  track: MyTrack;
  plays?: number;
  onPlay: () => void;
  say: (k: 'good' | 'bad', t: string) => void;
}) {
  const p = usePlayer();
  const [picking, setPicking] = useState(false);
  const [info, setInfo] = useState(false);
  const current = p.current?.trackId === track.trackId;
  const url = albumArtUrl(track.artistName, track.albumTitle);

  const items: MenuItem[] = [
    { label: 'Add to playlist', onSelect: () => setPicking(true) },
    { label: 'Info', onSelect: () => setInfo(true) },
  ];

  return (
    <WithMenu items={items} className="songrowwrap">
    <div className={`toprow${current ? ' playing' : ''}`} onClick={onPlay}>
      <div className="rank">{rank}</div>
      <div className="thumb">
        <Artwork src={url} kind="album" alt={track.albumTitle} />
      </div>
      <div className="words">
        <div className="t">{track.title}</div>
        {/* The artist and album are the navigable part; the row itself plays. */}
        <div className="s">
          <Link
            to={{ name: 'albumpage', artist: track.artistName, album: track.albumTitle }}
            className="rowlink"
            onNavigate={() => undefined}
          >
            {track.artistName}
          </Link>
        </div>
      </div>
      {plays !== undefined && (
        <div className="count">
          {plays} play{plays === 1 ? '' : 's'}
        </div>
      )}
    </div>
    {picking && (
      <PlaylistPicker
        title={`“${track.title}”`}
        say={say}
        onClose={() => setPicking(false)}
        onPick={async (id) => {
          await api.addToPlaylist(id, [track.trackId]);
          say('good', `Added ${track.title}`);
        }}
      />
    )}
    {info && <TrackInfoModal trackId={track.trackId} onClose={() => setInfo(false)} />}
    </WithMenu>
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * The wide-search latch, shared by the header box and SearchView.
 *
 * Search runs in two phases: the LOCAL half answers every keystroke from SQLite, and the
 * WIDE half (MusicBrainz + Last.fm) fires only once the query has sat still — or the moment
 * Enter says "search now". Enter may not change the query at all, so a bare state prop can't
 * carry it; a sequence number makes the view react, and the consumable flag says the rerun
 * should skip the settle delay.
 */
let wideSeq = 0;
let wideNow = false;
const wideListeners = new Set<() => void>();
function requestWideSearch(): void {
  wideNow = true;
  wideSeq++;
  for (const fn of wideListeners) fn();
}
function subscribeWide(fn: () => void): () => void {
  wideListeners.add(fn);
  return () => void wideListeners.delete(fn);
}
function consumeWideNow(): boolean {
  const v = wideNow;
  wideNow = false;
  return v;
}

/** Typing pauses this long before the wide search fires; with the header's own 250ms
 * navigation debounce in front it lands at Matt's asked-for second of stillness. */
const WIDE_SETTLE_MS = 750;

function SearchView({
  q,
  say,
}: {
  q: string;
  say: (k: 'good' | 'bad', t: string) => void;
}) {
  const [local, setLocal] = useState<LocalSearch | null>(null);
  const [res, setRes] = useState<SearchResult | null>(null);
  const [wideTracks, setWideTracks] = useState<TrackHit[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const wide = useSyncExternalStore(subscribeWide, () => wideSeq);
  // Answers arriving out of order must not clobber newer ones — the guard is one shared
  // sequence: every fetch remembers the sequence it was born under and checks it on landing.
  const seq = useRef(0);

  // Phase one, every keystroke: what crate already knows. Previous results stay up while the
  // next answer is in flight (single-digit ms) so the page never blinks between letters.
  useEffect(() => {
    const my = ++seq.current;
    api
      .searchLocal(q)
      .then((r) => {
        if (seq.current === my) setLocal(r);
      })
      .catch(() => {
        if (seq.current === my) setLocal({ tracks: [], artists: [], albums: [] });
      });
  }, [q]);

  // Phase two, once the query sits still or Enter fires the latch: the world beyond the
  // library. Cleared on every new q so stale wide results never sit under a fresh query.
  useEffect(() => {
    setRes(null);
    setWideTracks(null);
    setErr(null);
    const my = seq.current;
    const delay = consumeWideNow() ? 0 : WIDE_SETTLE_MS;
    const t = window.setTimeout(() => {
      api
        .search(q)
        .then((r) => {
          if (seq.current === my) setRes(r);
        })
        .catch((e: Error) => {
          if (seq.current === my) setErr(e.message);
        });
      api
        .searchTracks(q)
        .then((r) => {
          if (seq.current === my) setWideTracks(r.tracks);
        })
        .catch(() => {
          if (seq.current === my) setWideTracks([]);
        });
    }, delay);
    return () => window.clearTimeout(t);
  }, [q, wide]);

  const reload = useCallback(() => {
    api.searchLocal(q).then(setLocal).catch(() => undefined);
    if (wideTracks) api.searchTracks(q).then((r) => setWideTracks(r.tracks)).catch(() => undefined);
  }, [q, wideTracks]);

  if (!local) return <div className="spinner">Searching…</div>;

  // The wide list opens with the same local rows in the same order, so swapping it in adds
  // the downloadable tail without moving anything already on screen.
  const tracks = wideTracks ?? local.tracks;
  const searching = !res && !err;
  // Local artists/albums the wide results also found are dropped from the wide sections —
  // one card per thing, and the card already on screen is the one that stays.
  const localArtistNames = new Set(local.artists.map((a) => a.name.toLowerCase()));
  const localAlbumKeys = new Set(
    local.albums.map((al) => `${al.artistName.toLowerCase()}|${al.title.toLowerCase()}`),
  );
  const wideArtists = (res?.artists ?? []).filter((a) => !localArtistNames.has(a.name.toLowerCase()));
  const wideAlbums = (res?.albums ?? []).filter(
    (al) => !localAlbumKeys.has(`${al.artistName.toLowerCase()}|${al.title.toLowerCase()}`),
  );

  const nothingLocal = !tracks.length && !local.artists.length && !local.albums.length;
  if (nothingLocal && searching) return <div className="spinner">Searching…</div>;
  if (nothingLocal && !wideArtists.length && !wideAlbums.length) {
    return err ? <div className="note bad">{err}</div> : <div className="empty">Nothing found for “{q}”.</div>;
  }

  return (
    <>
      <SongResults q={q} say={say} tracks={tracks} onChanged={reload} />

      {local.artists.length > 0 && (
        <>
          <div className="rowhead">
            <h2>Artists</h2>
            <span className="reason">in your library</span>
          </div>
          <div className="grid">
            {local.artists.map((a) => (
              <LocalArtistCard key={a.name} name={a.name} images={a.images} say={say} />
            ))}
          </div>
        </>
      )}

      {local.albums.length > 0 && (
        <>
          <div className="rowhead">
            <h2>Albums</h2>
            <span className="reason">in your library</span>
          </div>
          <div className="grid">
            {local.albums.map((al) => (
              <div
                key={`${al.artistName}|${al.title}`}
                className="card clickable"
                onClick={() =>
                  navigate({
                    name: 'albumpage',
                    artist: al.artistName,
                    album: al.title,
                    ...(al.mbid ? { mbid: al.mbid } : {}),
                  })
                }
              >
                <Art images={al.images} label={al.title} />
                <div className="meta">
                  <div className="t">{al.title}</div>
                  <div className="s">{al.artistName}</div>
                  <div style={{ marginTop: 8 }}>
                    <span className="tag held">in library</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {searching && <div className="spinner">Searching everywhere…</div>}
      {err && <div className="note bad">{err}</div>}

      {wideArtists.length > 0 && (
        <>
          <div className="rowhead">
            <h2>Artists</h2>
            <span className="reason">from everywhere</span>
          </div>
          <div className="grid">
            {wideArtists.map((a) => (
              <Link
                key={a.mbid}
                to={{ name: 'artist', mbid: a.mbid }}
                className="card"
                onNavigate={() => rememberArtist(a.mbid, a.name)}
              >
                <Art images={a.images} label={a.name} shape="circle" />
                <div className="meta">
                  <div className="t">{a.name}</div>
                  <div className="s">
                    {a.held ? <span className="tag held">in library</span> : a.genres[0] ?? 'artist'}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}

      {wideAlbums.length > 0 && (
        <>
          <div className="rowhead">
            <h2>Albums</h2>
            <span className="reason">requesting a song? request its album</span>
          </div>
          <div className="grid">
            {wideAlbums.map((al) => (
              <AlbumCard key={al.mbid} album={al} say={say} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

/**
 * A library artist in the instant results. Local rows carry no MusicBrainz id and the artist
 * page is addressed by one, so the click resolves name → mbid on its way through — a single
 * cheap lookup paid only when somebody actually goes.
 */
function LocalArtistCard({
  name,
  images,
  say,
}: {
  name: string;
  images: Images;
  say: (k: 'good' | 'bad', t: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div
      className="card clickable"
      onClick={() => {
        if (busy) return;
        setBusy(true);
        api
          .resolveArtist(name)
          .then((r) => {
            if (!r.artist) {
              say('bad', `Couldn't place ${name} on MusicBrainz`);
              return;
            }
            rememberArtist(r.artist.mbid, name);
            navigate({ name: 'artist', mbid: r.artist.mbid });
          })
          .catch((e: Error) => say('bad', e.message))
          .finally(() => setBusy(false));
      }}
    >
      <Art images={images} label={name} shape="circle" />
      <div className="meta">
        <div className="t">{name}</div>
        <div className="s">
          <span className="tag held">in library</span>
        </div>
      </div>
    </div>
  );
}

function AlbumCard({
  album,
  say,
}: {
  album: SearchAlbum;
  say: (k: 'good' | 'bad', t: string) => void;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>(album.requested ? 'done' : 'idle');

  const request = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setState('busy');
    try {
      const r = await api.request({
        kind: 'album',
        mbid: album.mbid,
        askedFor: `${album.artistName} — ${album.title}`,
      });
      setState('done');
      say(
        'good',
        r.instant
          ? `${album.title} is in your library.`
          : `Requested ${album.title}. Searching indexers now.`,
      );
    } catch (err) {
      setState('idle');
      say('bad', (err as Error).message);
    }
  };

  return (
    // The whole card opens the album page — held or not, since the page can
    // now render either. It was a dead card with a Request button, which made
    // search a place you could buy an album but not look at it first.
    <div
      className="card clickable"
      onClick={() =>
        navigate({ name: 'albumpage', artist: album.artistName, album: album.title, mbid: album.mbid })
      }
    >
      <Art images={album.images} label={album.title} />
      <div className="meta">
        <div className="t">{album.title}</div>
        <div className="s">
          {album.artistName}
          {album.releaseDate ? ` · ${album.releaseDate.slice(0, 4)}` : ''}
        </div>
        <div style={{ marginTop: 8 }}>
          {album.held ? (
            <span className="tag held">in library</span>
          ) : state === 'done' ? (
            <span className="tag req">requested</span>
          ) : (
            <button className="btn sm" disabled={state === 'busy'} onClick={(e) => void request(e)}>
              {state === 'busy' ? 'Requesting…' : 'Request'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Artist detail
// ---------------------------------------------------------------------------

/**
 * Names for artist mbids crate has already seen.
 *
 * Every route to an artist page starts somewhere that already knows their name
 * — a search result, a tile, a track row — and then throws it away, leaving the
 * page with nothing to show but a spinner while it asks the server for a name
 * it was just handed. Remembering it means the heading is right immediately and
 * the wait happens under a page that already looks like the artist's.
 *
 * A plain module Map: it only needs to survive the click that follows, and a
 * miss costs nothing but the skeleton it would have shown anyway.
 */
const artistNames = new Map<string, string>();
export function rememberArtist(mbid: string, name: string): void {
  if (mbid && name) artistNames.set(mbid, name);
}

/** The page's frame while the real thing loads: right shape, no content. */
function ArtistSkeleton({ name }: { name: string }) {
  return (
    <>
      <div className="hero">
        <div className="inner">
          <div className="sk sk-poster" />
          <div style={{ minWidth: 0 }}>
            {/* A known name is shown for real. An unknown one gets a bar rather
                than a guess — a wrong heading is worse than no heading. */}
            {name ? <h1>{name}</h1> : <div className="sk sk-h1" />}
            <div className="sk sk-line" style={{ width: 160, marginTop: 10 }} />
          </div>
        </div>
      </div>
      <div className="rowhead">
        <h2>Albums</h2>
      </div>
      <table className="list albums">
        <tbody>
          {Array.from({ length: 6 }, (_, i) => (
            <tr key={i}>
              <td>
                <div className="albumrow">
                  <div className="sk sk-thumb" />
                  <div className="tinfo">
                    <div className="sk sk-line" style={{ width: `${58 - i * 5}%` }} />
                  </div>
                </div>
              </td>
              <td className="muted"><div className="sk sk-line" style={{ width: 54 }} /></td>
              <td className="muted"><div className="sk sk-line" style={{ width: 66 }} /></td>
              <td />
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/**
 * The artist page for a name whose id is not known yet.
 *
 * Renders the skeleton with the real name immediately, resolves the id, then
 * REPLACES itself with the id URL rather than pushing one — so Back returns to
 * the page you came from instead of to this intermediate address, which would
 * only resolve again and bounce you forward.
 */
function ArtistByName({ artist, say }: { artist: string; say: (k: 'good' | 'bad', t: string) => void }) {
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    api
      .resolveArtist(artist)
      .then((r) => {
        if (dead) return;
        if (!r.artist) {
          setErr(`No metadata for ${artist}`);
          return;
        }
        rememberArtist(r.artist.mbid, r.artist.name);
        navigate({ name: 'artist', mbid: r.artist.mbid }, { replace: true });
      })
      .catch((e: Error) => !dead && setErr(e.message));
    return () => {
      dead = true;
    };
  }, [artist]);

  if (err) {
    return (
      <div className="note bad">
        {err}
        <div style={{ marginTop: 10 }}>
          <button className="btn sec sm" onClick={() => window.history.back()}>
            Back
          </button>
        </div>
      </div>
    );
  }
  return <ArtistSkeleton name={artist} />;
}

function ArtistView({
  mbid,
  openAlbum,
  me,
  say,
}: {
  mbid: string;
  /** Album expanded by the URL, so a track listing can be linked to directly. */
  openAlbum: string | undefined;
  me: Me | null;
  say: (k: 'good' | 'bad', t: string) => void;
}) {
  const p = usePlayer();
  const [d, setD] = useState<ArtistDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Songs and Albums as tabs. null until the data lands, then the page decides where to
   * open: a deep link to an album listing means Albums, an artist whose songs are already
   * on the shelves means Songs (you came to play), anyone else means Albums (you came to
   * browse a discography). Switching is state, not URL — Back should leave the page.
   */
  const [tab, setTab] = useState<'songs' | 'albums' | null>(null);

  const load = useCallback(() => {
    api
      .artist(mbid)
      .then((r) => {
        rememberArtist(mbid, r.artist.name);
        setD(r);
      })
      .catch((e: Error) => setErr(e.message));
  }, [mbid]);

  useEffect(() => {
    setD(null);
    setErr(null);
    load();
  }, [load]);

  /**
   * One artist action: fetch the discography, under the caps.
   *
   * There used to be a second, "Follow", which monitored future releases through
   * Lidarr and downloaded nothing. It went with Lidarr.
   */
  const addArtist = async () => {
    setBusy(true);
    // The button only renders once `d` has loaded, so the name is always there;
    // the fallback keeps the request auditable if that ever stops being true.
    const name = d?.artist.name || mbid;
    try {
      const r = await api.request({ kind: 'artist', mbid, askedFor: name });
      say(
        'good',
        r.queuedAlbums === 0
          ? `Everything is in your library now${r.added ? ` (${r.added} tracks added)` : ''}.`
          : `Requested ${r.queuedAlbums} album${r.queuedAlbums === 1 ? '' : 's'}` +
              `${r.added ? `, ${r.added} tracks added instantly` : ''}. Searching now.`,
      );
      load();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (err) return <div className="note bad">{err}</div>;
  // The frame, not a spinner. Navigation should feel like arriving somewhere
  // and waiting for it to fill in, not like nothing happened for two seconds.
  if (!d) return <ArtistSkeleton name={artistNames.get(mbid) ?? ''} />;

  const cap = me?.maxAlbumsPerRequest ?? 5;
  const songs = d.songs ?? [];
  const shown = tab ?? (openAlbum || !songs.length ? 'albums' : 'songs');

  return (
    <>
      <div className="hero">
        {d.artist.images.fanart && (
          <Artwork className="bg" src={d.artist.images.fanart} kind="artist" />
        )}
        <div className="inner">
          {/* Always rendered, so a missing portrait leaves the layout alone
              instead of shifting the heading left when it fails. */}
          <span className="heroart">
            <Artwork src={d.artist.images.poster} kind="artist" alt={d.artist.name} />
          </span>
          <div>
            <h1>{d.artist.name}</h1>
            <div className="sub">
              {d.albumCount} {d.albumCount === 1 ? 'album' : 'albums'}
              {d.heldCount > 0 && (
                <>
                  {' · '}
                  <span className="tag held">{d.heldCount} in library</span>
                </>
              )}
              {(d.artist.trackCount ?? 0) > 0 && ` · ${d.artist.trackCount} tracks yours`}
            </div>
            {(d.artist.genres?.length ?? 0) > 0 && (
              <div className="sub muted">{d.artist.genres?.slice(0, 4).join(' · ')}</div>
            )}
          </div>
          <div className="acts">
            {/* Browser history, not a hardcoded destination — so this button and
                the browser's own Back button do the same thing. */}
            <button className="btn sec sm" onClick={() => window.history.back()}>
              Back
            </button>
            <button
              className="btn"
              disabled={busy || d.wouldExceedPerRequest}
              title={
                d.wouldExceedPerRequest
                  ? `${d.albumCount} albums is over the ${cap}-per-request limit — request albums individually below`
                  : undefined
              }
              onClick={() => void addArtist()}
            >
              Get all {d.albumCount}
            </button>
          </div>
        </div>
      </div>

      {d.artist.overview && <ArtistBio text={d.artist.overview} />}

      {d.wouldExceedPerRequest && (
        <div className="note">
          {d.artist.name} has {d.albumCount} albums, over the {cap} allowed in a single
          request. Pick the ones you want below — this limit exists so one click cannot queue tens
          of gigabytes.
        </div>
      )}

      {/* Songs or Albums — one page, two questions: "play what I have" and "what exists". */}
      <div className="seg artisttabs" role="group" aria-label="Songs or albums">
        <button
          className={`segbtn${shown === 'songs' ? ' on' : ''}`}
          aria-pressed={shown === 'songs'}
          onClick={() => setTab('songs')}
        >
          Songs{songs.length ? ` (${songs.length})` : ''}
        </button>
        <button
          className={`segbtn${shown === 'albums' ? ' on' : ''}`}
          aria-pressed={shown === 'albums'}
          onClick={() => setTab('albums')}
        >
          Albums ({d.albumCount})
        </button>
      </div>

      {shown === 'songs' && (
        <>
          {songs.length > 0 ? (
            <>
              <div className="rowhead">
                <h2>Songs</h2>
                <span className="reason">
                  {songs.length} on disk
                  {songs.some((t) => t.mine) &&
                    ` · ${songs.filter((t) => t.mine).length} in your library`}
                </span>
              </div>
              <div className="bar" style={{ marginBottom: 10 }}>
                <button
                  className="btn sm"
                  onClick={() => p.play(songs.map(playable), 0, d.artist.name)}
                >
                  Play all
                </button>
                <button
                  className="btn sec sm"
                  onClick={() => {
                    // Fisher–Yates on a copy: the list on screen keeps its order.
                    const deck = [...songs];
                    for (let i = deck.length - 1; i > 0; i--) {
                      const j = Math.floor(Math.random() * (i + 1));
                      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
                    }
                    p.play(deck.map(playable), 0, `${d.artist.name} shuffled`, { shuffle: 'held' });
                  }}
                >
                  Shuffle
                </button>
              </div>
              <div className="songrows">
                {songs.map((t, i) => (
                  <SongRow
                    key={t.trackId}
                    track={t}
                    queue={songs}
                    index={i}
                    label={d.artist.name}
                    say={say}
                    mine={t.mine}
                    onDisk={t.onDisk}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="empty">
              Nothing by {d.artist.name} on disk yet — the Albums tab is where their records
              can be requested.
            </div>
          )}

          {/* A guest's page has nothing else on it: they own no album, so every album query finds
              nothing for them. This is where a featured credit actually surfaces. */}
          {(d.appearsOn?.length ?? 0) > 0 && (
            <>
              <div className="sechead">
                <h2>Appears on</h2>
                <span className="sub">tracks they play on, from someone else’s record</span>
              </div>
              <div className="songrows">
                {(d.appearsOn ?? []).map((t, i) => (
                  <SongRow
                    key={t.trackId}
                    track={t}
                    queue={d.appearsOn ?? []}
                    index={i}
                    label={`${d.artist.name} — appears on`}
                    say={say}
                    mine={t.mine}
                    onDisk={t.onDisk}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}

      {shown === 'albums' && (
        <>
          {(d.onDiskOnly?.length ?? 0) > 0 && (
            <>
              <div className="sechead">
                <h2>In your library</h2>
                <span className="sub">not in the official discography</span>
              </div>
              <div className="gridart">
                {d.onDiskOnly?.map((a) => (
                  <AlbumTile
                    key={a.albumTitle}
                    artist={d.artist.name}
                    album={a.albumTitle}
                    mine={a.mine}
                    say={say}
                    subtitle={`${a.mine} of ${a.onDisk} track${a.onDisk === 1 ? '' : 's'}`}
                    here={a.mine > 0}
                  />
                ))}
              </div>
            </>
          )}

          <div className="rowhead">
            <h2>Albums</h2>
            <span className="reason">every release, whether you have it or not</span>
          </div>
          <table className="list albums">
            <thead>
              <tr>
                <th>Album</th>
                <th>Type</th>
                <th>Released</th>
                <th style={{ textAlign: 'right' }}>&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {[...d.albums]
                .sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''))
                .map((al) => (
                  <AlbumRow
                    key={al.mbid}
                    album={al}
                    artistMbid={mbid}
                    open={al.mbid === openAlbum}
                    say={say}
                  />
                ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

/**
 * One album, expandable to its track listing.
 *
 * Which album is expanded comes from the URL rather than local state, so a track
 * listing can be linked to and collapsing is just a Back away.
 */
function AlbumRow({
  album,
  artistMbid,
  open,
  say,
}: {
  album: SearchAlbum;
  artistMbid: string;
  open: boolean;
  say: (k: 'good' | 'bad', t: string) => void;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>(album.requested ? 'done' : 'idle');

  const toggle = () =>
    navigate({ name: 'artist', mbid: artistMbid, album: open ? undefined : album.mbid });

  const request = async () => {
    setState('busy');
    try {
      await api.request({
        kind: 'album',
        mbid: album.mbid,
        askedFor: `${album.artistName} — ${album.title}`,
      });
      setState('done');
      say('good', `Requested ${album.title}.`);
    } catch (e) {
      setState('idle');
      say('bad', (e as Error).message);
    }
  };

  return (
    <>
      <tr>
        <td>
          <div className="albumrow">
            <button className="disc" title={open ? 'Hide tracks' : 'Show tracks'} onClick={toggle}>
              {open ? '▾' : '▸'}
            </button>
            <div className="thumb">
              <Artwork src={album.images.cover} kind="album" alt={album.title} />
            </div>
            {/* Held albums open their page — tracklist, play, the lot. Ones not
                on disk have no page worth opening, so the title expands the
                MusicBrainz tracklist instead. */}
            <div className="tinfo">
              {album.held ? (
                <Link
                  to={{ name: 'albumpage', artist: album.artistName, album: album.title }}
                  className="ttl"
                >
                  {album.title}
                </Link>
              ) : (
                <div className="ttl" onClick={toggle}>
                  {album.title}
                </div>
              )}
              {/* Type and year get their own columns on a wide screen. A phone
                  drops those columns, so the same two facts ride under the
                  title rather than being lost. */}
              <div className="sub muted">
                {[album.albumType, album.releaseDate?.slice(0, 4)].filter(Boolean).join(' \u00b7 ')}
              </div>
            </div>
          </div>
        </td>
        <td className="muted">{album.albumType}</td>
        <td className="muted">{album.releaseDate || '—'}</td>
        <td style={{ textAlign: 'right' }}>
          {album.held ? (
            <Link
              to={{ name: 'albumpage', artist: album.artistName, album: album.title }}
              className="btn sec sm"
            >
              Open
            </Link>
          ) : state === 'done' ? (
            <span className="tag req">requested</span>
          ) : (
            <button className="btn sm" disabled={state === 'busy'} onClick={() => void request()}>
              {state === 'busy' ? '…' : 'Request'}
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} style={{ paddingTop: 0 }}>
            {/* A held album's songs are already here, so its tracklist offers
                nothing to fetch — the album page is where you play them. */}
            <TrackList
              mbid={album.mbid}
              artist={album.artistName}
              say={say}
              requestable={!album.held}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/** mm:ss from milliseconds, or a dash when the length is unknown. */
function dur(ms: number | null): string {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Track listing, fetched on expand rather than with the album.
 *
 * An artist page can list a dozen albums; fetching every listing up front would
 * mean a dozen lookups for a page where most rows are never opened. The server
 * caches them, so opening the same album again is instant.
 */
/**
 * Play thirty seconds of a song crate does not have.
 *
 * The point is deciding whether to spend a download on something, so it lives
 * next to the Get button rather than anywhere the library's own player would
 * do. Songs already on disk get no preview: there is a real file to play.
 *
 * Apple is asked only on the first press, never on render — a tracklist that
 * resolved a preview per row would fire twenty calls to show twenty buttons
 * almost none of which get used, and Apple rate limits well below that.
 */
function PreviewButton({
  artist,
  title,
  k,
}: {
  artist: string;
  title: string;
  /** Identifies this row among all previewable rows on the page. */
  k: string;
}) {
  const p = usePlayer();
  const previewing = usePreviewing();
  const [busy, setBusy] = useState(false);
  const [none, setNone] = useState(false);
  const on = previewing === k;

  // Leaving the page mid-clip should not leave audio playing over the next one.
  useEffect(() => () => { if (currentPreviewKey() === k) stopPreview(); }, [k]);

  const click = async (e: React.MouseEvent) => {
    // These rows are clickable — expanding a tracklist, opening an album — and
    // a preview must not also do that.
    e.stopPropagation();
    e.preventDefault();
    if (on) {
      stopPreview();
      return;
    }
    // Nobody wants a preview over the top of the song they are listening to.
    if (p.playing) p.toggle();
    setBusy(true);
    const r = await playPreview(k, artist, title);
    setBusy(false);
    if (r === 'none') setNone(true);
  };

  return (
    <button
      className={`prev${on ? ' on' : ''}`}
      disabled={busy || none}
      title={
        none ? 'Apple has no preview for this song'
        : on ? 'Stop preview'
        : 'Preview 30 seconds'
      }
      aria-label={on ? 'Stop preview' : `Preview ${title}`}
      onClick={(e) => void click(e)}
    >
      {none ? (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 1.4a5.1 5.1 0 0 1 3.1 1.05L4 11.05A5.1 5.1 0 0 1 8 2.9Zm0 10.2a5.1 5.1 0 0 1-3.1-1.05L12 4.95A5.1 5.1 0 0 1 8 13.1Z" fill="currentColor" />
        </svg>
      ) : busy ? (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" className="spin">
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="9 28" strokeLinecap="round" />
        </svg>
      ) : on ? (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <rect x="3.5" y="3.5" width="9" height="9" rx="1.6" fill="currentColor" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path d="M5 3.4v9.2a.6.6 0 0 0 .92.5l7.2-4.6a.6.6 0 0 0 0-1l-7.2-4.6A.6.6 0 0 0 5 3.4Z" fill="currentColor" />
        </svg>
      )}
    </button>
  );
}

function TrackList({
  mbid,
  highlight,
  artist,
  say,
  requestable,
}: {
  mbid: string;
  highlight?: string;
  artist?: string;
  say?: (k: 'good' | 'bad', t: string) => void;
  /** False for an album already on disk, where the album page is the place to go. */
  requestable?: boolean;
}) {
  const [tracks, setTracks] = useState<AlbumTrack[] | null>(null);
  const [source, setSource] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [asked, setAsked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  /**
   * One song, not the record.
   *
   * The album still downloads — Usenet and torrents deal in albums — but only
   * the song asked for joins the library, which is the whole point of a
   * track-first library. Listing a tracklist and giving no way to act on it
   * was the gap.
   */
  const getSong = (title: string) => {
    if (!say || !artist) return;
    setBusy(title);
    void api
      .requestTrack(mbid, title, `${artist} — ${title}`)
      .then(() => {
        setAsked((prev) => new Set(prev).add(title));
        say('good', `Getting ${title}. Only this song joins your library.`);
      })
      .catch((e: Error) => say('bad', e.message))
      .finally(() => setBusy(null));
  };

  useEffect(() => {
    api
      .tracks(mbid)
      .then((r) => {
        setTracks(r.tracks);
        setSource(r.source);
      })
      .catch((e: Error) => setErr(e.message));
  }, [mbid]);

  if (err) return <div className="tracks muted">{err}</div>;
  if (!tracks) return <div className="tracks muted">Loading tracks…</div>;
  if (!tracks.length) return <div className="tracks muted">No track listing available.</div>;

  const hl = highlight?.toLowerCase();
  return (
    <div className="tracks">
      <ol>
        {tracks.map((t) => (
          <li
            key={`${t.position}-${t.title}`}
            className={hl && t.title.toLowerCase() === hl ? 'hl' : undefined}
          >
            <span className="n">{t.position}</span>
            <span className="ti">{t.title}</span>
            {t.hasFile === false && <span className="tag">missing</span>}
            <span className="d">{dur(t.lengthMs)}</span>
            {requestable && artist && (
              <PreviewButton artist={artist} title={t.title} k={`${mbid}:${t.position}`} />
            )}
            {requestable && say && artist && (
              <button
                className="btn sec sm"
                disabled={busy === t.title || asked.has(t.title)}
                title="Download this song (the album is fetched, only this song is added)"
                onClick={() => getSong(t.title)}
              >
                {asked.has(t.title) ? 'requested' : busy === t.title ? '…' : 'Get'}
              </button>
            )}
          </li>
        ))}
      </ol>
      <div className="src muted">
        {tracks.length} tracks · from MusicBrainz
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * Account management.
 *
 * Everyone can change their own password; only an admin sees the list and the
 * add form. There is deliberately no delete: requests are attributed by username
 * and the history is what the daily cap is audited against, so removing a user
 * would orphan their record. Disabling ends their sessions and blocks sign-in,
 * which is what "remove" actually needs to mean here.
 */
/**
 * The avatar and its menu — the account's front door.
 *
 * Everything that used to be scattered across the top bar (Requests, Account,
 * Admin, Sign out) lives here now, so the tabs can be purely about music.
 */
/**
 * Auto, dark or light.
 *
 * A segmented control rather than three menu rows, because these are one
 * setting with three values — three rows would read as three actions, and give
 * no indication of which is currently in force.
 *
 * The choice is local to the device on purpose. Which theme suits depends on
 * the screen and the room it is in, so the same account on a phone at night
 * and a desktop in daylight wants different answers; storing it server-side
 * would force one on both.
 */
function ThemePicker() {
  const [theme, setLocal] = useState<Theme>(readTheme);

  const pick = (t: Theme) => {
    setTheme(t);
    setLocal(t);
  };

  // Auto has to follow the system as it changes, not only at load — the OS
  // switches at sunset and the page may well be open across it.
  useEffect(() => {
    if (theme !== 'auto') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('auto');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  return (
    <div className="themerow">
      <span className="muted">Theme</span>
      <div className="seg" role="group" aria-label="Theme">
        {(['auto', 'dark', 'light'] as Theme[]).map((t) => (
          <button
            key={t}
            className={`segbtn${theme === t ? ' on' : ''}`}
            aria-pressed={theme === t}
            onClick={() => pick(t)}
          >
            {t === 'auto' ? 'Auto' : t === 'dark' ? 'Dark' : 'Light'}
          </button>
        ))}
      </div>
    </div>
  );
}

function UserMenu({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const go = (v: View) => {
    setOpen(false);
    navigate(v);
  };

  return (
    <div className="usermenu" ref={wrap}>
      <button
        className="avatar"
        title={me.name}
        aria-label="Account menu"
        onClick={() => setOpen((o) => !o)}
      >
        {me.name.slice(0, 1).toUpperCase()}
      </button>
      {open && (
        <div className="menupop usermenupop" role="menu">
          <div className="userhead">
            <b>{me.name}</b>
            <span className="muted">@{me.user}</span>
          </div>
          <ThemePicker />
          <button className="menuitem" onClick={() => go({ name: 'listening' })}>
            <span>Your listening</span>
          </button>
          <button className="menuitem" onClick={() => go({ name: 'gaps' })}>
            <span>Complete your albums</span>
          </button>
          <button className="menuitem" onClick={() => go({ name: 'profile', page: 'preferences' })}>
            <span>My profile</span>
          </button>
          {me.admin && (
            <button className="menuitem" onClick={() => go({ name: 'admin', page: 'statistics' })}>
              <span>Admin portal</span>
            </button>
          )}
          <button
            className="menuitem"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            <span>Sign out</span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The profile: everything about YOU, one pane at a time.
 *
 * Same side-menu shape as the admin portal — these are settings pages, and a
 * single scroll of unrelated sections stopped scaling the moment Import
 * arrived with its own live progress display.
 */
/**
 * Everyone's import runs, for the admin. Who brought a library across, when,
 * and how it went — the same rows each person sees on their own Import tab,
 * with the username added.
 */
function AdminImports() {
  const [runs, setRuns] = useState<ImportRun[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.adminImports().then((r) => setRuns(r.runs)).catch((e: Error) => setErr(e.message));
  }, []);

  if (err) return <div className="note bad">{err}</div>;
  if (!runs) return <div className="spinner">Loading…</div>;
  if (!runs.length) return <div className="empty">Nobody has imported a library yet.</div>;

  return (
    <>
      <div className="rowhead">
        <h2>Import runs</h2>
        <span className="reason">{runs.length} run{runs.length === 1 ? '' : 's'}, newest first</span>
      </div>
      <table className="list">
        <thead>
          <tr>
            <th>User</th>
            <th>Started</th>
            <th>Last activity</th>
            <th>Songs</th>
            <th>Done</th>
            <th>Failed</th>
            <th>Open</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={`${r.userId}-${r.batchId}`}>
              <td>{r.username}</td>
              <td>{new Date(r.startedAt * 1000).toLocaleString()}</td>
              <td className="muted">{new Date(r.updatedAt * 1000).toLocaleString()}</td>
              <td>{r.total}</td>
              <td style={{ color: 'var(--ok)' }}>{r.done}</td>
              <td style={{ color: r.failed ? 'var(--err)' : undefined }}>{r.failed}</td>
              <td className="muted">{r.open}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function ProfileView({
  me,
  page,
  say,
  onPrefsChanged,
  onSignedOut,
}: {
  me: Me | null;
  page: ProfilePage;
  say: (k: 'good' | 'bad', t: string) => void;
  onPrefsChanged: () => void;
  onSignedOut: () => void;
}) {
  const uiPlugins = useUiPlugins();
  const items: { page: ProfilePage; label: string; hint: string }[] = [
    { page: 'preferences', label: 'Preferences', hint: 'home page and defaults' },
    { page: 'algorithm', label: 'My Algorithm', hint: 'steer your recommendations' },
    ...uiPlugins
      .filter((pl) => pl.profile)
      .map((pl) => ({ page: pl.id, label: pl.profile!.label, hint: pl.profile!.hint })),
    { page: 'requests', label: 'Requests', hint: 'downloads and history' },
    { page: 'apps', label: 'Music apps', hint: 'phone and desktop players' },
    { page: 'import', label: 'Import', hint: 'bring a library across' },
    { page: 'upload', label: 'Upload', hint: 'add an album from your files' },
    { page: 'account', label: 'Account', hint: 'password and sign-in' },
  ];
  /*
   * A bookmark can point at a plugin page that is switched off, uninstalled, or simply not
   * loaded yet — the URL always parses, and this is where it lands somewhere sensible. The
   * fallback is REACTIVE: when an installed plugin registers a moment after first paint, items
   * regains its page and this re-renders onto the real pane.
   */
  const shown = items.some((it) => it.page === page) ? page : 'preferences';

  return (
    <div className="admin">
      <nav className="adminnav">
        {items.map((it) => (
          <Link
            key={it.page}
            to={{ name: 'profile', page: it.page }}
            className={`adminlink${shown === it.page ? ' on' : ''}`}
          >
            <span className="l">{it.label}</span>
            <span className="h">{it.hint}</span>
          </Link>
        ))}
      </nav>
      <section className="adminpane profilepane">
        {/* One header for every pane, from the same list the nav is built
            from — the title you clicked is the title you get, and no pane
            can drift into carrying its own competing h2. */}
        <div className="rowhead panehead">
          <h2>{items.find((it) => it.page === shown)?.label}</h2>
          <span className="reason">
            {shown === 'account' ? `signed in as ${me?.user}` : items.find((it) => it.page === shown)?.hint}
          </span>
        </div>
        {shown === 'preferences' && <PrefsPane me={me} say={say} onPrefsChanged={onPrefsChanged} />}
        {shown === 'algorithm' && <MyAlgorithm say={say} />}
        {uiPlugins.map(
          (pl) => pl.profile && shown === pl.id && <pl.profile.Pane key={pl.id} say={say} />,
        )}
        {shown === 'requests' && <RequestsView say={say} admin={!!me?.admin} />}
        {shown === 'apps' && <StreamPassword me={me} say={say} />}
        {shown === 'import' && <ImportPane say={say} />}
        {shown === 'upload' && <UploadPane say={say} />}
        {shown === 'account' && (
          <PasswordForm
            userId={me?.id ?? null}
            label="Change your password"
            onDone={(signedOut) => {
              say('good', 'Password changed. Sign in again.');
              if (signedOut) onSignedOut();
            }}
            say={say}
          />
        )}
      </section>
    </div>
  );
}

function PrefsPane({
  me,
  say,
  onPrefsChanged,
}: {
  me: Me | null;
  say: (k: 'good' | 'bad', t: string) => void;
  onPrefsChanged: () => void;
}) {
  const [home, setHome] = useState<Me['homePage']>(me?.homePage ?? 'discover');
  const [savingHome, setSavingHome] = useState(false);

  const pickHome = (v: Me['homePage']) => {
    setHome(v);
    setSavingHome(true);
    void api
      .setPrefs(v)
      .then(() => {
        onPrefsChanged();
        say('good', 'Home page updated');
      })
      .catch((e: Error) => say('bad', e.message))
      .finally(() => setSavingHome(false));
  };

  return (
    <>
      <div className="field">
        <span>Home page — what crate opens with</span>
        <div className="chips" style={{ marginTop: 6 }}>
          {(
            [
              ['discover', 'Discover'],
              ['mylibrary', 'My Library'],
              ['playlists', 'Playlists'],
            ] as [Me['homePage'], string][]
          ).map(([v, label]) => (
            <button
              key={v}
              className={`chip${home === v ? ' on' : ''}`}
              disabled={savingHome}
              onClick={() => pickHome(v)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * Parse CSV, honestly. Quoted fields, embedded commas and newlines, doubled
 * quotes — a library export has all of them the moment an album is called
 * "Yes, I Know" or a playlist has a comma in its name.
 */
function parseCsv(text: string): string[][] {
  // A UTF-8 BOM glues itself to the first header cell — "\ufefftrack name"
  // matches nothing — and TuneMyMusic's exports carry one. Excel adds one to
  // anything it re-saves, so this protects the Apple path too.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/**
 * The import pane: pick the export, see what it holds, press go, watch it
 * land. Processing sits at the top, done gets its tick, failed its cross —
 * and failed rows say why, because "failed" alone is a support ticket.
 */
/**
 * Bring your own album.
 *
 * Three ways to give the files an identity, in order of effort: crate guesses
 * a MusicBrainz album from the files\' own tags; the person searches and picks
 * one, then assigns each file to a track; or they type the whole thing —
 * artist, album, per-song titles — and optionally attach a cover image. That
 * last path is what makes bootlegs, demos and home recordings first-class: not
 * everything worth keeping is in a database.
 */
type UploadBatch = {
  batchId: string;
  files: UploadedFile[];
  rejected: { name: string; why: string }[];
};

/**
 * The identity step, shared by uploads and adopted downloads.
 *
 * Everything after "the files are staged": guess the album, or search and
 * allocate, or type it all. Cancel discards the batch — which for an upload
 * deletes a copy, and for an adopted download RESTORES it to where it came
 * from; the server knows which from the batch itself, so this component does
 * not have to.
 */
function UploadConfirm({
  batch,
  say,
  onDone,
  onCancel,
}: {
  batch: UploadBatch;
  say: (k: 'good' | 'bad', t: string) => void;
  onDone: (artist: string, album: string) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<'mb' | 'custom'>('mb');
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<SearchAlbum[] | null>(null);
  const [chosen, setChosen] = useState<SearchAlbum | null>(null);
  const [tracklist, setTracklist] = useState<AlbumTrack[] | null>(null);
  /** staged file name -> index into the tracklist. -1 = leave this file out. */
  const [alloc, setAlloc] = useState<Record<string, number>>({});
  const [cArtist, setCArtist] = useState('');
  const [cAlbum, setCAlbum] = useState('');
  const [cMeta, setCMeta] = useState<Record<string, { title: string; trackNo: number }>>({});
  const [busy, setBusy] = useState(false);

  const audio = batch.files.filter((f) => f.kind === 'audio');
  const image = batch.files.find((f) => f.kind === 'image');
  const fold = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  /*
   * The fingerprint beats the tags when both exist: tags describe what
   * somebody once typed, the fingerprint describes what the audio IS. Either
   * way the result is only a pre-filled search — the person still confirms.
   */
  useEffect(() => {
    const printed = batch.files.find((f) => f.kind === 'audio' && f.match?.artist);
    const first = batch.files.find((f) => f.kind === 'audio' && f.tags?.artist);
    const guess = printed?.match
      ? `${printed.match.artist} ${printed.match.album}`.trim()
      : first?.tags
        ? `${first.tags.artist} ${first.tags.album}`.trim()
        : '';
    setQuery(guess);
    if (guess) void search(guess, printed?.match?.releaseGroupMbid ?? null);
    setCArtist(first?.tags?.artist ?? '');
    setCAlbum(first?.tags?.album ?? '');
    const meta: Record<string, { title: string; trackNo: number }> = {};
    batch.files
      .filter((f) => f.kind === 'audio')
      .forEach((f, i) => {
        meta[f.name] = { title: f.tags?.title ?? f.name, trackNo: f.tags?.trackNo ?? i + 1 };
      });
    setCMeta(meta);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch.batchId]);

  const search = async (q: string, autoPick: string | null = null) => {
    setCandidates(null);
    try {
      const r = await api.search(q);
      const albums = r.albums.slice(0, 8);
      setCandidates(albums);
      // When the fingerprint named a release group and the search found it,
      // choose it outright — the person sees it selected, not a question.
      const hit = autoPick ? albums.find((al) => al.mbid === autoPick) : undefined;
      if (hit) void choose(hit);
    } catch {
      setCandidates([]);
    }
  };

  const choose = async (al: SearchAlbum) => {
    setChosen(al);
    setTracklist(null);
    try {
      const r = await api.tracks(al.mbid);
      setTracklist(r.tracks);
      /*
       * Allocation is the server's job now: the rules engine reads through
       * release-name noise the old exact-match here tripped on, and when an
       * OpenAI key is configured the doubtful leftovers get arbitrated. A
       * failure of the endpoint falls back to file order — still editable,
       * still only a suggestion.
       */
      try {
        const m = await api.matchTracks(
          audio.map((f) => ({
            name: f.name,
            tagTitle: f.tags?.title ?? null,
            tagTrackNo: f.tags?.trackNo ?? null,
            durationS: f.tags?.durationS ?? null,
          })),
          r.tracks.map((t) => ({ position: t.position, title: t.title, lengthMs: t.lengthMs })),
        );
        const next: Record<string, number> = {};
        for (const a of m.assignments) {
          next[a.name] = a.position === null ? -1 : r.tracks.findIndex((t) => t.position === a.position);
        }
        setAlloc(next);
      } catch {
        const next: Record<string, number> = {};
        audio.forEach((f, i) => {
          next[f.name] = Math.min(i, r.tracks.length - 1);
        });
        setAlloc(next);
      }
    } catch (e) {
      say('bad', (e as Error).message);
    }
  };

  const cancel = () => {
    void api.discardUpload(batch.batchId).catch(() => {});
    onCancel();
  };

  const finalize = async () => {
    if (!batch) return;
    let body: Parameters<typeof api.finalizeUpload>[0];
    if (mode === 'mb') {
      if (!chosen || !tracklist) return;
      body = {
        batchId: batch.batchId,
        artistName: chosen.artistName,
        albumTitle: chosen.title,
        mbid: chosen.mbid,
        cover: image?.name,
        files: audio
          .filter((f) => (alloc[f.name] ?? -1) >= 0)
          .map((f) => {
            const t = tracklist[alloc[f.name] ?? 0]!;
            return { name: f.name, title: t.title, trackNo: t.position };
          }),
      };
    } else {
      if (!cArtist.trim() || !cAlbum.trim()) {
        say('bad', 'artist and album are required');
        return;
      }
      body = {
        batchId: batch.batchId,
        artistName: cArtist.trim(),
        albumTitle: cAlbum.trim(),
        cover: image?.name,
        files: audio.map((f) => ({
          name: f.name,
          title: cMeta[f.name]?.title || f.name,
          trackNo: cMeta[f.name]?.trackNo || 1,
        })),
      };
    }
    if (!body.files.length) {
      say('bad', 'no files are assigned to tracks');
      return;
    }
    setBusy(true);
    try {
      const r = await api.finalizeUpload(body);
      /*
       * Say what actually happened, including the case where nothing was uploaded.
       *
       * A batch whose songs are all already on disk reported nothing at all, so clicking Add
       * To Library looked like a dead button — the request had returned, it just had nothing
       * to announce. Those songs are now taken from the copy already there, which is a
       * SUCCESS and has to read like one.
       */
      const moved = r.tracks - (r.adopted ?? 0);
      const parts = [];
      if (moved) parts.push(`${moved} uploaded`);
      if (r.adopted) parts.push(`${r.adopted} already on disk, added from there`);
      say(
        'good',
        `${body.albumTitle}: ${parts.join(' · ') || `${r.tracks} tracks`} in your library.`,
      );
      // Anything genuinely left out — a duplicate the person already owned — is worth one
      // more line rather than silence.
      const left = (r.skipped ?? []).filter((sk) => /already in your library/.test(sk.why));
      if (left.length) say('bad', `${left.length} left out: ${left[0]!.why}`);
      onDone(body.artistName, body.albumTitle);
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
          <div className="note">
            <b>{audio.length}</b> audio file{audio.length === 1 ? '' : 's'} staged
            {image ? ', plus a cover image' : ''}.
          </div>

          <div className="chips" style={{ margin: '10px 0' }}>
            <button className={`chip${mode === 'mb' ? ' on' : ''}`} onClick={() => setMode('mb')}>
              Match a MusicBrainz album
            </button>
            <button
              className={`chip${mode === 'custom' ? ' on' : ''}`}
              onClick={() => setMode('custom')}
            >
              My own album
            </button>
          </div>

          {mode === 'mb' && (
            <>
              <div className="pair" style={{ alignItems: 'center' }}>
                <input
                  type="search"
                  placeholder="artist and album…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void search(query);
                  }}
                />
                <button className="btn sec sm" onClick={() => void search(query)}>
                  Search
                </button>
              </div>
              {candidates === null && query && <div className="spinner">Searching…</div>}
              {candidates && (
                <div className="chips" style={{ margin: '8px 0' }}>
                  {candidates.map((al) => (
                    <button
                      key={al.mbid}
                      className={`chip${chosen?.mbid === al.mbid ? ' on' : ''}`}
                      onClick={() => void choose(al)}
                    >
                      {al.artistName} — {al.title}
                      {al.releaseDate ? ` (${al.releaseDate.slice(0, 4)})` : ''}
                    </button>
                  ))}
                  {!candidates.length && <span className="muted sm">nothing found — try other words</span>}
                </div>
              )}
              {chosen && !tracklist && <div className="spinner">Loading the tracklist…</div>}
              {chosen && tracklist && (
                <table className="list">
                  <thead>
                    <tr>
                      <th>Your file</th>
                      <th>Becomes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audio.map((f) => (
                      <tr key={f.name}>
                        <td>
                          {f.name}
                          {f.tags?.durationS ? (
                            <span className="muted"> · {secs(f.tags.durationS)}</span>
                          ) : null}
                        </td>
                        <td>
                          <select
                            value={alloc[f.name] ?? -1}
                            onChange={(e) =>
                              setAlloc({ ...alloc, [f.name]: Number(e.target.value) })
                            }
                          >
                            <option value={-1}>— leave out —</option>
                            {tracklist.map((t, i) => (
                              <option key={`${t.position}-${t.title}`} value={i}>
                                {t.position}. {t.title}
                                {t.lengthMs ? ` (${secs(Math.round(t.lengthMs / 1000))})` : ''}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}

          {mode === 'custom' && (
            <>
              <div className="pair">
                <label className="field">
                  <span>Artist</span>
                  <input value={cArtist} onChange={(e) => setCArtist(e.target.value)} />
                </label>
                <label className="field">
                  <span>Album</span>
                  <input value={cAlbum} onChange={(e) => setCAlbum(e.target.value)} />
                </label>
              </div>
              <table className="list">
                <thead>
                  <tr>
                    <th style={{ width: 60 }}>#</th>
                    <th>Title</th>
                    <th>File</th>
                  </tr>
                </thead>
                <tbody>
                  {audio.map((f) => (
                    <tr key={f.name}>
                      <td>
                        <input
                          type="number"
                          min={1}
                          style={{ width: 56 }}
                          value={cMeta[f.name]?.trackNo ?? 1}
                          onChange={(e) =>
                            setCMeta({
                              ...cMeta,
                              [f.name]: {
                                title: cMeta[f.name]?.title ?? '',
                                trackNo: Number(e.target.value),
                              },
                            })
                          }
                        />
                      </td>
                      <td>
                        <input
                          value={cMeta[f.name]?.title ?? ''}
                          onChange={(e) =>
                            setCMeta({
                              ...cMeta,
                              [f.name]: {
                                trackNo: cMeta[f.name]?.trackNo ?? 1,
                                title: e.target.value,
                              },
                            })
                          }
                        />
                      </td>
                      <td className="muted">{f.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!image && (
                <div className="muted sm" style={{ marginTop: 6 }}>
                  Tip: include a jpg or png in the upload and it becomes the album cover.
                </div>
              )}
            </>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              className="btn"
              disabled={busy || (mode === 'mb' && (!chosen || !tracklist))}
              onClick={() => void finalize()}
            >
              {busy ? 'Adding…' : 'Add to library'}
            </button>
            <button className="btn sec" disabled={busy} onClick={cancel}>
              Cancel
            </button>
          </div>
    </>
  );
}

function UploadPane({ say }: { say: (k: 'good' | 'bad', t: string) => void }) {
  const [progress, setProgress] = useState<number | null>(null);
  const [batch, setBatch] = useState<UploadBatch | null>(null);

  const onPick = (list: FileList | null) => {
    if (!list?.length) return;
    setProgress(0);
    api
      .uploadFiles([...list], setProgress)
      .then((r) => {
        setBatch(r);
        for (const rej of r.rejected) say('bad', `${rej.name}: ${rej.why}`);
      })
      .catch((e: Error) => say('bad', e.message))
      .finally(() => setProgress(null));
  };

  return (
    <>
      {!batch && (
        <>
          <div className="note">
            Pick the audio files for one album — a cover image can ride along. crate reads their
            tags, guesses the album, and you confirm it (or correct it, or invent it).
          </div>
          <div style={{ margin: '12px 0' }}>
            <input
              type="file"
              multiple
              accept=".mp3,.flac,.m4a,.ogg,.opus,.wav,.aac,.jpg,.jpeg,.png,.webp"
              disabled={progress !== null}
              onChange={(e) => {
                onPick(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
          {progress !== null && (
            <div className="note">
              Uploading… {progress}%
            </div>
          )}
        </>
      )}

      {batch && (
        <UploadConfirm
          batch={batch}
          say={say}
          onDone={(artist, album) => {
            setBatch(null);
            navigate({ name: 'albumpage', artist, album });
          }}
          onCancel={() => setBatch(null)}
        />
      )}
    </>
  );
}

/**
 * Downloads sitting in the completed-music folder that crate never queued —
 * manual SAB adds, mostly. Adopt moves one into staging and hands it to the
 * same confirm screen an upload gets; cancelling puts the files back.
 */
function AdoptPane({ say }: { say: (k: 'good' | 'bad', t: string) => void }) {
  const [entries, setEntries] = useState<AdoptableEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adopting, setAdopting] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<UploadBatch | null>(null);
  const [unpacker, setUnpacker] = useState(true);
  const [scanning, setScanning] = useState(false);

  /**
   * Re-read the folder. The listing is computed live from disk on every call, so this is all a
   * "rescan" needs to be — the reason a hand-extracted folder looked unchanged was that
   * nothing ever asked again.
   */
  const load = useCallback(() => {
    setScanning(true);
    api
      .adoptable()
      .then((r) => {
        setEntries(r.entries);
        setUnpacker(r.unpacker);
        // Drop selections for entries that have since gone, so the count cannot outlive them.
        setPicked((prev) => {
          const live = new Set(r.entries.map((e) => e.path));
          return new Set([...prev].filter((p) => live.has(p)));
        });
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setScanning(false));
  }, []);
  useEffect(load, [load]);

  const adopt = async (path: string) => {
    setAdopting(path);
    try {
      setBatch(await api.adopt(path));
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setAdopting(null);
    }
  };

  const delPicked = async () => {
    setAdopting('::picked');
    try {
      const r = await api.deleteAdoptables([...picked]);
      say(
        'good',
        `${r.removed.length} moved to the trash` +
          (r.failed.length ? ` — ${r.failed.length} refused` : '') +
          '.',
      );
      setPicked(new Set());
      setConfirming(null);
      load();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setAdopting(null);
    }
  };

  const unpackPicked = async (paths: string[]) => {
    setAdopting('::unpack');
    try {
      const r = await api.unpackAdoptables(paths);
      const opened = r.results.reduce((n, x) => n + x.archives, 0);
      const gained = r.results.reduce((n, x) => n + x.audioGained, 0);
      const errs = r.results.flatMap((x) => x.errors);
      if (opened === 0 && !errs.length) say('bad', 'No archives found in that selection.');
      else if (errs.length) {
        // Surfaced rather than swallowed: a missing volume is the usual cause and the
        // person needs to know the release is incomplete, not that crate is broken.
        say('bad', `${gained} track${gained === 1 ? '' : 's'} extracted · ${errs[0]}`);
      } else {
        say('good', `Unpacked ${opened} archive${opened === 1 ? '' : 's'} — ${gained} audio file${gained === 1 ? '' : 's'}.`);
      }
      load();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setAdopting(null);
    }
  };

  const purgeDuds = async () => {
    setAdopting('::duds');
    try {
      const r = await api.purgeDuds();
      say('good', `${r.removed.length} dud${r.removed.length === 1 ? '' : 's'} moved to the trash.`);
      setConfirming(null);
      load();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setAdopting(null);
    }
  };

  const del = async (path: string) => {
    setAdopting(path);
    try {
      await api.deleteAdoptable(path);
      say('good', 'Moved to the trash.');
      setConfirming(null);
      load();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setAdopting(null);
    }
  };

  if (err) return <div className="note bad">{err}</div>;

  if (batch) {
    return (
      <>
        <div className="rowhead">
          <h2>Adopt this download</h2>
          <span className="reason">cancel puts the files back where they were</span>
        </div>
        <UploadConfirm
          batch={batch}
          say={say}
          onDone={() => {
            setBatch(null);
            load();
          }}
          onCancel={() => {
            setBatch(null);
            load();
          }}
        />
      </>
    );
  }

  return (
    <>
      <div className="rowhead">
        <h2>Adopt downloads</h2>
        <span className="reason">finished music crate didn’t queue itself</span>
        <div className="spacer" />
        <button className="btn sec sm" disabled={scanning} onClick={load}>
          {scanning ? 'Rescanning…' : 'Rescan'}
        </button>{' '}
        {(() => {
          const duds = (entries ?? []).filter(
            (e) => e.audioFiles === 0 && !e.note.includes('archives'),
          ).length;
          if (!duds) return null;
          return confirming === '::duds' ? (
            <>
              <button
                className="btn sm"
                disabled={adopting !== null}
                onClick={() => void purgeDuds()}
              >
                Really delete {duds}
              </button>{' '}
              <button className="btn sec sm" onClick={() => setConfirming(null)}>
                Keep
              </button>
            </>
          ) : (
            <button className="btn sec sm" onClick={() => setConfirming('::duds')}>
              Delete {duds} dud{duds === 1 ? '' : 's'}
            </button>
          );
        })()}
      </div>
      {!entries && <div className="spinner">Looking…</div>}
      {entries && !entries.length && (
        <div className="note" style={{ maxWidth: 560 }}>
          Nothing waiting. Anything added to SAB by hand under the music category will appear
          here once it finishes. Archives are fine — unpack them here rather than on the NAS.
        </div>
      )}
      {picked.size > 0 && (
        <div className="note" style={{ maxWidth: 760, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span>
            {picked.size} selected — deleting moves them to the trash, not oblivion.
          </span>
          <div className="spacer" />
          {(() => {
            const withArchives = (entries ?? []).filter(
              (e) => picked.has(e.path) && e.archiveFiles > 0,
            ).length;
            if (!withArchives) return null;
            return (
              <button
                className="btn sec sm"
                disabled={adopting !== null || !unpacker}
                title={unpacker ? undefined : '7z is missing from this image'}
                onClick={() => void unpackPicked([...picked])}
              >
                {adopting === '::unpack' ? 'Unpacking…' : `Unpack ${withArchives}`}
              </button>
            );
          })()}
          {confirming === '::picked' ? (
            <>
              <button className="btn sm" disabled={adopting !== null} onClick={() => void delPicked()}>
                Really delete {picked.size}
              </button>
              <button className="btn sec sm" onClick={() => setConfirming(null)}>
                Keep
              </button>
            </>
          ) : (
            <button className="btn sm" onClick={() => setConfirming('::picked')}>
              Delete selected
            </button>
          )}
        </div>
      )}
      {entries && entries.length > 0 && (
        <table className="list" style={{ maxWidth: 760 }}>
          <thead>
            <tr>
              <th style={{ width: 30 }}>
                <input
                  type="checkbox"
                  checked={picked.size === entries.length && entries.length > 0}
                  aria-label="Select all"
                  onChange={(e) =>
                    setPicked(e.target.checked ? new Set(entries.map((x) => x.path)) : new Set())
                  }
                />
              </th>
              <th>Download</th>
              <th>Audio</th>
              <th>Size</th>
              <th>Age</th>
              <th style={{ textAlign: 'right' }}>&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.path}>
                <td>
                  <input
                    type="checkbox"
                    checked={picked.has(e.path)}
                    aria-label={`Select ${e.name}`}
                    onChange={(ev) => {
                      const next = new Set(picked);
                      if (ev.target.checked) next.add(e.path);
                      else next.delete(e.path);
                      setPicked(next);
                    }}
                  />
                </td>
                <td>
                  {e.name}
                  {e.note && <div className="muted sm">{e.note}</div>}
                </td>
                <td className="muted">{e.audioFiles} file{e.audioFiles === 1 ? '' : 's'}</td>
                <td className="muted">{bytes(e.bytes)}</td>
                <td className="muted">
                  {e.ageMinutes < 120 ? `${e.ageMinutes} min` : `${Math.round(e.ageMinutes / 60)} h`}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {e.archiveFiles > 0 && (
                    <>
                      <button
                        className="btn sec sm"
                        disabled={adopting !== null || !unpacker}
                        title={unpacker ? undefined : '7z is missing from this image'}
                        onClick={() => void unpackPicked([e.path])}
                      >
                        {adopting === '::unpack' ? 'Unpacking…' : 'Unpack'}
                      </button>{' '}
                    </>
                  )}
                  <button
                    className="btn sm"
                    disabled={adopting !== null || e.audioFiles === 0 || e.settling}
                    title={e.settling ? 'Waiting in case it is still being written' : undefined}
                    onClick={() => void adopt(e.path)}
                  >
                    {adopting === e.path ? 'Adopting…' : 'Adopt'}
                  </button>{' '}
                  {confirming === e.path ? (
                    <>
                      <button
                        className="btn sm"
                        disabled={adopting !== null}
                        onClick={() => void del(e.path)}
                      >
                        Really delete
                      </button>{' '}
                      <button className="btn sec sm" onClick={() => setConfirming(null)}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn sec sm"
                      disabled={adopting !== null}
                      onClick={() => setConfirming(e.path)}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function ImportPane({ say }: { say: (k: 'good' | 'bad', t: string) => void }) {
  const [parsed, setParsed] = useState<
    { rows: { title: string; artist: string; album: string; playlist: string; isrc: string }[]; fileName: string } | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<Awaited<ReturnType<typeof api.importStatus>> | null>(null);
  const [runs, setRuns] = useState<ImportRun[] | null>(null);
  /** Which run the detail view shows; undefined = the latest. */
  const [viewBatch, setViewBatch] = useState<string | undefined>(undefined);

  const refresh = useCallback(() => {
    api.importStatus(viewBatch).then(setLive).catch(() => undefined);
    api.importHistory().then((r) => setRuns(r.runs)).catch(() => undefined);
  }, [viewBatch]);

  // Poll while anything is still moving; stop the moment it is not.
  useEffect(() => {
    refresh();
  }, [refresh]);
  const active = ((live?.counts.pending ?? 0) + (live?.counts.processing ?? 0)) > 0;
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(refresh, 4000);
    return () => window.clearInterval(t);
  }, [active, refresh]);

  const onFile = (f: File) => {
    void f.text().then((text) => {
      const grid = parseCsv(text);
      const head = (grid[0] ?? []).map((h) => h.trim().toLowerCase());
      const col = (...names: string[]) => {
        for (const n of names) {
          const i = head.indexOf(n);
          if (i !== -1) return i;
        }
        return -1;
      };
      const ct = col('track name', 'name', 'title', 'song');
      const ca = col('artist name', 'artist');
      const cal = col('album', 'album name');
      const cp = col('playlist name', 'playlist');
      const ci = col('isrc');
      if (ct === -1 || ca === -1) {
        say('bad', 'That file has no "Track name" / "Artist name" columns — expected an Apple Music or TuneMyMusic CSV export.');
        return;
      }
      const rows = grid.slice(1).map((r) => ({
        title: r[ct] ?? '',
        artist: r[ca] ?? '',
        album: cal === -1 ? '' : (r[cal] ?? ''),
        playlist: cp === -1 ? '' : (r[cp] ?? ''),
        isrc: ci === -1 ? '' : (r[ci] ?? ''),
      })).filter((r) => r.title.trim() && r.artist.trim());
      setParsed({ rows, fileName: f.name });
    });
  };

  const begin = () => {
    if (!parsed) return;
    setBusy(true);
    void api
      .importRows(parsed.rows)
      .then((r) => {
        say('good', `Import started: ${r.items} songs, ${r.playlists} new playlist${r.playlists === 1 ? '' : 's'}`);
        setParsed(null);
        refresh();
      })
      .catch((e: Error) => say('bad', e.message))
      .finally(() => setBusy(false));
  };

  const uniq = (xs: string[]) => new Set(xs.filter(Boolean)).size;

  /*
   * A working example beats a format description. Two rows demonstrate the
   * shape — one with everything filled, one with only the required pair — and
   * a data: URI keeps it out of the server entirely: nothing to fetch, cache
   * or 404, because a broken "download the sample" link on a help page is a
   * special kind of embarrassing.
   */
  const sample =
    'Track name,Artist name,Album,Playlist name,ISRC\n' +
    'Teardrop,Massive Attack,Mezzanine,Trip Hop Essentials,GBAAA9800303\n' +
    'Everlong,Foo Fighters,,,\n';

  return (
    <>
      <div className="note">
        Import your existing library and crate will do its best to source the music for you and
        make it available for you to stream.{' '}
        <a
          href={`data:text/csv;charset=utf-8,${encodeURIComponent(sample)}`}
          download="crate-import-sample.csv"
        >
          Download a sample CSV
        </a>
        .
      </div>

      <div className="pair" style={{ alignItems: 'center', margin: '12px 0' }}>
        <input
          type="file"
          accept=".csv,text/csv,text/plain"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = '';
          }}
        />
        {parsed && (
          <button className="btn" disabled={busy} onClick={begin}>
            {busy ? 'Starting…' : `Import ${parsed.rows.length} songs`}
          </button>
        )}
      </div>

      {parsed && (
        <div className="note">
          <b>{parsed.fileName}</b>: {parsed.rows.length} songs ·{' '}
          {uniq(parsed.rows.map((r) => `${r.artist}|${r.album}`))} albums ·{' '}
          {uniq(parsed.rows.map((r) => r.playlist))} playlists
        </div>
      )}

      {runs && runs.length > 0 && (
        <>
          <div className="rowhead subhead">
            <h3>Your imports</h3>
            <span className="reason">every run, newest first — click one to inspect it</span>
          </div>
          <table className="list">
            <thead>
              <tr>
                <th>Started</th>
                <th>Songs</th>
                <th>Done</th>
                <th>Failed</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr
                  key={r.batchId}
                  style={{ cursor: 'pointer' }}
                  className={live?.batchId === r.batchId ? 'playing' : undefined}
                  onClick={() => setViewBatch(r.batchId)}
                >
                  <td>{new Date(r.startedAt * 1000).toLocaleString()}</td>
                  <td>{r.total}</td>
                  <td style={{ color: 'var(--ok)' }}>{r.done}</td>
                  <td style={{ color: r.failed ? 'var(--err)' : undefined }}>{r.failed}</td>
                  <td className="muted">{r.open}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {live?.batchId && (
        <>
          <div className="sechead">
            <h2>Progress</h2>
            <span className="sub">
              {(live.counts.done ?? 0) + (live.counts.failed ?? 0)} of {live.total} settled
            </span>
          </div>

          {/* One bar for the whole batch: green ground gained, red ground lost. */}
          <div className="impbar">
            <div
              className="ok"
              style={{ width: `${live.total ? ((live.counts.done ?? 0) / live.total) * 100 : 0}%` }}
            />
            <div
              className="bad"
              style={{ width: `${live.total ? ((live.counts.failed ?? 0) / live.total) * 100 : 0}%` }}
            />
          </div>
          <div className="impcounts">
            <span className="c ok">✓ {live.counts.done ?? 0} done</span>
            <span className="c bad">✕ {live.counts.failed ?? 0} failed</span>
            <span className="c">⟳ {live.counts.processing ?? 0} downloading</span>
            <span className="c muted">{live.counts.pending ?? 0} waiting</span>
          </div>

          {live.albums.length > 0 && (
            <>
              <div className="sechead">
                <h2>Downloading now</h2>
                <span className="sub">{live.albums.length} album{live.albums.length === 1 ? '' : 's'} in flight</span>
              </div>
              <div className="importlist">
                {live.albums.map((a, i) => (
                  <div key={`${a.artist}-${a.album}-${i}`} className="importrow processing">
                    <span className="st"><span className="spin" /></span>
                    <span className="words">
                      <b>{a.album || '(album)'}</b> — {a.artist}
                      <em> · {a.songs} song{a.songs === 1 ? '' : 's'} from this album</em>
                    </span>
                    <span className="pct">{a.progress > 0 ? `${a.progress}%` : 'searching…'}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {live.failed.length > 0 && (
            <>
              <div className="sechead">
                <h2>Failed</h2>
                <span className="sub">every one, with its reason</span>
                <div className="spacer" />
                {/* Two buttons because the failures are not equal: one that was
                    found and then broke has a second source to fall back on now
                    and is worth trying first, while one that found nothing
                    proves less. */}
                <button
                  className="btn sec sm"
                  title="Aborted transfers, missing repair blocks, bad archives"
                  onClick={() => {
                    void api
                      .importRetry('downloads')
                      .then((r) => {
                        say('good', `${r.retried} download failure${r.retried === 1 ? '' : 's'} requeued`);
                        refresh();
                      })
                      .catch((e: Error) => say('bad', e.message));
                  }}
                >
                  Retry broken downloads
                </button>
                <button
                  className="btn sec sm"
                  onClick={() => {
                    void api
                      .importRetry()
                      .then((r) => {
                        say('good', `${r.retried} song${r.retried === 1 ? '' : 's'} back in the queue`);
                        refresh();
                      })
                      .catch((e: Error) => say('bad', e.message));
                  }}
                >
                  Retry all failed
                </button>
              </div>
              <div className="importlist">
                {live.failed.map((it) => (
                  <div key={it.id} className="importrow failed">
                    <span className="st">✕</span>
                    <span className="words">
                      <b>{it.title}</b> — {it.artist}
                      {it.detail ? <em className="why"> — {it.detail}</em> : null}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {live.recentDone.length > 0 && (
            <>
              <div className="sechead">
                <h2>Recently completed</h2>
                <span className="sub">newest first · {live.counts.done ?? 0} total</span>
              </div>
              <div className="importlist">
                {live.recentDone.map((it) => (
                  <div key={it.id} className="importrow done">
                    <span className="st">✓</span>
                    <span className="words">
                      <b>{it.title}</b> — {it.artist}
                      {it.playlist ? <em> · {it.playlist}</em> : null}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {(live.counts.pending ?? 0) > 0 && (
            <>
              <div className="sechead">
                <h2>Waiting</h2>
                <span className="sub">{live.counts.pending} more queued behind the downloads</span>
              </div>
              <div className="importlist">
                {live.waitingPreview.map((it) => (
                  <div key={it.id} className="importrow pending">
                    <span className="st">·</span>
                    <span className="words">
                      <b>{it.title}</b> — {it.artist}
                    </span>
                  </div>
                ))}
                {(live.counts.pending ?? 0) > live.waitingPreview.length && (
                  <div className="muted" style={{ padding: '6px 12px' }}>
                    …and {(live.counts.pending ?? 0) - live.waitingPreview.length} more
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

/**
 * My Algorithm: both kinds of recommendation suppression, visible and undoable.
 *
 * "Don't recommend" marks are explicit; the ones created by removing music
 * from the library are implicit and used to be invisible. Here they sit side
 * by side, each with its way back.
 */
/** One warmth value: six fixed choices, so it reads as a dial, not a field. */
function WarmthDial({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="warmth" role="radiogroup" aria-label="Warmth">
      {[0, 1, 2, 3, 4, 5].map((v) => (
        <button
          key={v}
          className={`wnotch${value === v ? ' on' : ''}${v === 0 ? ' zero' : ''}`}
          role="radio"
          aria-checked={value === v}
          title={v === 0 ? 'Prefer none of this' : v === 5 ? 'Prefer most of this' : `Warmth ${v}`}
          onClick={() => onChange(v)}
        >
          {v}
        </button>
      ))}
    </div>
  );
}

const WARMTH_KINDS: { kind: WarmthKind; label: string; hint: string }[] = [
  { kind: 'genre', label: 'Genres', hint: 'applies through each artist’s genres' },
  { kind: 'artist', label: 'Artists', hint: 'everything by them' },
  { kind: 'album', label: 'Albums', hint: 'as “Artist — Album”' },
  { kind: 'track', label: 'Songs', hint: 'as “Artist — Title”' },
];

function MyAlgorithm({ say }: { say: (k: 'good' | 'bad', t: string) => void }) {
  const [removed, setRemoved] = useState<string[] | null>(null);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.algo>> | null>(null);
  const [newName, setNewName] = useState('');
  const [addKind, setAddKind] = useState<WarmthKind>('genre');
  const [addLabel, setAddLabel] = useState('');
  const [filling, setFilling] = useState(false);

  const loadAlgo = useCallback(() => {
    api.algo().then(setData).catch((e: Error) => say('bad', e.message));
  }, [say]);
  useEffect(() => loadAlgo(), [loadAlgo]);

  const load = useCallback(() => {
    api
      .excludes()
      .then((r) => setRemoved(r.removedArtists))
      .catch(() => setRemoved([]));
  }, []);
  useEffect(() => load(), [load]);

  const setWarmth = (kind: WarmthKind, label: string, warmth: number) => {
    void api
      .setWarmth(kind, label, warmth)
      .then(loadAlgo)
      .catch((e: Error) => say('bad', e.message));
  };

  const fill = async () => {
    setFilling(true);
    try {
      // Loop until nothing remains: each call is capped so a slow public API
      // cannot hold one request open for ten minutes.
      let r = await api.fillGenres();
      while (r.remaining > 0) r = await api.fillGenres();
      say('good', 'Genres are up to date.');
      loadAlgo();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setFilling(false);
    }
  };

  return (
    <>
      <div className="rowhead subhead">
        <h3>Profiles</h3>
        <span className="reason">moods — each holds its own warmth values</span>
      </div>
      {data && (
        <>
          <div className="chips" style={{ marginBottom: 6 }}>
            {data.profiles.map((p) => (
              <button
                key={p.id}
                className={`chip${p.active ? ' on' : ''}`}
                title={`${p.entries} value${p.entries === 1 ? '' : 's'}`}
                onClick={() => {
                  if (!p.active) {
                    void api.activateAlgoProfile(p.id).then(loadAlgo).catch((e: Error) => say('bad', e.message));
                  }
                }}
              >
                {p.name}
              </button>
            ))}
            <input
              className="chip yearbox"
              placeholder="new mood…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newName.trim()) {
                  void api
                    .createAlgoProfile(newName.trim())
                    .then(() => {
                      setNewName('');
                      loadAlgo();
                    })
                    .catch((err: Error) => say('bad', err.message));
                }
              }}
            />
            {(() => {
              const active = data.profiles.find((p) => p.active);
              if (!active || active.name === 'Default') return null;
              return (
                <button
                  className="chip"
                  onClick={() => {
                    void api.deleteAlgoProfile(active.id).then(loadAlgo).catch((e: Error) => say('bad', e.message));
                  }}
                >
                  ✕ delete {active.name}
                </button>
              );
            })()}
          </div>
          <div className="muted sm" style={{ marginBottom: 14 }}>
            Warmth runs 0–5: 0 means prefer <b>none</b> of this, 5 means prefer <b>most</b> of it,
            and anything you have not set stays neutral. The most specific value wins — a song’s
            own warmth beats its album’s, which beats its artist’s, which beats its genres’. Sort
            your library by it from Songs → <b>My algorithm</b>; warmth-0 songs are hidden there.
          </div>

          {WARMTH_KINDS.map(({ kind, label, hint }) => {
            const entries = data.entries.filter((e) => e.kind === kind);
            return (
              <div key={kind} style={{ marginBottom: 14 }}>
                <div className="rowhead subhead">
                  <h3>{label}</h3>
                  <span className="reason">{hint}</span>
                  {kind === 'genre' && (
                    <>
                      <div className="spacer" />
                      <span className="muted sm">
                        {data.coverage.withGenres} of {data.coverage.artists} artists mapped
                      </span>
                      {data.coverage.withGenres < data.coverage.artists && (
                        <button className="btn sec sm" disabled={filling} onClick={() => void fill()}>
                          {filling ? 'Mapping…' : 'Map genres'}
                        </button>
                      )}
                    </>
                  )}
                </div>
                {entries.length === 0 && <div className="muted sm">nothing yet</div>}
                {entries.map((e) => (
                  <div key={e.normKey} className="warmthrow">
                    <span className="wlabel">{e.label}</span>
                    <WarmthDial value={e.warmth} onChange={(v) => setWarmth(kind, e.label, v)} />
                    <button
                      className="btn sec sm"
                      title="Remove — back to neutral"
                      onClick={() => {
                        void api.removeWarmth(kind, e.normKey).then(loadAlgo).catch((err: Error) => say('bad', err.message));
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            );
          })}

          <div className="rowhead subhead">
            <h3>Add a value</h3>
          </div>
          <div className="bar">
            <select value={addKind} onChange={(e) => setAddKind(e.target.value as WarmthKind)}>
              <option value="genre">Genre</option>
              <option value="artist">Artist</option>
              <option value="album">Album</option>
              <option value="track">Song</option>
            </select>
            <input
              list={addKind === 'genre' ? 'algo-genres' : undefined}
              placeholder={
                addKind === 'genre'
                  ? 'e.g. shoegaze'
                  : addKind === 'artist'
                    ? 'artist name'
                    : `Artist — ${addKind === 'album' ? 'Album' : 'Song title'}`
              }
              value={addLabel}
              onChange={(e) => setAddLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && addLabel.trim()) {
                  setWarmth(addKind, addLabel.trim(), 3);
                  setAddLabel('');
                }
              }}
            />
            <button
              className="btn sm"
              disabled={!addLabel.trim()}
              onClick={() => {
                setWarmth(addKind, addLabel.trim(), 3);
                setAddLabel('');
              }}
            >
              Add at 3
            </button>
            <datalist id="algo-genres">
              {data.genres.map((g) => (
                <option key={g.genre} value={g.genre}>{`${g.genre} (${g.artists})`}</option>
              ))}
            </datalist>
          </div>
        </>
      )}

      <MyExcludes say={say} />
      {removed && removed.length > 0 && (
        <>
          <div className="rowhead subhead">
            <h3>Removed from your library</h3>
            <span className="reason">not recommended back unless you say so</span>
          </div>
          <table className="list">
            <tbody>
              {removed.map((name) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="btn sec sm"
                      onClick={() => {
                        void api
                          .recommendAgain(name)
                          .then(() => {
                            staleRecBlocks();
                            say('good', `${name} can be recommended again`);
                            load();
                          })
                          .catch((e: Error) => say('bad', e.message));
                      }}
                    >
                      Recommend again
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

function UsersView({
  me,
  say,
  onSignedOut,
}: {
  me: Me | null;
  say: (k: 'good' | 'bad', t: string) => void;
  onSignedOut: () => void;
}) {
  const [users, setUsers] = useState<CrateUser[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!me?.admin) return;
    api
      .users()
      .then((r) => setUsers(r.users))
      .catch((e: Error) => setErr(e.message));
  }, [me?.admin]);

  useEffect(() => load(), [load]);

  // Account-personal things (password, preferences) live on the profile page;
  // this is purely the administrator's view of everyone.
  return (
    <>
      {me?.admin && (
        <>
          <div className="rowhead">
            <h2>Users</h2>
            <span className="reason">{users ? `${users.length} account(s)` : 'loading…'}</span>
          </div>
          {err && <div className="note bad">{err}</div>}
          {users && (
            <table className="list">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Last sign-in</th>
                  <th style={{ textAlign: 'right' }}>&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <UserRow key={u.id} user={u} me={me} onChange={load} say={say} />
                ))}
              </tbody>
            </table>
          )}
          <AddUser onAdded={load} say={say} />
        </>
      )}
    </>
  );
}

function UserRow({
  user,
  me,
  onChange,
  say,
}: {
  user: CrateUser;
  me: Me | null;
  onChange: () => void;
  say: (k: 'good' | 'bad', t: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const isSelf = user.username === me?.user;

  const toggle = async () => {
    setBusy(true);
    try {
      await api.setEnabled(user.id, !user.enabled);
      say('good', `${user.username} ${user.enabled ? 'disabled' : 'enabled'}`);
      onChange();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <tr style={user.enabled ? undefined : { opacity: 0.55 }}>
        <td>
          {user.username}
          {isSelf && <span className="tag" style={{ marginLeft: 8 }}>you</span>}
        </td>
        <td className="muted">{user.name}</td>
        <td>
          {user.admin ? <span className="tag held">admin</span> : <span className="tag">user</span>}
        </td>
        <td className="muted">
          {user.lastLoginAt ? new Date(user.lastLoginAt * 1000).toLocaleString() : 'never'}
        </td>
        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
          <button className="btn sec sm" onClick={() => setInspecting(!inspecting)}>
            {inspecting ? 'Close' : 'Inspect'}
          </button>{' '}
          <button className="btn sec sm" onClick={() => setResetting(!resetting)}>
            Password
          </button>{' '}
          <button className="btn sec sm" disabled={busy} onClick={() => void toggle()}>
            {user.enabled ? 'Disable' : 'Enable'}
          </button>
        </td>
      </tr>
      {inspecting && (
        <tr>
          <td colSpan={5} style={{ paddingTop: 0 }}>
            <UserDataPanel user={user} onPurged={onChange} say={say} />
          </td>
        </tr>
      )}
      {resetting && (
        <tr>
          <td colSpan={5}>
            <PasswordForm
              userId={user.id}
              label={`Set a new password for ${user.username}`}
              onDone={(signedOut) => {
                setResetting(false);
                say(
                  'good',
                  signedOut
                    ? 'Password changed — you have been signed out.'
                    : `Password set for ${user.username}. Their sessions have ended.`,
                );
              }}
              say={say}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Everything one account holds, and the lever that takes it away.
 *
 * The inspect view and the purge live on the same screen on purpose: the
 * decision needs the evidence. The number that matters most is the exclusive
 * figure — what leaves the DISK — because everything else is rows, and rows
 * are recoverable from a backup in a way a family member's feelings about
 * their vanished playlists are not.
 *
 * Purging asks for the username typed back, and the server checks it again:
 * the text box here is UX, the server's comparison is the safety.
 */
function UserDataPanel({
  user,
  onPurged,
  say,
}: {
  user: CrateUser;
  onPurged: () => void;
  say: (k: 'good' | 'bad', t: string) => void;
}) {
  const [d, setD] = useState<Awaited<ReturnType<typeof api.adminUserData>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const [arming, setArming] = useState(false);
  const [purging, setPurging] = useState(false);

  useEffect(() => {
    api.adminUserData(user.id).then(setD).catch((e: Error) => setErr(e.message));
  }, [user.id]);

  if (err) return <div className="note bad">{err}</div>;
  if (!d) return <div className="spinner">Loading…</div>;

  const purge = async () => {
    setPurging(true);
    try {
      const r = await api.purgeUser(user.id, confirm);
      say(
        'good',
        `Purged ${user.username}: ${r.rows.libraryTracks ?? 0} library rows, ` +
          `${r.rows.playlists ?? 0} playlists, ${r.files} files (${bytes(r.freedBytes)}) to trash` +
          (r.skipped.length ? ` — ${r.skipped.length} skipped` : ''),
      );
      setArming(false);
      setConfirm('');
      onPurged();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setPurging(false);
    }
  };

  return (
    <div className="userdata">
      <div className="stats" style={{ marginBottom: 10 }}>
        <div className="stat">
          <div className="n">{d.counts.tracks}</div>
          <div className="l">tracks · {d.counts.albums} albums · {d.counts.artists} artists</div>
        </div>
        <div className="stat">
          <div className="n">{d.exclusive.tracks}</div>
          <div className="l">only they hold · {bytes(d.exclusive.bytes)} would leave the disk</div>
        </div>
        <div className="stat">
          <div className="n">{d.playlists.length}</div>
          <div className="l">playlists</div>
        </div>
        <div className="stat">
          <div className="n">{d.requests}</div>
          <div className="l">requests · {d.imports.items} import rows</div>
        </div>
      </div>

      {d.playlists.length > 0 && (
        <div className="muted sm" style={{ marginBottom: 8 }}>
          Playlists: {d.playlists.map((p) => `${p.name} (${p.tracks})`).join(' · ')}
        </div>
      )}

      {d.albums.length > 0 && (
        <details>
          <summary className="muted sm" style={{ cursor: 'pointer' }}>
            Their library — {d.albums.length} album{d.albums.length === 1 ? '' : 's'}
          </summary>
          <table className="list" style={{ marginTop: 6 }}>
            <tbody>
              {d.albums.map((a) => (
                <tr key={`${a.artistName}|${a.albumTitle}`}>
                  <td>{a.albumTitle}</td>
                  <td className="muted">{a.artistName}</td>
                  <td className="muted">{a.tracks} tracks</td>
                  <td className="muted">{a.plays} plays</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {user.admin ? (
        <div className="muted sm" style={{ marginTop: 10 }}>
          Admins cannot be purged. Remove admin first — deliberately two steps.
        </div>
      ) : !arming ? (
        <div style={{ marginTop: 10 }}>
          <button className="btn sec sm" onClick={() => setArming(true)}>
            Purge this user’s data…
          </button>
        </div>
      ) : (
        <div className="note bad" style={{ marginTop: 10 }}>
          This clears their library, playlists, plays, imports and requests, and moves{' '}
          <b>{d.exclusive.tracks} file{d.exclusive.tracks === 1 ? '' : 's'} ({bytes(d.exclusive.bytes)})</b>{' '}
          that only they hold to the trash. Shared music stays. The account survives, empty.
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input
              type="text"
              placeholder={`Type “${user.username}” to confirm`}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            <button
              className="btn sm"
              disabled={purging || confirm !== user.username}
              onClick={() => void purge()}
            >
              {purging ? 'Purging…' : 'Purge'}
            </button>
            <button className="btn sec sm" onClick={() => { setArming(false); setConfirm(''); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Minimum length matches the rest of the estate rather than inventing its own. */
const MIN_PASSWORD = 10;

function PasswordForm({
  userId,
  label,
  onDone,
  say,
}: {
  userId: number | null;
  label: string;
  onDone: (signedOut: boolean) => void;
  say: (k: 'good' | 'bad', t: string) => void;
}) {
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);

  if (userId === null) {
    return <div className="note">This session is an API client, not a user account.</div>;
  }

  const tooShort = pw.length > 0 && pw.length < MIN_PASSWORD;
  const mismatch = again.length > 0 && pw !== again;
  const ok = pw.length >= MIN_PASSWORD && pw === again;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.setPassword(userId, pw);
      setPw('');
      setAgain('');
      onDone(r.signedOut);
    } catch (x) {
      say('bad', (x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="pwform" onSubmit={(e) => void submit(e)}>
      <div className="muted" style={{ fontSize: '0.82rem', marginBottom: 8 }}>
        {label} · at least {MIN_PASSWORD} characters
      </div>
      <div className="bar">
        <input
          type="password"
          placeholder="New password"
          autoComplete="new-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        <input
          type="password"
          placeholder="Repeat it"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
        />
        <button className="btn sm" disabled={busy || !ok}>
          {busy ? 'Saving…' : 'Set password'}
        </button>
      </div>
      {tooShort && <div className="muted" style={{ fontSize: '0.8rem' }}>Too short.</div>}
      {mismatch && <div className="muted" style={{ fontSize: '0.8rem' }}>They do not match.</div>}
    </form>
  );
}

function AddUser({
  onAdded,
  say,
}: {
  onAdded: () => void;
  say: (k: 'good' | 'bad', t: string) => void;
}) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [pw, setPw] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);

  const ok = /^[a-z0-9._-]{2,32}$/.test(username) && pw.length >= MIN_PASSWORD;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.addUser({ username, password: pw, displayName: displayName || username, isAdmin });
      say('good', `Added ${username}`);
      setUsername('');
      setDisplayName('');
      setPw('');
      setIsAdmin(false);
      onAdded();
    } catch (x) {
      say('bad', (x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="rowhead">
        <h2>Add a user</h2>
        <span className="reason">they can request music straight away</span>
      </div>
      <form className="pwform" onSubmit={(e) => void submit(e)}>
        <div className="bar">
          <input
            placeholder="username"
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
          />
          <input
            placeholder="display name (optional)"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <input
            type="password"
            placeholder="password"
            autoComplete="new-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
          <label className="chk">
            <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
            admin
          </label>
          <button className="btn sm" disabled={busy || !ok}>
            {busy ? 'Adding…' : 'Add user'}
          </button>
        </div>
        <div className="muted" style={{ fontSize: '0.8rem' }}>
          Lower case letters, numbers, dot, underscore or hyphen · password at least{' '}
          {MIN_PASSWORD} characters
        </div>
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function RequestsView({
  say,
  admin = false,
}: {
  say: (k: 'good' | 'bad', t: string) => void;
  /** Admins get an extra chip to see everyone; the server ignores it from anyone else. */
  admin?: boolean;
}) {
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /**
   * Which requests to show. Asked-for by default: a library import creates one
   * album request per missing album, which on a big export outnumbers a
   * person's own by a hundred to one and makes this page useless for the thing
   * it is for — watching what you asked for arrive.
   */
  const [source, setSource] = useState<'user' | 'import' | undefined>('user');
  /** Only what did not succeed: failed, or queued with an error against it. */
  const [trouble, setTrouble] = useState(false);
  const [everyone, setEveryone] = useState(false);
  const [retrying, setRetrying] = useState<number | null>(null);
  const [choosing, setChoosing] = useState<RequestRow | null>(null);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  /** Bumped to re-run the loader after a clear, since it keys on the filters. */
  const [reloadKey, setReloadKey] = useState(0);

  /**
   * Refresh while anything is still in flight.
   *
   * A download percentage that only updates on a manual reload is no better than
   * the silent 'queued' it replaced, so this polls for as long as there is
   * something to watch and stops as soon as there is not.
   */
  useEffect(() => {
    let live = true;
    let timer: number | undefined;

    const load = () => {
      api
        .requests({ source, trouble, all: admin && everyone })
        .then((r) => {
          if (!live) return;
          setRows(r.requests);
          if (r.requests.some((x) => x.status === 'queued')) {
            timer = window.setTimeout(load, 5000);
          }
        })
        .catch((e: Error) => {
          if (live) setErr(e.message);
        });
    };

    load();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [source, trouble, everyone, admin, reloadKey]);

  const clearFailed = async () => {
    setClearing(true);
    try {
      const r = await api.clearFailedRequests(admin && everyone);
      say(
        'good',
        r.removed
          ? `Cleared ${r.removed} failed request${r.removed === 1 ? '' : 's'}.`
          : 'Nothing to clear.',
      );
      setConfirmClear(false);
      setRows(null);
      setReloadKey((k) => k + 1);
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setClearing(false);
    }
  };

  /**
   * Only rows that actually FAILED can be cleared, which is a narrower set than the
   * "Didn't succeed" filter shows — that also lists queued downloads carrying an error,
   * and those are still running.
   */
  const failedCount = (rows ?? []).filter((r) => r.status === 'failed').length;

  const filter = (
    <div className="chips" style={{ margin: '0 0 12px' }}>
      {(
        [
          ['user', 'My requests'],
          ['import', 'From imports'],
          [undefined, 'Everything'],
        ] as [typeof source, string][]
      ).map(([v, label]) => (
        <button
          key={label}
          className={`chip${source === v ? ' on' : ''}`}
          onClick={() => {
            setRows(null);
            setSource(v);
          }}
        >
          {label}
        </button>
      ))}
      {/* Separate from the source chips because it is a different question:
          those pick whose requests, this picks how they went. */}
      <span className="chipsplit" />
      <button
        className={`chip${trouble ? ' on' : ''}`}
        onClick={() => {
          setRows(null);
          setTrouble((t) => !t);
        }}
      >
        Didn’t succeed
      </button>
      {admin && (
        <button
          className={`chip${everyone ? ' on' : ''}`}
          onClick={() => {
            setRows(null);
            setEveryone((v) => !v);
          }}
        >
          Everyone’s
        </button>
      )}
    </div>
  );

  if (err) return <div className="note bad">{err}</div>;
  if (!rows) return (
    <>
      {filter}
      <div className="spinner">Loading…</div>
    </>
  );
  if (!rows.length) {
    return (
      <>
        {filter}
        <div className="empty">
          {trouble
            ? 'Nothing here failed — everything either arrived or is still going.'
            : source === 'user'
              ? 'You have not requested anything directly yet.'
              : source === 'import'
                ? 'No import has queued a download.'
                : 'No requests yet.'}
        </div>
      </>
    );
  }

  return (
    <>
      {filter}
      <div className="rowhead">
        <h2>Requests</h2>
        <span className="reason">{rows.length} shown</span>
        <div className="spacer" />
        {failedCount > 0 &&
          (confirmClear ? (
            <>
              <button className="btn sm" disabled={clearing} onClick={() => void clearFailed()}>
                {clearing ? 'Clearing…' : `Really clear ${failedCount}`}
              </button>{' '}
              <button className="btn sec sm" onClick={() => setConfirmClear(false)}>
                Keep
              </button>
            </>
          ) : (
            <button
              className="btn sec sm"
              onClick={() => setConfirmClear(true)}
              title="Deletes the failed rows. Anything still downloading is left alone."
            >
              Clear {failedCount} failed
            </button>
          ))}
      </div>
      <table className="list">
        <thead>
          <tr>
            <th>What</th>
            <th>Kind</th>
            <th>Albums</th>
            <th>Who</th>
            <th>When</th>
            <th>Status</th>
            <th>&nbsp;</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Fragment key={r.id}>
              <tr>
                <td>{r.asked_for || r.title}</td>
                <td className="muted">{r.kind}</td>
                <td className="muted">{r.album_count}</td>
                <td className="muted">{r.requested_by}</td>
                <td className="muted">{new Date(r.requested_at * 1000).toLocaleString()}</td>
                <td>
                  {/* Status and reason on one line, reading as a sentence. The
                      reason used to sit on a row of its own spanning the table,
                      which broke the eye's path from the status that prompted
                      it. A stuck request still says so rather than rendering a
                      healthy-looking 'queued' with the cause hidden away. */}
                  <span className="reqstatus">
                    {/*
                      * Four states, four colours: queued is BLUE (in progress), fulfilled green
                      * (done), stuck amber, failed neutral. Queued and fulfilled both used to be
                      * green, which made a page of requests read as finished at a glance when
                      * half of it was still downloading.
                      */}
                    <span
                      className={`tag ${
                        r.status === 'failed'
                          ? ''
                          : r.error
                            ? 'req'
                            : r.status === 'queued'
                              ? 'queued'
                              : 'held'
                      }`}
                    >
                      {r.status === 'queued' && (r.progress ?? 0) > 0 && (r.progress ?? 0) < 100
                        ? `${r.progress}%`
                        : r.status}
                      {r.error ? ' · stuck' : ''}
                    </span>
                    {(r.error || (r.status === 'queued' && r.note)) && (
                      <span className={r.error ? 'reqerr' : 'reqnote'} title={r.error || r.note || ''}>
                        {r.error || r.note}
                      </span>
                    )}
                  </span>
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {/* Choosing by hand beats another automatic attempt when the
                      scorer has already been wrong: comments and grab counts say
                      things crate cannot see. */}
                  <button
                    className="btn sec sm"
                    title="See every release and pick one"
                    onClick={() => setChoosing(r)}
                  >
                    Releases
                  </button>{' '}
                  {r.status !== 'queued' && (
                    <button
                      className="btn sec sm"
                      disabled={retrying === r.id}
                      title="Search again from scratch"
                      onClick={() => {
                        setRetrying(r.id);
                        void api
                          .retryRequest(r.id)
                          .then(() => {
                            say('good', `Retrying ${r.asked_for || r.title}`);
                            setRows((cur) =>
                              (cur ?? []).map((x) =>
                                x.id === r.id
                                  ? { ...x, status: 'queued', error: null, progress: 0 }
                                  : x,
                              ),
                            );
                          })
                          .catch((e: Error) => say('bad', e.message))
                          .finally(() => setRetrying(null));
                      }}
                    >
                      {retrying === r.id ? '…' : 'Retry'}
                    </button>
                  )}
                </td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
      {choosing && (
        <ReleasePicker
          request={choosing}
          say={say}
          onClose={() => setChoosing(null)}
          onGrabbed={() => {
            setChoosing(null);
            setRows(null);
            setSource(source);
          }}
        />
      )}
    </>
  );
}

/**
 * Interactive search: every release an indexer has, and the operator decides.
 *
 * Automatic scoring gets it right most of the time and wrong in a way it cannot
 * detect — three attempts on Appetite for Destruction all landed on obfuscated
 * reposts of one broken upload, while the release with five thousand grabs and a
 * comment thread vouching for it sat unseen. So the whole list is shown, crate's
 * pick first, with the things a person judges by: how many people took it, how
 * big it is, how old, and a link to the comments.
 */
function ReleasePicker({
  request,
  say,
  onClose,
  onGrabbed,
}: {
  request: RequestRow;
  say: (k: 'good' | 'bad', t: string) => void;
  onClose: () => void;
  onGrabbed: () => void;
}) {
  const [data, setData] = useState<{
    artist: string;
    album: string;
    query: string;
    releases: Release[];
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  /** What is in the box. Empty means "whatever crate worked out", the default. */
  const [typed, setTyped] = useState('');
  /** The query actually searched; changing it is what re-runs the effect. */
  const [asked, setAsked] = useState('');
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let live = true;
    setSearching(true);
    setErr(null);
    api
      .releases(request.id, asked || undefined)
      .then((d) => {
        if (live) setData(d);
      })
      .catch((e: Error) => {
        if (live) setErr(e.message);
      })
      .finally(() => {
        if (live) setSearching(false);
      });
    return () => {
      live = false;
    };
  }, [request.id, asked]);

  const grab = (r: Release) => {
    setBusy(r.downloadUrl);
    void api
      .grabRelease(request.id, { downloadUrl: r.downloadUrl, title: r.title, protocol: r.protocol })
      .then((res) => {
        say('good', `Downloading ${r.title.slice(0, 40)} via ${res.via}`);
        onGrabbed();
      })
      .catch((e: Error) => say('bad', e.message))
      .finally(() => setBusy(null));
  };

  const all = data?.releases ?? [];
  // Crate's rejects are hidden by default: the list is long and they lost for
  // reasons that are usually right.
  const shown = showAll ? all : all.filter((r) => r.score !== null);

  /** Enter or the button; two characters is the server's own floor. */
  const runSearch = () => {
    const q = typed.trim();
    if (q.length === 1) return;
    setData(null);
    setShowAll(false);
    setAsked(q);
  };

  return (
    <Modal title={`Releases for ${request.asked_for || request.title}`} onClose={onClose}>
      {/* Type the right words yourself.

          Crate picks which album a requested song lives on, and when it picks
          wrong the search looks for a record nobody has — the failure that sent
          "The Real Slim Shady" to a promo snippet tape. The resolver is fixed for
          those cases, but ambiguous metadata never stops being ambiguous, and the
          words are the one thing a person always has. Empty box means the album
          crate worked out, so the default costs nothing. */}
      <div className="relsearch">
        <input
          value={typed}
          placeholder={data ? `${data.artist} ${data.album}`.trim() : 'artist and album'}
          aria-label="Search releases yourself"
          onChange={(e) => setTyped(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              runSearch();
            }
          }}
        />
        <button className="btn sec sm" disabled={searching} onClick={runSearch}>
          {searching ? '…' : 'Search'}
        </button>
        {asked && (
          <button
            className="btn sec sm"
            disabled={searching}
            title="Go back to the album crate resolved"
            onClick={() => {
              setTyped('');
              setData(null);
              setShowAll(false);
              setAsked('');
            }}
          >
            Clear
          </button>
        )}
      </div>
      {err && <div className="note bad">{err}</div>}
      {!data && !err && <div className="spinner">Asking every indexer…</div>}
      {data && (
        <>
          <div className="muted" style={{ marginBottom: 10, fontSize: '0.84rem' }}>
            {data.query ? (
              <>
                Searched your words: <b>{data.query}</b>
              </>
            ) : (
              <>
                Searched <b>{data.artist}</b> — <b>{data.album}</b>
              </>
            )}{' '}
            · {all.length} release
            {all.length === 1 ? '' : 's'} · {all.filter((r) => r.score !== null).length} passed
            crate's checks
            {all.length > shown.length && (
              <>
                {' · '}
                <button className="btn sec sm" onClick={() => setShowAll(true)}>
                  show the {all.length - shown.length} it rejected
                </button>
              </>
            )}
          </div>

          <div className="rellist">
            {shown.map((r) => (
              <div key={r.downloadUrl} className={`relrow${r.score === null ? ' rejected' : ''}`}>
                <div className="words">
                  <div className="t">{r.title}</div>
                  <div className="s muted">
                    {r.sizeMb} MB · {r.grabs > 0 ? `${r.grabs.toLocaleString()} grabs` : 'no grabs'}
                    {r.protocol === 'torrent' ? ` · ${r.seeders} seeders` : ''}
                    {r.files > 0 ? ` · ${r.files} files` : ''}
                    {r.ageDays > 0 ? ` · ${r.ageDays}d old` : ''} · {r.indexer}
                    {r.score !== null ? ` · score ${r.score}` : ' · filtered out'}
                  </div>
                  {r.reasons.length > 0 && <div className="s why">{r.reasons.join(' · ')}</div>}
                </div>
                <div className="acts">
                  {r.infoUrl && (
                    <a
                      className="btn sec sm"
                      href={r.infoUrl}
                      target="_blank"
                      rel="noreferrer"
                      title="Comments and details at the indexer"
                    >
                      Comments
                    </a>
                  )}
                  <button
                    className="btn sm"
                    disabled={busy !== null}
                    onClick={() => grab(r)}
                  >
                    {busy === r.downloadUrl ? '…' : 'Get this'}
                  </button>
                </div>
              </div>
            ))}
            {!shown.length && <div className="muted">No releases found.</div>}
          </div>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/**
 * The admin section: a vertical nav on the left, one pane on the right.
 *
 * The nav items are real links to /admin/<page>, so each pane is bookmarkable and
 * Back moves between them — the same reason the rest of the app stopped using
 * component state for navigation.
 *
 * Rendered only for admins, and the API enforces that independently. The client
 * check decides what to draw; it is not the control.
 */
function AdminView({
  page,
  me,
  say,
  onSignedOut,
}: {
  page: AdminPage;
  me: Me | null;
  say: (k: 'good' | 'bad', t: string) => void;
  onSignedOut: () => void;
}) {
  if (!me?.admin) {
    return <div className="note bad">This section is for administrators.</div>;
  }

  const items: { page: AdminPage; label: string; hint: string }[] = [
    { page: 'statistics', label: 'Statistics', hint: 'library, disk, users' },
    { page: 'library', label: 'Library', hint: 'albums, tracks, deletion' },
    { page: 'users', label: 'Users', hint: 'accounts and passwords' },
    { page: 'downloading', label: 'Downloading', hint: 'client, indexer, criteria' },
    { page: 'adopt', label: 'Adopt', hint: 'downloads crate does not know' },
    { page: 'lastfm', label: 'Integrations', hint: 'Last.fm, MusicBrainz, AcoustID' },
    { page: 'imports', label: 'Imports', hint: "everyone's library imports" },
    { page: 'plugins', label: 'Plugins', hint: 'switch features on and off' },
    { page: 'webhooks', label: 'Webhooks', hint: 'Pushover and REST' },
  ];

  return (
    <div className="admin">
      <nav className="adminnav">
        {items.map((it) => (
          <Link
            key={it.page}
            to={{ name: 'admin', page: it.page }}
            className={`adminlink${page === it.page ? ' on' : ''}`}
          >
            <span className="l">{it.label}</span>
            <span className="h">{it.hint}</span>
          </Link>
        ))}
      </nav>
      <section className="adminpane">
        {page === 'statistics' && <StatsPane />}
        {page === 'users' && <UsersView me={me} say={say} onSignedOut={onSignedOut} />}
        {page === 'imports' && <AdminImports />}
        {page === 'downloading' && <DownloadingPane say={say} />}
        {page === 'adopt' && <AdoptPane say={say} />}
        {page === 'lastfm' && <LastfmPane say={say} />}
        {page === 'library' && <LibraryPane say={say} />}
        {page === 'plugins' && <AdminPlugins say={say} />}
        {page === 'webhooks' && <WebhooksPane say={say} />}
      </section>
    </div>
  );
}

/**
 * The plugin switchboard: what is installed, what the repository offers, and the switches.
 *
 * Three ideas on one page, in the order an admin needs them. INSTALLED is the ground truth of
 * this instance — compiled-in plugins (switchable, not removable) and downloaded ones
 * (switchable, updatable, removable). THE REPOSITORY is where more come from: a GitHub repo of
 * pre-built artifacts, private ones reachable with a token that is stored server-side and never
 * shown again. And RESTART, because a downloaded server half only boards at boot — under
 * compose, an orderly exit is a restart, so the button completes the story the install starts.
 */
function AdminPlugins({ say }: { say: (k: 'good' | 'bad', t: string) => void }) {
  const [board, setBoard] = useState<PluginSwitchboard | null>(null);
  const [available, setAvailable] = useState<AvailablePlugin[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [repoField, setRepoField] = useState('');
  const [tokenField, setTokenField] = useState('');
  const [restarting, setRestarting] = useState(false);
  const uiPlugins = useUiPlugins();

  const load = useCallback(() => {
    api
      .adminPlugins()
      .then((b) => {
        setBoard(b);
        setRepoField(b.repo.repo);
      })
      .catch((e: Error) => say('bad', e.message));
  }, [say]);
  useEffect(load, [load]);

  const checkRepo = () => {
    setChecking(true);
    api
      .adminPluginsAvailable()
      .then((r) => setAvailable(r.available))
      .catch((e: Error) => say('bad', e.message))
      .finally(() => setChecking(false));
  };

  const saveSource = () => {
    void api
      .setPluginSource(repoField.trim(), tokenField ? tokenField : undefined)
      .then(() => {
        setTokenField('');
        say('good', 'Plugin repository saved');
        load();
      })
      .catch((e: Error) => say('bad', e.message));
  };

  const install = (id: string) => {
    setBusy(id);
    void api
      .installPlugin(id)
      .then((r) => {
        say('good', `${id} ${r.needsRestart ? 'installed — restart to activate' : 'installed'}`);
        load();
        checkRepo();
      })
      .catch((e: Error) => say('bad', e.message))
      .finally(() => setBusy(null));
  };

  const uninstall = (id: string) => {
    setBusy(id);
    void api
      .uninstallPlugin(id)
      .then((r) => {
        say('good', `${id} uninstalled${r.needsRestart ? ' — restart to finish' : ''} — its data is kept`);
        load();
        setAvailable(null);
      })
      .catch((e: Error) => say('bad', e.message))
      .finally(() => setBusy(null));
  };

  const toggle = (id: string, enabled: boolean) => {
    setBusy(id);
    void api
      .setPluginEnabled(id, enabled)
      .then((b) => {
        setBoard(b);
        setDisabledPlugins(b.installed.filter((pl) => !pl.enabled).map((pl) => pl.id));
        say('good', `${id} switched ${enabled ? 'on' : 'off'}`);
      })
      .catch((e: Error) => say('bad', e.message))
      .finally(() => setBusy(null));
  };

  /**
   * Restart, then wait for the app to answer again and reload the page — the reload is what
   * picks up newly active plugins (their bundles are listed per session).
   */
  const restart = () => {
    setRestarting(true);
    void api
      .restartCrate()
      .then(async () => {
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          try {
            const res = await fetch('/api/health');
            if (res.ok) {
              window.location.reload();
              return;
            }
          } catch {
            /* still coming back */
          }
        }
        setRestarting(false);
        say('bad', 'crate did not come back — check the container');
      })
      .catch((e: Error) => {
        setRestarting(false);
        say('bad', e.message);
      });
  };

  if (!board) return <div className="spinner">Loading…</div>;

  /** What the UI half of a loaded plugin claims, from the live registry. */
  const slotsOf = (id: string) => {
    const ui = uiPlugins.find((pl) => pl.id === id);
    const slots = [ui?.playbar && 'player panel', ui?.profile && 'profile page'].filter(Boolean).join(', ');
    return slots;
  };

  return (
    <>
      {(board.needsRestart || restarting) && (
        <div className="note restartnote">
          {restarting ? (
            <span>Restarting — this page will reload itself…</span>
          ) : (
            <>
              <span>A change is waiting for a restart.</span>
              <button className="btn sm" onClick={restart}>
                Restart crate
              </button>
            </>
          )}
        </div>
      )}

      <h3 className="plsection">Installed</h3>
      <div className="pluginrows">
        {board.installed.map((pl) => (
          <div key={pl.id} className="pluginrow">
            <div className="words">
              <span className="t">
                {pl.name}
                {pl.version ? <span className="muted"> v{pl.version}</span> : null}
              </span>
              <span className="s muted">
                {pl.id} · {pl.source === 'builtin' ? 'built in' : pl.source === 'removed' ? 'uninstalled, active until restart' : slotsOf(pl.id) || 'installed'}
                {pl.needsRestart && pl.source !== 'removed' ? ' · waiting for restart' : ''}
              </span>
            </div>
            <span className={`pillstate${pl.enabled ? ' on' : ''}`}>{pl.enabled ? 'On' : 'Off'}</span>
            <button
              className="btn sec sm"
              disabled={busy === pl.id}
              onClick={() => toggle(pl.id, !pl.enabled)}
            >
              {pl.enabled ? 'Switch off' : 'Switch on'}
            </button>
            {pl.source === 'installed' && (
              <button className="btn sec sm" disabled={busy === pl.id} onClick={() => uninstall(pl.id)}>
                Uninstall
              </button>
            )}
          </div>
        ))}
        {board.installed.length === 0 && <p className="muted">Nothing installed yet.</p>}
      </div>

      <h3 className="plsection">Repository</h3>
      <p className="muted sm">
        A GitHub repository of pre-built plugins (like MattLarritt/crate-plugins). Private repos
        need a personal access token with read access to the repository contents — it is stored
        on the server and never shown again.
      </p>
      <div className="plsource">
        <input
          type="text"
          placeholder="owner/repository"
          value={repoField}
          onChange={(e) => setRepoField(e.target.value)}
        />
        <input
          type="password"
          placeholder={board.repo.token.set ? `token set (${board.repo.token.hint}) — paste to replace` : 'token (for private repos)'}
          value={tokenField}
          autoComplete="new-password"
          onChange={(e) => setTokenField(e.target.value)}
        />
        <button className="btn sm" onClick={saveSource}>
          Save
        </button>
        <button className="btn sec sm" disabled={!board.repo.repo || checking} onClick={checkRepo}>
          {checking ? 'Checking…' : 'Check the repository'}
        </button>
      </div>

      {available && (
        <>
          <h3 className="plsection">Available</h3>
          <div className="pluginrows">
            {available.map((pl) => {
              const update = pl.installed && pl.installedVersion && pl.installedVersion !== pl.version;
              return (
                <div key={pl.id} className="pluginrow">
                  <div className="words">
                    <span className="t">
                      {pl.name} <span className="muted">v{pl.version}</span>
                    </span>
                    <span className="s muted">{pl.description}</span>
                  </div>
                  {pl.builtin ? (
                    <span className="muted sm">built in</span>
                  ) : update ? (
                    <button className="btn sm" disabled={busy === pl.id} onClick={() => install(pl.id)}>
                      Update to v{pl.version}
                    </button>
                  ) : pl.installed ? (
                    <span className="muted sm">installed</span>
                  ) : (
                    <button className="btn sm" disabled={busy === pl.id} onClick={() => install(pl.id)}>
                      Install
                    </button>
                  )}
                </div>
              );
            })}
            {available.length === 0 && <p className="muted">The repository offers no plugins.</p>}
          </div>
        </>
      )}
    </>
  );
}

/** Bytes as something a human reads at a glance. */
function bytes(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function StatsPane() {
  const [s, setS] = useState<AdminStats | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.adminStats().then(setS).catch((e: Error) => setErr(e.message));
  }, []);

  if (err) return <div className="note bad">{err}</div>;
  if (!s) return <div className="spinner">Counting…</div>;

  const pct = s.disk ? Math.round((s.disk.usedBytes / s.disk.totalBytes) * 100) : 0;

  return (
    <>
      <div className="rowhead">
        <h2>Statistics</h2>
        <span className="reason">{s.musicRoot}</span>
      </div>

      <div className="stats">
        <div className="stat">
          <div className="n">{s.tracks.toLocaleString()}</div>
          <div className="k">tracks</div>
        </div>
        <div className="stat">
          <div className="n">{s.albums.toLocaleString()}</div>
          <div className="k">albums</div>
        </div>
        <div className="stat">
          <div className="n">{s.artists.toLocaleString()}</div>
          <div className="k">artists</div>
        </div>
        <div className="stat">
          <div className="n">{s.users.total}</div>
          <div className="k">users · {s.users.admins} admin</div>
        </div>
        <div className="stat">
          {/* Counted from crate's own playlists table, so it is always a real number. The
              honest rendering; a 0 here would be a dashboard telling a small lie. */}
          <div className="n">{s.playlists === null ? '—' : s.playlists}</div>
          <div className="k">
            playlists
          </div>
        </div>
        <div className="stat">
          <div className="n">{s.requests.total}</div>
          <div className="k">
            requests · {s.requests.fulfilled} done
            {s.requests.failed > 0 ? `, ${s.requests.failed} failed` : ''}
          </div>
        </div>
      </div>

      <div className="rowhead">
        <h3>Disk</h3>
      </div>
      {s.disk ? (
        <>
          <div className="diskbar">
            <div className="fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="muted sm">
            {bytes(s.disk.usedBytes)} used of {bytes(s.disk.totalBytes)} · {bytes(s.disk.freeBytes)}{' '}
            free ({pct}%)
          </div>
        </>
      ) : (
        <div className="note bad">
          Could not read {s.musicRoot} — the share may not be mounted. Downloads will fail to
          import until it is.
        </div>
      )}

      <div className="rowhead">
        <h3>Artwork cache</h3>
        <span className="reason">
          {s.artRetentionDays === 0
            ? 'kept indefinitely'
            : `unused art reclaimed after ${s.artRetentionDays} days`}
        </span>
      </div>
      <div className="stats">
        <div className="stat">
          <div className="n">{s.artCache.entries}</div>
          <div className="k">images cached</div>
        </div>
        <div className="stat">
          <div className="n">{bytes(s.artCache.onDiskBytes)}</div>
          <div className="k">on disk</div>
        </div>
        <div className="stat">
          <div className="n">{s.artCache.pinned}</div>
          <div className="k">pinned · never deleted</div>
        </div>
      </div>
      <div className="muted sm">
        Art is fetched from a remote source once and served locally after that. Anything
        belonging to music on disk is pinned and survives regardless of the retention setting —
        only art for things browsed past and never returned to is reclaimed.
      </div>

      {s.topArtists.length > 0 && (
        <>
          <div className="rowhead">
            <h3>Biggest artists</h3>
          </div>
          <table className="list">
            <thead>
              <tr>
                <th>Artist</th>
                <th>Albums</th>
                <th>Tracks</th>
              </tr>
            </thead>
            <tbody>
              {s.topArtists.map((a) => (
                <tr key={a.name}>
                  <td>{a.name}</td>
                  <td className="muted">{a.albums}</td>
                  <td className="muted">{a.trackFiles}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

/**
 * A secret field.
 *
 * The current value is never sent to the browser, so the input starts empty and
 * shows a hint of what is stored. Leaving it blank on save means "keep what you
 * have" — the server enforces that too, so a form saved without retyping every key
 * cannot wipe the credentials the pipeline runs on.
 */
/**
 * The library sweep: analyse everything with no current profile.
 *
 * Separate from the enable toggle on purpose. Switching Song characteristics on covers music
 * added from that moment; the existing library is a bill somebody has to choose to pay, so it
 * says how many tracks it is about to work through and waits to be asked.
 *
 * Progress is polled rather than pushed: the worker is a background trickle, so there is no
 * request to hold open, and a slow count is what an honest display of that looks like.
 */
/**
 * Page warming: how many artist and album pages are ready, and the buttons to build the rest.
 *
 * Worth showing at all because the cost is invisible otherwise — an artist page that has never
 * been opened takes seconds on MusicBrainz's one-request-per-second limit, and this is the only
 * place that says whether that debt has been paid.
 */
function PageWarmPanel({ say }: { say: (k: 'good' | 'bad', t: string) => void }) {
  const [p, setP] = useState<WarmProgress | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void api
      .warmProgress()
      .then(setP)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    // While a sweep runs this is the only feedback there is, so poll like the analyser panel.
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  if (!p) return null;
  /*
   * Defaulted rather than read straight off the response: a client left open across a deploy
   * polls a server whose payload shape has moved, and reading p.mirror.configured on a payload
   * without `mirror` threw and blanked this whole panel behind its error boundary. Caught
   * exactly that way, by a stale poll, while testing something else.
   */
  const mirror = p.mirror ?? { configured: false, live: false, downForS: 0, fails: 0 };
  const total = p.artists.total + p.albums.total;
  const warm = p.artists.warm + p.albums.warm;
  const pending = p.artists.pending + p.albums.pending;
  const failed = p.artists.failed + p.albums.failed;

  const sweep = (all: boolean) => {
    setBusy(true);
    void api
      .warmSweep(all)
      .then((r) => {
        say(
          'good',
          r.queued
            ? `Queued ${r.queued} page${r.queued === 1 ? '' : 's'} to warm`
            : 'Every page is already warm',
        );
        load();
      })
      .catch((e: Error) => say('bad', e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="charsweep">
      <div className="statline">
        <span>
          <b>{warm}</b> of <b>{total}</b> pages ready
        </span>
        <span>
          <b>{p.artists.warm}</b>/{p.artists.total} artists
        </span>
        <span>
          <b>{p.albums.warm}</b>/{p.albums.total} albums
        </span>
        {pending > 0 && (
          <span>
            <b>{pending}</b> queued
          </span>
        )}
        {failed > 0 && (
          <span className="bad" title="Usually MusicBrainz being unreachable, not a missing artist">
            <b>{failed}</b> failed
          </span>
        )}
      </div>
      {/*
        * The mirror line. Said here rather than only next to its URL field because this is
        * where its absence is measurable: a mirror answers instantly and unqueued, the public
        * API answers once a second, and that difference IS the slow first visit to an artist.
        */}
      {mirror.configured && !mirror.live && (
        <div className="note bad">
          Your MusicBrainz mirror is not answering, so crate is using the public API — one
          request a second, which is what makes an uncached page slow. Retrying in{' '}
          {mirror.downForS}s (failed {mirror.fails}×). Check the mirror is running, then
          Test it above.
        </div>
      )}
      {mirror.configured && mirror.live && (
        <div className="note">Using your MusicBrainz mirror — no rate limit, so this is fast.</div>
      )}
      {!mirror.configured && (
        <div className="note">
          No MusicBrainz mirror configured, so warming runs at the public API&rsquo;s one request
          a second. A mirror makes it near-instant.
        </div>
      )}
      {p.current ? (
        <div className="note">Warming {p.current}…</div>
      ) : (
        pending > 0 && <div className="note">Waiting for the next slot…</div>
      )}
      <div className="isstartrow">
        <button
          className="btn sec"
          disabled={busy || !p.enabled || (!pending && warm === total && !failed)}
          title={
            !p.enabled
              ? 'Switch page warming on first'
              : warm === total && !failed
                ? 'Every page is already warm'
                : undefined
          }
          onClick={() => sweep(false)}
        >
          {busy ? 'Queueing…' : 'Warm what is missing'}
        </button>
        <button
          className="btn sec"
          disabled={busy || !p.enabled}
          title="Re-fetch every page, including ones already warm"
          onClick={() => sweep(true)}
        >
          Rebuild everything
        </button>
      </div>
    </div>
  );
}

function CharacteristicSweep({ say }: { say: (k: 'good' | 'bad', t: string) => void }) {
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void api
      .characteristicProgress()
      .then((r) => setProgress(r.progress))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  if (!progress) return null;
  const c = progress.counts;
  const outstanding = c.notAnalysed + c.pending + c.analysing + progress.stale;

  const sweep = () => {
    setBusy(true);
    void api
      .analyseCharacteristics({ scope: 'library' })
      .then((r) => {
        say(
          'good',
          r.queued
            ? `Queued ${r.queued} track${r.queued === 1 ? '' : 's'}${r.skipped ? `, skipped ${r.skipped} already done` : ''}`
            : 'Everything is already analysed',
        );
        load();
      })
      .catch((e: Error) => say('bad', e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="charsweep">
      <div className="statline">
        <span>
          <b>{c.analysed}</b> analysed
        </span>
        <span>
          <b>{c.pending + c.analysing}</b> queued
        </span>
        <span>
          <b>{c.notAnalysed}</b> never analysed
        </span>
        {progress.stale > 0 && (
          <span title={`Analysed by an older classifier than ${progress.version}`}>
            <b>{progress.stale}</b> stale
          </span>
        )}
        {c.failed > 0 && (
          <span className="bad">
            <b>{c.failed}</b> failed
          </span>
        )}
      </div>
      {progress.enabled && !progress.ready && (
        <div className="note bad">
          Song characteristics is on but there is no OpenAI key, so nothing will be analysed.
        </div>
      )}
      <button
        className="btn sec"
        disabled={busy || !progress.enabled || !outstanding}
        title={
          !progress.enabled
            ? 'Switch Song characteristics on first'
            : !outstanding
              ? 'Every track already has a current profile'
              : undefined
        }
        onClick={sweep}
      >
        {busy
          ? 'Queueing…'
          : outstanding
            ? `Analyse ${outstanding} remaining track${outstanding === 1 ? '' : 's'}`
            : 'Nothing left to analyse'}
      </button>
      <div className="note">
        Ten tracks per request, one request every eight seconds, in the background — roughly
        4,500 tracks an hour. Safe to leave running, safe to restart, and safe to press twice:
        anything already analysed at {progress.version} is skipped. Each track receives{' '}
        {progress.characteristics} scores.
      </div>
    </div>
  );
}

function SecretField({
  label,
  hint,
  isSet,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  isSet: boolean;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="field">
      <span>
        {label}{' '}
        <em className="muted">
          {isSet ? `stored, ending ${hint} — leave blank to keep` : 'not set'}
        </em>
      </span>
      <input
        type="password"
        autoComplete="new-password"
        placeholder={isSet ? '••••••••' : 'paste key'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function TestButton({
  what,
  say,
}: {
  what: 'sab' | 'prowlarr' | 'lastfm' | 'qbit' | 'mbmirror' | 'acoustid' | 'openai';
  say: (k: 'good' | 'bad', t: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.testConnection(what);
      setResult(r);
      say(r.ok ? 'good' : 'bad', r.detail);
    } catch (e) {
      const detail = (e as Error).message;
      setResult({ ok: false, detail });
      say('bad', detail);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="testrow">
      <button className="btn sec sm" disabled={busy} onClick={() => void run()}>
        {busy ? 'Testing…' : 'Test connection'}
      </button>
      {result && (
        <span className={result.ok ? 'tag held' : 'tag'} style={{ marginLeft: 8 }}>
          {result.ok ? 'ok' : 'failed'} · {result.detail}
        </span>
      )}
    </div>
  );
}

/**
 * Download client, indexer and the criteria a release has to satisfy.
 *
 * The search probe at the bottom is the point of this page. These numbers decide
 * what gets grabbed, and their effect used to be invisible until the next real
 * request either worked or quietly did not — so being able to change a bound and
 * immediately see what survives it is worth more than any amount of explanation.
 */
function DownloadingPane({ say }: { say: (k: 'good' | 'bad', t: string) => void }) {
  const [s, setS] = useState<AdminSettings | null>(null);
  const [ready, setReady] = useState<{ prowlarr: boolean; sab: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api
      .adminSettings()
      .then((r) => {
        setS(r.settings);
        setReady(r.ready);
      })
      .catch((e: Error) => setErr(e.message));
  }, []);
  useEffect(load, [load]);

  const save = async () => {
    if (!s) return;
    setSaving(true);
    try {
      const r = await api.saveSettings({
        sabUrl: s.sabUrl,
        sabKey: s.sabKey,
        sabCategory: s.sabCategory,
        prowlarrUrl: s.prowlarrUrl,
        prowlarrKey: s.prowlarrKey,
        formats: s.formats,
        requireLossless: s.requireLossless,
        losslessMinMbPerTrack: s.losslessMinMbPerTrack,
        losslessMaxMbPerTrack: s.losslessMaxMbPerTrack,
        lossyMinMbPerTrack: s.lossyMinMbPerTrack,
        lossyMaxMbPerTrack: s.lossyMaxMbPerTrack,
        maxTotalMb: s.maxTotalMb,
        artRetentionDays: s.artRetentionDays,
        disqualify: s.disqualify,
        maxAttempts: s.maxAttempts,
        stallMinutes: s.stallMinutes,
        dailyAlbumCap: s.dailyAlbumCap,
        maxAlbumsPerRequest: s.maxAlbumsPerRequest,
        qbitUrl: s.qbitUrl,
        qbitUser: s.qbitUser,
        qbitPassword: s.qbitPassword,
        qbitCategory: s.qbitCategory,
        qbitSavePath: s.qbitSavePath,
        preferProtocol: s.preferProtocol,
        minSeeders: s.minSeeders,
      });
      setS(r.settings);
      say('good', 'Saved. Changes apply to the next request — no restart needed.');
      load();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (err) return <div className="note bad">{err}</div>;
  if (!s) return <div className="spinner">Loading…</div>;

  const set = <K extends keyof AdminSettings>(k: K, v: AdminSettings[K]) =>
    setS({ ...s, [k]: v });

  return (
    <>
      <div className="rowhead">
        <h2>Downloading</h2>
        <span className="reason">applies immediately</span>
      </div>

      {ready && (!ready.sab || !ready.prowlarr) && (
        <div className="note">
          {!ready.prowlarr && !ready.sab
            ? 'Neither the indexer nor the download client is configured, so requests will fail.'
            : !ready.prowlarr
              ? 'No indexer configured — nothing can be found.'
              : 'No download client configured — nothing can be fetched.'}
        </div>
      )}

      <h3>Download client — SABnzbd</h3>
      <label className="field">
        <span>URL</span>
        <input value={s.sabUrl} onChange={(e) => set('sabUrl', e.target.value)} placeholder="http://sabnzbd:8080" />
      </label>
      <SecretField
        label="API key"
        hint={s.sabKeyHint}
        isSet={s.sabKeySet}
        value={s.sabKey}
        onChange={(v) => set('sabKey', v)}
      />
      <label className="field">
        <span>
          Category <em className="muted">decides which folder SABnzbd completes into</em>
        </span>
        <input value={s.sabCategory} onChange={(e) => set('sabCategory', e.target.value)} />
      </label>
      <TestButton what="sab" say={say} />

      <h3>Indexer — Prowlarr</h3>
      <label className="field">
        <span>URL</span>
        <input value={s.prowlarrUrl} onChange={(e) => set('prowlarrUrl', e.target.value)} placeholder="http://prowlarr:9696" />
      </label>
      <SecretField
        label="API key"
        hint={s.prowlarrKeyHint}
        isSet={s.prowlarrKeySet}
        value={s.prowlarrKey}
        onChange={(v) => set('prowlarrKey', v)}
      />
      <TestButton what="prowlarr" say={say} />

      <h3>Search criteria</h3>
      <label className="field">
        <span>
          Accepted file types <em className="muted">comma separated</em>
        </span>
        <input
          value={s.formats.join(', ')}
          onChange={(e) => set('formats', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))}
        />
      </label>
      <label className="chk">
        <input
          type="checkbox"
          checked={s.requireLossless}
          onChange={(e) => set('requireLossless', e.target.checked)}
        />
        <span>
          Lossless only <em className="muted">rejects MP3 outright rather than ranking it lower</em>
        </span>
      </label>

      <div className="pair">
        <label className="field">
          <span>Lossless min MB/track</span>
          <input
            type="number"
            value={s.losslessMinMbPerTrack}
            onChange={(e) => set('losslessMinMbPerTrack', Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>Lossless max MB/track</span>
          <input
            type="number"
            value={s.losslessMaxMbPerTrack}
            onChange={(e) => set('losslessMaxMbPerTrack', Number(e.target.value))}
          />
        </label>
      </div>
      <div className="pair">
        <label className="field">
          <span>Lossy min MB/track</span>
          <input
            type="number"
            value={s.lossyMinMbPerTrack}
            onChange={(e) => set('lossyMinMbPerTrack', Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>Lossy max MB/track</span>
          <input
            type="number"
            value={s.lossyMaxMbPerTrack}
            onChange={(e) => set('lossyMaxMbPerTrack', Number(e.target.value))}
          />
        </label>
      </div>
      <label className="field">
        <span>
          Maximum download size, MB <em className="muted">0 = unlimited</em>
        </span>
        <input
          type="number"
          min={0}
          value={s.maxTotalMb}
          onChange={(e) => set('maxTotalMb', Number(e.target.value))}
        />
      </label>
      <div className="muted sm">
        Size per track rejects a single pretending to be an album, or a box set pretending to be one
        disc. The maximum above is a different question — a budget for the whole release, which is
        how a legitimate 24-bit rip that happens to be 2 GB gets ruled out. A release whose size the
        indexer does not report is never rejected for being too big, because an unknown size is not
        evidence.
      </div>
      <div className="muted sm">
        Set any of these too tight and everything is refused, which looks exactly like an indexer
        with no results — use the probe below before trusting a change.
      </div>

      <label className="field">
        <span>
          Never grab titles containing <em className="muted">comma separated</em>
        </span>
        <input
          value={s.disqualify.join(', ')}
          onChange={(e) => set('disqualify', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))}
        />
      </label>

      <h3>Caching</h3>
      <label className="field">
        <span>
          Keep unused artwork and metadata for, days{' '}
          <em className="muted">0 = forever</em>
        </span>
        <input
          type="number"
          min={0}
          value={s.artRetentionDays}
          onChange={(e) => set('artRetentionDays', Number(e.target.value))}
        />
      </label>
      <div className="muted sm">
        Artwork and metadata are stored locally on first use, so a remote source is asked once
        rather than on every page load. Anything belonging to music on disk — which includes
        everything in anybody&apos;s library — is never deleted whatever this is set to. This only
        governs art for things that were looked at once and never again.
      </div>

      <div className="pair">
        <label className="field">
          <span>
            Releases to try <em className="muted">before giving up</em>
          </span>
          <input
            type="number"
            value={s.maxAttempts}
            onChange={(e) => set('maxAttempts', Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>
            Stall timeout <em className="muted">minutes without progress</em>
          </span>
          <input
            type="number"
            value={s.stallMinutes}
            onChange={(e) => set('stallMinutes', Number(e.target.value))}
          />
        </label>
      </div>

      <div className="sechead">
        <h2>Torrents</h2>
        <span className="sub">a second source, for what Usenet does not have</span>
      </div>
      <div className="note">
        Leave the URL empty to keep torrents off entirely. Downloads are <b>copied</b> into the
        library rather than moved, so finished torrents keep seeding. Prowlarr decides which
        trackers are searched.
      </div>
      <div className="pair">
        <label className="field">
          <span>
            qBittorrent WebUI <em className="muted">e.g. http://gluetun:8090</em>
          </span>
          <input value={s.qbitUrl} onChange={(e) => set('qbitUrl', e.target.value)} />
        </label>
        <label className="field">
          <span>
            Category <em className="muted">marks crate's torrents</em>
          </span>
          <input value={s.qbitCategory} onChange={(e) => set('qbitCategory', e.target.value)} />
        </label>
      </div>
      <div className="pair">
        <label className="field">
          <span>
            Username <em className="muted">only if crate's IP is not whitelisted</em>
          </span>
          <input value={s.qbitUser} onChange={(e) => set('qbitUser', e.target.value)} />
        </label>
        <label className="field">
          <span>
            Password <em className="muted">leave blank to keep the saved one</em>
          </span>
          <input
            type="password"
            autoComplete="new-password"
            placeholder={s.qbitUrl ? '••••••••' : ''}
            value={s.qbitPassword}
            onChange={(e) => set('qbitPassword', e.target.value)}
          />
        </label>
      </div>
      <div className="pair">
        <label className="field">
          <span>
            Save path <em className="muted">as both qBittorrent and crate see it</em>
          </span>
          <input value={s.qbitSavePath} onChange={(e) => set('qbitSavePath', e.target.value)} />
        </label>
        <label className="field">
          <span>
            Minimum seeders <em className="muted">thin swarms are skipped · 0 = any</em>
          </span>
          <input
            type="number"
            value={s.minSeeders}
            onChange={(e) => set('minSeeders', Number(e.target.value))}
          />
        </label>
      </div>
      <TestButton what="qbit" say={say} />
      <div className="field">
        <span>Prefer</span>
        <div className="chips" style={{ marginTop: 6 }}>
          {(
            [
              ['usenet', 'Usenet first'],
              ['torrent', 'Torrents first'],
            ] as [string, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              className={`chip${s.preferProtocol === v ? ' on' : ''}`}
              onClick={() => set('preferProtocol', v)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="note">
        Request caps exist for metered Usenet accounts. 0 means unlimited — instant adds from
        the pool never count either way.
      </div>
      <div className="pair">
        <label className="field">
          <span>
            Daily album cap <em className="muted">per user, rolling 24h · 0 = unlimited</em>
          </span>
          <input
            type="number"
            value={s.dailyAlbumCap}
            onChange={(e) => set('dailyAlbumCap', Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>
            Albums per artist request <em className="muted">0 = unlimited</em>
          </span>
          <input
            type="number"
            value={s.maxAlbumsPerRequest}
            onChange={(e) => set('maxAlbumsPerRequest', Number(e.target.value))}
          />
        </label>
      </div>

      <button className="btn" disabled={saving} onClick={() => void save()}>
        {saving ? 'Saving…' : 'Save'}
      </button>

      <SearchProbePanel />
    </>
  );
}

/** Run a real indexer search through the current criteria, grabbing nothing. */
function SearchProbePanel() {
  const [artist, setArtist] = useState('');
  const [album, setAlbum] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<SearchProbe | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      setRes(await api.testSearch(artist.trim(), album.trim()));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h3>Try a search</h3>
      <div className="muted sm">
        Searches the indexers and scores the results with the settings above. Downloads nothing.
      </div>
      <div className="pair">
        <label className="field">
          <span>Artist</span>
          <input value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="Radiohead" />
        </label>
        <label className="field">
          <span>Album</span>
          <input value={album} onChange={(e) => setAlbum(e.target.value)} placeholder="OK Computer" />
        </label>
      </div>
      <button
        className="btn sec"
        disabled={busy || !artist.trim() || !album.trim()}
        onClick={() => void run()}
      >
        {busy ? 'Searching…' : 'Search'}
      </button>

      {err && <div className="note bad">{err}</div>}
      {res && (
        <>
          <div className="muted sm" style={{ marginTop: 10 }}>
            {res.found} result{res.found === 1 ? '' : 's'} from the indexers, {res.viable} passed the
            criteria, {res.rejected} rejected.
          </div>
          {res.viable === 0 && res.found > 0 && (
            <div className="note">
              Everything was rejected. Either none of these is really that album, or the criteria
              above are too strict.
            </div>
          )}
          {res.results.length > 0 && (
            <table className="list">
              <thead>
                <tr>
                  <th>Release</th>
                  <th>Size</th>
                  <th>Score</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {res.results.map((r, i) => (
                  <tr key={`${r.title}-${i}`}>
                    <td>
                      {i === 0 && <span className="tag held" style={{ marginRight: 6 }}>would grab</span>}
                      {r.title}
                    </td>
                    <td className="muted">{r.sizeMb} MB</td>
                    <td className="muted">{r.score}</td>
                    <td className="muted sm">{r.reasons.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}

function LastfmPane({ say }: { say: (k: 'good' | 'bad', t: string) => void }) {
  const [s, setS] = useState<AdminSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api
      .adminSettings()
      .then((r) => setS(r.settings))
      .catch((e: Error) => setErr(e.message));
  }, []);
  useEffect(load, [load]);

  const save = async () => {
    if (!s) return;
    setSaving(true);
    try {
      const r = await api.saveSettings({
        lastfmKey: s.lastfmKey,
        minSeeds: s.minSeeds,
        mbMirrorUrl: s.mbMirrorUrl,
        acoustidKey: s.acoustidKey,
        openaiKey: s.openaiKey,
        warmPages: s.warmPages,
        songCharacteristics: s.songCharacteristics,
      });
      setS(r.settings);
      say('good', 'Saved.');
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (err) return <div className="note bad">{err}</div>;
  if (!s) return <div className="spinner">Loading…</div>;

  return (
    <>
      <div className="rowhead">
        <h2>Last.fm</h2>
        <span className="reason">powers the discovery rows</span>
      </div>

      {!s.lastfmKeySet && (
        <div className="note">
          Without a key, search and requests work normally but the front page has no
          recommendations. A free key comes from last.fm/api/account/create — any callback URL will
          do, since crate never uses one.
        </div>
      )}

      <SecretField
        label="API key"
        hint={s.lastfmKeyHint}
        isSet={s.lastfmKeySet}
        value={s.lastfmKey}
        onChange={(v) => setS({ ...s, lastfmKey: v })}
      />
      <TestButton what="lastfm" say={say} />

      <label className="field">
        <span>
          Seed artists before personalising{' '}
          <em className="muted">below this the front page falls back to charts</em>
        </span>
        <input
          type="number"
          value={s.minSeeds}
          onChange={(e) => setS({ ...s, minSeeds: Number(e.target.value) })}
        />
      </label>
      <div className="muted sm">
        One is deliberate. With two seeds the suggestions were A Perfect Circle, Serj Tankian and
        Deftones; the chart fallback offered Ariana Grande and Drake. A narrow but relevant guess
        beats a broad irrelevant one.
      </div>

      <div className="rowhead">
        <h2>MusicBrainz</h2>
        <span className="reason">where album and track metadata comes from</span>
      </div>

      <div className="note">
        The public API allows one request per second, shared by everything crate does — which is
        why a large import takes hours rather than minutes. A local mirror has no such limit, so
        crate skips the queue entirely when one answers.
        <br />
        <br />
        This is an accelerator, not a dependency. Whenever the mirror does not answer, crate falls
        back to the public API and tries the mirror again a minute later, so pointing it at a
        desktop that is off half the time works exactly as you would want.
      </div>

      <label className="field">
        <span>
          Mirror base URL <em className="muted">blank uses the public API</em>
        </span>
        <input
          type="text"
          placeholder="http://mirror.lan:5000/ws/2"
          value={s.mbMirrorUrl}
          onChange={(e) => setS({ ...s, mbMirrorUrl: e.target.value })}
        />
      </label>
      <div className="muted sm">
        Include the <code>/ws/2</code> path. Search lives in a separate container from the
        database, so a mirror without one still serves everything looked up by id — crate sends
        only the searches to the public API in that case.
      </div>
      <TestButton what="mbmirror" say={say} />

      <div className="rowhead">
        <h2>AcoustID</h2>
        <span className="reason">identify uploads by sound, not tags</span>
      </div>
      <div className="note">
        Fingerprints are computed locally — the audio never leaves this box. With a key, the
        fingerprint hash is matched against AcoustID so untagged uploads name themselves. A free
        key comes from acoustid.org/new-application. Without one, uploads fall back to their tags.
      </div>
      <SecretField
        label="Application key"
        hint={s.acoustidKeyHint}
        isSet={s.acoustidKeySet}
        value={s.acoustidKey}
        onChange={(v) => setS({ ...s, acoustidKey: v })}
      />
      <TestButton what="acoustid" say={say} />

      <div className="rowhead">
        <h2>OpenAI</h2>
        <span className="reason">AI assistance for admin jobs</span>
      </div>
      <div className="note">
        Currently used for one thing: when adopting or uploading an album, files the matcher
        cannot confidently place on the tracklist are sent to gpt-4o-mini for a second opinion —
        file names and the tracklist only, never audio. Everything works without a key; the rules
        just decide alone.
      </div>
      <SecretField
        label="API key"
        hint={s.openaiKeyHint}
        isSet={s.openaiKeySet}
        value={s.openaiKey}
        onChange={(v) => setS({ ...s, openaiKey: v })}
      />
      <TestButton what="openai" say={say} />

      <div className="rowhead">
        <h2>Song characteristics</h2>
        <span className="reason">how a song sounds and feels, not what it is</span>
      </div>
      <div className="note">
        Artist and album pages need MusicBrainz and Last.fm, which are slow the first time and
        instant afterwards — measured on this library, a first visit took 3.3 seconds and every
        visit after it took 15 milliseconds. This fetches that metadata in the background before
        anybody clicks, newest additions included, on the queue that yields to anything a person
        is waiting on. Artwork is not part of it; covers have their own cache.
      </div>
      <label className="chk">
        <input
          type="checkbox"
          checked={s.warmPages}
          onChange={(e) => setS({ ...s, warmPages: e.target.checked })}
        />
        <span>
          Warm artist and album pages{' '}
          <em className="muted">keeps up with new music by itself; use the sweep for the rest</em>
        </span>
      </label>
      <PageWarmPanel say={say} />

      <div className="note">
        Use AI to analyse the musical, emotional and sonic characteristics of songs. Each track
        gets a score from 0 to 1 on every dimension — energy, darkness, groove, atmosphere,
        sensuality and forty-odd more — independently of genre, which is what makes tracks
        comparable to each other. Off by default because it is the one feature that costs money
        per track. Only existing metadata is sent; audio never leaves this box, and the files
        themselves are never modified.
      </div>
      <label className="chk">
        <input
          type="checkbox"
          checked={s.songCharacteristics}
          onChange={(e) => setS({ ...s, songCharacteristics: e.target.checked })}
        />
        <span>
          Song characteristics{' '}
          <em className="muted">
            analyses newly-added songs from here on; existing songs need the sweep below
          </em>
        </span>
      </label>
      <CharacteristicSweep say={say} />

      <button className="btn" disabled={saving} onClick={() => void save()}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </>
  );
}

/**
 * Webhooks: destinations and the events each one wants.
 *
 * Two kinds because they answer different needs. Pushover is a phone notification and
 * wants a sentence; a REST endpoint is something else's automation and wants fields.
 * Every event carries both, so neither destination has to parse the other's format.
 *
 * The test button matters more here than anywhere else on the admin page: a webhook
 * that was accepted and then silently never delivers is indistinguishable from one
 * that has nothing to say.
 */
function WebhooksPane({ say }: { say: (k: 'good' | 'bad', t: string) => void }) {
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [events, setEvents] = useState<EventInfo[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState<'pushover' | 'rest' | null>(null);

  const load = useCallback(() => {
    api
      .webhooks()
      .then((r) => {
        setHooks(r.webhooks);
        setEvents(r.events);
      })
      .catch((e: Error) => setErr(e.message));
  }, []);
  useEffect(load, [load]);

  if (err) return <div className="note bad">{err}</div>;
  if (!hooks) return <div className="spinner">Loading…</div>;

  return (
    <>
      <div className="rowhead">
        <h2>Webhooks</h2>
        <span className="reason">{hooks.length} configured</span>
      </div>

      {hooks.length === 0 && (
        <div className="empty">
          Nothing configured. Add a Pushover destination for phone notifications, or a REST endpoint
          to drive something else.
        </div>
      )}

      {hooks.map((h) => (
        <WebhookCard key={h.id} hook={h} events={events} onChanged={setHooks} say={say} />
      ))}

      <div className="bar" style={{ marginTop: 18 }}>
        <button className="btn sec sm" onClick={() => setAdding('pushover')}>
          Add Pushover
        </button>
        <button className="btn sec sm" onClick={() => setAdding('rest')}>
          Add REST endpoint
        </button>
      </div>

      {adding && (
        <WebhookEditor
          kind={adding}
          events={events}
          onCancel={() => setAdding(null)}
          onSaved={(list) => {
            setHooks(list);
            setAdding(null);
            say('good', 'Webhook added. Send a test to prove it works.');
          }}
          say={say}
        />
      )}
    </>
  );
}

/** Relative time, so "last delivery" reads without doing arithmetic. */
function ago(unix: number | null): string {
  if (!unix) return 'never';
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function WebhookCard({
  hook,
  events,
  onChanged,
  say,
}: {
  hook: Webhook;
  events: EventInfo[];
  onChanged: (list: Webhook[]) => void;
  say: (k: 'good' | 'bad', t: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<{ webhooks: Webhook[] }>, ok?: string) => {
    setBusy(true);
    try {
      const r = await fn();
      onChanged(r.webhooks);
      if (ok) say('good', ok);
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      const r = await api.testWebhook(hook.id);
      onChanged(r.webhooks);
      say(r.ok ? 'good' : 'bad', r.detail);
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const target =
    hook.kind === 'rest'
      ? String(hook.config.url ?? '')
      : hook.config.userSet
        ? `user key ${String(hook.config.userHint ?? '')}`
        : 'no user key';

  return (
    <div className="hook">
      <div className="hookhead">
        <div>
          <div className="t">
            {hook.name}{' '}
            <span className="tag">{hook.kind === 'rest' ? 'REST' : 'Pushover'}</span>
            {!hook.enabled && (
              <span className="tag" style={{ marginLeft: 6 }}>
                disabled
              </span>
            )}
          </div>
          <div className="s muted">{target}</div>
          <div className="s muted">
            {hook.events.length === 0
              ? 'every event'
              : `${hook.events.length} of ${events.length} events`}
            {' · last delivery '}
            {ago(hook.lastAt)}
            {hook.lastOk === false && ' · failed'}
            {hook.failures > 0 && ` (${hook.failures} in a row)`}
          </div>
        </div>
        <div className="acts">
          <button className="btn sec sm" disabled={busy} onClick={() => void test()}>
            Test
          </button>
          <button className="btn sec sm" onClick={() => setOpen(!open)}>
            {open ? 'Close' : 'Edit'}
          </button>
          <button
            className="btn sec sm"
            disabled={busy}
            onClick={() =>
              void act(
                () => api.updateWebhook(hook.id, { enabled: !hook.enabled }),
                hook.enabled ? 'Disabled' : 'Enabled',
              )
            }
          >
            {hook.enabled ? 'Disable' : 'Enable'}
          </button>
        </div>
      </div>

      {/* A failing destination says so here rather than only in the log, because the
          whole point of a notification channel is that somebody is relying on it. */}
      {hook.lastOk === false && hook.lastError && (
        <div className="reqerr" style={{ padding: '4px 0 0' }}>
          {hook.lastError}
        </div>
      )}

      {open && (
        <WebhookEditor
          kind={hook.kind}
          hook={hook}
          events={events}
          onCancel={() => setOpen(false)}
          onSaved={(list) => {
            onChanged(list);
            setOpen(false);
            say('good', 'Saved.');
          }}
          onDeleted={(list) => {
            onChanged(list);
            say('good', `Removed ${hook.name}`);
          }}
          say={say}
        />
      )}
    </div>
  );
}

function WebhookEditor({
  kind,
  hook,
  events,
  onCancel,
  onSaved,
  onDeleted,
  say,
}: {
  kind: 'pushover' | 'rest';
  hook?: Webhook;
  events: EventInfo[];
  onCancel: () => void;
  onSaved: (list: Webhook[]) => void;
  onDeleted?: (list: Webhook[]) => void;
  say: (k: 'good' | 'bad', t: string) => void;
}) {
  const cfg = hook?.config ?? {};
  const [name, setName] = useState(hook?.name ?? (kind === 'pushover' ? 'Pushover' : 'REST endpoint'));
  const [token, setToken] = useState('');
  const [user, setUser] = useState('');
  const [priority, setPriority] = useState(Number(cfg.priority ?? 0));
  const [url, setUrl] = useState(String(cfg.url ?? ''));
  const [method, setMethod] = useState(String(cfg.method ?? 'POST'));
  const [headers, setHeaders] = useState('');
  // Empty means every event, which is the useful default for one phone destination.
  const [chosen, setChosen] = useState<string[]>(hook?.events ?? []);
  const [busy, setBusy] = useState(false);

  const toggle = (e: string) =>
    setChosen(chosen.includes(e) ? chosen.filter((x) => x !== e) : [...chosen, e]);

  const save = async () => {
    setBusy(true);
    try {
      let parsedHeaders: Record<string, string> | undefined;
      if (headers.trim()) {
        try {
          parsedHeaders = JSON.parse(headers) as Record<string, string>;
        } catch {
          say('bad', 'Headers must be a JSON object, e.g. {"Authorization":"Bearer x"}');
          setBusy(false);
          return;
        }
      }

      const config =
        kind === 'pushover'
          ? { token, user, priority }
          : { url, method, ...(parsedHeaders ? { headers: parsedHeaders } : {}) };

      const r = hook
        ? await api.updateWebhook(hook.id, { name, config, events: chosen })
        : await api.addWebhook({ name, kind, enabled: true, config, events: chosen });
      onSaved(r.webhooks);
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!hook || !onDeleted) return;
    setBusy(true);
    try {
      const r = await api.deleteWebhook(hook.id);
      onDeleted(r.webhooks);
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hookedit">
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      {kind === 'pushover' ? (
        <>
          <SecretField
            label="API token / key"
            hint={String(cfg.tokenHint ?? '')}
            isSet={Boolean(cfg.tokenSet)}
            value={token}
            onChange={setToken}
          />
          <SecretField
            label="User key"
            hint={String(cfg.userHint ?? '')}
            isSet={Boolean(cfg.userSet)}
            value={user}
            onChange={setUser}
          />
          <label className="field">
            <span>
              Priority <em className="muted">-2 quiet … 2 emergency</em>
            </span>
            <input
              type="number"
              min={-2}
              max={2}
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
            />
          </label>
        </>
      ) : (
        <>
          <label className="field">
            <span>URL</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/hook"
            />
          </label>
          <label className="field">
            <span>Method</span>
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option>POST</option>
              <option>PUT</option>
              <option>PATCH</option>
            </select>
          </label>
          <label className="field">
            <span>
              Extra headers{' '}
              <em className="muted">
                JSON object, optional{Boolean(cfg.headersSet) && ' — stored, leave blank to keep'}
              </em>
            </span>
            <input
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              placeholder='{"Authorization":"Bearer …"}'
            />
          </label>
          <div className="muted sm">
            Receives a JSON body: event, at, title, message, and a data object with the structured
            fields for that event.
          </div>
        </>
      )}

      <h3>Triggers</h3>
      <div className="muted sm">
        {chosen.length === 0
          ? 'None selected, which means every event — including ones added later.'
          : `${chosen.length} selected.`}
      </div>
      <div className="triggers">
        {events.map((e) => (
          <label key={e.name} className="chk">
            <input
              type="checkbox"
              checked={chosen.includes(e.name)}
              onChange={() => toggle(e.name)}
            />
            <span>
              {e.label} <em className="muted">{e.name}</em>
            </span>
          </label>
        ))}
      </div>

      <div className="bar" style={{ marginTop: 12 }}>
        <button className="btn sm" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : hook ? 'Save' : 'Add'}
        </button>
        <button className="btn sec sm" onClick={onCancel}>
          Cancel
        </button>
        {hook && onDeleted && (
          <button className="btn sec sm" disabled={busy} onClick={() => void remove()}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Library: what is on disk, and the only place that can remove it.
 *
 * Deletion lives here rather than on the artist page because it is destructive and
 * admin-only, and because the useful view when you are cleaning up is "everything I
 * have", not "one artist at a time".
 *
 * Nothing is unlinked — a delete moves files to a trash directory outside the music
 * root, so a mistake is a move rather than a loss. The pane says so, because a button
 * labelled Delete that actually means "move to trash" should admit it.
 */
/**
 * Fix an album after the fact: names, track titles and numbers, the cover.
 *
 * Exists because upload and adoption are confirm-once flows and typos are
 * noticed after the button. Edits rewrite the INDEX — the audio is untouched,
 * and the scanner's trust in unchanged files is what makes the corrections
 * stick. The cover goes to disk beside the tracks, where the art resolver
 * looks first, and the cached art is dropped so the change shows immediately.
 */
function AlbumEditPanel({
  album,
  say,
  onSaved,
}: {
  album: LibraryAlbum;
  say: (k: 'good' | 'bad', t: string) => void;
  onSaved: () => void;
}) {
  const [artist, setArtist] = useState(album.artistName);
  const [title, setTitle] = useState(album.albumTitle);
  const [rows, setRows] = useState<{ trackId: number; title: string; trackNo: number }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);

  useEffect(() => {
    api
      .album(album.artistName, album.albumTitle)
      .then((r) =>
        setRows(
          r.tracks.map((t, i) => ({
            trackId: t.trackId,
            title: t.title,
            trackNo: t.trackNo ?? i + 1,
          })),
        ),
      )
      .catch((e: Error) => setErr(e.message));
  }, [album.artistName, album.albumTitle]);

  const save = async () => {
    if (!rows) return;
    setBusy(true);
    try {
      const r = await api.editAlbum({
        key: album.normKey,
        artistName: artist,
        albumTitle: title,
        tracks: rows,
      });
      say('good', `Saved — ${r.touched} track${r.touched === 1 ? '' : 's'} updated.`);
      onSaved();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cover = async (f: File) => {
    setCoverBusy(true);
    try {
      await api.setCover(album.normKey, f);
      say('good', 'Cover replaced. Pages pick it up on their next load.');
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setCoverBusy(false);
    }
  };

  if (err) return <div className="note bad">{err}</div>;
  if (!rows) return <div className="spinner">Loading tracks…</div>;

  return (
    <div className="userdata" style={{ marginTop: 10 }}>
      <div className="pair" style={{ maxWidth: 560 }}>
        <label className="field">
          <span>Artist</span>
          <input value={artist} onChange={(e) => setArtist(e.target.value)} />
        </label>
        <label className="field">
          <span>Album</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </div>

      <table className="list" style={{ maxWidth: 680 }}>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.trackId}>
              <td style={{ width: 64 }}>
                <input
                  type="number"
                  min={1}
                  style={{ width: 56 }}
                  value={r.trackNo}
                  onChange={(e) => {
                    const next = [...rows];
                    next[i] = { ...r, trackNo: Number(e.target.value) };
                    setRows(next);
                  }}
                />
              </td>
              <td>
                <input
                  value={r.title}
                  onChange={(e) => {
                    const next = [...rows];
                    next[i] = { ...r, title: e.target.value };
                    setRows(next);
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
        <button className="btn sm" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <label className="btn sec sm" style={{ cursor: 'pointer' }}>
          {coverBusy ? 'Uploading…' : 'Replace cover…'}
          <input
            type="file"
            accept=".jpg,.jpeg,.png,.webp"
            style={{ display: 'none' }}
            disabled={coverBusy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void cover(f);
              e.target.value = '';
            }}
          />
        </label>
      </div>
    </div>
  );
}

/**
 * The same song twice in one album — what two merged rips leave behind.
 *
 * Shown only when there is something to show, because a clean library should
 * not carry a permanent empty panel telling it so.
 */
function DuplicatePanel({
  say,
  onPurged,
}: {
  say: (k: 'good' | 'bad', t: string) => void;
  onPurged: () => void;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.duplicates>> | null>(null);
  const [open, setOpen] = useState(false);
  const [arming, setArming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.duplicates().then(setData).catch(() => setData(null));
  }, []);
  useEffect(() => load(), [load]);

  if (!data || data.totals.sets === 0) return null;
  const t = data.totals;

  return (
    <div className="userdata" style={{ marginBottom: 14 }}>
      <div className="rowhead subhead" style={{ marginTop: 0 }}>
        <h3>Duplicate copies</h3>
        <span className="reason">
          {t.sets} song{t.sets === 1 ? '' : 's'} appear twice · {t.redundant} redundant file
          {t.redundant === 1 ? '' : 's'} · {bytes(t.bytes)}
        </span>
        <div className="spacer" />
        <button className="btn sec sm" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Review'}
        </button>
        {arming ? (
          <>
            <button
              className="btn sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void api
                  .purgeDuplicates()
                  .then((r) => {
                    say('good', `Removed ${r.removed} duplicate${r.removed === 1 ? '' : 's'} — ${bytes(r.freed)} to trash.`);
                    setArming(false);
                    load();
                    onPurged();
                  })
                  .catch((e: Error) => say('bad', e.message))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? 'Removing…' : `Really remove ${t.redundant}`}
            </button>
            <button className="btn sec sm" onClick={() => setArming(false)}>
              Keep
            </button>
          </>
        ) : (
          <button className="btn sec sm" onClick={() => setArming(true)}>
            Keep the best of each
          </button>
        )}
      </div>
      <div className="muted sm">
        Lossless wins over lossy; between two of the same format the larger file wins. Library
        entries, play counts and playlist places move to the copy that stays, and the rest go to
        the trash.
      </div>
      {open && (
        <table className="list" style={{ marginTop: 8 }}>
          <tbody>
            {data.sets.slice(0, 200).map((s) => (
              <tr key={`${s.albumArtist}|${s.album}|${s.title}`}>
                <td>
                  {s.title}
                  <div className="muted sm">{s.album}</div>
                </td>
                <td>
                  {s.files.map((f) => (
                    <div key={f.trackId} className={f.trackId === s.keep ? '' : 'muted'}>
                      {f.trackId === s.keep ? '✓ ' : '✕ '}
                      {f.path.split('/').pop()} · {bytes(f.sizeBytes)}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function LibraryPane({ say }: { say: (k: 'good' | 'bad', t: string) => void }) {
  const [albums, setAlbums] = useState<LibraryAlbum[] | null>(null);
  const [trash, setTrash] = useState('');
  const [totals, setTotals] = useState<{ albums: number; tracks: number; bytes: number } | null>(
    null,
  );
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .libraryAlbums()
      .then((r) => {
        setAlbums(r.albums);
        setTrash(r.trashRoot);
        setTotals(r.totals);
      })
      .catch((e: Error) => setErr(e.message));
  }, []);
  useEffect(load, [load]);

  const delAlbum = async (a: LibraryAlbum) => {
    setBusy(true);
    try {
      const r = await api.deleteAlbum(a.normKey);
      say('good', `Moved ${r.moved} file${r.moved === 1 ? '' : 's'} to the trash`);
      setConfirming(null);
      load();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const delTrack = async (a: LibraryAlbum, name: string) => {
    setBusy(true);
    try {
      await api.deleteTrack(`${a.path}/${name}`);
      say('good', `${name} moved to the trash`);
      load();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rescan = async () => {
    setBusy(true);
    try {
      const r = await api.rescanLibrary();
      say('good', `Rescanned: ${r.albums} albums, ${r.tracks} tracks`);
      load();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (err) return <div className="note bad">{err}</div>;
  if (!albums) return <div className="spinner">Reading the library…</div>;

  return (
    <>
      <div className="rowhead">
        <h2>Library</h2>
        <span className="reason">
          {totals?.albums} albums · {totals?.tracks} tracks · {bytes(totals?.bytes ?? 0)}
        </span>
      </div>

      <div className="muted sm">
        Deleting moves files to <code>{trash}</code> rather than erasing them. That is outside the
        music folder, so they leave your library straight away, and the bytes are copied and verified
        before the original goes. Empty it yourself when you are sure.
      </div>

      <div className="bar" style={{ margin: '10px 0 16px' }}>
        <button className="btn sec sm" disabled={busy} onClick={() => void rescan()}>
          Rescan from disk
        </button>
      </div>

      <OrphanPurge say={say} onPurged={load} />

      <DuplicatePanel say={say} onPurged={load} />

      <div className="rowhead">
        <h3>Albums on disk</h3>
      </div>
      {albums.length === 0 && <div className="empty">Nothing in the library yet.</div>}

      {albums.map((a) => (
        <div className="hook" key={a.normKey}>
          <div className="hookhead">
            <div>
              <div className="t">
                {a.artistName} — {a.albumTitle}
                {a.mbid && (
                  <span className="tag held" style={{ marginLeft: 6 }}>
                    matched
                  </span>
                )}
              </div>
              <div className="s muted">
                {a.files.length} track{a.files.length === 1 ? '' : 's'} ·{' '}
                {bytes(a.files.reduce((n, f) => n + f.sizeBytes, 0))} · {a.path}
              </div>
              {a.sharedFolder && (
                <div className="s muted">
                  shares a folder with other albums — only this album&apos;s files are removed
                </div>
              )}
            </div>
            <div className="acts">
              <button
                className="btn sec sm"
                onClick={() => setOpen(open === a.normKey ? null : a.normKey)}
              >
                {open === a.normKey ? 'Hide tracks' : 'Tracks'}
              </button>
              <button
                className="btn sec sm"
                onClick={() => setEditing(editing === a.normKey ? null : a.normKey)}
              >
                {editing === a.normKey ? 'Close' : 'Edit'}
              </button>
              {confirming === a.normKey ? (
                <>
                  <button className="btn sm" disabled={busy} onClick={() => void delAlbum(a)}>
                    {busy ? 'Deleting…' : 'Really delete'}
                  </button>
                  <button className="btn sec sm" onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button className="btn sec sm" onClick={() => setConfirming(a.normKey)}>
                  Delete album
                </button>
              )}
            </div>
          </div>

          {editing === a.normKey && (
            <AlbumEditPanel
              album={a}
              say={say}
              onSaved={() => {
                setEditing(null);
                load();
              }}
            />
          )}
          {open === a.normKey && (
            <table className="list" style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th>Track</th>
                  <th>Size</th>
                  <th style={{ textAlign: 'right' }}>&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {a.files.map((f) => (
                  <tr key={f.name}>
                    <td>{f.name}</td>
                    <td className="muted">{bytes(f.sizeBytes)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="btn sec sm"
                        disabled={busy}
                        onClick={() => void delTrack(a, f.name)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------

/** Human numbers for the listening page: durations in words, times as "20m ago". */
const Format = {
  minutes(total: number): string {
    if (total < 60) return `${total} min`;
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  },
  ago(at: number): string {
    const s = Math.max(0, Math.floor(Date.now() / 1000) - at);
    if (s < 90) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    return d === 1 ? 'yesterday' : `${d}d ago`;
  },
};

/** mm:ss, or a dash when the length is unknown. */
function secs(s: number | null): string {
  if (!s) return '—';
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}

/**
 * Song results, as the same rows My Library uses.
 *
 * One component for song lists everywhere: SongRow already knows the three
 * states (yours plays, available adds on tap, everything else downloads via
 * its menu), and its actions live in the row rather than in a button column
 * hanging off the right edge of a table — which on a phone was half
 * off-screen. The MusicBrainz half of the results comes from a recording
 * search, so songs are found by SONG name, not by their album's name.
 */
/**
 * Presentational now: SearchView owns the data, because the rows it shows change source
 * mid-search — the instant local list first, the full list (with downloadable extras
 * appended) once the wide search lands.
 */
function SongResults({
  q,
  say,
  tracks,
  onChanged,
}: {
  q: string;
  say: (k: 'good' | 'bad', t: string) => void;
  tracks: TrackHit[];
  onChanged: () => void;
}) {
  if (!tracks.length) return null;

  return (
    <>
      <div className="rowhead">
        <h2>Songs</h2>
        {tracks.some((t) => t.mine) && (
          <span className="reason">{tracks.filter((t) => t.mine).length} in your library</span>
        )}
      </div>
      <div className="songrows">
        {tracks.map((t, i) => (
          <SongRow
            key={`${t.artistName}|${t.albumTitle}|${t.title}-${i}`}
            track={t}
            // Not a play queue — search rows act individually — but the position still
            // uniquely identifies a row, which the preview button needs.
            index={i}
            label={`“${q}”`}
            say={say}
            mine={t.mine}
            onDisk={t.onDisk}
            albumMbid={t.albumMbid}
            onChanged={onChanged}
            variant="search"
          />
        ))}
      </div>
    </>
  );
}

function MyLibraryView({ say }: { say: (k: 'good' | 'bad', t: string) => void }) {
  const p = usePlayer();
  const [songs, setSongs] = useState<(MyTrack & { plays: number })[] | null>(null);
  const [total, setTotal] = useState(0);
  /**
   * Most played is home base. A–Z and ★ are one press away and pressing the
   * active one again returns home, so the two buttons behave like the toggles
   * they look like rather than a third of a radio group.
   */
  const [sort, setSort] = useState<LibrarySort>('plays');
  /**
   * A pressed Shuffle holds the WHOLE shuffled queue, and the list shows its
   * head — the screen and the speakers must agree about what order means.
   * Any sort press clears it, because a sort is a statement about order and
   * a shuffle is the absence of one.
   */
  const [shuffled, setShuffled] = useState<(MyTrack & { plays: number })[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // A named loader rather than a bare effect, so a removal can refresh the
  // grid in place — a removed song that stays on screen until a reload looks
  // exactly like the removal not working.
  const load = useCallback(() => {
    api
      // Eleven, because Show more is the twelfth item of the grid.
      .mySongs({ per: 11, sort })
      .then((r) => {
        setSongs(r.tracks);
        setTotal(r.total);
      })
      .catch((e: Error) => setErr(e.message));
  }, [sort]);
  useEffect(() => load(), [load]);

  const toggle = (v: LibrarySort) => {
    setShuffled(null);
    setSort(sort === v ? 'plays' : v);
  };

  const shuffleAll = () => {
    void api.queue({ kind: 'library' }).then((r) => {
      // Shuffled HERE rather than by the player, so the queue order and the
      // list on screen are one array — the player just plays it straight.
      const arr = [...r.tracks] as (MyTrack & { plays: number })[];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j]!, arr[i]!];
      }
      setShuffled(arr);
      // 'held': this deal IS the shuffle — the flag turns on, the order plays as dealt.
      p.play(arr.map(playable), 0, 'my library', { shuffle: 'held' });
    });
  };

  if (err) return <div className="note bad">{err}</div>;
  if (!songs) return <div className="spinner">Loading your library…</div>;

  return (
    <>
      <div className="sechead">
        <h2>Songs</h2>
        {songs.length > 0 && (
          <button
            className="roundplay"
            title="Play all, in this order"
            aria-label="Play all songs in the current order"
            onClick={() => {
              // The whole library in the order on screen. A live shuffle IS
              // the current order, so replay that; otherwise the sort rides
              // along to the server and "all" and "as sorted" are one list.
              if (shuffled) {
                p.play(shuffled.map(playable), 0, 'my library', { shuffle: 'held' });
                return;
              }
              void api.queue({ kind: 'library', sort }).then((r) => {
                p.play(r.tracks.map(playable), 0, 'my library');
              });
            }}
          >
            <IconPlay />
          </button>
        )}
        <span className="sub">{total}</span>
        <div className="spacer" />
        {songs.length > 0 && (
          <>
            <button
              className={`btn sec sm iconable${shuffled ? ' on' : ''}`}
              title="Shuffle everything — press again to redeal"
              onClick={shuffleAll}
            >
              <IconShuffle /> <span className="btnword">Shuffle</span>
            </button>
            <button
              className={`btn sec sm${sort === 'alpha' ? ' on' : ''}`}
              title="Alphabetical"
              aria-pressed={sort === 'alpha'}
              onClick={() => toggle('alpha')}
            >
              A–Z
            </button>
            <button
              className={`btn sec sm${sort === 'fav' ? ' on' : ''}`}
              title="Favorites first"
              aria-pressed={sort === 'fav'}
              onClick={() => toggle('fav')}
            >
              ★
            </button>
          </>
        )}
      </div>

      {songs.length === 0 ? (
        <div className="empty">
          Nothing yet. Search for a song and either add it — if somebody already downloaded it —
          or download it.
        </div>
      ) : (
        // Twelve compact rows: enough to recognise the library at a glance without the page
        // becoming the list, which is what Show more is for.
        <div className="songrows">
          {(shuffled ? shuffled.slice(0, 11) : songs).map((t, i, list) => (
            <SongRow
              key={t.trackId}
              track={t}
              queue={list}
              index={i}
              label="my library"
              say={say}
              onChanged={() => {
                setShuffled(null);
                load();
              }}
              showRemove
            />
          ))}
          {total > 11 && (
            <Link to={{ name: 'librarysongs' }} className="showall">
              Show more — all {total} songs
            </Link>
          )}
        </div>
      )}

      <LibraryArtists say={say} preview />
      <LibraryAlbums say={say} preview />
    </>
  );
}

/** The full artists listing, split out so the library page stays a glance. */
function LibraryArtistsView({ say }: { say: (k: 'good' | 'bad', t: string) => void }) {
  return <LibraryArtists say={say} />;
}

function LibraryAlbumsView({ say }: { say: (k: 'good' | 'bad', t: string) => void }) {
  return <LibraryAlbums say={say} />;
}

/** The three orderings offered on every library listing. */
function SortPicker({
  value,
  onChange,
  withFav = false,
}: {
  value: LibrarySort;
  onChange: (v: LibrarySort) => void;
  withFav?: boolean;
}) {
  const opts: { v: LibrarySort; label: string }[] = [
    { v: 'alpha', label: 'A–Z' },
    { v: 'plays', label: 'Most played' },
    { v: 'added', label: 'Recently added' },
    // Songs only: favourites and warmth are per-track concerns, so the
    // options would be lies on the artist and album listings.
    ...(withFav
      ? ([
          { v: 'fav', label: '★ Favorites' },
          { v: 'algo', label: 'My algorithm' },
          { v: 'shuffle', label: 'Shuffle' },
        ] as { v: LibrarySort; label: string }[])
      : []),
  ];
  return (
    <div className="sorts">
      {opts.map((o) => (
        <button
          key={o.v}
          className={`sortbtn${value === o.v ? ' on' : ''}`}
          title={
            o.v === 'shuffle'
              ? 'Shuffle the list — press again to deal a different order'
              : undefined
          }
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Page controls, shown only when there is more than one page.
 *
 * Paginating four items would be chrome for its own sake, so the whole strip disappears below
 * the threshold rather than rendering a disabled pair of arrows.
 */
function Pager({
  page,
  per,
  total,
  onPage,
}: {
  page: number;
  per: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.ceil(total / per);
  if (pages <= 1) return null;
  return (
    <div className="pager">
      <button className="btn sec sm" disabled={page === 0} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <span>
        {page + 1} of {pages}
      </span>
      <button className="btn sec sm" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </div>
  );
}

function LibraryArtists({
  say,
  preview = false,
}: {
  say: (k: 'good' | 'bad', t: string) => void;
  /** On the library page: one row of tiles and a Show-more tile, no paging. */
  preview?: boolean;
}) {
  const p = usePlayer();
  const [sort, setSort] = useState<LibrarySort>('alpha');
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ artists: LibraryArtist[]; total: number; per: number } | null>(
    null,
  );
  const per = preview ? 17 : 24;

  const load = useCallback(() => {
    api
      .myArtists({ sort, page, per })
      .then(setData)
      .catch(() => setData({ artists: [], total: 0, per }));
  }, [sort, page, per]);
  useEffect(() => load(), [load]);

  if (!data || data.total === 0) return null;

  return (
    <>
      <div className="sechead">
        <h2>Artists</h2>
        <span className="sub">{data.total}</span>
        <div className="spacer" />
        <SortPicker
          value={sort}
          onChange={(v) => {
            setSort(v);
            setPage(0);
          }}
        />
      </div>
      <div className="gridart">
        {data.artists.map((a) => (
          // ArtistTile rather than a bare Tile: the bare one had no destination, so clicking an
          // artist in your own library did nothing at all. It resolves the name to an mbid on
          // click and opens the artist page, and carries the shared menu.
          <ArtistTile
            key={a.name}
            name={a.name}
            inLibrary
            onChanged={load}
            why={`${a.tracks} track${a.tracks === 1 ? '' : 's'}${
              sort === 'plays' && a.plays ? ` · ${a.plays} plays` : ''
            }`}
            say={say}
            onPlay={() => {
              void api
                .queue({ kind: 'artist', artist: a.name })
                .then((r) => {
                  if (r.tracks.length) p.play(r.tracks.map(playable), 0, a.name);
                })
                .catch((e: Error) => say('bad', e.message));
            }}
          />
        ))}
        {preview && data.total > data.artists.length && (
          <Link to={{ name: 'libraryartists' }} className="showall tileform">
            Show more
            <span className="muted">all {data.total} artists</span>
          </Link>
        )}
      </div>
      {!preview && <Pager page={page} per={data.per} total={data.total} onPage={setPage} />}
    </>
  );
}

function LibraryAlbums({
  say,
  preview = false,
}: {
  say: (k: 'good' | 'bad', t: string) => void;
  preview?: boolean;
}) {
  const p = usePlayer();
  const [sort, setSort] = useState<LibrarySort>('alpha');
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{
    albums: LibraryAlbumRow[];
    total: number;
    per: number;
  } | null>(null);

  const per = preview ? 17 : 24;
  const load = useCallback(() => {
    api
      .myAlbums({ sort, page, per })
      .then(setData)
      .catch(() => setData({ albums: [], total: 0, per }));
  }, [sort, page, per]);
  useEffect(() => load(), [load]);

  if (!data || data.total === 0) return null;

  return (
    <>
      <div className="sechead">
        <h2>Albums</h2>
        <span className="sub">{data.total}</span>
        <div className="spacer" />
        <SortPicker
          value={sort}
          onChange={(v) => {
            setSort(v);
            setPage(0);
          }}
        />
      </div>
      <div className="gridart">
        {data.albums.map((a) => (
          <AlbumTile
            key={`${a.artistName}-${a.albumTitle}`}
            artist={a.artistName}
            album={a.albumTitle}
            mine={a.tracks}
            say={say}
            onChanged={load}
            subtitle={`${a.artistName} · ${a.tracks} track${a.tracks === 1 ? '' : 's'}`}
            onPlay={() => {
              void api
                .queue({ kind: 'album', artist: a.artistName, album: a.albumTitle })
                .then((r) => {
                  if (r.tracks.length) p.play(r.tracks.map(playable), 0, a.albumTitle);
                })
                .catch((e: Error) => say('bad', e.message));
            }}
          />
        ))}
        {preview && data.total > data.albums.length && (
          <Link to={{ name: 'libraryalbums' }} className="showall tileform">
            Show more
            <span className="muted">all {data.total} albums</span>
          </Link>
        )}
      </div>
      {!preview && <Pager page={page} per={data.per} total={data.total} onPage={setPage} />}
    </>
  );
}

/**
 * The full song list: searchable, sortable, paginated.
 *
 * A separate page rather than an expanding section, because at a few thousand tracks the
 * library page would otherwise become one enormous scroll with the artists and albums stranded
 * at the bottom of it.
 */
function LibrarySongsView({ say }: { say: (k: 'good' | 'bad', t: string) => void }) {
  const p = usePlayer();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<LibrarySort>('alpha');
  /**
   * Which deal of the shuffle is on screen.
   *
   * The list is paged and each page is its own request, so the order has to be reproducible or
   * page two would be a different shuffle from page one — the same song twice, another one
   * never. The seed is what makes every page agree, and a new one is what deals again.
   */
  const [seed, setSeed] = useState(1);
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{
    tracks: (MyTrack & { plays: number })[];
    total: number;
    per: number;
  } | null>(null);

  // Debounced, so typing does not fire a query per keystroke against a large library.
  const timer = useRef<number | undefined>(undefined);
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setDebounced(q);
      setPage(0);
    }, 300);
    return () => window.clearTimeout(timer.current);
  }, [q]);

  const load = useCallback(() => {
    api
      .mySongs({ q: debounced, sort, page, per: 60, ...(sort === 'shuffle' ? { seed } : {}) })
      .then(setData)
      .catch(() => setData({ tracks: [], total: 0, per: 60 }));
  }, [debounced, sort, page, seed]);
  useEffect(load, [load]);

  const remove = async (t: MyTrack) => {
    try {
      await api.removeTrack(t.trackId);
      say('good', `Removed ${t.title} — the file is kept and will not be recommended back`);
      load();
    } catch (e) {
      say('bad', (e as Error).message);
    }
  };
  /**
   * Play everything matching, IN THE ORDER ON SCREEN.
   *
   * Everything matching rather than this page of it — paging is how a long list is read, not a
   * choice about what to play — but the sort has to ride along or the queue is a different list
   * from the one being looked at. The endpoint has always taken a sort; this view simply never
   * sent one, so sorting by Most played and pressing play gave you the library alphabetically.
   *
   * `reshuffle` is the Shuffle button beside it: deal a new order, show it, and play that. The
   * screen and the queue stay the same list, which is the whole point of dealing it first.
   */
  const playAll = (opts?: { reshuffle?: boolean }) => {
    const useSort: LibrarySort = opts?.reshuffle ? 'shuffle' : sort;
    const useSeed = opts?.reshuffle ? Math.floor(Math.random() * 1_000_000) + 1 : seed;
    if (opts?.reshuffle) {
      setSeed(useSeed);
      setSort('shuffle');
      setPage(0);
    }
    const params: Record<string, string> = { kind: 'library', sort: useSort };
    if (q.trim()) params.q = q.trim();
    if (useSort === 'shuffle') params.seed = String(useSeed);
    void api
      .queue(params)
      .then((r) =>
        p.play(r.tracks.map(playable), 0, q ? `“${q}”` : 'my library', {
          // A server-side shuffle deal is still a shuffle: the flag goes on, the deal plays
          // as dealt. Any other sort plays in order with the transport flag off.
          shuffle: useSort === 'shuffle' ? 'held' : false,
        }),
      );
  };


  return (
    <>
      <div className="sechead">
        <h2>Songs</h2>
        <span className="sub">{data?.total ?? 0}</span>
        <div className="spacer" />
        <SortPicker
          withFav
          value={sort}
          onChange={(v) => {
            /*
             * Shuffle is the one ordering with no natural sequel: pressing it again can only
             * mean "deal me another one", so it takes a fresh seed every press. Nothing here
             * touches the player — reordering the list you are reading is not a reason to
             * interrupt the song you are listening to.
             */
            if (v === 'shuffle') setSeed(Math.floor(Math.random() * 1_000_000) + 1);
            setSort(v);
            setPage(0);
          }}
        />
      </div>

      <div className="bar" style={{ marginBottom: 12 }}>
        <input
          type="search"
          placeholder="Search your songs…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {data && data.tracks.length > 0 && (
          <>
            <button className="btn sm" onClick={() => playAll()}>
              <IconPlay /> Play these
            </button>
            {/* Shuffle AND play, which is a different act from the Shuffle sort beside the
                heading: that one reorders what you are reading, this one starts the music. */}
            <button
              className="btn sec sm iconable"
              title="Shuffle these and play — press again to deal a different order"
              onClick={() => playAll({ reshuffle: true })}
            >
              <IconShuffle /> <span className="btnword">Shuffle</span>
            </button>
          </>
        )}
      </div>

      {!data ? (
        <div className="spinner">Loading…</div>
      ) : data.tracks.length === 0 ? (
        <div className="empty">{debounced ? `Nothing matching “${debounced}”.` : 'No songs yet.'}</div>
      ) : (
        <>
          <div className="songrows">
            {data.tracks.map((t, i) => (
              <SongRow
                key={t.trackId}
                track={t}
                queue={data.tracks}
                index={i}
                label={q ? `“${q}”` : 'my library'}
                say={say}
                onChanged={load}
                showRemove
              />
            ))}
          </div>
          <Pager page={page} per={data.per} total={data.total} onPage={setPage} />
        </>
      )}
    </>
  );
}

/** The do-not-recommend list, which lived on the old library page. */
function MyExcludes({ say }: { say: (k: 'good' | 'bad', t: string) => void }) {
  const [excl, setExcl] = useState<Exclusion[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.excludes().then((r) => setExcl(r.excludes)).catch(() => setExcl([]));
  }, []);

  const remove = async (e: Exclusion) => {
    setBusy(true);
    try {
      const r = await api.removeExclude(e.kind, e.key);
      staleRecBlocks();
      setExcl(r.excludes);
    } catch (x) {
      say('bad', (x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="rowhead subhead">
        <h3>Not recommended</h3>
        <span className="reason">{excl.length} suppressed</span>
      </div>
      {excl.length === 0 ? (
        <div className="muted sm">
          Nothing suppressed. Use “Don&apos;t recommend” on a song to keep it without letting it
          steer your suggestions — useful for the one track you like that is nothing like the rest.
        </div>
      ) : (
        <div className="bar">
          {excl.map((e) => (
            <button
              key={`${e.kind}:${e.key}`}
              className="btn sec sm"
              disabled={busy}
              title="Click to allow recommendations from this again"
              onClick={() => void remove(e)}
            >
              {e.kind}: {e.label} ✕
            </button>
          ))}
        </div>
      )}
    </>
  );
}


/**
 * The Subsonic streaming password.
 *
 * Most people will never need this: a client that sends the password itself works with the
 * normal crate password. It exists for clients that use Subsonic's token scheme, which
 * requires the server to hold a recoverable secret — so that secret is deliberately a
 * separate one, and the copy explains that rather than leaving somebody to wonder why
 * their crate password "does not work".
 */
function StreamPassword({ say }: { me: Me | null; say: (k: 'good' | 'bad', t: string) => void }) {
  const [pw, setPw] = useState('');
  const [isSet, setIsSet] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.me().then((m) => setIsSet(Boolean(m.streamPasswordSet))).catch(() => setIsSet(null));
  }, []);

  const save = async (clear = false) => {
    setBusy(true);
    try {
      const r = await api.setStreamPassword(clear ? '' : pw);
      setIsSet(r.set);
      setPw('');
      say('good', r.set ? 'Streaming password set' : 'Streaming password cleared');
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="rowhead subhead">
        <h3>Connect a player</h3>
        <span className="reason">Subsonic / OpenSubsonic</span>
      </div>
      <div className="muted sm">
        Point a music app at <code>{window.location.origin}</code> with your crate username and
        password. Only the tracks in your library appear — not everything on the server.
      </div>
      <div className="muted sm">
        If an app rejects your password, it uses Subsonic&apos;s token login, which needs a
        separate password the server can read back. Set one here and use it in that app instead.
        It only ever grants access to your own music — it cannot sign in to crate, change
        settings or request downloads.
        {isSet === true && <> One is set.</>}
      </div>
      <div className="bar">
        <input
          type="password"
          placeholder={isSet ? 'replace streaming password' : 'streaming password'}
          autoComplete="new-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        <button className="btn sm" disabled={busy || pw.length < 8} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Set'}
        </button>
        {isSet && (
          <button className="btn sec sm" disabled={busy} onClick={() => void save(true)}>
            Clear
          </button>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Play bar
// ---------------------------------------------------------------------------

/** mm:ss for the player, which needs it constantly. */
function clock(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/**
 * The fixed bar at the bottom of every page.
 *
 * Rendered by App outside the view switch, alongside the audio element it controls, so
 * navigating never interrupts playback. Hidden entirely until something is queued — an empty
 * transport sitting there is just a band of dead space.
 */
/**
 * The scrubber — the only thing in the player that redraws while a song plays.
 *
 * Its own component so the position context is consumed HERE and nowhere
 * higher: everything else in the play bar, and every row and tile on the page,
 * is left alone four times a second.
 */
function SeekBar({
  abA,
  abB,
  onSeek,
  trackId,
}: {
  abA: number | null;
  abB: number | null;
  onSeek: (s: number) => void;
  /** Only to notice a track change and drop a half-finished drag. */
  trackId: number | undefined;
}) {
  const { position, duration } = usePosition();
  const [scrubbing, setScrubbing] = useState<number | null>(null);

  // A drag released outside the slider never fires its own mouseup, which would
  // leave the bar showing the drag position for the rest of time. Both of these
  // let go of it: a new track, or a mouse button released anywhere.
  useEffect(() => setScrubbing(null), [trackId]);
  useEffect(() => {
    const done = () => setScrubbing(null);
    window.addEventListener('mouseup', done);
    window.addEventListener('touchend', done);
    return () => {
      window.removeEventListener('mouseup', done);
      window.removeEventListener('touchend', done);
    };
  }, []);

  const shown = scrubbing ?? position;
  const pct = duration > 0 ? (shown / duration) * 100 : 0;
  const aPct = abA !== null && duration > 0 ? (abA / duration) * 100 : null;
  const bPct = abB !== null && duration > 0 ? (abB / duration) * 100 : null;

  return (
    <div className="pbseek">
      <span className="muted">{clock(shown)}</span>
      {/* A range input rather than a div: it is keyboard accessible and draggable for
          free, and the A/B markers sit behind it. */}
      <div className="pbtrack">
        <div className="pbfill" style={{ width: `${pct}%` }} />
        {aPct !== null && <div className="pbmark a" style={{ left: `${aPct}%` }} />}
        {bPct !== null && <div className="pbmark b" style={{ left: `${bPct}%` }} />}
        <input
          type="range"
          min={0}
          max={Math.max(1, Math.floor(duration))}
          value={Math.floor(shown)}
          onChange={(e) => setScrubbing(Number(e.target.value))}
          onMouseUp={() => {
            if (scrubbing !== null) onSeek(scrubbing);
            setScrubbing(null);
          }}
          onTouchEnd={() => {
            if (scrubbing !== null) onSeek(scrubbing);
            setScrubbing(null);
          }}
        />
      </div>
      <span className="muted">{clock(duration)}</span>
    </div>
  );
}

/**
 * Five stars, clickable. Clicking the current rating clears it — the only
 * discoverable way to un-rate without a sixth control.
 */
function RatingStars({
  value,
  onRate,
  size = 18,
}: {
  value: number;
  onRate: (n: number) => void;
  size?: number;
}) {
  return (
    <div className="stars" role="radiogroup" aria-label="Rate this song">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          className={`star${n <= value ? ' lit' : ''}`}
          style={{ fontSize: size }}
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n === 1 ? '' : 's'}`}
          onClick={() => onRate(n === value ? 0 : n)}
        >
          {n <= value ? '★' : '☆'}
        </button>
      ))}
    </div>
  );
}

/**
 * The rating of whatever is playing, kept honest across track changes.
 *
 * Fetched per track rather than carried in the queue, because tracks reach
 * the player from a dozen surfaces and only some of them know ratings. A 404
 * (a preview, a track no longer in the library) simply disables the control.
 */
function useCurrentRating(trackId: number | null): [number | null, (n: number) => void] {
  const [rating, setRating] = useState<number | null>(null);
  useEffect(() => {
    setRating(null);
    if (!trackId) return;
    let dead = false;
    api
      .getRating(trackId)
      .then((r) => !dead && setRating(r.rating))
      .catch(() => !dead && setRating(null));
    return () => {
      dead = true;
    };
  }, [trackId]);
  const rate = (n: number) => {
    if (!trackId) return;
    setRating(n);
    void api.setRating(trackId, n).catch(() => setRating(rating));
  };
  return [rating, rate];
}

/**
 * The DJ's insight: what the booth sees, for the curious. Desktop-only by construction (the
 * button that opens it is CSS-gated to fine pointers ≥900px), so this needs no phone variant.
 * Everything in here is read-mostly — the mood chips and the ghost's leanings — plus the two
 * mood-level actions that would otherwise have no home: freeze it as a playlist, forget it.
 */
function DjInsightPanel({
  say,
  onClose,
}: {
  say: (k: 'good' | 'bad', t: string) => void;
  onClose: () => void;
}) {
  const p = usePlayer();
  const [fetched, setFetched] = useState<{ mood: Mood; ghost: Ghost | null } | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * Two sources, freshest wins: the mount-time fetch covers opening the panel cold, and the
   * live snapshot (fed by every vote response) covers voting WHILE the panel is open — the
   * chips move the moment the vote lands, no refetch. The snapshot is newer whenever it
   * exists, because only votes and resets write it.
   */
  const live = useDjMood();
  useEffect(() => {
    void moodNow()
      .then((r) => setFetched({ mood: r.mood, ghost: r.ghost ?? null }))
      .catch(() => setFetched(null));
  }, []);
  const mood = live?.mood ?? fetched?.mood ?? null;
  const ghost = live?.ghost ?? fetched?.ghost ?? null;
  // The promise the skip button keeps — the one queue fact worth reading in here.
  const next = p.queue[p.index + 1] ?? null;

  const chips = (entries: MoodEntry[], klass: string) =>
    entries.map((e) => (
      <span key={`${e.kind}|${e.label}`} className={`djchip ${klass}`}>
        {e.label}
      </span>
    ));

  return (
    <div className="djpanel">
      <div className="djhead">
        <div className="words">
          <div className="t">The DJ&rsquo;s insight</div>
          <div className="s muted">what the votes have taught it</div>
        </div>
        <button className="btn sec sm" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="djbody">
        <div className="djnext muted">
          {next ? (
            <>
              <span className="k">Up next</span> {next.title} — {next.artistName}
            </>
          ) : (
            <span className="k">finding what's next…</span>
          )}
        </div>
        {mood && (mood.into.length > 0 || mood.outOf.length > 0) ? (
          <>
            {mood.into.length > 0 && (
              <div className="djrow">
                <span className="k muted">Leaning into</span>
                {chips(mood.into, 'in')}
              </div>
            )}
            {mood.outOf.length > 0 && (
              <div className="djrow">
                <span className="k muted">Steering away</span>
                {chips(mood.outOf, 'out')}
              </div>
            )}
          </>
        ) : (
          <p className="muted">
            An open mind so far — votes teach it, and what they teach fades over a few hours.
          </p>
        )}
        {/* The ghost: what it should FEEL like, shown only once it has actual say. */}
        {ghost && ghost.say > 0 && ghost.wants.length > 0 && (
          <div className="djrow">
            <span className="k muted">Sounds like</span>
            {ghost.wants.map((w) => (
              <span key={w.key} className={`djchip ${w.high ? 'in' : 'out'}`}>
                {w.high ? '' : 'not '}
                {w.key.replaceAll('_', ' ')}
              </span>
            ))}
            <span className="muted djsay">{Math.round(ghost.say * 100)}% of the choice</span>
          </div>
        )}
        <div className="djactions">
          <button
            className="btn sec sm"
            disabled={busy || !mood || (mood.into.length === 0 && mood.outOf.length === 0)}
            onClick={() => {
              setBusy(true);
              void saveMoodPlaylist()
                .then((r) => say('good', `Saved as “${r.name}” — it deals this vibe forever`))
                .catch((e: Error) => say('bad', e.message))
                .finally(() => setBusy(false));
            }}
          >
            Save as playlist
          </button>
          <button
            className="btn sec sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void resetSession(p)
                .then(() => {
                  setFetched({ mood: { into: [], outOf: [] }, ghost: null });
                  say('good', 'Mood cleared — the DJ starts over from this song');
                })
                .catch((e: Error) => say('bad', e.message))
                .finally(() => setBusy(false));
            }}
          >
            Forget the mood
          </button>
        </div>
      </div>
    </div>
  );
}

function PlayBar({ say }: { say: (k: 'good' | 'bad', t: string) => void }) {
  const p = usePlayer();
  // Registered minus admin-disabled — a toggle removes the button without a refresh.
  const uiPlugins = useUiPlugins();
  /*
   * Which full-height panel is open, if any — lyrics, chords, or a plugin's.
   *
   * One arbiter instead of a boolean per panel, because the booleans made exclusion everyone's
   * job: each button had to remember to close the others, and the coordination was already
   * asymmetric (chords closed lyrics; lyrics left chords standing). Two full-height panels over
   * one play bar is a fight neither wins, and a single slot cannot lose it.
   */
  const [openPanel, setOpenPanel] = useState<string | null>(null);
  const togglePanel = (id: string) => setOpenPanel((cur) => (cur === id ? null : id));
  const [ratePopup, setRatePopup] = useState(false);
  const [rating, rate] = useCurrentRating(p.current?.trackId ?? null);
  const [picking, setPicking] = useState(false);
  const [info, setInfo] = useState(false);
  // The DJ: session flag re-renders the cluster on start/stop; busy debounces double-taps.
  const djActive = useDjActive();
  // The thumb you pressed stays lit while this song plays (and again if you come back to it).
  const djVote = useDjVote(p.current?.trackId ?? null);
  const [djBusy, setDjBusy] = useState(false);
  const castVote = (direction: 'more' | 'less') => {
    if (djBusy) return;
    setDjBusy(true);
    void voteFromBar(p, direction)
      .then((r) => {
        // Artist, a genre or two, the decade: the vote's reach in one line.
        const what = [
          r.applied.artist,
          ...r.applied.genres.slice(0, 2),
          ...(r.applied.era ? [r.applied.era] : []),
        ].join(', ');
        say('good', direction === 'more' ? `More like: ${what}` : `Less like: ${what}`);
      })
      .catch((e: Error) => say('bad', e.message))
      .finally(() => setDjBusy(false));
  };
  // Somebody clicked a song in a plugin's list: they wanted the panel, not just the song.
  // Collected here rather than pushed, because this component may not have existed at the time —
  // see plugins/runtime.ts.
  const currentId = p.current?.trackId ?? 0;
  useEffect(() => {
    const id = consumePanelRequest();
    if (id) setOpenPanel(id);
  }, [currentId]);
  // Where the volume was before a mute, so unmuting restores rather than
  // guessing. A ref, not state: nothing renders from it.
  const preMute = useRef(0.7);
  if (!p.current) return null;

  const muted = p.volume <= 0;
  const toggleMute = () => {
    if (muted) {
      p.setVolume(preMute.current || 0.7);
    } else {
      preMute.current = p.volume;
      p.setVolume(0);
    }
  };

  // A mode label rather than a glyph: an icon cannot say which of the three states it is in,
  // and that is the only thing somebody needs from this button.
  const abLabel = p.abA === null ? 'A–B' : p.abB === null ? 'set B' : 'on';

  return (
    <div className="playbar">
      {/* The whole now-playing block opens the album page — the natural answer
          to "what else is on this record?" while it plays. */}
      <div
        className="pbnow"
        style={p.current.albumTitle ? { cursor: 'pointer' } : undefined}
        onClick={() => {
          if (!p.current) return;
          if (p.current.albumTitle) {
            navigate({
              name: 'albumpage',
              artist: p.current.artistName,
              album: p.current.albumTitle,
            });
          }
        }}
      >
        <Art
          images={{
            poster: `/api/art/album?artist=${encodeURIComponent(p.current.artistName)}&album=${encodeURIComponent(p.current.albumTitle)}`,
          }}
          label={p.current.title}
        />
        <div className="pbmeta">
          <div className="t">{p.current.title}</div>
          <div className="s muted">
            {p.current.artistName}
            {p.current.albumTitle ? ` · ${p.current.albumTitle}` : ''}
          </div>
          {p.source && <div className="s muted">from {p.source}</div>}
        </div>
      </div>

      <div className="pbmain">
        <div className="pbbuttons">
          <button
            className={`pbicon${p.shuffle ? ' on' : ''}`}
            title="Shuffle"
            onClick={p.toggleShuffle}
          >
            <IconShuffle />
          </button>
          <button className="pbicon" title="Previous" onClick={p.prev}>
            <IconPrev />
          </button>
          <button className="pbicon big" title={p.playing ? 'Pause' : 'Play'} onClick={p.toggle}>
            {p.playing ? <IconPause /> : <IconPlay />}
          </button>
          <button className="pbicon" title="Next" onClick={() => p.next(true)}>
            <IconNext />
          </button>
          <button
            className={`pbicon${p.repeat !== 'off' ? ' on' : ''}`}
            title={
              p.repeat === 'off' ? 'Repeat off' : p.repeat === 'all' ? 'Repeat queue' : 'Repeat one'
            }
            onClick={p.cycleRepeat}
          >
            {p.repeat === 'one' ? <IconRepeatOne /> : <IconRepeat />}
          </button>
          <button
            className={`pbicon ab${p.abA !== null ? ' on' : ''}`}
            title="A–B repeat: press for A, again for B, again to clear"
            onClick={p.markAb}
          >
            <IconAb />
            <span>{abLabel}</span>
          </button>
          {/*
            * THE DJ, whole UX. While shuffle is on, two votes live right here in the transport
            * row — the one cluster every display regime shows (.pbside dies under 760px and on
            * touch, .pbtouch only exists on touch). The first vote silently starts a DJ session;
            * the only sign one is running is the End button appearing. Reset and Insight are
            * desktop extras, hidden by CSS below 900px/coarse pointers. See dj.tsx for the rules.
            */}
          {p.shuffle && (
            <div className="pbdj">
              <button
                className={`pbicon down${djVote === 'less' ? ' on' : ''}`}
                title="Less like this"
                disabled={djBusy}
                onClick={() => castVote('less')}
              >
                <IconThumbDown />
                <span className="lbl">Less like this</span>
              </button>
              <button
                className={`pbicon up${djVote === 'more' ? ' on' : ''}`}
                title="More like this"
                disabled={djBusy}
                onClick={() => castVote('more')}
              >
                <IconThumbUp />
                <span className="lbl">More like this</span>
              </button>
              {djActive && (
                <>
                  <button className="pbicon end" title="End DJ session" onClick={endSession}>
                    <IconDjEnd />
                    <span className="lbl">End DJ session</span>
                  </button>
                  <button
                    className="pbicon lg"
                    title="Reset DJ session — fresh ears, keep playing"
                    disabled={djBusy}
                    onClick={() => {
                      setDjBusy(true);
                      void resetSession(p)
                        .then(() => say('good', 'The DJ starts over from this song'))
                        .catch((e: Error) => say('bad', e.message))
                        .finally(() => setDjBusy(false));
                    }}
                  >
                    <IconDjReset />
                    <span className="lbl">Reset</span>
                  </button>
                  <button
                    className={`pbicon lg${openPanel === 'dj' ? ' on' : ''}`}
                    title="The DJ's insight"
                    onClick={() => togglePanel('dj')}
                  >
                    <IconInsight />
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <SeekBar abA={p.abA} abB={p.abB} onSeek={p.seek} trackId={p.current?.trackId} />

        {/* Desktop-only underline row: volume where the pointer already lives,
            queue position spelled out. Touch devices hide it — iOS owns the
            volume, and the count earns no space on a phone. */}
        <div className="pbsub">
          <div className="pbvolume">
            <button
              className="pbicon sm"
              title={muted ? 'Unmute' : 'Mute'}
              onClick={toggleMute}
            >
              {muted ? (
                <IconVolumeMute />
              ) : (
                <IconVolume level={p.volume < 0.5 ? 'low' : 'high'} />
              )}
            </button>
            {/* Same anatomy as the scrubber — track, fill, invisible range on
                top — so the two sliders read as one family. */}
            <div className="pbtrack vol">
              <div className="pbfill" style={{ width: `${Math.round(p.volume * 100)}%` }} />
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(p.volume * 100)}
                title="Volume"
                onChange={(e) => p.setVolume(Number(e.target.value) / 100)}
              />
            </div>
          </div>
          <span className="pbcount">
            {/* "of 12" is a lie during a DJ session — the queue refills itself, so there is
                no y. Say what is true instead: how deep into the session this song is. */}
            {djActive
              ? `DJ session · song ${p.index + 1}`
              : `Track ${p.index + 1} of ${p.queue.length}`}
          </span>
        </div>
      </div>

      <div className="pbside">
        {rating !== null && <RatingStars value={rating} onRate={rate} size={15} />}
        {/* The song playing is the one you most often want to know about, and until now the
            only route to its details was finding the row it came from — which for a DJ or
            shuffle queue may not be on screen at all. */}
        <button className="pbicon" title="Song info" onClick={() => setInfo(true)}>
          <IconInfo />
        </button>
        {/* What is playing is the thing you most often want to keep. */}
        <button className="pbicon" title="Add to a playlist" onClick={() => setPicking(true)}>
          <IconPlus />
        </button>
        <button
          className={`pbicon${openPanel === 'lyrics' ? ' on' : ''}`}
          title="Lyrics"
          onClick={() => togglePanel('lyrics')}
        >
          <IconLyrics />
        </button>
        {/* Plugin panels: one button each, same arbiter. Registry order is display order. */}
        {uiPlugins.map(
          (pl) =>
            pl.playbar && (
              <button
                key={pl.id}
                className={`pbicon${openPanel === pl.id ? ' on' : ''}`}
                title={pl.playbar.title}
                onClick={() => togglePanel(pl.id)}
              >
                <pl.playbar.icon />
              </button>
            ),
        )}
      </div>

      {/* The volume cluster is hidden on touch devices, so phones get their own
          buttons, floated at the top right of the player pane. A flex row rather
          than per-button pixel offsets, so a new panel button costs no CSS. */}
      <div className="pbtouch">
        {rating !== null && (
          <button
            className={`pbicon ratebtn-touch${(rating ?? 0) > 0 ? ' on' : ''}`}
            title="Rate this song"
            aria-label={rating ? `Rated ${rating} of 5 — change rating` : 'Rate this song'}
            onClick={() => setRatePopup(true)}
          >
            {(rating ?? 0) > 0 ? '★' : '☆'}
          </button>
        )}
        <button
          className="pbicon"
          title="Song info"
          aria-label="Song info"
          onClick={() => setInfo(true)}
        >
          <IconInfo />
        </button>
        <button
          className="pbicon"
          title="Add to a playlist"
          aria-label="Add to a playlist"
          onClick={() => setPicking(true)}
        >
          <IconPlus />
        </button>
        {uiPlugins.map(
          (pl) =>
            pl.playbar && (
              <button
                key={pl.id}
                className={`pbicon${openPanel === pl.id ? ' on' : ''}`}
                title={pl.playbar.title}
                aria-label={pl.playbar.title}
                onClick={() => togglePanel(pl.id)}
              >
                <pl.playbar.icon />
              </button>
            ),
        )}
        <button
          className={`pbicon${openPanel === 'lyrics' ? ' on' : ''}`}
          title="Lyrics"
          aria-label="Lyrics"
          onClick={() => togglePanel('lyrics')}
        >
          <IconLyrics />
        </button>
      </div>
      {ratePopup &&
        createPortal(
          // A dialog, not a panel: five choices, one tap, gone. Clicking
          // anywhere else is a cancel, because a rating is never mandatory.
          <div className="ratepop-back" onClick={() => setRatePopup(false)}>
            <div className="ratepop" onClick={(e) => e.stopPropagation()}>
              <div className="t">{p.current?.title}</div>
              <RatingStars
                value={rating ?? 0}
                size={30}
                onRate={(n) => {
                  rate(n);
                  setRatePopup(false);
                }}
              />
            </div>
          </div>,
          document.body,
        )}

      {/* Portalled to <body>: the playbar's backdrop-filter makes it the
          containing block for fixed descendants, so a panel rendered inside it
          positions against the BAR, not the screen — it appeared squashed
          inside the player on every device. The picker is portalled for the
          same reason. */}
      {/* Portalled for the reason directly above: rendered inside the bar, the modal positioned
          against the BAR rather than the viewport and hung half off the bottom of the screen. */}
      {info &&
        p.current &&
        createPortal(
          <TrackInfoModal trackId={p.current.trackId} onClose={() => setInfo(false)} />,
          document.body,
        )}
      {openPanel === 'lyrics' &&
        createPortal(<LyricsPanel onClose={() => setOpenPanel(null)} />, document.body)}
      {openPanel === 'dj' &&
        createPortal(<DjInsightPanel say={say} onClose={() => setOpenPanel(null)} />, document.body)}
      {uiPlugins.map(
        (pl) =>
          pl.playbar &&
          openPanel === pl.id &&
          p.current &&
          createPortal(
            <pl.playbar.Panel
              key={pl.id}
              trackId={p.current.trackId}
              title={p.current.title}
              artistName={p.current.artistName}
              say={say}
              onClose={() => setOpenPanel(null)}
            />,
            document.body,
          ),
      )}
      {picking &&
        p.current &&
        createPortal(
          <PlaylistPicker
            title={`“${p.current.title}”`}
            say={say}
            onClose={() => setPicking(false)}
            onPick={async (id, name) => {
              if (!p.current) return;
              await api.addToPlaylist(id, [p.current.trackId]);
              say('good', `Added ${p.current.title} to ${name}`);
            }}
          />,
          document.body,
        )}
    </div>
  );
}

/** One parsed LRC line, or a rendered gap between them. */
type LyricEntry =
  | { kind: 'line'; t: number; text: string }
  | { kind: 'gap'; t: number; until: number };

/**
 * Parse LRC text: `[mm:ss.xx]words`, possibly several timestamps per line.
 * Untimed lines (plain lyrics) come back with t = -1.
 */
function parseLrc(text: string): { lines: { t: number; text: string }[]; timed: boolean } {
  const out: { t: number; text: string }[] = [];
  let sawTime = false;
  for (const raw of text.split('\n')) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const words = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!stamps.length) {
      if (words) out.push({ t: -1, text: words });
      continue;
    }
    sawTime = true;
    for (const m of stamps) {
      out.push({ t: Number(m[1]) * 60 + Number(m[2]), text: words });
    }
  }
  if (sawTime) out.sort((a, b) => a.t - b.t);
  return { lines: out, timed: sawTime };
}

/**
 * The lyrics panel: a side sheet on desktop (maximisable), the whole screen
 * above the play bar on a phone.
 *
 * Synced lyrics follow the song: the active line is highlighted and kept
 * centred, tapping a line seeks to it, and an instrumental gap longer than a
 * few seconds renders as three dots that fill as the gap elapses — the wait
 * made visible, borrowed shamelessly from Apple Music. Scrolling by hand
 * pauses the auto-follow briefly so reading ahead is not a fight.
 */
function LyricsPanel({ onClose }: { onClose: () => void }) {
  const p = usePlayer();
  // A leaf panel, mounted only while open: consuming the fast context here is
  // the point — the lines must follow the song.
  const { position } = usePosition();
  const [data, setData] = useState<{ synced: boolean; text: string | null } | 'loading'>('loading');
  const [max, setMax] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLDivElement | null>(null);
  // Timestamp until which the auto-scroll yields to the human.
  const handsOff = useRef(0);

  const trackId = p.current?.trackId ?? 0;
  useEffect(() => {
    if (!trackId) return;
    setData('loading');
    api
      .lyrics(trackId)
      .then(setData)
      .catch(() => setData({ synced: false, text: null }));
  }, [trackId]);

  const parsed = useMemo(() => {
    if (data === 'loading' || !data.text) return null;
    return parseLrc(data.text);
  }, [data]);

  // Interleave dot-gaps into the timed lines once, not per render.
  const entries = useMemo<LyricEntry[] | null>(() => {
    if (!parsed?.timed) return null;
    const out: LyricEntry[] = [];
    let last = 0;
    for (const l of parsed.lines) {
      if (l.t - last > 6 && (out.length === 0 || l.text !== '')) {
        out.push({ kind: 'gap', t: last, until: l.t });
      }
      if (l.text !== '') out.push({ kind: 'line', t: l.t, text: l.text });
      last = l.t;
    }
    return out;
  }, [parsed]);

  // The entry currently being sung (or waited through).
  const activeIdx = useMemo(() => {
    if (!entries) return -1;
    let idx = -1;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e && e.t <= position + 0.25) idx = i;
      else break;
    }
    return idx;
  }, [entries, position]);

  useEffect(() => {
    if (Date.now() < handsOff.current) return;
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIdx]);

  return (
    <div className={`lyricspanel${max ? ' max' : ''}`}>
      <div className="lyricshead">
        <div className="words">
          <div className="t">{p.current?.title}</div>
          <div className="s muted">{p.current?.artistName}</div>
        </div>
        <button
          className="btn sec sm lyricsmax"
          title={max ? 'Restore' : 'Maximise'}
          onClick={() => setMax((m) => !m)}
        >
          {max ? '⤢' : '⤡'}
        </button>
        <button className="btn sec sm" onClick={onClose}>
          Close
        </button>
      </div>

      <div
        className="lyricsbody"
        ref={listRef}
        onWheel={() => {
          handsOff.current = Date.now() + 4000;
        }}
        onTouchMove={() => {
          handsOff.current = Date.now() + 4000;
        }}
      >
        {data === 'loading' && <div className="spinner">Finding the words…</div>}
        {data !== 'loading' && !data.text && (
          <div className="muted lyricsnone">No lyrics found for this song.</div>
        )}

        {/* Synced: the show. */}
        {entries &&
          entries.map((e, i) => {
            const active = i === activeIdx;
            if (e.kind === 'gap') {
              // How far through the wait we are, driving the three dots.
              const span = Math.max(e.until - e.t, 0.001);
              const done = Math.min(Math.max((position - e.t) / span, 0), 1);
              return (
                <div
                  key={`gap-${i}`}
                  ref={active ? activeRef : undefined}
                  className={`lyricgap${active ? ' active' : ''}`}
                >
                  {[0, 1, 2].map((d) => (
                    <span
                      key={d}
                      className="dot"
                      style={
                        active
                          ? { opacity: 0.25 + 0.75 * Math.min(Math.max(done * 3 - d, 0), 1) }
                          : undefined
                      }
                    />
                  ))}
                </div>
              );
            }
            return (
              <div
                key={`${e.t}-${i}`}
                ref={active ? activeRef : undefined}
                className={`lyricline${active ? ' active' : ''}${e.t <= position ? ' sung' : ''}`}
                onClick={() => p.seek(e.t)}
              >
                {e.text}
              </div>
            );
          })}

        {/* Plain lyrics: still worth showing, just without the choreography. */}
        {parsed && !parsed.timed && (
          <div className="lyricsplain">
            {parsed.lines.map((l, i) => (
              <div key={i} className="lyricline plain">
                {l.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


/**
 * A row of songs with a play button, used by every shelf on the home page.
 *
 * Clicking any row plays the whole list from that point, which is what people expect from a
 * list of songs and saves building a queue by hand.
 */
function TrackTable({
  tracks,
  label,
  say,
  showPlays,
  onRemove,
}: {
  tracks: (MyTrack & { plays?: number })[];
  label: string;
  say: (k: 'good' | 'bad', t: string) => void;
  showPlays?: boolean;
  onRemove?: (t: MyTrack) => void;
}) {
  const p = usePlayer();
  const [adding, setAdding] = useState<MyTrack | null>(null);

  if (!tracks.length) return null;
  return (
    <>
      <table className="list">
        <thead>
          <tr>
            <th style={{ width: 34 }}>&nbsp;</th>
            <th>Song</th>
            <th>Artist</th>
            <th>Album</th>
            {showPlays && <th>Plays</th>}
            <th>Length</th>
            <th style={{ textAlign: 'right' }}>&nbsp;</th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((t, i) => {
            const isCurrent = p.current?.trackId === t.trackId;
            return (
              <tr key={t.trackId} className={isCurrent ? 'playing' : undefined}>
                <td>
                  <button
                    className="pbicon sm"
                    title={`Play from here (${label})`}
                    onClick={() => p.play(tracks.map(playable), i, label)}
                  >
                    {isCurrent && p.playing ? <IconPause /> : <IconPlay />}
                  </button>
                </td>
                <td>{t.title}</td>
                <td className="muted">{t.artistName}</td>
                <td className="muted">{t.albumTitle}</td>
                {showPlays && <td className="muted">{t.plays ?? 0}</td>}
                <td className="muted">{secs(t.durationS)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn sec sm" title="Add to a playlist" onClick={() => setAdding(t)}>
                    +
                  </button>
                  {onRemove && (
                    <>
                      {' '}
                      <button className="btn sec sm" onClick={() => onRemove(t)}>
                        Remove
                      </button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {adding && (
        <AddToPlaylist track={adding} say={say} onClose={() => setAdding(null)} />
      )}
    </>
  );
}

/** Pick a playlist for a track, or make one on the spot. */
function AddToPlaylist({
  track,
  say,
  onClose,
}: {
  track: MyTrack;
  say: (k: 'good' | 'bad', t: string) => void;
  onClose: () => void;
}) {
  const [lists, setLists] = useState<Playlist[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.playlists().then((r) => setLists(r.playlists)).catch(() => setLists([]));
  }, []);

  const addTo = async (id: number) => {
    setBusy(true);
    try {
      await api.addToPlaylist(id, [track.trackId]);
      say('good', `Added ${track.title}`);
      onClose();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createAndAdd = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const r = await api.createPlaylist(name.trim());
      await api.addToPlaylist(r.id, [track.trackId]);
      say('good', `Created ${name.trim()} with ${track.title}`);
      onClose();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hookedit">
      <div className="muted sm">Add “{track.title}” to a playlist</div>
      <div className="bar" style={{ marginTop: 8 }}>
        {(lists ?? []).map((l) => (
          <button key={l.id} className="btn sec sm" disabled={busy} onClick={() => void addTo(l.id)}>
            {l.name} ({l.tracks})
          </button>
        ))}
      </div>
      <div className="bar" style={{ marginTop: 8 }}>
        <input placeholder="new playlist" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn sm" disabled={busy || !name.trim()} onClick={() => void createAndAdd()}>
          Create and add
        </button>
        <button className="btn sec sm" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

function PlaylistsView({ say }: { say: (k: 'good' | 'bad', t: string) => void }) {
  const [lists, setLists] = useState<Playlist[] | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    api.playlists().then((r) => setLists(r.playlists)).catch(() => setLists([]));
  }, []);
  useEffect(load, [load]);

  if (!lists) return <div className="spinner">Loading playlists…</div>;

  return (
    <>
      <div className="rowhead">
        <h2>Playlists</h2>
        <span className="reason">{lists.length}</span>
        <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>
          New playlist
        </button>
      </div>

      {creating && <NewPlaylistModal say={say} onClose={() => setCreating(false)} />}

      {lists.length === 0 ? (
        <div className="empty">
          No playlists yet. Make one here, or use the + button beside any song.
        </div>
      ) : (
        // Tiles rather than rows: every playlist now has a cover, and the whole point of
        // generating one is that the list is something you recognise by sight.
        <div className="gridart">
          {lists.map((l) => (
            <PlaylistTile key={l.id} pl={l} say={say} />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * One door, two rooms: Manual is name-and-description, AI Assisted is a single prompt and
 * the model handles the rest — name, description, songs. Separate tabs rather than blended
 * fields, because "leave the name blank to let the AI choose" made one form answer two
 * different questions at once. Either way the finish line is the new playlist's own page.
 */
/**
 * The dynamic-recipe picker, shared by the New Playlist modal and the edit form on a
 * playlist's own page — one implementation, so the two can never drift into disagreeing
 * about what a recipe looks like.
 *
 * `initial` pre-selects from an existing recipe, which is what makes editing possible;
 * the parent reads the current selection back through `onChange`.
 */
function useRecipeBuilder(initial?: PlaylistRules | null) {
  const [vocab, setVocab] = useState<GenreVocab | null>(null);
  const [pickedGenres, setPickedGenres] = useState<Set<string>>(
    () => new Set((initial?.terms ?? []).filter((t) => t.kind === 'genre').map((t) => t.key)),
  );
  const [pickedFamilies, setPickedFamilies] = useState<Set<string>>(
    () => new Set((initial?.terms ?? []).filter((t) => t.kind === 'style').map((t) => t.key)),
  );
  const [pickedEras, setPickedEras] = useState<Set<number>>(
    () => new Set((initial?.terms ?? []).filter((t) => t.kind === 'era').map((t) => Number(t.key))),
  );
  const [energy, setEnergy] = useState<'' | 'chill' | 'medium' | 'high'>(
    () => ((initial?.terms ?? []).find((t) => t.kind === 'energy')?.key as 'chill' | 'medium' | 'high') ?? '',
  );
  /*
   * Characteristics as dimension -> band. A Map rather than two Sets because a dimension can
   * only be in one band at a time and the chip cycles through off → high → low; two Sets would
   * let a saved recipe contain both and leave the UI unable to draw it.
   */
  const [pickedChars, setPickedChars] = useState<Map<string, 'high' | 'low'>>(() => {
    const m = new Map<string, 'high' | 'low'>();
    for (const t of initial?.terms ?? []) {
      if (t.kind !== 'char') continue;
      const [dim, side] = t.key.split('|');
      if (dim && (side === 'high' || side === 'low')) m.set(dim, side);
    }
    return m;
  });
  const [limit, setLimit] = useState(initial?.limit ?? 50);

  const load = useCallback(() => {
    if (!vocab) {
      api
        .genres()
        .then(setVocab)
        .catch(() =>
          setVocab({
            genres: [],
            families: [],
            eras: [],
            energyReady: false,
            characteristics: [],
            charAnalysed: 0,
            charTotal: 0,
            charsReady: false,
          }),
        );
    }
  }, [vocab]);

  const termCount =
    pickedGenres.size + pickedFamilies.size + pickedEras.size + (energy ? 1 : 0) + pickedChars.size;

  const build = (): PlaylistRules => {
    const terms: RuleTerm[] = [];
    for (const g of pickedGenres) terms.push({ kind: 'genre', key: g, weight: 2.5, label: g });
    for (const f of pickedFamilies) {
      terms.push({ kind: 'style', key: f, weight: 2, label: vocab?.families.find((x) => x.id === f)?.label ?? f });
    }
    for (const e of pickedEras) terms.push({ kind: 'era', key: String(e), weight: 1.5, label: `${e}s` });
    if (energy) terms.push({ kind: 'energy', key: energy, weight: 1.5, label: `${energy} energy` });
    for (const [dim, side] of pickedChars) {
      const name = vocab?.characteristics.find((c) => c.key === dim)?.name ?? dim;
      // Weighted with era and energy: a feel shapes the running order, it does not decide
      // what the music is. Matches CHAR_CLAMP's reasoning on the server.
      terms.push({
        kind: 'char',
        key: `${dim}|${side}`,
        weight: 1.5,
        label: side === 'high' ? `high ${name.toLowerCase()}` : `low ${name.toLowerCase()}`,
      });
    }
    return { v: 1, terms, limit };
  };

  return {
    vocab,
    load,
    termCount,
    build,
    state: { pickedGenres, setPickedGenres, pickedFamilies, setPickedFamilies, pickedEras, setPickedEras, energy, setEnergy, pickedChars, setPickedChars, limit, setLimit },
  };
}

type RecipeState = ReturnType<typeof useRecipeBuilder>;

/**
 * Song-characteristic chips: how the music should FEEL, on top of what it is.
 *
 * Each chip cycles off → high → low, so one control covers both directions of a dimension and
 * fifty-five dimensions do not become a hundred and ten chips. The ten the taxonomy weights
 * highest are shown; the rest sit behind a disclosure, grouped, because a wall of chips is not
 * a choice.
 *
 * High and low are the top and bottom THIRD of this library on that dimension, not a fixed
 * score — see CHAR_BAND_FRACTION in lib/dynamicpl.ts for the measurements that forced that.
 */
function CharacteristicFields({ recipe }: { recipe: RecipeState }) {
  const { vocab, state } = recipe;
  const [showAll, setShowAll] = useState(false);
  if (!vocab) return null;

  const cycle = (key: string) => {
    const next = new Map(state.pickedChars);
    const now = next.get(key);
    if (now === undefined) next.set(key, 'high');
    else if (now === 'high') next.set(key, 'low');
    else next.delete(key);
    state.setPickedChars(next);
  };

  const chip = (c: { key: string; name: string }) => {
    const band = state.pickedChars.get(c.key);
    return (
      <button
        key={c.key}
        className={`pchip${band ? ` on ${band}` : ''}`}
        /*
         * Phrased as "most/least X" rather than an inflected adjective: the taxonomy has
         * fifty-five names and English will not decline them all. The first attempt built
         * `${name}est` and produced "the darknessest third of your library".
         */
        title={
          band === 'high'
            ? `The third of your library with the most ${c.name.toLowerCase()} — click for the least`
            : band === 'low'
              ? `The third with the least ${c.name.toLowerCase()} — click again to clear`
              : `Click for the most ${c.name.toLowerCase()}, again for the least`
        }
        onClick={() => cycle(c.key)}
      >
        {band === 'high' ? '↑ ' : band === 'low' ? '↓ ' : ''}
        {c.name}
      </button>
    );
  };

  const prominent = vocab.characteristics.filter((c) => c.prominent);
  const rest = vocab.characteristics.filter((c) => !c.prominent);
  const groups = [...new Map(rest.map((c) => [c.group, c.groupLabel])).entries()];

  return (
    <label>
      <span className="lbl">
        Feel{' '}
        <em className="muted">
          {vocab.charAnalysed} of {vocab.charTotal} songs analysed
        </em>
      </span>
      <div className="chiprow">{prominent.map(chip)}</div>
      {rest.length > 0 && (
        <button className="linkish" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Fewer' : `All ${vocab.characteristics.length} characteristics`}
        </button>
      )}
      {showAll &&
        groups.map(([group, label]) => (
          <div key={group} className="chargroup">
            <span className="muted">{label}</span>
            <div className="chiprow">{rest.filter((c) => c.group === group).map(chip)}</div>
          </div>
        ))}
    </label>
  );
}

/** The chips themselves. Dumb: everything it needs comes from useRecipeBuilder. */
function RecipeFields({ recipe }: { recipe: RecipeState }) {
  const { vocab, state } = recipe;
  const toggle = <T,>(set: Set<T>, value: T, update: (s: Set<T>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    update(next);
  };

  if (!vocab) return <div className="spinner">Reading your library…</div>;

  return (
    <>
      <label>
        <span className="lbl">Styles</span>
        <div className="chiprow">
          {vocab.families.map((f) => (
            <button
              key={f.id}
              className={`pchip${state.pickedFamilies.has(f.id) ? ' on' : ''}`}
              onClick={() => toggle(state.pickedFamilies, f.id, state.setPickedFamilies)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </label>
      <label>
        <span className="lbl">Genres</span>
        <div className="chiprow">
          {vocab.genres.slice(0, 28).map((g) => (
            <button
              key={g.name}
              className={`pchip${state.pickedGenres.has(g.name) ? ' on' : ''}`}
              title={`${g.count} tracks`}
              onClick={() => toggle(state.pickedGenres, g.name, state.setPickedGenres)}
            >
              {g.name}
            </button>
          ))}
        </div>
      </label>
      {vocab.eras.length > 0 && (
        <label>
          <span className="lbl">Eras</span>
          <div className="chiprow">
            {vocab.eras.map((e) => (
              <button
                key={e}
                className={`pchip${state.pickedEras.has(e) ? ' on' : ''}`}
                onClick={() => toggle(state.pickedEras, e, state.setPickedEras)}
              >
                {e}s
              </button>
            ))}
          </div>
        </label>
      )}
      {vocab.energyReady && (
        <label>
          <span className="lbl">Energy</span>
          <div className="seg" role="group" aria-label="Energy">
            {(['', 'chill', 'medium', 'high'] as const).map((e) => (
              <button
                key={e || 'any'}
                className={`segbtn${state.energy === e ? ' on' : ''}`}
                onClick={() => state.setEnergy(e)}
              >
                {e === '' ? 'Any' : e[0]!.toUpperCase() + e.slice(1)}
              </button>
            ))}
          </div>
        </label>
      )}
      {vocab.charsReady && <CharacteristicFields recipe={recipe} />}
      <label>
        <span className="lbl">Songs per deal</span>
        <div className="seg" role="group" aria-label="Length">
          {[25, 50, 100].map((n) => (
            <button
              key={n}
              className={`segbtn${state.limit === n ? ' on' : ''}`}
              onClick={() => state.setLimit(n)}
            >
              {n}
            </button>
          ))}
        </div>
      </label>
    </>
  );
}

function NewPlaylistModal({ say, onClose }: { say: (k: 'good' | 'bad', t: string) => void; onClose: () => void }) {
  const [tab, setTab] = useState<'manual' | 'dynamic' | 'ai'>('manual');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const recipe = useRecipeBuilder();

  const ai = tab === 'ai';
  const dynamic = tab === 'dynamic';
  const ready = ai
    ? prompt.trim().length >= 4
    : dynamic
      ? Boolean(name.trim()) && recipe.termCount > 0
      : Boolean(name.trim());

  // The vocabulary loads once, when the Dynamic tab is first opened.
  useEffect(() => {
    if (dynamic) recipe.load();
  }, [dynamic, recipe]);

  const buildRules = recipe.build;

  const go = async () => {
    setBusy(true);
    try {
      if (ai) {
        const r = await api.aiPlaylist(prompt.trim());
        say('good', `Built "${r.name}" — ${r.added} tracks`);
        navigate({ name: 'playlist', id: r.id });
      } else if (dynamic) {
        const r = await api.createPlaylist(name.trim(), buildRules());
        if (desc.trim()) await api.describePlaylist(r.id, desc.trim());
        say('good', `Created ${name.trim()} — it deals fresh songs every time`);
        navigate({ name: 'playlist', id: r.id });
      } else {
        const r = await api.createPlaylist(name.trim());
        if (desc.trim()) await api.describePlaylist(r.id, desc.trim());
        say('good', `Created ${name.trim()}`);
        navigate({ name: 'playlist', id: r.id });
      }
      onClose();
    } catch (e) {
      say('bad', (e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title="New playlist" onClose={onClose}>
      <div className="pledit">
        <div className="seg" role="group" aria-label="How to create">
          {(['manual', 'dynamic', 'ai'] as const).map((t) => (
            <button
              key={t}
              className={`segbtn${tab === t ? ' on' : ''}`}
              aria-pressed={tab === t}
              disabled={busy}
              onClick={() => setTab(t)}
            >
              {t === 'manual' ? 'Manual' : t === 'dynamic' ? 'Dynamic' : 'AI Assisted'}
            </button>
          ))}
        </div>

        {!ai && (
          <>
            <label>
              <span className="lbl">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                placeholder={dynamic ? 'e.g. Heavy Nineties' : 'e.g. Sunday morning'}
                autoFocus
              />
            </label>
            <label>
              <span className="lbl">Description (optional)</span>
              <textarea
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                maxLength={300}
                rows={2}
                placeholder="What is this playlist for?"
              />
            </label>
          </>
        )}

        {dynamic && (
          <>
            <p className="muted" style={{ margin: 0, fontSize: '0.82rem' }}>
              A dynamic playlist stores a recipe, not songs — every time it opens it deals a
              fresh set from your library that fits.
            </p>
            <RecipeFields recipe={recipe} />
          </>
        )}

        <div className="bar">
          <button className="btn sm" disabled={busy || !ready} onClick={() => void go()}>
            {busy ? (ai ? 'Reading your library…' : 'Creating…') : ai ? 'Build playlist' : 'Create playlist'}
          </button>
          <button className="btn sec sm" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The edit form for one playlist. Its own component so the recipe builder can be seeded
 * from the playlist's CURRENT rules at mount — a hook cannot pick up its initial value
 * later, and the playlist arrives asynchronously.
 */
function PlaylistEditor({
  pl,
  draftName,
  setDraftName,
  draftDesc,
  setDraftDesc,
  busy,
  onSave,
  onDelete,
  say,
  onChanged,
}: {
  pl: Playlist;
  draftName: string;
  setDraftName: (v: string) => void;
  draftDesc: string;
  setDraftDesc: (v: string) => void;
  busy: boolean;
  onSave: () => Promise<void>;
  onDelete: () => Promise<void>;
  say: (k: 'good' | 'bad', t: string) => void;
  onChanged: () => void;
}) {
  const initial = useMemo<PlaylistRules | null>(() => {
    if (!pl.rules) return null;
    try {
      return JSON.parse(pl.rules) as PlaylistRules;
    } catch {
      return null;
    }
  }, [pl.rules]);
  const recipe = useRecipeBuilder(initial);
  const [savingRecipe, setSavingRecipe] = useState(false);

  useEffect(() => {
    if (pl.dynamic) recipe.load();
  }, [pl.dynamic, recipe]);

  const saveRecipe = async () => {
    setSavingRecipe(true);
    try {
      await api.setPlaylistRules(pl.id, recipe.build());
      say('good', 'Recipe updated — dealing fresh');
      onChanged();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setSavingRecipe(false);
    }
  };

  return (
    <div className="pledit">
      <label>
        <span className="lbl">Name</span>
        <input value={draftName} onChange={(e) => setDraftName(e.target.value)} maxLength={120} />
      </label>
      <label>
        <span className="lbl">Description</span>
        <textarea
          value={draftDesc}
          onChange={(e) => setDraftDesc(e.target.value)}
          maxLength={600}
          rows={3}
          placeholder="What is this playlist for?"
        />
      </label>

      {pl.dynamic && (
        <>
          <div className="lbl" style={{ marginTop: 4 }}>
            Recipe — what this playlist deals from
          </div>
          <RecipeFields recipe={recipe} />
          <div className="bar">
            <button
              className="btn sm"
              disabled={savingRecipe || recipe.termCount === 0}
              onClick={() => void saveRecipe()}
            >
              {savingRecipe ? 'Saving recipe…' : 'Save recipe & re-deal'}
            </button>
            {recipe.termCount === 0 && (
              <span className="muted" style={{ fontSize: '0.78rem' }}>
                pick at least one style, genre, era or energy
              </span>
            )}
          </div>
        </>
      )}

      <div className="bar">
        <button className="btn sm" disabled={busy || !draftName.trim()} onClick={() => void onSave()}>
          {busy ? 'Saving…' : 'Save details'}
        </button>
        <button className="btn sec sm danger" onClick={() => void onDelete()}>
          Delete playlist
        </button>
      </div>
    </div>
  );
}

/**
 * "Your listening": what you actually played, and the vibe it adds up to.
 *
 * Built on the play log rather than the DJ's votes on purpose — votes only exist while
 * somebody uses the DJ and fade within hours, whereas what you chose to play over a week
 * is the honest record of the mood you were in. It works for people who never open the
 * DJ at all, and the "more of this" buttons hand the answer straight to a dynamic
 * playlist.
 */
function ListeningView({ say }: { say: (k: 'good' | 'bad', t: string) => void }) {
  const p = usePlayer();
  const [days, setDays] = useState(7);
  const [data, setData] = useState<ListeningSummary | null>(null);

  useEffect(() => {
    setData(null);
    api.listening(days).then(setData).catch(() => setData(null));
  }, [days]);

  if (!data) return <div className="spinner">Reading your history…</div>;

  const peak = Math.max(1, ...data.clock);
  const empty = data.totals.plays === 0;

  const buildFromVibe = async () => {
    const terms = [
      ...data.vibe.families.slice(0, 3).map((f) => ({ kind: 'style' as const, key: f.id, weight: 2, label: f.label })),
      ...data.vibe.energy.slice(0, 1).map((e) => ({ kind: 'energy' as const, key: e.band, weight: 1.5, label: `${e.band} energy` })),
    ];
    if (!terms.length) return;
    try {
      const name = data.vibe.families.slice(0, 2).map((f) => f.label).join(' · ') || 'Lately';
      const r = await api.createPlaylist(name, { v: 1, terms, limit: 50 });
      say('good', `Made "${name}" from your last ${days} days`);
      navigate({ name: 'playlist', id: r.id });
    } catch (e) {
      say('bad', (e as Error).message);
    }
  };

  return (
    <>
      <div className="rowhead">
        <h2>Your listening</h2>
        <div className="seg" role="group" aria-label="Window" style={{ marginLeft: 'auto' }}>
          {[7, 30, 90].map((d) => (
            <button key={d} className={`segbtn${days === d ? ' on' : ''}`} onClick={() => setDays(d)}>
              {d} days
            </button>
          ))}
        </div>
      </div>

      {empty ? (
        <div className="empty">
          Nothing played in the last {days} days. Play some music and this fills in.
        </div>
      ) : (
        <>
          <div className="statrow">
            <Stat label="plays" value={data.totals.plays} />
            <Stat label="songs" value={data.totals.tracks} />
            <Stat label="artists" value={data.totals.artists} />
            <Stat label="listening" value={Format.minutes(data.totals.minutes)} />
          </div>

          {data.vibe.families.length > 0 && (
            <div className="vibe">
              <div className="sechead">
                <h2>Your vibe lately</h2>
                <span className="sub">what you have actually been reaching for</span>
              </div>
              <div className="chiprow">
                {data.vibe.families.map((f) => (
                  <span key={f.id} className="pchip static">
                    {f.label} · {f.share}%
                  </span>
                ))}
                {data.vibe.energy.map((e) => (
                  <span key={e.band} className="pchip static">
                    {e.band} energy · {e.share}%
                  </span>
                ))}
              </div>
              <div className="bar" style={{ marginTop: 10 }}>
                <button className="btn sm" onClick={() => void buildFromVibe()}>
                  Make a playlist from this
                </button>
              </div>
            </div>
          )}

          <div className="sechead">
            <h2>When you listen</h2>
            <span className="sub">plays by hour</span>
          </div>
          <div className="clock">
            {data.clock.map((n, hour) => (
              <div key={hour} className="clockbar" title={`${hour}:00 — ${n} play${n === 1 ? '' : 's'}`}>
                <div className="fill" style={{ height: `${Math.round((100 * n) / peak)}%` }} />
                <div className="hr">{hour % 6 === 0 ? hour : ''}</div>
              </div>
            ))}
          </div>

          <div className="listcols">
            <div>
              <div className="sechead"><h2>Top artists</h2></div>
              {data.topArtists.map((a) => (
                <Link key={a.name} to={{ name: 'artistByName', artist: a.name }} className="statline">
                  <span className="n">{a.name}</span>
                  <span className="v">{a.plays}</span>
                </Link>
              ))}
            </div>
            <div>
              <div className="sechead"><h2>Top albums</h2></div>
              {data.topAlbums.map((a) => (
                <Link
                  key={`${a.artistName}|${a.albumTitle}`}
                  to={{ name: 'albumpage', artist: a.artistName, album: a.albumTitle }}
                  className="statline"
                >
                  <span className="n">{a.albumTitle}<span className="muted"> · {a.artistName}</span></span>
                  <span className="v">{a.plays}</span>
                </Link>
              ))}
            </div>
            <div>
              <div className="sechead"><h2>Top songs</h2></div>
              {data.topTracks.map((t) => (
                <button
                  key={t.trackId}
                  className="statline"
                  onClick={() =>
                    p.play([{ trackId: t.trackId, title: t.title, artistName: t.artistName, albumTitle: '', durationS: null }], 0, 'your top songs')
                  }
                >
                  <span className="n">{t.title}<span className="muted"> · {t.artistName}</span></span>
                  <span className="v">{t.plays}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="sechead">
            <h2>Recently played</h2>
          </div>
          <div className="songrows">
            {data.recent.map((r, i) => (
              <div key={`${r.trackId}-${r.at}-${i}`} className="statline">
                <span className="n">{r.title}<span className="muted"> · {r.artistName}</span></span>
                <span className="v muted">{Format.ago(r.at)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stat">
      <div className="statv">{value}</div>
      <div className="statl">{label}</div>
    </div>
  );
}

/**
 * "Complete your albums": records the pool already holds more of than you do. Every row
 * here closes with one click and no download, which is the entire reason it deserves a
 * screen rather than being buried in each album page.
 */
function GapsView({ say }: { say: (k: 'good' | 'bad', t: string) => void }) {
  const [albums, setAlbums] = useState<{ artistName: string; albumTitle: string; mine: number; onDisk: number }[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  const load = useCallback(() => {
    api.gaps().then((r) => setAlbums(r.albums)).catch(() => setAlbums([]));
  }, []);
  useEffect(load, [load]);

  if (!albums) return <div className="spinner">Looking for gaps…</div>;

  const missing = albums.reduce((n, a) => n + (a.onDisk - a.mine), 0);

  return (
    <>
      <div className="rowhead">
        <h2>Complete your albums</h2>
        <span className="reason">
          {albums.length === 0
            ? 'nothing missing'
            : `${albums.length} album${albums.length === 1 ? '' : 's'} · ${missing} track${missing === 1 ? '' : 's'} already on disk`}
        </span>
        {albums.length > 0 && (
          <button
            className="btn sm"
            style={{ marginLeft: 'auto' }}
            disabled={all}
            onClick={() => {
              setAll(true);
              void api
                .fillAllGaps()
                .then((r) => {
                  say('good', `Added ${r.added} track${r.added === 1 ? '' : 's'} across ${r.albums} album${r.albums === 1 ? '' : 's'}`);
                  load();
                })
                .catch((e: Error) => say('bad', e.message))
                .finally(() => setAll(false));
            }}
          >
            {all ? 'Completing…' : 'Complete all'}
          </button>
        )}
      </div>

      {albums.length === 0 ? (
        <div className="empty">
          Every album you own part of is complete. New gaps appear here when somebody else
          downloads more of a record you already have some of.
        </div>
      ) : (
        <div className="songrows">
          {albums.map((a) => {
            const key = `${a.artistName}|${a.albumTitle}`;
            return (
              <div key={key} className="gaprow">
                <RemoteAlbumArt artist={a.artistName} album={a.albumTitle} />
                <div className="words">
                  <Link to={{ name: 'albumpage', artist: a.artistName, album: a.albumTitle }} className="t">
                    {a.albumTitle}
                  </Link>
                  <div className="s muted">
                    {a.artistName} · you have {a.mine} of {a.onDisk}
                  </div>
                </div>
                <button
                  className="btn sec sm"
                  disabled={busy === key}
                  onClick={() => {
                    setBusy(key);
                    void api
                      .fillGap(a.artistName, a.albumTitle)
                      .then((r) => {
                        say('good', `Added ${r.added} track${r.added === 1 ? '' : 's'} to ${a.albumTitle}`);
                        load();
                      })
                      .catch((e: Error) => say('bad', e.message))
                      .finally(() => setBusy(null));
                  }}
                >
                  {busy === key ? 'Adding…' : `Add ${a.onDisk - a.mine}`}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/** Small album thumb by name — the gaps list is the only place that wants one this size. */
function RemoteAlbumArt({ artist, album }: { artist: string; album: string }) {
  return (
    <span className="gapart">
      <Artwork src={albumArtUrl(artist, album)} kind="album" alt={album} />
    </span>
  );
}

/** The recipe of a dynamic playlist, as chips: what it deals from. */
function RecipeChips({ rules }: { rules: string | null }) {
  if (!rules) return null;
  let parsed: PlaylistRules | null = null;
  try {
    parsed = JSON.parse(rules) as PlaylistRules;
  } catch {
    return null;
  }
  if (!parsed?.terms?.length) return null;
  // A saved DJ mood can carry dozens of weighted terms; show the strongest dozen.
  const shown = [...parsed.terms].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 12);
  return (
    <div className="chiprow" style={{ margin: '6px 0' }}>
      {shown.map((t) => (
        <span key={`${t.kind}|${t.key}`} className={`pchip static${t.weight < 0 ? ' neg' : ''}`}>
          {t.label ?? t.key}
        </span>
      ))}
    </div>
  );
}

/** A playlist as artwork, with play on hover — Delete lives on the playlist's own page. */
function PlaylistTile({ pl, say }: { pl: Playlist; say: (k: 'good' | 'bad', t: string) => void }) {
  const p = usePlayer();
  return (
    <Tile
      src={playlistArtUrl(pl)}
      label={pl.name}
      title={pl.name}
      subtitle={`${pl.tracks} track${pl.tracks === 1 ? '' : 's'}`}
      to={{ name: 'playlist', id: pl.id }}
      onPlay={
        pl.tracks
          ? () => {
              // The tile has no tracks of its own, so fetch before playing.
              void api
                .playlist(pl.id)
                .then((r) => {
                  if (r.tracks.length) p.play(r.tracks.map(playable), 0, pl.name);
                  else say('bad', `${pl.name} is empty`);
                })
                .catch((e: Error) => say('bad', e.message));
            }
          : undefined
      }
    />
  );
}

/**
 * One playlist: its cover, its details and its songs.
 *
 * The cover sits on the right of the header rather than the left, which is the one place this
 * deliberately departs from the album page — an album's identity IS its sleeve, while a
 * playlist's is its name, so the name leads and the artwork follows.
 */
function PlaylistView({ id, say }: { id: number; say: (k: 'good' | 'bad', t: string) => void }) {
  const p = usePlayer();
  const [pl, setPl] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<MyTrack[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftDesc, setDraftDesc] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .playlist(id)
      .then((r) => {
        setPl(r.playlist);
        setDraftName(r.playlist.name);
        setDraftDesc(r.playlist.description);
        setTracks(r.tracks);
      })
      .catch((e: Error) => setErr(e.message));
  }, [id]);
  useEffect(load, [load]);

  if (err) return <div className="note bad">{err}</div>;
  if (!tracks || !pl) return <div className="spinner">Loading…</div>;

  const playable_ = tracks.filter((t) => t.mine);
  const mins = Math.round(tracks.reduce((n, t) => n + (t.durationS ?? 0), 0) / 60);

  const save = async () => {
    setBusy(true);
    try {
      const name = draftName.trim();
      if (name && name !== pl.name) await api.renamePlaylist(id, name);
      if (draftDesc.trim() !== pl.description) {
        const r = await api.describePlaylist(id, draftDesc.trim());
        setPl(r.playlist);
      }
      setEditing(false);
      load();
      say('good', 'Saved');
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const destroy = async () => {
    if (!window.confirm(`Delete the playlist "${pl.name}"? The songs stay in your library.`)) return;
    try {
      await api.deletePlaylist(id);
      say('good', `Deleted ${pl.name}`);
      navigate({ name: 'playlists' });
    } catch (e) {
      say('bad', (e as Error).message);
    }
  };

  return (
    <>
      <div className="hero2 artright">
        <div className="backdrop" style={{ backgroundImage: `url("${playlistArtUrl(pl)}")` }} />
        <div className="words">
          <div className="kicker">{pl.dynamic ? 'Dynamic playlist' : 'Playlist'}</div>
          <h1>{pl.name}</h1>
          <div className="by">
            {tracks.length} track{tracks.length === 1 ? '' : 's'}
            {mins > 0 && ` · ${mins} min`}
            {pl.dynamic && ' · dealt fresh each visit'}
            {!pl.dynamic &&
              playable_.length !== tracks.length &&
              ` · ${tracks.length - playable_.length} no longer in your library`}
          </div>
          {pl.dynamic && <RecipeChips rules={pl.rules ?? null} />}
          {pl.description && !editing && <p className="pldesc">{pl.description}</p>}
          <div className="acts">
            <button
              className="btn"
              disabled={!playable_.length}
              onClick={() => p.play(playable_.map(playable), 0, pl.name)}
            >
              <IconPlay /> Play all
            </button>
            <button
              className="btn sec"
              disabled={!playable_.length}
              onClick={() => {
                p.play(playable_.map(playable), 0, pl.name, { shuffle: true });
              }}
            >
              <IconShuffle /> Play shuffled
            </button>
            {pl.dynamic && (
              <button className="btn sec" onClick={load}>
                Re-deal
              </button>
            )}
            <button className="btn sec" onClick={() => setEditing((v) => !v)}>
              {editing ? 'Close' : 'Edit details'}
            </button>
          </div>
        </div>
        <PlaylistArtwork pl={pl} onChanged={load} say={say} />
      </div>

      {editing && (
        <PlaylistEditor
          pl={pl}
          draftName={draftName}
          setDraftName={setDraftName}
          draftDesc={draftDesc}
          setDraftDesc={setDraftDesc}
          busy={busy}
          onSave={save}
          onDelete={destroy}
          say={say}
          onChanged={load}
        />
      )}

      {tracks.length === 0 ? (
        <div className="empty">
          Nothing here yet. Use the ⋯ menu beside any song to add it.
        </div>
      ) : (
        // Compact rows: a playlist is a list you read down, not a browsing shelf.
        <div className="songrows">
          {tracks.map((t, i) => (
            <SongRow
              key={t.trackId}
              track={t}
              queue={tracks}
              index={i}
              label={pl.name}
              say={say}
              mine={t.mine}
              onDisk={t.onDisk}
              onChanged={load}
              showRemove={!pl.dynamic}
            />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * The playlist cover, with Replace and Remove revealed over it.
 *
 * The overlay opens on hover for a mouse and on tap for everything else — a hover-only
 * affordance would leave the art unchangeable on a phone, which is where most of this app
 * gets used.
 */
function PlaylistArtwork({
  pl,
  onChanged,
  say,
}: {
  pl: Playlist;
  onChanged: () => void;
  say: (k: 'good' | 'bad', t: string) => void;
}) {
  const file = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const upload = async (f: File) => {
    setBusy(true);
    try {
      await api.setPlaylistArt(pl.id, f);
      say('good', 'Cover replaced');
      onChanged();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      await api.clearPlaylistArt(pl.id);
      say('good', pl.customArt ? 'Cover removed' : 'New cover generated');
      onChanged();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <div className={`cover plcover${open ? ' open' : ''}`} onClick={() => setOpen((v) => !v)}>
      <Artwork src={playlistArtUrl(pl)} kind="album" alt={pl.name} />
      <div className="artacts">
        <button
          className="btn sm"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            file.current?.click();
          }}
        >
          Replace
        </button>
        <button
          className="btn sec sm"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            void reset();
          }}
        >
          {pl.customArt ? 'Remove' : 'Regenerate'}
        </button>
      </div>
      <input
        ref={file}
        type="file"
        accept="image/jpeg,image/png"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void upload(f);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Album page
// ---------------------------------------------------------------------------

/**
 * One album: its tracks, the rest of the artist's records, and a few similar artists.
 *
 * Keyed on names because nothing in crate has a numeric album id — the pool is keyed on
 * normalised artist and album, and that is what a tile on the front page knows.
 *
 * Shows tracks that are on disk but NOT in your library too, with an Add button. Hiding them
 * would mean an album you own three songs from looks like a three-track album, when the other
 * eight are sitting there free.
 */
function AlbumPageView({
  artist,
  album,
  mbid,
  say,
}: {
  artist: string;
  album: string;
  /** MusicBrainz release group, when the caller had one — what makes an album
   *  crate does NOT hold renderable: tracklist, previews, per-song Get. */
  mbid?: string;
  say: (k: 'good' | 'bad', t: string) => void;
}) {
  const p = usePlayer();
  const [data, setData] = useState<AlbumPage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [reqState, setReqState] = useState<'idle' | 'busy' | 'done'>('idle');

  const load = useCallback(() => {
    api
      .album(artist, album)
      .then(setData)
      .catch((e: Error) => setErr(e.message));
  }, [artist, album]);
  useEffect(load, [load]);

  /*
   * The release group, RESOLVED here when the caller did not know it.
   *
   * A discover tile knows only names — the recommender works in names — but the metadata
   * page below needs an mbid for its tracklist, previews and Request. Resolving inside the
   * page rather than at the click means every door works: a tile, a typed URL, a link from
   * anywhere. 'none' is a real answer (MusicBrainz has no such record), distinct from
   * "still looking".
   */
  const [resolved, setResolved] = useState<string | 'none' | null>(null);
  const needsMbid = Boolean(data && data.tracks.length === 0 && !mbid);
  useEffect(() => {
    if (!needsMbid) return;
    let dead = false;
    const la = artist.toLowerCase();
    const lb = album.toLowerCase();
    api
      .search(`${artist} ${album}`)
      .then((r) => {
        if (dead) return;
        const hit =
          r.albums.find(
            (a) => a.title.toLowerCase() === lb && a.artistName.toLowerCase() === la,
          ) ??
          r.albums.find((a) => a.artistName.toLowerCase() === la) ??
          r.albums[0];
        setResolved(hit?.mbid ?? 'none');
      })
      .catch(() => {
        if (!dead) setResolved('none');
      });
    return () => {
      dead = true;
    };
  }, [needsMbid, artist, album]);

  if (err) return <div className="note bad">{err}</div>;
  if (!data) return <div className="spinner">Loading…</div>;
  if (needsMbid && resolved === null) return <div className="spinner">Loading…</div>;

  /*
   * Not a record crate holds — but the caller knew its MusicBrainz id, so the
   * page renders from metadata instead: tracklist, a preview per song, Get per
   * song, Request for the whole thing. This is the page a search result opens,
   * and it exists because clicking an album used to offer nothing but a
   * Request button — an album you could buy but not look at first.
   */
  const groupMbid = mbid ?? (resolved && resolved !== 'none' ? resolved : undefined);
  if (data.tracks.length === 0 && groupMbid) {
    const rurl = `${albumArtUrl(artist, album)}&mbid=${encodeURIComponent(groupMbid)}`;
    const requestAlbum = async () => {
      setReqState('busy');
      try {
        const r = await api.request({ kind: 'album', mbid: groupMbid, askedFor: `${artist} — ${album}` });
        setReqState('done');
        say('good', r.instant ? `${album} is in your library.` : `Requested ${album}. Searching now.`);
        if (r.instant) load();
      } catch (e) {
        setReqState('idle');
        say('bad', (e as Error).message);
      }
    };
    return (
      <>
        <div className="hero2">
          <div className="backdrop" style={{ backgroundImage: `url("${rurl}")` }} />
          <div className="cover">
            <Artwork src={rurl} kind="album" alt={album} />
          </div>
          <div className="words">
            <div className="kicker">Album · not in your library</div>
            <h1>{album}</h1>
            <div className="by">{artist}</div>
            <div className="acts">
              {reqState === 'done' ? (
                <span className="tag req">requested</span>
              ) : (
                <button className="btn" disabled={reqState === 'busy'} onClick={() => void requestAlbum()}>
                  {reqState === 'busy' ? 'Requesting…' : 'Request album'}
                </button>
              )}
              <button className="btn sec" onClick={() => window.history.back()}>
                Back
              </button>
            </div>
          </div>
        </div>

        <div className="sechead">
          <h2>Tracks</h2>
          <span className="sub">preview any song, or get just the ones you want</span>
        </div>
        {/* The same tracklist the artist page expands: previews and per-song
            Get, driven by the release group id. */}
        <TrackList mbid={groupMbid} artist={artist} say={say} requestable />
      </>
    );
  }

  const mine = data.tracks.filter((t) => t.mine);
  const notMine = data.tracks.filter((t) => !t.mine);
  const url = albumArtUrl(artist, album);

  const addAll = async () => {
    setBusy(true);
    try {
      for (const t of notMine) await api.addTrack(t.trackId);
      say('good', `Added ${notMine.length} track${notMine.length === 1 ? '' : 's'}`);
      load();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="hero2">
        <div className="backdrop" style={{ backgroundImage: `url("${url}")` }} />
        <div className="cover">
          <Artwork src={url} kind="album" alt={album} />
        </div>
        <div className="words">
          <div className="kicker">Album</div>
          <h1>{album}</h1>
          <div className="by">
            {artist}
            {/* Only when known: "Album · —" reads worse than no year at all. */}
            {data.year !== null && ` · ${data.year}`}
            {/* The copy on disk is a reissue, which is worth knowing and is NOT the album's
                year — so it is said as such rather than shown as a second bare number. */}
            {data.tagYear !== null && (
              <span className="reissue"> · {data.tagYear} reissue</span>
            )}{' '}
            · {mine.length} of {data.tracks.length} in your library
          </div>
          <div className="acts">
            <button
              className="btn"
              disabled={!mine.length}
              onClick={() => p.play(mine.map(playable), 0, album)}
            >
              <IconPlay /> Play
            </button>
            <button
              className="btn sec"
              disabled={!mine.length}
              onClick={() => {
                p.play(mine.map(playable), 0, album, { shuffle: true });
              }}
            >
              <IconShuffle /> Shuffle
            </button>
            {notMine.length > 0 && (
              <button className="btn sec" disabled={busy} onClick={() => void addAll()}>
                {busy ? 'Adding…' : `+ Add ${notMine.length} more`}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="sechead">
        <h2>Tracks</h2>
        <span className="sub">
          {mine.length === data.tracks.length
            ? `all ${data.tracks.length} in your library`
            : `${mine.length} of ${data.tracks.length} in your library`}
        </span>
      </div>
      <div className="songrows" style={{ gridTemplateColumns: '1fr' }}>
        {data.tracks.map((t) => (
          <SongRow
            key={t.trackId}
            track={t}
            queue={mine}
            index={Math.max(0, mine.findIndex((m) => m.trackId === t.trackId))}
            label={album}
            say={say}
            mine={t.mine}
            onChanged={load}
            showRemove={t.mine}
          />
        ))}
      </div>

      {data.otherAlbums.length > 0 && (
        <>
          <div className="sechead">
            <h2>More from {artist}</h2>
          </div>
          <Shelf>
            {data.otherAlbums.map((a) => (
              <AlbumTile
                key={a.albumTitle}
                artist={artist}
                album={a.albumTitle}
                subtitle={
                  a.mine === a.onDisk
                    ? `${a.onDisk} track${a.onDisk === 1 ? '' : 's'}`
                    : `${a.mine} of ${a.onDisk} yours`
                }
                here={a.mine > 0}
                why={a.mine > 0 ? 'in your library' : 'on the server'}
                onPlay={
                  a.mine > 0
                    ? () => {
                        void api
                          .queue({ kind: 'album', artist, album: a.albumTitle })
                          .then((r) => {
                            if (r.tracks.length) p.play(r.tracks.map(playable), 0, a.albumTitle);
                          })
                          .catch((e: Error) => say('bad', e.message));
                      }
                    : undefined
                }
              />
            ))}
          </Shelf>
        </>
      )}

      {data.similar.length > 0 && (
        <>
          <div className="sechead">
            <h2>Similar artists</h2>
            <span className="sub">not in your library</span>
          </div>
          <Shelf>
            {data.similar.map((s) => (
              <ArtistTile key={s.name} name={s.name} why={s.because} say={say} />
            ))}
          </Shelf>
        </>
      )}
    </>
  );
}

/**
 * Tracks nobody has in a library.
 *
 * These arrived because they happened to be on an album somebody wanted one song from. Keeping
 * them is the point of the pool — it is what makes the next request for one of them instant —
 * so nothing here is automatic. This is the list and the decision.
 *
 * The server re-checks each track is genuinely unheld at the moment of deletion, so somebody
 * adding one to their library while this page is open does not lose it.
 */
function OrphanPurge({
  say,
  onPurged,
}: {
  say: (k: 'good' | 'bad', t: string) => void;
  onPurged: () => void;
}) {
  const [orphans, setOrphans] = useState<Orphan[] | null>(null);
  const [totals, setTotals] = useState<{ tracks: number; bytes: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(() => {
    api
      .orphans()
      .then((r) => {
        setOrphans(r.orphans);
        setTotals(r.totals);
      })
      .catch(() => setOrphans([]));
  }, []);
  useEffect(load, [load]);

  const purgeAll = async () => {
    setBusy(true);
    try {
      const r = await api.purge({ all: true });
      say(
        'good',
        `Purged ${r.removed} track${r.removed === 1 ? '' : 's'} to trash` +
          (r.skipped.length ? `; ${r.skipped.length} skipped (someone had them)` : ''),
      );
      setConfirm(false);
      load();
      onPurged();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const purgeOne = async (o: Orphan) => {
    setBusy(true);
    try {
      await api.purge({ trackIds: [o.trackId] });
      say('good', `${o.title} moved to trash`);
      load();
      onPurged();
    } catch (e) {
      say('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!orphans) return null;

  return (
    <>
      <div className="rowhead">
        <h3>Unused tracks</h3>
        <span className="reason">
          {totals?.tracks} in nobody&apos;s library · {bytes(totals?.bytes ?? 0)}
        </span>
      </div>

      {orphans.length === 0 ? (
        <div className="muted sm">
          Every track on disk is in at least one library. Nothing to purge.
        </div>
      ) : (
        <>
          <div className="muted sm">
            These came down as part of albums people wanted single songs from. Keeping them is why
            those songs are instant for the next person — purge only if the space matters.
          </div>
          <div className="bar" style={{ margin: '10px 0' }}>
            <button className="btn sec sm" onClick={() => setOpen(!open)}>
              {open ? 'Hide list' : `Show ${orphans.length}`}
            </button>
            {confirm ? (
              <>
                <button className="btn sm" disabled={busy} onClick={() => void purgeAll()}>
                  {busy ? 'Purging…' : `Really purge all ${orphans.length}`}
                </button>
                <button className="btn sec sm" onClick={() => setConfirm(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="btn sec sm" onClick={() => setConfirm(true)}>
                Purge all
              </button>
            )}
          </div>

          {open && (
            <table className="list">
              <thead>
                <tr>
                  <th>Song</th>
                  <th>Artist</th>
                  <th>Album</th>
                  <th>Size</th>
                  <th style={{ textAlign: 'right' }}>&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {orphans.map((o) => (
                  <tr key={o.trackId}>
                    <td>{o.title}</td>
                    <td className="muted">{o.artistName}</td>
                    <td className="muted">{o.albumTitle}</td>
                    <td className="muted">{bytes(o.sizeBytes)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn sec sm" disabled={busy} onClick={() => void purgeOne(o)}>
                        Purge
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Consistent song / album / artist actions
// ---------------------------------------------------------------------------

/**
 * The playlist chooser, reused by every "Add to playlist" action.
 *
 * Takes a callback rather than a track, because a song already on disk is added directly while
 * one that is not starts a download aimed at the chosen playlist. Same dialog, two outcomes.
 */
function PlaylistPicker({
  title,
  onPick,
  onClose,
  say,
}: {
  title: string;
  onPick: (playlistId: number, name: string) => Promise<void> | void;
  onClose: () => void;
  say: (k: 'good' | 'bad', t: string) => void;
}) {
  const [lists, setLists] = useState<Playlist[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.playlists().then((r) => setLists(r.playlists)).catch(() => setLists([]));
  }, []);

  const run = async (id: number, label: string) => {
    setBusy(true);
    try {
      await onPick(id, label);
      onClose();
    } catch (e) {
      say('bad', (e as Error).message);
      setBusy(false);
    }
  };

  const create = (wanted: string) => {
    setBusy(true);
    void api
      .createPlaylist(wanted)
      .then((r) => run(r.id, wanted))
      .catch((e: Error) => {
        say('bad', e.message);
        setBusy(false);
      });
  };

  const term = q.trim().toLowerCase();
  const shown = (lists ?? []).filter((l) => !term || l.name.toLowerCase().includes(term));
  // The typed name is a new playlist unless it already exists exactly.
  const canCreate =
    term !== '' && !(lists ?? []).some((l) => l.name.toLowerCase() === term);

  return (
    <Modal title={`Add ${title} to a playlist`} onClose={onClose}>
      {lists === null ? (
        <div className="spinner">Loading…</div>
      ) : (
        <>
          {/* One field for both jobs: it filters as you type, and if what you
              typed is not a playlist yet, the same text makes one. A row of
              wrapping buttons stopped being a list at about six playlists. */}
          <input
            autoFocus
            className="pickerfind"
            placeholder={lists.length ? 'Find or name a new playlist…' : 'Name your first playlist…'}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const first = shown[0];
              if (first && !canCreate) void run(first.id, first.name);
              else if (canCreate) create(q.trim());
            }}
          />

          <div className="pickerlist">
            {shown.map((l) => (
              <button
                key={l.id}
                className="pickerrow"
                disabled={busy}
                onClick={() => void run(l.id, l.name)}
              >
                <span className="n">{l.name}</span>
                <span className="c muted">
                  {l.tracks} song{l.tracks === 1 ? '' : 's'}
                </span>
              </button>
            ))}
            {shown.length === 0 && lists.length > 0 && !canCreate && (
              <div className="muted" style={{ padding: '10px 12px' }}>
                Nothing matching “{q.trim()}”.
              </div>
            )}
          </div>

          {canCreate && (
            <button className="btn newlist" disabled={busy} onClick={() => create(q.trim())}>
              <IconPlus /> Create “{q.trim()}” and add
            </button>
          )}
        </>
      )}
    </Modal>
  );
}

/** Everything known about one track. */
/** The order groups read in, and what to call them. Mirrors the server taxonomy's grouping. */
const CHAR_GROUPS: { id: string; label: string }[] = [
  { id: 'energy', label: 'Energy & movement' },
  { id: 'emotion', label: 'Emotion' },
  { id: 'tone', label: 'Tone & sound' },
  { id: 'rhythm', label: 'Rhythm' },
  { id: 'composition', label: 'Composition' },
  { id: 'production', label: 'Production' },
  { id: 'vocal', label: 'Vocals' },
];

/**
 * A track's characteristic profile.
 *
 * FIFTY-FIVE NUMBERS IS NOT A UI. Shown raw, a complete vector tells a person nothing — it is
 * a wall, and most of it sits near the middle saying "this track is a bit of everything". So
 * the default view is the handful of characteristics that are actually OPINIONATED about this
 * track, and the rest is one click away, grouped.
 *
 * "Opinionated" means furthest from 0.5 in either direction, not simply highest. That matters:
 * `danceability 0.04` is as strong a statement about a song as `atmosphere 0.95`, and a panel
 * that only surfaced high scores would describe every track by what it is and never by what it
 * conspicuously is not.
 */
function CharacteristicsPanel({ trackId }: { trackId: number }) {
  const [status, setStatus] = useState<TrackAnalysisStatus | null>(null);
  const [defs, setDefs] = useState<Map<string, CharacteristicDef>>(new Map());
  const [enabled, setEnabled] = useState(false);
  const [expanded, setExpanded] = useState(false);
  /*
   * Editing is off by default. A slider per row turned a profile into a control panel — fifty
   * chunky inputs shouting for attention when the common case is simply reading the shape of a
   * track. Behind a toggle, the default view is text and a bar, and the machinery appears only
   * for the person who actually came to change something.
   */
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    void api
      .trackCharacteristics(trackId)
      .then(setStatus)
      .catch((e: Error) => setErr(e.message));
  }, [trackId]);

  useEffect(() => {
    load();
    void api
      .characteristicVocab()
      .then((r) => {
        setDefs(new Map(r.characteristics.map((c) => [c.key, c])));
        setEnabled(r.progress.enabled);
      })
      .catch(() => undefined);
  }, [load]);

  /*
   * While analysis is in flight there is nothing to react to — the worker is a background
   * trickle, not a request/response — so poll until it settles. Only while actually waiting.
   */
  useEffect(() => {
    if (status?.state !== 'pending' && status?.state !== 'analysing') return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [status?.state, load]);

  const analyse = () => {
    setBusy(true);
    setErr(null);
    void api
      .analyseTrack(trackId)
      .then((r) => setStatus(r.status))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };

  const setScore = (key: string, score: number) => {
    void api
      .setTrackCharacteristic(trackId, key, score)
      .then((r) => setStatus(r.status))
      .catch((e: Error) => setErr(e.message));
  };

  const strongest = useMemo(() => {
    if (!status) return [];
    // Distance from the midpoint: what this track has an opinion about, either way.
    return [...status.characteristics]
      .sort((a, b) => Math.abs(b.score - 0.5) - Math.abs(a.score - 0.5))
      .slice(0, 8);
  }, [status]);

  if (!status) return <div className="charrow muted">Reading characteristics…</div>;

  const byGroup = CHAR_GROUPS.map((g) => ({
    ...g,
    items: status.characteristics.filter((c) => c.group === g.id),
  })).filter((g) => g.items.length);

  return (
    <div className="chars">
      <div className="charhead">
        <span className="lbl">Song characteristics</span>
        <AnalysisStateChip state={status.state} detail={status.detail} />
        <div className="spacer" />
        {status.characteristics.length > 0 && (
          <button
            className={`btn sec sm${editing ? ' on' : ''}`}
            onClick={() => setEditing((x) => !x)}
            title="Adjust these by hand"
          >
            {editing ? 'Done' : 'Edit'}
          </button>
        )}
        {enabled ? (
          <button className="btn sec sm" disabled={busy} onClick={analyse}>
            {busy ? 'Queueing…' : status.state === 'not-analysed' ? 'Analyse' : 'Reanalyse'}
          </button>
        ) : (
          <span className="muted sm">switched off</span>
        )}
      </div>

      {err && <div className="note bad">{err}</div>}

      {status.characteristics.length === 0 ? (
        <div className="muted sm">
          {status.state === 'failed'
            ? status.detail || 'Analysis failed.'
            : status.state === 'pending' || status.state === 'analysing'
              ? 'Waiting for the classifier…'
              : 'Not analysed yet.'}
        </div>
      ) : (
        <>
          {!expanded &&
            strongest.map((c) => (
              <CharBar key={c.key} c={c} def={defs.get(c.key)} onSet={setScore} editing={editing} />
            ))}
          {expanded &&
            byGroup.map((g) => (
              <div className="chargroup" key={g.id}>
                <div className="grouphead">{g.label}</div>
                {g.items.map((c) => (
                  <CharBar key={c.key} c={c} def={defs.get(c.key)} onSet={setScore} editing={editing} />
                ))}
              </div>
            ))}
          <button className="btn sec sm charmore" onClick={() => setExpanded((x) => !x)}>
            {expanded
              ? 'Show the strongest only'
              : `Show all ${status.characteristics.length} characteristics`}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * One dimension: name, a quiet bar, the number.
 *
 * The bar is a hairline in the foreground colour rather than a filled accent block. Fifty rows
 * of saturated blue reads as a dashboard demanding to be acted on; what this actually is, is
 * text with a magnitude beside it. A hand-set value is the one thing that earns the accent
 * colour, because it is the one thing on the row that somebody decided.
 */
function CharBar({
  c,
  def,
  onSet,
  editing,
}: {
  c: TrackCharacteristic;
  def?: CharacteristicDef;
  onSet: (key: string, score: number) => void;
  editing: boolean;
}) {
  const manual = c.source === 'manual';
  return (
    <div className={`charrow${editing ? ' editing' : ''}`} title={def?.description}>
      <span className="nm">
        {c.name}
        {manual && (
          <em className="by" title="Set by hand — survives reanalysis and overrides the AI">
            ·
          </em>
        )}
      </span>
      {editing ? (
        <input
          className="wt"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={c.score}
          title="Drag to set this by hand"
          onChange={(e) => onSet(c.key, Number(e.target.value))}
        />
      ) : (
        <span className={`bar${manual ? ' mine' : ''}`}>
          <i style={{ width: `${Math.round(c.score * 100)}%` }} />
        </span>
      )}
      <span className="num">{c.score.toFixed(2)}</span>
    </div>
  );
}

/** The analysis state, as a word somebody can act on rather than an enum. */
function AnalysisStateChip({ state, detail }: { state: TrackAnalysisStatus['state']; detail: string }) {
  const label: Record<TrackAnalysisStatus['state'], string> = {
    'not-analysed': 'not analysed',
    pending: 'queued',
    analysing: 'analysing…',
    analysed: 'analysed',
    failed: 'failed',
  };
  return (
    <span className={`charstate ${state}`} title={state === 'failed' && detail ? detail : undefined}>
      {label[state]}
    </span>
  );
}

/**
 * The nearest tracks by characteristic profile.
 *
 * Shown as evidence rather than as a recommendation — the heading says "closest by sound"
 * deliberately, because the most similar track is often the same song again and presenting it
 * as "play this next" would be a different, and wrong, claim. Same-artist matches are filtered
 * out server-side for the same reason: they are correct and useless.
 */
function SimilarTracks({ trackId }: { trackId: number }) {
  const [rows, setRows] = useState<SimilarTrack[] | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const p = usePlayer();

  useEffect(() => {
    void api
      .similarTracks(trackId, 6)
      .then((r) => {
        setRows(r.results);
        setReason(r.reason ?? null);
      })
      .catch(() => setRows([]));
  }, [trackId]);

  if (!rows || (!rows.length && !reason)) return null;

  return (
    <div className="chars">
      <div className="charhead">
        <span className="lbl">Closest by sound</span>
        <div className="spacer" />
        <span className="muted sm">other artists</span>
      </div>
      {reason && <div className="muted sm">{reason}</div>}
      {rows.map((r) => (
        <button
          className="simrow"
          key={r.trackId}
          onClick={() => p.play([{ trackId: r.trackId, title: r.title, artistName: r.artistName, albumTitle: r.albumTitle, durationS: null }], 0, `similar:${trackId}`)}
        >
          <span className="nm">
            {r.title}
            <em className="muted"> · {r.artistName}</em>
          </span>
          <span className="bar">
            <i style={{ width: `${Math.round(r.similarity * 100)}%` }} />
          </span>
          <span className="num">{r.similarity.toFixed(2)}</span>
        </button>
      ))}
    </div>
  );
}

function TrackInfoModal({ trackId, onClose }: { trackId: number; onClose: () => void }) {
  const [info, setInfo] = useState<TrackInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.trackInfo(trackId).then(setInfo).catch((e: Error) => setErr(e.message));
  }, [trackId]);

  return (
    <Modal title={info ? info.title : 'Track info'} onClose={onClose}>
      {err && <div className="note bad">{err}</div>}
      {!info && !err && <div className="spinner">Reading the file…</div>}
      {info && (
        <>
          {info.unreadable && (
            <div className="note">
              The file could not be parsed, so only what crate recorded is shown.
            </div>
          )}
          <InfoRow label="Artist" value={info.artistName} />
          <InfoRow
            label="Album artist"
            value={info.albumArtist && info.albumArtist !== info.artistName ? info.albumArtist : null}
          />
          <InfoRow label="Album" value={info.albumTitle} />
          <InfoRow label="Year" value={info.year} />
          <InfoRow label="Genre" value={info.genres.join(', ')} />
          <InfoRow
            label="Track"
            value={info.trackNo ? `${info.trackNo}${info.trackOf ? ` of ${info.trackOf}` : ''}` : null}
          />
          <InfoRow label="Disc" value={info.discNo} />
          <InfoRow label="Composer" value={info.composer.join(', ')} />
          <InfoRow label="Length" value={info.durationS ? secs(info.durationS) : null} />
          <InfoRow
            label="Format"
            value={
              info.codec
                ? `${info.codec}${info.lossless === true ? ' · lossless' : info.lossless === false ? ' · lossy' : ''}`
                : null
            }
          />
          <InfoRow label="Bitrate" value={info.bitrateKbps ? `${info.bitrateKbps} kbps` : null} />
          <InfoRow
            label="Sample rate"
            value={
              info.sampleRate
                ? `${(info.sampleRate / 1000).toFixed(1)} kHz${info.bitsPerSample ? ` · ${info.bitsPerSample}-bit` : ''}`
                : null
            }
          />
          <InfoRow
            label="Channels"
            value={info.channels === 2 ? 'stereo' : info.channels === 1 ? 'mono' : info.channels}
          />
          <InfoRow label="Size" value={bytes(info.sizeBytes)} />
          <InfoRow label="BPM" value={info.bpm ? Math.round(info.bpm) : null} />
          <InfoRow
            label="Energy"
            value={
              info.energy != null
                ? `${Math.round(info.energy * 100)}% ${info.energy < 0.35 ? '· chill' : info.energy < 0.65 ? '· medium' : '· high'}`
                : null
            }
          />
          <InfoRow label="Lyrics" value={info.hasLyrics ? 'embedded' : 'none'} />
          <InfoRow label="Plays" value={info.plays} />
          <InfoRow label="In your library" value={info.inLibrary ? 'yes' : 'no'} />
          <InfoRow label="MusicBrainz" value={info.musicbrainzAlbumId} />
          <InfoRow label="File" value={<code style={{ fontSize: '0.78rem' }}>{info.path}</code>} />
          <CharacteristicsPanel trackId={trackId} />
          <SimilarTracks trackId={trackId} />
        </>
      )}
    </Modal>
  );
}

/**
 * A song, as a compact row: small square cover, title, album underneath.
 *
 * Rows rather than tiles wherever a list of songs IS the content — a playlist, the library
 * preview — because a playlist is something you read down, and forty large tiles is a browsing
 * surface rather than a list.
 *
 * `onDisk` false means nobody has downloaded it yet, so the menu offers to fetch it instead of
 * to add it, and the row does not play.
 */
function SongRow({
  track,
  queue,
  index,
  label,
  say,
  onDisk = true,
  mine = true,
  albumMbid,
  onChanged,
  showRemove,
  variant = 'library',
}: {
  track: {
    trackId: number;
    title: string;
    artistName: string;
    albumTitle: string;
    durationS: number | null;
    favorite?: boolean;
    rating?: number;
  };
  queue?: MyTrack[];
  index?: number;
  label?: string;
  say: (k: 'good' | 'bad', t: string) => void;
  onDisk?: boolean;
  /**
   * In the caller's library. Defaults true because most rows come from lists
   * that are the library — playlists, My Library. An album page passes the
   * real flag, and a row that is not yours does not play: streaming checks
   * ownership, so a play control here would be a button that errors. It adds
   * instead, which is instant when the file is pooled.
   */
  mine?: boolean;
  /** Needed to start a download when the song is not on disk. */
  albumMbid?: string | null;
  onChanged?: () => void;
  showRemove?: boolean;
  /**
   * Search results read differently from library lists: the song bold with
   * the ARTIST underneath (a library list is already grouped by context; a
   * search result's context IS the artist), the row opens the album rather
   * than playing, and the action is an explicit button — Play when it is
   * yours, Add when the server has it, Request when it needs downloading.
   */
  variant?: 'library' | 'search';
}) {
  const p = usePlayer();
  const [failed, setFailed] = useState(false);
  const [picking, setPicking] = useState(false);
  const [info, setInfo] = useState(false);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  const current = p.current?.trackId === track.trackId;
  const url = albumArtUrl(track.artistName, track.albumTitle);

  const download = async (playlistId?: number) => {
    // With an album id the request is direct; without one the server resolves
    // the containing album by name — search results ranked by Last.fm carry
    // no MusicBrainz ids until someone actually wants the song.
    if (albumMbid) {
      await api.requestTrack(albumMbid, track.title, `${track.artistName} — ${track.title}`, playlistId);
    } else {
      await api.requestTrackByName(track.artistName, track.title, playlistId);
    }
    say(
      'good',
      playlistId
        ? `Getting ${track.title}. It joins the playlist when it lands.`
        : `Getting ${track.title}. The album downloads in the background; only this song is added.`,
    );
  };

  /** Instant add for a pooled song that is not in the library yet. */
  const addInstant = async () => {
    await api.addTrack(track.trackId);
    say('good', `Added ${track.title} to your library`);
    onChanged?.();
  };

  const items: MenuItem[] = onDisk
    ? [
        ...(!mine
          ? [
              {
                label: 'Add to library',
                onSelect: () => void addInstant().catch((e: Error) => say('bad', e.message)),
              },
            ]
          : []),
        { label: 'Add to playlist', onSelect: () => setPicking(true) },
        ...(showRemove
          ? [
              {
                label: 'Remove from library',
                danger: true,
                onSelect: () => {
                  void api
                    .removeTrack(track.trackId)
                    .then(() => {
                      staleRecBlocks();
                      say('good', `Removed ${track.title} — the file is kept`);
                      onChanged?.();
                    })
                    .catch((e: Error) => say('bad', e.message));
                },
              },
            ]
          : []),
        { label: 'Info', onSelect: () => setInfo(true) },
      ]
    : [
        { label: 'Add to playlist', hint: 'downloads', onSelect: () => setPicking(true) },
        { label: 'Add to library', hint: 'downloads', onSelect: () => void download().catch((e: Error) => say('bad', e.message)) },
        { label: 'Info', disabled: true, hint: 'not downloaded', onSelect: () => undefined },
      ];

  /** The search variant's explicit action, by state. */
  const actionButton =
    variant !== 'search' ? null : mine ? (
      <button
        className="pbicon sm"
        title="Play"
        onClick={(e) => {
          e.stopPropagation();
          p.play([playable(track as MyTrack)], 0, label ?? '');
        }}
      >
        <IconPlay />
      </button>
    ) : onDisk ? (
      <button
        className="btn sm"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          setBusy(true);
          void addInstant()
            .catch((err: Error) => say('bad', err.message))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Adding…' : 'Add'}
      </button>
    ) : (
      <button
        className="btn sm"
        disabled={busy || asked}
        onClick={(e) => {
          e.stopPropagation();
          setBusy(true);
          void download()
            .then(() => setAsked(true))
            .catch((err: Error) => say('bad', err.message))
            .finally(() => setBusy(false));
        }}
      >
        {asked ? 'Requested' : busy ? 'Requesting…' : 'Request'}
      </button>
    );

  const rowClick = () => {
    if (variant === 'search') {
      // The row shows; the button acts. An album page needs files on disk —
      // for anything else the preview modal is the album page's stand-in.
      if (onDisk && track.albumTitle) {
        navigate({ name: 'albumpage', artist: track.artistName, album: track.albumTitle });
      } else {
        setPreview(true);
      }
      return;
    }
    if (!onDisk) return;
    if (!mine) {
      // Not in the library, so it cannot stream — tapping it adds it,
      // which is what tapping a song you do not have means.
      void addInstant().catch((e: Error) => say('bad', e.message));
      return;
    }
    if (queue && index !== undefined) p.play(queue.map(playable), index, label ?? '');
    else p.play([playable(track as MyTrack)], 0, label ?? '');
  };

  return (
    <>
      <WithMenu items={items} className="songrowwrap">
        <div
          className={`songrow${current ? ' playing' : ''}${
            variant === 'library' && !(onDisk && mine) ? ' notmine' : ''
          }`}
          onClick={rowClick}
        >
          <div className="cover">
            {!failed ? (
              <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
            ) : (
              <span>{track.title.slice(0, 1).toUpperCase()}</span>
            )}
          </div>
          <div className="words">
            <div className="t">
              {(track.rating ?? 0) > 0 && (
                <span className="favstar" title={`Rated ${track.rating} of 5`}>
                  ★{track.rating}
                </span>
              )}
              {track.title}
            </div>
            <div className="s">
              {/* The ARTIST, not the album. A song row already shows the album
                  as its cover art, and in any mixed list — a playlist, the
                  library, search results — the artist is what identifies the
                  song. On an album page the album was printed on every row,
                  which said nothing the heading had not. */}
              {track.artistName || track.albumTitle}
              {variant !== 'search' && (!onDisk || !mine) && ' · not in your library'}
            </div>
          </div>
          {/* A song you cannot play is one you might download, and thirty
              seconds is how you decide. Present whenever the row is not
              yours to play — on disk but not in your library counts, since
              the pooled file is not yours to hear yet either. */}
          {(!onDisk || !mine) && track.artistName && (
            <PreviewButton
              artist={track.artistName}
              title={track.title}
              /*
               * The ARTIST and the row's position both belong in this key. Downloadable
               * search hits all carry trackId 0, so a search for "Lux Aeterna" made every
               * version of it key as "row:0:Lux Aeterna" — press one preview and the whole
               * page showed itself as playing. Artist separates the covers; the index
               * separates two rows that are genuinely the same song.
               */
              k={`row:${track.trackId}:${track.artistName}:${track.title}:${index ?? 0}`}
            />
          )}
          {actionButton ??
            // No dash for an unknown length: a placeholder that answers no
            // question is just clutter.
            (track.durationS ? <div className="len">{secs(track.durationS)}</div> : null)}
        </div>
      </WithMenu>
      {preview && (
        <SongPreviewModal
          artist={track.artistName}
          title={track.title}
          say={say}
          onClose={() => setPreview(false)}
          onGot={() => setAsked(true)}
        />
      )}

      {picking && (
        <PlaylistPicker
          title={`“${track.title}”`}
          say={say}
          onClose={() => setPicking(false)}
          onPick={async (id) => {
            if (onDisk) {
              // A playlist references the library, so joining one implies joining
              // the library — a no-op when it is already there.
              if (!mine) await api.addTrack(track.trackId);
              await api.addToPlaylist(id, [track.trackId]);
              say('good', `Added ${track.title}`);
            } else {
              await download(id);
            }
            onChanged?.();
          }}
        />
      )}
      {info && <TrackInfoModal trackId={track.trackId} onClose={() => setInfo(false)} />}
    </>
  );
}

/**
 * The album menu and its info panel.
 *
 * Same shape as the song menu on purpose — add to playlist, add or remove from the library,
 * info, go to the artist — because the whole point of this pass is that the three object types
 * behave the same way. Removing an album removes its tracks from the library and leaves the
 * files alone, exactly as removing a song does.
 */
function AlbumMenu({
  artist,
  album,
  mine,
  say,
  onChanged,
}: {
  artist: string;
  album: string;
  /** Tracks of this album the user holds. 0 means nothing of it is theirs yet. */
  mine: number;
  say: (k: 'good' | 'bad', t: string) => void;
  onChanged?: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [info, setInfo] = useState(false);
  const [busy, setBusy] = useState(false);

  const tracks = useCallback(
    () => api.album(artist, album).then((r) => r.tracks),
    [artist, album],
  );

  const items: MenuItem[] = [
    { label: 'Add to playlist', onSelect: () => setPicking(true) },
    mine > 0
      ? {
          label: 'Remove from library',
          danger: true,
          onSelect: () => {
            setBusy(true);
            void tracks()
              .then(async (ts) => {
                const owned = ts.filter((t) => t.mine);
                for (const t of owned) await api.removeTrack(t.trackId);
                staleRecBlocks();
                say('good', `Removed ${owned.length} track${owned.length === 1 ? '' : 's'} — files kept`);
                onChanged?.();
              })
              .catch((e: Error) => say('bad', e.message))
              .finally(() => setBusy(false));
          },
        }
      : {
          label: 'Add to library',
          onSelect: () => {
            setBusy(true);
            void tracks()
              .then(async (ts) => {
                const missing = ts.filter((t) => !t.mine);
                for (const t of missing) await api.addTrack(t.trackId);
                say(
                  'good',
                  missing.length
                    ? `Added ${missing.length} track${missing.length === 1 ? '' : 's'}`
                    : 'None of that album is available yet — open the artist page to request it',
                );
                onChanged?.();
              })
              .catch((e: Error) => say('bad', e.message))
              .finally(() => setBusy(false));
          },
        },
    { label: 'Info', onSelect: () => setInfo(true) },
    {
      label: 'Go to artist',
      onSelect: () => {
        void api
          .search(artist)
          .then((r) => {
            const exact =
              r.artists.find((a) => a.name.toLowerCase() === artist.toLowerCase()) ?? r.artists[0];
            if (exact) {
              rememberArtist(exact.mbid, exact.name);
              navigate({ name: 'artist', mbid: exact.mbid });
            }
            else say('bad', `No metadata for ${artist}`);
          })
          .catch((e: Error) => say('bad', e.message));
      },
    },
  ];

  return (
    <>
      <span style={busy ? { opacity: 0.6 } : undefined} />
      <WithMenu items={items}>
        <span />
      </WithMenu>
      {picking && (
        <PlaylistPicker
          title={`“${album}”`}
          say={say}
          onClose={() => setPicking(false)}
          onPick={async (id) => {
            const ts = await tracks();
            // A playlist references the library, so joining one implies joining
            // the library — instant here, since these tracks are pooled.
            const missing = ts.filter((t) => !t.mine);
            for (const t of missing) await api.addTrack(t.trackId);
            const all = ts.map((t) => t.trackId);
            if (!all.length) {
              say('bad', 'None of that album is available yet — open the artist page to request it');
              return;
            }
            await api.addToPlaylist(id, all);
            say('good', `Added ${all.length} track${all.length === 1 ? '' : 's'}`);
            onChanged?.();
          }}
        />
      )}
      {info && <AlbumInfoModal artist={artist} album={album} onClose={() => setInfo(false)} />}
    </>
  );
}

function AlbumInfoModal({
  artist,
  album,
  onClose,
}: {
  artist: string;
  album: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<AlbumPage | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.album(artist, album).then(setData).catch((e: Error) => setErr(e.message));
  }, [artist, album]);

  const mine = data?.tracks.filter((t) => t.mine) ?? [];
  const totalS = mine.reduce((n, t) => n + (t.durationS ?? 0), 0);
  const plays = mine.reduce((n, t) => n + t.plays, 0);

  return (
    <Modal title={album} onClose={onClose}>
      {err && <div className="note bad">{err}</div>}
      {!data && !err && <div className="spinner">Loading…</div>}
      {data && (
        <>
          <InfoRow label="Artist" value={artist} />
          <InfoRow label="On the server" value={`${data.tracks.length} tracks`} />
          <InfoRow label="In your library" value={`${mine.length} tracks`} />
          <InfoRow label="Total length" value={totalS ? secs(totalS) : null} />
          <InfoRow label="Plays" value={plays} />
          <InfoRow
            label="Other albums"
            value={data.otherAlbums.length ? `${data.otherAlbums.length} by this artist` : null}
          />
          <InfoRow
            label="Similar artists"
            value={data.similar.length ? data.similar.map((s) => s.name).join(', ') : null}
          />
        </>
      )}
    </Modal>
  );
}

/** The artist menu: the same grammar again — playlist, library, info, and the artist page. */
/**
 * Which artists this person's recommendations are suppressing, cached once per
 * session rather than fetched by every tile — a shelf mounts fourteen menus.
 *
 * Two sources, one meaning: an explicit "don't recommend", and the implicit
 * block created by removing an artist's tracks from the library. The menu
 * shows "Recommend again" for either.
 */
let recBlocks: Promise<Set<string>> | null = null;
function loadRecBlocks(): Promise<Set<string>> {
  recBlocks ??= api
    .excludes()
    .then((r) => {
      const set = new Set<string>();
      for (const e of r.excludes) if (e.kind === 'artist') set.add(e.label.toLowerCase());
      for (const a of r.removedArtists) set.add(a.toLowerCase());
      return set;
    })
    .catch(() => new Set<string>());
  return recBlocks;
}
/** Call after anything that changes exclusions or removals. */
function staleRecBlocks(): void {
  recBlocks = null;
}

function ArtistMenu({
  name,
  mbid,
  say,
  inLibrary = false,
  onChanged,
}: {
  name: string;
  mbid?: string;
  say: (k: 'good' | 'bad', t: string) => void;
  /**
   * Whether the caller holds tracks by this artist. The menu is built from
   * this, because a menu has to describe the object it is attached to:
   * "Remove from library" on an artist who was never in the library is not an
   * option, it is a bug report waiting to be filed — and it was.
   */
  inLibrary?: boolean;
  onChanged?: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [info, setInfo] = useState(false);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    let dead = false;
    void loadRecBlocks().then((b) => !dead && setBlocked(b.has(name.toLowerCase())));
    return () => {
      dead = true;
    };
  }, [name]);

  const mineTracks = useCallback(
    () => api.queue({ kind: 'artist', artist: name }).then((r) => r.tracks),
    [name],
  );

  const items: MenuItem[] = [
    ...(inLibrary
      ? [
          { label: 'Add to playlist', onSelect: () => setPicking(true) },
          {
            label: 'Remove from library',
            danger: true,
            onSelect: () => {
              void mineTracks()
                .then(async (ts) => {
                  for (const t of ts) await api.removeTrack(t.trackId);
                  staleRecBlocks();
                  say('good', `Removed ${ts.length} track${ts.length === 1 ? '' : 's'} — files kept`);
                  onChanged?.();
                })
                .catch((e: Error) => say('bad', e.message));
            },
          },
        ]
      : []),
    blocked
      ? {
          label: 'Recommend again',
          onSelect: () => {
            void api
              .recommendAgain(name)
              .then(() => {
                staleRecBlocks();
                setBlocked(false);
                say('good', `${name} can be recommended again`);
              })
              .catch((e: Error) => say('bad', e.message));
          },
        }
      : {
          label: "Don't recommend",
          onSelect: () => {
            void api
              .addExclude({ kind: 'artist', artist: name })
              .then(() => {
                staleRecBlocks();
                setBlocked(true);
                say('good', `Won't base recommendations on ${name}`);
              })
              .catch((e: Error) => say('bad', e.message));
          },
        },
    { label: 'Info', onSelect: () => setInfo(true) },
    {
      label: 'Go to artist',
      onSelect: () => {
        if (mbid) {
          rememberArtist(mbid, name);
          navigate({ name: 'artist', mbid });
          return;
        }
        void api
          .search(name)
          .then((r) => {
            const exact =
              r.artists.find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? r.artists[0];
            if (exact) {
              rememberArtist(exact.mbid, exact.name);
              navigate({ name: 'artist', mbid: exact.mbid });
            }
            else say('bad', `No metadata for ${name}`);
          })
          .catch((e: Error) => say('bad', e.message));
      },
    },
  ];

  return (
    <>
      <WithMenu items={items}>
        <span />
      </WithMenu>
      {picking && (
        <PlaylistPicker
          title={name}
          say={say}
          onClose={() => setPicking(false)}
          onPick={async (id) => {
            const ts = await mineTracks();
            if (!ts.length) {
              say('bad', `Nothing by ${name} is in your library yet`);
              return;
            }
            await api.addToPlaylist(id, ts.map((t) => t.trackId));
            say('good', `Added ${ts.length} track${ts.length === 1 ? '' : 's'}`);
          }}
        />
      )}
      {info && <ArtistInfoModal name={name} mbid={mbid} onClose={() => setInfo(false)} />}
    </>
  );
}

function ArtistInfoModal({
  name,
  mbid,
  onClose,
}: {
  name: string;
  mbid?: string;
  onClose: () => void;
}) {
  const [d, setD] = useState<ArtistDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const go = (id: string) => api.artist(id).then(setD).catch((e: Error) => setErr(e.message));
    if (mbid) {
      void go(mbid);
      return;
    }
    void api
      .search(name)
      .then((r) => {
        const exact =
          r.artists.find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? r.artists[0];
        if (exact) return go(exact.mbid);
        setErr(`No metadata for ${name}`);
      })
      .catch((e: Error) => setErr(e.message));
  }, [name, mbid]);

  return (
    <Modal title={name} onClose={onClose}>
      {err && <div className="note bad">{err}</div>}
      {!d && !err && <div className="spinner">Loading…</div>}
      {d && (
        <>
          <InfoRow label="Also known as" value={d.artist.disambiguation} />
          <InfoRow label="Genres" value={(d.artist.genres ?? []).join(', ')} />
          <InfoRow label="Albums" value={d.albumCount} />
          <InfoRow label="In your library" value={`${d.artist.albumsHeld ?? 0} albums, ${d.artist.trackCount ?? 0} tracks`} />
          {d.artist.overview && (
            <div style={{ marginTop: 12, fontSize: '0.88rem', lineHeight: 1.55 }}>
              {d.artist.overview}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

/**
 * An artist biography, clamped with a toggle.
 *
 * A biography can run to several paragraphs, which would push the discography off the
 * screen — the discography is what somebody came to the page for.
 */
function ArtistBio({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 320;
  return (
    <div className="bio">
      <p className={open || !long ? '' : 'clamp'}>{text}</p>
      {long && (
        <button className="btn sec sm" onClick={() => setOpen(!open)}>
          {open ? 'Less' : 'More'}
        </button>
      )}
    </div>
  );
}
