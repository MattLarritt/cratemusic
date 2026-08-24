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

const API_VERSION = '1.16.1';
const SERVER = 'crate';

interface SubsonicDeps {
  store: Store;
  userlib: UserLibrary;
  recommender: Recommender;
  artcache: ArtCache;
  playlistart: PlaylistArt;
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

  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) children.push(toXml(k, item));
    } else if (typeof v === 'object') {
      children.push(toXml(k, v));
    } else {
      attrs.push(`${k}="${xmlEscape(String(v))}"`);
    }
  }
  const open = `<${name}${attrs.length ? ' ' + attrs.join(' ') : ''}`;
  return children.length ? `${open}>${children.join('')}</${name}>` : `${open}/>`;
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
      serverVersion: '0.1',
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
      serverVersion: '0.1',
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

    // --- token auth -------------------------------------------------------
    if (q.t && q.s) {
      const user = store.userByName(username);
      const secret = user?.stream_password ?? '';
      if (!user || !user.enabled) {
        fail(req, reply, ERR.BAD_CREDENTIALS, 'Wrong username or password');
        return null;
      }
      if (!secret) {
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
        fail(req, reply, ERR.BAD_CREDENTIALS, 'Wrong username or password');
        return null;
      }
      return user;
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
        fail(req, reply, ERR.BAD_CREDENTIALS, 'Wrong username or password');
        return null;
      }
    }

    // The real crate password, against the real argon2id hash.
    const byAccount = await store.checkPassword(username, password);
    if (byAccount) return byAccount;

    // Or the streaming password, so somebody who set one can use it everywhere rather
    // than remembering which client wants which.
    const user = store.userByName(username);
    if (user?.enabled && user.stream_password && user.stream_password === password) return user;

    fail(req, reply, ERR.BAD_CREDENTIALS, 'Wrong username or password');
    return null;
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
    const byArtist = new Map<string, number>();
    for (const t of mine) byArtist.set(t.artistName, (byArtist.get(t.artistName) ?? 0) + 1);

    // Subsonic groups artists under alphabetical indexes.
    const groups = new Map<string, { id: string; name: string; albumCount: number }[]>();
    for (const [name, n] of byArtist) {
      const letter = (name[0] ?? '#').toUpperCase();
      const key = /[A-Z]/.test(letter) ? letter : '#';
      const list = groups.get(key) ?? [];
      list.push({ id: `ar-${enc(name)}`, name, albumCount: n });
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
    const albums = albumsFor(user).filter((a) => a.artist === artist);
    if (!albums.length) return fail(req, reply, ERR.NOT_FOUND, 'Artist not found');
    send(req, reply, {
      artist: {
        id,
        name: artist,
        albumCount: albums.length,
        album: albums.map((a) => ({ ...a, artistId: id, coverArt: a.id })),
      },
    });
  });

  rest('getAlbum', (req, reply, user) => {
    const id = String((req.query as Record<string, string>).id ?? '');
    const parts = albumParts(id);
    if (!parts) return fail(req, reply, ERR.NOT_FOUND, 'Album not found');
    const [artist, album] = parts;
    const mine = userlib
      .mine(user.id, 20_000)
      .filter((t) => t.artistName === artist && t.albumTitle === album);
    if (!mine.length) return fail(req, reply, ERR.NOT_FOUND, 'Album not found');
    send(req, reply, {
      album: {
        id,
        name: album,
        artist,
        artistId: `ar-${enc(artist)}`,
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

  rest('search3', (req, reply, user) => {
    const q = req.query as Record<string, string>;
    const term = String(q.query ?? '').replace(/\*/g, '').trim().toLowerCase();
    const mine = userlib.mine(user.id, 20_000);
    const match = (s: string) => !term || s.toLowerCase().includes(term);

    const songs = mine.filter((t) => match(t.title));
    const albums = albumsFor(user).filter((a) => match(a.name));
    const artists = [...new Set(mine.map((t) => t.artistName))].filter(match);

    send(req, reply, {
      searchResult3: {
        artist: artists.slice(0, Number(q.artistCount ?? 20)).map((name) => ({
          id: `ar-${enc(name)}`,
          name,
        })),
        album: albums.slice(0, Number(q.albumCount ?? 20)).map((a) => ({
          ...a,
          artistId: `ar-${enc(a.artist)}`,
          coverArt: a.id,
        })),
        song: songs.slice(0, Number(q.songCount ?? 50)).map(songTag),
      },
    });
  });

  rest('getSong', (req, reply, user) => {
    const id = String((req.query as Record<string, string>).id ?? '');
    const t = trackFor(user, id);
    if (!t) return fail(req, reply, ERR.NOT_FOUND, 'Song not found');
    send(req, reply, { song: songTag(t) });
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
      const t = trackFor(user, sid);
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
      const t = trackFor(user, sid);
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
  rest('scrobble', (req, reply, user) => {
    const q = req.query as Record<string, string>;
    const id = String(q.id ?? '');
    const submission = String(q.submission ?? 'true').toLowerCase() !== 'false';
    const t = trackFor(user, id);
    if (t && submission) {
      store.noteSeed(t.artistName, 'listen');
      deps.userlib.notePlay(user.id, t.trackId);
      // The taste profile just moved, so the cached recommendation set is stale.
      deps.recommender.invalidate(user.id);
    }
    send(req, reply, {});
  });

  rest('star', (req, reply) => send(req, reply, {}));
  rest('unstar', (req, reply) => send(req, reply, {}));
  rest('setRating', (req, reply) => send(req, reply, {}));

  // ---- media ------------------------------------------------------------

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
    if (!id.startsWith('t-')) return null;
    const trackId = Number(id.slice(2));
    if (!Number.isFinite(trackId)) return null;
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
    const id = String((req.query as Record<string, string>).id ?? '');
    const t = trackFor(user, id);
    if (!t) return fail(req, reply, ERR.NOT_FOUND, 'Song not found in your library');

    let size: number;
    try {
      size = (await stat(t.path)).size;
    } catch {
      return fail(req, reply, ERR.NOT_FOUND, 'The file is missing from disk');
    }

    const type = MIME[extname(t.path).toLowerCase()] ?? 'application/octet-stream';
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
