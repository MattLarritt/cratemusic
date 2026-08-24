/**
 * The hand search: scoring candidates for a person to choose between.
 *
 * The endpoint is GET /api/requests/:id/releases, optionally with ?q=. Its network halves belong
 * to Prowlarr and MusicBrainz, so what is worth pinning here is the two scoring decisions that
 * make the list honest — both of which were wrong first, and both of which fail silently: a
 * broken one still returns a plausible list, just with the good releases missing from it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { score, type Candidate, type Criteria } from '../src/lib/release.js';

const MB = 1024 * 1024;

const crit = (over: Partial<Criteria> = {}): Criteria => ({
  minSeeders: 2,
  preferProtocol: 'usenet',
  formats: ['flac', 'mp3'],
  requireLossless: false,
  losslessMinMbPerTrack: 8,
  losslessMaxMbPerTrack: 500,
  lossyMinMbPerTrack: 2,
  lossyMaxMbPerTrack: 20,
  maxTotalMb: 1000,
  disqualify: [],
  ...over,
});

let n = 0;
const cand = (o: Partial<Candidate> & { title: string }): Candidate => ({
  title: o.title,
  size: o.size ?? 300 * MB,
  protocol: o.protocol ?? 'usenet',
  seeders: o.seeders ?? 0,
  grabs: o.grabs ?? 0,
  files: o.files ?? 12,
  ageDays: o.ageDays ?? 100,
  indexer: o.indexer ?? 'an indexer',
  infoUrl: o.infoUrl ?? '',
  downloadUrl: o.downloadUrl ?? `https://example.invalid/${++n}`,
  publishDate: o.publishDate ?? '',
});

/**
 * What the route does: ask once per protocol so the fallback cannot fire.
 *
 * See the comment in routes/api.ts. This mirrors it rather than importing it, because the route
 * needs a Fastify instance and eleven live dependencies to reach three lines of arithmetic.
 */
const scoreBothProtocols = (found: Candidate[], target: Parameters<typeof score>[1], c: Criteria) =>
  (['usenet', 'torrent'] as const).flatMap((proto) =>
    score(
      found.filter((f) => (f.protocol === 'torrent') === (proto === 'torrent')),
      target,
      { ...c, preferProtocol: proto },
    ),
  );

describe('the hand search', () => {
  /*
   * The Sixteen Stone case, trimmed to its essentials: one thin Usenet post that passes, and one
   * good FLAC torrent. score() on its own returns the Usenet post ALONE, because preferProtocol
   * is a fallback order — right for the pipeline, and a lie in a list a person reads, where it
   * displayed the FLAC as "filtered out".
   */
  describe('a torrent that is merely second in line', () => {
    const found = [
      cand({ title: 'Bush - Sixteen Stone', size: 50 * MB, protocol: 'usenet' }),
      cand({
        title: 'Bush - Sixteen Stone (1994 / 2014 RM) FLAC',
        size: 402 * MB,
        protocol: 'torrent',
        seeders: 12,
      }),
    ];
    const target = { artist: 'Bush', album: 'Sixteen Stone', trackCount: 0, year: '' };

    it('is dropped entirely by the ordinary scorer — which is why the route does not use it', () => {
      const one = score(found, target, crit());
      assert.equal(one.length, 1);
      assert.equal(one[0]?.protocol, 'usenet', 'the fallback order is the pipeline’s, not a verdict');
    });

    it('keeps its real score when each protocol is asked separately', () => {
      const both = scoreBothProtocols(found, target, crit());
      assert.equal(both.length, 2, 'every viable candidate must survive');
      const flac = both.find((r) => r.protocol === 'torrent');
      assert.ok(flac, 'the FLAC torrent was still dropped');
      assert.ok(flac.reasons.includes('lossless'));
      assert.ok(
        flac.score > (both.find((r) => r.protocol === 'usenet')?.score ?? 0),
        'a lossless 402MB rip with twelve seeders should outrank a 50MB unknown',
      );
    });

    it('still rejects what is genuinely unfit, on either protocol', () => {
      // A thin swarm and an over-the-ceiling release are real verdicts, and must survive the fix.
      const withJunk = [
        ...found,
        cand({ title: 'Bush - Sixteen Stone FLAC', size: 300 * MB, protocol: 'torrent', seeders: 1 }),
        cand({ title: 'Bush - Sixteen Stone 24-96 FLAC', size: 1297 * MB, protocol: 'usenet' }),
      ];
      const urls = new Set(scoreBothProtocols(withJunk, target, crit()).map((r) => r.downloadUrl));
      assert.equal(urls.size, 2, 'one-seeder and over-ceiling releases are still out');
    });
  });

  /*
   * The reason the feature exists. Crate resolves which album a requested SONG lives on, and the
   * person is typing because that answer was wrong — so the typed words have to become the
   * target. Scoring against the request's own album instead rejected all fifteen real Sixteen
   * Stone releases, correctly by its own rules and uselessly.
   */
  describe('the typed words are the target', () => {
    const real = [
      cand({ title: 'Bush - Sixteen Stone FLAC', size: 402 * MB, protocol: 'torrent', seeders: 12 }),
      cand({ title: 'Bush-Sixteen_Stone-Remastered-CD-FLAC', size: 387 * MB, protocol: 'torrent', seeders: 4 }),
    ];

    it('scoring against the album being corrected rejects everything', () => {
      // The request that failed in the wild: a track request whose album never resolved.
      const asked = { artist: 'Bush', album: 'Bush — Glycerine', trackCount: 0, year: '' };
      assert.equal(scoreBothProtocols(real, asked, crit()).length, 0);
    });

    it('scoring against what was typed finds them', () => {
      // artist is empty and the typed text is the album — containsAllWords then checks the
      // candidate titles against the words a person actually meant.
      const typed = { artist: '', album: 'Bush Sixteen Stone', trackCount: 0, year: '' };
      assert.equal(scoreBothProtocols(real, typed, crit()).length, 2);
    });

    it('typed words still gate: a different record does not match them', () => {
      // The name gate is the whole reason to pass the query as the album rather than ignore it.
      const other = [cand({ title: 'Bush - Razorblade Suitcase FLAC', protocol: 'torrent', seeders: 9 })];
      const typed = { artist: '', album: 'Bush Sixteen Stone', trackCount: 0, year: '' };
      assert.equal(scoreBothProtocols(other, typed, crit()).length, 0);
    });
  });
});
