import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { narrow, line, CATALOG_CHAR_BUDGET, MIN_POOL, type CatalogTrack } from '../src/lib/curate.js';
import { failureReason } from '../src/lib/openai.js';

/**
 * The bug these guard: the whole library went up in one request, which at a few thousand
 * tracks is tens of thousands of tokens against a much smaller per-minute ceiling. Every
 * build returned 429. The rules below keep the payload bounded WITHOUT quietly curating
 * from an arbitrary slice, which would be the worse failure of the two.
 */

let next = 1;
const track = (artist: string, title: string, genres = 'rock', year: number | null = 2000): CatalogTrack => ({
  id: next++,
  artist,
  title,
  album: 'An Album',
  year,
  genres,
});

function library(artists: number, per: number, genres = 'rock'): CatalogTrack[] {
  const out: CatalogTrack[] = [];
  for (let a = 0; a < artists; a += 1) {
    for (let i = 0; i < per; i += 1) out.push(track(`Artist ${a}`, `Song ${i}`, genres));
  }
  return out;
}

describe('narrow: budget', () => {
  test('a library inside the budget is sent whole', () => {
    const r = narrow(library(5, 4), null);
    assert.equal(r.tracks.length, 20);
    assert.equal(r.sampled, false);
  });

  test('a library over the budget is cut down to fit it', () => {
    const lib = library(300, 20);
    const r = narrow(lib, null);
    assert.equal(r.sampled, true);
    const chars = r.tracks.reduce((n, t) => n + line(t).length + 1, 0);
    assert.ok(chars <= CATALOG_CHAR_BUDGET, `${chars} must fit ${CATALOG_CHAR_BUDGET}`);
    assert.ok(r.tracks.length < lib.length);
  });

  test('sampling spreads across artists instead of taking the first ones whole', () => {
    // The failure this prevents: the catalog is ordered by artist, so a plain slice would
    // send everything by the first few dozen artists and nothing by the rest.
    const r = narrow(library(300, 20), null);
    const artists = new Set(r.tracks.map((t) => t.artist));
    assert.equal(artists.size, 300, 'every artist should be represented');
    const counts = [...artists].map((a) => r.tracks.filter((t) => t.artist === a).length);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, 'evenly spread');
  });

  test('the result is deterministic — same library, same pool', () => {
    const lib = library(300, 20);
    assert.deepEqual(narrow(lib, null).tracks.map((t) => t.id), narrow(lib, null).tracks.map((t) => t.id));
  });
});

describe('narrow: the plan', () => {
  const lib = [
    track('Miles Davis', 'So What', 'jazz', 1959),
    track('Bill Evans', 'Peace Piece', 'jazz', 1958),
    track('Linkin Park', 'Numb', 'nu metal, rock', 2003),
    track('Slipknot', 'Duality', 'nu metal', 2004),
    ...library(10, 6, 'pop'),
  ];

  test('filters to the named genres', () => {
    const r = narrow(lib, { genres: ['jazz'], artists: [], fromYear: null, toYear: null }, { budget: 100_000, minPool: 0 });
    assert.deepEqual(r.tracks.map((t) => t.title).sort(), ['Peace Piece', 'So What']);
  });

  test('genre match is whole-value, not substring', () => {
    const r = narrow(lib, { genres: ['metal'], artists: [], fromYear: null, toYear: null }, { budget: 100_000, minPool: 0 });
    assert.equal(r.matched, 0, "'metal' must not sweep in 'nu metal'");
  });

  test('a named artist is kept even when their genre was not asked for', () => {
    const r = narrow(lib, { genres: ['jazz'], artists: ['Linkin Park'], fromYear: null, toYear: null }, { budget: 100_000, minPool: 0 });
    assert.ok(r.tracks.some((t) => t.title === 'Numb'));
    assert.ok(r.tracks.some((t) => t.title === 'So What'));
  });

  test('artist matching survives punctuation and case', () => {
    const r = narrow(
      [track('A-Ha', 'Take On Me', 'synthpop', 1985)],
      { genres: [], artists: ['a ha'], fromYear: null, toYear: null },
      { budget: 100_000, minPool: 0 },
    );
    assert.equal(r.matched, 1);
  });

  test('years bound the pool, and a track with no year is not guessed into it', () => {
    const dated = [
      track('A', 'old', 'rock', 1975),
      track('B', 'new', 'rock', 2015),
      track('C', 'unknown', 'rock', null),
    ];
    const r = narrow(dated, { genres: [], artists: [], fromYear: 2000, toYear: 2020 }, { budget: 100_000, minPool: 0 });
    assert.deepEqual(r.tracks.map((t) => t.title), ['new']);
  });

  test('a plan naming neither genre nor artist is a pure year filter, not an empty result', () => {
    const r = narrow(lib, { genres: [], artists: [], fromYear: 1950, toYear: 1960 }, { budget: 100_000, minPool: 0 });
    assert.equal(r.tracks.length, 2);
  });
});

describe('narrow: widening', () => {
  test('a plan that matches almost nothing falls back to the whole library', () => {
    // The real case: the model invents a genre spelling the library does not use. Handing
    // the curator three tracks and asking for twenty is worse than a broad pool.
    const r = narrow(library(20, 5, 'rock'), { genres: ['vaporwave'], artists: [], fromYear: null, toYear: null }, { budget: 100_000 });
    assert.equal(r.matched, 0);
    assert.equal(r.widened, true);
    assert.equal(r.tracks.length, 100);
  });

  test('a plan matching enough is left alone', () => {
    const r = narrow(library(20, 5, 'rock'), { genres: ['rock'], artists: [], fromYear: null, toYear: null }, { budget: 100_000 });
    assert.equal(r.widened, false);
    assert.ok(r.matched >= MIN_POOL);
  });

  test('a small library is not "widened" into itself', () => {
    const r = narrow(library(2, 3, 'rock'), { genres: ['rock'], artists: [], fromYear: null, toYear: null }, { budget: 100_000 });
    assert.equal(r.widened, false, 'everything already matched');
  });

  test('widening still respects the budget', () => {
    const r = narrow(library(300, 20, 'rock'), { genres: ['nothing-matches'], artists: [], fromYear: null, toYear: null });
    assert.equal(r.widened, true);
    const chars = r.tracks.reduce((n, t) => n + line(t).length + 1, 0);
    assert.ok(chars <= CATALOG_CHAR_BUDGET);
  });
});

describe('failureReason', () => {
  test('a too-large 429 says so instead of blaming the prompt', () => {
    // The misdiagnosis that shipped: this surfaced as "try rewording", which cannot help.
    const m = failureReason(new Error('HTTP 429: {"error":{"message":"Request too large for gpt-4.1"}}'));
    assert.match(m, /one minute/);
    assert.doesNotMatch(m, /rewording/);
  });

  test('an ordinary 429 suggests waiting', () => {
    assert.match(failureReason(new Error('HTTP 429: {"error":{"message":"Rate limit reached"}}')), /wait a minute/);
  });

  test('an auth failure points at the setting that fixes it', () => {
    assert.match(failureReason(new Error('HTTP 401: nope')), /Admin → Settings/);
  });

  test('a server error and a timeout each say which', () => {
    assert.match(failureReason(new Error('HTTP 503: upstream')), /server error/);
    assert.match(failureReason(new Error('request timed out')), /too long/);
  });

  test('anything unrecognised is passed through rather than invented', () => {
    assert.equal(failureReason(new Error('socket hang up')), 'socket hang up');
  });
});
