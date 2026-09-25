/**
 * OpenSubsonic, served per user.
 *
 * This is what makes the per-user library real rather than a crate-only fiction. A server
 * serves a folder, so it shows everybody everything; crate knows who owns what, so every
 * response here is filtered through the caller's own user_tracks. Two people pointing
 * Amperfy at the same host see two different libraries.
 *
 * AUTHENTICATION — the part that decides whether "just use their crate password" works.
 *
 * Subsonic has three schemes, and which of them a server *can* support is determined by
 * how it stores passwords, not by preference:
 *
 *   p=<password>        the real password arrives, so it can be checked against an
 *   p=enc:<hex>         argon2id hash. Works with the existing crate password, no
 *                       change to how anything is stored. This is the good case.
 *
 *   t=md5(password+salt) the server has to compute the same md5, which requires the
 *   &s=<salt>            PLAINTEXT password. An argon2id hash cannot produce it — that is
 *                        the entire point of a password hash. No amount of cleverness
 *                        gets around this; it is why every Subsonic server that supports
 *                        token auth keeps recoverable passwords.
 *
 * A client's settings screen asking for "username and password" does not say which of
 * these it sends. So both are supported:
 *
 *   - p= is checked against the account's argon2id hash. Nothing is stored differently
 *     and the user types their normal crate password.
 *   - t= is checked against an optional, separate "streaming password" the user sets in
 *     their account page. That one is necessarily recoverable, so it is deliberately NOT
 *     the account password: worst case it grants access to that person's own music, and
 *     it cannot be used to log into crate, change settings, or request downloads.
 *
 * A token request with no streaming password set returns error 40 with a message saying
 * what to do, rather than a bare "wrong password" that would send somebody hunting for a
 * typo that is not there.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Store, User } from '../lib/store.js';
import type { ArtCache } from '../lib/artcache.js';
import { albumIdentity } from '../lib/library.js';
import { norm } from '../lib/release.js';
import type { Playlist, UserLibrary } from '../lib/userlib.js';
import type { PlaylistArt } from '../lib/playlistart.js';
import type { Recommender } from '../lib/recommend.js';
import { clientIp } from './auth.js';
import { VERSION_SHORT } from '../lib/version.js';
import { plan, spawnTranscode } from '../lib/transcode.js';
import type { ExternalCatalog, ExternalRow } from '../lib/external.js';
import { streamExternal } from '../lib/externalstream.js';
import { matchWords } from '../lib/songmatch.js';
import { getBytes } from '../lib/http.js';

const API_VERSION = '1.16.1';
const SERVER = 'crate';

interface SubsonicDeps {
  store: Store;
  userlib: UserLibrary;
  recommender: Recommender;
  artcache: ArtCache;
  playlistart: PlaylistArt;
  /** Songs from outside the library, and the ids that keep working once they are kept. */
  external: ExternalCatalog;
}

/** Subsonic error codes that matter here. */
const ERR = {
  MISSING_PARAM: 10,
  BAD_CREDENTIALS: 40,
  NOT_FOUND: 70,
};

const MIME: Record<string, string> = {
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
};

/**
 * Stable, opaque ids. Subsonic ids are strings, so the natural key can be carried.
 *
 * An album id has to carry two values. They are packed as JSON rather than joined with a
 * delimiter: the first cut used a NUL byte, which is genuinely unambiguous — no tag or
 * filename contains one — but it is invisible in an editor, in a diff and in grep output,
 * and a delimiter you cannot see is a delimiter nobody can maintain. JSON says what it is.
 */
const enc = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const dec = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');
/*
 * Both halves NORMALISED, because this is an identity and not a label.
 *
 * Keying on the raw title let one album in with two ids: half of Dizzy Up The Girl is tagged
 * "Dizzy up the Girl", which norm_album folds and a raw string does not, so the record showed
 * twice. The readable title still travels in `name` — only the key is normalised.
 */
const albumKey = (artist: string, album: string): string =>
  JSON.stringify([norm(artist), albumIdentity(album)]);
const albumId = (artist: string, album: string): string => `al-${enc(albumKey(artist, album))}`;
const albumParts = (id: string): [string, string] | null => {
  if (!id.startsWith('al-')) return null;
  try {
    const v = JSON.parse(dec(id.slice(3))) as unknown;
    if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string') {
      return [v[0], v[1]];
    }
  } catch {
    /* not one of ours */
  }
  return null;
};

/**
 * One page of results, per Subsonic's offset/count pairs.
 *
 * The offsets were accepted and then ignored, so every page returned page one. That is
 * worse than not implementing paging: a client walking through results collects the
 * same rows over and over with nothing anywhere saying so, and a twenty-track album
 * arrives as sixty. Past the end returns nothing, which is how a client knows to stop.
 */
function page<T>(rows: T[], offset: unknown, count: unknown, fallback: number): T[] {
  const from = Math.max(Number(offset ?? 0) || 0, 0);
  const size = Math.max(Number(count ?? fallback) || fallback, 0);
  return rows.slice(from, from + size);
}

