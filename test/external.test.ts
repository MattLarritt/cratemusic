import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { open } from '../src/db/schema.js';
import { Store } from '../src/lib/store.js';
import { UserLibrary } from '../src/lib/userlib.js';
import { ExternalCatalog, idFor, parseId } from '../src/lib/external.js';
import type { ExternalHit, ExternalSource } from '../src/lib/plugin.js';
import type { FastifyBaseLogger } from 'fastify';

/**
 * The external catalog: ids that keep working, and the keep policy.
 *
 * The rules pinned here are the ones a user would notice being wrong — a skipped song landing
 * in their library, a song downloaded twice, a voice request that never plays again — so the
 * tests are written as those scenarios rather than around the implementation.
 */

const quiet = { warn() {}, info() {}, error() {}, debug() {} } as unknown as FastifyBaseLogger;

interface Harness {
  db: Database.Database;
  cat: ExternalCatalog;
  userlib: UserLibrary;
  calls: { search: number; acquire: number; describe: number; resolve: number };
  fire: () => void;
  pending: () => number;
  setEnabled: (v: boolean) => void;
  failAcquire: (n: number) => void;
  setCap: (why: string | null) => void;
  setAutoKeep: (on: boolean) => void;
}

const HITS: ExternalHit[] = [
  { key: 'aaaaaaaaaaa', title: 'Song 2', artist: 'Blur', durationS: 122, coverUrl: 'https://img/a.jpg' },
  { key: 'bbbbbbbbbbb', title: 'Song 2 (Live)', artist: 'Blur', durationS: 140 },
];

function harness(): Harness {
  const db = open(':memory:');
  for (const id of [1, 2]) {
    db.prepare('INSERT INTO users (id,username,password_hash,is_admin,enabled,created_at) VALUES (?,?,?,0,1,1)').run(
      id,
      `u${id}`,
      'x',
    );
  }
  const store = new Store(db);
  const userlib = new UserLibrary(db);
  const calls = { search: 0, acquire: 0, describe: 0, resolve: 0 };
  let enabled = true;
  let failuresLeft = 0;
  let cap: string | null = null;

  const source: ExternalSource = {
    id: 'youtube',
    label: 'YouTube',
    async search() {
      calls.search += 1;
      return HITS;
    },
    async describe(key) {
      calls.describe += 1;
      return key === 'zzzzzzzzzzz' ? { key, title: 'Late Arrival', artist: 'Nobody' } : null;
    },
    async resolveStream(key) {
      calls.resolve += 1;
      return { url: `https://media/${key}`, mime: 'audio/mp4', expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    },
    async acquire(key, hit) {
      calls.acquire += 1;
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('the far end said no');
      }
      return { file: `/tmp/${key}.m4a`, artist: hit.artist, title: hit.title };
    },
  };

  // The ingester's real job is tested elsewhere; here it only has to produce a real track row,
  // because external_tracks.track_id is a foreign key and FKs are on.
  const ingester = {
    async ingest(input: { file: string; artist: string; title: string }, userId: number) {
      const info = db
        .prepare(
          `INSERT INTO tracks (path,size,mtime,artist_name,album_title,title,norm_artist,norm_album,norm_title,first_seen)
           VALUES (?,1,1,?,?,?,?,?,?,1)`,
        )
        .run(input.file, input.artist, 'Singles', input.title, input.artist.toLowerCase(), 'singles', input.title.toLowerCase());
      const trackId = Number(info.lastInsertRowid);
      userlib.add(userId, trackId, 'external');
      return { trackId, adopted: false, artist: input.artist, title: input.title, album: 'Singles' };
    },
  };

  // Timers the test fires by hand, so "30 seconds later" is an instruction, not a wait.
  let timers: { fn: () => void; cancelled: boolean }[] = [];
  let autoKeep = true;
  const cat = new ExternalCatalog(db, store, userlib, ingester, { isEnabled: () => enabled }, quiet, {
    capCheck: () => cap,
    autoKeep: () => autoKeep,
    schedule: (fn) => {
      const t = { fn, cancelled: false };
      timers.push(t);
      return { cancel: () => (t.cancelled = true) };
    },
  });
  cat.register('youtube', source);

  return {
    db,
    cat,
    userlib,
    calls,
    fire: () => {
      const due = timers.filter((t) => !t.cancelled);
      timers = [];
      for (const t of due) t.fn();
    },
    pending: () => timers.filter((t) => !t.cancelled).length,
    setEnabled: (v) => (enabled = v),
    failAcquire: (n) => (failuresLeft = n),
    setCap: (why) => (cap = why),
    setAutoKeep: (on) => (autoKeep = on),
  };
}

