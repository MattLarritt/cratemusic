/**
 * Runtime settings, editable from the admin page.
 *
 * Everything here previously lived in one of two places: an environment variable
 * that needed a container recreate to change, or a constant in release.ts that
 * needed a rebuild. Neither is reasonable for the things an operator actually wants
 * to tune — which file types to accept, how big a track should be, whether lossless
 * is required — so they move into SQLite where a form can reach them.
 *
 * Environment variables remain the DEFAULTS. That ordering matters: the compose file
 * still describes a working deployment, a fresh database inherits it, and nothing
 * has to be entered twice. A stored value simply wins once one exists.
 *
 * Secrets are stored here too, and are never sent to the browser. The admin API
 * reports whether a key is set and the last four characters, which is enough to tell
 * two keys apart without handing a working credential to anything that can read a
 * response body.
 */

import type Database from 'better-sqlite3';

/** Everything tunable, with the types the rest of the app expects. */
export interface Config {
  // ---- download client -----------------------------------------------------
  sabUrl: string;
  sabKey: string;
  sabCategory: string;
  // ---- indexer -------------------------------------------------------------
  prowlarrUrl: string;
  prowlarrKey: string;
  // ---- search criteria -----------------------------------------------------
  /** Extensions considered acceptable audio, lowercase, no dot. */
  formats: string[];
  /** Reject anything not matching a lossless pattern outright. */
  requireLossless: boolean;
  losslessMinMbPerTrack: number;
  losslessMaxMbPerTrack: number;
  lossyMinMbPerTrack: number;
  lossyMaxMbPerTrack: number;
  /**
   * Hard ceiling on a whole release, in MB. 0 means no limit.
   *
   * Separate from the per-track bounds because they answer a different question.
   * Per-track catches a single pretending to be an album; this one is about the bill
   * — a 24-bit hi-res rip can be a perfectly correct release and still be more than
   * you want to pull down a metered connection in one go.
   */
  maxTotalMb: number;
  /** Title fragments that disqualify a release outright. */
  disqualify: string[];
  maxAttempts: number;
  stallMinutes: number;
  /**
   * Albums one user may queue per rolling 24 hours. 0 = unlimited.
   *
   * Exists for metered Usenet accounts, not as product policy — instant adds
   * from the pool never count against it. Unlimited by default: the operator
   * who pays the bill can set a number.
   */
  dailyAlbumCap: number;
  /** Albums one artist request may queue at once. 0 = unlimited. */
  maxAlbumsPerRequest: number;
  // ---- torrents -------------------------------------------------------------
  /**
   * qBittorrent's WebUI. Empty disables torrents entirely, and crate behaves
   * exactly as it did before they existed.
   */
  qbitUrl: string;
  /** Only needed when crate's address is not in qBittorrent's subnet whitelist. */
  qbitUser: string;
  qbitPassword: string;
  /** Marks crate's torrents in a client that other things also use. */
  qbitCategory: string;
  /**
   * Where torrents are saved, as BOTH qBittorrent and crate see it — they mount
   * the same share at the same path, which is what makes this a single setting
   * rather than a remote path mapping.
   */
  qbitSavePath: string;
  /**
   * Try Usenet first and fall back to torrents, or the reverse.
   *
   * Usenet first by default: it is faster, needs no seeding, and is already
   * paid for. Torrents exist here to cover what Usenet does not have.
   */
  preferProtocol: string;
  /**
   * Seeders below which a torrent is not worth starting. A swarm of one is a
   * download that will probably stall, and the stall timeout is a slow way to
   * discover that.
   */
  minSeeders: number;
  // ---- last.fm -------------------------------------------------------------
  lastfmKey: string;
  /**
   * Base URL of a local MusicBrainz mirror, e.g. http://mirror.lan:5000/ws/2.
   * Empty uses the public API.
   *
   * A mirror is not rate limited, so this is the difference between one lookup
   * per second and as many as the machine will serve. It is treated as a
   * best-effort accelerator rather than a dependency: crate falls back to the
   * public API whenever it does not answer, so pointing this at a desktop that
   * is off half the time is a supported way to run it.
   */
  mbMirrorUrl: string;
  /**
   * AcoustID application key — free from acoustid.org/new-application.
   *
   * Gates the one network call in audio identification: fingerprints are
   * computed locally by fpcalc regardless, but matching one to a recording
   * means asking api.acoustid.org, and that only happens with a key present.
   */
  acoustidKey: string;
  /**
   * OpenAI API key. Powers optional admin-side AI assistance — currently the
   * arbitration step in track matching. Everything it touches must also work
   * without it: AI here is an improver, never a dependency.
   */
  openaiKey: string;
  minSeeds: number;
  // ---- song characteristics -------------------------------------------------
  /**
   * Song characteristics: use AI to analyse the musical, emotional and sonic characteristics
   * of songs.
   *
   * Off by default and deliberately so — it is the one feature in crate that spends money per
   * track, so it has to be a decision somebody made rather than something that started
   * happening. Off means no analysis request is ever sent; it does NOT mean existing
   * characteristic data is hidden or deleted.
   *
   * There is no threshold setting here, unlike the mood feature this replaced: a characteristic
   * vector wants every dimension scored, and a score of zero is a real answer rather than noise
   * to be filtered out.
   */
  /**
   * Warm artist and album pages in the background, before anybody opens them.
   *
   * On by default, unlike Song characteristics, because the two cost differently: that one
   * spends money per track at an AI provider, this one spends politeness at MusicBrainz on
   * the idle lane and would happen anyway the moment somebody clicked. Off is for a server
   * that would rather make no unattended outbound calls at all.
   */
  warmPages: boolean;
  songCharacteristics: boolean;
  /**
   * When Song characteristics was switched on, as a unix timestamp. Written by the admin route
   * on the off→on edge, and it is what stops enabling the feature from silently enrolling an
   * entire existing library: automatic analysis only reaches tracks first seen after this.
   * Backfilling what came before is an explicit batch action. 0 = never enabled.
   */
  songCharacteristicsSince: number;
  // ---- caching -------------------------------------------------------------
  /**
   * Days of disuse before cached artwork and metadata are reclaimed. 0 = keep forever.
   *
   * Artwork for anything still on disk is never deleted regardless of this, so the setting
   * only governs art for things that were browsed past and never returned to.
   */
  artRetentionDays: number;
  // ---- migrations ----------------------------------------------------------
  /**
   * Set once the shared library has been copied into every user's library.
   *
   * A flag rather than an emptiness check, because a user who deliberately empties their
   * library must not have it refilled on the next restart.
   */
  poolBackfilled: boolean;
}

