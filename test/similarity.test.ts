/**
 * The similarity engine: pure maths over characteristic vectors.
 *
 * Tested against compareVectors directly rather than through the database, because the
 * properties that matter here are mathematical — identity, monotonicity, weighting, and the
 * treatment of missing dimensions — and a database would only obscure them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CHARACTERISTIC_BY_KEY } from '../src/lib/characteristics.js';
import { MIN_OVERLAP, compareVectors, toVector } from '../src/lib/similarity.js';

/** A vector from a plain object, for readable tests. */
const v = (o: Record<string, number>) => new Map(Object.entries(o));

/** Enough dimensions to clear MIN_OVERLAP, all at the same value. */
const flat = (value: number, keys: string[]) => v(Object.fromEntries(keys.map((k) => [k, value])));

const TEN = [
  'energy',
  'intensity',
  'danceability',
  'groove',
  'momentum',
  'darkness',
  'atmosphere',
  'warmth',
  'density',
  'tension',
];

describe('compareVectors', () => {
  it('scores an identical profile as 1', () => {
    const a = flat(0.5, TEN);
    const r = compareVectors(a, new Map(a));
    assert.equal(r.similarity, 1);
    assert.equal(r.overlap, 10);
    assert.equal(r.differences.length, 0, 'nothing differs, so nothing is reported as differing');
  });

  it('falls monotonically as profiles diverge', () => {
    const a = flat(0.5, TEN);
    const scores = [0.5, 0.6, 0.7, 0.9].map((x) => {
      const r = compareVectors(a, flat(x, TEN));
      assert.notEqual(r.similarity, null);
      return r.similarity as number;
    });
    for (let i = 1; i < scores.length; i++) {
      assert.ok(
        scores[i]! < scores[i - 1]!,
        `similarity should fall as distance grows: ${scores.join(' > ')}`,
      );
    }
    assert.equal(scores[0], 1);
  });

  it('scores maximally opposite profiles as 0', () => {
    const r = compareVectors(flat(0, TEN), flat(1, TEN));
    assert.equal(r.similarity, 0);
  });

  it('stays inside 0..1 for every combination of extremes', () => {
    for (const [x, y] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
      [0.25, 0.75],
    ]) {
      const r = compareVectors(flat(x!, TEN), flat(y!, TEN));
      assert.ok(r.similarity !== null && r.similarity >= 0 && r.similarity <= 1);
    }
  });

  it('lets weights decide how much a dimension matters', () => {
    // energy is a high-weight characteristic; harmonic_richness is a low-weight one. The same
    // sized disagreement must cost more on the dimension that carries more weight.
    assert.ok(
      CHARACTERISTIC_BY_KEY.get('energy')!.similarityWeight >
        CHARACTERISTIC_BY_KEY.get('harmonic_richness')!.similarityWeight,
    );
    const base = Object.fromEntries(TEN.map((k) => [k, 0.5]));

    const differOnEnergy = compareVectors(v({ ...base, harmonic_richness: 0.5 }), v({ ...base, energy: 0.9, harmonic_richness: 0.5 }));
    const differOnHarmony = compareVectors(v({ ...base, harmonic_richness: 0.5 }), v({ ...base, harmonic_richness: 0.9 }));

    assert.ok(
      (differOnEnergy.similarity as number) < (differOnHarmony.similarity as number),
      'a gap on a heavily-weighted dimension should hurt more',
    );
  });

  it('honours an injected weight function without touching the taxonomy', () => {
    const base = Object.fromEntries(TEN.map((k) => [k, 0.5]));
    const a = v(base);
    const b = v({ ...base, energy: 1 });
    const withEnergy = compareVectors(a, b);
    // The same pair, judged by someone who does not care about energy at all.
    const ignoringEnergy = compareVectors(a, b, { weights: (k) => (k === 'energy' ? 0 : 1) });
    assert.ok((ignoringEnergy.similarity as number) > (withEnergy.similarity as number));
    assert.equal(ignoringEnergy.similarity, 1, 'the only disagreement was excluded');
  });

  it('excludes a dimension either side is missing rather than treating it as zero', () => {
    const base = Object.fromEntries(TEN.map((k) => [k, 0.5]));
    // B has no vocal_intimacy at all (an instrumental). A scores it 1.0.
    const a = v({ ...base, vocal_intimacy: 1 });
    const b = v(base);
    const r = compareVectors(a, b);

    assert.equal(r.overlap, 10, 'the unshared dimension took no part');
    assert.equal(r.similarity, 1, 'and did not drag the score down as a 1.0-vs-0 disagreement');
    assert.ok(!r.differences.some((d) => d.characteristic === 'vocal_intimacy'));
  });

  it('proves missing and zero are genuinely different', () => {
    const base = Object.fromEntries(TEN.map((k) => [k, 0.5]));
    const a = v({ ...base, vocal_intimacy: 1 });
    const missing = compareVectors(a, v(base));
    const explicitZero = compareVectors(a, v({ ...base, vocal_intimacy: 0 }));
    assert.equal(missing.similarity, 1);
    assert.ok((explicitZero.similarity as number) < 1, 'a scored zero IS a disagreement');
  });

  it('refuses to answer when the two barely overlap', () => {
    const a = v({ energy: 0.5, darkness: 0.5, groove: 0.5 });
    const b = v({ energy: 0.5, darkness: 0.5, groove: 0.5 });
    const r = compareVectors(a, b);
    assert.equal(r.similarity, null, `three shared dimensions is under the ${MIN_OVERLAP} floor`);
    assert.equal(r.overlap, 3);
    assert.match(r.reason ?? '', /not enough to compare/);
  });

  it('says so plainly when there is nothing at all to compare', () => {
    const r = compareVectors(new Map(), new Map());
    assert.equal(r.similarity, null);
    assert.match(r.reason ?? '', /neither track has been analysed/);
  });

  it('explains itself: biggest differences first, ranked by impact not raw gap', () => {
    const base = Object.fromEntries(TEN.map((k) => [k, 0.5]));
    const a = v({ ...base, harmonic_richness: 0.5, energy: 0.5 });
    const b = v({ ...base, harmonic_richness: 1.0, energy: 0.9 });
    const r = compareVectors(a, b);

    // harmonic_richness has the LARGER raw gap (0.5 vs 0.4) but a much lower weight, so energy
    // is the more honest explanation of why these two differ.
    assert.equal(r.differences[0]!.characteristic, 'energy');
    assert.equal(r.differences[0]!.a, 0.5);
    assert.equal(r.differences[0]!.b, 0.9);
    assert.ok(r.differences.some((d) => d.characteristic === 'harmonic_richness'));
  });

  it('reports what two tracks agree on', () => {
    const a = v({ ...Object.fromEntries(TEN.map((k) => [k, 0.5])), energy: 0.1 });
    const b = v({ ...Object.fromEntries(TEN.map((k) => [k, 0.5])), energy: 0.9 });
    const r = compareVectors(a, b);
    assert.ok(r.closest.length > 0);
    assert.equal(r.closest[0]!.delta, 0, 'the closest dimensions are the ones that match');
    assert.ok(!r.closest.some((c) => c.characteristic === 'energy'));
  });

  it('compares a track against an arbitrary target profile', () => {
    // The recommendation shape: same track, but asked for more energy and less darkness.
    const track = v({ ...Object.fromEntries(TEN.map((k) => [k, 0.5])), energy: 0.45, darkness: 0.7 });
    const target = toVector({ ...Object.fromEntries(TEN.map((k) => [k, 0.5])), energy: 0.65, darkness: 0.5 });

    const self = compareVectors(track, track);
    const shifted = compareVectors(track, target);
    assert.equal(self.similarity, 1);
    assert.ok((shifted.similarity as number) < 1, 'the target is deliberately not the track');
    assert.ok((shifted.similarity as number) > 0.8, 'but it is a nudge, not a different song');
    assert.deepEqual(
      shifted.differences.map((d) => d.characteristic).sort(),
      ['darkness', 'energy'],
    );
  });

  it('ignores unknown keys and clamps out-of-range values in a target profile', () => {
    const t = toVector({ energy: 0.5, not_a_characteristic: 0.9, darkness: 5, warmth: -2 });
    assert.equal(t.has('not_a_characteristic'), false);
    assert.equal(t.get('darkness'), 1);
    assert.equal(t.get('warmth'), 0);
  });
});
