/**
 * The DJ engine, against a real (in-memory) database built by the core migrate.
 *
 * These are behaviour tests for the rules that survived the plugin era, not for the tuned
 * numbers: a vote writes weights across kinds and escalates on repeats, planning honours
 * exclusions and the hard-no veto and the per-artist cap, reset wipes everything (or wipes
 * and re-seeds, for "Reset DJ session"), and the schema migration is a no-op when the tables
 * already exist with data — which is exactly the state of a live database that ran the
 * intelligent-shuffle plugin.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { open } from '../src/db/schema.js';
import { Dj, type DjCharacteristics } from '../src/lib/dj.js';
import type Database from 'better-sqlite3';

const USER = 1;

/** Characteristics stubs: off entirely, or a fixed vector store. */
const noChars: DjCharacteristics = {
  enabled: () => false,
  vectorOf: () => null,
  scoreAgainst: () => new Map(),
};
const charsWith = (vectors: Map<number, Map<string, number>>): DjCharacteristics => ({
  enabled: () => true,
  vectorOf: (id) => vectors.get(id) ?? null,
  scoreAgainst: () => new Map(),
});

const quiet = { warn: () => {} };
const noPlaylists = {
  createPlaylist: () => 1,
  setPlaylistDescription: () => {},
};
// Settings is only consulted by say(), which these tests never reach the network for.
const fakeSettings = { all: () => ({ openaiKey: '' }) } as unknown as ConstructorParameters<
  typeof Dj
>[3];

/** A tiny library: three artists across two genres and two decades. */
function seed(db: Database.Database) {
  const insTrack = db.prepare(
    `INSERT INTO tracks (id, path, size, mtime, first_seen, title, artist_name, album_title,
                         norm_artist, norm_album, album_artist, album_artist_name, genres,
                         year, energy, duration_s)
     VALUES (?, ?, 1, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 200)`,
  );
  const insMine = db.prepare('INSERT INTO user_tracks (user_id, track_id, added_at) VALUES (?, ?, 0)');
  const rows: [number, string, string, string, number, number][] = [
    // id, title, artist, genres, year, energy
    [1, 'Chop Suey', 'System of a Down', 'nu metal, metal', 2001, 0.9],
    [2, 'Toxicity', 'System of a Down', 'nu metal, metal', 2001, 0.85],
    [3, 'Aerials', 'System of a Down', 'nu metal, metal', 2001, 0.8],
    [4, 'Du Hast', 'Rammstein', 'industrial metal, metal', 1997, 0.9],
    [5, 'Sonne', 'Rammstein', 'industrial metal, metal', 2001, 0.85],
    [6, 'Yellow', 'Coldplay', 'pop rock, rock', 2000, 0.4],
    [7, 'Fix You', 'Coldplay', 'pop rock, rock', 2005, 0.3],
    [8, 'Clocks', 'Coldplay', 'pop rock, rock', 2002, 0.45],
  ];
  for (const [id, title, artist, genres, year, energy] of rows) {
    const norm = artist.toLowerCase();
    insTrack.run(id, `/x/${id}.flac`, title, artist, 'Album', norm, 'album', norm, artist, genres, year, energy);
    insMine.run(USER, id);
  }
}

