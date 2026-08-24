import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { LastFm } from '../lib/lastfm.js';
import { canonAlbum, type Library } from '../lib/library.js';
import type { Notifier } from '../lib/notify.js';
import type { ArtCache } from '../lib/artcache.js';
import type { PlaylistArt } from '../lib/playlistart.js';
import type { Recommender } from '../lib/recommend.js';
import { UserLibrary } from '../lib/userlib.js';
import type { Prowlarr } from '../lib/prowlarr.js';
import type { Sab } from '../lib/sab.js';
import type { Qbit } from '../lib/qbit.js';
import type { Settings } from '../lib/settings.js';
import { adminRoutes } from './admin.js';
import { playRoutes } from './play.js';
import { djRoutes } from './dj.js';
import { Dj } from '../lib/dj.js';
import type { PageWarmer } from '../lib/warm.js';
import type { Pipeline } from '../lib/pipeline.js';
import type { Lyrics } from '../lib/lyrics.js';
import type { MusicImport, ImportRow } from '../lib/musicimport.js';
import type { AlbumHit, ArtistHit, MusicBrainz } from '../lib/musicbrainz.js';
import { FAMILY_LABEL, familyOf, type Family } from '../lib/genrefam.js';
import { listeningSummary } from '../lib/listening.js';
import type { Store } from '../lib/store.js';
import type { ITunes } from '../lib/itunes.js';
import type { Uploads } from '../lib/upload.js';
import { uploadRoutes } from './upload.js';
import type { AcoustId } from '../lib/acoustid.js';
import type { OpenAi } from '../lib/openai.js';
import type { SongCharacteristics } from '../lib/songcharacteristics.js';
import {
  CHARACTERISTICS,
  GROUP_LABEL,
  activeKeys as activeCharacteristicKeys,
} from '../lib/characteristics.js';
import type { Similarity } from '../lib/similarity.js';
import type { Algo, WarmthKind } from '../lib/algo.js';
import { excludeSet, normalise, suggest, suggestFromInput } from '../lib/taste.js';
import { score } from '../lib/release.js';
import { publicUser } from './auth.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PluginState, RETIRED_PLUGIN_IDS, type CratePlugin, type PluginContext } from '../lib/plugin.js';
import { PLUGINS as BUILTIN_PLUGINS } from '../plugins/index.js';
import { PluginRepo } from '../lib/pluginrepo.js';
import { getBytes, getJson, getText } from '../lib/http.js';

/**
 * The most any Discover shelf will ever hold.
 *
 * The page shows twenty and pages up to this. Both the recommender and the
 * chart endpoint are asked for exactly this many so "show more" always has
 * something behind it — a button that reveals nothing is worse than no button.
 */
const PAGE_MAX = 100;

interface Deps {
  /** The raw handle, passed through to plugins — they own their own tables. */
  db: Database.Database;
  /** Every plugin this process runs: compiled-in plus installed. See lib/plugin.ts. */
  plugins: CratePlugin[];
  /** Where installed plugins' downloaded artifacts live. */
  pluginDir: string;
  store: Store;
  lastfm: LastFm;
  /** The metadata source: search, discographies, track listings. */
  mb: MusicBrainz;
  /** Bearer token for callers with no browser session. Null disables that path. */
  apiKey: string | null;
  /** Name of crate's own session cookie. */
  cookieName: string;
  /** What crate owns, from its own index of the files on disk. */
  library: Library;
  settings: Settings;
  prowlarr: Prowlarr;
  sab: Sab;
  qbit: Qbit;
  notifier: Notifier;
  userlib: UserLibrary;
  recommender: Recommender;
  lyrics: Lyrics;
  /** Thirty-second previews for songs not on disk. */
  itunes: ITunes;
  /** Bring-your-own-album staging and finalize. */
  uploads: Uploads;
  /** Optional fingerprint identification for uploads. */
  acoustid: AcoustId;
  /** Optional AI arbitration for track matching. */
  openai: OpenAi;
  /** Song characteristics: the per-track vector. Readable always, analysed only when enabled. */
  songchars: SongCharacteristics;
  /** Similarity over those vectors. A reusable primitive, not a recommender — see lib/similarity.ts. */
  similarity: Similarity;
  warmer: PageWarmer;
  /** Warmth profiles: what the library sorts by and discovery leans toward. */
  algo: Algo;
  /** Where completed music downloads land, for adoption. */
  adoptRoot: string;
  musicimport: MusicImport;
  artcache: ArtCache;
  playlistart: PlaylistArt;
  musicRoot: string;
  trashRoot: string;
  /** The download path. Always present; an unconfigured Prowlarr or SABnzbd
   *  fails the individual request with a message pointing at the admin page. */
  pipeline: Pipeline;
}

interface Caller {
  /** Row id, or null for the API-key caller, which is not a user. */
  id: number | null;
  user: string;
  name: string;
  isAdmin: boolean;
  /** True when identified by API key rather than a browser session. */
  viaToken: boolean;
}

/**
 * The whole HTTP surface.
 *
 * Identity is crate's own: a session cookie backed by a row in its own database,
 * or a bearer token for callers with no browser. gatekeeper is an optional extra
 * layer that can be placed in front of this host — it is not this app's identity
 * system, and crate stands on its own without it.
 */
/**
 * A placeholder row for handing a freshly created request to the pipeline.
 *
 * pipeline.start only reads id, mbid and title; re-reading the row from SQLite
 * purely to pass it back would be a query for nothing.
 */
const emptyRow = {
  kind: 'album' as const,
  artist_name: '',
  asked_for: '',
  requested_by: '',
  requested_at: 0,
  album_count: 1,
  status: 'queued' as const,
  lidarr_id: null,
  error: null,
};

