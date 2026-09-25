import type Database from 'better-sqlite3';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { UserLibrary } from './userlib.js';
import type { Notifier } from './notify.js';
import type { getBytes, getJson, getText } from './http.js';
import type { SimilarityResult } from './similarity.js';
import type { IngestInput, IngestResult } from './ingest.js';
import { pathToFileURL } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger as Logger } from 'fastify';

/**
 * Compiled-in plugins: a feature as a folder, enabled by one registry line.
 *
 * The chord-sheets feature proved what a self-contained feature costs under the old shape:
 * eight shared files touched in twenty-five places — DDL spliced into schema.ts's template
 * literal, construction in main.ts, deps threaded through two route modules, eleven sites in
 * App.tsx. Every future feature of that shape would pay the same tax. A plugin pays it once,
 * here, and then each feature is a directory under src/plugins/ plus one line in
 * src/plugins/index.ts.
 *
 * COMPILED IN is the deliberate half of the name. These are not loadable at runtime: the client
 * is one Vite bundle baked at image build, the runtime image has no compiler and only /data
 * writable, and tsc typechecks every plugin against the real interfaces on every build. A
 * broken plugin is a build failure, not a deployment surprise. "Install a plugin" therefore
 * means "add a folder and rebuild", which for a homelab app with one image is the honest
 * trade — a runtime loader would buy nothing but risk.
 *
 * The contract is deliberately small. A plugin gets exactly the things it cannot import
 * because they are instances constructed in main.ts or closures private to api.ts; everything
 * else — the http helpers, the parser it owns, node built-ins — it imports like any other
 * module, because it IS any other module.
 */

/** What the session guard identifies. Mirrors the caller shape api.ts produces. */
export interface PluginCaller {
  /** Row id, or null for the API-key caller, which is not a user. */
  id: number | null;
  user: string;
  name: string;
  isAdmin: boolean;
  viaToken: boolean;
}

export interface PluginContext {
  /** The one database. A plugin owns its own tables; core tables are read via userlib. */
  db: Database.Database;
  /** Track existence and ownership checks — the questions every per-track feature asks. */
  userlib: UserLibrary;
  log: FastifyBaseLogger;
  /**
   * The session guard, already bound to the cookie/bearer logic in api.ts. It has already
   * replied 401 when it returns null, so a handler simply returns.
   */
  need: (req: FastifyRequest, reply: FastifyReply) => PluginCaller | null;
  /**
   * crate's IPv4-pinned HTTP helpers (this estate has no IPv6 egress, so plain fetch fails).
   * Compiled-in plugins could import lib/http directly; INSTALLED plugins cannot import from
   * the crate tree at all — their bundle is self-contained and this context is their whole
   * world — so the helpers ride along here for both kinds.
   */
  http: {
    getText: typeof getText;
    getJson: typeof getJson;
    getBytes: typeof getBytes;
  };
  /**
   * Subscribe to the app's events — the same names the webhook system fans out
   * (request.fulfilled, library.scanned, …; see lib/notify.ts EVENTS). Listeners run
   * synchronously at emit and a throw is contained: a plugin can observe the pipeline, it
   * cannot break it.
   */
  events: Pick<Notifier, 'on'>;
  /**
   * Song characteristics, read-only, plus the distance maths over them.
   *
   * Here rather than importable because an INSTALLED plugin's bundle is self-contained and
   * cannot reach the crate tree — and because the alternative is every consumer reimplementing
   * a weighted Euclidean distance slightly differently, which is exactly what lib/similarity.ts
   * exists to prevent. A plugin gets the primitive, not the table.
   *
   * `enabled` is the feature switch: false means no track has a profile worth asking about, and
   * a caller should fall back to whatever it did before rather than treating an empty vector as
   * a statement.
   */
  characteristics: {
    enabled(): boolean;
    /** Active characteristic keys, so a caller can build a target profile in the right space. */
    keys(): string[];
    /** One track's merged AI+manual vector, or null when it has never been analysed. */
    vectorOf(trackId: number): Map<string, number> | null;
    /** How close every analysed track is to a target profile. One pass, cached vectors. */
    scoreAgainst(profile: Record<string, number>): Map<number, number>;
    /** The full comparison, with the closest dimensions and the biggest differences. */
    compareToProfile(trackId: number, profile: Record<string, number>): SimilarityResult;
  };
  /**
   * Put a file into the library, for someone. The same dedupe-move-index-override-own sequence
   * the upload route uses (see lib/ingest.ts), so a plugin that fetches songs cannot get the
   * order wrong. The file is MOVED.
   */
  library: {
    ingest(input: IngestInput, userId: number): Promise<IngestResult>;
  };
  /**
   * A writable directory that belongs to this plugin alone, under /data. The runtime image has
   * nowhere else to write, and a plugin that needs a tool, a cache or a staging area needs
   * somewhere that survives a container rebuild.
   */
  dataDir: string;
  /**
   * This plugin's own settings, as declared in CratePlugin.settings and set on the admin
   * plugin page. Read-only from the plugin's side: settings are the admin's decisions, and a
   * plugin writing its own would make the admin page lie.
   */
  settings: {
    get(key: string): string | number | boolean | undefined;
  };
}

