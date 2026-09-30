import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { PluginRepo } from '../src/lib/pluginrepo.js';

/**
 * Plugin repositories — several of them, each with its own token.
 *
 * GitHub is replaced by a table of files per repository, so these run offline and can say
 * exactly which repository was asked for what, and with which credentials.
 */

const quiet = { info: () => {}, warn: () => {}, error: () => {} } as never;

type Files = Record<string, string>;

function fakeGitHub(repos: Record<string, Files | 'down'>) {
  const seen: { url: string; auth: string | undefined }[] = [];
  const fetchText = (async (url: string, opts?: { headers?: Record<string, string> }) => {
    seen.push({ url, auth: opts?.headers?.Authorization });
    const m = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/);
    if (!m) throw new Error(`unexpected url ${url}`);
    const files = repos[m[1]!];
    if (!files || files === 'down') throw new Error('HTTP 404');
    const body = files[m[2]!];
    if (body === undefined) throw new Error('HTTP 404');
    return body;
  }) as never;
  return { fetchText, seen };
}

/** A repository offering the given plugins at the given versions. */
function repoOf(plugins: Record<string, string>): Files {
  const files: Files = {
    'index.json': JSON.stringify({
      plugins: Object.entries(plugins).map(([id, version]) => ({
        id,
        name: id,
        version,
        description: `${id} plugin`,
        dir: `plugins/${id}/dist`,
      })),
    }),
  };
  for (const [id, version] of Object.entries(plugins)) {
    files[`plugins/${id}/dist/manifest.json`] = JSON.stringify({
      id,
      name: id,
      version,
      description: `${id} plugin`,
      server: 'server.js',
    });
    files[`plugins/${id}/dist/server.js`] = `export default { id: '${id}' }; // ${version}`;
  }
  return files;
}

