/**
 * Playback for the web player: streaming, play counts and playlists.
 *
 * Separate from the Subsonic surface because the authentication differs — this is the crate
 * session cookie, that is Subsonic's query-string credentials — but the range-handling and
 * the ownership check are the same, so `streamTrack` is shared rather than written twice.
 *
 * Ownership is the access check throughout. A track existing on disk does not entitle anybody
 * to stream it; being in their library does.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Recommender } from '../lib/recommend.js';
import type { Lyrics } from '../lib/lyrics.js';
import type { UserLibrary } from '../lib/userlib.js';
import type { Algo } from '../lib/algo.js';
import type { OpenAi } from '../lib/openai.js';
import type { SongCharacteristics } from '../lib/songcharacteristics.js';
import { parseRules } from '../lib/dynamicpl.js';
import { MAX_ART_BYTES, type PlaylistArt } from '../lib/playlistart.js';

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
 * Send a file with Range support, taking the socket over from Fastify.
 *
 * reply.hijack() rather than reply.send(stream): Fastify's payload path and a manually set
 * Content-Length disagree, and the symptom is a 206 with a correct Content-Range and an empty
 * body — headers that look perfect while nothing plays. Found the hard way on the Subsonic
 * endpoint, so both callers now use this.
 */
export async function streamTrack(
  req: FastifyRequest,
  reply: FastifyReply,
  path: string,
): Promise<void> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    reply.code(404).send({ error: 'the file is missing from disk' });
    return;
  }

  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
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
    // Seeking re-requests ranges constantly; letting the browser keep them matters.
    'Cache-Control': 'private, max-age=3600',
    ...(code === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });

  const file = createReadStream(path, { start, end });
  file.pipe(reply.raw);
  // Abandoning a track mid-play is normal, not an error. Without this the handle would be
  // held until the process noticed.
  file.on('error', () => reply.raw.destroy());
  reply.raw.on('close', () => file.destroy());
}

interface PlayDeps {
  userlib: UserLibrary;
  algo: Algo;
  recommender: Recommender;
  lyrics: Lyrics;
  playlistart: PlaylistArt;
  openai: OpenAi;
  songchars: SongCharacteristics;
  need: (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => { id: number | null; user: string } | null;
}

export function playRoutes(app: FastifyInstance, deps: PlayDeps): void {
  const { userlib, algo, recommender, lyrics, playlistart, openai, songchars, need } = deps;

  /**
   * Lyrics for one track, synced when LRCLIB has them synced.
   *
   * Served from the same cache the download-time prefetch fills; anything not
   * cached — files that predate crate — is looked up live and cached, so the
   * panel works for the whole library, not just what crate imported. The
   * client parses the LRC timestamps; the server just hands over the words.
   */
  app.get('/api/track/:trackId/lyrics', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const trackId = Number((req.params as { trackId: string }).trackId);
    const t = userlib.byId(trackId);
    if (!t) return reply.code(404).send({ error: 'no such track' });

    const found = await lyrics.forTrack(t.artistName, t.title, t.albumTitle, t.durationS ?? 0);
    if (!found) return { synced: false, text: null };
    return { synced: found.synced, text: found.text };
  });