export function apiRoutes(app: FastifyInstance, deps: Deps): void {
  const { store, lastfm } = deps;
  // Which plugins are switched on. Constructed here, not at the registration loop below,
  // because /api/me reports the disabled set and is defined first.
  const pluginState = new PluginState(deps.db);
  // Ids compiled into this build — the ones install/uninstall must refuse to touch.
  const PLUGINS_BUILTIN = new Set(BUILTIN_PLUGINS.map((p) => p.id));

  /**
   * crate-served artwork URLs, keyed by name.
   *
   * Every image the API hands out points back at /api/art, which resolves
   * through the local cache and only then to Cover Art Archive or Deezer. The
   * client never sees a remote image host.
   */
  const artistImages = (name: string) => {
    if (!name) return {};
    const u = `/api/art/artist?name=${encodeURIComponent(name)}`;
    // poster fills the card; fanart is the artist hero background. Same image —
    // Deezer's 1000×1000 crops acceptably for both.
    return { poster: u, fanart: u };
  };
  const albumImages = (artist: string, album: string, mbid?: string) =>
    artist && album
      ? {
          cover:
            `/api/art/album?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}` +
            // The release-group id turns the lookup into a direct Cover Art
            // Archive fetch instead of a rate-limited search.
            (mbid ? `&mbid=${encodeURIComponent(mbid)}` : ''),
        }
      : {};

  /**
   * Who is asking.
   *
   * Deliberately reads no reverse-proxy headers. Trusting one would mean crate
   * could not work without a particular proxy in front of it, and worse, that
   * anything able to set that header could impersonate any user.
   */
  function caller(req: FastifyRequest): Caller | null {
    const token = String(req.cookies?.[deps.cookieName] ?? '');
    if (token) {
      const u = store.userForSession(token);
      if (u) {
        return {
          id: u.id,
          user: u.username,
          name: u.display_name || u.username,
          isAdmin: Boolean(u.is_admin),
          viaToken: false,
        };
      }
    }

    const auth = String(req.headers.authorization ?? '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (deps.apiKey && bearer && bearer === deps.apiKey) {
      // NOT an admin.
      //
      // The bearer key exists so a script with no browser can call /api/similar and
      // make requests. It used to report isAdmin, which was already generous when
      // admin meant user management — and became an escalation once the admin API
      // could rewrite the download client and indexer credentials. A machine
      // credential should reach the request surface, not the configuration.
      //
      // Administration requires a real account, which also means every settings
      // change is attributable to a person.
      return { id: null, user: 'api', name: 'API client', isAdmin: false, viaToken: true };
    }
    return null;
  }

  /**
   * Guard: it has already replied when it returns null.
   *
   * `needsLogin` is what the client keys off to show the sign-in screen, rather
   * than the client inferring it from a 401 that could equally mean an expired
   * session or a bad bearer token.
   */
  function need(
    req: FastifyRequest,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ): Caller | null {
    const c = caller(req);
    if (c) return c;
    reply.code(401).send({ error: 'sign in to continue', needsLogin: true });
    return null;
  }

  // ---- reads -------------------------------------------------------------

  app.get('/api/health', async () => {
    return { ok: true, lastfm: lastfm.enabled };
  });

  app.get('/api/me', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const since = Math.floor(Date.now() / 1000) - 86400;
    const cfg = deps.settings.all();
    return {
      // The client needs the id to change its own password.
      id: c.id,
      user: c.user,
      name: c.name,
      admin: c.isAdmin,
      // Whether a streaming password exists, never what it is.
      streamPasswordSet: Boolean(c.id && store.userById(c.id)?.stream_password),
      homePage: (c.id && store.userById(c.id)?.home_page) || 'discover',
      viaToken: c.viaToken,
      albumsToday: store.albumsQueuedSince(c.user, since),
      // 0 means unlimited on both. Settings rather than env, so the operator
      // can change them from the admin page.
      dailyAlbumCap: cfg.dailyAlbumCap,
      maxAlbumsPerRequest: cfg.maxAlbumsPerRequest,
      // Which plugins the admin has switched off, so the client hides their UI slots.
      // Usually empty; the ids of switched-off plugins otherwise.
      disabledPlugins: deps.plugins
        .filter((p) => !pluginState.isEnabled(p.id))
        .map((p) => p.id),
    };
  });

  /**
   * Per-account preferences. Just the home page for now: which view '/' opens.
   */
  app.post('/api/me/prefs', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no preferences' });
    const page = String(((req.body ?? {}) as { homePage?: unknown }).homePage ?? '');
    if (!['discover', 'mylibrary', 'playlists'].includes(page)) {
      return reply.code(400).send({ error: 'homePage must be discover, mylibrary or playlists' });
    }
    store.setHomePage(c.id, page);
    return { ok: true, homePage: page };
  });

  /**
   * What is on disk, from crate's own index.
   *
   * Not from Lidarr. Lidarr's library holds a metadata row for every album of
   * every artist it has been told about, so asking it returned artists and albums
   * that were never downloaded. crate's index counts audio files.
   *
   * Artwork is fetched by name because these rows are keyed by folder and may
   * predate crate entirely, so there is no mbid to key artwork on.
   */
  app.get('/api/library', async (req, reply) => {
    if (!need(req, reply)) return;
    return {
      artists: deps.library.artists().map((a) => ({
        mbid: '',
        name: a.name,
        trackFiles: a.trackFiles,
        images: { poster: `/api/art/artist?name=${encodeURIComponent(a.name)}` },
      })),
    };
  });

  /**
   * Search, with in-library flags resolved.
   *
   * MusicBrainz supplies the results; whether something is held comes from
   * crate's own index of the files on disk. A cold search is two rate-gated
   * MusicBrainz calls (~2s); everything after that answers from the cache.
   */
  /**
   * A name to an artist mbid, and nothing else.
   *
   * Exists because the front page's artist tiles carry a Last.fm name and no
   * id, so opening one has to resolve it first — and /api/search was doing that
   * job at twice the cost, searching release groups as well and throwing the
   * albums away. That second search is the slower of the two, so halving the
   * work removes rather more than half the wait.
   */
  app.get('/api/artist/resolve', async (req, reply) => {
    if (!need(req, reply)) return;
    const name = String((req.query as Record<string, string>).name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name is required' });
    const hits = await deps.mb.searchArtists(name, 3);
    // Prefer an exact name over the top-scoring one: a search for "Bush"
    // outranks the band with a better-known solo artist often enough to matter.
    const exact =
      hits.find((h) => h.name.toLowerCase() === name.toLowerCase()) ?? hits[0] ?? null;
    return { artist: exact ? { mbid: exact.mbid, name: exact.name } : null };
  });

  /**
   * The instant half of search: what crate already knows, straight from SQLite, no network.
   *
   * This exists so the search page has something on it while somebody is still typing —
   * /api/search below is a live MusicBrainz lookup that legitimately takes seconds, and the
   * client only fires it once the typing pauses. Everything here must stay answerable in
   * single-digit milliseconds; anything that costs a network call belongs in the other half.
   */
  app.get('/api/search/local', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const q = String((req.query as Record<string, string>).q ?? '').trim();
    if (q.length < 2) return { tracks: [], artists: [], albums: [] };

    const pool = deps.userlib.searchPool(q, 40);
    const mineIds = c.id ? deps.userlib.minesOf(c.id, pool.map((t) => t.trackId)) : new Set<number>();
    // Same order as /api/tracks/search builds, deliberately: when the full results land they
    // replace this list with an identical prefix, so nothing jumps under the cursor.
    pool.sort((a, b) => Number(mineIds.has(b.trackId)) - Number(mineIds.has(a.trackId)));

    return {
      tracks: pool.map((t) => ({
        trackId: t.trackId,
        title: t.title,
        artistName: t.artistName,
        albumTitle: t.albumTitle,
        trackNo: t.trackNo,
        durationS: t.durationS,
        onDisk: true,
        mine: mineIds.has(t.trackId),
        albumMbid: null as string | null,
      })),
      artists: deps.userlib.searchLocalArtists(q).map((a) => ({
        name: a.name,
        images: artistImages(a.name),
      })),
      albums: deps.userlib.searchLocalAlbums(q).map((al) => ({
        artistName: al.artistName,
        title: al.title,
        mbid: al.mbid,
        images: albumImages(al.artistName, al.title, al.mbid ?? undefined),
      })),
    };
  });

  app.get('/api/search', async (req, reply) => {
    if (!need(req, reply)) return;
    const q = String((req.query as Record<string, string>).q ?? '').trim();
    if (q.length < 2) return { artists: [], albums: [] };

    const hits = await deps.mb.search(q);
    const heldNames = new Set(deps.library.artists(500).map((a) => normalise(a.name)));

    const artists = hits.filter((h): h is ArtistHit => h.kind === 'artist');
    const albums = hits.filter((h): h is AlbumHit => h.kind === 'album');

    return {
      artists: artists.map((a) => ({
        ...a,
        images: artistImages(a.name),
        held: heldNames.has(normalise(a.name)),
      })),
      albums: albums.map((a) => ({
        ...a,
        images: albumImages(a.artistName, a.title, a.mbid),
        held: Boolean(deps.library.held(a.mbid, a.artistName, a.title)),
        artistHeld: heldNames.has(normalise(a.artistName)),
        requested: store.alreadyRequested(a.mbid),
      })),
    };
  });

  /**
   * One artist, with the discography that makes the cap meaningful.
   *
   * MusicBrainz for identity and the discography, crate's own index for what is
   * actually on disk, Last.fm for the biography, and /api/art for the images.
   */
  app.get('/api/artist/:mbid', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const mbid = String((req.params as { mbid: string }).mbid);

    const [studio, info] = await Promise.all([
      deps.mb.studioAlbums(mbid),
      deps.mb.artistInfo(mbid),
    ]);
    const name = info?.name ?? '';

    // Held albums for this artist, so each row can be flagged and counted. Looked
    // up once rather than per album: the index is local but this is a hot path.
    const ownedByMbid = new Set<string>();
    const ownedByTitle = new Set<string>();
    for (const h of deps.library.albumsFor(name)) {
      if (h.mbid) ownedByMbid.add(h.mbid);
      // canonAlbum, not normalise: the file on disk is tagged "Ring Ring (2022
      // Remastered)" and MusicBrainz calls it "Ring Ring", so plain normalisation
      // compares two strings that will never be equal and reports zero held.
      ownedByTitle.add(canonAlbum(h.albumTitle));
    }
    const isHeld = (albumMbid: string, title: string): boolean =>
      ownedByMbid.has(albumMbid) || ownedByTitle.has(canonAlbum(title));

    // Albums crate holds that MusicBrainz's release-group list does not mention — a live
    // bootleg, a compilation, anything tagged unusually. Leaving them off an artist page that
    // claims to show everything would be the page lying about what you own.
    /*
     * Start resolving every cover now, without waiting for any of them.
     *
     * The browser asks for one cover per album the instant this response lands,
     * and a cold cover costs Cover Art Archive one and a half to three seconds.
     * Starting them here buys that time back: by the time each request arrives
     * the fetch is already in flight, and artcache runs one resolution per key
     * however many callers are waiting, so joining costs nothing. Whatever is
     * not ready inside the art route's budget 404s and the client's retry
     * ladder picks it up already warm.
     *
     * Deliberately not awaited. This is a page of artwork, not the page.
     */
    for (const a of studio) {
      void deps.artcache.album(name, a.title, [], a.mbid).catch(() => null);
    }

    const held = c.id ? deps.userlib.albumsByArtist(c.id, name) : [];
    const inStudio = new Set(studio.map((a) => canonAlbum(a.title)));
    const extra = held.filter((h) => !inStudio.has(canonAlbum(h.albumTitle)));

    return {
      artist: {
        mbid,
        name,
        held: ownedByTitle.size > 0,
        images: artistImages(name),
        overview: lastfm.enabled && name ? await lastfm.artistBio(name).catch(() => '') : '',
        genres: info?.genres ?? [],
        disambiguation: info?.disambiguation ?? '',
        country: info?.country ?? '',
        began: info?.began ?? '',
        ended: info?.ended ?? '',
        trackCount: held.reduce((n, h) => n + h.mine, 0),
        albumsHeld: held.filter((h) => h.mine > 0).length,
      },
      albumCount: studio.length + extra.length,
      heldCount: studio.filter((a) => isHeld(a.mbid, a.title)).length + extra.length,
      onDiskOnly: extra.map((h) => ({
        albumTitle: h.albumTitle,
        mine: h.mine,
        onDisk: h.onDisk,
      })),
      // Tracks where they play but own no album. For most artists this is empty; for a
      // featured guest it is the only thing their page can show.
      // Every track of theirs already on the shelves — the Songs tab. Local SQLite, so it
      // rides along free on a response that already paid for two MusicBrainz calls.
      songs: (() => {
        const pool = store.poolByNormArtist(normalise(name), 2000);
        const mine = c.id ? deps.userlib.minesOf(c.id, pool.map((t) => t.trackId)) : new Set<number>();
        return pool.map((t) => ({
          trackId: t.trackId,
          title: t.title,
          artistName: t.artistName,
          albumTitle: t.albumTitle,
          trackNo: t.trackNo,
          durationS: t.durationS,
          onDisk: true,
          mine: mine.has(t.trackId),
          albumMbid: null as string | null,
          addedAt: null as number | null,
        }));
      })(),
      appearsOn: c.id ? deps.userlib.appearsOn(c.id, name) : [],
      albums: studio.map((a) => ({
        kind: 'album' as const,
        mbid: a.mbid,
        title: a.title,
        artistName: name,
        artistMbid: mbid,
        albumType: 'Album',
        trackFiles: 0,
        releaseDate: a.firstReleased,
        genres: [],
        images: albumImages(name, a.title, a.mbid),
        rating: null,
        libraryId: null,
        held: isHeld(a.mbid, a.title),
        requested: store.alreadyRequested(a.mbid),
      })),
      // Zero means MusicBrainz was unreachable, not that the artist has no
      // albums. Treating that as "over the cap" would block a Follow, which
      // downloads nothing and is always safe.
      wouldExceedPerRequest:
        deps.settings.all().maxAlbumsPerRequest > 0 &&
        studio.length > deps.settings.all().maxAlbumsPerRequest,
    };
  });