/** One song an external source can offer. `key` is the source's own id for it. */
export interface ExternalHit {
  key: string;
  title: string;
  artist: string;
  album?: string;
  durationS?: number;
  coverUrl?: string;
  /** The source's own confidence, higher is better. Only used to order one source's hits. */
  score?: number;
}

/** Where the audio for a song lives right now. Core proxies it; the plugin never touches HTTP. */
export interface ExternalStream {
  url: string;
  mime: string;
  headers?: Record<string, string>;
  sizeBytes?: number;
  /** Epoch seconds after which the URL stops working, so core knows how long to reuse it. */
  expiresAt?: number;
}

/** A song fetched to a local file, ready for ctx.library.ingest. */
export interface ExternalAcquired {
  file: string;
  artist: string;
  title: string;
  album?: string;
  trackNo?: number;
}

/**
 * A place songs can come from that is not the library — YouTube, and whatever follows it.
 *
 * The split is deliberate: the plugin answers four questions (find this, describe this, where
 * is its audio, fetch it to a file) and core does everything a person or a client can see —
 * the ids, authentication, Range, transcoding, when to fall back, when a listen counts, the
 * import, the caps. That keeps every source behaving identically from the outside, and keeps
 * the parts that must be right exactly once (auth, the Subsonic protocol) out of plugin code.
 */
export interface ExternalSource {
  /** The <source> in x-<source>-<key>. Short, stable, [a-z0-9]. Changing it orphans every id. */
  id: string;
  /** How the web search labels this source's section: "Not in your library — from YouTube". */
  label: string;
  search(q: string, limit: number): Promise<ExternalHit[]>;
  describe(key: string): Promise<ExternalHit | null>;
  resolveStream(key: string): Promise<ExternalStream>;
  acquire(key: string, hit: ExternalHit): Promise<ExternalAcquired>;
}

/** One setting a plugin declares; the admin plugin page renders these generically. */
export interface PluginSettingDef {
  key: string;
  label: string;
  type: 'boolean' | 'string' | 'number' | 'secret';
  default?: string | number | boolean;
  hint?: string;
}

/**
 * Which plugins are switched on, from the admin portal.
 *
 * A plugin is compiled in — the code always ships — so "disabled" is a runtime gate, not an
 * absence: its routes answer 404, its UI slots render nothing, its data sits untouched in its
 * tables until it is switched back on. The state is a row per plugin so it survives restarts
 * and rebuilds, and unknown ids default to ENABLED — adding a plugin to the registry turns it
 * on, which is what adding it means.
 *
 * Owned by the framework, DDL included, because this table is about plugins as a category;
 * no individual plugin could own it.
 */
