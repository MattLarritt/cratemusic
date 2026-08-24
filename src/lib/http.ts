import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * Pick the transport from the scheme.
 *
 * Everything on the public internet is https, but a mirror on the LAN is
 * plain http and node:https against it fails at the TLS handshake with an
 * error that says nothing useful about the cause.
 */
function requestFor(url: string): typeof httpsRequest {
  return url.startsWith('http://') ? (httpRequest as typeof httpsRequest) : httpsRequest;
}

/**
 * GET raw bytes over IPv4, following redirects.
 *
 * Exists for artwork. Cover Art Archive answers with a 307 to archive.org and
 * from there another hop to an ia*.us.archive.org node, and archive.org
 * publishes AAAA records — exactly the shape that makes undici's fetch report
 * ETIMEDOUT on this estate (see getJson below). Redirects are followed here,
 * with the family pinned on every hop, because pinning only the first request
 * would fix nothing: the host that actually serves the bytes is the last one.
 */
export function getBytes(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; maxHops?: number } = {},
): Promise<{ body: Buffer; contentType: string } | null> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxHops = opts.maxHops ?? 5;

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { family: 4, headers: opts.headers ?? {}, method: 'GET' },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          if (maxHops <= 0) {
            resolve(null);
            return;
          }
          resolve(
            getBytes(new URL(location, url).href, { ...opts, maxHops: maxHops - 1 }).catch(
              () => null,
            ),
          );
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          // A miss (404 for an album with no cover) is an answer, not an error.
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          chunks.push(c);
          size += c.length;
          // Covers run tens of KB to a few MB; anything past this is not artwork.
          if (size > 20_000_000) req.destroy(new Error('response too large'));
        });
        res.on('end', () => {
          resolve({
            body: Buffer.concat(chunks),
            contentType: res.headers['content-type'] ?? 'image/jpeg',
          });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.end();
  });
}

/**
 * GET some JSON over IPv4, deliberately not using fetch.
 *
 * This exists because of a failure that looks like an outage and is not. This
 * estate has no working IPv6 egress — a container connecting to a v6 address
 * gets ENETUNREACH in about 4ms. Node's global fetch (undici) races the two
 * address families with a 250ms `autoSelectFamilyAttemptTimeout`, and when the
 * v6 attempt fails it surfaces the whole thing as ETIMEDOUT after ~260ms rather
 * than falling back to the v4 address that works.
 *
 * The symptom is brutal to diagnose: curl succeeds from the same container,
 * every other host succeeds, and only hosts that publish an AAAA record fail.
 * musicbrainz.org does; images.lidarr.audio does not, which is why Lidarr's
 * artwork worked throughout and made the problem look MusicBrainz-specific.
 *
 * node:https takes an explicit `family`, so pinning 4 removes the race
 * entirely. Applied to every external call rather than only the one that failed,
 * because any of these hosts could add an AAAA record tomorrow and reintroduce
 * exactly this.
 */
/**
 * POST JSON, same IPv4 discipline as getJson and for the same reason —
 * api.openai.com publishes AAAA records, which is exactly the shape that
 * breaks on this estate's v6-less egress.
 */
export function postJson<T>(
  url: string,
  body: unknown,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const payload = JSON.stringify(body);
  return new Promise<T>((resolve, reject) => {
    const req = requestFor(url)(
      url,
      {
        family: 4,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          text += c;
          if (text.length > 8_000_000) req.destroy(new Error('response too large'));
        });
        res.on('end', () => {
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}: ${text.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(new Error(`invalid JSON from ${new URL(url).host}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.write(payload);
    req.end();
  });
}

export function getJson<T>(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 20_000;

  return new Promise<T>((resolve, reject) => {
    const req = requestFor(url)(
      url,
      { family: 4, headers: opts.headers ?? {}, method: 'GET' },
      (res) => {
        const status = res.statusCode ?? 0;
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          body += c;
          // A runaway response must not become a memory problem. Nothing we ask
          // for is anywhere near this size.
          if (body.length > 8_000_000) {
            req.destroy(new Error('response too large'));
          }
        });
        res.on('end', () => {
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch {
            reject(new Error(`invalid JSON from ${new URL(url).host}`));
          }
        });
      },
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.end();
  });
}

/**
 * GET a text document over IPv4, following redirects.
 *
 * Same family pinning and the same reasoning as the two above — see the note on getJson. This
 * one exists for HTML rather than JSON or images: a page whose data is embedded in its markup,
 * which is how a chord sheet arrives from Ultimate Guitar.
 *
 * Unlike getBytes, a non-2xx REJECTS rather than resolving null. A missing cover is an answer;
 * a page that would not load is a failure the person needs told about, because they pasted the
 * URL and are waiting to hear whether it worked.
 */
export function getText(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; maxHops?: number; maxBytes?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxHops = opts.maxHops ?? 5;
  const maxBytes = opts.maxBytes ?? 8_000_000;

  return new Promise((resolve, reject) => {
    const req = requestFor(url)(
      url,
      { family: 4, headers: opts.headers ?? {}, method: 'GET' },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          if (maxHops <= 0) {
            reject(new Error('too many redirects'));
            return;
          }
          resolve(getText(new URL(location, url).href, { ...opts, maxHops: maxHops - 1 }));
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          chunks.push(c);
          size += c.length;
          if (size > maxBytes) req.destroy(new Error('response too large'));
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.end();
  });
}
