import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import { open } from '../src/db/schema.js';
import { Library } from '../src/lib/library.js';
import { UserLibrary } from '../src/lib/userlib.js';
import { Ingester, SINGLES_ALBUM } from '../src/lib/ingest.js';
import { matchWords, wordsOf } from '../src/lib/songmatch.js';
import { PluginSettings, type CratePlugin } from '../src/lib/plugin.js';

/**
 * The smaller pieces the external-source hooks rest on: the word matcher that stops a song you
 * own losing to YouTube, plugin settings, and the single-file ingest a kept song lands through.
 */

const quiet = { warn() {}, info() {}, error() {}, debug() {} } as unknown as FastifyBaseLogger;

describe('matchWords — a spoken request finds a song you own', () => {
  const lib = [
    { title: 'Song 2', artistName: 'Blur', albumArtistName: 'Blur', albumTitle: 'Blur' },
    { title: 'Parklife', artistName: 'Blur', albumArtistName: 'Blur', albumTitle: 'Parklife' },
    { title: 'Numb', artistName: 'Linkin Park', albumArtistName: 'Linkin Park', albumTitle: 'Meteora' },
    { title: 'Blur', artistName: 'Stone Sour', albumArtistName: 'Stone Sour', albumTitle: 'Song 2 Sessions' },
  ];

  test('title and artist run together, as people say them', () => {
    assert.equal(matchWords(lib, 'song 2 by blur')[0]?.title, 'Song 2');
    assert.equal(matchWords(lib, 'numb linkin park')[0]?.title, 'Numb');
  });

  test('the song whose TITLE holds the words ranks first', () => {
    // "Blur" by Stone Sour on an album called "Song 2 Sessions" also contains every word;
    // it must not beat the song actually called Song 2.
    const hits = matchWords(lib, 'song 2 blur');
    assert.deepEqual(hits.map((h) => h.title), ['Song 2', 'Blur']);
  });

  test('whole words only, so a short word does not match inside another', () => {
    assert.deepEqual(matchWords(lib, 'park life'), [], '"park" is not the word "parklife"');
  });

  test('a word that is nowhere means no match, not a partial one', () => {
    assert.deepEqual(matchWords(lib, 'song 2 by oasis'), []);
  });

  test('filler words are dropped, unless there is nothing else', () => {
    assert.deepEqual(wordsOf('Song 2 by Blur'), ['song', '2', 'blur']);
    assert.deepEqual(wordsOf('The The'), ['the', 'the'], 'a band called The The keeps its name');
  });

  test('an empty query matches nothing', () => {
    assert.deepEqual(matchWords(lib, '   '), []);
  });
});

describe('PluginSettings', () => {
  let db: Database.Database;
  let ps: PluginSettings;
  const plugin: Pick<CratePlugin, 'id' | 'settings'> = {
    id: 'youtube',
    settings: [
      { key: 'maxResults', label: 'Results', type: 'number', default: 5 },
      { key: 'safe', label: 'Safe', type: 'boolean', default: true },
      { key: 'token', label: 'Token', type: 'secret' },
    ],
  };

  beforeEach(() => {
    db = open(':memory:');
    ps = new PluginSettings(db);
  });

  test('unset settings read back as their declared defaults', () => {
    assert.deepEqual(ps.values(plugin), { maxResults: 5, safe: true, token: '' });
  });

  test('values come back as their declared type', () => {
    ps.set(plugin, { maxResults: '8', safe: false });
    assert.deepEqual(ps.scoped(plugin).get('maxResults'), 8);
    assert.equal(ps.scoped(plugin).get('safe'), false);
  });

  test('a secret is never shown, only whether it is set', () => {
    ps.set(plugin, { token: 'abc123' });
    const shown = ps.redacted(plugin);
    assert.equal(shown.token, '');
    assert.equal(shown.tokenSet, true);
    assert.equal(ps.scoped(plugin).get('token'), 'abc123', 'the plugin itself can read it');
  });

  test('an empty secret keeps the stored one', () => {
    // The form never receives a secret, so an untouched field arrives empty.
    ps.set(plugin, { token: 'abc123' });
    ps.set(plugin, { token: '' });
    assert.equal(ps.scoped(plugin).get('token'), 'abc123');
  });

  test('keys the plugin did not declare are ignored', () => {
    ps.set(plugin, { somethingElse: 'x' } as Record<string, unknown>);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM plugin_settings').get() as { n: number }).n, 0);
  });

  test('a stored value that no longer fits its type reads as the default', () => {
    db.prepare("INSERT INTO plugin_settings VALUES ('youtube','maxResults','lots',1)").run();
    assert.equal(ps.scoped(plugin).get('maxResults'), 5);
  });

  test("plugins do not see each other's settings", () => {
    ps.set(plugin, { maxResults: 9 });
    assert.equal(ps.scoped({ ...plugin, id: 'other' }).get('maxResults'), 5);
  });
});

