/**
 * qBittorrent, as a download client crate can use interchangeably with SABnzbd.
 *
 * Torrents earn their place by covering what Usenet cannot. Measured on this
 * estate: of 621 unique albums a library import asked for, 405 failed with "no
 * results from any indexer" — Australian singles, Triple J compilation tracks,
 * anything that was never posted as an album. The Pirate Bay has 24 results for
 * Mezzanine and 53 for a Taylor Swift record that failed thirty-six times on
 * Usenet. Different corpus, not a better one.
 *
 * TWO THINGS THIS MODULE IS CAREFUL ABOUT.
 *
 * **Seeding.** A finished Usenet download is disposable, so the importer moves
 * its files. A finished torrent is being uploaded to other people, and moving
 * its files breaks that — so torrent imports COPY, and the torrent is left
 * alone. See `keepSource` in lib/importer.ts.
 *
 * **Where it downloads to.** qBittorrent lives in gluetun's network namespace
 * but mounts the same NAS share crate does, both as /downloads, so a save path
 * given here is a path crate can read directly. No remote path mapping, and
 * nothing to keep in sync.
 *
 * **How it is reached.** Through its own host name, not by
 * poking at the container network. Going straight to gluetun's namespace
 * answered 403 — qBittorrent trusts the LAN and crate's container address is
 * not on it — and the instinct to reach for credentials was the wrong one: the
 * estate already publishes this WebUI through Traefik, which connects from a
 * LAN address qBittorrent already trusts. So the existing route needs no
 * password and no configuration change anywhere. Username and password stay
 * supported for a deployment without such a route.
 */

import { mkdir } from 'node:fs/promises';
import type { Settings } from './settings.js';

export interface TorrentJob {
  hash: string;
  name: string;
  /** Mapped to the same vocabulary SABnzbd's client reports. */
  state: 'queued' | 'downloading' | 'postprocessing' | 'done' | 'failed' | 'unknown';
  percent: number;
  /** Where the finished content is. Only set once done. */
  path: string | null;
  message: string | null;
  /** qBittorrent's own state string, for a stall message that names the truth. */
  raw: string;
  seeders: number;
}

/**
 * qBittorrent states, mapped.
 *
 * `stalledDL` is deliberately NOT failed: a torrent with no seeders right now
 * may find one, and the pipeline's stall timeout is what gives up. `pausedDL`
 * is not failed either — a person paused it, and crate should not fight them.
 */
const STATE: Record<string, TorrentJob['state']> = {
  allocating: 'queued',
  checkingDL: 'postprocessing',
  checkingResumeData: 'queued',
  checkingUP: 'postprocessing',
  downloading: 'downloading',
  error: 'failed',
  forcedDL: 'downloading',
  forcedMetaDL: 'queued',
  forcedUP: 'done',
  metaDL: 'queued',
  missingFiles: 'failed',
  moving: 'postprocessing',
  pausedDL: 'queued',
  pausedUP: 'done',
  queuedDL: 'queued',
  queuedUP: 'done',
  stalledDL: 'downloading',
  stalledUP: 'done',
  stoppedDL: 'queued',
  stoppedUP: 'done',
  unknown: 'unknown',
  uploading: 'done',
};

interface RawTorrent {
  hash?: string;
  name?: string;
  state?: string;
  progress?: number;
  content_path?: string;
  save_path?: string;
  num_seeds?: number;
  num_complete?: number;
}

export class Qbit {
  /** The WebUI session cookie, when one was needed. */
  private sid: string | null = null;

  constructor(private settings: Settings) {}

  get configured(): boolean {
    return Boolean(this.settings.all().qbitUrl);
  }

  private get base(): string {
    return this.settings.all().qbitUrl.replace(/\/$/, '');
  }

