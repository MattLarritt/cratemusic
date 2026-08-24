import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';
import { mkdirSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCompress from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { open, sweep } from './db/schema.js';
import { LastFm } from './lib/lastfm.js';
import { Library } from './lib/library.js';
import { ArtSource } from './lib/artsource.js';
import { Pipeline } from './lib/pipeline.js';
import { Prowlarr } from './lib/prowlarr.js';
import { Sab } from './lib/sab.js';
import { Qbit } from './lib/qbit.js';
import { Lyrics } from './lib/lyrics.js';
import { ITunes } from './lib/itunes.js';
import { Uploads } from './lib/upload.js';
import { AcoustId } from './lib/acoustid.js';
import { OpenAi } from './lib/openai.js';
import { CHARACTERISTICS } from './lib/characteristics.js';
import { Similarity } from './lib/similarity.js';
import { SongCharacteristics } from './lib/songcharacteristics.js';
import { Analyzer } from './lib/analysis.js';
import { parseFile } from 'music-metadata';
import { Algo } from './lib/algo.js';
import { Notifier } from './lib/notify.js';
import { Settings } from './lib/settings.js';
import { ArtCache } from './lib/artcache.js';
import { PlaylistArt } from './lib/playlistart.js';
import { Recommender } from './lib/recommend.js';
import { UserLibrary } from './lib/userlib.js';
import { subsonicRoutes } from './routes/subsonic.js';
import { MusicImport } from './lib/musicimport.js';
import { MusicBrainz } from './lib/musicbrainz.js';
import { Store } from './lib/store.js';
import { PLUGINS } from './plugins/index.js';
import { RETIRED_PLUGIN_IDS, loadDynamicPlugins } from './lib/plugin.js';
import { PageWarmer } from './lib/warm.js';
import { refreshSeedsFromLibrary } from './lib/taste.js';
import { apiRoutes } from './routes/api.js';
import { artRoutes } from './routes/art.js';
import { authRoutes, makeIsAuthed } from './routes/auth.js';

/**
 * An optional env var, treating empty as absent.
 *
 * `process.env.X ?? null` is not enough: compose passes an unset value through
 * as an empty string, so `??` yields '' and every "is this configured" check
 * downstream reports true. That produced a container reporting lastfm enabled
 * while its own startup line said disabled, and would have sent Last.fm calls
 * with a blank key instead of falling back to the cold-start page.
 */
function optional(name: string): string | null {
  const v = (process.env[name] ?? '').trim();
  return v === '' ? null : v;
}

const DB_PATH = process.env.CRATE_DB ?? '/data/crate.db';
const PORT = Number(process.env.CRATE_PORT ?? 8080);

// Optional. Without it the app still searches and requests; only the discovery
// rows lose their content, and /api/home falls back to the library listing.
const LASTFM_KEY = optional('CRATE_LASTFM_KEY');

// Bearer token for callers with no browser session, so POST /api/similar is
// usable from a script. Absent means that path is closed entirely.
const API_KEY = optional('CRATE_API_KEY');

// Request caps live in settings now (0 = unlimited); env values seed a fresh
// database and stay the fallback, like the rest of the pipeline config.
const MAX_ALBUMS_PER_REQUEST = Number(process.env.CRATE_MAX_ALBUMS_PER_REQUEST ?? 0);
const DAILY_ALBUM_CAP = Number(process.env.CRATE_DAILY_ALBUM_CAP ?? 0);
// One seed is enough to personalise. The threshold was 3 on the assumption that
// a couple of artists could not say much, which the data disproved: two seeds
// (System of a Down, Radiohead) produced A Perfect Circle, Serj Tankian and
// Deftones, while the cold-start fallback offered Ariana Grande and Drake.
// Falling back to a global chart is worse than a narrow but relevant guess.
const MIN_SEEDS = Number(process.env.CRATE_MIN_SEEDS ?? 1);

// MusicBrainz requires a descriptive User-Agent and blocks generic ones, so
// this is not cosmetic. A contact URL is what their policy asks for.
const MB_UA =
  process.env.CRATE_MB_USER_AGENT ?? 'crate/0.1 ( https://github.com/MattLarritt/cratemusic )';

// The pipeline: crate searches Prowlarr, hands the NZB to SABnzbd, and imports
// the result itself. There is no other download path.
const PROWLARR_URL = optional('CRATE_PROWLARR_URL') ?? '';
// qBittorrent's WebUI. Empty means torrents stay off and crate behaves exactly
// as it did before them.
const QBIT_URL = optional('CRATE_QBIT_URL') ?? '';
const QBIT_USER = optional('CRATE_QBIT_USER') ?? '';
const QBIT_PASSWORD = optional('CRATE_QBIT_PASSWORD') ?? '';
const PROWLARR_KEY = optional('CRATE_PROWLARR_KEY') ?? '';
const SAB_URL = optional('CRATE_SAB_URL') ?? '';
const SAB_KEY = optional('CRATE_SAB_KEY') ?? '';
const SAB_CATEGORY = process.env.CRATE_SAB_CATEGORY ?? 'music';
// Where the library lives, as this container sees it. The importer refuses to run
// if this turns out to be the same tree as a download folder.
const MUSIC_ROOT = process.env.CRATE_MUSIC_ROOT ?? '/music';
// Deletions move here rather than being unlinked. Outside the music root so the
// library scanner never re-indexes them, and on the same filesystem so the move
// is atomic rather than a copy of hundreds of megabytes.
const TRASH_ROOT = process.env.CRATE_TRASH_ROOT ?? '/downloads/.crate-trash';
// Upload staging on the NAS, beside the trash — an album of FLAC is hundreds
// of megabytes and the container disk is the smallest one on the estate.
const UPLOAD_STAGING = process.env.CRATE_UPLOAD_STAGING ?? '/downloads/.crate-uploads';
// Where SAB finishes music-category jobs — the folder adoption watches. The
// torrent save path is deliberately NOT included: those files are seeding, and
// moving them out from under qBittorrent breaks the seed.
const ADOPT_ROOT = process.env.CRATE_ADOPT_ROOT ?? '/downloads/usenet/music';
// Cached artwork. Lives beside the database so it survives a container recreate, and is
// regenerable, so losing it costs one refetch rather than any data.
const ART_DIR = process.env.CRATE_ART_DIR ?? dirname(DB_PATH) + '/art';
// Deliberately NOT inside ART_DIR: that directory is swept by last-used date, which would
// eventually delete a cover somebody uploaded by hand.
const PLAYLIST_ART_DIR = process.env.CRATE_PLAYLIST_ART_DIR ?? dirname(DB_PATH) + '/playlist-art';
// Installed plugins live beside the database — downloaded artifacts, so they survive a
// container recreate and are re-downloadable if lost.
const PLUGIN_DIR = process.env.CRATE_PLUGIN_DIR ?? dirname(DB_PATH) + '/plugins';
// Minutes a SABnzbd job may show no change before the pipeline gives up on it and
// tries the next release. Configurable mainly so the watchdog can be tested without
// waiting twenty minutes.
const STALL_MINUTES = Number(process.env.CRATE_STALL_MINUTES ?? 20);

const COOKIE_NAME = process.env.CRATE_COOKIE_NAME ?? 'crate_sid';
// Secure cookies are the only sane production setting. This exists so the app
// can be exercised over plain HTTP on a dev box.
const COOKIE_SECURE = process.env.CRATE_COOKIE_INSECURE !== '1';
if (!COOKIE_SECURE) console.warn('[crate] WARNING: session cookie is NOT Secure (dev mode)');

// First-run administrator. Only used when the users table is empty, so leaving
// these set after setup is harmless — but they are secrets, so they belong in
// .env either way.
const BOOTSTRAP_USER = optional('CRATE_BOOTSTRAP_USER');
const BOOTSTRAP_PASSWORD = optional('CRATE_BOOTSTRAP_PASSWORD');

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = open(DB_PATH);
const store = new Store(db);

const library = new Library(db);

/**
 * Settings, with the environment as defaults.
 *
 * Everything the admin page edits lives in SQLite; these env values seed a fresh
 * database and stay the fallback, so the compose file still describes a working
 * deployment and nothing has to be entered twice.
 */
const settings = new Settings(db, {
  sabUrl: SAB_URL,
  sabKey: SAB_KEY,
  sabCategory: SAB_CATEGORY,
  prowlarrUrl: PROWLARR_URL,
  prowlarrKey: PROWLARR_KEY,
  lastfmKey: LASTFM_KEY ?? '',
  minSeeds: MIN_SEEDS,
  stallMinutes: STALL_MINUTES,
  dailyAlbumCap: DAILY_ALBUM_CAP,
  maxAlbumsPerRequest: MAX_ALBUMS_PER_REQUEST,
  qbitUrl: QBIT_URL,
  qbitUser: QBIT_USER,
  qbitPassword: QBIT_PASSWORD,
});

// Constructed unconditionally now: they read their config per call, so "not
// configured yet" is a state they report rather than a reason not to exist. That is
// what lets an operator paste a key into the admin page and have it work.
const prowlarr = new Prowlarr(settings);
const sab = new Sab(settings);
// Torrents. Reads its config per call like the others, so an operator can paste
// the WebUI details into the admin page and have them take effect at once.
const qbit = new Qbit(settings);
const lastfm = new LastFm(store, settings);

const app = Fastify({ logger: { level: process.env.CRATE_LOG ?? 'info' }, trustProxy: true });

/*
 * Every plugin this process runs: the compiled-in registry plus whatever is installed under
 * PLUGIN_DIR (downloaded from the plugin repository via the admin portal — see
 * lib/pluginrepo.ts). Compiled-in wins an id collision, because code that tsc checked at
 * build time outranks code that was downloaded.
 *
 * Plugin schemas run after the core's (open() ran migrate() already), in registry order.
 * Same idempotence rules as the core — see lib/plugin.ts.
 */
const dynamicPlugins = (await loadDynamicPlugins(PLUGIN_DIR, app.log)).filter((d) => {
  /*
   * A retired id is a feature that graduated into core. Loading the leftover installed copy
   * would register its routes at the same paths the native feature now owns, and Fastify's
   * duplicate-route throw would take the whole boot down — so it is skipped here, before
   * migrate() or route registration ever see it. Skipped rather than deleted: boot never
   * removes files, cleaning the directory is a deploy step.
   */
  if (RETIRED_PLUGIN_IDS.has(d.id)) {
    app.log.warn(
      { plugin: d.id },
      'installed plugin is now a core feature — skipped; delete it from the plugins directory',
    );
    return false;
  }
  if (PLUGINS.some((p) => p.id === d.id)) {
    app.log.warn({ plugin: d.id }, 'installed plugin shadows a compiled-in one — skipped');
    return false;
  }
  return true;
});
const allPlugins = [...PLUGINS, ...dynamicPlugins];
for (const plugin of allPlugins) plugin.migrate?.(db);

const mb = new MusicBrainz(
  store,
  MB_UA,
  (m) => app.log.warn(m),
  () => settings.all().mbMirrorUrl,
);

// Outbound notifications. Constructed early because the pipeline and the routes both
// emit through it, and a missing destination is simply nothing to deliver to.
const notifier = new Notifier(db, app.log);
// Lyrics are fetched during a download and embedded as it is imported, replacing the
// nightly cron that left a freshly requested album wordless until the small hours.
const lyrics = new Lyrics(db, app.log);
const itunes = new ITunes(store, (m) => app.log.warn(m));
const uploads = new Uploads(UPLOAD_STAGING, MUSIC_ROOT, (m) => app.log.warn(m));
const acoustid = new AcoustId(settings, (m) => app.log.warn(m));
const openai = new OpenAi(settings, (m) => app.log.warn(m));

/*
 * Song characteristics, and the similarity engine over them.
 *
 * The classifier is injected rather than reached for, so the service has no idea OpenAI exists —
 * which is what lets the tests drive the whole state machine without a network, and what will
 * let a local model be dropped in later without touching the service. Similarity is constructed
 * first because the analysis service has to invalidate its vector cache on every write.
 */
const similarity = new Similarity(db);

/*
 * Page warming: fills the MusicBrainz and Last.fm caches an artist or album page needs, on the
 * idle lane, before anybody clicks. See lib/warm.ts for the measurements that motivated it.
 */
const warmer = new PageWarmer(
  db,
  mb,
  lastfm,
  () => settings.all().warmPages,
  { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) },
);
const songchars = new SongCharacteristics(
  db,
  settings,
  (inputs) => openai.classifyCharacteristics(inputs, CHARACTERISTICS),
  similarity,
  app.log,
);
// The taxonomy is code-owned; push it in on every boot so adding or reweighting a
// characteristic is a code change plus a restart, never a schema change.
songchars.syncTaxonomy();
// Per-user libraries over the shared pool of files on disk. See lib/userlib.ts for why
// the two are separate facts.
const userlib = new UserLibrary(db);