/**
   * Track listing for an album, from MusicBrainz in a single cached request.
   *
   * For albums crate holds, the pages that matter use /api/album (keyed by
   * names, answered from the pool) — this endpoint serves the ones it does not.
   */
  app.get('/api/album/:mbid/tracks', async (req, reply) => {
    if (!need(req, reply)) return;
    const mbid = String((req.params as { mbid: string }).mbid);

    const tracks = await deps.mb.tracks(mbid);
    return {
      source: 'musicbrainz',
      // hasFile is unknowable for an album crate does not hold, and reporting
      // false would claim the tracks are missing rather than unknown.
      tracks: tracks.map((t) => ({ ...t, hasFile: null })),
    };
  });

  app.get('/api/requests', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const q = req.query as Record<string, string>;
    // 'user' hides the album requests a library import creates, which on a big
    // export outnumber a person's own by a hundred to one. 'trouble' keeps only
    // what did not succeed — filtered in SQL, since the client holds a page and
    // the failures would otherwise be off the end of it.
    const source = q.source === 'user' || q.source === 'import' ? q.source : undefined;
    // Scoped to the caller UNLESS an admin asks for everyone. This used to be
    // opt-in via ?mine=1, which the client never sent — so with a second
    // account on the instance, everybody read everybody's request history.
    // Privacy enforced here, not by hoping the client asks politely.
    const all = String(q.all ?? '') === '1' && c.isAdmin;
    return {
      requests: store.requests({
        user: all ? undefined : c.user,
        source,
        trouble: String(q.trouble ?? '') === '1',
      }),
    };
  });

  /**
   * Clear this person's failed requests.
   *
   * Scoped to the caller the same way the listing is, and for the same reason: without it,
   * one account could wipe another's history. An admin viewing everyone can clear everyone,
   * but has to ask for it explicitly.
   */
  app.delete('/api/requests/failed', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const all = String((req.query as Record<string, string>).all ?? '') === '1' && c.isAdmin;
    const removed = store.clearFailedRequests(all ? undefined : c.user);
    app.log.warn({ user: c.user, removed, all }, 'failed requests cleared');
    return { ok: true, removed };
  });

  /**
   * The personalised front page.
   *
   * Assembled server-side so the client makes one call and the composition rules
   * live next to the data. Rows are only included when non-empty, so a thin
   * library produces a shorter page rather than a page of empty shelves.
   */
  app.get('/api/home', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) {
      return { cold: true, lastfm: lastfm.enabled, mostPlayed: [], newest: [], rec: null };
    }

    // Four rows, each answering a different question: what do you love, what just arrived,
    // and what should you try next. Recommendations are one mixed set of songs plus the
    // artists and albums that set came from, so the rows agree with each other instead of
    // telling three unrelated stories.
    // 100, because the page now pages through them twenty at a time. Building
    // is cached per user, so the extra costs one build rather than one a scroll.
    const [rec] = await Promise.all([deps.recommender.forUser(c.id, PAGE_MAX)]);
    // Both were 24, chosen when the shelves showed ten and everything past that
    // was unreachable. They page now, so they are asked for a full set.
    /*
     * Discover no longer LISTS these — they are the library looking at
     * itself, which is My Library's job. What remains is the hero, which
     * needs one row to name and a length to choose between them, so a
     * handful is plenty and the other ~190 track objects stop being shipped
     * on every load. The hero's play buttons fetch the real queue.
     */
    const mostPlayed = deps.userlib.mostPlayed(c.id, 4);
    const newest = deps.userlib.newest(c.id, 4);

    return {
      cold: rec.cold && mostPlayed.length === 0,
      lastfm: lastfm.enabled,
      counts: deps.userlib.counts(c.id),
      mostPlayed,
      newest,
      rec,
    };
  });

  /**
   * "Your listening": the timeline, the tops, and the vibe it adds up to.
   * `days` picks the window — a week by default, which is the one people mean.
   */
  app.get('/api/listening', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no history' });
    const days = Math.min(365, Math.max(1, Number((req.query as Record<string, string>).days) || 7));
    return listeningSummary(deps.db, c.id, days);
  });

  /**
   * Albums the caller owns only part of, where the pool already has the rest — a gap
   * that costs one click and no download to close.
   */
  app.get('/api/library/gaps', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return { albums: [] };
    return { albums: deps.userlib.incompleteAlbums(c.id) };
  });

  app.post('/api/library/gaps/fill', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no library' });
    const b = (req.body ?? {}) as { artist?: string; album?: string; all?: boolean };
    // `all` closes every gap at once — the whole point of the screen for somebody who
    // simply wants their albums whole.
    if (b.all) {
      let added = 0;
      let albums = 0;
      for (const a of deps.userlib.incompleteAlbums(c.id)) {
        const n = deps.userlib.fillAlbum(c.id, a.artistName, a.albumTitle);
        if (n > 0) {
          added += n;
          albums++;
        }
      }
      deps.recommender.invalidate(c.id);
      return { ok: true, added, albums };
    }
    const artist = String(b.artist ?? '').trim();
    const album = String(b.album ?? '').trim();
    if (!artist || !album) return reply.code(400).send({ error: 'artist and album are required' });
    const added = deps.userlib.fillAlbum(c.id, artist, album);
    deps.recommender.invalidate(c.id);
    return { ok: true, added, albums: added > 0 ? 1 : 0 };
  });

  /**
   * The library's genre vocabulary: what the Dynamic-playlist builder offers as chips.
   * Genres come with their counts and families; eras are the decades actually present;
   * energyReady says whether the analyzer has covered enough of the library for an
   * energy rule to mean anything yet.
   */
  /*
   * ---- SONG CHARACTERISTICS -----------------------------------------------
   *
   * A dense, comparable description of how each track sounds and feels (lib/characteristics.ts),
   * plus the similarity engine over those vectors (lib/similarity.ts).
   *
   * READS ARE ALWAYS AVAILABLE, even with the feature switched off: disabling stops new analysis,
   * it does not hide or delete what is known. Only the endpoints that would SPEND MONEY check
   * the switch.
   *
   * Scores stay numeric all the way out — never bucketed into tags — because the whole point is
   * that a listener's direction ("more energy, less dark, keep the atmosphere") is arithmetic
   * over these numbers.
   */

  /** The taxonomy and where analysis stands. What a settings or profile UI needs. */
  app.get('/api/characteristics', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    return { characteristics: deps.songchars.taxonomy(), progress: deps.songchars.progress() };
  });

  /** Analysis progress, for a batch display that polls. */
  app.get('/api/characteristics/progress', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const batchId = String((req.query as { batch?: string }).batch ?? '').trim();
    return {
      progress: deps.songchars.progress(),
      batch: batchId ? { batchId, ...deps.songchars.batchProgress(batchId) } : null,
    };
  });

  /** One track's profile and the state of its analysis. */
  app.get('/api/track/:trackId/characteristics', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const trackId = Number((req.params as { trackId: string }).trackId);
    if (!deps.userlib.byId(trackId)) return reply.code(404).send({ error: 'no such track' });
    return deps.songchars.statusOf(trackId);
  });

  /**
   * Analyse or reanalyse one track. Always forced — a person pressing this has asked for a fresh
   * answer, and silently skipping because the profile is current would look like a broken button.
   */
  app.post('/api/track/:trackId/characteristics/analyse', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!deps.songchars.enabled()) {
      return reply.code(409).send({ error: 'Song characteristics is switched off (Admin → Settings)' });
    }
    const trackId = Number((req.params as { trackId: string }).trackId);
    if (!deps.userlib.byId(trackId)) return reply.code(404).send({ error: 'no such track' });
    deps.songchars.queue([trackId], { force: true });
    return { ok: true, status: deps.songchars.statusOf(trackId) };
  });

  /**
   * Analyse a selection, or the whole library.
   *
   * The whole-library sweep is ADMIN ONLY: it is the one action that can run to thousands of paid
   * calls, and characteristics are shared metadata on a shared pool, so it is an operator decision
   * rather than a per-listener one.
   */
  app.post('/api/characteristics/analyse', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!deps.songchars.enabled()) {
      return reply.code(409).send({ error: 'Song characteristics is switched off (Admin → Settings)' });
    }
    const b = (req.body ?? {}) as { trackIds?: unknown; scope?: unknown; force?: unknown };
    const force = b.force === true;

    if (b.scope === 'library') {
      if (!c.isAdmin) {
        return reply.code(403).send({ error: 'only an admin can analyse the whole library' });
      }
      const batchId = `lib-${Math.floor(Date.now() / 1000)}`;
      return { ok: true, batchId, ...deps.songchars.queueLibrary(batchId, { force }) };
    }

    const ids = Array.isArray(b.trackIds)
      ? [...new Set(b.trackIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
      : [];
    if (!ids.length) return reply.code(400).send({ error: 'no tracks given' });
    if (ids.length > 500) return reply.code(400).send({ error: 'at most 500 tracks at a time' });
    const known = ids.filter((id) => deps.userlib.byId(id));
    if (!known.length) return reply.code(404).send({ error: 'none of those tracks exist' });
    const batchId = `sel-${Math.floor(Date.now() / 1000)}`;
    return { ok: true, batchId, ...deps.songchars.queue(known, { force, batchId }) };
  });

  /**
   * Set one characteristic by hand. Stored as source='manual', which survives reanalysis and
   * outranks the model for that dimension. Not gated on the feature switch: curating by hand
   * needs no AI and should keep working when the AI is off.
   */
  app.put('/api/track/:trackId/characteristics', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const trackId = Number((req.params as { trackId: string }).trackId);
    if (!deps.userlib.byId(trackId)) return reply.code(404).send({ error: 'no such track' });
    const b = (req.body ?? {}) as { key?: unknown; score?: unknown };
    if (!deps.songchars.setManual(trackId, String(b.key ?? '').trim(), Number(b.score))) {
      return reply.code(400).send({ error: 'unknown characteristic, or a score outside 0–1' });
    }
    return { ok: true, status: deps.songchars.statusOf(trackId) };
  });

  /** Undo a hand-set score. Any AI value for the same dimension reappears, which is correct. */
  app.delete('/api/track/:trackId/characteristics/:key', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const { trackId: rawId, key } = req.params as { trackId: string; key: string };
    const trackId = Number(rawId);
    if (!deps.userlib.byId(trackId)) return reply.code(404).send({ error: 'no such track' });
    deps.songchars.removeManual(trackId, key);
    return { ok: true, status: deps.songchars.statusOf(trackId) };
  });

  /**
   * How alike two tracks are, with the explanation.
   *
   * Returns the closest dimensions and the biggest differences alongside the number, because
   * "0.87" on its own is unfalsifiable — the breakdown is what makes a recommendation
   * explicable and a bad weight visible.
   */
  app.get('/api/track/:trackId/similarity/:otherId', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const { trackId, otherId } = req.params as { trackId: string; otherId: string };
    const a = Number(trackId);
    const b = Number(otherId);
    if (!deps.userlib.byId(a) || !deps.userlib.byId(b)) {
      return reply.code(404).send({ error: 'no such track' });
    }
    return deps.similarity.compareTracks(a, b);
  });

  /**
   * The nearest tracks to this one by characteristic profile.
   *
   * NOT a recommender. The most similar song is frequently the worst next song — it is the same
   * song again — so this is exposed as the primitive it is, and anything that wants to play music
   * composes on top. `sameArtist=false` is the common case: a track's true nearest neighbours are
   * usually the rest of its own album, which is correct and useless.
   */
  app.get('/api/track/:trackId/similar', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const trackId = Number((req.params as { trackId: string }).trackId);
    if (!deps.userlib.byId(trackId)) return reply.code(404).send({ error: 'no such track' });
    const q = req.query as { limit?: string; sameArtist?: string };
    const r = deps.similarity.findSimilar(trackId, {
      limit: Number(q.limit) || 12,
      sameArtist: q.sameArtist === 'true',
    });
    return { trackId, ...r };
  });

  /**
   * Rank the library against an arbitrary target profile.
   *
   * This is the endpoint recommendation will actually be built on: take a track's vector, push
   * energy up and darkness down, and search for THAT rather than for the song playing. Same
   * distance function as track-to-track, no duplicated maths.
   */
  app.post('/api/characteristics/similar', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const b = (req.body ?? {}) as { profile?: unknown; limit?: unknown; exclude?: unknown };
    if (!b.profile || typeof b.profile !== 'object') {
      return reply.code(400).send({ error: 'a target profile is required' });
    }
    const r = deps.similarity.findSimilar(b.profile as Record<string, number>, {
      limit: Number(b.limit) || 20,
      exclude: Array.isArray(b.exclude) ? b.exclude.map(Number) : [],
    });
    return r;
  });

  app.get('/api/genres', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const counts = new Map<string, number>();
    for (const r of deps.db.prepare("SELECT genres FROM tracks WHERE genres != ''").all() as { genres: string }[]) {
      for (const g of r.genres.split(', ')) counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    const genres = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count, family: familyOf(name) }));
    const eras = (
      deps.db
        .prepare(
          `SELECT DISTINCT (year/10)*10 AS decade FROM tracks WHERE year >= 1900 ORDER BY decade`,
        )
        .all() as { decade: number }[]
    ).map((r) => r.decade);
    const analyzed = (
      deps.db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE energy >= 0').get() as { n: number }
    ).n;
    const total = (deps.db.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n;
    /*
     * Song characteristics, for the recipe builder's chips.
     *
     * `analysed` gates the whole section: with nothing classified there are no bands to put a
     * track in, so offering the chips would be offering a control that silently does nothing.
     * `prominent` marks the ten dimensions the taxonomy weights highest for similarity — the
     * builder shows those first and hides the other forty-five behind a disclosure, because
     * fifty-five chips is a wall, not a choice.
     */
    const charAnalysed = (
      deps.db.prepare('SELECT COUNT(DISTINCT track_id) AS n FROM track_characteristics').get() as {
        n: number;
      }
    ).n;
    return {
      genres,
      families: (Object.entries(FAMILY_LABEL) as [Family, string][]).map(([id, label]) => ({ id, label })),
      eras,
      energyReady: total > 0 && analyzed / total > 0.5,
      characteristics: CHARACTERISTICS.filter((ch) => ch.enabled).map((ch) => ({
        key: ch.key,
        name: ch.name,
        group: ch.group,
        groupLabel: GROUP_LABEL[ch.group],
        prominent: ch.similarityWeight === 1,
      })),
      /** How many of this library's tracks have a profile — the builder says so out loud. */
      charAnalysed,
      charTotal: total,
      charsReady: charAnalysed >= 3,
    };
  });

  /**
   * The most-listened ARTISTS for a tag — the artist twin of /api/toptracks, feeding
   * Discover's "Top artists by genre/year" shelves. Held flags from the local index.
   */
  app.get('/api/topartists', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!lastfm.enabled) {
      return reply.code(503).send({ error: 'no Last.fm key configured' });
    }
    const tag = String((req.query as Record<string, string>).tag ?? '').trim().slice(0, 60);
    if (!tag) return reply.code(400).send({ error: 'tag is required' });

    const chart = await lastfm.tagTopArtists(tag, PAGE_MAX);
    const heldNames = new Set(deps.library.artists(500).map((a) => normalise(a.name)));
    return {
      tag,
      artists: chart.map((a) => ({
        name: a.name,
        listeners: a.listeners,
        images: artistImages(a.name),
        held: heldNames.has(normalise(a.name)),
      })),
    };
  });

  /**
   * The most-listened tracks for a tag — a genre ("nu metal"), a decade ("90s")
   * or a year ("1997") — resolved against the pool and the caller's library.
   *
   * Each row says which of three states it is in, and that is the entire
   * feature: mine plays instantly, on-disk adds instantly, and the rest is
   * worth downloading. The Last.fm chart is cached for a day; the pool match is
   * a local index lookup per row.
   */
  app.get('/api/toptracks', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!lastfm.enabled) {
      return reply.code(503).send({ error: 'no Last.fm key configured' });
    }
    const tag = String((req.query as Record<string, string>).tag ?? '').trim().slice(0, 60);
    if (!tag) return reply.code(400).send({ error: 'tag is required' });

    const chart = await lastfm.tagTopTracks(tag, PAGE_MAX);
    /*
     * TRACKS THE CALLER ALREADY OWNS ARE DROPPED, NOT FLAGGED.
     *
     * A shelf headed "what the world plays" exists to name music you have not got. Flagging an
     * owned track "in your library" spent a slot telling somebody something they knew, and on a
     * genre they collect it was most of the row — 41 of the top 100 nu metal tracks, measured
     * against the real library. The recommender shelves above have always worked this way
     * (recommend.ts rejects owned track ids), so this makes the chart shelves agree with them
     * instead of being the one corner of Discover that shows you your own records.
     *
     * `onDisk` deliberately survives: a track sitting in the shared pool that THIS caller has
     * not added is still a discovery, and a one-click one.
     *
     * Filtered per caller rather than at fetch, because the Last.fm chart is cached for a day
     * and shared by every user — two people own different things.
     */
    const tracks = [];
    for (const t of chart) {
      const pool = deps.userlib.poolMatch(t.artistName, t.title);
      if (pool && c.id !== null && deps.userlib.has(c.id, pool.trackId)) continue;
      tracks.push({
        title: t.title,
        artistName: t.artistName,
        albumTitle: pool?.albumTitle ?? '',
        trackId: pool?.trackId ?? null,
        durationS: pool?.durationS ?? null,
        onDisk: pool !== null,
      });
    }
    return { tag, tracks };
  });

  /**
   * The album a song lives on, by names alone.
   *
   * What a song tile's preview opens with: a chart entry or a recommendation is
   * an artist and a title with no ids, and the person deciding whether to
   * download deserves to see what the containing album actually is first.
   */
  app.get('/api/track/resolve', async (req, reply) => {
    if (!need(req, reply)) return;
    const q = req.query as Record<string, string>;
    const artist = String(q.artist ?? '').trim();
    const title = String(q.title ?? '').trim();
    if (!artist || !title) return reply.code(400).send({ error: 'artist and title are required' });

    const found = await deps.mb.albumForTrack(artist, title);
    if (!found) {
      return reply.code(404).send({ error: `no album found containing “${title}” by ${artist}` });
    }
    return found;
  });

  app.post('/api/similar', async (req, reply) => {
    if (!need(req, reply)) return;
    if (!lastfm.enabled) {
      return reply.code(503).send({ error: 'no Last.fm key configured; similarity is unavailable' });
    }

    const body = (req.body ?? {}) as {
      artists?: unknown;
      tracks?: unknown;
      limit?: unknown;
      excludeLibrary?: unknown;
    };
    const artists = Array.isArray(body.artists) ? body.artists.map(String).slice(0, 25) : [];
    const tracks = Array.isArray(body.tracks)
      ? (body.tracks as { artist?: unknown; title?: unknown }[])
          .slice(0, 25)
          .map((t) => ({ artist: String(t.artist ?? ''), title: String(t.title ?? '') }))
          .filter((t) => t.artist && t.title)
      : [];

    if (!artists.length && !tracks.length) {
      return reply.code(400).send({ error: 'give at least one of artists[] or tracks[]' });
    }

    // Seeds are always excluded from their own results; the library only when
    // asked, because a caller mapping taste may legitimately want everything.
    const exclude = new Set<string>();
    for (const a of artists) exclude.add(normalise(a));
    for (const t of tracks) exclude.add(normalise(t.artist));
    if (body.excludeLibrary !== false) {
      for (const a of deps.library.artists(500)) exclude.add(normalise(a.name));
    }

    const limit = Math.min(Math.max(Number(body.limit ?? 40) || 40, 1), 100);
    const picks = await suggestFromInput(lastfm, { artists, tracks }, exclude, limit);
    return { seeds: { artists, tracks: tracks.length }, count: picks.length, results: picks };
  });

  // ---- writes ------------------------------------------------------------

  /**
   * Request something.
   *
   * Auto-approved by design, which puts the whole burden of restraint on the two
   * caps below. An artist request is the dangerous shape — a discography is
   * dozens of albums and tens of gigabytes from one click — so it is sized from
   * MusicBrainz first and refused outright when it exceeds the per-request cap.
   */
  app.post('/api/request', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;

    const body = (req.body ?? {}) as {
      kind?: unknown;
      mbid?: unknown;
      askedFor?: unknown;
      backCatalogue?: unknown;
      /** For kind='track': which song on the album was asked for. */
      title?: unknown;
      /** For kind='track' with no mbid: whose song it is, so the album can be resolved. */
      artist?: unknown;
      /** For kind='track': a playlist the track should join when it arrives. */
      playlistId?: unknown;
    };
    const kind = String(body.kind ?? '');
    let mbid = String(body.mbid ?? '').trim();
    const askedFor = String(body.askedFor ?? '').slice(0, 200);

    if (kind !== 'artist' && kind !== 'album' && kind !== 'track') {
      return reply.code(400).send({ error: "kind must be 'artist', 'album' or 'track'" });
    }
    if (!/^[0-9a-f-]{36}$/i.test(mbid)) {
      // A track may be requested by names alone — a chart entry is an artist
      // and a title with no ids — so the containing album is resolved here,
      // through the same lookup and cache every other metadata read uses.
      const artist = String(body.artist ?? '').trim();
      const wantedTitle = String(body.title ?? '').trim();
      if (kind === 'track' && artist && wantedTitle) {
        const found = await deps.mb.albumForTrack(artist, wantedTitle);
        if (!found) {
          return reply.code(404).send({
            error: `no album found containing “${wantedTitle}” by ${artist}`,
          });
        }
        mbid = found.albumMbid;
      } else {
        return reply.code(400).send({ error: 'mbid must be a MusicBrainz UUID' });
      }
    }

    const since = Math.floor(Date.now() / 1000) - 86400;
    const already = store.albumsQueuedSince(c.user, since);

    try {
      // A track request downloads the album it lives on — Usenet has no other shape —
      // and adds only the requested song to the requester's library. The rest of the
      // album stays in the pool, where the next person who wants one gets it instantly.
      if (kind === 'track') {
        const wanted = String(body.title ?? '').trim();
        if (!wanted) return reply.code(400).send({ error: 'title is required for a track request' });
        const cap = deps.settings.all().dailyAlbumCap;
        if (cap > 0 && already + 1 > cap) {
          return reply.code(429).send({
            error: `daily cap reached: ${already}/${cap} albums in the last 24h`,
          });
        }
        const id = store.addRequest({
          kind: 'track',
          mbid,
          title: askedFor || wanted,
          artistName: '',
          askedFor,
          requestedBy: c.user,
          albumCount: 1,
          lidarrId: null,
          wantedTitle: wanted,
          requesterId: c.id,
          // Verified as theirs before it is stored, so a request cannot be aimed at
          // somebody else's playlist.
          wantedPlaylist:
            c.id && body.playlistId
              ? (deps.userlib.playlist(c.id, Number(body.playlistId))?.id ?? null)
              : null,
        });
        store.noteSeed(askedFor.split(' — ')[0] ?? '', 'request');
        deps.notifier.emit('request.created', {
          title: 'New crate request',
          message: `${c.user} requested the track "${wanted}"`,
          data: { requestId: id, mbid, wanted, requestedBy: c.user, kind: 'track' },
        });

        void deps.pipeline
          .start({
            ...emptyRow,
            id,
            mbid,
            title: askedFor || wanted,
            wanted_title: wanted,
            requester_id: c.id,
            wanted_playlist:
              c.id && body.playlistId
                ? (deps.userlib.playlist(c.id, Number(body.playlistId))?.id ?? null)
                : null,
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            app.log.error({ err: msg, requestId: id, mbid }, 'pipeline start failed');
            store.settleRequest(id, 'failed', msg);
          });

        return { ok: true, requestId: id, queuedAlbums: 1, wanted };
      }

      if (kind === 'album') {
        // Already pooled? Then "get this album" means "put it in my library",
        // which is instant and free — not a second download of files that are
        // already here. The daily cap deliberately does not apply: it exists
        // to protect a metered Usenet account, and this touches nothing.
        if (c.id) {
          const meta = await deps.mb.albumInfo(mbid);
          const pooled = meta ? deps.userlib.poolForAlbum(meta.artistName, meta.title) : [];
          if (pooled.length > 0) {
            for (const t of pooled) deps.userlib.add(c.id, t.trackId, 'add');
            deps.recommender.invalidate(c.id);
            const id = store.addRequest({
              kind: 'album',
              mbid,
              title: askedFor || meta?.title || mbid,
              artistName: meta?.artistName ?? '',
              askedFor,
              requestedBy: c.user,
              albumCount: 0,
              requesterId: c.id,
            });
            store.settleRequest(id, 'fulfilled');
            return { ok: true, requestId: id, queuedAlbums: 0, added: pooled.length, instant: true };
          }
        }

        const cap = deps.settings.all().dailyAlbumCap;
        if (cap > 0 && already + 1 > cap) {
          return reply.code(429).send({
            error: `daily cap reached: ${already}/${cap} albums in the last 24h`,
          });
        }
        // crate searches Prowlarr, grabs through SABnzbd and imports the result.
        const id = store.addRequest({
          kind: 'album',
          mbid,
          title: askedFor || mbid,
          artistName: '',
          askedFor,
          requestedBy: c.user,
          albumCount: 1,
          lidarrId: null,
          requesterId: c.id,
        });
        store.noteSeed(askedFor.split(' — ')[0] ?? '', 'request');
        deps.notifier.emit('request.created', {
          title: 'New crate request',
          message: `${c.user} requested ${askedFor || mbid}`,
          data: { requestId: id, mbid, askedFor, requestedBy: c.user, kind: 'album' },
        });

        // Searching indexers takes seconds, so the reply does not wait for it.
        // A failure lands on the request row where the requester can see it,
        // rather than being reported to a click that has already returned.
        void deps.pipeline.start({ ...emptyRow, id, mbid, title: askedFor || mbid, requester_id: c.id }).catch(
          (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            app.log.error({ err: msg, requestId: id, mbid }, 'pipeline start failed');
            store.settleRequest(id, 'failed', msg);
          },
        );

        return { ok: true, requestId: id, queuedAlbums: 1 };
      }

      // Artist. An artist request IS the back catalogue now — there is no
      // "follow future releases" without Lidarr's monitoring, so the request is
      // sized from MusicBrainz, capped, and queued as individual album requests
      // through the same pipeline as everything else.
      const studio = await deps.mb.studioAlbums(mbid);

      if (studio.length === 0) {
        // Unknown size. Refuse rather than guess: an unbounded discography is
        // the one thing the cap exists for.
        return reply.code(503).send({
          error:
            'could not size that discography (MusicBrainz unreachable, or no studio albums) — ' +
            'request individual albums instead',
        });
      }

      const info = await deps.mb.artistInfo(mbid);
      const artistName = info?.name || askedFor || mbid;

      // Albums already pooled cost nothing and download nothing — they join the
      // requester's library right now instead of being silently skipped, so
      // "Get all N" always means all N end up in the library one way or the other.
      const wanted: typeof studio = [];
      let instantTracks = 0;
      for (const a of studio) {
        if (!deps.library.held(a.mbid, artistName, a.title)) {
          wanted.push(a);
          continue;
        }
        if (c.id) {
          for (const t of deps.userlib.poolForAlbum(artistName, a.title)) {
            deps.userlib.add(c.id, t.trackId, 'add');
            instantTracks++;
          }
        }
      }
      if (instantTracks > 0 && c.id) deps.recommender.invalidate(c.id);
      if (wanted.length === 0) {
        return {
          ok: true,
          requestId: null,
          queuedAlbums: 0,
          added: instantTracks,
          note: 'everything was already here — it is in your library now',
        };
      }
      const limits = deps.settings.all();
      if (limits.maxAlbumsPerRequest > 0 && wanted.length > limits.maxAlbumsPerRequest) {
        return reply.code(409).send({
          error:
            `that artist has ${wanted.length} albums to fetch, over the ${limits.maxAlbumsPerRequest} ` +
            'allowed in one request — pick individual albums instead',
          albumCount: wanted.length,
          maxAlbumsPerRequest: limits.maxAlbumsPerRequest,
        });
      }
      if (limits.dailyAlbumCap > 0 && already + wanted.length > limits.dailyAlbumCap) {
        return reply.code(429).send({
          error:
            `that would queue ${wanted.length} albums and you are at ${already}/` +
            `${limits.dailyAlbumCap} for the last 24h`,
        });
      }

      let firstId: number | null = null;
      for (const a of wanted) {
        const title = `${artistName} — ${a.title}`;
        const id = store.addRequest({
          kind: 'album',
          mbid: a.mbid,
          title,
          artistName,
          askedFor: askedFor || artistName,
          requestedBy: c.user,
          albumCount: 1,
          lidarrId: null,
          requesterId: c.id,
        });
        firstId ??= id;
        void deps.pipeline.start({ ...emptyRow, id, mbid: a.mbid, title, requester_id: c.id }).catch(
          (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            app.log.error({ err: msg, requestId: id, mbid: a.mbid }, 'pipeline start failed');
            store.settleRequest(id, 'failed', msg);
          },
        );
      }
      store.noteSeed(artistName, 'request');
      deps.notifier.emit('request.created', {
        title: 'New crate request',
        message: `${c.user} requested ${wanted.length} album${wanted.length === 1 ? '' : 's'} by ${artistName}`,
        data: { mbid, artistName, requestedBy: c.user, kind: 'artist', albums: wanted.length },
      });

      return { ok: true, requestId: firstId, queuedAlbums: wanted.length, added: instantTracks };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Recorded as failed rather than dropped: the history is the audit trail
      // for the cap, and a silent failure looks identical to never having asked.
      store.addRequest({
        kind: kind === 'artist' ? 'artist' : 'album',
        mbid,
        title: askedFor || mbid,
        artistName: '',
        askedFor,
        requestedBy: c.user,
        albumCount: 0,
      });
      app.log.error({ err: msg, mbid, kind }, 'request failed');
      return reply.code(502).send({ error: `that request failed: ${msg.slice(0, 300)}` });
    }
  });

  /**
   * Try a failed request again.
   *
   * The row is reset — status, error, SAB job, attempt, candidate list — and
   * sent back through the pipeline, so the search runs fresh rather than
   * working down a stale candidate list. That matters because the usual reason
   * to retry is that the metadata was wrong and has since been fixed: the old
   * search was looking for the wrong album.
   *
   * Import items that rode on this request are re-opened too, so they get
   * re-matched instead of staying failed while their album downloads.
   */
  app.post('/api/requests/:id/retry', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const id = Number((req.params as { id: string }).id);
    const row = store.requestById(id);
    if (!row) return reply.code(404).send({ error: 'no such request' });

    /**
     * Cancel whatever is downloading before starting over.
     *
     * Retry used to refuse an in-flight request, which made "this torrent will
     * take all night, get it from Usenet instead" impossible — and resetting
     * the row without telling the client would have been worse, orphaning a
     * download that keeps running with nothing watching it. A part-finished
     * attempt is worth nothing, so a torrent goes with its data; a successful
     * one is left seeding elsewhere, by release().
     */
    if (row.nzo_id) {
      if (row.download_via === 'torrent') await deps.qbit.discard(row.nzo_id).catch(() => {});
      else await deps.sab.forget(row.nzo_id).catch(() => {});
    }

    store.resetRequest(id);
    deps.musicimport.reopenForRequest(id);

    /**
     * Re-resolve which album a track request should fetch.
     *
     * Without this a retry re-searches indexers for the SAME album id, which
     * is useless in the one case that most needs a retry: the metadata was
     * wrong. Massive Attack's Teardrop had been resolved to an unrelated split
     * release, so every retry hunted for that and found nothing, exactly as
     * before. Now the request is repointed first, and picks up whatever the
     * resolver knows today.
     */
    let target = row;
    if (row.kind === 'track' && row.wanted_title) {
      // "Massive Attack — Teardrop" is how the request was labelled; the part
      // before the dash is the artist, which is not stored separately for a
      // track request.
      const artist =
        row.artist_name || (row.asked_for || row.title).split(/\s+[—–-]\s+/)[0]?.trim() || '';
      if (artist) {
        const found = await deps.mb.albumForTrack(artist, row.wanted_title).catch(() => null);
        if (found && found.albumMbid !== row.mbid) {
          const title = `${artist} — ${found.albumTitle}`;
          store.repointRequest(id, found.albumMbid, title);
          target = { ...row, mbid: found.albumMbid, title };
          app.log.info(
            { requestId: id, from: row.mbid, to: found.albumMbid, album: found.albumTitle },
            'retry repointed to a re-resolved album',
          );
        }
      }
    }

    void deps.pipeline.start({ ...target, status: 'queued', error: null }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error({ err: msg, requestId: id }, 'retry failed');
      store.settleRequest(id, 'failed', msg);
    });
    return { ok: true };
  });

  /**
   * Every release an indexer has for a request's album, judged but not filtered.
   *
   * The interactive search: crate's own ranking is shown, and so is everything
   * it rejected and why it lost, because the operator can see things crate
   * cannot — a comment thread saying an upload is broken, or five thousand
   * grabs vouching for one that crate scored low.
   *
   * With ?q=… the words are the operator's instead of crate's. That exists
   * because crate decides for itself which album a requested SONG lives on, and
   * when that decision is wrong it goes looking for a record nobody has:
   * "The Real Slim Shady" resolved to a DJ's promo snippet tape, and Glycerine
   * to no album at all. The resolver has been fixed for both, but ambiguous
   * metadata is not a solvable class of problem — a film cue, a regional
   * edition, a song that only ever appeared on a promo — and the person looking
   * at the failure knows the right words when the machine does not.
   *
   * The typed text becomes the ALBUM half of the target, which is what makes it
   * work: the scorer's name gate then checks candidate titles against the words
   * that were typed. Scoring against the request's own album instead — the first
   * version of this — rejected all fifteen real Sixteen Stone releases, since
   * the album being corrected is precisely the one they do not match.
   */
  app.get('/api/requests/:id/releases', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const id = Number((req.params as { id: string }).id);
    const row = store.requestById(id);
    if (!row) return reply.code(404).send({ error: 'no such request' });

    const typed = String((req.query as { q?: unknown } | undefined)?.q ?? '').trim().slice(0, 200);
    let artist: string;
    let album: string;
    let year = '';
    let found;
    if (typed.length >= 2) {
      // No MusicBrainz lookup at all: the operator is here because the metadata
      // was the problem, so asking it again would only re-derive the bad answer.
      artist = '';
      album = typed;
      found = await deps.prowlarr.searchQuery(typed);
    } else {
      const meta = await deps.mb.albumInfo(row.mbid).catch(() => null);
      artist = meta?.artistName || row.artist_name || (row.asked_for || row.title).split(/\s+[—–-]\s+/)[0] || '';
      album = meta?.title || row.title;
      if (!artist || !album) return reply.code(409).send({ error: 'that request has no album to search for' });
      year = (meta?.releaseDate ?? '').slice(0, 4);
      found = await deps.prowlarr.search(artist, album);
    }

    const cfg = deps.settings.all();
    /*
     * Scored once per protocol, because score() collapses them.
     *
     * preferProtocol is a FALLBACK ORDER inside score() (release.ts:242-257):
     * whenever the preferred protocol has anything viable at all, every
     * candidate on the other protocol is dropped from the result. That is right
     * for the pipeline — torrents are the backup — and wrong for a list a person
     * reads, where it marked a 402MB FLAC with twelve seeders "filtered out"
     * behind two 50MB Usenet posts. Being second in line is not a verdict on the
     * release, and displaying it as one is a lie about why it lost.
     *
     * Asking each protocol separately gives every candidate its real score and
     * reasons; the fallback cannot fire, because each call sees one protocol.
     */
    const ranked = (['usenet', 'torrent'] as const).flatMap((proto) =>
      score(
        found.filter((f) => (f.protocol === 'torrent') === (proto === 'torrent')),
        { artist, album, trackCount: 0, year },
        { ...cfg, preferProtocol: proto },
      ),
    );
    const byUrl = new Map(ranked.map((r) => [r.downloadUrl, r]));

    return {
      artist,
      album,
      /** Echoed so the box keeps what was typed, and blank when crate chose. */
      query: typed.length >= 2 ? typed : '',
      releases: found
        .map((f) => {
          const judged = byUrl.get(f.downloadUrl);
          return {
            title: f.title,
            sizeMb: Math.round(f.size / 1024 / 1024),
            protocol: f.protocol,
            seeders: f.seeders,
            grabs: f.grabs,
            files: f.files,
            ageDays: Math.round(f.ageDays),
            indexer: f.indexer,
            infoUrl: f.infoUrl,
            downloadUrl: f.downloadUrl,
            /** Null when crate filtered it out — the reasons say what it liked. */
            score: judged ? judged.score : null,
            reasons: judged ? judged.reasons : [],
          };
        })
        // Crate's pick first, then whatever the crowd likes most.
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.grabs - a.grabs),
    };
  });

  /**
   * Download one specific release, chosen by a person.
   *
   * Whatever is in flight is cancelled first, and the choice bypasses scoring
   * entirely — the point of choosing is that the operator knows something the
   * scorer does not.
   */
  app.post('/api/requests/:id/grab', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const id = Number((req.params as { id: string }).id);
    const row = store.requestById(id);
    if (!row) return reply.code(404).send({ error: 'no such request' });

    const b = (req.body ?? {}) as { downloadUrl?: unknown; title?: unknown; protocol?: unknown };
    const url = String(b.downloadUrl ?? '').trim();
    const title = String(b.title ?? '').trim() || 'chosen release';
    const protocol = String(b.protocol ?? 'usenet') === 'torrent' ? 'torrent' : 'usenet';
    if (!/^(https?:|magnet:)/i.test(url)) {
      return reply.code(400).send({ error: 'downloadUrl must be an http(s) or magnet link' });
    }

    if (row.nzo_id) {
      if (row.download_via === 'torrent') await deps.qbit.discard(row.nzo_id).catch(() => {});
      else await deps.sab.forget(row.nzo_id).catch(() => {});
    }
    store.resetRequest(id);
    deps.musicimport.reopenForRequest(id);

    try {
      const jobId =
        protocol === 'torrent' ? await deps.qbit.add(url, title) : await deps.sab.add(url, title);
      store.setDownload(id, { nzoId: jobId, attempt: 0, note: `chosen: ${title}`, via: protocol });
      app.log.info({ requestId: id, protocol, title }, 'grabbed a release chosen by hand');
      return { ok: true, via: protocol };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.settleRequest(id, 'failed', msg);
      return reply.code(502).send({ error: msg });
    }
  });

  app.post('/api/dismiss', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const name = String(((req.body ?? {}) as { name?: unknown }).name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name is required' });
    store.dismiss(name, c.user);
    return { ok: true };
  });

  // ---- tracks, per-user libraries and do-not-recommend --------------------

  /**
   * Search for songs.
   *
   * Three states a track can be in, and the difference is the whole feature:
   *   mine    — already in this person's library
   *   onDisk  — somebody else already downloaded it, so adding is instant and free
   *   neither — has to be fetched, which means downloading the album it lives on
   *
   * The pool is searched first because an instant answer beats a download, then
   * MusicBrainz fills in tracks nobody has yet for albums the metadata knows about.
   */
  /**
   * A thirty-second preview of a song, from Apple.
   *
   * Deliberately on demand rather than resolved with the tracklist: a request
   * per row would put twenty Apple calls behind every album somebody expands,
   * for previews almost none of which get played. It answers 200 with a null
   * url when Apple has nothing, because "no preview exists" is a real answer
   * the button needs in order to disable itself, not an error.
   */
  app.get('/api/preview', async (req, reply) => {
    if (!need(req, reply)) return;
    const q = req.query as Record<string, string>;
    const artist = String(q.artist ?? '').trim();
    const title = String(q.title ?? '').trim();
    if (!artist || !title) return reply.code(400).send({ error: 'artist and title are required' });
    return { preview: await deps.itunes.preview(artist, title) };
  });

  app.get('/api/tracks/search', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const q = String((req.query as Record<string, string>).q ?? '').trim();
    if (q.length < 2) return { tracks: [] };

    const pool = deps.userlib.searchPool(q, 60);
    const mineIds = c.id ? deps.userlib.minesOf(c.id, pool.map((t) => t.trackId)) : new Set<number>();

    // Their own library first, then the rest of the pool, then anything that would need
    // downloading. Somebody searching for a song they already have should not have to scroll
    // past twelve things they would have to wait for.
    pool.sort((a, b) => Number(mineIds.has(b.trackId)) - Number(mineIds.has(a.trackId)));

    const tracks = pool.map((t) => ({
      trackId: t.trackId,
      title: t.title,
      artistName: t.artistName,
      albumTitle: t.albumTitle,
      trackNo: t.trackNo,
      durationS: t.durationS,
      onDisk: true,
      mine: mineIds.has(t.trackId),
      /** No album mbid needed: it is already here. */
      albumMbid: null as string | null,
    }));

    // Then anything the pool does not have. Last.fm ranks song search by how
    // many people actually listen — MusicBrainz scores every exact title match
    // 100, which buried Coldplay's The Scientist under a dozen bootlegs and
    // tribute albums. These rows carry no album id; the request path resolves
    // the containing album by name when someone actually asks for one.
    try {
      const found = lastfm.enabled
        ? (await lastfm.trackSearch(q, 12)).map((r) => ({
            title: r.title,
            artistName: r.artistName,
            albumTitle: '',
            albumMbid: null as string | null,
            lengthMs: null as number | null,
          }))
        : await deps.mb.searchRecordings(q, 12);
      const seen = new Set(tracks.map((t) => `${normalise(t.artistName)}|${normalise(t.title)}`));
      for (const r of found) {
        const k = `${normalise(r.artistName)}|${normalise(r.title)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        tracks.push({
          trackId: 0,
          title: r.title,
          artistName: r.artistName,
          albumTitle: r.albumTitle,
          trackNo: null,
          durationS: r.lengthMs ? Math.round(r.lengthMs / 1000) : null,
          onDisk: false,
          mine: false,
          albumMbid: r.albumMbid,
        });
      }
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err), q },
        'track search metadata lookup failed; returning pool results only',
      );
    }

    return { tracks };
  });

  /**
   * Set or clear the separate streaming password.
   *
   * Only needed for clients that use Subsonic token authentication. Clients that send the
   * password itself work with the normal crate password and need none of this — see the
   * header of routes/subsonic.ts for why the two cannot be the same credential.
   */
  app.post('/api/streampassword', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no account' });
    const pw = String((req.body as { password?: string } | undefined)?.password ?? '');
    if (pw && pw.length < 8) {
      return reply.code(400).send({ error: 'use at least 8 characters' });
    }
    store.setStreamPassword(c.id, pw);
    return { ok: true, set: Boolean(pw) };
  });

  /**
   * Everything an album page needs, in one call.
   *
   * Keyed on names rather than an id because that is how the pool is keyed and how a tile on
   * the front page knows the album — there is no numeric album anywhere in this system.
   */
  app.get('/api/album', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const q = req.query as Record<string, string>;
    const artist = String(q.artist ?? '').trim();
    const album = String(q.album ?? '').trim();
    if (!artist || !album) return reply.code(400).send({ error: 'artist and album are required' });

    const onDisk = deps.userlib.poolForAlbum(artist, album);
    const mineIds = c.id
      ? deps.userlib.minesOf(c.id, onDisk.map((t) => t.trackId))
      : new Set<number>();
    const plays = c.id ? deps.userlib.playsOf(c.id, onDisk.map((t) => t.trackId)) : new Map();

    // Similar artists, kept small — this is a sidebar on an album page, not a discovery feed.
    let similar: { name: string; because: string }[] = [];
    if (lastfm.enabled) {
      try {
        const hits = await lastfm.similarArtists(artist, 12);
        const owned = new Set(
          (c.id ? deps.userlib.seedArtists(c.id, 500) : []).map((a) => normalise(a.name)),
        );
        similar = hits
          .filter((h) => !owned.has(normalise(h.name)))
          .slice(0, 8)
          .map((h) => ({ name: h.name, because: `like ${artist}` }));
      } catch {
        similar = [];
      }
    }

    /*
     * MusicBrainz first, tags as the fallback.
     *
     * The tag year is the year the RIP was made for anything that is not a new release, so
     * it dated Nebraska to 2023 and Sweet Baby James to 2023. MusicBrainz knows when the
     * album actually came out. The lookup is cached immortally and runs on the idle lane, so
     * this costs one mirror query the first time an album page is opened and nothing after;
     * when MusicBrainz has no match, or is down, the tag year still shows.
     */
    const tagYear = deps.userlib.albumYear(artist, album);
    const mbYear = await deps.mb.albumYear(artist, album).catch(() => null);

    return {
      artist,
      album,
      year: mbYear ?? tagYear,
      /** Set only when the two disagree, so the UI can say which pressing is on disk. */
      tagYear: mbYear !== null && tagYear !== null && tagYear !== mbYear ? tagYear : null,
      tracks: onDisk.map((t) => ({
        ...t,
        mine: mineIds.has(t.trackId),
        onDisk: true,
        addedAt: null,
        plays: plays.get(t.trackId) ?? 0,
      })),
      otherAlbums: c.id
        ? deps.userlib.albumsByArtist(c.id, artist).filter((a) => normalise(a.albumTitle) !== normalise(album))
        : [],
      similar,
    };
  });

  /**
   * A place for the browser to report a crash.
   *
   * Exists because a client-side render throw is invisible from the server: the page goes blank,
   * a reload fixes it, and the only evidence was in a console nobody was looking at. With this,
   * "it crashed" becomes a stack trace in the same log as everything else.
   *
   * Deliberately unauthenticated-tolerant and rate-limited by Traefik like the rest of /api —
   * a crash report is worth having even from a session that has just broken.
   */
  app.post('/api/client-error', async (req, reply) => {
    const b = (req.body ?? {}) as {
      message?: unknown;
      stack?: unknown;
      componentStack?: unknown;
      url?: unknown;
    };
    const c = caller(req);
    app.log.error(
      {
        who: c?.user ?? 'anonymous',
        url: String(b.url ?? '').slice(0, 300),
        // Truncated: a stack is useful, a novel is not, and this is an unvalidated body.
        stack: String(b.stack ?? '').slice(0, 2000),
        componentStack: String(b.componentStack ?? '').slice(0, 2000),
      },
      `client error: ${String(b.message ?? 'unknown').slice(0, 300)}`,
    );
    return reply.code(204).send();
  });

  /** This person's library. */
  app.get('/api/mytracks', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return { tracks: [], counts: { tracks: 0, artists: 0, albums: 0 } };
    return { tracks: deps.userlib.mine(c.id), counts: deps.userlib.counts(c.id) };
  });

  /** Add a track already on disk. No download, no wait. */
  app.post('/api/mytracks', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no library' });
    const trackId = Number((req.body as { trackId?: number } | undefined)?.trackId);
    const t = deps.userlib.byId(trackId);
    if (!t) return reply.code(404).send({ error: 'no such track on disk' });
    deps.userlib.add(c.id, t.trackId, 'add');
    // The taste profile just changed, so the cached recommendation set is wrong. Without this
    // the six-hour TTL means the front page keeps showing what it computed before the change —
    // which is why a deleted album kept reappearing.
    deps.recommender.invalidate(c.id);
    return { ok: true, added: { trackId: t.trackId, title: t.title } };
  });

  /**
   * Remove a track from this person's library.
   *
   * Does NOT delete the file. Somebody else may hold it, and even if nobody does, keeping
   * it is what makes the next request for it instant. Admin purges what nobody has.
   */
  app.delete('/api/mytracks/:trackId', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no library' });
    const trackId = Number((req.params as { trackId: string }).trackId);
    deps.userlib.remove(c.id, trackId);
    deps.recommender.invalidate(c.id);
    return {
      ok: true,
      note: 'removed from your library; the file is kept on disk and will not be recommended back',
    };
  });

  /**
   * Take in a parsed library export.
   *
   * The client parses the CSV — it has the file, and a browser is perfectly
   * good at CSV — and posts rows. Playlists appear immediately; songs settle
   * over the following minutes as the processor works through them, watched
   * via the status endpoint below.
   */
  app.post('/api/import', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no library' });
    const body = (req.body ?? {}) as { rows?: unknown };
    if (!Array.isArray(body.rows) || body.rows.length === 0) {
      return reply.code(400).send({ error: 'rows[] is required' });
    }
    if (body.rows.length > 10_000) {
      return reply.code(400).send({ error: 'that is over the 10,000-row limit — split the file' });
    }
    const rows: ImportRow[] = (body.rows as Record<string, unknown>[]).map((r) => ({
      title: String(r.title ?? '').slice(0, 300),
      artist: String(r.artist ?? '').slice(0, 300),
      album: String(r.album ?? '').slice(0, 300),
      playlist: String(r.playlist ?? '').slice(0, 100),
      isrc: String(r.isrc ?? '').slice(0, 20),
    }));
    return deps.musicimport.addBatch(c.id, c.user, rows);
  });

  /** Put this batch's failures back through the matcher — after a fix, or a blip. */
  /**
   * `group` narrows which failures are retried. 'downloads' takes the ones that
   * were found and then broke — aborted transfers, missing repair blocks, bad
   * archives — which are the likeliest to succeed now that there is a second
   * source to fall back on. Omitted means everything.
   */
  app.post('/api/import/retry', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no library' });
    const group = String(((req.body ?? {}) as { group?: unknown }).group ?? '');
    const reasons =
      group === 'downloads'
        ? ['aborted', 'repair blocks', 'rar files failed', 'import kept failing', 'disappeared']
        : undefined;
    return { ok: true, retried: deps.musicimport.retryFailed(c.id, { reasons }) };
  });

  app.get('/api/import/status', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return { batchId: null, counts: {}, items: [] };
    const batch = String((req.query as Record<string, string>).batch ?? '') || undefined;
    return deps.musicimport.status(c.id, batch);
  });

  /** This person's own import runs, newest first. */
  app.get('/api/import/history', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return { runs: [] };
    return { runs: deps.musicimport.history(c.id) };
  });

  /** What this person has asked not to be recommended. */
  app.get('/api/excludes', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return { excludes: [], removedArtists: [] };
    return {
      excludes: deps.userlib.excludes(c.id),
      // Artists whose tracks this person removed. A removal quietly stops the
      // artist being recommended back — by design — and the client needs to
      // know so it can offer the way back out.
      removedArtists: deps.userlib.removedArtistNames(c.id),
    };
  });

  /**
   * Let an artist be recommended again.
   *
   * Undoes both suppressions at once: the explicit "don't recommend" exclusion
   * AND the implicit one created by removing their tracks from the library.
   * They are one idea to the listener — "stop suggesting this" — so coming
   * back is also one action, not a scavenger hunt across two mechanisms.
   */
  app.post('/api/recommendable', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no preferences' });
    const artist = String(((req.body ?? {}) as { artist?: unknown }).artist ?? '').trim();
    if (!artist) return reply.code(400).send({ error: 'an artist is required' });

    deps.userlib.unexclude(c.id, 'artist', UserLibrary.excludeKey('artist', artist));
    const cleared = deps.userlib.unremoveByArtist(c.id, artist);
    deps.recommender.invalidate(c.id);
    return { ok: true, cleared };
  });

  /**
   * Do not recommend an artist, album or track.
   *
   * Deliberately not deletion. Somebody can keep one song that is nothing like the rest
   * of their taste and stop it steering every later suggestion.
   */
  app.post('/api/excludes', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no preferences' });
    const b = (req.body ?? {}) as { kind?: string; artist?: string; album?: string; title?: string };
    const kind = b.kind === 'artist' || b.kind === 'album' || b.kind === 'track' ? b.kind : null;
    const artist = String(b.artist ?? '').trim();
    if (!kind) return reply.code(400).send({ error: "kind must be artist, album or track" });
    if (!artist) return reply.code(400).send({ error: 'an artist is required' });

    const second = kind === 'album' ? String(b.album ?? '') : String(b.title ?? '');
    if (kind !== 'artist' && !second) {
      return reply.code(400).send({ error: `an ${kind} name is required` });
    }
    const key = UserLibrary.excludeKey(kind, artist, second);
    const label = kind === 'artist' ? artist : `${artist} — ${second}`;
    deps.userlib.exclude(c.id, kind, key, label);
    deps.recommender.invalidate(c.id);
    return { ok: true, excludes: deps.userlib.excludes(c.id) };
  });

  app.delete('/api/excludes', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no preferences' });
    const qy = req.query as Record<string, string>;
    const kind = qy.kind === 'artist' || qy.kind === 'album' || qy.kind === 'track' ? qy.kind : null;
    if (!kind || !qy.key) return reply.code(400).send({ error: 'kind and key are required' });
    deps.userlib.unexclude(c.id, kind, String(qy.key));
    deps.recommender.invalidate(c.id);
    return { ok: true, excludes: deps.userlib.excludes(c.id) };
  });

  // ---- user management (admin only) --------------------------------------

  /** Admin guard, layered on need() so the 401 and 403 cases stay distinct. */
  function needAdmin(
    req: FastifyRequest,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ): Caller | null {
    const c = need(req, reply);
    if (!c) return null;
    if (!c.isAdmin) {
      reply.code(403).send({ error: 'admin only' });
      return null;
    }
    return c;
  }

  // Statistics, settings and the connection tests. Split into its own module
  // because it is a different audience and a different risk profile: these routes
  // write the credentials the pipeline runs on.
  // Playback, play counts and playlists. Same session check, different concern.
  playRoutes(app, {
    userlib: deps.userlib,
    algo: deps.algo,
    recommender: deps.recommender,
    lyrics: deps.lyrics,
    playlistart: deps.playlistart,
    openai: deps.openai,
    songchars: deps.songchars,
    need: (req, reply) => need(req, reply),
  });

  /*
   * The DJ (Intelligent Shuffle) — a native feature since it graduated from the plugin of the
   * same name. Registered HERE in the main scope, deliberately outside the PluginState-gated
   * plugin loop below: a live database may still carry a plugin_state row for
   * 'intelligent-shuffle' from its plugin days, and a leftover "disabled" there must not 404
   * a core feature. Its characteristics window is the same narrow read-only shape the plugin
   * contract exposes, built from the same services.
   */
  const dj = new Dj(
    deps.db,
    {
      enabled: () => deps.songchars.enabled(),
      vectorOf: (trackId) => deps.similarity.vectorOf(trackId),
      scoreAgainst: (profile) => deps.similarity.scoreAgainst(profile),
    },
    deps.userlib,
    deps.settings,
    app.log,
  );
  djRoutes(app, { dj, need: (req, reply) => need(req, reply) });

  /*
   * Plugin routes, registered here rather than in main.ts because `need` is a closure over
   * `caller()` above and IS the thing a plugin cannot import. Each plugin sees the same guard
   * every core route uses, so a plugin route is exactly as authenticated as anything else.
   * Fastify throws on a duplicate path at boot — the collision guard.
   */
  const pluginCtx: PluginContext = {
    db: deps.db,
    userlib: deps.userlib,
    log: app.log,
    need: (req, reply) => need(req, reply),
    events: deps.notifier,
    http: { getText, getJson, getBytes },
    /*
     * A narrow, read-only window onto Song characteristics. Deliberately not the services
     * themselves: a plugin may ask how close things are, and may not write scores or reach the
     * tables. The distance maths lives once, in lib/similarity.ts, and every consumer shares it.
     */
    characteristics: {
      enabled: () => deps.songchars.enabled(),
      keys: () => activeCharacteristicKeys(),
      vectorOf: (trackId) => deps.similarity.vectorOf(trackId),
      scoreAgainst: (profile) => deps.similarity.scoreAgainst(profile),
      compareToProfile: (trackId, profile) => deps.similarity.compareToProfile(trackId, profile),
    },
  };
  for (const plugin of deps.plugins) {
    if (!plugin.routes) continue;
    /*
     * Each plugin's routes live in their own encapsulated Fastify scope so ONE hook can gate
     * them all: disabled means every route the plugin registered answers 404, immediately,
     * with no restart — Fastify cannot unregister a route, but a scope-wide onRequest check
     * is the same thing from the caller's side. 404 rather than 403 because a switched-off
     * feature should look absent, exactly as it would if the registry line were removed.
     */
    void app.register(async (scope) => {
      scope.addHook('onRequest', async (req, reply) => {
        if (!pluginState.isEnabled(plugin.id)) {
          return reply.code(404).send({ error: 'this feature is disabled' });
        }
      });
      plugin.routes!(scope, pluginCtx);
    });
  }

  /*
   * The plugin switchboard. Admin-only, and OUTSIDE the gated scopes — the switch that turns
   * a plugin back on cannot live behind the switch.
   *
   * Two sources of truth, deliberately distinct: deps.plugins is what THIS PROCESS loaded at
   * boot; repo.installed() is what is on disk NOW. They disagree exactly when an install or
   * uninstall has happened since boot, and that disagreement IS the "restart needed" signal.
   */
  const repo = new PluginRepo(deps.db, deps.pluginDir, app.log);

  const switchboard = async () => {
    const onDisk = await repo.installed();
    const loaded = new Set(deps.plugins.map((p) => p.id));
    const installed = [
      // Compiled into this build: not uninstallable, only switchable.
      ...deps.plugins
        .filter((p) => PLUGINS_BUILTIN.has(p.id))
        .map((p) => ({
          id: p.id,
          name: p.id,
          version: null as string | null,
          description: '',
          source: 'builtin' as const,
          enabled: pluginState.isEnabled(p.id),
          loaded: true,
          needsRestart: false,
        })),
      ...onDisk.map((m) => ({
        id: m.id,
        name: m.name,
        version: m.version as string | null,
        description: m.description,
        source: 'installed' as const,
        enabled: pluginState.isEnabled(m.id),
        loaded: loaded.has(m.id),
        // On disk but not in the process: installed since boot, waiting for a restart.
        needsRestart: Boolean(m.server) && !loaded.has(m.id),
      })),
      // In the process but no longer on disk: uninstalled since boot, routes still live.
      ...deps.plugins
        .filter((p) => !PLUGINS_BUILTIN.has(p.id) && !onDisk.some((m) => m.id === p.id))
        .map((p) => ({
          id: p.id,
          name: p.id,
          version: null as string | null,
          description: '',
          source: 'removed' as const,
          enabled: pluginState.isEnabled(p.id),
          loaded: true,
          needsRestart: true,
        })),
    ];
    return {
      installed,
      repo: { repo: repo.repo(), token: repo.tokenState() },
      needsRestart: installed.some((p) => p.needsRestart),
    };
  };

  app.get('/api/admin/plugins', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    return switchboard();
  });

  /** The repo's catalog, with what-is-installed folded in so the page can say Update. */
  app.get('/api/admin/plugins/available', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    try {
      const [catalog, onDisk] = await Promise.all([repo.available(), repo.installed()]);
      return {
        available: catalog.map((c) => {
          const inst = onDisk.find((m) => m.id === c.id);
          return {
            ...c,
            installed: Boolean(inst) || deps.plugins.some((p) => p.id === c.id),
            installedVersion: inst?.version ?? null,
            builtin: PLUGINS_BUILTIN.has(c.id),
          };
        }),
      };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.put('/api/admin/plugins/source', async (req, reply) => {
    const c = needAdmin(req, reply);
    if (!c) return;
    const b = (req.body ?? {}) as { repo?: unknown; token?: unknown };
    try {
      repo.setSource(
        String(b.repo ?? ''),
        // undefined keeps the stored token; an empty string clears it deliberately.
        b.token === undefined ? undefined : String(b.token),
      );
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    app.log.info({ by: c.user }, 'plugin repository configured');
    return { ok: true, repo: repo.repo(), token: repo.tokenState() };
  });

  app.post('/api/admin/plugins/install', async (req, reply) => {
    const c = needAdmin(req, reply);
    if (!c) return;
    const id = String((req.body as { id?: unknown } | undefined)?.id ?? '');
    if (PLUGINS_BUILTIN.has(id)) {
      return reply.code(400).send({ error: 'that plugin is compiled into this build' });
    }
    if (RETIRED_PLUGIN_IDS.has(id)) {
      return reply.code(400).send({ error: 'that feature is part of crate now — nothing to install' });
    }
    try {
      const manifest = await repo.install(id);
      app.log.info({ plugin: id, version: manifest.version, by: c.user }, 'plugin installed');
      // A server half only activates at the next boot; a pure-UI plugin is live on reload.
      return { ok: true, id, version: manifest.version, needsRestart: Boolean(manifest.server) };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.delete('/api/admin/plugins/installed/:id', async (req, reply) => {
    const c = needAdmin(req, reply);
    if (!c) return;
    const id = String((req.params as { id: string }).id);
    if (PLUGINS_BUILTIN.has(id)) {
      return reply.code(400).send({ error: 'that plugin is compiled into this build' });
    }
    await repo.uninstall(id);
    app.log.info({ plugin: id, by: c.user }, 'plugin uninstalled');
    // Its data stays in its tables; its routes stay until the restart.
    return { ok: true, needsRestart: deps.plugins.some((p) => p.id === id) };
  });

  /**
   * Restart crate. Under compose (restart: unless-stopped) an orderly exit IS a restart —
   * which is what makes install-from-the-admin-page a complete story instead of "now go and
   * run docker commands".
   */
  app.post('/api/admin/restart', async (req, reply) => {
    const c = needAdmin(req, reply);
    if (!c) return;
    app.log.warn({ by: c.user }, 'restart requested from the admin page');
    setTimeout(() => process.exit(0), 400);
    return { ok: true };
  });

  app.put('/api/admin/plugins/:id', async (req, reply) => {
    const c = needAdmin(req, reply);
    if (!c) return;
    const id = String((req.params as { id: string }).id);
    const known =
      deps.plugins.some((p) => p.id === id) || (await repo.installed()).some((m) => m.id === id);
    if (!known) return reply.code(404).send({ error: 'no such plugin' });
    const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled must be true or false' });
    }
    pluginState.setEnabled(id, enabled);
    app.log.info({ plugin: id, enabled, by: c.user }, 'plugin toggled');
    return switchboard();
  });

  /**
   * The client bundles the SPA should load: installed, LOADED (their routes exist in this
   * process — a bundle whose API is not up yet would be a half-alive feature), and enabled.
   * The version rides in the URL as the cache-buster.
   */
  app.get('/api/plugins/ui', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const loaded = new Set(deps.plugins.map((p) => p.id));
    const out = [];
    for (const m of await repo.installed()) {
      if (!m.client || !loaded.has(m.id) || !pluginState.isEnabled(m.id)) continue;
      out.push({
        id: m.id,
        version: m.version,
        client: `/plugins/${m.id}/${m.client}?v=${encodeURIComponent(m.version)}`,
        css: m.css ? `/plugins/${m.id}/${m.css}?v=${encodeURIComponent(m.version)}` : null,
      });
    }
    return { plugins: out };
  });

  /**
   * Installed plugins' client assets. Session-gated like the API (import() and <link> send
   * cookies same-origin), and only names that survive the same character test the installer
   * enforces — no dots-and-slashes tourism.
   */
  app.get('/plugins/:id/:file', async (req, reply) => {
    if (!need(req, reply)) return;
    const { id, file } = req.params as { id: string; file: string };
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id) || !/^[A-Za-z0-9._-]+$/.test(file) || file.includes('..')) {
      return reply.code(404).send({ error: 'no such asset' });
    }
    try {
      const body = await readFile(join(deps.pluginDir, id, file), 'utf-8');
      const type = file.endsWith('.css') ? 'text/css' : 'text/javascript';
      // The version query is the cache key; the asset itself may be cached hard.
      return reply.header('Content-Type', `${type}; charset=utf-8`).header('Cache-Control', 'private, max-age=31536000, immutable').send(body);
    } catch {
      return reply.code(404).send({ error: 'no such asset' });
    }
  });

  // ---- algorithm profiles ---------------------------------------------------

  /** Everything the My Algorithm page shows, in one call. */
  app.get('/api/algo', async (req, reply) => {
    const c = need(req, reply);
    if (!c || !c.id) return reply.code(400).send({ error: 'sign in to continue' });
    const profiles = deps.algo.profiles(c.id);
    const active = profiles.find((p) => p.active)!;
    return {
      profiles,
      entries: deps.algo.entries(active.id),
      genres: deps.algo.knownGenres().slice(0, 200),
      coverage: deps.algo.genreCoverage(),
    };
  });

  app.post('/api/algo/profiles', async (req, reply) => {
    const c = need(req, reply);
    if (!c || !c.id) return reply.code(400).send({ error: 'sign in to continue' });
    const name = String((req.body as { name?: string } | undefined)?.name ?? '').trim().slice(0, 40);
    if (!name) return reply.code(400).send({ error: 'a name is required' });
    if (name.toLowerCase() === 'default') return reply.code(400).send({ error: 'Default already exists' });
    const id = deps.algo.createProfile(c.id, name);
    deps.algo.activate(c.id, id);
    deps.recommender.invalidate(c.id);
    return { ok: true, id };
  });

  app.post('/api/algo/profiles/:id/activate', async (req, reply) => {
    const c = need(req, reply);
    if (!c || !c.id) return reply.code(400).send({ error: 'sign in to continue' });
    if (!deps.algo.activate(c.id, Number((req.params as { id: string }).id))) {
      return reply.code(404).send({ error: 'no such profile' });
    }
    // A mood switch changes what discovery should offer, immediately.
    deps.recommender.invalidate(c.id);
    return { ok: true };
  });

  app.delete('/api/algo/profiles/:id', async (req, reply) => {
    const c = need(req, reply);
    if (!c || !c.id) return reply.code(400).send({ error: 'sign in to continue' });
    if (!deps.algo.deleteProfile(c.id, Number((req.params as { id: string }).id))) {
      return reply.code(400).send({ error: 'Default cannot be deleted' });
    }
    deps.recommender.invalidate(c.id);
    return { ok: true };
  });

  app.post('/api/algo/warmth', async (req, reply) => {
    const c = need(req, reply);
    if (!c || !c.id) return reply.code(400).send({ error: 'sign in to continue' });
    const b = (req.body ?? {}) as { kind?: string; label?: string; warmth?: number };
    const kind = String(b.kind ?? '') as WarmthKind;
    if (!['genre', 'artist', 'album', 'track'].includes(kind)) {
      return reply.code(400).send({ error: 'kind must be genre, artist, album or track' });
    }
    const label = String(b.label ?? '').trim().slice(0, 200);
    const warmth = Math.max(0, Math.min(5, Math.round(Number(b.warmth))));
    if (!label || Number.isNaN(warmth)) return reply.code(400).send({ error: 'label and warmth 0–5 required' });
    deps.algo.setWarmth(deps.algo.activeProfile(c.id), kind, label, warmth);
    deps.recommender.invalidate(c.id);
    return { ok: true };
  });

  app.delete('/api/algo/warmth', async (req, reply) => {
    const c = need(req, reply);
    if (!c || !c.id) return reply.code(400).send({ error: 'sign in to continue' });
    const q = req.query as Record<string, string>;
    deps.algo.removeWarmth(deps.algo.activeProfile(c.id), String(q.kind ?? '') as WarmthKind, String(q.key ?? ''));
    deps.recommender.invalidate(c.id);
    return { ok: true };
  });

  /** Materialise genres for library artists — capped per call, so it reports progress. */
  app.post('/api/algo/genres/fill', async (req, reply) => {
    const c = need(req, reply);
    if (!c || !c.id) return reply.code(400).send({ error: 'sign in to continue' });
    const r = await deps.algo.fillGenres(deps.mb, 50);
    return { ok: true, ...r };
  });

  uploadRoutes(app, {
    uploads: deps.uploads,
    acoustid: deps.acoustid,
    openai: deps.openai,
    library: deps.library,
    userlib: deps.userlib,
    recommender: deps.recommender,
    notifier: deps.notifier,
    need: (req, reply) => need(req, reply),
  });

  adminRoutes(app, {
    store,
    library: deps.library,
    settings: deps.settings,
    prowlarr: deps.prowlarr,
    sab: deps.sab,
    qbit: deps.qbit,
    notifier: deps.notifier,
    userlib: deps.userlib,
    recommender: deps.recommender,
    artcache: deps.artcache,
    warmer: deps.warmer,
    musicRoot: deps.musicRoot,
    trashRoot: deps.trashRoot,
    uploads: deps.uploads,
    acoustid: deps.acoustid,
    openai: deps.openai,
    adoptRoot: deps.adoptRoot,
    need: (req, reply) => need(req, reply),
    needAdmin,
  });

  /** Everyone's import runs — the admin's view of who brought what across. */
  app.get('/api/admin/imports', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    return { runs: deps.musicimport.history() };
  });

  app.get('/api/users', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    return {
      users: store.users().map((u) => ({
        ...publicUser(u),
        enabled: Boolean(u.enabled),
        lastLoginAt: u.last_login_at,
      })),
    };
  });

  app.post('/api/users', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const username = String(b.username ?? '').trim().toLowerCase();
    const password = String(b.password ?? '');

    if (!/^[a-z0-9._-]{2,32}$/.test(username)) {
      return reply
        .code(400)
        .send({ error: 'username must be 2-32 chars of a-z, 0-9, dot, underscore or hyphen' });
    }
    // Ten characters, matching the estate's MIN_PASSWORD_LENGTH so there is one
    // number rather than a different floor per app.
    if (password.length < 10) {
      return reply.code(400).send({ error: 'password must be at least 10 characters' });
    }
    if (store.userByName(username)) {
      return reply.code(409).send({ error: 'that username already exists' });
    }

    const id = await store.addUser({
      username,
      password,
      displayName: String(b.displayName ?? '') || username,
      isAdmin: b.isAdmin === true,
    });
    deps.notifier.emit('user.created', {
      title: 'New crate user',
      message: `${username}${b.isAdmin === true ? ' (admin)' : ''} was added`,
      data: { userId: id, username, isAdmin: b.isAdmin === true },
    });
    return { ok: true, id };
  });

  app.post('/api/users/:id/password', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const id = Number((req.params as { id: string }).id);
    const target = store.userById(id);
    if (!target) return reply.code(404).send({ error: 'no such user' });

    // A user may change their own password; only an admin may change anyone else's.
    if (!c.isAdmin && target.username !== c.user) {
      return reply.code(403).send({ error: 'you can only change your own password' });
    }

    const b = (req.body ?? {}) as Record<string, unknown>;
    const password = String(b.password ?? '');
    if (password.length < 10) {
      return reply.code(400).send({ error: 'password must be at least 10 characters' });
    }
    await store.setPassword(id, password);
    // Every session for that user is now gone, including possibly this one, which
    // is the point: a password change must actually end access.
    return { ok: true, signedOut: true };
  });

  app.post('/api/users/:id/enabled', async (req, reply) => {
    const c = needAdmin(req, reply);
    if (!c) return;
    const id = Number((req.params as { id: string }).id);
    const target = store.userById(id);
    if (!target) return reply.code(404).send({ error: 'no such user' });

    const enabled = ((req.body ?? {}) as { enabled?: unknown }).enabled === true;
    // Refuse to disable the last enabled admin, which would lock everyone out of
    // user management with no way back in short of editing the database.
    if (!enabled && target.is_admin) {
      const admins = store.users().filter((u) => u.is_admin && u.enabled && u.id !== id);
      if (admins.length === 0) {
        return reply.code(409).send({ error: 'that is the last enabled admin' });
      }
    }
    store.setUserEnabled(id, enabled);
    return { ok: true };
  });
}
