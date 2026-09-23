import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { open } from '../src/db/schema.js';
import { UserLibrary, splitGenres } from '../src/lib/userlib.js';
import { albumIdentity } from '../src/lib/library.js';
import { norm } from '../src/lib/release.js';

/**
 * Four client-visible bugs, reported by a third-party OpenSubsonic client against a
 * real library, plus the queries behind the three endpoints added alongside them.
 *
 * Written the way the client saw them — an id handed out by one endpoint, fed back into
 * another — rather than around the implementation, because that round trip is the thing
 * that was broken and the thing that must not break again.
 */

const enc = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const dec = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');
const albumKey = (artist: string, album: string): string =>
  JSON.stringify([norm(artist), albumIdentity(album)]);

function seed(): { db: Database.Database; userlib: UserLibrary } {
  const db = open(':memory:');
  const insert = db.prepare(
    `INSERT INTO tracks (path,size,mtime,artist_name,album_title,title,norm_artist,norm_album,
       norm_title,first_seen,album_artist,album_artist_name,canon_album,tags_v,genres,track_no,
       duration_s,year)
     VALUES (@path,1000,1,@artist,@album,@title,@nartist,@nalbum,@ntitle,1,@aartistN,@aartist,
       @nalbum,1,@genres,@no,180,@year)`,
  );
  const rows = [
    { path: '/m/1', artist: 'Beastie Boys', aartist: 'Beastie Boys', album: 'Ill Communication', title: 'Sabotage', genres: 'hip hop, rock', no: 1, year: 1994 },
    { path: '/m/2', artist: 'Beastie Boys', aartist: 'Beastie Boys', album: 'Ill Communication', title: 'Sure Shot', genres: 'hip hop, rock', no: 2, year: 1994 },
    { path: '/m/3', artist: 'Linkin Park', aartist: 'Linkin Park', album: 'Meteora', title: 'Numb', genres: 'rock, nu metal', no: 1, year: 2003 },
    // The reported "single-album artist" case: a guest credit whose artist differs from
    // the album's own artist, so the two indexes disagree about where they live.
    { path: '/m/4', artist: 'A-Ha', aartist: 'Various Artists', album: '80s Hits', title: 'Take On Me', genres: 'pop, synthpop', no: 5, year: 1985 },
    { path: '/m/5', artist: 'Miles Davis', aartist: 'Miles Davis', album: 'Kind of Blue', title: 'So What', genres: 'jazz', no: 1, year: 1959 },
    { path: '/m/6', artist: 'Depeche Mode', aartist: 'Depeche Mode', album: 'Violator', title: 'Enjoy the Silence', genres: 'synthpop', no: 1, year: 1990 },
  ];
  for (const r of rows) {
    insert.run({
      ...r,
      nartist: norm(r.artist),
      nalbum: albumIdentity(r.album),
      ntitle: norm(r.title),
      aartistN: norm(r.aartist),
    });
  }
  db.prepare(
    'INSERT INTO users (id,username,password_hash,is_admin,enabled,created_at) VALUES (1,?,?,1,1,1)',
  ).run('tester', 'x');
  db.prepare('INSERT INTO user_tracks (user_id,track_id,added_at) SELECT 1,id,1 FROM tracks').run();
  return { db, userlib: new UserLibrary(db) };
}

describe('album id round trip (getArtist -> getAlbum)', () => {
  test('an id built from normalised values still finds its tracks', () => {
    // The bug: ids normalise both halves by design, and the lookup then compared them
    // against the stored originals — so every album 404ed from getAlbum.
    const { userlib } = seed();
    const id = `al-${enc(albumKey('Beastie Boys', 'Ill Communication'))}`;
    const [artist, album] = JSON.parse(dec(id.slice(3))) as [string, string];
    assert.equal(artist, 'beastie boys', 'the id carries normalised values');

    const mine = userlib
      .mine(1, 100)
      .filter((t) => norm(t.albumArtistName) === artist && albumIdentity(t.albumTitle) === album);
    assert.equal(mine.length, 2);
    // Display values must come from the rows, not from the normalised id.
    assert.equal(mine[0]!.albumTitle, 'Ill Communication');
  });

  test('matching the track credit instead of the album artist would lose a compilation', () => {
    const { userlib } = seed();
    const [, album] = JSON.parse(dec(enc(albumKey('Various Artists', '80s Hits')))) as [string, string];
    const byAlbumArtist = userlib
      .mine(1, 100)
      .filter((t) => norm(t.albumArtistName) === 'various artists' && albumIdentity(t.albumTitle) === album);
    assert.equal(byAlbumArtist.length, 1, 'the album artist finds the compilation track');
    const byCredit = userlib.mine(1, 100).filter((t) => norm(t.artistName) === 'various artists');
    assert.equal(byCredit.length, 0, 'the credit does not, which was the second half of it');
  });

  test('a differently-cased title resolves to the same album', () => {
    // Why the id normalises at all: one record must not arrive under two ids.
    assert.equal(albumKey('Beastie Boys', 'ill communication'), albumKey('Beastie Boys', 'Ill Communication'));
  });
});

