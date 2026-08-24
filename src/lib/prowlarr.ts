/**
 * Prowlarr search, used directly rather than through Lidarr.
 *
 * Prowlarr is the indexer layer on this estate — Lidarr only ever asked it
 * questions. Asking it ourselves removes Lidarr from the request path entirely,
 * and with it the release matching that refused an eleven-track ABBA rip because
 * the release it had chosen wanted twenty-five.
 *
 * Newznab categories: 3000 is Audio, 3040 Lossless, 3010 MP3. Searching 3000
 * rather than 3040 alone matters because indexers categorise inconsistently and a
 * FLAC release filed under plain Audio would otherwise be invisible.
 */

import type { Settings } from './settings.js';

export interface Candidate {
  title: string;
  /** Bytes. 0 when the indexer does not report it, which the scorer treats as unknown. */
  size: number;
  /**
   * What to hand the download client: an NZB URL for usenet, a magnet link
   * (preferred) or .torrent URL for a torrent.
   */
  downloadUrl: string;
  guid: string;
  indexer: string;
  publishDate: string;
  protocol: string;
  /** Torrents only. 0 for usenet, where the idea does not apply. */
  seeders: number;
  /** How many people have taken this release. The crowd's verdict on a post. */
  grabs: number;
  /** Files in the release, when the indexer says. 0 means it did not. */
  files: number;
  /** Where a human can read the comments — often the difference between a
   *  broken upload and a good one, and something crate cannot judge. */
  infoUrl: string;
  ageDays: number;
}

interface RawResult {
  title?: string;
  size?: number;
  downloadUrl?: string;
  magnetUrl?: string;
  guid?: string;
  indexer?: string;
  publishDate?: string;
  protocol?: string;
  seeders?: number;
  grabs?: number;
  files?: number;
  infoUrl?: string;
  commentUrl?: string;
  age?: number;
}

export class Prowlarr {
  /**
   * Reads its URL and key from Settings on every call rather than at construction,
   * so changing them on the admin page takes effect without recreating the
   * container. The cost is one cached map lookup per search.
   */
  constructor(private settings: Settings) {}

  get configured(): boolean {
    const c = this.settings.all();
    return Boolean(c.prowlarrUrl && c.prowlarrKey);
  }

  /**
   * How many indexers Prowlarr has, for the admin page's connection test.
   *
   * Counts rather than pings, because a Prowlarr with a valid key and no indexers
   * answers every search with an empty list — which reads as "nothing available"
   * and is the least obvious way for this to be broken.
   */
  async indexerCount(): Promise<number> {
    const { prowlarrUrl, prowlarrKey } = this.settings.all();
    if (!prowlarrUrl || !prowlarrKey) throw new Error('prowlarr is not configured');
    const res = await fetch(`${prowlarrUrl}/api/v1/indexer`, {
      headers: { 'X-Api-Key': prowlarrKey },
    });
    if (!res.ok) throw new Error(`prowlarr ${res.status} on /indexer`);
    const list = (await res.json()) as { enable?: boolean }[];
    return list.filter((i) => i.enable !== false).length;
  }

  /**
   * Search every configured indexer for one album.
   *
   * The query is deliberately just "artist album" with no quoting or field
   * syntax: indexers differ on all of it, and a query that is too clever returns
   * nothing at all rather than something to filter. Filtering happens in
   * release.ts, where it can be reasoned about.
   */
  async search(artist: string, album: string): Promise<Candidate[]> {
    const { prowlarrUrl, prowlarrKey } = this.settings.all();
    if (!prowlarrUrl || !prowlarrKey) throw new Error('prowlarr is not configured');

    /**
     * Punctuation is stripped from the query, not merely trimmed.
     *
     * A straight apostrophe silently breaks a Newznab search: NZBgeek returned
     * 95 results for "Guns N Roses Appetite for Destruction" and 63 for
     * "Guns N' Roses …" — and the 32 it dropped included the best release on
     * the indexer, a 24-bit remaster with 5,507 grabs. MusicBrainz spells the
     * name with that apostrophe, so crate never saw it and spent three attempts
     * on obfuscated reposts of one broken upload instead.
     *
     * Every band with an apostrophe, slash or exclamation mark in its name was
     * quietly getting a worse search: Guns N' Roses, Sinéad O'Connor, AC/DC,
     * Panic! at the Disco. Indexers match on words, so words are all we send.
     */
    const query = `${artist} ${album}`.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
    return this.searchQuery(query);
  }

  /**
   * The same search, from a query somebody typed.
   *
   * Exists for the manual release search: when crate has resolved the wrong album — or when
   * MusicBrainz simply has no useful album for a song — the person looking at the failure knows
   * the right words and the machine does not. Punctuation is stripped here too, for the same
   * reason it is above: indexers match on words, and an apostrophe silently costs results.
   */
  async searchQuery(typed: string): Promise<Candidate[]> {
    const { prowlarrUrl, prowlarrKey } = this.settings.all();
    if (!prowlarrUrl || !prowlarrKey) throw new Error('prowlarr is not configured');
    const query = typed.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!query) return [];
    const url =
      `${prowlarrUrl}/api/v1/search` +
      `?query=${encodeURIComponent(query)}&categories=3000&type=search`;

    const res = await fetch(url, { headers: { 'X-Api-Key': prowlarrKey } });
    if (!res.ok) throw new Error(`prowlarr ${res.status} on search`);

    const raw = (await res.json()) as RawResult[];
    return raw
      // A magnet counts as a usable link, so a torrent with only a magnet is
      // not discarded — on public trackers that is most of them.
      .filter((r) => Boolean(r.downloadUrl || r.magnetUrl))
      .map((r) => ({
        title: r.title ?? '',
        size: r.size ?? 0,
        // Magnet first for torrents: it needs no cookie, no session and no
        // second request to the tracker's web front end.
        downloadUrl: (r.protocol === 'torrent' ? r.magnetUrl || r.downloadUrl : r.downloadUrl) ?? '',
        guid: r.guid ?? r.downloadUrl ?? r.magnetUrl ?? '',
        indexer: r.indexer ?? 'unknown',
        publishDate: r.publishDate ?? '',
        protocol: r.protocol ?? 'usenet',
        seeders: r.seeders ?? 0,
        grabs: r.grabs ?? 0,
        files: r.files ?? 0,
        infoUrl: r.infoUrl ?? r.commentUrl ?? '',
        ageDays: r.age ?? 0,
      }));
  }
}