/** A valid, silent, one-second 8 kHz mono WAV: enough for the tag reader to index it. */
function silentWav(): Buffer {
  const samples = 8000;
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples * 2, 40);
  return b;
}

describe('Ingester — one kept song into the library', () => {
  let dir: string;
  let db: Database.Database;
  let userlib: UserLibrary;
  let ingester: Ingester;
  let events: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crate-ingest-'));
    await mkdir(join(dir, 'music'));
    await mkdir(join(dir, 'staging'));
    db = open(':memory:');
    db.prepare('INSERT INTO users (id,username,password_hash,is_admin,enabled,created_at) VALUES (1,?,?,0,1,1)').run('u1', 'x');
    db.prepare('INSERT INTO users (id,username,password_hash,is_admin,enabled,created_at) VALUES (2,?,?,0,1,1)').run('u2', 'x');
    userlib = new UserLibrary(db);
    events = [];
    ingester = new Ingester({
      musicRoot: join(dir, 'music'),
      library: new Library(db),
      userlib,
      acoustid: { enabled: () => false } as never,
      recommender: { invalidateAll() {} } as never,
      notifier: { emit: (e: string) => void events.push(e) } as never,
      log: quiet,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const stage = async (name: string) => {
    const f = join(dir, 'staging', name);
    await writeFile(f, silentWav());
    return f;
  };

  test('files an albumless song under Artist/Singles, owned by the person who kept it', async () => {
    const file = await stage('aaaaaaaaaaa.wav');
    const r = await ingester.ingest({ file, artist: 'Blur', title: 'Song 2' }, 1);
    assert.equal(r.adopted, false);
    assert.equal(r.album, SINGLES_ALBUM);
    assert.deepEqual(await readdir(join(dir, 'music', 'Blur', 'Singles')), ['Song 2.wav']);
    assert.ok(userlib.has(1, r.trackId));
    assert.equal(userlib.byId(r.trackId)?.title, 'Song 2', 'the identity it was given, not the filename');
    assert.deepEqual(events, ['library.external']);
  });

  test('moves the file rather than copying it', async () => {
    const file = await stage('bbbbbbbbbbb.wav');
    await ingester.ingest({ file, artist: 'Blur', title: 'Song 2' }, 1);
    await assert.rejects(access(file), 'the staging copy is gone');
  });

  test('uses the album and track number when the source knows them', async () => {
    const file = await stage('c.wav');
    await ingester.ingest({ file, artist: 'Blur', title: 'Song 2', album: 'Blur', trackNo: 2 }, 1);
    assert.deepEqual(await readdir(join(dir, 'music', 'Blur', 'Blur')), ['02. Song 2.wav']);
  });

  test('a song already on disk is granted, and the download dropped', async () => {
    const first = await ingester.ingest({ file: await stage('d.wav'), artist: 'Blur', title: 'Song 2' }, 1);
    const second = await ingester.ingest({ file: await stage('e.wav'), artist: 'blur', title: 'SONG 2' }, 2);
    assert.equal(second.adopted, true);
    assert.equal(second.trackId, first.trackId, 'the same library track');
    assert.ok(userlib.has(2, first.trackId));
    assert.deepEqual(await readdir(join(dir, 'music', 'Blur', 'Singles')), ['Song 2.wav'], 'no second copy');
  });

  test('never overwrites a file that happens to share a name', async () => {
    await mkdir(join(dir, 'music', 'Blur', 'Singles'), { recursive: true });
    await writeFile(join(dir, 'music', 'Blur', 'Singles', 'Song 2.wav'), 'someone else\'s');
    await ingester.ingest({ file: await stage('f.wav'), artist: 'Blur', title: 'Song 2' }, 1);
    assert.deepEqual((await readdir(join(dir, 'music', 'Blur', 'Singles'))).sort(), ['Song 2 (2).wav', 'Song 2.wav']);
  });

  test('refuses a song with no artist or title rather than filing it as Unknown', async () => {
    await assert.rejects(ingester.ingest({ file: await stage('g.wav'), artist: ' ', title: 'Song 2' }, 1));
  });
});
