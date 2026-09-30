import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import { getText } from './http.js';

/**
 * Installing plugins from GitHub repositories, from inside crate.
 *
 * A repository (crate-plugins, or anybody's) holds PRE-BUILT artifacts — crate's runtime image
 * has no compiler, so "install" is honest-to-goodness download-and-run: index.json names the
 * plugins, each plugin's dist/ holds at most four files (manifest.json, server.js, client.js,
 * style.css), and installing copies them into PLUGIN_DIR/<id>/. The server half is picked up
 * at the next restart (Fastify cannot add routes to a running server); the client half is
 * served to the SPA and import()ed at page load.
 *
 * SEVERAL repositories can be configured — the public one, a fork, a private one of your own —
 * each with its own token or none. Their catalogs are read side by side; each is fetched on its
 * own, so one that is down or mistyped reports its own error and hides nothing else. An
 * installed plugin remembers which repository it came from (in the manifest crate writes into
 * its directory), so "Update" means an update from THAT repository, not whichever happens to
 * list the same id with a bigger number.
 *
 * The GitHub contents API is used with Accept: application/vnd.github.raw — one GET per file,
 * which for a private repo needs a token. Tokens live in the framework's own table, are
 * returned to the admin page only as "set, ending …xxxx", and are never logged.
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
  /**
   * The repository it was installed from, as owner/name. Written by crate at install time;
   * absent on installs from before crate could hold more than one repository.
   */
  repo?: string;
}

export interface RepoSource {
  id: number;
  repo: string;
  /** Whether a token exists and its tail — never the token. */
  token: { set: boolean; hint: string };
}

/** One repository's catalog, or why it could not be read. */
export interface RepoCatalog {
  repo: string;
  plugins: CatalogEntry[];
  error?: string;
}

type FetchText = typeof getText;