function xmlEscape(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Serialise to Subsonic XML.
 *
 * Written by hand rather than pulled in as a dependency because the shape is tiny and
 * fixed: attributes for scalars, child elements for arrays and objects. XML is the
 * DEFAULT for Subsonic — a client that does not send f=json expects it, and returning
 * JSON to one of those looks like a broken server.
 */
function toXml(name: string, node: unknown): string {
  if (node === null || node === undefined) return `<${name}/>`;
  if (typeof node !== 'object') return `<${name}>${xmlEscape(String(node))}</${name}>`;

  const obj = node as Record<string, unknown>;
  const attrs: string[] = [];
  const children: string[] = [];

  let text: string | null = null;

  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    /*
     * `value` is the element's TEXT, not an attribute.
     *
     * Subsonic's XML puts a genre name in the element body — <genre songCount="12"
     * albumCount="3">rock</genre> — while its JSON carries the same thing as
     * {"value": "rock"}. Naming the property `value` lets one response object
     * serialise correctly into both, instead of each endpoint building two shapes.
     */
    if (k === 'value' && typeof v !== 'object') {
      text = xmlEscape(String(v));
      continue;
    }
    if (Array.isArray(v)) {
      for (const item of v) children.push(toXml(k, item));
    } else if (typeof v === 'object') {
      children.push(toXml(k, v));
    } else {
      attrs.push(`${k}="${xmlEscape(String(v))}"`);
    }
  }
  const open = `<${name}${attrs.length ? ' ' + attrs.join(' ') : ''}`;
  const body = `${text ?? ''}${children.join('')}`;
  return body ? `${open}>${body}</${name}>` : `${open}/>`;
}

