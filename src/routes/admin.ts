/**
 * The admin API: statistics, settings and connection tests.
 *
 * Every route here is admin-only. That guard is not decoration — these endpoints
 * write the credentials the download pipeline runs on, and one of them reports the
 * free space on a NAS.
 *
 * Secrets are write-only over this API. A GET reports whether a key is set and its
 * last four characters; it never returns the value. Echoing a working credential
 * back to a page gains nothing and loses something, since the response is readable
 * by anything in the chain — a logging proxy, a browser extension, a screenshot.
 *
 * The test endpoints exist because "I pasted a key" and "the key works" are
 * different claims, and the difference used to be discovered hours later when a
 * request quietly failed.
 */

import { statfs } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Library } from '../lib/library.js';
import type { Prowlarr } from '../lib/prowlarr.js';
import type { Sab } from '../lib/sab.js';
import type { Qbit } from '../lib/qbit.js';
import type { Config, Settings } from '../lib/settings.js';
import type { Store } from '../lib/store.js';
import { getJson } from '../lib/http.js';
import { parseFile } from 'music-metadata';
import type { AcoustId } from '../lib/acoustid.js';
import type { StagedFile, Uploads } from '../lib/upload.js';
import type { OpenAi } from '../lib/openai.js';
import { mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { moveFile } from '../lib/importer.js';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { mirrorBase } from '../lib/musicbrainz.js';
import { EVENTS, EVENT_LABELS, type EventName, type Notifier } from '../lib/notify.js';
import { removeAlbum, removeTrack } from '../lib/remove.js';
import { isArchive, unpackDir, unpackerAvailable } from '../lib/unpack.js';
import type { ArtCache } from '../lib/artcache.js';
import type { PageWarmer } from '../lib/warm.js';
import type { Recommender } from '../lib/recommend.js';
import type { UserLibrary } from '../lib/userlib.js';

interface AdminDeps {
  store: Store;
  library: Library;
  settings: Settings;
  prowlarr: Prowlarr;
  sab: Sab;
  qbit: Qbit;
  notifier: Notifier;
  userlib: UserLibrary;
  recommender: Recommender;
  artcache: ArtCache;
  warmer: PageWarmer;
  musicRoot: string;
  /** Where deletions are moved to. Outside the music root, same filesystem. */
  trashRoot: string;
  uploads: Uploads;
  acoustid: AcoustId;
  openai: OpenAi;
  /** Where completed music downloads land — the place adoption looks. */
  adoptRoot: string;
  /** Caller identity, for owning the staging batch adoption creates. */
  need: (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => { id: number | null; user: string } | null;
  needAdmin: (
    req: FastifyRequest,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ) => unknown;
}

/** Fields the admin form may write, so a stray key in a request body cannot land. */
const WRITABLE: (keyof Config)[] = [
  'sabUrl',
  'sabKey',
  'sabCategory',
  'prowlarrUrl',
  'prowlarrKey',
  'formats',
  'requireLossless',
  'losslessMinMbPerTrack',
  'losslessMaxMbPerTrack',
  'lossyMinMbPerTrack',
  'lossyMaxMbPerTrack',
  'maxTotalMb',
  'disqualify',
  'maxAttempts',
  'stallMinutes',
  'dailyAlbumCap',
  'maxAlbumsPerRequest',
  'qbitUrl',
  'qbitUser',
  'qbitPassword',
  'qbitCategory',
  'qbitSavePath',
  'preferProtocol',
  'minSeeders',
  'lastfmKey',
  'mbMirrorUrl',
  'acoustidKey',
  'openaiKey',
  'minSeeds',
  'artRetentionDays',
  'songCharacteristics',
  'warmPages',
];

export function adminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { store, library, settings, prowlarr, sab, qbit, needAdmin, notifier, uploads, acoustid } = deps;

  /**
   * Everything the Statistics page shows.
   *
   * Disk usage comes from statfs on the music root rather than from summing file
   * sizes: the number an operator cares about is how much room is left before
   * downloads start failing, and that is a property of the filesystem.
   *
   * Playlists are counted from crate's own `playlists` table. This used to ask
   * Navidrome, from a time when crate genuinely had no playlist concept — long
   * since untrue, and the stale wiring meant the dashboard reported "no Navidrome"
   * instead of the playlists crate itself owns.
   */
  /**
   * Page warming: how ready the library's artist and album pages are — see lib/warm.ts.
   *
   * Admin rather than per-user because the caches it fills are server-wide: one warm artist
   * page is warm for everybody, so there is nothing per-user to report or to trigger.
   */
  app.get('/api/admin/warm', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    return deps.warmer.progress();
  });

  /**
   * The retroactive build. `all` re-warms everything including what already succeeded (for a
   * library whose caches have aged out); the default fills only the gaps, which is what
   * somebody clicking after adding music wants.
   */
  app.post('/api/admin/warm', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const all = Boolean((req.body as { all?: unknown } | undefined)?.all);
    const queued = all ? deps.warmer.sweepAll() : deps.warmer.sweepCold();
    app.log.info({ queued, all }, 'page warm sweep queued');
    return { ok: true, queued, ...deps.warmer.progress() };
  });

  app.get('/api/admin/stats', async (req, reply) => {
    if (!needAdmin(req, reply)) return;

    let disk: {
      totalBytes: number;
      freeBytes: number;
      usedBytes: number;
    } | null = null;
    try {
      const fs = await statfs(deps.musicRoot);
      const total = fs.blocks * fs.bsize;
      const free = fs.bavail * fs.bsize;
      disk = { totalBytes: total, freeBytes: free, usedBytes: total - free };
    } catch {
      // A share that is not mounted must not take the page down; it is reported as
      // unknown, which is also the most useful thing to see when it happens.
      disk = null;
    }

    const albums = library.artists(10_000);
    const users = store.users();

    const playlists = store.playlistCount();

    const reqs = store.requestCounts();

    return {
      disk,
      musicRoot: deps.musicRoot,
      tracks: albums.reduce((n, a) => n + a.trackFiles, 0),
      albums: albums.reduce((n, a) => n + a.albums, 0),
      artists: albums.length,
      users: { total: users.length, admins: users.filter((u) => u.is_admin).length,
               enabled: users.filter((u) => u.enabled).length },
      playlists,
      requests: reqs,
      artCache: await deps.artcache.stats(),
      artRetentionDays: settings.all().artRetentionDays,
      topArtists: albums.slice(0, 10),
    };
  });

  app.get('/api/admin/settings', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    return {
      settings: settings.redacted(),
      // So the page can say why a request would fail before anyone tries one.
      ready: { prowlarr: prowlarr.configured, sab: sab.configured },
    };
  });

  app.put('/api/admin/settings', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const patch: Partial<Record<keyof Config, string | number | boolean | string[]>> = {};
    for (const k of WRITABLE) {
      if (!(k in body)) continue;
      const v = body[k];
      if (k === 'formats' || k === 'disqualify') {
        patch[k] = Array.isArray(v)
          ? v.map(String)
          : String(v ?? '')
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean);
      } else if (k === 'requireLossless' || k === 'songCharacteristics') {
        patch[k] = v === true || v === 'true' || v === 1 || v === '1';
      } else if (typeof v === 'number' || /MbPerTrack|maxTotalMb|Attempts|Minutes|Seeds/.test(k)) {
        const n = Number(v);
        if (!Number.isFinite(n)) {
          return reply.code(400).send({ error: `${k} must be a number` });
        }
        patch[k] = n;
      } else {
        patch[k] = String(v ?? '');
      }
    }

    // Sanity, because these bounds are the difference between "prefers a sensible
    // release" and "rejects everything" — and a scorer that rejects everything looks
    // exactly like an indexer with no results.
    const merged = { ...settings.all(), ...patch } as Config;
    if (merged.losslessMinMbPerTrack >= merged.losslessMaxMbPerTrack) {
      return reply.code(400).send({ error: 'lossless minimum must be below the maximum' });
    }
    if (merged.lossyMinMbPerTrack >= merged.lossyMaxMbPerTrack) {
      return reply.code(400).send({ error: 'lossy minimum must be below the maximum' });
    }
    if (merged.maxTotalMb < 0) {
      return reply.code(400).send({ error: 'maximum download size cannot be negative' });
    }
    if (merged.maxAttempts < 1 || merged.maxAttempts > 10) {
      return reply.code(400).send({ error: 'attempts must be between 1 and 10' });
    }
    if (merged.artRetentionDays < 0) {
      return reply.code(400).send({ error: 'retention cannot be negative (0 means keep forever)' });
    }
    if (merged.stallMinutes < 1) {
      return reply.code(400).send({ error: 'stall timeout must be at least 1 minute' });
    }
    if (!merged.formats.length) {
      return reply.code(400).send({ error: 'at least one file type must be accepted' });
    }

    /*
     * Stamp when Song characteristics was switched ON, before the write, while the old value is
     * still readable. This is the line that keeps enabling the feature cheap: automatic analysis
     * is bounded to tracks first seen after this moment, so switching it on cannot quietly enrol
     * a library that was already there. Backfilling is a separate, deliberate button. Switching
     * it off leaves the stamp alone — turning it back on should not re-enrol everything that
     * arrived while it was off either.
     */
    if (patch.songCharacteristics === true && !settings.all().songCharacteristics) {
      patch.songCharacteristicsSince = Math.floor(Date.now() / 1000);
    }

    settings.set(patch);
    app.log.info({ keys: Object.keys(patch) }, 'admin updated settings');
    notifier.emit('settings.changed', {
      title: 'crate settings changed',
      // Names only, never values: a notification is a place a secret should never
      // end up, and the useful information is which knob moved.
      message: `Changed: ${Object.keys(patch).join(', ')}`,
      data: { keys: Object.keys(patch) },
    });
    return { ok: true, settings: settings.redacted() };
  });

  /** Forget a stored value and fall back to the environment default. */
  app.post('/api/admin/settings/clear', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const key = String((req.body as { key?: string } | undefined)?.key ?? '');
    if (!WRITABLE.includes(key as keyof Config)) {
      return reply.code(400).send({ error: 'not a settable key' });
    }
    settings.clear(key as keyof Config);
    return { ok: true, settings: settings.redacted() };
  });

  /**
   * Prove a download client, indexer or Last.fm key actually works.
   *
   * Each test does the smallest real call the service offers rather than a ping, so
   * a wrong key fails here instead of silently at the first request.
   */
  app.post('/api/admin/test/:what', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const what = String((req.params as { what: string }).what);

    try {
      if (what === 'sab') {
        const status = await sab.serverStatus();
        return { ok: true, detail: `SABnzbd ${status.version}, ${status.queued} queued` };
      }
      if (what === 'qbit') {
        if (!qbit.configured) return { ok: false, detail: 'no qBittorrent URL configured' };
        const version = await qbit.version();
        return { ok: true, detail: `qBittorrent ${version}` };
      }
      if (what === 'prowlarr') {
        const n = await prowlarr.indexerCount();
        return {
          ok: n > 0,
          detail:
            n > 0
              ? `${n} indexer${n === 1 ? '' : 's'} configured`
              : 'connected, but no indexers are configured in Prowlarr',
        };
      }
      if (what === 'mbmirror') {
        const { mbMirrorUrl } = settings.all();
        if (!mbMirrorUrl) return { ok: false, detail: 'no mirror URL set; using the public API' };
        const base = mirrorBase(mbMirrorUrl);
        // A known mbid rather than a search: it proves the database imported,
        // and works even on a mirror with no search server attached.
        const started = Date.now();
        const body = await getJson<{ name?: string }>(
          `${base}/artist/a74b1b7f-71a5-4011-9441-d0b5e4122711?fmt=json`,
          { headers: { 'User-Agent': 'crate/1.0 (admin test)' }, timeoutMs: 8_000 },
        );
        if (!body.name) return { ok: false, detail: 'answered, but not with MusicBrainz data' };
        const ms = Date.now() - started;
        /*
         * Each search index is built separately and comes online separately, so
         * "is search working" has no single answer during an import: the artist
         * index can be serving while release-group returns count: 0. crate
         * sends whatever a live index cannot answer to the public API, so the
         * useful report is per index rather than a yes or no.
         */
        const indexes: [string, string, string][] = [
          ['artists', 'artist', 'radiohead'],
          ['albums', 'release-group', 'ok computer'],
          ['tracks', 'recording', 'paranoid android'],
        ];
        const live: string[] = [];
        const building: string[] = [];
        for (const [label, entity, query] of indexes) {
          try {
            const q = await getJson<Record<string, unknown[]>>(
              `${base}/${entity}?fmt=json&limit=1&query=${encodeURIComponent(query)}`,
              { headers: { 'User-Agent': 'crate/1.0 (admin test)' }, timeoutMs: 8_000 },
            );
            const hits = q[`${entity}s`] ?? q[entity === 'release-group' ? 'release-groups' : entity];
            (Array.isArray(hits) && hits.length ? live : building).push(label);
          } catch {
            building.push(label);
          }
        }
        const search = live.length
          ? `search live for ${live.join(', ')}` +
            (building.length ? `; ${building.join(', ')} still building (public API used for those)` : '')
          : 'no search indexes yet — crate uses the public API for every search';
        return { ok: true, detail: `answered in ${ms}ms — ${body.name}; ${search}` };
      }
      if (what === 'openai') {
        return deps.openai.testKey();
      }
      if (what === 'acoustid') {
        const { acoustidKey } = settings.all();
        if (!acoustidKey) return { ok: false, detail: 'no key set' };
        /*
         * Probed with a junk fingerprint on purpose: a BAD KEY fails before
         * the fingerprint is even looked at, so which error comes back is the
         * answer. "invalid fingerprint" means the key was accepted.
         */
        try {
          await getJson(
            `https://api.acoustid.org/v2/lookup?client=${encodeURIComponent(acoustidKey)}` +
              `&duration=10&fingerprint=AQAAAA`,
            { timeoutMs: 8_000 },
          );
          return { ok: true, detail: 'key accepted' };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/invalid API key/i.test(msg)) {
            return {
              ok: false,
              detail:
                'AcoustID rejected this key. Note there are two kinds: this needs the ' +
                'APPLICATION key from acoustid.org/new-application, not the user key ' +
                'from your profile page.',
            };
          }
          if (/fingerprint/i.test(msg)) return { ok: true, detail: 'key accepted' };
          return { ok: false, detail: msg.slice(0, 160) };
        }
      }
      if (what === 'lastfm') {
        const { lastfmKey } = settings.all();
        if (!lastfmKey) return { ok: false, detail: 'no API key set' };
        const url =
          'https://ws.audioscrobbler.com/2.0/?method=artist.getsimilar' +
          `&artist=Radiohead&limit=1&api_key=${encodeURIComponent(lastfmKey)}&format=json`;
        const res = await fetch(url);
        const body = (await res.json()) as { error?: number; message?: string };
        if (body.error) return { ok: false, detail: `Last.fm error ${body.error}: ${body.message}` };
        return { ok: true, detail: 'key accepted; similar-artist lookup returned results' };
      }
      return reply.code(400).send({ error: 'unknown test' });
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  });

  // ---- library ------------------------------------------------------------

  /** Albums on disk with their files, so a delete acts on what is actually there. */
  app.get('/api/admin/library', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const albums = await library.albumsWithFiles();
    return {
      albums,
      trashRoot: deps.trashRoot,
      totals: {
        albums: albums.length,
        tracks: albums.reduce((n, a) => n + a.files.length, 0),
        bytes: albums.reduce((n, a) => n + a.files.reduce((m, f) => m + f.sizeBytes, 0), 0),
      },
    };
  });

  /**
   * Delete an album.
   *
   * Moves it to the trash rather than unlinking. The library row goes immediately so the
   * UI is honest, and the cached tags go with it so the next scan re-reads rather than
   * trusting a stale entry.
   */
  app.delete('/api/admin/library/album', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const key = String((req.query as Record<string, string>).key ?? '');
    const row = library.byKey(key);
    if (!row) return reply.code(404).send({ error: 'no such album in the library' });

    const withFiles = (await library.albumsWithFiles()).find((a) => a.normKey === key);
    const stamp = Math.floor(Date.now() / 1000);

    try {
      const result = await removeAlbum({
        dir: row.path,
        musicRoot: deps.musicRoot,
        trashRoot: deps.trashRoot,
        stamp,
        // Only move the named files when the folder holds more than this album, which is
        // what the pre-existing flat layout looks like — renaming that directory would
        // take the artist's whole discography with it.
        onlyFiles: withFiles?.sharedFolder ? withFiles.files.map((f) => f.name) : undefined,
      });
      library.forget(key);
      library.forgetTags((withFiles?.files ?? []).map((f) => `${row.path}/${f.name}`));

      app.log.warn(
        { album: `${row.artistName} — ${row.albumTitle}`, files: result.files.length, to: result.movedTo },
        'album deleted (moved to trash)',
      );
      notifier.emit('library.deleted', {
        title: 'crate deleted an album',
        message: `${row.artistName} — ${row.albumTitle} (${result.files.length} files) moved to trash`,
        data: {
          artist: row.artistName,
          album: row.albumTitle,
          files: result.files.length,
          trash: result.movedTo,
        },
      });
      return { ok: true, moved: result.files.length, trash: result.movedTo };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error({ err: msg, key }, 'album delete refused');
      return reply.code(400).send({ error: msg });
    }
  });

  /** Delete one track, by its path on disk. */
  app.delete('/api/admin/library/track', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const path = String((req.query as Record<string, string>).path ?? '');
    if (!path) return reply.code(400).send({ error: 'a path is required' });

    try {
      const result = await removeTrack({
        path,
        musicRoot: deps.musicRoot,
        trashRoot: deps.trashRoot,
        stamp: Math.floor(Date.now() / 1000),
      });
      library.forgetTags([path]);
      // The album row's count is now wrong; a rescan is cheap and keeps it truthful.
      await library.scan(deps.musicRoot);
      app.log.warn({ path, to: result.movedTo }, 'track deleted (moved to trash)');
      notifier.emit('library.deleted', {
        title: 'crate deleted a track',
        message: `${path.split('/').pop()} moved to trash`,
        data: { path, trash: result.movedTo },
      });
      return { ok: true, trash: result.movedTo };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error({ err: msg, path }, 'track delete refused');
      return reply.code(400).send({ error: msg });
    }
  });

  /** Rescan, so the pane can be refreshed after changes made outside crate. */
  app.post('/api/admin/library/rescan', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const r = await library.scan(deps.musicRoot);
    return { ok: true, ...r };
  });

  /**
   * Everything one user has, for the admin.
   *
   * Exists because a purge is a judgement call and this is its evidence: how
   * much of what they hold is theirs alone (that part leaves the disk), what
   * is shared (that part stays), and what they have built (playlists, plays,
   * imports) that would go with them. Read-only; the page that shows it and
   * the button that acts on it are deliberately the same screen.
   */
  app.get('/api/admin/users/:id/data', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const u = store.userById(id);
    if (!u) return reply.code(404).send({ error: 'no such user' });

    const counts = deps.userlib.counts(id);
    const exclusive = deps.userlib.exclusiveTracks(id);
    const playlists = deps.userlib.playlists(id);
    const albums = deps.userlib.albumsPage(id, { sort: 'plays', limit: 500 }).albums;
    const played = deps.userlib.mostPlayed(id, 10);
    const requests = store.requestCountBy(u.username);
    const imports = store.importSummary(id);

    return {
      user: { id: u.id, username: u.username, name: u.display_name, admin: !!u.is_admin, enabled: !!u.enabled },
      counts,
      exclusive: {
        tracks: exclusive.length,
        bytes: exclusive.reduce((n, t) => n + t.sizeBytes, 0),
      },
      playlists,
      albums,
      mostPlayed: played.map((t) => ({ title: t.title, artistName: t.artistName, plays: t.plays })),
      requests,
      imports,
    };
  });

  /**
   * Purge a user's data: every row that is theirs, and every file only they hold.
   *
   * Two design rules. The confirmation is re-typed SERVER-side — the body must
   * carry the exact username — so a stray click on a cached page or a replayed
   * request cannot do this; the UI's confirm box is convenience, this is the
   * check. And admins are refused outright, which also covers self-purge:
   * demote first, purge second, so destroying an admin's data takes two
   * deliberate steps by someone who is still an admin afterwards.
   *
   * Files follow the same law as every deletion in crate: trash, never unlink,
   * and each track's holders re-checked at the moment of action rather than
   * trusted from the page the admin was looking at. The ACCOUNT survives — a
   * purged user can sign in to an empty library and start over, which is what
   * "reset my sister's experiment" actually wants. Disable is a separate,
   * existing control.
   */
  app.post('/api/admin/users/:id/purge', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const u = store.userById(id);
    if (!u) return reply.code(404).send({ error: 'no such user' });
    if (u.is_admin) {
      return reply.code(400).send({ error: 'refusing to purge an admin — remove admin first' });
    }
    const typed = String((req.body as { username?: string } | undefined)?.username ?? '');
    if (typed !== u.username) {
      return reply.code(400).send({ error: 'type the username exactly to confirm' });
    }

    // Captured BEFORE their rows go, because afterwards nothing ties these
    // tracks to them. Holder counts are re-checked after the row purge, when
    // they are honest about everyone else.
    const candidates = deps.userlib.exclusiveTracks(id);
    const rows = deps.userlib.purgeUserRows(id, u.username);

    const stamp = Math.floor(Date.now() / 1000);
    let freedBytes = 0;
    const removed: string[] = [];
    const skipped: { path: string; why: string }[] = [];
    for (const t of candidates) {
      if (deps.userlib.holders(t.trackId).length) {
        skipped.push({ path: t.path, why: 'now held by someone else' });
        continue;
      }
      try {
        await removeTrack({ path: t.path, musicRoot: deps.musicRoot, trashRoot: deps.trashRoot, stamp });
        library.forgetTags([t.path]);
        removed.push(t.path);
        freedBytes += t.sizeBytes;
      } catch (err) {
        skipped.push({ path: t.path, why: err instanceof Error ? err.message : String(err) });
      }
    }

    if (removed.length) await library.scan(deps.musicRoot);
    deps.recommender.invalidateAll();

    app.log.warn(
      { user: u.username, rows, files: removed.length, freedBytes, skipped: skipped.length },
      'user data purged',
    );
    notifier.emit('library.deleted', {
      title: 'crate purged a user',
      message:
        `${u.username}: library and playlists cleared, ` +
        `${removed.length} file${removed.length === 1 ? '' : 's'} only they held moved to trash`,
      data: { user: u.username, rows, files: removed.length, freedBytes },
    });
    return { ok: true, rows, files: removed.length, freedBytes, skipped };
  });

  const AUDIO_EXT = /\.(mp3|flac|m4a|ogg|opus|wav|aac|alac|ape)$/i;

  /**
   * "Is this download redundant?" — answered from the tags of one file.
   *
   * Cached by path+mtime because a hundred tag parses over CIFS is a slow
   * page, and the answer only changes when the folder does. The pool lookup
   * itself is NOT cached: an adoption a minute ago changes it, and the whole
   * point of the hint is telling the truth about now.
   */
  const adoptHints = new Map<string, { newest: number; artist: string; album: string }>();

  /**
   * Folders crate unpacked itself, and when it finished.
   *
   * The settling hold assumes a fresh mtime means somebody else may still be writing. When
   * CRATE did the writing that assumption is simply wrong, and enforcing it would mean
   * unpacking an album and then being told to wait ten minutes before adopting it — trading
   * the manual shell step for a manual pause. In memory because it is only ever a hint about
   * the last few minutes, and a restart losing it costs one short wait.
   */
  const unpackedAt = new Map<string, number>();

  /**
   * Rewrite an album's identity — names, per-track titles and numbers.
   *
   * Exists because adoption and upload are confirm-once flows, and people
   * notice the typo AFTER pressing the button. Edits go to the INDEX, not the
   * files: overrideTrack survives rescans (the scanner trusts unchanged files'
   * existing rows), the audio is never rewritten, and if a file later changes
   * its own tags win again. Track identity is the trackId resolved to a path,
   * and the path must live inside the album's own folder — an id from some
   * other album cannot be smuggled in to rename it.
   */
  app.post('/api/admin/album/edit', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const b = (req.body ?? {}) as {
      key?: string;
      artistName?: string;
      albumTitle?: string;
      tracks?: { trackId?: number; title?: string; trackNo?: number }[];
    };
    const row = library.byKey(String(b.key ?? ''));
    if (!row) return reply.code(404).send({ error: 'no such album' });

    const artistName = String(b.artistName ?? '').trim() || row.artistName;
    const albumTitle = String(b.albumTitle ?? '').trim() || row.albumTitle;

    let touched = 0;
    for (const t of b.tracks ?? []) {
      const pool = deps.userlib.byId(Number(t.trackId));
      if (!pool) continue;
      if (!(pool.path + '/').startsWith(row.path.replace(/\/+$/, '') + '/') && !pool.path.startsWith(row.path + '/')) {
        continue;
      }
      library.overrideTrack(pool.path, {
        artistName,
        albumTitle,
        title: String(t.title ?? '').trim() || pool.title,
        trackNo: Number(t.trackNo) > 0 ? Number(t.trackNo) : (pool.trackNo ?? 1),
        albumMbid: null,
      });
      touched++;
    }
    if (!touched) return reply.code(400).send({ error: 'no tracks matched this album' });

    // A rename is a new library identity: record the new key, forget the old,
    // and drop the old name's cached art — nothing will ever ask for it again.
    const renamed = artistName !== row.artistName || albumTitle !== row.albumTitle;
    library.record({
      mbid: row.mbid ?? '',
      artistName,
      albumTitle,
      path: row.path,
      trackFiles: touched,
    });
    if (renamed) {
      library.forget(String(b.key));
      await deps.artcache.forgetAlbum(row.artistName, row.albumTitle);
    }
    deps.recommender.invalidateAll();
    app.log.warn({ from: `${row.artistName} — ${row.albumTitle}`, to: `${artistName} — ${albumTitle}`, touched }, 'album edited');
    return { ok: true, touched, artistName, albumTitle };
  });

  /**
   * Replace an album's cover.
   *
   * The image lands as cover.<ext> beside the audio — first place the art
   * resolver looks — after any existing cover/folder/front file is removed,
   * because two candidate covers make the winner an accident of directory
   * order. The cached art for the album is dropped so the change is visible
   * on the next request rather than after a sweep that pinned art never gets.
   */
  app.post('/api/admin/album/cover', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const key = String((req.query as Record<string, string>).key ?? '');
    const row = library.byKey(key);
    if (!row) return reply.code(404).send({ error: 'no such album' });

    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'no image attached' });
    const ext = (part.filename.match(/\.(jpe?g|png|webp)$/i)?.[0] ?? '').toLowerCase();
    if (!ext) return reply.code(400).send({ error: 'jpg, png or webp only' });

    for (const f of await readdir(row.path).catch(() => [] as string[])) {
      if (/^(cover|folder|front)\.(jpe?g|png|webp)$/i.test(f)) {
        await rm(join(row.path, f), { force: true }).catch(() => {});
      }
    }
    const dest = join(row.path, `cover${ext === '.jpeg' ? '.jpg' : ext}`);
    await pipeline(part.file, createWriteStream(dest));
    await deps.artcache.forgetAlbum(row.artistName, row.albumTitle);
    app.log.warn({ album: `${row.artistName} — ${row.albumTitle}`, dest }, 'cover replaced');
    return { ok: true };
  });

  /**
   * Downloads crate does not know about.
   *
   * The pipeline only tracks jobs it queued itself, so anything added to SAB
   * by hand completes into the music folder and sits there invisible. This
   * walks that folder and offers what it finds. Entries younger than ten
   * minutes are held back: a crate-owned job lives here briefly between SAB
   * finishing and the importer collecting it, and adopting one mid-collection
   * would have two movers fighting over the same files.
   */
  app.get('/api/admin/adoptable', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const out: {
      name: string;
      path: string;
      audioFiles: number;
      archiveFiles: number;
      bytes: number;
      ageMinutes: number;
      settling: boolean;
      note: string;
    }[] = [];
    const now = Date.now();
    const entries = await readdir(deps.adoptRoot, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(deps.adoptRoot, e.name);
      let audio = 0;
      let bytes = 0;
      let newest = 0;
      let archives = 0;
      let others = 0;
      const walk = async (d: string, depth: number, onAudio?: (fp: string) => void): Promise<void> => {
        if (depth > 3) return;
        for (const f of await readdir(d, { withFileTypes: true }).catch(() => [])) {
          const fp = join(d, f.name);
          if (f.isDirectory()) {
            await walk(fp, depth + 1, onAudio);
            continue;
          }
          const st = await stat(fp).catch(() => null);
          if (!st) continue;
          newest = Math.max(newest, st.mtimeMs);
          if (AUDIO_EXT.test(f.name)) {
            audio++;
            bytes += st.size;
            onAudio?.(fp);
          } else if (isArchive(f.name)) archives++;
          else others++;
        }
      };
      let firstAudio = '';
      const remember = (fp: string) => {
        if (!firstAudio) firstAudio = fp;
      };
      if (e.isDirectory()) await walk(p, 0, remember);
      else {
        const st = await stat(p).catch(() => null);
        if (!st) continue;
        newest = st.mtimeMs;
        if (AUDIO_EXT.test(e.name)) {
          audio = 1;
          bytes = st.size;
          remember(p);
        }
      }

      // What the tags say this is, and whether the pool already holds it.
      let dupNote = '';
      if (firstAudio) {
        let hint = adoptHints.get(p);
        if (!hint || hint.newest !== newest) {
          try {
            const m = await parseFile(firstAudio);
            hint = {
              newest,
              artist: m.common.artist ?? m.common.albumartist ?? '',
              album: m.common.album ?? '',
            };
          } catch {
            hint = { newest, artist: '', album: '' };
          }
          adoptHints.set(p, hint);
        }
        if (hint.artist && hint.album) {
          const pool = deps.userlib.poolForAlbum(hint.artist, hint.album);
          dupNote =
            pool.length > 0
              ? `tags say ${hint.artist} — ${hint.album}; already in the pool (${pool.length} tracks) — likely a duplicate`
              : `tags say ${hint.artist} — ${hint.album}`;
        }
      }
      const ageMinutes = Math.round((now - newest) / 60000);
      // Zero-audio entries stay LISTED: a download that arrived as artwork
      // scans and nothing else is precisely the junk somebody wants to delete,
      // and hiding it made it undeletable. Only genuinely empty dirs are
      // skipped.
      if (audio === 0 && archives === 0 && others === 0) continue;
      /*
       * Young entries are SHOWN but not adoptable, where they used to be hidden.
       *
       * The hold exists because a crate-owned job lives here briefly between SAB finishing
       * and the importer collecting it, and adopting one mid-collection would have two movers
       * fighting over the same files. That reason is sound; hiding the row was not. Unpacking
       * rewrites every mtime, so the moment anybody extracted an archive the entry vanished
       * for ten minutes — the exact opposite of the feedback they were looking for.
       */
      // Crate's own extraction does not count as "somebody might still be writing": if every
      // recent mtime is explained by an unpack we performed, the folder is complete now.
      const ours = unpackedAt.get(p);
      const settling = ageMinutes < 10 && !(ours !== undefined && newest <= ours + 5_000);
      out.push({
        name: e.name,
        path: p,
        audioFiles: audio,
        archiveFiles: archives,
        bytes,
        ageMinutes,
        settling,
        note:
          settling
            ? `just changed — settling for ${Math.max(1, 10 - ageMinutes)} more min in case it is still being written`
            : audio === 0 && archives > 0
              ? 'only archives — unpack them here, or delete'
              : audio === 0
                ? 'no audio at all — a dud worth deleting'
                : archives > 0
                  ? `unpacked; the archives stay behind${dupNote ? ' · ' + dupNote : ''}`
                  : dupNote,
      });
    }
    return { adoptRoot: deps.adoptRoot, entries: out, unpacker: await unpackerAvailable() };
  });

  /**
   * Unpack the archives inside one or more downloads, in place.
   *
   * Scene music releases arrive as RAR sets and the adopt step only ever moved audio, so the
   * only way through was a shell on the NAS. Nothing is deleted here: the archives stay where
   * they are, and the folder is re-listed so the caller can see what came out before deciding
   * whether to adopt it.
   */
  app.post('/api/admin/adoptable/unpack', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    if (!(await unpackerAvailable())) {
      return reply.code(503).send({ error: '7z is not in this image — rebuild it to unpack archives' });
    }
    const body = (req.body ?? {}) as { paths?: string[]; path?: string };
    const targets = body.paths ?? (body.path ? [body.path] : []);
    if (!targets.length) return reply.code(400).send({ error: 'nothing selected' });

    const root = await realpath(deps.adoptRoot).catch(() => null);
    if (!root) return reply.code(400).send({ error: 'downloads folder unavailable' });

    const done: { path: string; archives: number; audioGained: number; errors: string[] }[] = [];
    for (const raw of targets.slice(0, 50)) {
      // The same realpath fence adoption and deletion use: a symlink out of the downloads
      // folder must not turn "unpack this" into "extract over anything".
      const target = await realpath(String(raw)).catch(() => null);
      if (!target || target === root || !(target + '/').startsWith(root + '/')) {
        done.push({
          path: String(raw),
          archives: 0,
          audioGained: 0,
          errors: ['not inside the downloads folder'],
        });
        continue;
      }
      const r = await unpackDir(target, AUDIO_EXT, (m) => app.log.warn(m));
      // Stamped after the writes finish, so the listing can tell crate's own mtimes from
      // somebody else's and not hold the folder back for ten minutes.
      if (r.archives.length) unpackedAt.set(target, Date.now());
      app.log.warn(
        { entry: basename(target), archives: r.archives.length, audioGained: r.audioGained },
        'unpacked a download',
      );
      done.push({ path: target, archives: r.archives.length, audioGained: r.audioGained, errors: r.errors });
    }
    return { ok: true, results: done };
  });

  /**
   * Delete a download nobody wants to adopt.
   *
   * Same law as every deletion in crate: to the trash, never unlinked. The
   * adopt root and the trash share the /downloads mount, so the whole entry
   * moves with one rename; the EXDEV fallback exists for anyone who ever
   * configures them apart. The same realpath fence as adoption applies — a
   * symlink out of the downloads folder must not turn "delete this dud" into
   * "delete something else".
   */
  const trashAdoptable = async (target: string): Promise<string> => {
    const stamp = Math.floor(Date.now() / 1000);
    const destDir = join(deps.trashRoot, `unadopted-${stamp}`);
    await mkdir(destDir, { recursive: true });
    const dest = join(destDir, basename(target));
    try {
      await rename(target, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      const walk = async (from: string, to: string): Promise<void> => {
        const st = await stat(from);
        if (st.isFile()) {
          await moveFile(from, to);
          return;
        }
        await mkdir(to, { recursive: true });
        for (const f of await readdir(from)) await walk(join(from, f), join(to, f));
        await rm(from, { recursive: true, force: true });
      };
      await walk(target, dest);
    }
    return dest;
  };

  /**
   * Sweep every true dud in one go: entries with no audio AND no archives.
   *
   * Archives are deliberately excluded even though they show zero audio — a
   * tar still CONTAINS the music, and "delete all the junk" must not quietly
   * include the one entry that was not junk. Those stay listed with their
   * unpack-it-first note until someone deals with them by hand.
   */
  app.post('/api/admin/adoptable/purge-duds', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const root = await realpath(deps.adoptRoot).catch(() => null);
    if (!root) return reply.code(400).send({ error: 'downloads folder unavailable' });

    const removed: string[] = [];
    const now = Date.now();
    for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.')) continue;
      const p = join(root, e.name);
      let audio = 0;
      let archives = 0;
      let others = 0;
      let newest = 0;
      const walk = async (d: string, depth: number): Promise<void> => {
        if (depth > 3) return;
        for (const f of await readdir(d, { withFileTypes: true }).catch(() => [])) {
          const fp = join(d, f.name);
          if (f.isDirectory()) {
            await walk(fp, depth + 1);
            continue;
          }
          const st = await stat(fp).catch(() => null);
          if (!st) continue;
          newest = Math.max(newest, st.mtimeMs);
          if (AUDIO_EXT.test(f.name)) audio++;
          else if (isArchive(f.name)) archives++;
          else others++;
        }
      };
      if (e.isDirectory()) await walk(p, 0);
      else {
        const st = await stat(p).catch(() => null);
        if (!st) continue;
        newest = st.mtimeMs;
        if (AUDIO_EXT.test(e.name)) audio++;
        else if (isArchive(e.name)) archives++;
        else others++;
      }
      // Same fences as the listing: not empty, not too young to be crate's own.
      if (audio > 0 || archives > 0) continue;
      if (others === 0) continue;
      if ((now - newest) / 60000 < 10) continue;
      await trashAdoptable(p);
      removed.push(e.name);
    }
    app.log.warn({ removed: removed.length }, 'dud downloads purged');
    return { ok: true, removed };
  });

  /**
   * Trash a hand-picked set in one request.
   *
   * Every path is fenced INDIVIDUALLY — one bad path in a batch of twenty
   * skips that path and reports it, rather than either failing the whole
   * batch (annoying) or trusting the rest less carefully (worse).
   */
  app.post('/api/admin/adoptable/delete', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const asked = ((req.body as { paths?: unknown } | undefined)?.paths ?? []) as string[];
    if (!Array.isArray(asked) || !asked.length) {
      return reply.code(400).send({ error: 'paths[] is required' });
    }
    const root = await realpath(deps.adoptRoot).catch(() => null);
    if (!root) return reply.code(400).send({ error: 'downloads folder unavailable' });

    const removed: string[] = [];
    const failed: { path: string; why: string }[] = [];
    for (const p of asked.slice(0, 200)) {
      const target = await realpath(String(p)).catch(() => null);
      if (!target || target === root || !(target + '/').startsWith(root + '/')) {
        failed.push({ path: String(p), why: 'not inside the downloads folder' });
        continue;
      }
      try {
        await trashAdoptable(target);
        removed.push(basename(target));
      } catch (err) {
        failed.push({ path: String(p), why: err instanceof Error ? err.message : String(err) });
      }
    }
    app.log.warn({ removed: removed.length, failed: failed.length }, 'selected downloads trashed');
    return { ok: true, removed, failed };
  });

  app.delete('/api/admin/adoptable', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const asked = String((req.query as Record<string, string>).path ?? '');
    const root = await realpath(deps.adoptRoot).catch(() => null);
    const target = await realpath(asked).catch(() => null);
    if (!root || !target || target === root || !(target + '/').startsWith(root + '/')) {
      return reply.code(400).send({ error: 'not inside the downloads folder' });
    }

    const dest = await trashAdoptable(target);
    app.log.warn({ from: target, to: dest }, 'unadopted download moved to trash');
    return { ok: true, trash: dest };
  });

  /**
   * Pull one downloaded folder into the upload flow.
   *
   * Files MOVE into a staging batch (same mount, so a rename) with an origin
   * marker — cancelling the confirm screen puts them back, because unlike an
   * upload this is the only copy. Identification then runs exactly as it does
   * for uploads: tags always, fingerprints when the AcoustID key is set. The
   * response is the same shape /api/upload returns, so the client reuses the
   * whole confirm screen.
   */
  app.post('/api/admin/adopt', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const c = deps.need(req, reply);
    if (!c || !c.id) return;

    const asked = String((req.body as { path?: string } | undefined)?.path ?? '');
    // realpath both sides: resolve() normalises a string but follows nothing,
    // and a symlink out of the adopt root is a path to someone else's files.
    const root = await realpath(deps.adoptRoot).catch(() => null);
    const target = await realpath(asked).catch(() => null);
    if (!root || !target || !(target + '/').startsWith(root + '/')) {
      return reply.code(400).send({ error: 'not inside the downloads folder' });
    }

    const sources: string[] = [];
    const collect = async (d: string, depth: number): Promise<void> => {
      const st = await stat(d);
      if (st.isFile()) {
        sources.push(d);
        return;
      }
      if (depth > 3) return;
      for (const f of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        if (f.isDirectory()) await collect(join(d, f.name), depth + 1);
        else sources.push(join(d, f.name));
      }
    };
    await collect(target, 0);

    const batchId = uploads.newBatchId(c.id);
    const dir = uploads.batchDir(c.id, batchId)!;
    await uploads.markOrigin(dir, target);
    const files: StagedFile[] = await uploads.adopt(dir, sources);
    if (!files.some((f) => f.kind === 'audio')) {
      await uploads.discard(dir);
      return reply.code(400).send({ error: 'no audio files in that folder (archives are not opened)' });
    }
    for (const f of files) {
      if (f.kind === 'audio' && acoustid.enabled()) {
        // Same tag hint the upload path passes: the fingerprint picks the recording, the
        // tag breaks the tie between an original and a cover of the same song.
        f.match = await acoustid.identify(join(dir, f.name), {
          artist: f.tags?.artist,
          title: f.tags?.title,
        });
      }
    }
    app.log.warn({ user: c.user, from: target, files: files.length }, 'download adopted into staging');
    return { batchId, files, rejected: [] };
  });

  /**
   * Which copy of a doubled track to keep.
   *
   * Lossless beats lossy outright — a FLAC and an MP3 of one song is not a
   * close call. Between two of the same format the larger file wins, which
   * for FLAC means the less aggressively compressed rip and for MP3 the
   * higher bitrate. The loser goes to the trash like everything else here,
   * so a wrong call costs a restore rather than a re-download.
   */
  const LOSSLESS = /\.(flac|alac|ape|wav)$/i;
  const rankCopy = (f: { path: string; sizeBytes: number }): number =>
    (LOSSLESS.test(f.path) ? 1e12 : 0) + f.sizeBytes;

  app.get('/api/admin/duplicates', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const sets = deps.userlib.duplicateSets().map((s) => {
      const ranked = [...s.files].sort((a, b) => rankCopy(b) - rankCopy(a));
      return { ...s, keep: ranked[0]!.trackId, files: ranked };
    });
    return {
      sets,
      totals: {
        sets: sets.length,
        redundant: sets.reduce((n, s) => n + s.files.length - 1, 0),
        bytes: sets.reduce((n, s) => n + s.files.slice(1).reduce((m, f) => m + f.sizeBytes, 0), 0),
      },
    };
  });

  /**
   * Trash the redundant copies, keeping the best of each set.
   *
   * References move BEFORE the file goes: if the copy being removed is in
   * somebody's library and the keeper is not, the library entry, the play
   * count and any playlist position all transfer to the keeper. Deleting a
   * duplicate must never cost anyone the song.
   */
  app.post('/api/admin/duplicates/purge', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const only = (req.body as { albums?: string[] } | undefined)?.albums;
    const wanted = Array.isArray(only) && only.length ? new Set(only) : null;

    const stamp = Math.floor(Date.now() / 1000);
    let removed = 0;
    let freed = 0;
    const failed: { path: string; why: string }[] = [];

    for (const set of deps.userlib.duplicateSets()) {
      if (wanted && !wanted.has(`${set.albumArtist}|${set.album}`)) continue;
      const ranked = [...set.files].sort((a, b) => rankCopy(b) - rankCopy(a));
      const keep = ranked[0]!;
      for (const drop of ranked.slice(1)) {
        try {
          deps.userlib.transferReferences(drop.trackId, keep.trackId);
          await removeTrack({
            path: drop.path,
            musicRoot: deps.musicRoot,
            trashRoot: deps.trashRoot,
            stamp,
          });
          library.forgetTags([drop.path]);
          removed++;
          freed += drop.sizeBytes;
        } catch (err) {
          failed.push({ path: drop.path, why: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    if (removed) await library.scan(deps.musicRoot);
    deps.recommender.invalidateAll();
    app.log.warn({ removed, freed, failed: failed.length }, 'duplicate copies purged');
    if (removed) {
      notifier.emit('library.deleted', {
        title: 'crate removed duplicate copies',
        message: `${removed} redundant file${removed === 1 ? '' : 's'} moved to trash`,
        data: { removed, freed },
      });
    }
    return { ok: true, removed, freed, failed };
  });

  /**
   * Tracks nobody has in a library.
   *
   * These are the files that arrived because they happened to be on an album somebody
   * wanted one song from. Keeping them is the point — it is what makes the next request
   * for one instant — so nothing here happens automatically. This is the list, and the
   * purge below is a decision somebody makes when the space matters more.
   */
  app.get('/api/admin/orphans', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const orphans = deps.userlib.orphans();
    return {
      orphans,
      totals: {
        tracks: orphans.length,
        bytes: orphans.reduce((n, t) => n + t.sizeBytes, 0),
      },
    };
  });

  /**
   * Purge tracks nobody holds.
   *
   * Re-checks that each track is genuinely unheld at the moment of deletion rather than
   * trusting the list the browser was shown — somebody may have added one to their
   * library between the page loading and the button being pressed, and deleting a track
   * out from under them would be the worst possible outcome of a tidy-up.
   *
   * Moves to the trash like every other deletion here. Nothing is unlinked.
   */
  app.post('/api/admin/purge', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const b = (req.body ?? {}) as { trackIds?: number[]; all?: boolean };
    const wanted = b.all ? deps.userlib.orphans().map((t) => t.trackId) : (b.trackIds ?? []).map(Number);
    if (!wanted.length) return reply.code(400).send({ error: 'nothing selected' });

    const stamp = Math.floor(Date.now() / 1000);
    const removed: string[] = [];
    const skipped: { path: string; why: string }[] = [];

    for (const id of wanted) {
      const t = deps.userlib.byId(id);
      if (!t) continue;
      const holders = deps.userlib.holders(id);
      if (holders.length) {
        skipped.push({ path: t.path, why: `now in ${holders.join(', ')}'s library` });
        continue;
      }
      try {
        await removeTrack({
          path: t.path,
          musicRoot: deps.musicRoot,
          trashRoot: deps.trashRoot,
          stamp,
        });
        library.forgetTags([t.path]);
        removed.push(t.path);
      } catch (err) {
        skipped.push({ path: t.path, why: err instanceof Error ? err.message : String(err) });
      }
    }

    // Rescan so the album rollup and counts stop describing files that have gone, and drop
    // every cached recommendation set — a purge can remove something any user was being
    // offered, and a stale set would keep offering it.
    await library.scan(deps.musicRoot);
    deps.recommender.invalidateAll();

    app.log.warn({ removed: removed.length, skipped: skipped.length }, 'orphan purge');
    if (removed.length) {
      notifier.emit('library.deleted', {
        title: 'crate purged unused tracks',
        message: `${removed.length} track${removed.length === 1 ? '' : 's'} nobody had were moved to trash`,
        data: { removed: removed.length, skipped: skipped.length },
      });
    }
    return { ok: true, removed: removed.length, skipped };
  });

  // ---- webhooks ----------------------------------------------------------

  /** The event catalogue, so the form is built from the server's list not a copy. */
  app.get('/api/admin/webhooks', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    return {
      webhooks: notifier.redactedList(),
      events: EVENTS.map((e) => ({ name: e, label: EVENT_LABELS[e] })),
    };
  });

  app.post('/api/admin/webhooks', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const b = (req.body ?? {}) as {
      name?: string;
      kind?: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
      events?: string[];
    };
    const name = String(b.name ?? '').trim();
    const kind = b.kind === 'rest' ? 'rest' : b.kind === 'pushover' ? 'pushover' : null;
    if (!name) return reply.code(400).send({ error: 'a name is required' });
    if (!kind) return reply.code(400).send({ error: "kind must be 'pushover' or 'rest'" });

    const bad = validateConfig(kind, b.config ?? {});
    if (bad) return reply.code(400).send({ error: bad });

    const id = notifier.create({
      name,
      kind,
      enabled: b.enabled !== false,
      config: b.config ?? {},
      events: cleanEvents(b.events),
    });
    app.log.info({ id, kind, name }, 'webhook created');
    return { ok: true, id, webhooks: notifier.redactedList() };
  });

  app.put('/api/admin/webhooks/:id', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const row = notifier.get(id);
    if (!row) return reply.code(404).send({ error: 'no such webhook' });

    const b = (req.body ?? {}) as {
      name?: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
      events?: string[];
    };
    if (b.config) {
      // Validated against the merged result, since the form may legitimately omit a
      // secret it was never shown and that must not read as "missing".
      const merged = { ...JSON.parse(row.config), ...stripBlankSecrets(b.config) };
      const bad = validateConfig(row.kind, merged);
      if (bad) return reply.code(400).send({ error: bad });
    }

    notifier.update(id, {
      name: b.name?.trim() || undefined,
      enabled: b.enabled,
      config: b.config,
      events: b.events ? cleanEvents(b.events) : undefined,
    });
    return { ok: true, webhooks: notifier.redactedList() };
  });

  app.delete('/api/admin/webhooks/:id', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    if (!notifier.get(id)) return reply.code(404).send({ error: 'no such webhook' });
    notifier.remove(id);
    app.log.info({ id }, 'webhook deleted');
    return { ok: true, webhooks: notifier.redactedList() };
  });

  /** Deliver a sample event, so a destination is proven before it has to matter. */
  app.post('/api/admin/webhooks/:id/test', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const result = await notifier.test(id);
    return { ...result, webhooks: notifier.redactedList() };
  });

  /**
   * Try a search without grabbing anything.
   *
   * This is the thing worth having on a settings page: change the size bounds or the
   * accepted formats, then see what survives them, rather than discovering the effect
   * on the next real request. Nothing is sent to SABnzbd.
   */
  app.post('/api/admin/test/search', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const b = (req.body ?? {}) as { artist?: string; album?: string; trackCount?: number };
    const artist = String(b.artist ?? '').trim();
    const album = String(b.album ?? '').trim();
    if (!artist || !album) return reply.code(400).send({ error: 'artist and album are required' });

    const { score } = await import('../lib/release.js');
    const found = await prowlarr.search(artist, album);
    const cfg = settings.all();
    const ranked = score(
      found,
      { artist, album, trackCount: Number(b.trackCount) || 0, year: '' },
      cfg,
    );
    return {
      found: found.length,
      viable: ranked.length,
      results: ranked.slice(0, 10).map((r) => ({
        title: r.title,
        sizeMb: Math.round(r.size / 1024 / 1024),
        score: r.score,
        reasons: r.reasons,
        indexer: r.indexer,
      })),
      rejected: found.length - ranked.length,
    };
  });
}