/** Keys whose values must never leave the server. */
export const SECRET_KEYS: (keyof Config)[] = ['sabKey', 'prowlarrKey', 'lastfmKey', 'qbitPassword', 'acoustidKey', 'openaiKey'];

const DEFAULT_FORMATS = ['flac', 'mp3', 'm4a', 'ogg', 'opus', 'aac', 'alac', 'ape', 'wav'];
const DEFAULT_DISQUALIFY = [
  'discography',
  'box set',
  'boxset',
  'complete collection',
  'greatest hits',
  'karaoke',
  'tribute',
  'in the style of',
  'made famous by',
];

export class Settings {
  /**
   * Read through a cache.
   *
   * The scorer asks for config once per candidate release, and the pipeline polls
   * every fifteen seconds, so an uncached read would mean a great many pointless
   * queries. Writes clear it, and there is only one process.
   */
  private cache: Config | null = null;

  constructor(
    private db: Database.Database,
    private env: Partial<Config>,
  ) {}

  all(): Config {
    if (this.cache) return this.cache;

    const rows = this.db.prepare('SELECT key, value FROM settings').all() as {
      key: string;
      value: string;
    }[];
    const stored = new Map(rows.map((r) => [r.key, r.value]));

    const str = (k: keyof Config, fallback: string): string => {
      const v = stored.get(k);
      return v !== undefined ? v : ((this.env[k] as string | undefined) ?? fallback);
    };
    const num = (k: keyof Config, fallback: number): number => {
      const v = stored.get(k);
      const raw = v !== undefined ? v : (this.env[k] as number | undefined);
      const n = Number(raw);
      return Number.isFinite(n) && raw !== undefined && raw !== '' ? n : fallback;
    };
    const bool = (k: keyof Config, fallback: boolean): boolean => {
      const v = stored.get(k);
      if (v !== undefined) return v === '1' || v === 'true';
      const e = this.env[k] as boolean | undefined;
      return e ?? fallback;
    };
    const list = (k: keyof Config, fallback: string[]): string[] => {
      const v = stored.get(k);
      if (v === undefined) return ((this.env[k] as string[] | undefined) ?? fallback);
      const parsed = v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      // An empty list would silently reject everything, so fall back instead.
      return parsed.length ? parsed : fallback;
    };

    this.cache = {
      sabUrl: str('sabUrl', ''),
      sabKey: str('sabKey', ''),
      sabCategory: str('sabCategory', 'music'),
      prowlarrUrl: str('prowlarrUrl', ''),
      prowlarrKey: str('prowlarrKey', ''),
      formats: list('formats', DEFAULT_FORMATS),
      requireLossless: bool('requireLossless', false),
      losslessMinMbPerTrack: num('losslessMinMbPerTrack', 8),
      losslessMaxMbPerTrack: num('losslessMaxMbPerTrack', 120),
      lossyMinMbPerTrack: num('lossyMinMbPerTrack', 1),
      lossyMaxMbPerTrack: num('lossyMaxMbPerTrack', 25),
      maxTotalMb: num('maxTotalMb', 0),
      disqualify: list('disqualify', DEFAULT_DISQUALIFY),
      maxAttempts: num('maxAttempts', 3),
      stallMinutes: num('stallMinutes', 20),
      dailyAlbumCap: num('dailyAlbumCap', 0),
      maxAlbumsPerRequest: num('maxAlbumsPerRequest', 0),
      qbitUrl: str('qbitUrl', ''),
      qbitUser: str('qbitUser', ''),
      qbitPassword: str('qbitPassword', ''),
      qbitCategory: str('qbitCategory', 'crate'),
      qbitSavePath: str('qbitSavePath', '/downloads/crate-torrents'),
      preferProtocol: str('preferProtocol', 'usenet'),
      minSeeders: num('minSeeders', 2),
      lastfmKey: str('lastfmKey', ''),
      mbMirrorUrl: str('mbMirrorUrl', ''),
      acoustidKey: str('acoustidKey', ''),
      openaiKey: str('openaiKey', ''),
      minSeeds: num('minSeeds', 1),
      warmPages: bool('warmPages', true),
      songCharacteristics: bool('songCharacteristics', false),
      songCharacteristicsSince: num('songCharacteristicsSince', 0),
      artRetentionDays: num('artRetentionDays', 180),
      poolBackfilled: bool('poolBackfilled', false),
    };
    return this.cache;
  }

