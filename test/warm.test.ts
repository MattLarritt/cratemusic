/**
 * Page warming: the worklist and the queue order.
 *
 * The lookups themselves are somebody else's network, so MusicBrainz and Last.fm are stubs that
 * record what they were asked for. What is worth testing is everything around them: that the
 * library becomes a worklist, that the most-played artist is warmed first, that a failure is
 * capped rather than retried forever, and that the two sweeps mean different things.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { open } from '../src/db/schema.js';
import { PageWarmer } from '../src/lib/warm.js';
import type { LastFm } from '../src/lib/lastfm.js';
import type { MusicBrainz } from '../src/lib/musicbrainz.js';
import type Database from 'better-sqlite3';

const quiet = { info: () => {}, warn: () => {} };

/** A MusicBrainz stub that records calls and can be told to fail. */
function stubMb(opts: { fail?: boolean; unknown?: boolean; mirror?: boolean } = {}) {
  const calls: string[] = [];
  const mb = {
    searchArtists: async (term: string, _limit?: number, lane?: string) => {
      calls.push(`searchArtists:${term}:${lane}`);
      if (opts.fail) throw new Error('musicbrainz is down');
      return opts.unknown ? [] : [{ mbid: `mbid-${term}`, name: term, kind: 'artist' }];
    },
    artistInfo: async (mbid: string, lane?: string) => {
      calls.push(`artistInfo:${mbid}:${lane}`);
      return { mbid, name: mbid };
    },
    studioAlbums: async (mbid: string, lane?: string) => {
      calls.push(`studioAlbums:${mbid}:${lane}`);
      return [];
    },
    albumYear: async (artist: string, album: string, lane?: string) => {
      calls.push(`albumYear:${artist}|${album}:${lane}`);
      return 1994;
    },
    mirrorStatus: () => ({
      configured: Boolean(opts.mirror),
      live: Boolean(opts.mirror),
      downForS: 0,
      fails: 0,
    }),
  };
  return { mb: mb as unknown as MusicBrainz, calls };
}

function stubLastfm(enabled = true) {
  const calls: string[] = [];
  const lf = {
    enabled,
    artistBio: async (a: string) => {
      calls.push(`bio:${a}`);
      return 'a bio';
    },
    similarArtists: async (a: string) => {
      calls.push(`similar:${a}`);
      return [];
    },
  };
  return { lastfm: lf as unknown as LastFm, calls };
}