/**
 * The recommender. Seeded from what people actually play rather than what they added, and
 * cached per user because a mixed set of fifty is a dozen Last.fm calls.
 */
const algo = new Algo(db);
const recommender = new Recommender(store, userlib, algo, lastfm);

/**
 * Artwork, cached on disk. The remote half — Cover Art Archive for covers,
 * Deezer for artist photos — lives in lib/artsource.ts; the cache only ever
 * sees bytes.
 */
const artsource = new ArtSource(mb, store, (m) => app.log.warn(m));
const artcache = new ArtCache(db, ART_DIR, settings, app.log, {
  albumImage: (artist, album) => artsource.albumImage(artist, album),
  albumImageByMbid: (mbid) => artsource.albumImageByMbid(mbid),
  artistImage: (artist) => artsource.artistImage(artist),
});

const playlistart = new PlaylistArt(db, PLAYLIST_ART_DIR, artcache, (m) => app.log.warn(m));


const pipeline = new Pipeline({
  store,
  library,
  prowlarr,
  sab,
  qbit,
  mb,
  musicRoot: MUSIC_ROOT,
  log: app.log,
  settings,
  notifier,
  lyrics,
  userlib,
  recommender,
});

if (!(prowlarr.configured && sab.configured)) {
  // Not fatal, and deliberately so: the admin page exists precisely to fill these
  // in, and refusing to start would leave no way to do it.
  app.log.warn(
    'Prowlarr or SABnzbd is not configured — requests will fail until they are set ' +
      'on the admin page (Downloading)',
  );
}