const SONG = idFor('youtube', 'aaaaaaaaaaa');
const LIVE = idFor('youtube', 'bbbbbbbbbbb');

describe('ids', () => {
  test('round-trip, and keys may contain dashes', () => {
    assert.equal(SONG, 'x-youtube-aaaaaaaaaaa');
    assert.deepEqual(parseId('x-youtube-a-b_c'), { source: 'youtube', key: 'a-b_c' });
  });

  test('library, album and artist ids are not external', () => {
    for (const id of ['t-12', 'al-abc', 'ar-abc', 'pl-3', 'x--abc', 'x-You-abc', '']) {
      assert.equal(parseId(id), null, id);
    }
  });
});

describe('search', () => {
  let h: Harness;
  beforeEach(() => (h = harness()));

  test('asks the source, remembers the hits, and answers from memory the second time', async () => {
    const a = await h.cat.search('song 2 blur');
    assert.deepEqual(a.map((r) => r.id), [SONG, LIVE]);
    await h.cat.search('Song 2  Blur');
    assert.equal(h.calls.search, 1, 'the same search, differently typed, is not a second lookup');
  });

  test('an empty query never reaches the source', async () => {
    // Clients sync whole libraries with an empty search3. That must never become a
    // YouTube search per sync.
    assert.deepEqual(await h.cat.search('   '), []);
    assert.equal(h.calls.search, 0);
  });

  test('a query with nothing searchable in it never reaches the source', async () => {
    // Clients sync with search3 query="" — two quote characters, which is not an empty string.
    for (const q of ['""', "''", '*', '  " "  ', '-']) assert.deepEqual(await h.cat.search(q), [], q);
    assert.equal(h.calls.search, 0);
  });

  test('a disabled plugin offers nothing', async () => {
    h.setEnabled(false);
    assert.deepEqual(await h.cat.search('song 2'), []);
    assert.equal(h.cat.enabled(), false);
  });

  test('a disabled plugin stops playing what it offered earlier, but not what was kept', async () => {
    await h.cat.search('song 2');
    await h.cat.streamFor(h.cat.get('youtube', 'bbbbbbbbbbb')!); // a cached stream URL, too
    await h.cat.listened(1, SONG);
    await h.cat.idle();
    h.setEnabled(false);
    assert.equal(await h.cat.resolve(LIVE), null, 'seen but never kept: gone');
    await assert.rejects(h.cat.streamFor(h.cat.get('youtube', 'bbbbbbbbbbb')!), /not enabled/);
    assert.equal((await h.cat.resolve(SONG))?.kind, 'track', 'kept: still the library file');
  });

  test('a source that throws makes the search empty, not broken', async () => {
    const h2 = harness();
    h2.cat.register('broken', {
      id: 'broken',
      label: 'Broken',
      search: async () => {
        throw new Error('down');
      },
      describe: async () => null,
      resolveStream: async () => ({ url: '', mime: '' }),
      acquire: async () => ({ file: '', artist: '', title: '' }),
    });
    const rows = await h2.cat.search('song 2');
    assert.deepEqual(rows.map((r) => r.source), ['youtube', 'youtube'], 'the working source still answers');
  });

  test('a fresh search never resets a song that is already being kept', async () => {
    await h.cat.search('song 2');
    await h.cat.listened(1, SONG);
    h.db.prepare("DELETE FROM cache").run(); // force the source to be asked again
    await h.cat.search('song 2');
    assert.notEqual(h.cat.get('youtube', 'aaaaaaaaaaa')?.state, 'seen');
  });
});

