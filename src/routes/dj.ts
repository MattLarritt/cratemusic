import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Dj, DjError, type VoteDirection } from '../lib/dj.js';

/**
 * The DJ's HTTP surface. Thin on purpose: parse and clamp, then hand to lib/dj.ts — the
 * engine holds every rule and every tuned number, these handlers hold none.
 *
 * THE PATHS ARE A CONTRACT. /api/ishuffle/* is what the plugin registered before the DJ went
 * native, and crate-ios (CrateKit) calls these exact paths with these exact response shapes —
 * VoteResponse there requires applied.artist/album/genres to exist. Renaming anything here
 * breaks a client that cannot be hot-fixed, for zero gain. Same for the caller rules: every
 * route is session-guarded and rejects token callers, because the DJ is per-user by design.
 */

interface DjDeps {
  dj: Dj;
  need: (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => { id: number | null; user: string } | null;
}

/** DjError carries an HTTP status; anything else is a real bug and stays a 500. */
const rethrow = (reply: FastifyReply, err: unknown) => {
  if (err instanceof DjError) return reply.code(err.statusCode).send({ error: err.message });
  throw err;
};

export function djRoutes(app: FastifyInstance, deps: DjDeps): void {
  const { dj, need } = deps;

  app.post('/api/ishuffle/plan', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no library' });
    const b = (req.body ?? {}) as {
      count?: unknown;
      exclude?: unknown;
      afterTrackId?: unknown;
      played?: unknown;
      seedFrom?: unknown;
    };
    const tracks = dj.plan(c.id, {
      count: Number(b.count) || 6,
      exclude: new Set(Array.isArray(b.exclude) ? b.exclude.map(Number) : []),
      playedOrder: Array.isArray(b.played) ? b.played.map(Number) : [],
      afterTrackId: Number(b.afterTrackId) || 0,
      seedFrom: Number(b.seedFrom) || 0,
    });
    return { tracks };
  });

  app.post('/api/ishuffle/vote', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no library' });
    const b = (req.body ?? {}) as { trackId?: unknown; direction?: unknown };
    const direction: VoteDirection | null =
      b.direction === 'less' ? 'less' : b.direction === 'more' ? 'more' : null;
    if (!direction) return reply.code(400).send({ error: "direction must be 'more' or 'less'" });
    try {
      return dj.vote(c.id, Number(b.trackId), direction);
    } catch (err) {
      return rethrow(reply, err);
    }
  });

  app.get('/api/ishuffle/mood', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no library' });
    return dj.moodNow(c.id);
  });

  app.post('/api/ishuffle/save-playlist', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no library' });
    const name = String((req.body as { name?: string } | undefined)?.name ?? '').trim();
    try {
      return dj.savePlaylist(c.id, name);
    } catch (err) {
      return rethrow(reply, err);
    }
  });

  app.post('/api/ishuffle/say', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no library' });
    const text = String((req.body as { text?: string } | undefined)?.text ?? '').trim();
    try {
      return await dj.say(c.id, text);
    } catch (err) {
      return rethrow(reply, err);
    }
  });

  /**
   * Wipe the mood. `seedFrom` distinguishes the two buttons that call this: absent = "End DJ
   * session" (a fresh mind, no target); a track id = "Reset DJ session" (fresh mind, but the
   * session keeps running so the ghost restarts on what is playing). iOS sends {} — end.
   */
  app.post('/api/ishuffle/reset', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no library' });
    const seedFrom = Number((req.body as { seedFrom?: unknown } | undefined)?.seedFrom) || 0;
    return dj.reset(c.id, seedFrom || undefined);
  });
}
