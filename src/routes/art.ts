import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import type { ArtCache } from '../lib/artcache.js';

interface Deps {
  /** Read to decide whether waiting for a cold resolution is worth it. */
  mb: { depth: (lane: 'fg' | 'bg' | 'idle') => number };
  /**
   * Whether this caller is signed in.
   *
   * Passed in rather than reimplemented so there is one definition of "signed
   * in" in the app. Artwork is not sensitive, but leaving these two endpoints
   * open while every other route requires a session is the kind of inconsistency
   * that later gets mistaken for intent.
   */
  isAuthed: (req: FastifyRequest) => boolean;
  artcache: ArtCache;
  /** The album's files on disk, when crate holds it — the source of embedded artwork. */
  trackPaths?: (artist: string, album: string) => string[];
}

/**
 * Artwork endpoints.
 *
 * Both are keyed by name rather than by any id, because names are the one thing
 * every caller has: a Last.fm suggestion is a name and nothing else, and the
 * pool's albums are keyed by their tags. Each card asks for its own artwork, so
 * a page paints immediately and the images fill in; the cache means each lookup
 * happens once per subject ever rather than once per page load.
 *
 * This module used to also proxy Lidarr's /MediaCover paths. With Lidarr gone,
 * every image is either already on disk or resolved through lib/artsource.ts,
 * and there is no remote host that needs relaying.
 */
export function artRoutes(app: FastifyInstance, deps: Deps): void {
  /** Long cache: these images do not change, and re-fetching them is wasteful. */
  function cacheable(reply: FastifyReply): void {
    reply.header('Cache-Control', 'public, max-age=604800, immutable');
  }

  /**
   * How long a single artwork request may hold its connection.
   *
   * Short on purpose. A page renders dozens of tiles at once, and a browser
   * has a hard ceiling on concurrent requests per host — so the budget is not
   * "how long can we afford to wait", it is "how long before the tiles behind
   * this one start queueing". At five seconds, thirty cold tiles filled the
   * connection pool with doomed requests and the page hung; the access log
   * showed 137 requests each burning exactly the budget.
   *
   * 1.2 seconds still covers everything that can actually be answered: a
   * local cache read, and a Cover Art Archive fetch whose release-group was
   * resolved earlier. Anything needing a fresh rate-limited lookup cannot
   * make ANY budget, so it 404s at once — the resolution keeps running and
   * writes to the cache, and the client's retries pick it up.
   */
  const BUDGET_MS = 1_200;
  const SLOW = Symbol('slow');

  /**
   * With lookups already queued, a cold resolution has no chance inside the
   * budget: waiting only costs the browser a connection slot. Start the fill
   * and answer immediately instead.
   */
  const QUEUE_IS_DEEP = 2;
  const tooBusyToWait = (): boolean => deps.mb.depth('bg') > QUEUE_IS_DEEP;

  async function within<T>(work: Promise<T>, budgetMs = BUDGET_MS): Promise<T | typeof SLOW> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<typeof SLOW>((r) => {
          timer = setTimeout(() => r(SLOW), budgetMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  app.get('/api/art/artist', async (req: FastifyRequest, reply) => {
    if (!deps.isAuthed(req)) return reply.code(401).send({ error: 'sign in to continue' });
    const name = String((req.query as Record<string, string>).name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name is required' });

    // Errors count as "no art yet" — the promise keeps filling the cache.
    const work = deps.artcache.artist(name).catch(() => null);
    const art = tooBusyToWait() ? SLOW : await within(work);
    if (art === SLOW) return reply.code(404).send({ error: 'artwork is still being fetched' });
    if (!art) return reply.code(404).send({ error: 'no artwork found' });
    cacheable(reply);
    return reply.type(art.contentType).send(art.body);
  });

  /**
   * Album art for the SPA, through the same cache as everything else.
   *
   * Takes names rather than an id because the caller may be looking at an album crate does
   * not hold, where there is nothing to key on but what it is called.
   */
  app.get('/api/art/album', async (req: FastifyRequest, reply) => {
    if (!deps.isAuthed(req)) return reply.code(401).send({ error: 'sign in to continue' });
    const q = req.query as Record<string, string>;
    const artist = String(q.artist ?? '').trim();
    const album = String(q.album ?? '').trim();
    if (!artist || !album) return reply.code(400).send({ error: 'artist and album are required' });

    // A release-group id, when the caller has one, turns this into a direct
    // fetch rather than a queued search — so it is worth waiting for even when
    // the lookup queue is busy.
    const mbid = /^[0-9a-f-]{36}$/i.test(String(q.mbid ?? '')) ? String(q.mbid) : undefined;
    const paths = deps.trackPaths ? deps.trackPaths(artist, album) : [];
    const work = deps.artcache.album(artist, album, paths, mbid).catch(() => null);
    /*
     * Wait a little longer with an id than without, but nowhere near as long as
     * this used to.
     *
     * An id makes the fetch direct rather than queued, which justified waiting
     * for it — but the budget was set to eight seconds without measuring what a
     * cover actually costs. Cover Art Archive redirects to archive.org and then
     * to a storage node, and a cold cover measured 1.5 to 3.4 seconds. An
     * artist page asks for one per album AT ONCE, so a thirteen-album artist
     * held thirteen connections for seconds each and the page sat there — the
     * "five or more seconds" on first click, growing with the discography.
     *
     * Two seconds catches the quick ones inline. Anything slower 404s
     * immediately, keeps resolving in the background, and the client's retry
     * ladder collects it four seconds later — which is what that ladder is for.
     */
    const art = mbid || !tooBusyToWait() ? await within(work, mbid ? 2_000 : undefined) : SLOW;
    if (art === SLOW) return reply.code(404).send({ error: 'artwork is still being fetched' });
    if (!art) return reply.code(404).send({ error: 'no artwork found' });
    cacheable(reply);
    return reply.type(art.contentType).send(art.body);
  });
}