describe('the keep policy', () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    await h.cat.search('song 2');
  });

  test('a stream that keeps going for 30 seconds is kept', async () => {
    h.cat.streamStarted(1, SONG);
    assert.equal(h.calls.acquire, 0, 'nothing is downloaded the moment playback starts');
    h.fire();
    await h.cat.idle();
    const row = h.cat.get('youtube', 'aaaaaaaaaaa')!;
    assert.equal(row.state, 'imported');
    assert.ok(row.trackId && h.userlib.has(1, row.trackId), 'and it is now in their library');
  });

  test('starting a different song inside the window is a skip, and nothing is kept', async () => {
    h.cat.streamStarted(1, SONG);
    h.cat.streamStarted(1, LIVE);
    h.fire();
    await h.cat.idle();
    assert.equal(h.cat.get('youtube', 'aaaaaaaaaaa')!.state, 'seen', 'the skipped song was never downloaded');
    assert.equal(h.cat.get('youtube', 'bbbbbbbbbbb')!.state, 'imported', 'the one they stayed on was');
  });

  test('skipping to a song you own also counts, and starts no new clock', async () => {
    // The voice case: YouTube played the wrong thing, and the next song is a library one.
    h.cat.streamStarted(1, SONG);
    h.cat.streamStarted(1, 't-42');
    assert.equal(h.pending(), 0);
    h.fire();
    await h.cat.idle();
    assert.equal(h.calls.acquire, 0);
  });

  test('with auto-keep off, listening keeps nothing — but asking still does', async () => {
    h.setAutoKeep(false);
    h.cat.streamStarted(1, SONG);
    assert.equal(h.pending(), 0, 'no clock is started at all');
    assert.equal(await h.cat.listened(1, SONG), 'off', 'a scrobble or a web listen is not a request');
    await h.cat.idle();
    assert.equal(h.calls.acquire, 0);
    assert.equal(h.cat.get('youtube', 'aaaaaaaaaaa')!.state, 'seen');

    assert.equal(await h.cat.keep(1, SONG), 'queued', 'the ⋯ menu, the download button, a star');
    await h.cat.idle();
    assert.equal(h.cat.get('youtube', 'aaaaaaaaaaa')!.state, 'imported');
  });

  test('with auto-keep off, a skip still cancels a clock started while it was on', async () => {
    h.cat.streamStarted(1, SONG);
    h.setAutoKeep(false);
    h.cat.streamStarted(1, LIVE);
    assert.equal(h.pending(), 0);
  });

  test('repeat requests for the same song do not restart the clock', async () => {
    // A client probes, then makes Range requests while seeking. Each one is a new HTTP
    // request for the same id, and none of them is a new playback.
    h.cat.streamStarted(1, SONG);
    h.cat.streamStarted(1, SONG);
    h.cat.streamStarted(1, SONG);
    assert.equal(h.pending(), 1);
  });

  test('a scrobble or a web listen keeps at once, and cancels the timer', async () => {
    h.cat.streamStarted(1, SONG);
    assert.equal(await h.cat.listened(1, SONG), 'queued');
    assert.equal(h.pending(), 0);
    await h.cat.idle();
    assert.equal(h.calls.acquire, 1);
  });

  test('a song is downloaded once, however many signals arrive', async () => {
    await h.cat.listened(1, SONG);
    await h.cat.listened(1, SONG);
    h.cat.streamStarted(1, SONG);
    h.fire();
    await h.cat.idle();
    assert.equal(h.calls.acquire, 1);
  });

  test('a second person keeping it mid-download gets it too, with no second download', async () => {
    await h.cat.listened(1, SONG);
    await h.cat.listened(2, SONG);
    await h.cat.idle();
    const { trackId } = h.cat.get('youtube', 'aaaaaaaaaaa')!;
    assert.ok(trackId && h.userlib.has(1, trackId) && h.userlib.has(2, trackId));
    assert.equal(h.calls.acquire, 1);
  });

  test('once imported, keeping it again just grants it', async () => {
    await h.cat.listened(1, SONG);
    await h.cat.idle();
    assert.equal(await h.cat.listened(2, SONG), 'owned');
    assert.equal(h.calls.acquire, 1);
  });

  test('over the daily cap it still plays, it just is not kept', async () => {
    h.setCap('3 today already');
    assert.equal(await h.cat.listened(1, SONG), 'capped');
    await h.cat.idle();
    assert.equal(h.calls.acquire, 0);
    assert.equal(h.cat.keptSince(1, 0), 0, 'and a refused keep does not count against them');
  });

  test('keeps count against the cap', async () => {
    await h.cat.listened(1, SONG);
    await h.cat.listened(1, LIVE);
    assert.equal(h.cat.keptSince(1, 0), 2);
    assert.equal(h.cat.keptSince(2, 0), 0, 'per person');
  });

  test('a transient failure is retried once', async () => {
    h.failAcquire(1);
    await h.cat.listened(1, SONG);
    await h.cat.idle();
    assert.equal(h.calls.acquire, 2);
    assert.equal(h.cat.get('youtube', 'aaaaaaaaaaa')!.state, 'imported');
  });

  test('two failures leave it failed, with the reason recorded', async () => {
    h.failAcquire(2);
    await h.cat.listened(1, SONG);
    await h.cat.idle();
    const row = h.cat.get('youtube', 'aaaaaaaaaaa')!;
    assert.equal(row.state, 'failed');
    assert.match(row.error ?? '', /far end said no/);
  });

  test('a failed song can be kept again later', async () => {
    h.failAcquire(2);
    await h.cat.listened(1, SONG);
    await h.cat.idle();
    await h.cat.listened(1, SONG);
    await h.cat.idle();
    assert.equal(h.cat.get('youtube', 'aaaaaaaaaaa')!.state, 'imported');
  });
});