  /**
   * Write a batch of settings.
   *
   * A blank secret means "leave it alone" rather than "clear it", because the admin
   * form cannot show the current value and therefore cannot round-trip it. Clearing
   * one is done with the explicit clear() below, so it can never happen by accident
   * when somebody saves a form without retyping every key.
   */
  set(values: Partial<Record<keyof Config, string | number | boolean | string[]>>): void {
    const put = this.db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?,?,unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
    );
    const tx = this.db.transaction(() => {
      for (const [k, v] of Object.entries(values)) {
        if (v === undefined) continue;
        if (SECRET_KEYS.includes(k as keyof Config) && (v === '' || v === null)) continue;
        const encoded = Array.isArray(v)
          ? v.join(',')
          : typeof v === 'boolean'
            ? v
              ? '1'
              : '0'
            : String(v);
        put.run(k, encoded);
      }
    });
    tx();
    this.cache = null;
  }

  clear(key: keyof Config): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    this.cache = null;
  }

  /** True when a value has been stored, as opposed to inherited from the environment. */
  isOverridden(key: keyof Config): boolean {
    return (
      this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key) !== undefined
    );
  }

  /**
   * The shape safe to send to a browser: secrets reduced to a hint.
   *
   * Nothing is gained by echoing a working API key back to a page, and something is
   * lost — the key becomes readable by anything that can see a response, including
   * a logged proxy or a browser extension.
   */
  redacted(): Record<string, unknown> {
    const c = this.all();
    const out: Record<string, unknown> = { ...c };
    for (const k of SECRET_KEYS) {
      const v = c[k] as string;
      out[k] = '';
      out[`${k}Set`] = Boolean(v);
      out[`${k}Hint`] = v ? `…${v.slice(-4)}` : '';
      out[`${k}Overridden`] = this.isOverridden(k);
    }
    return out;
  }
}