describe('the list of repositories', () => {
  let db: Database.Database;
  let dir: string;
  beforeEach(async () => {
    db = new Database(':memory:');
    dir = await mkdtemp(join(tmpdir(), 'crate-plugins-'));
  });

  test('the old single repository and its token carry over, once', () => {
    db.exec('CREATE TABLE plugin_repo (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    db.prepare("INSERT INTO plugin_repo VALUES ('repo', 'someone/crate-plugins'), ('token', 'secret-token-1234')").run();
    const repo = new PluginRepo(db, dir, quiet);
    assert.deepEqual(repo.sources().map((s) => [s.repo, s.token]), [
      ['someone/crate-plugins', { set: true, hint: '…1234' }],
    ]);
    assert.equal(
      (db.prepare("SELECT COUNT(*) n FROM plugin_repo WHERE k IN ('repo','token')").get() as { n: number }).n,
      0,
      'one place a repository is kept, not two',
    );
    new PluginRepo(db, dir, quiet);
    assert.equal(new PluginRepo(db, dir, quiet).sources().length, 1, 'and never twice');
  });

  test('adding checks the shape and refuses a repository already in the list', () => {
    const repo = new PluginRepo(db, dir, quiet);
    repo.addSource('someone/crate-plugins');
    assert.throws(() => repo.addSource('not a repo'), /owner\/name/);
    assert.throws(() => repo.addSource('https://github.com/a/b'), /owner\/name/);
    assert.throws(() => repo.addSource('SomeOne/Crate-Plugins'), /already in the list/);
    repo.addSource('me/my-plugins', 'tok-9876');
    assert.deepEqual(repo.sources().map((s) => [s.repo, s.token.set]), [
      ['someone/crate-plugins', false],
      ['me/my-plugins', true],
    ]);
  });

  test('tokens are reported, never returned, and can be replaced or cleared', () => {
    const repo = new PluginRepo(db, dir, quiet);
    const { id } = repo.addSource('me/private', 'first-token-aaaa');
    assert.equal(JSON.stringify(repo.sources()).includes('first-token'), false);
    repo.setToken(id, 'second-token-bbbb');
    assert.equal(repo.sources()[0]!.token.hint, '…bbbb');
    repo.setToken(id, '');
    assert.equal(repo.sources()[0]!.token.set, false);
    assert.throws(() => repo.setToken(999, 'x'), /no such repository/);
  });
});

describe('catalogs and installing', () => {
  let db: Database.Database;
  let dir: string;
  beforeEach(async () => {
    db = new Database(':memory:');
    dir = await mkdtemp(join(tmpdir(), 'crate-plugins-'));
  });

  test('every repository is read, and one that is down says so without hiding the rest', async () => {
    const gh = fakeGitHub({ 'public/plugins': repoOf({ chords: '1.0.0' }), 'gone/plugins': 'down' });
    const repo = new PluginRepo(db, dir, quiet, gh.fetchText);
    repo.addSource('public/plugins');
    repo.addSource('gone/plugins');
    const cats = await repo.available();
    assert.deepEqual(cats.map((c) => [c.repo, c.plugins.map((p) => p.id), Boolean(c.error)]), [
      ['public/plugins', ['chords'], false],
      ['gone/plugins', [], true],
    ]);
  });

  test("each repository is asked with its own token, and a public one with none", async () => {
    const gh = fakeGitHub({ 'public/plugins': repoOf({}), 'me/private': repoOf({}) });
    const repo = new PluginRepo(db, dir, quiet, gh.fetchText);
    repo.addSource('public/plugins');
    repo.addSource('me/private', 'private-token');
    await repo.available();
    const auth = Object.fromEntries(gh.seen.map((s) => [s.url.split('/')[4] + '/' + s.url.split('/')[5], s.auth]));
    assert.equal(auth['public/plugins'], undefined);
    assert.equal(auth['me/private'], 'Bearer private-token');
  });

  test('an install remembers its repository', async () => {
    const gh = fakeGitHub({ 'public/plugins': repoOf({ chords: '1.4.0' }) });
    const repo = new PluginRepo(db, dir, quiet, gh.fetchText);
    repo.addSource('public/plugins');
    const m = await repo.install('chords', 'public/plugins');
    assert.equal(m.repo, 'public/plugins');
    const onDisk = await repo.installed();
    assert.deepEqual(onDisk.map((p) => [p.id, p.version, p.repo]), [['chords', '1.4.0', 'public/plugins']]);
    assert.match(await readFile(join(dir, 'chords', 'server.js'), 'utf-8'), /1\.4\.0/);
  });

  test('the same plugin in two repositories: named, it installs from that one; unnamed, it asks', async () => {
    const gh = fakeGitHub({
      'public/plugins': repoOf({ youtube: '0.1.2' }),
      'me/fork': repoOf({ youtube: '0.2.0-mine' }),
    });
    const repo = new PluginRepo(db, dir, quiet, gh.fetchText);
    repo.addSource('public/plugins');
    repo.addSource('me/fork');
    await assert.rejects(repo.install('youtube'), /both offer youtube/);
    const m = await repo.install('youtube', 'me/fork');
    assert.equal(m.version, '0.2.0-mine');
    assert.equal(m.repo, 'me/fork');
  });

  test('one repository offering it is enough to install without naming it', async () => {
    const gh = fakeGitHub({ 'public/plugins': repoOf({ chords: '1.4.0' }), 'me/fork': repoOf({ other: '1.0.0' }) });
    const repo = new PluginRepo(db, dir, quiet, gh.fetchText);
    repo.addSource('public/plugins');
    repo.addSource('me/fork');
    assert.equal((await repo.install('chords')).repo, 'public/plugins');
  });

  test('only a repository in the list can be installed from', async () => {
    const gh = fakeGitHub({ 'stranger/plugins': repoOf({ chords: '9.9.9' }) });
    const repo = new PluginRepo(db, dir, quiet, gh.fetchText);
    await assert.rejects(repo.install('chords', 'stranger/plugins'), /not one of the plugin repositories/);
  });

  test('removing a repository leaves what was installed from it', async () => {
    const gh = fakeGitHub({ 'public/plugins': repoOf({ chords: '1.4.0' }) });
    const repo = new PluginRepo(db, dir, quiet, gh.fetchText);
    const { id } = repo.addSource('public/plugins');
    await repo.install('chords', 'public/plugins');
    repo.removeSource(id);
    assert.deepEqual(repo.sources(), []);
    assert.deepEqual(await readdir(join(dir, 'chords')), ['manifest.json', 'server.js']);
  });
});