authRoutes(app, { store, cookieName: COOKIE_NAME, cookieSecure: COOKIE_SECURE });
artRoutes(app, {
  mb,
  isAuthed: makeIsAuthed(store, COOKIE_NAME, API_KEY),
  artcache,
  // Embedded artwork comes from the album's own files, so the cache needs to know where
  // they are for anything crate actually holds.
  trackPaths: (artist, album) => userlib.poolForAlbum(artist, album).map((t) => t.path),
});

// Library imports (Apple Music exports and friends), processed in the background.
const musicimport = new MusicImport(db, store, userlib, mb, pipeline, recommender, app.log);
setInterval(() => void musicimport.tick().catch(() => undefined), 20 * 1000).unref();

apiRoutes(app, {
  db,
  plugins: allPlugins,
  pluginDir: PLUGIN_DIR,
  store,
  cookieName: COOKIE_NAME,
  lastfm,
  lyrics,
  itunes,
  uploads,
  acoustid,
  openai,
  songchars,
  similarity,
  algo,
  adoptRoot: ADOPT_ROOT,
  musicimport,
  mb,
  library,
  pipeline,
  settings,
  prowlarr,
  sab,
  qbit,
  notifier,
  userlib,
  recommender,
  artcache,
  playlistart,
  musicRoot: MUSIC_ROOT,
  trashRoot: TRASH_ROOT,
  apiKey: API_KEY,
  warmer,
});

