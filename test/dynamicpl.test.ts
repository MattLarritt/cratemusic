/**
 * Dynamic playlists, with the focus on the song-characteristic terms.
 *
 * The part worth pinning is the BAND: "high darkness" means the darkest third of this library,
 * not a score above some constant. That choice exists because fixed cuts measured badly on the
 * real data — one dimension had no track below 0.35 at all, another had 95% above 0.65 — so the
 * tests below build deliberately lopsided distributions and check the band still splits them.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { open } from '../src/db/schema.js';
import { materialize, parseRules, type PlaylistRules } from '../src/lib/dynamicpl.js';
import type Database from 'better-sqlite3';

const USER = 1;

/** `n` tracks, all one artist-per-track so the per-artist cap never interferes. */
function seedTracks(db: Database.Database, n: number) {
  const ins = db.prepare(
    `INSERT INTO tracks (id, path, size, mtime, first_seen, title, artist_name, album_title,
                         norm_artist, norm_album, album_artist, album_artist_name, genres, year, energy)
     VALUES (?, ?, 1, 0, 0, ?, ?, 'Album', ?, 'album', ?, ?, 'rock', 2000, 0.5)`,
  );
  const mine = db.prepare('INSERT INTO user_tracks (user_id, track_id, added_at) VALUES (?, ?, 0)');
  for (let i = 1; i <= n; i++) {
    const artist = `Artist ${i}`;
    const norm = `artist ${i}`;
    ins.run(i, `/t${i}.flac`, `Track ${i}`, artist, norm, norm, artist);
    mine.run(USER, i);
  }
}

/**
 * Give track `id` a score on `key`.
 *
 * The dimension is registered first because track_characteristics carries a foreign key onto
 * characteristics(key) and open() turns foreign_keys ON — in production the taxonomy is synced
 * into that table at boot, so a test that skipped it would be testing a shape the server never
 * has.
 */
function score(db: Database.Database, id: number, key: string, value: number, source = 'ai') {
  db.prepare(
    `INSERT INTO characteristics (key, name, grp) VALUES (?, ?, 'energy')
       ON CONFLICT(key) DO NOTHING`,
  ).run(key, key);
  db.prepare(
    `INSERT INTO track_characteristics (track_id, characteristic_key, source, score, analysed_at)
     VALUES (?, ?, ?, ?, 0)`,
  ).run(id, key, source, value);
}

const rules = (terms: PlaylistRules['terms'], limit = 50): PlaylistRules => ({ v: 1, terms, limit });

