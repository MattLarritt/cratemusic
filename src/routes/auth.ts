import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store, User } from '../lib/store.js';
import { type Cidr, isTrustedProxy, parseTrustedProxies } from '../lib/trustedproxy.js';

/**
 * Proxies whose forwarding headers are believed, from `CRATE_TRUSTED_PROXIES`.
 *
 * Read once at import. This is deployment topology rather than a runtime setting, and an
 * operator moving crate behind a different proxy is restarting it anyway.
 *
 * Empty by default, which means no header is believed at all. See clientIp().
 */
export const TRUSTED_PROXIES: readonly Cidr[] = parseTrustedProxies(
  process.env.CRATE_TRUSTED_PROXIES ?? '',
);

interface Deps {
  store: Store;
  cookieName: string;
  cookieSecure: boolean;
}

/**
 * The client's address, used to key the sign-in lockout.
 *
 * This value decides whose failed attempts count together, so a caller able to choose it
 * can defeat the lockout entirely: rotate the header, get a fresh bucket, and a limit of
 * six attempts per fifteen minutes limits nothing at all. Getting it wrong is therefore
 * not a logging inconvenience — it silently removes a control that looks present.
 *
 * The one thing a caller cannot choose is the address it opened the socket from. So that
 * is the answer unless the peer is a proxy the operator has explicitly named, and with
 * nothing configured every forwarding header is ignored. That default is deliberately
 * the safe one: crate reached directly is the case where believing a header is worst,
 * and it is also the case an operator is least likely to have thought about.
 *
 * Once the peer IS trusted, the order is:
 *
 *   1. `CF-Connecting-IP`, if present. A CDN that sets this overwrites any inbound
 *      value, so it is one authoritative address rather than a chain to reason about.
 *   2. Otherwise the RIGHT-most `X-Forwarded-For` entry — the hop nearest the proxy that
 *      just spoke to us. A proxy appends the peer it actually saw to whatever chain
 *      arrived, so the left-most entry is whatever the client wrote and the right-most
 *      is the only one attested by something we trust.
 *
 * Never `req.ip`: with trustProxy enabled Fastify derives it from the LEFT-most entry,
 * which is precisely the forgeable one this function exists to avoid.
 *
 * `trusted` is a parameter so the decision can be tested without touching the
 * environment; production callers use the configured list.
 */
export function clientIp(
  req: FastifyRequest,
  trusted: readonly Cidr[] = TRUSTED_PROXIES,
): string {
  const peer = req.socket.remoteAddress ?? 'unknown';
  if (!isTrustedProxy(peer, trusted)) return peer;

  const cf = String(req.headers['cf-connecting-ip'] ?? '').trim();
  if (cf) return cf;

  const chain = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const nearest = chain[chain.length - 1];
  if (nearest) return nearest;

  return peer;
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