/**
 * OpenSubsonic under /rest, filtered per user.
 *
 * This is what makes the per-user library real outside crate. A server that simply
 * exposes a folder shows everybody everything; every response here is filtered through
 * the caller's own tracks instead, so two people pointing a phone client at this host
 * get two different libraries.
 */
subsonicRoutes(app, { store, userlib, recommender, artcache, playlistart });

// The built client. Served from the same origin as the API, which is the whole
// reason there is one container and no CORS, no BFF proxy and no build-time API
// URL to bake in — the three things the two-container split next door keeps
// having to fix.
const HERE = dirname(fileURLToPath(import.meta.url));
await app.register(fastifyCookie);
/*
 * Compress text, and cache the client build properly.
 *
 * Both of these were costing far more than anything in the app. The bundle
 * went out at 338 KB uncompressed because nothing gzipped it, and every asset
 * carried max-age=0 — so a phone re-fetched a third of a megabyte, and
 * revalidated every file, on every single navigation. Measured against the
 * app itself answering in one to three milliseconds, the transfer WAS the
 * page load.
 *
 * Audio is untouched: streamTrack writes 206 range responses through
 * reply.raw, which never reaches an onSend hook, and audio types are not
 * compressible anyway.
 */
/*
 * Multipart exists for exactly one route, /api/upload, but registration is
 * global. Files STREAM to staging rather than buffering in memory; the
 * per-file byte cap is enforced by the staging code as bytes arrive, and this
 * fileSize is the backstop above it.
 */