describe('artist lookup', () => {
  test('an artist known only by a track credit still resolves', () => {
    // A-Ha appears in the index, which is built from artistName, but their only track
    // sits on a Various Artists album — so matching the album artist alone 404ed them.
    const { userlib } = seed();
    const wanted = norm('A-Ha');
    const theirs = userlib
      .mine(1, 100)
      .filter((t) => norm(t.albumArtistName) === wanted || norm(t.artistName) === wanted);
    assert.equal(theirs.length, 1);
    assert.equal(theirs[0]!.albumTitle, '80s Hits');
  });

  test('albumCount counts albums, not tracks', () => {
    // It counted tracks, so "artists with exactly one album" really selected artists
    // with one TRACK — which is the compilation case, the one that then failed to open.
    const { userlib } = seed();
    const albums = new Set(
      userlib
        .mine(1, 100)
        .filter((t) => norm(t.artistName) === norm('Beastie Boys'))
        .map((t) => albumKey(t.albumArtistName, t.albumTitle)),
    );
    assert.equal(albums.size, 1, 'two tracks, one album');
  });
});

describe('search', () => {
  test('a song matches on artist and album, not the title alone', () => {
    // "Linkin Park" returned one artist and zero songs, which reads as an empty library.
    const { userlib } = seed();
    const term = 'linkin park';
    const match = (s: string) => s.toLowerCase().includes(term);
    const songs = userlib
      .mine(1, 100)
      .filter((t) => match(t.title) || match(t.artistName) || match(t.albumArtistName) || match(t.albumTitle));
    assert.equal(songs.length, 1);
    assert.equal(songs[0]!.title, 'Numb');
  });

  test('offset advances the window instead of repeating page one', () => {
    // The reported symptom: four identical copies of a library, and a twenty-track
    // album arriving as sixty.
    const page = <T>(rows: T[], offset: unknown, count: unknown, fallback: number): T[] => {
      const from = Math.max(Number(offset ?? 0) || 0, 0);
      const size = Math.max(Number(count ?? fallback) || fallback, 0);
      return rows.slice(from, from + size);
    };
    const rows = ['a', 'b', 'c', 'd', 'e'];
    assert.deepEqual(page(rows, 0, 2, 50), ['a', 'b']);
    assert.deepEqual(page(rows, 2, 2, 50), ['c', 'd']);
    assert.deepEqual(page(rows, 4, 2, 50), ['e']);
    assert.deepEqual(page(rows, 99, 2, 50), [], 'past the end is empty, not page one');
    assert.deepEqual(page(rows, undefined, undefined, 3), ['a', 'b', 'c'], 'defaults apply');
  });
});

describe('genres', () => {
  test('lists genres with song and album counts', () => {
    const { userlib } = seed();
    const rock = userlib.genreCounts(1).find((x) => x.genre === 'rock');
    assert.equal(rock?.songCount, 3, 'two Beastie Boys tracks and one Linkin Park');
    assert.equal(rock?.albumCount, 2);
  });

  test('a genre matches whole values, never substrings', () => {
    // 'pop' must not sweep in a track tagged only 'synthpop'.
    const { userlib } = seed();
    assert.deepEqual(userlib.byGenre(1, 'pop', 50, 0).map((t) => t.title), ['Take On Me']);
    assert.deepEqual(
      userlib.byGenre(1, 'synthpop', 50, 0).map((t) => t.title).sort(),
      ['Enjoy the Silence', 'Take On Me'],
    );
  });

  test('is case-insensitive and pages', () => {
    const { userlib } = seed();
    assert.equal(userlib.byGenre(1, 'ROCK', 50, 0).length, 3);
    assert.equal(userlib.byGenre(1, 'rock', 2, 0).length, 2);
    assert.equal(userlib.byGenre(1, 'rock', 2, 2).length, 1, 'offset advances');
  });

  test('an unknown genre returns nothing rather than everything', () => {
    const { userlib } = seed();
    assert.deepEqual(userlib.byGenre(1, 'polka', 50, 0), []);
    assert.deepEqual(userlib.byGenre(1, '', 50, 0), []);
  });

  test('splitGenres trims, lowercases and de-duplicates', () => {
    assert.deepEqual(splitGenres('Rock, rock ,  Pop '), ['rock', 'pop']);
    assert.deepEqual(splitGenres(''), []);
  });
});

describe('random songs', () => {
  test('respects size and never exceeds the library', () => {
    const { userlib } = seed();
    assert.equal(userlib.randomTracks(1, 3).length, 3);
    assert.equal(userlib.randomTracks(1, 100).length, 6, 'caps at what the user owns');
  });

  test('filters by genre and by year', () => {
    const { userlib } = seed();
    assert.deepEqual(userlib.randomTracks(1, 10, { genre: 'jazz' }).map((t) => t.title), ['So What']);
    assert.deepEqual(
      userlib.randomTracks(1, 10, { fromYear: 1990, toYear: 2000 }).map((t) => t.title).sort(),
      ['Enjoy the Silence', 'Sabotage', 'Sure Shot'],
    );
  });

  test('only returns tracks the user actually owns', () => {
    const { db, userlib } = seed();
    db.prepare('DELETE FROM user_tracks WHERE track_id IN (SELECT id FROM tracks WHERE title <> ?)')
      .run('So What');
    const all = userlib.randomTracks(1, 50);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.title, 'So What');
  });
});