describe('dynamic playlists — characteristic terms', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = open(':memory:');
    seedTracks(db, 30);
  });

  it('deals the top third on a high band', () => {
    // Scores 0.01 … 0.30, evenly spread: the top third is tracks 21-30.
    for (let i = 1; i <= 30; i++) score(db, i, 'darkness', i / 100);
    const got = materialize(db, USER, rules([{ kind: 'char', key: 'darkness|high', weight: 2 }]));
    assert.ok(got.length > 0, 'the band matched nothing');
    const ids = got.map((t) => t.trackId).sort((a, b) => a - b);
    assert.ok(Math.min(...ids) >= 20, `expected only the darkest third, got ids from ${Math.min(...ids)}`);
  });

  it('deals the bottom third on a low band', () => {
    for (let i = 1; i <= 30; i++) score(db, i, 'darkness', i / 100);
    const got = materialize(db, USER, rules([{ kind: 'char', key: 'darkness|low', weight: 2 }]));
    const ids = got.map((t) => t.trackId);
    assert.ok(ids.length > 0);
    assert.ok(Math.max(...ids) <= 11, `expected only the least dark third, got up to ${Math.max(...ids)}`);
  });

  /*
   * The two cases that killed fixed thresholds, as regression tests.
   */
  it('a high band still splits a dimension where every score is high', () => {
    // atmosphere on the real library: nothing below 0.4, most of it above 0.65.
    for (let i = 1; i <= 30; i++) score(db, i, 'atmosphere', 0.7 + i / 300);
    const high = materialize(db, USER, rules([{ kind: 'char', key: 'atmosphere|high', weight: 2 }]));
    const low = materialize(db, USER, rules([{ kind: 'char', key: 'atmosphere|low', weight: 2 }]));
    assert.ok(high.length > 0 && high.length < 30, `high matched ${high.length} of 30`);
    assert.ok(low.length > 0 && low.length < 30, `low matched ${low.length} of 30 — a fixed 0.35 cut would match none`);
    // And they are different ends of the same library.
    assert.notDeepEqual(new Set(high.map((t) => t.trackId)), new Set(low.map((t) => t.trackId)));
  });

  it('a low band still splits a dimension where almost everything is at the ceiling', () => {
    // vocal_presence on the real library: 95% above 0.65.
    for (let i = 1; i <= 30; i++) score(db, i, 'vocal_presence', i <= 28 ? 0.98 : 0.2);
    const low = materialize(db, USER, rules([{ kind: 'char', key: 'vocal_presence|low', weight: 2 }]));
    assert.ok(low.length > 0, 'a saturated dimension must still have a bottom third');
    assert.ok(low.length < 30, 'and it must not be the whole library');
  });

  it('a track with no score on the dimension is not dealt, and not punished either', () => {
    // Only half the library is analysed on this dimension.
    for (let i = 1; i <= 15; i++) score(db, i, 'heaviness', i / 100);
    const got = materialize(db, USER, rules([{ kind: 'char', key: 'heaviness|high', weight: 2 }]));
    assert.ok(got.length > 0);
    assert.ok(
      got.every((t) => t.trackId <= 15),
      'an unanalysed track cannot be in a band and must not be dealt by one',
    );
  });

  it('an instrumental — no vocal row at all — is not swept up by a low vocal band', () => {
    // characteristics.ts is explicit that absent and zero are different states; this is why.
    for (let i = 1; i <= 20; i++) score(db, i, 'vocal_intimacy', i / 40);
    const got = materialize(db, USER, rules([{ kind: 'char', key: 'vocal_intimacy|low', weight: 2 }]));
    assert.ok(
      got.every((t) => t.trackId <= 20),
      'tracks 21-30 have no vocal_intimacy row and must not read as "quiet vocals"',
    );
  });

  it('manual scores outrank the classifier, as they do everywhere else', () => {
    for (let i = 1; i <= 30; i++) score(db, i, 'darkness', 0.05);
    // Track 1 is genuinely dark, by hand, against an AI score that says otherwise.
    score(db, 1, 'darkness', 0.99, 'manual');
    const got = materialize(db, USER, rules([{ kind: 'char', key: 'darkness|high', weight: 2 }]));
    assert.ok(got.some((t) => t.trackId === 1), 'the manual override was ignored');
  });

  it('too little analysed to speak of thirds deals nothing rather than guessing', () => {
    score(db, 1, 'darkness', 0.9);
    score(db, 2, 'darkness', 0.1);
    const got = materialize(db, USER, rules([{ kind: 'char', key: 'darkness|high', weight: 2 }]));
    assert.equal(got.length, 0);
  });

  describe('alongside the other term kinds', () => {
    it('a characteristic widens the pool like any other term (terms are an OR)', () => {
      // Half the library is metal, and a disjoint third is dark.
      db.prepare("UPDATE tracks SET genres = 'metal' WHERE id <= 10").run();
      for (let i = 21; i <= 30; i++) score(db, i, 'darkness', 0.9);
      for (let i = 1; i <= 20; i++) score(db, i, 'darkness', 0.1);

      const metalOnly = materialize(db, USER, rules([{ kind: 'genre', key: 'metal', weight: 2.5 }]));
      const both = materialize(
        db,
        USER,
        rules([
          { kind: 'genre', key: 'metal', weight: 2.5 },
          { kind: 'char', key: 'darkness|high', weight: 1.5 },
        ]),
      );
      assert.ok(
        both.length > metalOnly.length,
        `adding a feel term should widen the pool: ${metalOnly.length} -> ${both.length}`,
      );
    });

    it('round-trips through parseRules', () => {
      const raw = JSON.stringify(
        rules([{ kind: 'char', key: 'darkness|high', weight: 1.5, label: 'high darkness' }]),
      );
      const back = parseRules(raw);
      assert.equal(back?.terms.length, 1);
      assert.equal(back?.terms[0]?.kind, 'char');
      assert.equal(back?.terms[0]?.key, 'darkness|high');
    });
  });
});