/** Two artists, one played a lot and one never, plus an album each. */
function seed(db: Database.Database) {
  const ins = db.prepare(
    `INSERT INTO tracks (id, path, size, mtime, first_seen, title, artist_name, album_title,
                         norm_artist, norm_album, album_artist, album_artist_name)
     VALUES (?, ?, 1, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
  );
  ins.run(1, '/a.flac', 'Song A', 'Popular Band', 'Big Record', 'popular band', 'big record', 'popular band', 'Popular Band');
  ins.run(2, '/b.flac', 'Song B', 'Ignored Band', 'Small Record', 'ignored band', 'small record', 'ignored band', 'Ignored Band');
  db.prepare('INSERT INTO user_tracks (user_id, track_id, added_at) VALUES (1, 1, 0), (1, 2, 0)').run();
  // Only the first artist has plays, so it must be warmed first.
  db.prepare(
    'INSERT INTO plays (user_id, track_id, plays, first_played, last_played) VALUES (1, 1, 40, 0, 0)',
  ).run();
}

describe('PageWarmer', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = open(':memory:');
    seed(db);
  });

  it('turns the library into a worklist, artists and albums alike', () => {
    const { mb } = stubMb();
    const { lastfm } = stubLastfm();
    const w = new PageWarmer(db, mb, lastfm, () => true, quiet);
    const n = w.enrol();
    assert.equal(n.artists, 2);
    assert.equal(n.albums, 2);
    const p = w.progress();
    assert.equal(p.artists.total, 2);
    assert.equal(p.artists.pending, 2);
    assert.equal(p.albums.total, 2);
  });

  it('reports the mirror state, because a mirror in backoff is why pages are slow', () => {
    const { lastfm } = stubLastfm();
    const off = new PageWarmer(db, stubMb().mb, lastfm, () => true, quiet);
    assert.deepEqual(off.progress().mirror, {
      configured: false,
      live: false,
      downForS: 0,
      fails: 0,
    });
    const on = new PageWarmer(db, stubMb({ mirror: true }).mb, lastfm, () => true, quiet);
    assert.equal(on.progress().mirror.live, true);
  });

  it('enrolling twice adds nothing and loses nothing', () => {
    const { mb } = stubMb();
    const { lastfm } = stubLastfm();
    const w = new PageWarmer(db, mb, lastfm, () => true, quiet);
    w.enrol();
    w.enrol();
    assert.equal(w.progress().artists.total, 2);
  });

  it('warms the most-played artist first, and only on the idle lane', async () => {
    const { mb, calls } = stubMb();
    const { lastfm, calls: lfCalls } = stubLastfm();
    const w = new PageWarmer(db, mb, lastfm, () => true, quiet);
    w.enrol();
    assert.equal(await w.tick(), 'warmed');
    assert.ok(
      calls[0]?.startsWith('searchArtists:Popular Band'),
      `expected the played artist first, got ${calls[0]}`,
    );
    // Every MusicBrainz call must be idle — the whole point is not competing with a live page.
    for (const c of calls) assert.ok(c.endsWith(':idle'), `not on the idle lane: ${c}`);
    // And the page's Last.fm halves came along.
    assert.deepEqual(lfCalls, ['bio:Popular Band', 'similar:Popular Band']);
    assert.equal(w.progress().artists.warm, 1);
  });

  it('does the artists before the albums', async () => {
    const { mb, calls } = stubMb();
    const { lastfm } = stubLastfm();
    const w = new PageWarmer(db, mb, lastfm, () => true, quiet);
    w.enrol();
    for (let i = 0; i < 4; i++) await w.tick();
    const firstAlbumAt = calls.findIndex((c) => c.startsWith('albumYear:'));
    const lastArtistAt = calls.map((c) => c.startsWith('searchArtists:')).lastIndexOf(true);
    assert.ok(firstAlbumAt > lastArtistAt, 'an album was warmed before the last artist');
    const p = w.progress();
    assert.equal(p.artists.warm, 2);
    assert.equal(p.albums.warm, 2);
    assert.equal(await w.tick(), 'idle', 'nothing left to do');
  });

  it('records an artist MusicBrainz does not know as warm, not failed', async () => {
    // "No such artist" is a fact about the artist; retrying it forever would be pointless.
    const { mb } = stubMb({ unknown: true });
    const { lastfm } = stubLastfm();
    const w = new PageWarmer(db, mb, lastfm, () => true, quiet);
    w.enrol();
    assert.equal(await w.tick(), 'warmed');
    const row = db
      .prepare("SELECT state, detail FROM page_warm WHERE kind='artist' AND key='popular band'")
      .get() as { state: string; detail: string };
    assert.equal(row.state, 'warm');
    assert.match(row.detail, /no such artist/i);
  });

  it('gives up after three failures instead of retrying forever', async () => {
    const { mb } = stubMb({ fail: true });
    const { lastfm } = stubLastfm();
    const w = new PageWarmer(db, mb, lastfm, () => true, quiet);
    w.enrol();
    let failures = 0;
    // Two artists × three attempts each, then albums; well past the cap either way.
    for (let i = 0; i < 12; i++) if ((await w.tick()) === 'failed') failures++;
    assert.equal(failures, 6, 'expected exactly three attempts per artist');
    assert.equal(w.progress().artists.failed, 2);
  });

  it('does nothing at all when switched off', async () => {
    const { mb, calls } = stubMb();
    const { lastfm } = stubLastfm();
    const w = new PageWarmer(db, mb, lastfm, () => false, quiet);
    w.enrol();
    assert.equal(await w.tick(), 'disabled');
    assert.equal(calls.length, 0);
    assert.equal(w.progress().enabled, false);
  });

  it('skips Last.fm entirely when it has no key', async () => {
    const { mb } = stubMb();
    const { lastfm, calls } = stubLastfm(false);
    const w = new PageWarmer(db, mb, lastfm, () => true, quiet);
    w.enrol();
    await w.tick();
    assert.deepEqual(calls, []);
  });

  describe('sweeps', () => {
    it('the gap sweep leaves warm pages alone; the full sweep re-queues them', async () => {
      const { mb } = stubMb();
      const { lastfm } = stubLastfm();
      const w = new PageWarmer(db, mb, lastfm, () => true, quiet);
      w.enrol();
      for (let i = 0; i < 4; i++) await w.tick();
      assert.equal(w.progress().artists.pending, 0);

      w.sweepCold();
      assert.equal(w.progress().artists.pending, 0, 'nothing was cold, so nothing to do');

      w.sweepAll();
      const p = w.progress();
      assert.equal(p.artists.pending, 2);
      assert.equal(p.albums.pending, 2);
      assert.equal(p.artists.warm, 0);
    });

    it('the gap sweep revives a failed page', async () => {
      const { mb } = stubMb({ fail: true });
      const { lastfm } = stubLastfm();
      const w = new PageWarmer(db, mb, lastfm, () => true, quiet);
      w.enrol();
      for (let i = 0; i < 12; i++) await w.tick();
      assert.equal(w.progress().artists.failed, 2);
      w.sweepCold();
      assert.equal(w.progress().artists.pending, 2, 'a failure is usually the network, not the artist');
    });
  });
});