describe('resolve: the id keeps working', () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    await h.cat.search('song 2');
  });

  test('before it is kept, it is an external song', async () => {
    const r = await h.cat.resolve(SONG);
    assert.equal(r?.kind, 'external');
  });

  test('after it is kept, the same id IS the library track', async () => {
    await h.cat.listened(1, SONG);
    await h.cat.idle();
    const r = await h.cat.resolve(SONG);
    assert.equal(r?.kind, 'track');
  });

  test('an id never seen here is described by its source rather than refused', async () => {
    // A client kept the id from before a restore, say.
    const r = await h.cat.resolve('x-youtube-zzzzzzzzzzz');
    assert.equal(r?.kind, 'external');
    assert.equal(h.calls.describe, 1);
  });

  test('an unknown source, or a key the source denies, resolves to nothing', async () => {
    assert.equal(await h.cat.resolve('x-soundcloud-abc'), null);
    assert.equal(await h.cat.resolve('x-youtube-doesnotexist'), null);
  });

  test('deleting the kept track frees the id to be external again', async () => {
    await h.cat.listened(1, SONG);
    await h.cat.idle();
    const { trackId } = h.cat.get('youtube', 'aaaaaaaaaaa')!;
    h.db.prepare('DELETE FROM user_tracks WHERE track_id = ?').run(trackId);
    h.db.prepare('DELETE FROM tracks WHERE id = ?').run(trackId);
    assert.equal((await h.cat.resolve(SONG))?.kind, 'external');
  });
});

describe('stream URLs', () => {
  test('are reused until shortly before they expire', async () => {
    const h = harness();
    await h.cat.search('song 2');
    const row = h.cat.get('youtube', 'aaaaaaaaaaa')!;
    await h.cat.streamFor(row);
    await h.cat.streamFor(row);
    assert.equal(h.calls.resolve, 1);
    h.cat.forgetStream(row.id);
    await h.cat.streamFor(row);
    assert.equal(h.calls.resolve, 2, 'and resolved afresh once forgotten');
  });
});