export class PluginRepo {
  constructor(
    private db: Database.Database,
    private dir: string,
    private log: FastifyBaseLogger,
    /** The HTTP fetch, swappable so tests need no network. */
    private fetchText: FetchText = getText,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_repo (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
      -- Every repository plugins can be installed from. The token is per repository: a public
      -- one needs none, a private one needs its own.
      CREATE TABLE IF NOT EXISTS plugin_repos (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        repo     TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        token    TEXT    NOT NULL DEFAULT '',
        added_at INTEGER NOT NULL
      );
    `);
    this.migrateSingleSource();
  }

  /**
   * crate used to hold ONE repository, as two key/value rows. Carry it (and its token) into
   * the list once, then drop the rows so there is only ever one place a repository is kept.
   */
  private migrateSingleSource(): void {
    const kv = (k: string) =>
      (this.db.prepare('SELECT v FROM plugin_repo WHERE k = ?').get(k) as { v: string } | undefined)?.v ?? '';
    const repo = kv('repo');
    if (!repo && !kv('token')) return;
    this.db.transaction(() => {
      if (repo && SAFE_REPO.test(repo)) {
        this.db
          .prepare('INSERT OR IGNORE INTO plugin_repos (repo, token, added_at) VALUES (?, ?, unixepoch())')
          .run(repo, kv('token'));
      }
      this.db.prepare("DELETE FROM plugin_repo WHERE k IN ('repo', 'token')").run();
    })();
  }

  // ---- the list of repositories ----------------------------------------------

  private rows(): { id: number; repo: string; token: string }[] {
    return this.db.prepare('SELECT id, repo, token FROM plugin_repos ORDER BY id').all() as {
      id: number;
      repo: string;
      token: string;
    }[];
  }

  private static tokenState(t: string): { set: boolean; hint: string } {
    return { set: Boolean(t), hint: t.length > 4 ? `…${t.slice(-4)}` : '' };
  }

  /** For the admin page. Tokens are reported as set-or-not and their last four characters. */
  sources(): RepoSource[] {
    return this.rows().map((r) => ({ id: r.id, repo: r.repo, token: PluginRepo.tokenState(r.token) }));
  }

  addSource(repo: string, token = ''): RepoSource {
    const name = repo.trim();
    if (!SAFE_REPO.test(name)) throw new Error('repository must look like owner/name');
    if (this.rows().some((r) => r.repo.toLowerCase() === name.toLowerCase())) {
      throw new Error(`${name} is already in the list`);
    }
    const id = Number(
      this.db
        .prepare('INSERT INTO plugin_repos (repo, token, added_at) VALUES (?, ?, unixepoch())')
        .run(name, token.trim()).lastInsertRowid,
    );
    return this.sources().find((s) => s.id === id)!;
  }

  /** Replace a repository's token; an empty string clears it. */
  setToken(id: number, token: string): void {
    const r = this.db.prepare('UPDATE plugin_repos SET token = ? WHERE id = ?').run(token.trim(), id);
    if (!r.changes) throw new Error('no such repository');
  }

  /** Stop offering a repository's plugins. What was installed from it stays installed. */
  removeSource(id: number): void {
    const r = this.db.prepare('DELETE FROM plugin_repos WHERE id = ?').run(id);
    if (!r.changes) throw new Error('no such repository');
  }

  // ---- reading a repository ---------------------------------------------------

  /** One file from a repository, as text. Raw contents API: one GET per file. */
  private async fetch(repo: string, path: string): Promise<string> {
    const row = this.rows().find((r) => r.repo.toLowerCase() === repo.toLowerCase());
    if (!row) throw new Error(`${repo} is not one of the plugin repositories`);
    return this.fetchText(`https://api.github.com/repos/${row.repo}/contents/${path}`, {
      timeoutMs: 20_000,
      headers: {
        Accept: 'application/vnd.github.raw+json',
        // GitHub's API refuses requests without a User-Agent.
        'User-Agent': 'crate-plugin-installer',
        ...(row.token ? { Authorization: `Bearer ${row.token}` } : {}),
      },
    });
  }

  /** What one repository offers. */
  private async catalogOf(repo: string): Promise<CatalogEntry[]> {
    const raw = JSON.parse(await this.fetch(repo, 'index.json')) as { plugins?: CatalogEntry[] };
    const list = Array.isArray(raw.plugins) ? raw.plugins : [];
    // Only entries a directory name can be built from; anything else is a repo mistake.
    return list.filter((p) => SAFE_ID.test(String(p.id ?? '')));
  }

  /**
   * Every repository's catalog, side by side, in the order they were added. Read in parallel
   * and failing separately: a repository that is down, private without a token, or mistyped
   * says so on its own row.
   */
  async available(): Promise<RepoCatalog[]> {
    return Promise.all(
      this.rows().map(async (r): Promise<RepoCatalog> => {
        try {
          return { repo: r.repo, plugins: await this.catalogOf(r.repo) };
        } catch (err) {
          return { repo: r.repo, plugins: [], error: (err as Error).message };
        }
      }),
    );
  }

  /**
   * Download one plugin's dist/ into PLUGIN_DIR/<id>/.
   *
   * Staged through <id>.staging and renamed into place, so a failed download — network drop,
   * missing file, bad manifest — leaves either the old version or nothing, never half a
   * plugin. The manifest names the files; only those are fetched, and only into names the
   * manifest itself declares.
   */
  async install(id: string, repo?: string): Promise<InstalledManifest> {
    if (!SAFE_ID.test(id)) throw new Error('not a valid plugin id');
    const from = repo ?? (await this.onlySourceOf(id));
    const entry = (await this.catalogOf(from)).find((p) => p.id === id);
    if (!entry) throw new Error(`${from} does not offer a plugin called ${id}`);

    const fetched = JSON.parse(await this.fetch(from, `${entry.dir}/manifest.json`)) as InstalledManifest;
    if (fetched.id !== id) throw new Error(`manifest id "${fetched.id}" does not match ${id}`);
    // Where it came from travels with it, so an update is looked for in the same place.
    const manifest: InstalledManifest = { ...fetched, repo: this.rows().find((r) => r.repo.toLowerCase() === from.toLowerCase())!.repo };

    const staging = join(this.dir, `${id}.staging`);
    const final = join(this.dir, id);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });

    for (const file of [manifest.server, manifest.client, manifest.css].filter(
      (f): f is string => Boolean(f),
    )) {
      // The manifest declares plain file names; a path would be it trying to escape its dir.
      if (!/^[A-Za-z0-9._-]+$/.test(file)) throw new Error(`manifest names a suspicious file: ${file}`);
      const body = await this.fetch(from, `${entry.dir}/${file}`);
      await writeFile(join(staging, file), body, 'utf-8');
    }
    // The manifest lands last: its presence is what marks a directory as installed.
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

    await rm(final, { recursive: true, force: true });
    await rename(staging, final);
    this.log.info({ plugin: id, version: manifest.version, repo: manifest.repo }, 'plugin installed');
    return manifest;
  }

  /**
   * The repository to install a plugin from when the caller did not say: the one that offers
   * it, if exactly one does. Two that both offer it is a choice for a person, not a guess.
   */
  private async onlySourceOf(id: string): Promise<string> {
    const offering = (await this.available()).filter((c) => c.plugins.some((p) => p.id === id));
    if (offering.length === 1) return offering[0]!.repo;
    if (!offering.length) throw new Error(`no plugin repository offers a plugin called ${id}`);
    throw new Error(`${offering.map((c) => c.repo).join(' and ')} both offer ${id} — say which`);
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
