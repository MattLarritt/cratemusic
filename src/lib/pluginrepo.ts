import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import { getText } from './http.js';

/**
 * Installing plugins from a GitHub repository, from inside crate.
 *
 * The repo (crate-plugins) holds PRE-BUILT artifacts — crate's runtime image has no compiler,
 * so "install" is honest-to-goodness download-and-run: index.json names the plugins, each
 * plugin's dist/ holds at most four files (manifest.json, server.js, client.js, style.css),
 * and installing copies them into PLUGIN_DIR/<id>/. The server half is picked up at the next
 * restart (Fastify cannot add routes to a running server); the client half is served to the
 * SPA and import()ed at page load.
 *
 * The GitHub contents API is used with Accept: application/vnd.github.raw — one authenticated
 * GET per file, which for a private repo needs a token. The token lives in the framework's own
 * table, is returned to the admin page only as "set, ending …xxxx", and is never logged.
 */

/** Plugin ids become directory names and URL segments; nothing else is allowed in. */
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** GitHub repo slugs, so a typo cannot turn into a surprising URL. */
const SAFE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface CatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Path of the plugin's dist/ inside the repo. */
  dir: string;
}

export interface InstalledManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  server?: string;
  client?: string;
  css?: string;
}

export class PluginRepo {
  constructor(
    private db: Database.Database,
    private dir: string,
    private log: FastifyBaseLogger,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_repo (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
    `);
  }

  // ---- source configuration ------------------------------------------------

  private kv(k: string): string {
    const r = this.db.prepare('SELECT v FROM plugin_repo WHERE k = ?').get(k) as
      | { v: string }
      | undefined;
    return r?.v ?? '';
  }

  private setKv(k: string, v: string): void {
    this.db
      .prepare('INSERT INTO plugin_repo (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(k, v);
  }

  repo(): string {
    return this.kv('repo');
  }

  /** For the admin page: whether a token exists and its tail, never the token. */
  tokenState(): { set: boolean; hint: string } {
    const t = this.kv('token');
    return { set: Boolean(t), hint: t.length > 4 ? `…${t.slice(-4)}` : '' };
  }

  setSource(repo: string, token?: string): void {
    if (repo && !SAFE_REPO.test(repo)) throw new Error('repository must look like owner/name');
    this.setKv('repo', repo);
    // Absent means "keep what is stored" so saving the repo name does not wipe the token;
    // an explicit empty string is how the token is deliberately cleared.
    if (token !== undefined) this.setKv('token', token);
  }

  // ---- the repo ------------------------------------------------------------

  /** One file from the repo, as text. Raw contents API: one GET per file. */
  private async fetch(path: string): Promise<string> {
    const repo = this.repo();
    if (!repo) throw new Error('no plugin repository configured');
    const token = this.kv('token');
    return getText(`https://api.github.com/repos/${repo}/contents/${path}`, {
      timeoutMs: 20_000,
      headers: {
        Accept: 'application/vnd.github.raw+json',
        // GitHub's API refuses requests without a User-Agent.
        'User-Agent': 'crate-plugin-installer',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  }

  /** The catalog: what the repo offers. */
  async available(): Promise<CatalogEntry[]> {
    const raw = JSON.parse(await this.fetch('index.json')) as { plugins?: CatalogEntry[] };
    const list = Array.isArray(raw.plugins) ? raw.plugins : [];
    // Only entries a directory name can be built from; anything else is a repo mistake.
    return list.filter((p) => SAFE_ID.test(String(p.id ?? '')));
  }

  /**
   * Download one plugin's dist/ into PLUGIN_DIR/<id>/.
   *
   * Staged through <id>.staging and renamed into place, so a failed download — network drop,
   * missing file, bad manifest — leaves either the old version or nothing, never half a
   * plugin. The manifest names the files; only those are fetched, and only into names the
   * manifest itself declares.
   */
  async install(id: string): Promise<InstalledManifest> {
    if (!SAFE_ID.test(id)) throw new Error('not a valid plugin id');
    const entry = (await this.available()).find((p) => p.id === id);
    if (!entry) throw new Error(`the repository does not offer a plugin called ${id}`);

    const manifest = JSON.parse(await this.fetch(`${entry.dir}/manifest.json`)) as InstalledManifest;
    if (manifest.id !== id) throw new Error(`manifest id "${manifest.id}" does not match ${id}`);

    const staging = join(this.dir, `${id}.staging`);
    const final = join(this.dir, id);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });

    for (const file of [manifest.server, manifest.client, manifest.css].filter(
      (f): f is string => Boolean(f),
    )) {
      // The manifest declares plain file names; a path would be it trying to escape its dir.
      if (!/^[A-Za-z0-9._-]+$/.test(file)) throw new Error(`manifest names a suspicious file: ${file}`);
      const body = await this.fetch(`${entry.dir}/${file}`);
      await writeFile(join(staging, file), body, 'utf-8');
    }
    // The manifest lands last: its presence is what marks a directory as installed.
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

    await rm(final, { recursive: true, force: true });
    await rename(staging, final);
    this.log.info({ plugin: id, version: manifest.version }, 'plugin installed');
    return manifest;
  }

  /** Remove an installed plugin's files. Its tables and data are deliberately untouched. */
  async uninstall(id: string): Promise<void> {
    if (!SAFE_ID.test(id)) throw new Error('not a valid plugin id');
    await rm(join(this.dir, id), { recursive: true, force: true });
    this.log.info({ plugin: id }, 'plugin uninstalled');
  }

  /** What is on disk right now, regardless of what is loaded into the running process. */
  async installed(): Promise<InstalledManifest[]> {
    const out: InstalledManifest[] = [];
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return out;
    }
    for (const e of entries) {
      if (!SAFE_ID.test(e)) continue;
      try {
        out.push(JSON.parse(await readFile(join(this.dir, e, 'manifest.json'), 'utf-8')));
      } catch {
        // A directory without a readable manifest is a failed install; ignore it.
      }
    }
    return out;
  }
}