  /** Audio for the in-page player. Ownership, not existence, grants access. */
  app.get('/api/stream/:trackId', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no library' });

    const trackId = Number((req.params as { trackId: string }).trackId);
    if (!userlib.has(c.id, trackId)) {
      return reply.code(404).send({ error: 'not in your library' });
    }
    const t = userlib.byId(trackId);
    if (!t) return reply.code(404).send({ error: 'no such track' });
    return streamTrack(req, reply, t.path);
  });

  /**
   * Record a completed play.
   *
   * The client calls this once a track has run for thirty seconds or half its length,
   * whichever comes first — the Last.fm rule. Counting at play() would make skipping through
   * a queue look like enthusiasm, and every recommendation is built on this number.
   */
  app.post('/api/plays', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no history' });
    const b = (req.body ?? {}) as { trackId?: number; skipped?: boolean };
    const trackId = Number(b.trackId);
    if (!userlib.has(c.id, trackId)) return reply.code(404).send({ error: 'not in your library' });

    if (b.skipped === true) userlib.noteSkip(c.id, trackId);
    else userlib.notePlay(c.id, trackId);
    // The taste profile just moved, so the cached recommendation set is stale.
    recommender.invalidate(c.id);
    return { ok: true };
  });

  // ---- queues -------------------------------------------------------------

  /**
   * A ready-to-play queue.
   *
   * Assembled server-side because the ordering rules differ per kind — an album plays in track
   * order, an artist in album-then-track order, a playlist in its own order — and the client
   * should not have to know any of that.
   */
  /** Rate a library song 1..5, or 0 to clear the rating. */
  app.post('/api/tracks/:trackId/rating', async (req, reply) => {
    const c = need(req, reply);
    if (!c || !c.id) return;
    const trackId = Number((req.params as { trackId: string }).trackId);
    const raw = Number((req.body as { rating?: number } | undefined)?.rating);
    const rating = Number.isFinite(raw) ? Math.max(0, Math.min(5, Math.round(raw))) : NaN;
    if (Number.isNaN(rating)) return reply.code(400).send({ error: 'rating 0–5 required' });
    if (!userlib.setRating(c.id, trackId, rating)) {
      return reply.code(404).send({ error: 'not in your library' });
    }
    return { ok: true, rating };
  });

  /** The caller's rating of one song — what the play bar shows. */
  app.get('/api/tracks/:trackId/rating', async (req, reply) => {
    const c = need(req, reply);
    if (!c || !c.id) return;
    const trackId = Number((req.params as { trackId: string }).trackId);
    const rating = userlib.rating(c.id, trackId);
    if (rating === null) return reply.code(404).send({ error: 'not in your library' });
    return { rating };
  });

  app.get('/api/queue', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return { tracks: [] };
    const q = req.query as Record<string, string>;
    const kind = String(q.kind ?? 'library');

    switch (kind) {
      case 'library': {
        // A search term narrows it; without one this is the whole library.
        // Either way it is every match, not the page the client happens to be
        // showing — a page is a scrolling convenience, not a selection. The
        // sort rides along so "play all" means all IN THE ORDER ON SCREEN.
        const term = String(q.q ?? '').trim();
        const sort = ['alpha', 'plays', 'added', 'fav', 'algo', 'shuffle'].includes(
          String(q.sort ?? ''),
        )
          ? String(q.sort)
          : undefined;
        return {
          tracks: userlib.songsPage(c.id, {
            q: term || undefined,
            sort,
            algoProfile: sort === 'algo' ? algo.activeProfile(c.id) : undefined,
            // The seed matters here for the same reason it does on the listing: the queue has
            // to be the deal the person is looking at, not another one.
            seed: Number(q.seed) || 0,
            limit: term ? 500 : 5000,
          }).tracks,
        };
      }
      case 'artist':
        return { tracks: userlib.byArtist(c.id, String(q.artist ?? '')) };
      case 'album':
        return { tracks: userlib.byAlbum(c.id, String(q.artist ?? ''), String(q.album ?? '')) };
      case 'playlist': {
        const pl = userlib.playlist(c.id, Number(q.id));
        if (!pl) return reply.code(404).send({ error: 'no such playlist' });
        // playlistContent, not playlistTracks: a dynamic playlist deals fresh here too.
        return { tracks: userlib.playlistContent(c.id, pl), name: pl.name };
      }
      case 'mostplayed':
        return { tracks: userlib.mostPlayed(c.id, 100) };
      case 'newest':
        return { tracks: userlib.newest(c.id, 100) };
      default:
        return reply.code(400).send({ error: 'unknown queue kind' });
    }
  });

  /**
   * Everything known about one track, for the info panel.
   *
   * Read from the file rather than remembered from the import, because the file is the only
   * thing that cannot be out of date — and it is where somebody looking at an info screen
   * expects the numbers to come from. One parse per open is fine; nothing else reads this.
   */
  app.get('/api/track/:trackId/info', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const trackId = Number((req.params as { trackId: string }).trackId);
    const t = userlib.byId(trackId);
    if (!t) return reply.code(404).send({ error: 'no such track' });

    const { parseFile } = await import('music-metadata');
    let meta;
    try {
      meta = await parseFile(t.path, { duration: true });
    } catch {
      // A file crate cannot parse still has a row and a size, so report what is known
      // rather than failing the whole panel.
      return {
        trackId,
        title: t.title,
        artistName: t.artistName,
        albumTitle: t.albumTitle,
        sizeBytes: t.sizeBytes,
        durationS: t.durationS,
        /*
         * The list fields have to be PRESENT even here, empty. They were omitted, and the info
         * panel calls .join() on genres and composer unconditionally — so an unparseable file
         * crashed the whole modal rather than showing the reduced view this branch exists to
         * provide. Found while adding moods below; the same shape, always, is the fix.
         */
        genres: [],
        composer: [],
        // Characteristics are crate's own data, not the file's, so a file crate cannot parse
        // still has them — exactly the case where they are the only description available.
        characteristics: songchars.profileOf(trackId),
        characteristicState: songchars.statusOf(trackId).state,
        unreadable: true,
      };
    }

    const { common, format } = meta;
    const plays = c.id ? (userlib.playsOf(c.id, [trackId]).get(trackId) ?? 0) : 0;
    const analysis = userlib.analysisOf(trackId);
    return {
      trackId,
      bpm: analysis.bpm,
      energy: analysis.energy,
      title: common.title ?? t.title,
      artistName: common.artist ?? t.artistName,
      albumArtist: common.albumartist ?? null,
      albumTitle: common.album ?? t.albumTitle,
      year: common.year ?? null,
      genres: common.genre ?? [],
      trackNo: common.track?.no ?? t.trackNo,
      trackOf: common.track?.of ?? null,
      discNo: common.disk?.no ?? null,
      composer: common.composer ?? [],
      // Codec details are the half of an info panel that a tag editor cannot tell you.
      codec: format.codec ?? null,
      container: format.container ?? null,
      lossless: format.lossless ?? null,
      bitrateKbps: format.bitrate ? Math.round(format.bitrate / 1000) : null,
      sampleRate: format.sampleRate ?? null,
      bitsPerSample: format.bitsPerSample ?? null,
      channels: format.numberOfChannels ?? null,
      durationS: format.duration ? Math.round(format.duration) : t.durationS,
      sizeBytes: t.sizeBytes,
      path: t.path,
      hasLyrics: Boolean(common.lyrics && JSON.stringify(common.lyrics).length > 8),
      musicbrainzAlbumId: (common.musicbrainz_releasegroupid as string | undefined) ?? null,
      inLibrary: c.id ? userlib.has(c.id, trackId) : false,
      plays,
      /*
       * Song characteristics, merged across AI and manual sources. Part of the track's domain
       * representation rather than a separate fetch, so anything already showing track detail
       * gets the profile for free — and so a client can filter, sort or compare without a
       * second call.
       */
      characteristics: songchars.profileOf(trackId),
      characteristicState: songchars.statusOf(trackId).state,
      unreadable: false,
    };
  });

  // ---- library pages ------------------------------------------------------

  /**
   * Paginated, sortable views of one library.
   *
   * Three endpoints rather than one with a `kind` parameter, because the three shapes are
   * genuinely different — a song row, an artist with counts, an album with counts — and
   * collapsing them would mean a union type the client has to narrow on every use.
   */
  app.get('/api/library/songs', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return { tracks: [], total: 0 };
    const q = req.query as Record<string, string>;
    const per = Math.min(Math.max(Number(q.per ?? 60) || 60, 1), 200);
    const page = Math.max(Number(q.page ?? 0) || 0, 0);
    const r = userlib.songsPage(c.id, {
      q: q.q,
      sort: q.sort,
      algoProfile: q.sort === 'algo' ? algo.activeProfile(c.id) : undefined,
      // Coerced to a number here and again where it is used: it reaches SQL as a literal,
      // so it must never be able to arrive as anything but digits.
      seed: Number(q.seed) || 0,
      offset: page * per,
      limit: per,
    });
    return { ...r, page, per };
  });

  app.get('/api/library/artists', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return { artists: [], total: 0 };
    const q = req.query as Record<string, string>;
    const per = Math.min(Math.max(Number(q.per ?? 48) || 48, 1), 200);
    const page = Math.max(Number(q.page ?? 0) || 0, 0);
    const r = userlib.artistsPage(c.id, { sort: q.sort, offset: page * per, limit: per });
    return { ...r, page, per };
  });

  app.get('/api/library/albums', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return { albums: [], total: 0 };
    const q = req.query as Record<string, string>;
    const per = Math.min(Math.max(Number(q.per ?? 48) || 48, 1), 200);
    const page = Math.max(Number(q.page ?? 0) || 0, 0);
    const r = userlib.albumsPage(c.id, { sort: q.sort, offset: page * per, limit: per });
    return { ...r, page, per };
  });

  // ---- playlists ----------------------------------------------------------

  app.get('/api/playlists', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return { playlists: [] };
    return { playlists: userlib.playlists(c.id) };
  });

  app.post('/api/playlists', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no playlists' });
    const body = (req.body ?? {}) as { name?: string; rules?: unknown };
    const name = String(body.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'a name is required' });
    // Optional dynamic recipe. Validated by round-tripping through the parser, so a
    // malformed one is rejected here rather than making a playlist that deals nothing.
    let rules: string | null = null;
    if (body.rules != null) {
      const parsed = parseRules(JSON.stringify(body.rules));
      if (!parsed || parsed.terms.length === 0) {
        return reply.code(400).send({ error: 'rules must carry at least one valid term' });
      }
      rules = JSON.stringify(parsed);
    }
    const id = userlib.createPlaylist(c.id, name.slice(0, 120), rules);
    return { ok: true, id, playlists: userlib.playlists(c.id) };
  });

  /**
   * A playlist from a sentence: the prompt plus the caller's whole catalog go to the model,
   * ids come back, and the playlist is created here — one click, no curation UI.
   *
   * Every returned id is checked against the caller's own library before it is used. The
   * model only ever SAW that library, but "only pick from the list" is a request, not a
   * guarantee, and an invented id must not put someone else's track in a playlist.
   */
  app.post('/api/playlists/ai', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no playlists' });
    if (!openai.enabled()) {
      return reply.code(503).send({ error: 'no OpenAI key configured (Admin → Settings)' });
    }
    const b = (req.body ?? {}) as { prompt?: unknown; name?: unknown; description?: unknown };
    const prompt = String(b.prompt ?? '').trim();
    if (prompt.length < 4) return reply.code(400).send({ error: 'describe the playlist you want' });
    if (prompt.length > 500) return reply.code(400).send({ error: 'keep the request under 500 characters' });
    // A name or description typed into the form outranks whatever the model invents — the
    // person asked for "Sheety" and "Sheety" is what they get, verbatim.
    const givenName = String(b.name ?? '').trim();
    const givenDesc = String(b.description ?? '').trim();

    const catalog = userlib.aiCatalog(c.id);
    if (!catalog.length) return reply.code(400).send({ error: 'your library is empty' });

    const lines = catalog.map(
      (t) =>
        `${t.id}\t${t.artist} — ${t.title} (${t.album}${t.year ? `, ${t.year}` : ''})${t.genres ? ` [${t.genres}]` : ''}`,
    );
    const built = await openai.buildPlaylist(prompt, lines);
    if (!built) {
      return reply.code(502).send({ error: 'the model returned nothing usable — try rewording' });
    }

    const owned = new Set(catalog.map((t) => t.id));
    const picks = [...new Set(built.trackIds)].filter((id) => owned.has(id)).slice(0, 100);
    if (!picks.length) {
      return reply.code(502).send({ error: 'the model picked nothing from your library — try rewording' });
    }

    const name = (givenName || built.name || prompt).slice(0, 120);
    const description = (givenDesc || built.description).slice(0, 300);
    const id = userlib.createPlaylist(c.id, name);
    if (description) userlib.setPlaylistDescription(id, description);
    for (const trackId of picks) userlib.addToPlaylist(id, trackId);
    return { ok: true, id, name, added: picks.length };
  });

  app.get('/api/playlists/:id', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(404).send({ error: 'no such playlist' });
    const pl = userlib.playlist(c.id, Number((req.params as { id: string }).id));
    if (!pl) return reply.code(404).send({ error: 'no such playlist' });
    return { playlist: pl, tracks: userlib.playlistContent(c.id, pl) };
  });

  app.post('/api/playlists/:id/tracks', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(404).send({ error: 'no such playlist' });
    const pl = userlib.playlist(c.id, Number((req.params as { id: string }).id));
    if (!pl) return reply.code(404).send({ error: 'no such playlist' });
    // A dynamic playlist's content is its recipe; hand-adding rows to it would create a
    // second truth the next deal silently discards.
    if (pl.dynamic) return reply.code(400).send({ error: 'a dynamic playlist deals its own tracks' });

    const b = (req.body ?? {}) as { trackIds?: number[]; trackId?: number };
    const ids = b.trackIds ?? (b.trackId === undefined ? [] : [b.trackId]);
    // A playlist may only hold what the owner has; otherwise removing a track from a library
    // would leave playlists quietly pointing at music that is not theirs.
    const added = ids.map(Number).filter((id) => userlib.has(c.id as number, id));
    for (const id of added) userlib.addToPlaylist(pl.id, id);
    return { ok: true, added: added.length, tracks: userlib.playlistTracks(pl.id) };
  });

  app.delete('/api/playlists/:id/tracks/:trackId', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(404).send({ error: 'no such playlist' });
    const p = req.params as { id: string; trackId: string };
    const pl = userlib.playlist(c.id, Number(p.id));
    if (!pl) return reply.code(404).send({ error: 'no such playlist' });
    userlib.removeFromPlaylist(pl.id, Number(p.trackId));
    return { ok: true, tracks: userlib.playlistTracks(pl.id) };
  });

  app.put('/api/playlists/:id', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(404).send({ error: 'no such playlist' });
    const pl = userlib.playlist(c.id, Number((req.params as { id: string }).id));
    if (!pl) return reply.code(404).send({ error: 'no such playlist' });
    const b = (req.body ?? {}) as {
      name?: string;
      order?: number[];
      description?: string;
      rules?: unknown;
    };
    if (b.name) userlib.renamePlaylist(c.id, pl.id, String(b.name).trim().slice(0, 120));
    if (b.description !== undefined) {
      userlib.setPlaylistDescription(pl.id, String(b.description).trim().slice(0, 600));
    }
    if (Array.isArray(b.order)) userlib.reorderPlaylist(pl.id, b.order.map(Number));
    /*
     * Editing the recipe. Validated the same way creation is, so a malformed one is
     * rejected rather than turning a working playlist into one that deals nothing.
     * Only a playlist that is ALREADY dynamic can have its recipe changed: converting a
     * hand-filled playlist would silently orphan its rows.
     */
    if (b.rules !== undefined) {
      if (!pl.dynamic) {
        return reply.code(400).send({ error: 'this playlist holds songs, not a recipe' });
      }
      const parsed = parseRules(JSON.stringify(b.rules));
      if (!parsed || parsed.terms.length === 0) {
        return reply.code(400).send({ error: 'a recipe needs at least one term' });
      }
      userlib.setPlaylistRules(pl.id, JSON.stringify(parsed));
    }
    return { ok: true, playlist: userlib.playlist(c.id, pl.id), playlists: userlib.playlists(c.id) };
  });

  // ---- playlist artwork ---------------------------------------------------

  /**
   * The playlist's cover. Ownership-checked like everything else here, because the mosaic is
   * assembled from the sleeves of what is IN the playlist and so leaks its contents.
   *
   * Cached hard and versioned by the caller's ?v= — every change that can alter the picture
   * bumps the playlist's updated_at, so a stale cover is impossible and a fresh request per
   * page load is unnecessary.
   */
  app.get('/api/playlists/:id/art', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(404).send({ error: 'no such playlist' });
    const pl = userlib.playlist(c.id, Number((req.params as { id: string }).id));
    if (!pl) return reply.code(404).send({ error: 'no such playlist' });

    const art = await playlistart.get(pl.id);
    if (!art) return reply.code(404).send({ error: 'no art' });
    return reply
      .header('Content-Type', art.contentType)
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('X-Art-Source', art.source)
      .send(art.body);
  });

  app.post('/api/playlists/:id/art', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(404).send({ error: 'no such playlist' });
    const pl = userlib.playlist(c.id, Number((req.params as { id: string }).id));
    if (!pl) return reply.code(404).send({ error: 'no such playlist' });

    const part = await req.file({ limits: { fileSize: MAX_ART_BYTES } });
    if (!part) return reply.code(400).send({ error: 'no image attached' });
    let body: Buffer;
    try {
      body = await part.toBuffer();
    } catch {
      // multipart throws rather than truncating once the limit is passed.
      return reply.code(413).send({ error: `images must be under ${MAX_ART_BYTES / 1024 / 1024} MB` });
    }
    try {
      await playlistart.setCustom(pl.id, body);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'could not read that image' });
    }
    return { ok: true, playlist: userlib.playlist(c.id, pl.id) };
  });

  /** Remove the upload, which means going back to a freshly rolled mosaic. */
  app.delete('/api/playlists/:id/art', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(404).send({ error: 'no such playlist' });
    const pl = userlib.playlist(c.id, Number((req.params as { id: string }).id));
    if (!pl) return reply.code(404).send({ error: 'no such playlist' });
    await playlistart.clearCustom(pl.id);
    return { ok: true, playlist: userlib.playlist(c.id, pl.id) };
  });

  app.delete('/api/playlists/:id', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(404).send({ error: 'no such playlist' });
    const pl = userlib.playlist(c.id, Number((req.params as { id: string }).id));
    if (!pl) return reply.code(404).send({ error: 'no such playlist' });
    userlib.deletePlaylist(c.id, pl.id);
    return { ok: true, playlists: userlib.playlists(c.id) };
  });
}