  /**
   * One WebUI call, logging in on demand.
   *
   * qBittorrent accepts unauthenticated calls from whitelisted subnets and
   * demands a cookie from everywhere else, and which of those applies is the
   * operator's business, not something to configure twice. So: try the call; if
   * it comes back Forbidden, log in and try once more. A working whitelist
   * therefore needs no credentials at all, and credentials work without one.
   */
  private async call(path: string, body?: URLSearchParams | FormData): Promise<Response> {
    const form = body instanceof URLSearchParams;
    const attempt = async (): Promise<Response> =>
      fetch(`${this.base}/api/v2${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          ...(this.sid ? { Cookie: `SID=${this.sid}` } : {}),
          // FormData sets its own content type, boundary included; setting one
          // by hand would corrupt the upload.
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          // qBittorrent rejects cross-origin-looking requests unless the Referer
          // matches; sending its own base satisfies that check.
          Referer: this.base,
        },
        ...(body ? { body: form ? body.toString() : (body as FormData) } : {}),
        signal: AbortSignal.timeout(60_000),
      });

    let res = await attempt();
    if (res.status === 403) {
      await this.login();
      res = await attempt();
    }
    return res;
  }

  private async login(): Promise<void> {
    const cfg = this.settings.all();
    if (!cfg.qbitUser) {
      throw new Error(
        'qBittorrent refused the request and no username is configured — ' +
          'set one on the admin page, or whitelist crate in qBittorrent',
      );
    }
    const body = new URLSearchParams({ username: cfg.qbitUser, password: cfg.qbitPassword });
    const res = await fetch(`${this.base}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: this.base },
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const text = (await res.text()).trim();
    // A wrong password comes back 200 with the body "Fails." — status alone
    // would report a successful login that did nothing.
    if (!res.ok || text !== 'Ok.') {
      throw new Error(`qBittorrent login failed: ${text || res.status}`);
    }
    const setCookie = res.headers.get('set-cookie') ?? '';
    const sid = /SID=([^;]+)/.exec(setCookie)?.[1];
    if (!sid) throw new Error('qBittorrent login returned no session cookie');
    this.sid = sid;
  }

  /** Version string, for the admin page's connection test. */
  async version(): Promise<string> {
    const res = await this.call('/app/version');
    if (!res.ok) throw new Error(`qBittorrent responded ${res.status}`);
    return (await res.text()).trim();
  }

  /**
   * Add a magnet link or .torrent URL, and return the hash that identifies it.
   *
   * Two response shapes, because qBittorrent changed one. Up to 4.x the add
   * endpoint replied with the bare text "Ok."; 5.x replies with JSON —
   * {"added_torrent_ids":[…],"pending_count":1,"success_count":0,…} — and
   * treating anything that is not "Ok." as a refusal rejected a magnet the
   * client had actually taken. `pending_count` is the normal answer for a
   * magnet: accepted, metadata not yet fetched.
   *
   * When the reply names the id, that is used directly. Otherwise the torrent
   * is found by watching the marker category for a newcomer — which is also
   * what keeps crate's torrents distinguishable in a shared client.
   */
  async add(url: string, name: string): Promise<string> {
    const cfg = this.settings.all();
    const before = new Set((await this.listByCategory()).map((t) => t.hash));

    // Both clients see this path, so crate can prepare the directory
    // qBittorrent is about to write into. A save path that does not exist is
    // one more silent way for an add to go nowhere.
    if (cfg.qbitSavePath) await mkdir(cfg.qbitSavePath, { recursive: true }).catch(() => {});

    /**
     * A magnet goes as a link. Anything else is FETCHED HERE and uploaded as a
     * file, rather than handed over as a URL for qBittorrent to fetch itself.
     *
     * That is not defensive coding, it is a hard requirement of this estate:
     * indexer links from Prowlarr point at http://prowlarr:9696, a name that
     * resolves on crate's network and NOT inside gluetun's, where qBittorrent
     * lives. Passing the URL along produced the worst possible failure — the
     * client accepted the request, reported one torrent pending, and then had
     * nothing at all in its queue. crate can reach Prowlarr, so crate does the
     * fetching and qBittorrent only ever receives bytes.
     */
    const link = (magnet: string): URLSearchParams =>
      new URLSearchParams({
        urls: magnet,
        category: cfg.qbitCategory,
        savepath: cfg.qbitSavePath,
        root_folder: 'true',
      });

    let body: URLSearchParams | FormData;
    if (url.startsWith('magnet:')) {
      body = link(url);
    } else {
      /**
       * Resolve the indexer link by hand, one redirect at a time.
       *
       * Prowlarr's `magnetUrl` is not a magnet: it is a proxy URL on
       * prowlarr:9696 that 301s to one. Two things follow, and both bit.
       * `redirect: 'follow'` cannot chase it — undici refuses a non-HTTP
       * scheme and reports the unhelpful "fetch failed" — and the proxy host
       * does not resolve inside gluetun's namespace, so handing the URL to
       * qBittorrent instead produced an accepted request and an empty queue.
       *
       * So crate follows the chain itself, and whichever way it ends is
       * usable: a magnet goes over as a link, real torrent bytes go over as an
       * upload. qBittorrent never has to resolve a name it cannot see.
       */
      let target = url;
      // Kept as an ArrayBuffer: a Blob part must be backed by one, and a
      // Uint8Array's buffer is only maybe-shared as far as the types know.
      let bytes: ArrayBuffer | null = null;
      for (let hop = 0; hop < 5; hop++) {
        const got = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
        const location = got.headers.get('location');
        if (got.status >= 300 && got.status < 400 && location) {
          if (location.startsWith('magnet:')) {
            target = location;
            break;
          }
          target = new URL(location, target).href;
          continue;
        }
        if (!got.ok) throw new Error(`could not fetch the torrent: HTTP ${got.status}`);
        bytes = await got.arrayBuffer();
        break;
      }

      if (target.startsWith('magnet:')) {
        body = link(target);
      } else if (bytes && bytes.byteLength) {
        // Some indexers answer with the magnet as a plain body rather than a
        // redirect; that is text where a torrent file would be bencoded.
        const head = new TextDecoder().decode(bytes.slice(0, 20));
        if (head.startsWith('magnet:')) {
          body = link(new TextDecoder().decode(bytes).trim());
        } else {
          const form = new FormData();
          form.append(
            'torrents',
            new Blob([bytes], { type: 'application/x-bittorrent' }),
            `${name.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'crate'}.torrent`,
          );
          form.append('category', cfg.qbitCategory);
          form.append('savepath', cfg.qbitSavePath);
          form.append('root_folder', 'true');
          body = form;
        }
      } else {
        throw new Error('the indexer link led to neither a magnet nor a torrent file');
      }
    }
    const res = await this.call('/torrents/add', body);
    const text = (await res.text()).trim();
    if (!res.ok) throw new Error(`qBittorrent refused that torrent: ${text || res.status}`);

    let named: string | null = null;
    if (text.startsWith('{')) {
      const j = JSON.parse(text) as {
        added_torrent_ids?: string[];
        pending_count?: number;
        success_count?: number;
        failure_count?: number;
      };
      const accepted = (j.success_count ?? 0) + (j.pending_count ?? 0) + (j.added_torrent_ids?.length ?? 0);
      if (accepted === 0) {
        throw new Error(
          `qBittorrent rejected that torrent (${j.failure_count ?? 0} failure(s)): ${text.slice(0, 120)}`,
        );
      }
      named = j.added_torrent_ids?.[0] ?? null;
    } else if (text !== 'Ok.' && text !== '') {
      throw new Error(`qBittorrent refused that torrent: ${text.slice(0, 120)}`);
    }
    if (named) return named;

    // A magnet has no metadata yet, so it can take a moment to appear.
    for (let i = 0; i < 15; i++) {
      const now = await this.listByCategory();
      const fresh = now.find((t) => !before.has(t.hash));
      if (fresh) return fresh.hash;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`qBittorrent accepted "${name}" but it never appeared in the queue`);
  }