export class PluginState {
  /** One process, admin-frequency writes: read through a Map, like Settings does. */
  private cache = new Map<string, boolean>();

  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_state (
        id         TEXT PRIMARY KEY,
        enabled    INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
    `);
    const rows = db.prepare('SELECT id, enabled FROM plugin_state').all() as {
      id: string;
      enabled: number;
    }[];
    for (const r of rows) this.cache.set(r.id, Boolean(r.enabled));
  }

  isEnabled(id: string): boolean {
    return this.cache.get(id) ?? true;
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO plugin_state (id, enabled, updated_at) VALUES (?, ?, unixepoch())
         ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
      )
      .run(id, enabled ? 1 : 0);
    this.cache.set(id, enabled);
  }
}

/**
 * Plugin ids that have GRADUATED into core features and must never load as plugins again.
 *
 * The problem this solves is a boot failure, not a cosmetic one: a graduated feature's native
 * routes register at the same paths the old plugin used (deliberately — deployed clients call
 * them), and Fastify throws on a duplicate route at boot. A stale installed copy left in the
 * plugins directory would therefore take the whole server down. main.ts skips these ids with a
 * warning instead; deleting the directory is a deploy step, never something boot does.
 *
 * - intelligent-shuffle: the DJ, native since the /api/ishuffle routes moved to routes/dj.ts.
 */
export const RETIRED_PLUGIN_IDS = new Set(['intelligent-shuffle']);

export interface CratePlugin {
  /**
   * Short, stable, kebab-safe. It is the plugin's identity everywhere: the client uses the
   * same id for UI slots and URLs, so renaming one after it ships breaks bookmarks.
   */
  id: string;

  /**
   * The plugin's own DDL, run at boot after the core schema.
   *
   * Same rules the core follows (see db/schema.ts): idempotent — CREATE TABLE IF NOT EXISTS
   * plus PRAGMA table_info probes for later columns — because it runs unconditionally on
   * every start. A plugin creates only its own tables and never alters a core one; the core
   * cannot know what a plugin added, so anything else would be unowned schema.
   */
  migrate?(db: Database.Database): void;

  /**
   * Register routes. Paths are absolute and by convention live under /api/.
   *
   * Absolute rather than auto-prefixed with the plugin id, because the first plugin was
   * carved out of existing code and its URLs were already public — /api/track/:id/chords is
   * in deployed clients and cannot move. Fastify throws on a duplicate route at boot, which
   * is the collision guard a prefix would otherwise provide.
   */
  routes?(app: FastifyInstance, ctx: PluginContext): void;

  /**
   * Offer songs from outside the library. A factory rather than an object because a source
   * needs its context — its data directory, its settings — to exist at all.
   */
  source?(ctx: PluginContext): ExternalSource;

  /** Settings the admin can change on this plugin's page. */
  settings?: PluginSettingDef[];
}

/**
 * Per-plugin settings, as the admin set them.
 *
 * Framework-owned for the same reason plugin_state is: it is about plugins as a category.
 * Values are stored as text and coerced on read by the plugin's declared type, so a schema
 * change (a string setting becoming a number) cannot leave a value the plugin chokes on — it
 * reads back as the default instead.
 */
export class PluginSettings {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_settings (
        plugin_id  TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (plugin_id, key)
      );
    `);
  }

  private raw(pluginId: string): Map<string, string> {
    const rows = this.db
      .prepare('SELECT key, value FROM plugin_settings WHERE plugin_id = ?')
      .all(pluginId) as { key: string; value: string }[];
    return new Map(rows.map((r) => [r.key, r.value]));
  }

  /** Every declared setting with its current value — secrets included; callers redact. */
  values(plugin: Pick<CratePlugin, 'id' | 'settings'>): Record<string, string | number | boolean> {
    const stored = this.raw(plugin.id);
    const out: Record<string, string | number | boolean> = {};
    for (const def of plugin.settings ?? []) out[def.key] = coerce(def, stored.get(def.key));
    return out;
  }

  /** What an admin page may see: secrets blanked to "set or not", like core settings. */
  redacted(plugin: Pick<CratePlugin, 'id' | 'settings'>): Record<string, unknown> {
    const v = this.values(plugin);
    const out: Record<string, unknown> = {};
    for (const def of plugin.settings ?? []) {
      if (def.type === 'secret') {
        out[def.key] = '';
        out[`${def.key}Set`] = Boolean(v[def.key]);
      } else {
        out[def.key] = v[def.key];
      }
    }
    return out;
  }

  /** Only declared keys are written; an empty secret means "keep the stored one". */
  set(plugin: Pick<CratePlugin, 'id' | 'settings'>, patch: Record<string, unknown>): void {
    const defs = new Map((plugin.settings ?? []).map((d) => [d.key, d]));
    const stmt = this.db.prepare(
      `INSERT INTO plugin_settings (plugin_id, key, value, updated_at) VALUES (?,?,?,unixepoch())
       ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    for (const [k, v] of Object.entries(patch)) {
      const def = defs.get(k);
      if (!def) continue;
      if (def.type === 'secret' && (v === '' || v === null || v === undefined)) continue;
      stmt.run(plugin.id, k, def.type === 'boolean' ? (v === true || v === 'true' || v === '1' ? '1' : '0') : String(v));
    }
  }

  /** The read-only view a plugin's context carries. */
  scoped(plugin: Pick<CratePlugin, 'id' | 'settings'>): PluginContext['settings'] {
    return { get: (key) => this.values(plugin)[key] };
  }
}

function coerce(def: PluginSettingDef, raw: string | undefined): string | number | boolean {
  const fallback = def.default ?? (def.type === 'boolean' ? false : def.type === 'number' ? 0 : '');
  if (raw === undefined) return fallback;
  if (def.type === 'boolean') return raw === '1' || raw === 'true';
  if (def.type === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
  return raw;
}

/**
 * Load the server halves of installed plugins from PLUGIN_DIR.
 *
 * Each installed plugin is a directory holding a manifest and a self-contained server.js that
 * default-exports a CratePlugin. Loaded with dynamic import at boot — the one moment routes
 * can still be registered — and every failure is contained: a plugin that does not parse, does
 * not export the right shape, or lies about its id is logged and SKIPPED, because a broken
 * download must degrade to "that feature is missing", never to "crate does not start".
 */
export async function loadDynamicPlugins(
  dir: string,
  log: Logger,
): Promise<CratePlugin[]> {
  const out: CratePlugin[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out; // No directory yet: nothing installed, nothing to do.
  }
  for (const id of entries.sort()) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) continue;
    try {
      const manifest = JSON.parse(await readFile(join(dir, id, 'manifest.json'), 'utf-8')) as {
        id: string;
        server?: string;
      };
      if (manifest.id !== id) throw new Error(`manifest id "${manifest.id}" != directory "${id}"`);
      if (!manifest.server) continue; // Client-only plugin: nothing for this side to load.
      const mod = (await import(pathToFileURL(join(dir, id, manifest.server)).href)) as {
        default?: CratePlugin;
      };
      const plugin = mod.default;
      if (!plugin || plugin.id !== id) {
        throw new Error('server.js must default-export a CratePlugin whose id matches');
      }
      out.push(plugin);
      log.info({ plugin: id }, 'installed plugin loaded');
    } catch (err) {
      log.warn({ plugin: id, err: String(err) }, 'installed plugin failed to load — skipped');
    }
  }
  return out;
}