await app.register(fastifyMultipart, {
  limits: { fileSize: 450 * 1024 * 1024, files: 45 },
});

await app.register(fastifyCompress, {
  global: true,
  // br first for browsers that take it; gzip covers everything else.
  encodings: ['br', 'gzip', 'deflate'],
  // Below about a packet there is nothing to win and a little CPU to lose.
  threshold: 1024,
});

await app.register(fastifyStatic, {
  root: join(HERE, 'public'),
  wildcard: false,
  // Stop `send` emitting its own max-age=0, which it writes after setHeaders
  // runs and which therefore wins. With it off, the header below is the only
  // one set and it survives.
  cacheControl: false,
  setHeaders(res, path) {
    /*
     * Vite fingerprints everything under /assets/ with a content hash, so a
     * given URL's bytes can never change — which is exactly what immutable
     * promises. index.html must NOT be cached: it is the file that names the
     * current hashes, and caching it would pin a browser to the previous
     * deploy indefinitely.
     */
    const hashed = path.includes(`${sep}assets${sep}`);
    // Logos and icons are NOT fingerprinted, so they cannot be immutable — but
    // revalidating a 27 KB wordmark on every navigation is the cost this whole
    // header exists to avoid. A day is long enough to stop that and short
    // enough that replacing a logo does not need a hard refresh to be seen.
    const branding = /\.(png|svg|ico|webmanifest)$/.test(path);
    res.setHeader(
      'cache-control',
      hashed ? 'public, max-age=31536000, immutable'
      : branding ? 'public, max-age=86400'
      : 'no-cache',
    );
  },
});

/**
 * SPA fallback.
 *
 * Anything that is not an /api/ route and not a real file is the client's own
 * router's problem, so serve index.html and let it decide. /api/ is excluded
 * explicitly: a mistyped API path must 404 as JSON, not quietly return an HTML
 * page that the caller then fails to parse.
 */

/**
 * Paths that end in a file extension are assets, not routes.
 *
 * Without this a missing image answers 200 with the whole HTML page, which is
 * indistinguishable from a working one to anything checking status codes, and
 * renders as a broken image to a browser. It hid a stale favicon reference
 * during exactly this deploy — the check for dead links reported every one of
 * them alive. crate's own routes are word paths with no dots in the last
 * segment, so this cannot swallow a real one.
 */
const LOOKS_LIKE_A_FILE = /\.[a-z0-9]{2,5}$/i;

app.setNotFoundHandler((req, reply) => {
  const path = req.url.split('?')[0] ?? '';
  if (req.url.startsWith('/api/')) {
    return reply.code(404).send({ error: 'no such endpoint' });
  }
  if (LOOKS_LIKE_A_FILE.test(path)) {
    return reply.code(404).send({ error: 'not found' });
  }
  return reply.sendFile('index.html');
});

/**
 * One-time migration into the per-user model.
 *
 * Before this, "the library" was one shared thing: whatever was on disk, everyone saw.
 * Splitting it into per-user libraries over a shared pool would silently reinterpret that
 * as "nobody has anything" — every existing track would show up as unheld, My library
 * would be empty, and the admin purge page would cheerfully offer to delete the entire
 * collection. So the old semantics are preserved explicitly: every existing user starts
 * with everything that was already on disk.
 *
 * Guarded by a settings flag rather than by "is user_tracks empty", because a user who
 * genuinely empties their library must not have it refilled on the next restart.
 */
function backfillPoolOnce(): void {
  if (settings.all().poolBackfilled) return;

  const tracks = db.prepare('SELECT id FROM tracks').all() as { id: number }[];
  if (!tracks.length) return; // Nothing indexed yet; try again after the next scan.

  const users = store.users().filter((u) => u.enabled);
  const add = db.prepare(
    `INSERT INTO user_tracks (user_id, track_id, added_at, source)
     VALUES (?,?,unixepoch(),'add') ON CONFLICT DO NOTHING`,
  );
  const tx = db.transaction(() => {
    for (const u of users) for (const t of tracks) add.run(u.id, t.id);
  });
  tx();
  settings.set({ poolBackfilled: true });
  app.log.warn(
    { users: users.length, tracks: tracks.length },
    'migrated to per-user libraries: existing users start with everything already on disk',
  );
}

