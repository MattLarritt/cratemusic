import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { plan, spawnTranscode } from './transcode.js';
import type { ExternalCatalog, ExternalRow } from './external.js';
import type { ExternalStream } from './plugin.js';

/**
 * Play an external song: proxy its audio, or transcode it on the way through.
 *
 * The plugin only says WHERE the audio is. Everything a client can observe happens here, once,
 * for every source — which is why the Subsonic endpoint and the web player can both call it:
 *
 *   - Range passes straight through, so the client gets a real Content-Length and can seek.
 *     iOS's AVPlayer needs both; without them a song plays but shows no duration and will not
 *     scrub, which reads as broken even though the audio is fine.
 *   - A client asking for a format or a ceiling gets it transcoded by the same plan() the
 *     library uses, so the rules (raw wins, never re-encode below the source) are the same.
 *   - A refused URL (the far end's links expire) is re-resolved once before the client sees an
 *     error, because "the link was stale" is the normal way these fail.
 *
 * Proxied rather than redirected: a redirect would hand the client a URL that is bound to this
 * server's address and expires in hours, and a Subsonic client that caches it would fail later
 * with no way to recover. Proxying keeps the only URL the client ever sees crate's own.
 */

const EXT_FOR_MIME: Record<string, string> = {
  'audio/mp4': '.m4a',
  'audio/m4a': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/mpeg': '.mp3',
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
};

/** Status codes that mean "that URL is no good any more", as opposed to "the far end is down". */
const STALE = new Set([403, 404, 410]);

export async function streamExternal(
  req: FastifyRequest,
  reply: FastifyReply,
  external: Pick<ExternalCatalog, 'streamFor' | 'forgetStream'>,
  row: ExternalRow,
  opts: { format?: string; maxBitRate?: number; timeOffsetS?: number } = {},
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let s: ExternalStream;
    try {
      s = await external.streamFor(row);
    } catch (err) {
      reply.code(502).send({ error: `could not reach ${row.source}: ${(err as Error).message}` });
      return;
    }

    const ext = EXT_FOR_MIME[s.mime.split(';')[0]!.trim().toLowerCase()] ?? '.m4a';
    const p = plan({
      path: `source${ext}`,
      sizeBytes: s.sizeBytes ?? 0,
      durationS: row.durationS,
      format: opts.format,
      maxBitRate: opts.maxBitRate,
      sourceMime: s.mime,
    });

    if (p.transcode) {
      const proc = spawnTranscode(s.url, p, {
        ...(opts.timeOffsetS ? { timeOffsetS: opts.timeOffsetS } : {}),
        ...(s.headers ? { inputHeaders: s.headers } : {}),
      });
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': p.mime,
        'Accept-Ranges': 'none',
        'Cache-Control': 'no-store',
        'X-Crate-Transcode': p.reason,
      });
      proc.stdout.pipe(reply.raw);
      const stop = () => {
        if (!proc.killed) proc.kill('SIGKILL');
      };
      reply.raw.on('close', stop);
      reply.raw.on('error', stop);
      proc.on('error', () => reply.raw.destroy());
      proc.on('close', (code) => {
        // A failing encode over a remote input is most often a URL that expired mid-song;
        // forgetting it means the NEXT request resolves afresh instead of failing the same way.
        if (code) external.forgetStream(row.id);
        reply.raw.end();
      });
      return;
    }

    let upstream: IncomingMessage;
    try {
      upstream = await open(s, typeof req.headers.range === 'string' ? req.headers.range : undefined);
    } catch (err) {
      external.forgetStream(row.id);
      if (attempt === 1) continue;
      reply.code(502).send({ error: `could not reach ${row.source}: ${(err as Error).message}` });
      return;
    }
    const status = upstream.statusCode ?? 502;
    if (STALE.has(status) && attempt === 1) {
      upstream.resume();
      external.forgetStream(row.id);
      continue;
    }
    if (status >= 400) {
      upstream.resume();
      reply.code(502).send({ error: `${row.source} answered ${status}` });
      return;
    }

    const upstreamType = String(upstream.headers['content-type'] ?? '');
    reply.hijack();
    reply.raw.writeHead(status, {
      // Trust the far end's type only when it says audio; some CDNs label everything
      // application/octet-stream, which some clients then refuse to play.
      'Content-Type': upstreamType.startsWith('audio/') ? upstreamType : s.mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      ...(upstream.headers['content-length'] ? { 'Content-Length': String(upstream.headers['content-length']) } : {}),
      ...(upstream.headers['content-range'] ? { 'Content-Range': String(upstream.headers['content-range']) } : {}),
    });
    upstream.pipe(reply.raw);
    // Skipping a song closes the socket; the upstream request must go with it, or every skip
    // leaves a download running to nowhere.
    reply.raw.on('close', () => upstream.destroy());
    upstream.on('error', () => reply.raw.destroy());
    return;
  }
}

/**
 * GET the source URL over IPv4, following a few redirects.
 *
 * IPv4 because this estate has no IPv6 egress (see lib/http.ts): Node will happily prefer an
 * AAAA record it cannot reach and hang for the full timeout. Media CDNs publish both.
 */
function open(s: ExternalStream, range: string | undefined, hops = 3): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const url = new URL(s.url);
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        family: 4,
        method: 'GET',
        headers: { ...(s.headers ?? {}), ...(range ? { Range: range } : {}) },
      },
      (res) => {
        // The timeout guards CONNECTING only. Once audio is flowing, a paused player applies
        // backpressure and the socket goes quiet for as long as the pause lasts — which is
        // normal, and must not be mistaken for a dead connection.
        req.setTimeout(0);
        const loc = res.headers.location;
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc && hops > 0) {
          res.resume();
          resolve(open({ ...s, url: new URL(loc, url).href }, range, hops - 1));
          return;
        }
        resolve(res);
      },
    );
    req.on('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error('timed out connecting')));
    req.end();
  });
}