/** Drop unknown event names rather than storing something that can never fire. */
function cleanEvents(events: unknown): string[] {
  if (!Array.isArray(events)) return [];
  const known = new Set<string>(EVENTS as readonly string[]);
  return events.map(String).filter((e) => known.has(e as EventName));
}

/** Remove blank secrets so validation sees "unchanged", not "cleared". */
function stripBlankSecrets(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if ((k === 'token' || k === 'user' || k === 'headers') && (v === '' || v == null)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Reject a configuration that cannot possibly deliver.
 *
 * Checked here rather than at send time because a webhook that was accepted and then
 * silently never fires is exactly the failure mode this app keeps having to design
 * against. A URL is also required to be http(s) so a typo cannot turn into a request
 * to some other scheme.
 */
function validateConfig(kind: string, config: Record<string, unknown>): string | null {
  if (kind === 'pushover') {
    if (!config.token) return 'Pushover needs an API token';
    if (!config.user) return 'Pushover needs a user key';
    const p = Number(config.priority ?? 0);
    if (!Number.isFinite(p) || p < -2 || p > 2) return 'priority must be between -2 and 2';
    return null;
  }
  const url = String(config.url ?? '');
  if (!url) return 'a URL is required';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'that URL is not valid';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'the URL must be http or https';
  }
  const method = String(config.method ?? 'POST').toUpperCase();
  if (!['POST', 'PUT', 'PATCH'].includes(method)) return 'method must be POST, PUT or PATCH';
  if (config.headers !== undefined && typeof config.headers !== 'object') {
    return 'headers must be a JSON object';
  }
  return null;
}