async function refreshSeeds(): Promise<void> {
  try {
    // Scan first, so seeds reflect what is on disk right now rather than what the
    // index believed at boot. Cheap: two directory levels and a file count.
    const before = library.artists(10_000).reduce((n, a) => n + a.trackFiles, 0);
    const { albums, tracks } = await library.scan(MUSIC_ROOT);
    app.log.info(`library scan: ${albums} albums, ${tracks} tracks under ${MUSIC_ROOT}`);
    // Only when something actually changed. A scan that finds the same library every
    // thirty minutes is not news, and a notification channel that cries wolf is one
    // people stop reading.
    if (tracks !== before) {
      notifier.emit('library.scanned', {
        title: 'crate library changed',
        message: `${albums} albums, ${tracks} tracks (was ${before} tracks)`,
        data: { albums, tracks, previousTracks: before },
      });
    }
    // After the scan, so the pool exists to copy from.
    backfillPoolOnce();
    const { artists } = refreshSeedsFromLibrary(library, store);
    app.log.info(`seeds refreshed: ${artists} artists with files, ${store.seedCount()} seeds total`);
  } catch (err) {
    app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'seed refresh failed');
  }
}

/**
 * Advance the native pipeline.
 *
 * Fifteen seconds because the point of owning the download is that a requester
 * sees a percentage move instead of a silent 'queued'. It is a local SABnzbd call
 * per in-flight request and nothing when there are none.
 */
async function pipelineTick(): Promise<void> {
  if (!pipeline) return;
  try {
    await pipeline.tick();
  } catch (err) {
    app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'pipeline tick failed');
  }
}

/**
 * Pick up requests that never got as far as a download.
 *
 * A restart between recording a request and handing it to SABnzbd would otherwise
 * leave it queued forever — the same silent-stall shape this rewrite exists to
 * remove, just with a different cause.
 */
async function resumeUnstarted(): Promise<void> {
  if (!pipeline) return;
  for (const req of store.unstartedRequests()) {
    try {
      app.log.warn({ requestId: req.id }, 'resuming a request that never reached SABnzbd');
      await pipeline.start(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error({ err: msg, requestId: req.id }, 'could not resume request');
      store.settleRequest(req.id, 'failed', msg);
    }
  }
}

setInterval(() => void pipelineTick(), 15 * 1000).unref();
setInterval(() => void refreshSeeds(), 30 * 60 * 1000).unref();
/**
 * Reclaim caches nobody is using.
 *
 * Both halves respect the same retention setting, and both refuse to touch anything that
 * belongs to music actually on disk — the point is to stop paying for images and metadata
 * for things browsed past once, not to make crate refetch what it already has.
 */
async function sweepCaches(): Promise<void> {
  try {
    sweep(db, settings.all().artRetentionDays);
    await artcache.sweep();
    await uploads.sweep();
    await playlistart.sweep();
  } catch (err) {
    app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'cache sweep failed');
  }
}

setInterval(() => void sweepCaches(), 6 * 60 * 60 * 1000).unref();

/**
 * Create the first administrator, once.
 *
 * Only fires when there are no users at all, so this cannot overwrite a password
 * somebody has since changed. Without it a fresh deployment has no way in short
 * of editing the database, and with it there is exactly one moment where a
 * credential from the environment matters.
 */
if (store.userCount() === 0) {
  if (BOOTSTRAP_USER && BOOTSTRAP_PASSWORD) {
    const id = await store.addUser({
      username: BOOTSTRAP_USER,
      password: BOOTSTRAP_PASSWORD,
      displayName: BOOTSTRAP_USER,
      isAdmin: true,
    });
    app.log.warn(
      `created first admin '${BOOTSTRAP_USER}' (id=${id}) from CRATE_BOOTSTRAP_*. ` +
        'Change the password after signing in.',
    );
  } else {
    app.log.error(
      'no users exist and CRATE_BOOTSTRAP_USER/CRATE_BOOTSTRAP_PASSWORD are unset — ' +
        'nobody can sign in. Set them in .env and restart.',
    );
  }
}