  private async listByCategory(): Promise<TorrentJob[]> {
    const cat = encodeURIComponent(this.settings.all().qbitCategory);
    const res = await this.call(`/torrents/info?category=${cat}`);
    if (!res.ok) throw new Error(`qBittorrent responded ${res.status}`);
    return ((await res.json()) as RawTorrent[]).map(toJob);
  }

  /** One torrent by hash, or null when the client no longer knows it. */
  async status(hash: string): Promise<TorrentJob | null> {
    const res = await this.call(`/torrents/info?hashes=${encodeURIComponent(hash)}`);
    if (!res.ok) return null;
    const list = (await res.json()) as RawTorrent[];
    const raw = list[0];
    return raw ? toJob(raw) : null;
  }

  /**
   * Stop tracking a torrent, leaving its files alone.
   *
   * Called once an import has copied what it needs. Deleting the data is
   * deliberately not offered here: the files are what other people are
   * downloading, and a request being finished is no reason to stop seeding.
   */
  async forget(hash: string): Promise<void> {
    await this.call('/torrents/delete', new URLSearchParams({ hashes: hash, deleteFiles: 'false' }));
  }

  /** Give up on a torrent AND remove its data — for a failed attempt. */
  async discard(hash: string): Promise<void> {
    await this.call('/torrents/delete', new URLSearchParams({ hashes: hash, deleteFiles: 'true' }));
  }
}

function toJob(t: RawTorrent): TorrentJob {
  const raw = t.state ?? 'unknown';
  return {
    hash: t.hash ?? '',
    name: t.name ?? '',
    state: STATE[raw] ?? 'unknown',
    percent: Math.round((t.progress ?? 0) * 100),
    // content_path is the file or folder the torrent actually produced, which
    // is what the importer should walk — save_path is only the parent.
    path: (t.progress ?? 0) >= 1 ? (t.content_path || t.save_path || null) : null,
    message: raw === 'error' || raw === 'missingFiles' ? `qBittorrent state: ${raw}` : null,
    raw,
    seeders: t.num_seeds ?? t.num_complete ?? 0,
  };
}
