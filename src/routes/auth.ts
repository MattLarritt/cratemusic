import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store, User } from '../lib/store.js';

interface Deps {
  store: Store;
  cookieName: string;
  cookieSecure: boolean;
}

/** The client's address, for lockout bookkeeping. */
export function clientIp(req: FastifyRequest): string {
  // Cloudflare overwrites CF-Connecting-IP unconditionally, so it is a single
  // authoritative value rather than a chain to reason about. It is only
  // trustworthy while the request genuinely arrived via Cloudflare, which is what
  // the cloudflare-only allowlist on this host's Traefik routers enforces.
  const cf = String(req.headers['cf-connecting-ip'] ?? '').trim();
  if (cf) return cf;

  // Otherwise take the RIGHT-most entry, not the left-most.
  //
  // Traefik's websecure entryPoint lists Cloudflare's ranges in
  // forwardedHeaders.trustedIPs, so for a request through Cloudflare it preserves
  // the inbound X-Forwarded-For instead of replacing it — and Cloudflare appends
  // the peer it actually saw to whatever chain the client sent. That makes the
  // left-most entry attacker-controlled and the right-most one not. Reading the
  // left-most, which was safe only while this host was LAN-only, would hand an
  // internet client control of its own lockout key and make the brute-force limit
  // bypassable by rotating a single header.
  const chain = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const nearest = chain[chain.length - 1];
  if (nearest) return nearest;

  // Not req.ip: trustProxy is on, so Fastify derives that from the left-most
  // X-Forwarded-For too and it carries the same forgery problem.
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * crate's own accounts and sessions.
 *
 * Deliberately self-contained. gatekeeper is an optional extra layer that can be
 * put in front of this host, not this app's identity system — so nothing here
 * reads a header from a reverse proxy, and putting gatekeeper in front adds a
 * gate before crate's login rather than replacing it.
 */
export function authRoutes(app: FastifyInstance, deps: Deps): void {
  const { store } = deps;

  app.post('/api/login', async (req, reply) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = String(b.username ?? '').trim();
    const password = String(b.password ?? '');
    if (!username || !password) {
      return reply.code(400).send({ error: 'username and password are required' });
    }

    const ip = clientIp(req);
    const locked = store.lockoutRemaining(ip, username);
    if (locked > 0) {
      // Deliberately explicit about the wait. A vague refusal makes a locked-out
      // user retry, which on a naive implementation extends their own lockout.
      return reply
        .code(429)
        .send({ error: `too many attempts — try again in ${Math.ceil(locked / 60)} min` });
    }

    const user = await store.checkPassword(username, password);
    if (!user) {
      store.recordFail(ip, username);
      // One message for wrong-user and wrong-password, so the response cannot be
      // used to work out which usernames exist.
      return reply.code(401).send({ error: 'incorrect username or password' });
    }

    store.clearFails(ip, username);
    const { token, expiresAt } = store.createSession(user.id);
    reply.setCookie(deps.cookieName, token, {
      path: '/',
      httpOnly: true,
      secure: deps.cookieSecure,
      sameSite: 'lax',
      maxAge: expiresAt - Math.floor(Date.now() / 1000),
    });
    return { ok: true, user: publicUser(user) };
  });

  app.post('/api/logout', async (req, reply) => {
    const token = String(req.cookies[deps.cookieName] ?? '');
    if (token) store.endSession(token);
    reply.clearCookie(deps.cookieName, { path: '/' });
    return { ok: true };
  });

  /**
   * Whether anyone can log in at all.
   *
   * The client needs this to tell "you are signed out" from "this instance has no
   * accounts yet", which are different problems with different fixes.
   */
  app.get('/api/setup', async () => ({ hasUsers: store.userCount() > 0 }));
}

/**
 * Is this request carrying a valid session or the API key?
 *
 * Exported so route modules share one definition of "signed in" rather than each
 * reimplementing the cookie lookup.
 */
export function makeIsAuthed(
  store: Store,
  cookieName: string,
  apiKey: string | null,
): (req: FastifyRequest) => boolean {
  return (req) => {
    const token = String(req.cookies?.[cookieName] ?? '');
    if (token && store.userForSession(token)) return true;
    const auth = String(req.headers.authorization ?? '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return Boolean(apiKey && bearer && bearer === apiKey);
  };
}

/** A user as the client may see them — never the password hash. */
export function publicUser(u: User) {
  return {
    id: u.id,
    username: u.username,
    name: u.display_name || u.username,
    admin: Boolean(u.is_admin),
  };
}