await app.listen({ host: '0.0.0.0', port: PORT });
app.log.info(
  `crate listening on :${PORT}, ` +
    `lastfm ${LASTFM_KEY ? 'enabled' : 'disabled'}, ` +
    `api key ${API_KEY ? 'set' : 'unset'}, ` +
    `users ${store.userCount()}`,
);

notifier.emit('system.started', {
  title: 'crate started',
  message: `Listening on :${PORT}. ${store.userCount()} user${store.userCount() === 1 ? '' : 's'}.`,
  data: { port: PORT, users: store.userCount() },
});

// First refresh after listen, so a slow scan delays suggestions rather than
// the port opening.
void refreshSeeds();
void resumeUnstarted();

/*
 * The audio analyzer, as a trickle: one track at a time, a breath between each, forever.
 *
 * Decoding costs ~1–2 seconds per file, so the initial backfill over a few thousand
 * tracks takes hours BY DESIGN — it shares the box with playback and must never be
 * noticeable. New tracks are picked up automatically because the loop simply asks for
 * the next unanalysed row. A file that fails gets bpm = -1 and is never retried.
 */
const analyzer = new Analyzer();
async function analyzeNext(): Promise<void> {
  // ENERGY is the "have we analysed this" marker, not bpm: bpm is legitimately null for
  // most files (only a tagged TBPM is trusted — see lib/analysis.ts), so keying on it
  // would re-analyse the whole library forever.
  const row = db
    .prepare('SELECT id, path, duration_s FROM tracks WHERE energy IS NULL LIMIT 1')
    .get() as { id: number; path: string; duration_s: number | null } | undefined;
  if (!row) return;
  try {
    const { common } = await parseFile(row.path).catch(() => ({ common: {} as { bpm?: number } }));
    const result = await analyzer.analyze(row.path, row.duration_s, common.bpm ?? null);
    db.prepare('UPDATE tracks SET bpm = ?, energy = ? WHERE id = ?').run(result.bpm, result.energy, row.id);
  } catch (err) {
    db.prepare('UPDATE tracks SET energy = -1 WHERE id = ?').run(row.id);
    app.log.warn(`analysis failed for ${row.path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
setInterval(() => void analyzeNext(), 5_000).unref();

/*
 * Song characteristics, on the same trickle principle as the analyzer above: one batch of ten
 * tracks per tick, forever.
 *
 * Eight seconds between batches is the rate limit — deliberately a wall-clock interval rather
 * than a token bucket, because one request every eight seconds is comfortably inside any
 * provider's allowance and needs no bookkeeping to prove it. At ten tracks a batch that is
 * ~4,500 tracks an hour. tick() returns immediately when the feature is off, so this timer costs
 * nothing at all in the default configuration.
 */
setInterval(() => {
  void songchars.tick().catch((err: unknown) => {
    // tick() is written not to throw; if it ever does, a timer is the worst place to find out.
    app.log.warn(
      `song characteristics tick failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}, 8_000).unref();

/*
 * Page warming, the slowest trickle of the three.
 *
 * Two seconds per item, and every lookup inside sits in MusicBrainz's idle lane, so the real
 * pace is set by their one-per-second courtesy limit and by yielding to anything a person is
 * waiting on. An artist costs up to four calls, an album one, so a 385-artist / 321-album
 * library fills in something under an hour of wall clock and is invisible while it does.
 *
 * Enrolled here rather than only on scan, so a library that predates this feature is picked up
 * on the first boot after the upgrade — which is the whole of Matt's library.
 */
warmer.enrol();
setInterval(() => {
  void warmer.tick().catch((err: unknown) => {
    app.log.warn(`page warm tick failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}, 2_000).unref();

/*
 * New music means new pages to warm. `library.scanned` fires after every scan, including the
 * one an import triggers, so this is the single hook that covers downloads, uploads and
 * adoptions alike — enrol() is idempotent, so re-enrolling the whole library each time costs
 * four grouped queries and changes nothing for rows already present.
 */
notifier.on('library.scanned', () => {
  const n = warmer.enrol();
  app.log.info(`page warm: ${n.artists} artists and ${n.albums} albums on the worklist`);
});