export function subsonicRoutes(app: FastifyInstance, deps: SubsonicDeps): void {
  const { store, userlib } = deps;

  /** Respond in whichever format the client asked for. */
  function send(req: FastifyRequest, reply: FastifyReply, body: Record<string, unknown>): void {
    const q = req.query as Record<string, string>;
    const base = {
      status: 'ok',
      version: API_VERSION,
      type: SERVER,
      serverVersion: VERSION_SHORT,
      // Declares the OpenSubsonic extensions this speaks. Clients use it to decide
      // whether to bother with the newer calls.
      openSubsonic: true,
      ...body,
    };
    if ((q.f ?? '').toLowerCase() === 'json') {
      reply.type('application/json').send({ 'subsonic-response': base });
      return;
    }
    reply
      .type('application/xml')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          toXml('subsonic-response', { xmlns: 'http://subsonic.org/restapi', ...base }),
      );
  }

  function fail(req: FastifyRequest, reply: FastifyReply, code: number, message: string): void {
    const q = req.query as Record<string, string>;
    const base = {
      status: 'failed',
      version: API_VERSION,
      type: SERVER,
      serverVersion: VERSION_SHORT,
      openSubsonic: true,
      error: { code, message },
    };
    // Always HTTP 200: Subsonic reports failure in the body, and a client seeing a 401
    // often shows "server unreachable" rather than the actual reason.
    if ((q.f ?? '').toLowerCase() === 'json') {
      reply.type('application/json').send({ 'subsonic-response': base });
      return;
    }
    reply
      .type('application/xml')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          toXml('subsonic-response', { xmlns: 'http://subsonic.org/restapi', ...base }),
      );
  }

  /**
   * Authenticate a Subsonic request. See the header for why there are two paths.
   *
   * Returns the user, or null having already sent the error response.
   */
  async function auth(req: FastifyRequest, reply: FastifyReply): Promise<User | null> {
    const q = req.query as Record<string, string>;
    const username = String(q.u ?? '').trim();
    if (!username) {
      fail(req, reply, ERR.MISSING_PARAM, 'Required parameter u is missing');
      return null;
    }

    /*
     * The same lockout the web sign-in uses.
     *
     * This path had none, which made the web limit decorative: anyone with a wordlist
     * pointed it at /rest instead and was never slowed down. There are no sessions here
     * — every Subsonic call re-authenticates — so the throttle belongs inside the
     * per-request check rather than around a form.
     *
     * Cost matters on this path. One SELECT reads the failure count and the lockout
     * together, and clearFails() runs only when there is something to clear, so the
     * ordinary case of correct credentials is one indexed read and no writes.
     */
    const ip = clientIp(req);
    const state = store.loginFailState(ip, username);
    if (state.lockedForS > 0) {
      const mins = Math.ceil(state.lockedForS / 60);
      // BAD_CREDENTIALS rather than a new code: Subsonic has no rate-limit error, and
      // clients that meet an unknown one tend to report "server unreachable" instead of
      // showing the message, which hides the very thing the user needs to read.
      fail(req, reply, ERR.BAD_CREDENTIALS, `Too many failed attempts — try again in ${mins} min`);
      return null;
    }

    /**
     * Record the failure, send the error, hand back the null the caller returns.
     *
     * Every failing branch goes through here so a future one cannot quietly skip the
     * bookkeeping and reopen the hole.
     */
    const reject = (code: number, message: string): null => {
      store.recordFail(ip, username);
      fail(req, reply, code, message);
      return null;
    };

    /** Clear any recorded failures and hand back the authenticated user. */
    const accept = (user: User): User => {
      if (state.fails > 0) store.clearFails(ip, username);
      return user;
    };

    // --- token auth -------------------------------------------------------
    if (q.t && q.s) {
      const user = store.userByName(username);
      const secret = user?.stream_password ?? '';
      if (!user || !user.enabled) {
        return reject(ERR.BAD_CREDENTIALS, 'Wrong username or password');
      }
      if (!secret) {
        // Deliberately NOT counted as a failure. The credentials were never wrong — the
        // account simply has no streaming password yet — and counting it would lock
        // someone out for following the instructions this very message gives them.
        fail(
          req,
          reply,
          ERR.BAD_CREDENTIALS,
          'This client uses token authentication, which needs a streaming password. ' +
            'Set one in crate under Account, then use it here instead of your crate password.',
        );
        return null;
      }
      const expect = createHash('md5').update(secret + q.s).digest('hex');
      if (expect !== String(q.t).toLowerCase()) {
        return reject(ERR.BAD_CREDENTIALS, 'Wrong username or password');
      }
      return accept(user);
    }

    // --- password auth ----------------------------------------------------
    let password = String(q.p ?? '');
    if (!password) {
      fail(req, reply, ERR.MISSING_PARAM, 'Required parameter p or t is missing');
      return null;
    }
    // "enc:" is hex, not encryption. Subsonic's own naming, kept for compatibility.
    if (password.startsWith('enc:')) {
      try {
        password = Buffer.from(password.slice(4), 'hex').toString('utf8');
      } catch {
        return reject(ERR.BAD_CREDENTIALS, 'Wrong username or password');
      }
    }

    // The real crate password, against the real argon2id hash.
    const byAccount = await store.checkPassword(username, password);
    if (byAccount) return accept(byAccount);

    // Or the streaming password, so somebody who set one can use it everywhere rather
    // than remembering which client wants which.
    const user = store.userByName(username);
    if (user?.enabled && user.stream_password && user.stream_password === password) {
      return accept(user);
    }

    return reject(ERR.BAD_CREDENTIALS, 'Wrong username or password');
  }

  /**
   * Register a handler under both /rest/x and /rest/x.view.
   *
   * The .view suffix is a legacy of the original Subsonic servlet and clients still use
   * it, inconsistently. Registering both is one line and avoids a class of "works in one
   * app, not another" bug.
   */
  function rest(
    name: string,
    handler: (req: FastifyRequest, reply: FastifyReply, user: User) => Promise<void> | void,
  ): void {
    const wrapped = async (req: FastifyRequest, reply: FastifyReply) => {
      const user = await auth(req, reply);
      if (!user) return;
      await handler(req, reply, user);
    };
    app.get(`/rest/${name}`, wrapped);
    app.get(`/rest/${name}.view`, wrapped);
    // Some clients POST with the parameters in the query string regardless.
    app.post(`/rest/${name}`, wrapped);
    app.post(`/rest/${name}.view`, wrapped);
  }

  // ---- the caller's library, shaped for Subsonic -------------------------

  /** Albums the caller actually holds, derived from their tracks. */
  function albumsFor(user: User): {
    id: string;
    name: string;
    artist: string;
    songCount: number;
    duration: number;
  }[] {
    const mine = userlib.mine(user.id, 20_000);
    const byAlbum = new Map<
      string,
      { artist: string; album: string; songCount: number; duration: number }
    >();
    for (const t of mine) {
      /*
       * Keyed on the ALBUM ARTIST, not on who each track is credited to.
       *
       * With the credit, one guest feature split a record in two here: Sia's Reasonable
       * Woman became two albums on every phone client because one track is Kylie Minogue's.
       * The album page has always keyed on the album artist; this is the same key, so the
       * two surfaces finally agree.
       */
      const key = albumKey(t.albumArtistName, t.albumTitle);
      const g = byAlbum.get(key) ?? {
        artist: t.albumArtistName,
        album: t.albumTitle,
        songCount: 0,
        duration: 0,
      };
      g.songCount++;
      g.duration += t.durationS ?? 0;
      byAlbum.set(key, g);
    }
    return [...byAlbum.entries()].map(([key, g]) => ({
      id: `al-${enc(key)}`,
      name: g.album,
      artist: g.artist,
      songCount: g.songCount,
      duration: g.duration,
    }));
  }

  /**
   * One song. `artist` is the CREDIT, so a feature is visible, while every id that names an
   * album is built from the album artist — otherwise a client is told this track belongs to
   * an album that does not exist and its cover art 404s.
   */
  function songTag(t: {
    trackId: number;
    title: string;
    artistName: string;
    albumArtistName: string;
    albumTitle: string;
    trackNo: number | null;
    durationS: number | null;
    sizeBytes: number;
    path: string;
  }): Record<string, unknown> {
    const ext = extname(t.path).toLowerCase();
    return {
      id: `t-${t.trackId}`,
      parent: albumId(t.albumArtistName, t.albumTitle),
      title: t.title,
      album: t.albumTitle,
      artist: t.artistName,
      isDir: false,
      track: t.trackNo ?? undefined,
      duration: t.durationS ?? undefined,
      size: t.sizeBytes,
      suffix: ext.replace('.', ''),
      contentType: MIME[ext] ?? 'application/octet-stream',
      albumId: albumId(t.albumArtistName, t.albumTitle),
      artistId: `ar-${enc(t.artistName)}`,
      type: 'music',
      coverArt: albumId(t.albumArtistName, t.albumTitle),
    };
  }

  /**
   * A song that is not in the library yet, shaped so a client cannot tell the difference.
   *
   * m4a / audio/mp4 regardless of what the source serves, because that is what the stream
   * endpoint delivers for these (see the YouTube plugin: AAC chosen precisely so iOS's
   * AVPlayer can play it). No albumId or artistId: there is no album or artist page for a song
   * crate does not hold, and inventing one would give a client a link to a 404.
   */
  function externalSongTag(row: ExternalRow): Record<string, unknown> {
    return {
      id: row.id,
      title: row.title,
      album: row.album ?? '',
      artist: row.artist,
      isDir: false,
      duration: row.durationS ?? undefined,
      suffix: 'm4a',
      contentType: 'audio/mp4',
      type: 'music',
      coverArt: row.id,
    };
  }

  // ---- system -----------------------------------------------------------

  rest('ping', (req, reply) => send(req, reply, {}));

  rest('getLicense', (req, reply) =>
    send(req, reply, { license: { valid: true, email: 'self-hosted' } }),
  );

  rest('getOpenSubsonicExtensions', (req, reply) =>
    send(req, reply, { openSubsonicExtensions: [] }),
  );

  rest('getUser', (req, reply, user) =>
    send(req, reply, {
      user: {
        username: user.username,
        // Downloading and streaming yes; everything that changes the server, no. A music
        // client has no business creating users or altering settings.
        scrobblingEnabled: true,
        adminRole: false,
        settingsRole: false,
        downloadRole: true,
        streamRole: true,
        playlistRole: true,
        coverArtRole: true,
        shareRole: false,
        jukeboxRole: false,
      },
    }),
  );

  rest('getMusicFolders', (req, reply) =>
    send(req, reply, { musicFolders: { musicFolder: [{ id: 1, name: 'Music' }] } }),
  );

  // ---- browsing ---------------------------------------------------------

  rest('getArtists', (req, reply, user) => {
    const mine = userlib.mine(user.id, 20_000);
    /*
     * albumCount counts ALBUMS. It counted tracks, which is not a cosmetic slip: a
     * client filtering on "artists with one album" was really selecting artists with
     * one TRACK, which is exactly the compilation and guest-spot case — the one that
     * getArtist could not then open. Two bugs wearing each other's clothes.
     */
    const byArtist = new Map<string, Set<string>>();
    for (const t of mine) {
      const set = byArtist.get(t.artistName) ?? new Set<string>();
      set.add(albumKey(t.albumArtistName, t.albumTitle));
      byArtist.set(t.artistName, set);
    }

    // Subsonic groups artists under alphabetical indexes.
    const groups = new Map<string, { id: string; name: string; albumCount: number }[]>();
    for (const [name, albums] of byArtist) {
      const letter = (name[0] ?? '#').toUpperCase();
      const key = /[A-Z]/.test(letter) ? letter : '#';
      const list = groups.get(key) ?? [];
      list.push({ id: `ar-${enc(name)}`, name, albumCount: albums.size });
      groups.set(key, list);
    }
    send(req, reply, {
      artists: {
        ignoredArticles: 'The El La Los Las Le Les',
        index: [...groups.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, artist]) => ({ name, artist: artist.sort((x, y) => x.name.localeCompare(y.name)) })),
      },
    });
  });

  rest('getIndexes', (req, reply, user) => {
    // Same data as getArtists; older clients ask for this one.
    const mine = userlib.mine(user.id, 20_000);
    const byArtist = new Map<string, number>();
    for (const t of mine) byArtist.set(t.artistName, (byArtist.get(t.artistName) ?? 0) + 1);
    const groups = new Map<string, { id: string; name: string }[]>();
    for (const [name] of byArtist) {
      const letter = (name[0] ?? '#').toUpperCase();
      const key = /[A-Z]/.test(letter) ? letter : '#';
      const list = groups.get(key) ?? [];
      list.push({ id: `ar-${enc(name)}`, name });
      groups.set(key, list);
    }
    send(req, reply, {
      indexes: {
        lastModified: Date.now(),
        ignoredArticles: 'The El La Los Las Le Les',
        index: [...groups.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, artist]) => ({ name, artist })),
      },
    });
  });

  rest('getArtist', (req, reply, user) => {
    const id = String((req.query as Record<string, string>).id ?? '');
    if (!id.startsWith('ar-')) return fail(req, reply, ERR.NOT_FOUND, 'Artist not found');
    const artist = dec(id.slice(3));
    /*
     * Match the album artist OR the track credit.
     *
     * getArtists builds its index from artistName; albumsFor groups on
     * albumArtistName. Wherever those differ — a compilation, a guest spot — the
     * artist appeared in the index and then 404ed when opened, because the album they
     * appear on is filed under somebody else entirely.
     */
    const wanted = norm(artist);
    const albums = albumsFor(user).filter((a) => norm(a.artist) === wanted);
    const guested = albums.length
      ? []
      : [
          ...new Map(
            userlib
              .mine(user.id, 20_000)
              .filter((t) => norm(t.artistName) === wanted)
              .map((t) => [albumKey(t.albumArtistName, t.albumTitle), t] as const),
          ).values(),
        ].map((t) => ({
          id: albumId(t.albumArtistName, t.albumTitle),
          name: t.albumTitle,
          artist: t.albumArtistName,
          songCount: 0,
          duration: 0,
        }));
    const found = albums.length ? albums : guested;
    if (!found.length) return fail(req, reply, ERR.NOT_FOUND, 'Artist not found');
    send(req, reply, {
      artist: {
        id,
        name: artist,
        albumCount: found.length,
        album: found.map((a) => ({ ...a, artistId: id, coverArt: a.id })),
      },
    });
  });

  rest('getAlbum', (req, reply, user) => {
    const id = String((req.query as Record<string, string>).id ?? '');
    const parts = albumParts(id);
    if (!parts) return fail(req, reply, ERR.NOT_FOUND, 'Album not found');
    const [artist, album] = parts;
    /*
     * The id carries NORMALISED values, because albumKey normalises both halves so one
     * record cannot arrive under two ids. This filter compared them against the stored
     * originals, so an id crate had just handed out of getArtist came straight back as
     * "Album not found" — every album, every time, on the canonical album-to-tracks
     * path, leaving a client no option but to download the library and filter locally.
     *
     * It also matched artistName while the id is built from albumArtistName, which
     * would have broken compilations even with the case fixed.
     */
    const mine = userlib
      .mine(user.id, 20_000)
      .filter((t) => norm(t.albumArtistName) === artist && albumIdentity(t.albumTitle) === album);
    if (!mine.length) return fail(req, reply, ERR.NOT_FOUND, 'Album not found');
    // Display values come from the rows: "ill communication" is an identity, not a title.
    const first = mine[0]!;
    send(req, reply, {
      album: {
        id,
        name: first.albumTitle,
        artist: first.albumArtistName,
        artistId: `ar-${enc(first.albumArtistName)}`,
        coverArt: id,
        songCount: mine.length,
        duration: mine.reduce((n, t) => n + (t.durationS ?? 0), 0),
        song: mine.map(songTag),
      },
    });
  });

  rest('getAlbumList2', (req, reply, user) => {
    const q = req.query as Record<string, string>;
    const size = Math.min(Math.max(Number(q.size ?? 20) || 20, 1), 500);
    const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
    let albums = albumsFor(user);
    if ((q.type ?? '') === 'alphabeticalByArtist') {
      albums = albums.sort((a, b) => a.artist.localeCompare(b.artist));
    } else if ((q.type ?? '') === 'alphabeticalByName') {
      albums = albums.sort((a, b) => a.name.localeCompare(b.name));
    }
    send(req, reply, {
      albumList2: {
        album: albums.slice(offset, offset + size).map((a) => ({
          ...a,
          artistId: `ar-${enc(a.artist)}`,
          coverArt: a.id,
        })),
      },
    });
  });

  rest('search3', async (req, reply, user) => {
    const q = req.query as Record<string, string>;
    /*
     * Quotes and stars are query syntax, not search terms. Several clients sync the whole
     * library by searching for "" — two literal quote characters — which is not an empty string,
     * so it matched no song at all and, with an external source behind search3, went off to
     * YouTube as a search for a pair of quote marks. Stripped, it is what it means: everything.
     */
    const term = String(q.query ?? '').replace(/[*"]/g, '').trim().toLowerCase();
    const mine = userlib.mine(user.id, 20_000);
    const match = (s: string) => !term || s.toLowerCase().includes(term);

    /*
     * Songs match on more than the title.
     *
     * Searching an artist's name returned that artist and none of their songs, because
     * only t.title was consulted. Every other Subsonic server matches the artist and
     * album too, and clients are built expecting it — a search box that finds the
     * artist but not one track of theirs reads as an empty library.
     */
    const songs = mine.filter(
      (t) => match(t.title) || match(t.artistName) || match(t.albumArtistName) || match(t.albumTitle),
    );
    const albums = albumsFor(user).filter((a) => match(a.name) || match(a.artist));
    const artists = [...new Set(mine.map((t) => t.artistName))].filter(match);

    send(req, reply, {
      searchResult3: {
        artist: page(artists, q.artistOffset, q.artistCount, 20).map((name) => ({
          id: `ar-${enc(name)}`,
          name,
        })),
        album: page(albums, q.albumOffset, q.albumCount, 20).map((a) => ({
          ...a,
          artistId: `ar-${enc(a.artist)}`,
          coverArt: a.id,
        })),
        song: await songResults(),
      },
    });

    /*
     * When the library has no song for this search, look harder, and then look elsewhere.
     *
     * Only for a real search (a term — an empty query is how clients sync whole libraries, and
     * must never become a YouTube search per sync) and only on the first page (a client paging
     * past the end has already seen everything there is).
     *
     * Word by word first: "song 2 by blur" matches no single field, and a song you own must
     * never lose to somebody else's upload of it. Only when that also finds nothing does an
     * external source get asked — so "Hey Siri, play X" plays your copy when you have one and
     * still plays something when you do not.
     */
    async function songResults(): Promise<Record<string, unknown>[]> {
      const offset = Number(q.songOffset ?? 0) || 0;
      if (songs.length || !term || offset > 0) return page(songs, q.songOffset, q.songCount, 50).map(songTag);
      const byWords = matchWords(mine, term);
      if (byWords.length) return page(byWords, 0, q.songCount, 50).map(songTag);
      if (!deps.external.enabled()) return [];
      const hits = await deps.external.search(term, 5);
      return hits.map((r) => (r.trackId && userlib.has(user.id, r.trackId) ? songTag(userlib.byId(r.trackId)!) : externalSongTag(r)));
    }
  });

  rest('getSong', async (req, reply, user) => {
    const id = String((req.query as Record<string, string>).id ?? '');
    const t = trackFor(user, id);
    if (t) return send(req, reply, { song: songTag(t) });
    // An external song, or one somebody else kept — describe it either way.
    const r = id.startsWith('x-') ? await deps.external.resolve(id) : null;
    if (r?.kind === 'external') return send(req, reply, { song: externalSongTag(r.row) });
    const kept = r?.kind === 'track' ? userlib.byId(r.trackId) : null;
    if (kept) return send(req, reply, { song: songTag(kept) });
    return fail(req, reply, ERR.NOT_FOUND, 'Song not found');
  });

  /*
   * ---- browsing by genre, and by chance --------------------------------------
   *
   * Three endpoints a client cannot work around. Without getRandomSongs, "play
   * something" costs a full-library download before the client can pick one track;
   * without the genre pair, "play some jazz" cannot be attempted at all. All three are
   * answered from SQL rather than by reading the library into memory and filtering it
   * there — see genreCounts, byGenre and randomTracks in lib/userlib.ts.
   */

  rest('getRandomSongs', (req, reply, user) => {
    const q = req.query as Record<string, string>;
    // Subsonic documents a default of 10. The cap stops a malformed size turning one
    // request into a whole-library read.
    const size = Math.min(Math.max(Number(q.size ?? 10) || 10, 1), 500);
    const fromYear = Number(q.fromYear);
    const toYear = Number(q.toYear);
    const songs = userlib.randomTracks(user.id, size, {
      genre: q.genre,
      fromYear: Number.isFinite(fromYear) ? fromYear : undefined,
      toYear: Number.isFinite(toYear) ? toYear : undefined,
    });
    send(req, reply, { randomSongs: { song: songs.map(songTag) } });
  });

  rest('getGenres', (req, reply, user) => {
    send(req, reply, {
      genres: {
        genre: userlib.genreCounts(user.id).map((g) => ({
          // `value` becomes element text in XML and {"value": ...} in JSON, which is
          // what each serialisation expects. See toXml.
          value: g.genre,
          songCount: g.songCount,
          albumCount: g.albumCount,
        })),
      },
    });
  });

  rest('getSongsByGenre', (req, reply, user) => {
    const q = req.query as Record<string, string>;
    const genre = String(q.genre ?? '').trim();
    if (!genre) return fail(req, reply, ERR.MISSING_PARAM, 'Required parameter genre is missing');
    const count = Math.min(Math.max(Number(q.count ?? 10) || 10, 1), 500);
    const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
    send(req, reply, {
      songsByGenre: { song: userlib.byGenre(user.id, genre, count, offset).map(songTag) },
    });
  });

  // ---- playlists ----------------------------------------------------------
  //
  // The same per-user playlists the web app manages, read AND write, so a
  // playlist made on the phone and one made in the browser are the same thing.
  // Ownership is checked on every call: playlist ids are only meaningful
  // within the account that owns them, exactly like the library itself.

  /** The caller's playlist by Subsonic id ('pl-<n>'), or null. The auth check. */
  function playlistFor(user: User, id: string): Playlist | null {
    if (!id.startsWith('pl-')) return null;
    const n = Number(id.slice(3));
    if (!Number.isFinite(n)) return null;
    return userlib.playlist(user.id, n);
  }

  function playlistTag(user: User, pl: Playlist): Record<string, unknown> {
    // A dynamic playlist is never dealt just to be COUNTED — getPlaylists would deal
    // every recipe on every sync. Its advertised size is the recipe's limit (already in
    // pl.tracks) and its duration is unknowable until dealt.
    const tracks = pl.dynamic ? null : userlib.playlistTracks(pl.id);
    return {
      id: `pl-${pl.id}`,
      name: pl.name,
      comment: pl.description,
      owner: user.username,
      public: false,
      songCount: tracks ? tracks.length : pl.tracks,
      duration: tracks ? tracks.reduce((n, t) => n + (t.durationS ?? 0), 0) : 0,
      created: new Date().toISOString(),
      changed: new Date().toISOString(),
      // Clients only ask getCoverArt for an id the server advertised, so without this the
      // mosaic exists and no phone ever requests it.
      coverArt: `pl-${pl.id}`,
    };
  }

  /** One query parameter that the spec allows to repeat, as an array. */
  function many(q: Record<string, unknown>, key: string): string[] {
    const v = q[key];
    if (v === undefined) return [];
    return Array.isArray(v) ? v.map(String) : [String(v)];
  }

  rest('getPlaylists', (req, reply, user) => {
    send(req, reply, {
      playlists: {
        playlist: userlib.playlists(user.id).map((pl) => playlistTag(user, pl)),
      },
    });
  });

  rest('getPlaylist', (req, reply, user) => {
    const id = String((req.query as Record<string, string>).id ?? '');
    const pl = playlistFor(user, id);
    if (!pl) return fail(req, reply, ERR.NOT_FOUND, 'Playlist not found');
    send(req, reply, {
      playlist: {
        ...playlistTag(user, pl),
        entry: userlib.playlistContent(user.id, pl).map(songTag),
      },
    });
  });

  rest('createPlaylist', (req, reply, user) => {
    const q = req.query as Record<string, unknown>;
    const name = String(q.name ?? '').trim();
    if (!name) return fail(req, reply, ERR.MISSING_PARAM, 'name is required');
    const id = userlib.createPlaylist(user.id, name.slice(0, 100));
    for (const sid of many(q, 'songId')) {
      const t = trackFor(user, sid) ?? adoptKept(user, sid);
      if (t) userlib.addToPlaylist(id, t.trackId);
    }
    const pl = userlib.playlist(user.id, id);
    if (!pl) return fail(req, reply, ERR.NOT_FOUND, 'Playlist not found');
    send(req, reply, {
      playlist: { ...playlistTag(user, pl), entry: userlib.playlistTracks(id).map(songTag) },
    });
  });

  rest('updatePlaylist', (req, reply, user) => {
    const q = req.query as Record<string, unknown>;
    const pl = playlistFor(user, String(q.playlistId ?? ''));
    if (!pl) return fail(req, reply, ERR.NOT_FOUND, 'Playlist not found');

    const name = String(q.name ?? '').trim();
    if (name) userlib.renamePlaylist(user.id, pl.id, name.slice(0, 100));

    for (const sid of many(q, 'songIdToAdd')) {
      // Only songs the caller holds: the playlist references their library,
      // same rule as the web app.
      const t = trackFor(user, sid) ?? adoptKept(user, sid);
      if (t) userlib.addToPlaylist(pl.id, t.trackId);
    }

    // Removals are BY INDEX in the spec. Resolve indexes against the current
    // order first, then remove — removing as we go would shift every later
    // index and delete the wrong songs.
    const order = userlib.playlistTracks(pl.id);
    const doomed = many(q, 'songIndexToRemove')
      .map((i) => order[Number(i)])
      .filter((t): t is NonNullable<typeof t> => t !== undefined);
    for (const t of doomed) userlib.removeFromPlaylist(pl.id, t.trackId);

    send(req, reply, {});
  });

  rest('deletePlaylist', (req, reply, user) => {
    const pl = playlistFor(user, String((req.query as Record<string, string>).id ?? ''));
    if (!pl) return fail(req, reply, ERR.NOT_FOUND, 'Playlist not found');
    userlib.deletePlaylist(user.id, pl.id);
    send(req, reply, {});
  });

  rest('getStarred2', (req, reply) => send(req, reply, { starred2: {} }));
  rest('getStarred', (req, reply) => send(req, reply, { starred: {} }));

  /**
   * Scrobble. Recorded as a real play against the caller's own history, so a
   * song listened to in Amperfy counts exactly like one played in the web app —
   * it moves Most Played, feeds the listening profile and steers the
   * recommender. It used to only nudge the global seed table, which meant a
   * phone-first listener looked like someone who never played anything.
   *
   * Only a completed play counts. Subsonic clients send scrobble twice per
   * song: submission=false when it STARTS (a now-playing notice) and
   * submission=true when it finishes. Counting the first would count every
   * two-second skip as enthusiasm, and counting both would double everything.
   * An absent parameter means true, per the spec.
   *
   * Answering this is also what stops a client retrying it forever.
   */
  rest('scrobble', async (req, reply, user) => {
    const q = req.query as Record<string, string>;
    const id = String(q.id ?? '');
    const submission = String(q.submission ?? 'true').toLowerCase() !== 'false';
    // "This was played" is the most reliable listen signal there is, so it keeps an external
    // song at once for somebody who keeps by listening (the catalog checks that). Done first:
    // once kept, the song is theirs and counts like any other play.
    if (submission && id.startsWith('x-')) await deps.external.listened(user.id, id);
    const t = trackFor(user, id);
    if (t && submission) {
      store.noteSeed(t.artistName, 'listen');
      deps.userlib.notePlay(user.id, t.trackId);
      // The taste profile just moved, so the cached recommendation set is stale.
      deps.recommender.invalidate(user.id);
    }
    send(req, reply, {});
  });

  /**
   * Starring an external song keeps it.
   *
   * A phone client has no "download this" button for a song that is not in the library, but
   * every one of them has a heart or a star, and "I like this one" is exactly the request. For
   * library songs star is still a no-op. `id` may repeat, per the spec.
   */
  rest('star', async (req, reply, user) => {
    const raw = (req.query as Record<string, string | string[]>).id;
    const ids = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String).filter((i) => i.startsWith('x-'));
    for (const id of ids) await deps.external.keep(user.id, id);
    send(req, reply, {});
  });
  rest('unstar', (req, reply) => send(req, reply, {}));
  rest('setRating', (req, reply) => send(req, reply, {}));

  // ---- media ------------------------------------------------------------

  /**
   * A kept external song this person does not own yet, granted to them.
   *
   * For playlists: adding a song to a playlist is as deliberate a "keep" as there is, and a
   * playlist can only hold what its owner holds.
   */
  function adoptKept(user: User, id: string): ReturnType<typeof trackFor> {
    if (!id.startsWith('x-')) return null;
    const trackId = deps.external.trackIdFor(id);
    if (trackId === null) return null;
    userlib.add(user.id, trackId, 'external');
    return userlib.byId(trackId);
  }

  /** A track the caller actually holds, or null. This is the access check. */
  function trackFor(
    user: User,
    id: string,
  ): {
    trackId: number;
    title: string;
    artistName: string;
    albumArtistName: string;
    albumTitle: string;
    trackNo: number | null;
    durationS: number | null;
    sizeBytes: number;
    path: string;
  } | null {
    /*
     * A kept external song IS its library track: once someone has kept x-youtube-…, that id
     * resolves here exactly as its t- id does, so every endpoint below treats it identically
     * with no special case of its own. Clients cache ids, and this is what keeps the cached
     * one working.
     */
    const trackId = id.startsWith('t-') ? Number(id.slice(2)) : id.startsWith('x-') ? deps.external.trackIdFor(id) : null;
    if (trackId === null || !Number.isFinite(trackId)) return null;
    // The whole point: holding it is what grants access, not merely existing on disk.
    if (!userlib.has(user.id, trackId)) return null;
    return userlib.byId(trackId);
  }

  /**
   * Stream a file, honouring Range.
   *
   * Writes to reply.raw after reply.hijack() rather than reply.send(stream). Fastify's
   * payload path and a manually set Content-Length disagree: it logged "stream closed
   * prematurely" and delivered zero bytes with otherwise perfect headers — a 206 with a
   * correct Content-Range and an empty body, which is the most misleading possible
   * failure. Hijacking hands the socket over and takes Fastify out of the argument.
   *
   * Range support is not optional in practice: without it a client cannot seek, and some
   * refuse to play at all.
   */
  const streamHandler = async (req: FastifyRequest, reply: FastifyReply, user: User) => {
    const q = req.query as Record<string, string>;
    const id = String(q.id ?? '');
    // Signal 3 of the keep policy: an external stream still going in 30 seconds is kept, and
    // starting any other song — library ones included — is the skip that cancels it.
    deps.external.streamStarted(user.id, id);
    let t = trackFor(user, id);
    if (!t && id.startsWith('x-')) {
      const r = await deps.external.resolve(id);
      if (r?.kind === 'track') {
        // Somebody kept it already. Play the file; the timer above grants it to this person.
        t = userlib.byId(r.trackId);
      } else if (r?.kind === 'external') {
        return streamExternal(req, reply, deps.external, r.row, {
          ...(q.format ? { format: q.format } : {}),
          maxBitRate: Number(q.maxBitRate) || 0,
          timeOffsetS: Number(q.timeOffset) || 0,
        });
      }
    }
    if (!t) return fail(req, reply, ERR.NOT_FOUND, 'Song not found in your library');

    let size: number;
    try {
      size = (await stat(t.path)).size;
    } catch {
      return fail(req, reply, ERR.NOT_FOUND, 'The file is missing from disk');
    }

    const type = MIME[extname(t.path).toLowerCase()] ?? 'application/octet-stream';

    /*
     * Transcode only when the client actually asked for something it is not getting.
     *
     * plan() decides; everything below the branch is the original byte-for-byte path,
     * untouched. That split is deliberate — a client happy with the file as it stands
     * keeps its Range requests, its seeking and its exact bytes.
     */
    const p = plan({
      path: t.path,
      sizeBytes: size,
      durationS: t.durationS ?? null,
      format: q.format,
      maxBitRate: Number(q.maxBitRate) || 0,
      sourceMime: type,
    });

    if (p.transcode) {
      /*
       * A transcoded stream has no length until it exists, so there is nothing honest
       * to put in Content-Length and no way to answer a Range. Saying
       * Accept-Ranges: none and ignoring the header beats answering a seek with bytes
       * that are not where the client believes they are.
       *
       * Subsonic's own timeOffset covers seeking, and ffmpeg is handed it directly.
       */
      const offset = Number(q.timeOffset) || 0;
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': p.mime,
        'Accept-Ranges': 'none',
        'X-Crate-Transcode': p.reason,
      });

      const ff = spawnTranscode(t.path, p, { timeOffsetS: offset });
      ff.stdout.pipe(reply.raw);
      ff.on('error', () => reply.raw.destroy());

      /*
       * SIGKILL when the listener goes away — the part that would have hurt most in
       * production.
       *
       * Skipping a track closes the socket while ffmpeg carries on encoding into a
       * pipe nobody is reading. A handful of those pin a machine at 100% CPU with
       * nothing in the logs to explain it. SIGTERM is not enough, since ffmpeg may be
       * mid-write and ignore it, so this does not negotiate.
       */
      reply.raw.on('close', () => {
        if (ff.exitCode === null) ff.kill('SIGKILL');
      });
      return;
    }

    /*
     * A zero-byte file made end = size - 1 = -1, which createReadStream rejects. The
     * reply had already been hijacked, so the throw left the socket open with headers
     * sent and the client waiting forever — a hang rather than an error. Reachable
     * from a truncated import or a download that failed part-way.
     */
    if (size === 0) {
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Content-Length': '0',
      });
      reply.raw.end();
      return;
    }

    const m = String(req.headers.range ?? '').match(/^bytes=(\d*)-(\d*)$/);

    let start = 0;
    let end = size - 1;
    let code = 200;
    if (m) {
      start = m[1] ? Number(m[1]) : 0;
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        reply.hijack();
        reply.raw.writeHead(416, { 'Content-Range': `bytes */${size}` });
        reply.raw.end();
        return;
      }
      code = 206;
    }

    reply.hijack();
    reply.raw.writeHead(code, {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      ...(code === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });

    const file = createReadStream(t.path, { start, end });
    file.pipe(reply.raw);
    // A client that stops listening mid-track is normal, not an error; without this the
    // file handle would be held until the process noticed.
    file.on('error', () => reply.raw.destroy());
    reply.raw.on('close', () => file.destroy());
  };
  rest('stream', streamHandler);

  rest('download', async (req, reply, user) => {
    const id = String((req.query as Record<string, string>).id ?? '');
    const t = trackFor(user, id);
    if (!t) return fail(req, reply, ERR.NOT_FOUND, 'Song not found in your library');
    reply
      .header('Content-Disposition', `attachment; filename="${basename(t.path)}"`)
      .send(createReadStream(t.path));
  });

  /**
   * Cover art, through the local cache.
   *
   * The first version looked only for an image file beside the audio, which is why nothing
   * displayed: of eleven albums here exactly one has a usable cover file, while six carry
   * the art embedded in the audio itself. The cache tries local, then a cover file, then the
   * embedded picture, then Lidarr — and writes whatever it finds, so this is one filesystem
   * read from the second request onwards.
   */
  rest('getCoverArt', async (req, reply, user) => {
    const id = String((req.query as Record<string, string>).id ?? '');

    let artist = '';
    let album = '';
    if (id.startsWith('ar-')) {
      const art = await deps.artcache.artist(dec(id.slice(3)));
      if (!art) return fail(req, reply, ERR.NOT_FOUND, 'Cover art not found');
      reply.header('Content-Type', art.contentType).header('Cache-Control', 'max-age=86400');
      return reply.send(art.body);
    }

    // Playlist mosaics. playlistFor is the ownership check, so one user cannot fetch the
    // cover of another's playlist and read its albums off the tiles.
    if (id.startsWith('pl-')) {
      const pl = playlistFor(user, id);
      if (!pl) return fail(req, reply, ERR.NOT_FOUND, 'Cover art not found');
      const art = await deps.playlistart.get(pl.id);
      if (!art) return fail(req, reply, ERR.NOT_FOUND, 'Cover art not found');
      reply.header('Content-Type', art.contentType).header('Cache-Control', 'max-age=86400');
      return reply.send(art.body);
    }

    /*
     * An external song's own artwork, proxied: the client only ever sees crate's URL, so an
     * expiring or address-bound image link never ends up cached on somebody's phone.
     * Kept songs fall through to trackFor below and get their album's art like anything else.
     */
    if (id.startsWith('x-') && !trackFor(user, id)) {
      const r = await deps.external.resolve(id);
      const cover = r?.kind === 'external' ? r.row.coverUrl : null;
      const img = cover ? await getBytes(cover, { timeoutMs: 10_000 }).catch(() => null) : null;
      if (!img) return fail(req, reply, ERR.NOT_FOUND, 'Cover art not found');
      reply.header('Content-Type', img.contentType).header('Cache-Control', 'max-age=86400');
      return reply.send(img.body);
    }

    const parts = albumParts(id);
    if (parts) {
      [artist, album] = parts;
    } else {
      const t = trackFor(user, id);
      if (!t) return fail(req, reply, ERR.NOT_FOUND, 'Cover art not found');
      artist = t.artistName;
      album = t.albumTitle;
    }

    // Only files this user holds, so cover art cannot be used to confirm what is on the
    // server outside their own library.
    const paths = userlib
      .mine(user.id, 20_000)
      .filter((t) => t.artistName === artist && t.albumTitle === album)
      .map((t) => t.path);

    const art = await deps.artcache.album(artist, album, paths);
    if (!art) return fail(req, reply, ERR.NOT_FOUND, 'Cover art not found');
    reply.header('Content-Type', art.contentType).header('Cache-Control', 'max-age=86400');
    return reply.send(art.body);
  });
}