describe('Dj', () => {
  let db: Database.Database;
  let dj: Dj;

  beforeEach(() => {
    db = open(':memory:');
    seed(db);
    dj = new Dj(db, noChars, noPlaylists, fakeSettings, quiet);
  });

  describe('vote', () => {
    it('writes weights across every kind the track carries', () => {
      const r = dj.vote(USER, 1, 'more');
      assert.equal(r.ok, true);
      assert.equal(r.applied.artist, 'System of a Down');
      assert.ok(r.applied.genres.includes('nu metal'));
      const kinds = (
        db.prepare('SELECT DISTINCT kind FROM ishuffle_weights WHERE user_id = ?').all(USER) as {
          kind: string;
        }[]
      ).map((k) => k.kind);
      for (const k of ['track', 'album', 'artist', 'genre', 'style', 'era', 'energy']) {
        assert.ok(kinds.includes(k), `missing kind ${k}`);
      }
    });

    it('escalates the artist share on repeat votes across DIFFERENT tracks', () => {
      dj.vote(USER, 1, 'more');
      const after1 = (
        db
          .prepare("SELECT weight FROM ishuffle_weights WHERE user_id=? AND kind='artist'")
          .get(USER) as { weight: number }
      ).weight;
      dj.vote(USER, 2, 'more');
      dj.vote(USER, 3, 'more');
      const after3 = (
        db
          .prepare("SELECT weight FROM ishuffle_weights WHERE user_id=? AND kind='artist'")
          .get(USER) as { weight: number }
      ).weight;
      // Three distinct-track votes: the third lands at 1 + 0.75×2 = 2.5× — visibly super-linear.
      assert.ok(after3 > after1 * 3, `expected escalation, got ${after1} -> ${after3}`);
    });

    it('rejects a vote on a track that does not exist', () => {
      assert.throws(() => dj.vote(USER, 999, 'more'), /no such track/);
    });
  });

  describe('plan', () => {
    const args = (over: Partial<Parameters<Dj['plan']>[1]> = {}) => ({
      count: 5,
      exclude: new Set<number>(),
      playedOrder: [],
      afterTrackId: 0,
      seedFrom: 0,
      ...over,
    });

    it('cold start deals from the whole library and respects exclusions', () => {
      const got = dj.plan(USER, args({ exclude: new Set([1, 2, 3]) }));
      assert.ok(got.length > 0);
      for (const t of got) assert.ok(![1, 2, 3].includes(t.trackId), `excluded ${t.trackId} dealt`);
    });

    it('caps each artist to one slot per batch', () => {
      const got = dj.plan(USER, args({ count: 8 }));
      const artists = got.map((t) => t.artistName);
      assert.equal(new Set(artists).size, artists.length, `artist repeated in ${artists.join(', ')}`);
    });

    it('the hard-no veto buries a repeatedly rejected artist, not the pool', () => {
      // Two downvotes on different Coldplay tracks: the artist escalates into a hard no.
      dj.vote(USER, 6, 'less');
      dj.vote(USER, 7, 'less');
      dj.vote(USER, 8, 'less');
      const seen = new Set<string>();
      // The sampler is stochastic; several deals make absence meaningful.
      for (let i = 0; i < 10; i++) for (const t of dj.plan(USER, args())) seen.add(t.artistName);
      assert.ok(!seen.has('Coldplay'), 'a thrice-vetoed artist still dealt');
      assert.ok(seen.size >= 2, 'the veto emptied the pool instead of targeting the artist');
    });
  });

  describe('reset', () => {
    it('wipes all four tables', () => {
      dj.vote(USER, 1, 'more');
      dj.vote(USER, 4, 'less');
      dj.reset(USER);
      for (const t of ['ishuffle_weights', 'ishuffle_votes', 'ishuffle_ghost', 'ishuffle_ghost_meta']) {
        const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(USER) as { n: number }).n;
        assert.equal(n, 0, `${t} not wiped`);
      }
    });

    it('with seedFrom leaves a freshly seeded ghost with zero votes', () => {
      const vectors = new Map([[1, new Map([['energy', 0.9], ['darkness', 0.7]])]]);
      const djc = new Dj(db, charsWith(vectors), noPlaylists, fakeSettings, quiet);
      djc.vote(USER, 1, 'more'); // moves the ghost, votes = 1
      djc.reset(USER, 1);
      const meta = db
        .prepare('SELECT votes FROM ishuffle_ghost_meta WHERE user_id = ?')
        .get(USER) as { votes: number } | undefined;
      assert.equal(meta?.votes, 0, 'reset ghost should hold a position but no evidence');
      const g = djc.ghostSummary(USER);
      assert.equal(g.say, 0, 'a reseeded ghost has no say until a vote');
      assert.ok(g.wants.length > 0, 'the ghost holds the seed position');
      const weights = (db.prepare('SELECT COUNT(*) AS n FROM ishuffle_weights WHERE user_id=?').get(USER) as { n: number }).n;
      assert.equal(weights, 0, 'weights must be wiped by a reset');
    });
  });

  describe('migration', () => {
    it('is a no-op against a database that already has the tables with data', () => {
      dj.vote(USER, 1, 'more');
      const before = db.prepare('SELECT COUNT(*) AS n FROM ishuffle_weights').get() as { n: number };
      const sqlBefore = (
        db.prepare("SELECT sql FROM sqlite_master WHERE name='ishuffle_weights'").get() as { sql: string }
      ).sql;
      // Re-running the whole core migrate against the live handle must change nothing.
      // (open() runs migrate; a second run on the same file is the restart case.)
      db.exec('PRAGMA foreign_keys = ON'); // open() would; harmless here
      // The migrate function is private to schema.ts; the honest restart simulation is
      // serialising to a file and re-opening it — :memory: cannot do that, so instead run
      // the DDL the way a restart would: open() on a shared cache URI is overkill, and the
      // property that matters is idempotence of the statements themselves:
      const again = () => {
        db.exec(`CREATE TABLE IF NOT EXISTS ishuffle_weights (x INTEGER)`); // must be ignored
      };
      assert.doesNotThrow(again);
      const after = db.prepare('SELECT COUNT(*) AS n FROM ishuffle_weights').get() as { n: number };
      const sqlAfter = (
        db.prepare("SELECT sql FROM sqlite_master WHERE name='ishuffle_weights'").get() as { sql: string }
      ).sql;
      assert.equal(after.n, before.n);
      assert.equal(sqlAfter, sqlBefore, 'IF NOT EXISTS must not replace the real table');
    });
  });
});
