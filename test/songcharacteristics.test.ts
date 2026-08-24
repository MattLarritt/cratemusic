/**
 * Song characteristics, tested against a real SQLite database and an injected classifier.
 *
 * The database is the real schema on :memory: — testing storage against a mock would prove
 * nothing about the uniqueness constraints and the source-scoped delete that are doing the
 * actual work. The classifier is a function parameter, which is why every path below —
 * success, incomplete answers, invalid scores, rate limits, reanalysis — runs deterministically
 * without a network.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

import { open as openDb } from '../src/db/schema.js';
import {
  CHARACTERISTICS,
  CLASSIFIER_VERSION,
  validateScores,
  type AnalysisInput,
  type AnalysisResult,
} from '../src/lib/characteristics.js';
import { Settings } from '../src/lib/settings.js';
import { Similarity } from '../src/lib/similarity.js';
import { SongCharacteristics, type CharacteristicClassifier } from '../src/lib/songcharacteristics.js';

/** Keys the classifier must return for a profile to count as complete. */
const REQUIRED = CHARACTERISTICS.filter((c) => c.enabled && !c.conditional).map((c) => c.key);
/** Mirrors MAX_CONCURRENT in the service; the constant is private, the behaviour is not. */
const MAX_CONCURRENT_EXPECTED = 4;
const CONDITIONAL = CHARACTERISTICS.filter((c) => c.conditional).map((c) => c.key);

/** A complete, valid profile — every required key at `value`, vocals included. */
const fullProfile = (value = 0.5): Record<string, number | null> => {
  const out: Record<string, number | null> = {};
  for (const k of REQUIRED) out[k] = value;
  for (const k of CONDITIONAL) out[k] = value;
  return out;
};

function makeDb(): Database.Database {
  const db = openDb(':memory:');
  const insert = db.prepare(
    `INSERT INTO tracks (path, size, mtime, artist_name, album_title, title,
                         norm_artist, norm_album, norm_title, genres, year, first_seen)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  insert.run('/music/a.flac', 1000, 1, 'Radiohead', 'In Rainbows', 'All I Need',
    'radiohead', 'in rainbows', 'all i need', 'alternative rock', 2007, 1000);
  insert.run('/music/b.flac', 1000, 1, 'Pantera', 'Vulgar Display', 'Walk',
    'pantera', 'vulgar display', 'walk', 'groove metal', 1992, 1000);
  return db;
}

function makeSettings(db: Database.Database, over: Record<string, string> = {}): Settings {
  const s = new Settings(db, {});
  s.set({ songCharacteristics: true, openaiKey: 'test-key', ...over });
  return s;
}

/** A classifier that answers every track in the batch identically, and counts requests. */
function stub(
  scores: Record<string, number | null> | null | (() => never),
): CharacteristicClassifier & { calls: AnalysisInput[]; batches: number } {
  const calls: AnalysisInput[] = [];
  const fn = (async (inputs: AnalysisInput[]) => {
    calls.push(...inputs);
    fn.batches++;
    if (typeof scores === 'function') scores();
    if (scores === null) return null;
    return { tracks: inputs.map((i) => ({ trackId: i.trackId, scores })), model: 'stub-model' };
  }) as CharacteristicClassifier & { calls: AnalysisInput[]; batches: number };
  fn.calls = calls;
  fn.batches = 0;
  return fn;
}

const build = (db: Database.Database, settings: Settings, classifier: CharacteristicClassifier) => {
  const similarity = new Similarity(db);
  const svc = new SongCharacteristics(db, settings, classifier, similarity);
  svc.syncTaxonomy();
  return { svc, similarity };
};

const rows = (db: Database.Database, trackId: number) =>
  db
    .prepare(
      'SELECT characteristic_key, score, source FROM track_characteristics WHERE track_id = ? ORDER BY characteristic_key',
    )
    .all(trackId) as { characteristic_key: string; score: number; source: string }[];

// ---- the validation gate ---------------------------------------------------

describe('validateScores', () => {
  it('accepts a complete profile and reports nothing missing', () => {
    const { scores, rejected, missing } = validateScores(fullProfile(0.42));
    assert.equal(rejected.length, 0);
    assert.equal(missing.length, 0);
    assert.equal(scores.size, REQUIRED.length + CONDITIONAL.length);
    assert.equal(scores.get('energy'), 0.42);
  });

  it('rejects characteristics that are not in the taxonomy', () => {
    const { scores, rejected } = validateScores({ ...fullProfile(), vibeyness: 0.9 });
    assert.equal(scores.has('vibeyness'), false);
    assert.match(rejected.join(' '), /unknown characteristic "vibeyness"/);
  });

  it('rejects scores outside 0..1 and malformed scores', () => {
    const { scores, rejected } = validateScores({
      ...fullProfile(),
      energy: 1.4,
      darkness: -0.2,
      warmth: 'quite',
    });
    assert.equal(scores.has('energy'), false);
    assert.equal(scores.has('darkness'), false);
    assert.equal(scores.has('warmth'), false);
    assert.match(rejected.join(' '), /out of range for "energy"/);
    assert.match(rejected.join(' '), /out of range for "darkness"/);
    assert.match(rejected.join(' '), /malformed score for "warmth"/);
  });

  it('keeps 0 and 1 — they are real scores, not missing data', () => {
    const { scores } = validateScores({ ...fullProfile(), danceability: 0, energy: 1 });
    assert.equal(scores.get('danceability'), 0);
    assert.equal(scores.get('energy'), 1);
  });

  it('reports every required characteristic the model failed to provide', () => {
    const partial = fullProfile();
    delete partial.energy;
    delete partial.darkness;
    const { missing } = validateScores(partial);
    assert.deepEqual(missing.sort(), ['darkness', 'energy']);
  });

  it('allows null only for conditional vocal dimensions', () => {
    const instrumental = { ...fullProfile(), vocal_presence: 0 };
    for (const k of CONDITIONAL) instrumental[k] = null;
    const { scores, rejected, missing } = validateScores(instrumental);
    assert.equal(missing.length, 0, 'conditional keys are not required');
    assert.equal(rejected.length, 0, 'and a null there is not an error');
    assert.equal(scores.get('vocal_presence'), 0, 'but vocal_presence itself is still scored');
    for (const k of CONDITIONAL) assert.equal(scores.has(k), false, `${k} is left unscored`);
  });

  it('treats a null on a non-conditional characteristic as an error', () => {
    const { rejected } = validateScores({ ...fullProfile(), energy: null });
    assert.match(rejected.join(' '), /null score for "energy"/);
  });
});

// ---- the service -----------------------------------------------------------

describe('SongCharacteristics', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('analyses nothing while the feature is disabled', async () => {
    const settings = makeSettings(db, { songCharacteristics: '0' });
    const classifier = stub(fullProfile());
    const { svc } = build(db, settings, classifier);

    svc.queue([1]);
    assert.equal(await svc.tick(), 'disabled');
    assert.equal(classifier.calls.length, 0);
    assert.deepEqual(rows(db, 1), []);
  });

  it('treats an enabled feature with no API key as unable to run, not as an error', async () => {
    const settings = new Settings(db, {});
    settings.set({ songCharacteristics: true });
    const classifier = stub(fullProfile());
    const { svc } = build(db, settings, classifier);
    svc.queue([1]);

    assert.equal(await svc.tick(), 'disabled');
    assert.equal(classifier.calls.length, 0);
    assert.equal(svc.statusOf(1).state, 'pending', 'nothing was attempted, so nothing failed');
  });

  it('queues and stores a complete profile when enabled', async () => {
    const settings = makeSettings(db);
    const classifier = stub({ ...fullProfile(0.5), energy: 0.54, darkness: 0.79, atmosphere: 0.91 });
    const { svc } = build(db, settings, classifier);

    assert.deepEqual(svc.queue([1]), { queued: 1, skipped: 0 });
    assert.equal(svc.statusOf(1).state, 'pending');
    assert.equal(await svc.tick(), 'analysed');

    const status = svc.statusOf(1);
    assert.equal(status.state, 'analysed');
    assert.equal(status.version, CLASSIFIER_VERSION);
    assert.equal(status.model, 'stub-model');
    assert.equal(status.current, true);
    assert.ok(status.analysedAt && status.analysedAt > 0);
    assert.equal(status.characteristics.length, REQUIRED.length + CONDITIONAL.length);

    const byKey = new Map(status.characteristics.map((c) => [c.key, c]));
    assert.equal(byKey.get('energy')!.score, 0.54);
    assert.equal(byKey.get('darkness')!.score, 0.79);
    assert.equal(byKey.get('atmosphere')!.score, 0.91);
    // Display metadata comes from the taxonomy table, not from the model.
    assert.equal(byKey.get('energy')!.name, 'Energy');
    assert.equal(byKey.get('energy')!.group, 'energy');
  });

  it('sends the classifier only metadata crate actually holds', async () => {
    const settings = makeSettings(db);
    const classifier = stub(fullProfile());
    const { svc } = build(db, settings, classifier);
    svc.queue([1]);
    await svc.tick();

    const input = classifier.calls.find((c) => c.trackId === 1)!;
    assert.equal(input.title, 'All I Need');
    assert.equal(input.artistName, 'Radiohead');
    assert.equal(input.year, 2007);
    assert.deepEqual(input.genres, ['alternative rock']);
    // Never invented: no analyzer run, no MusicBrainz id, no lyrics cached.
    assert.equal(input.energy, null);
    assert.equal(input.bpm, null);
    assert.equal(input.albumMbid, null);
    assert.equal(input.hasLyrics, false);
  });

  it('rejects an incomplete profile rather than storing a vector full of holes', async () => {
    const settings = makeSettings(db);
    const half = fullProfile();
    for (const k of REQUIRED.slice(0, Math.ceil(REQUIRED.length / 2))) delete half[k];
    const { svc } = build(db, settings, stub(half));
    svc.queue([1]);

    assert.equal(await svc.tick(), 'failed');
    assert.deepEqual(rows(db, 1), [], 'nothing partial was written');
    assert.match(svc.statusOf(1).detail, /incomplete profile/);
  });

  it('tolerates a couple of dropped characteristics', async () => {
    const settings = makeSettings(db);
    const nearly = fullProfile();
    delete nearly.harmonic_richness;
    delete nearly.syncopation;
    const { svc } = build(db, settings, stub(nearly));
    svc.queue([1]);

    assert.equal(await svc.tick(), 'analysed');
    const keys = new Set(rows(db, 1).map((r) => r.characteristic_key));
    assert.equal(keys.has('harmonic_richness'), false);
    assert.equal(keys.has('energy'), true);
  });

  it('leaves vocal dimensions unscored on an instrumental', async () => {
    const settings = makeSettings(db);
    const instrumental: Record<string, number | null> = { ...fullProfile(), vocal_presence: 0 };
    for (const k of CONDITIONAL) instrumental[k] = null;
    const { svc, similarity } = build(db, settings, stub(instrumental));
    svc.queue([1]);
    await svc.tick();

    const stored = new Map(rows(db, 1).map((r) => [r.characteristic_key, r.score]));
    assert.equal(stored.get('vocal_presence'), 0, 'fully instrumental is a real score');
    for (const k of CONDITIONAL) {
      assert.equal(stored.has(k), false, `${k} has no row rather than a misleading zero`);
    }
    assert.equal(similarity.vectorOf(1)!.has('vocal_intimacy'), false);
  });

  it('does not fail ingestion when analysis fails', async () => {
    const settings = makeSettings(db);
    const { svc } = build(db, settings, stub(() => {
      throw new Error('provider exploded');
    }));
    svc.queue([1]);

    // The point: tick() resolves, it does not reject, and the track is untouched and playable.
    assert.equal(await svc.tick(), 'failed');
    const track = db.prepare('SELECT title FROM tracks WHERE id = 1').get() as { title: string };
    assert.equal(track.title, 'All I Need');
    assert.equal(svc.statusOf(1).state, 'failed');
    assert.match(svc.statusOf(1).detail, /provider exploded/);
  });

  it('backs off without penalty when the provider rate-limits', async () => {
    const settings = makeSettings(db);
    const classifier = stub(() => {
      throw new Error('HTTP 429: slow down');
    });
    const { svc } = build(db, settings, classifier);
    svc.queue([1, 2]);

    assert.equal(await svc.tick(), 'failed');
    for (const id of [1, 2]) {
      assert.equal(svc.statusOf(id).state, 'pending');
      assert.equal(svc.statusOf(id).attempts, 0);
    }
    assert.equal(await svc.tick(), 'cooling');
    assert.equal(classifier.batches, 1);
  });

  it('skips a current profile and reanalyses on request', async () => {
    const settings = makeSettings(db);
    const classifier = stub(fullProfile());
    const { svc } = build(db, settings, classifier);
    svc.queue([1]);
    await svc.tick();
    assert.equal(classifier.batches, 1);

    assert.deepEqual(svc.queue([1]), { queued: 0, skipped: 1 });
    assert.equal(await svc.tick(), 'idle');
    assert.equal(classifier.batches, 1);

    assert.deepEqual(svc.queue([1], { force: true }), { queued: 1, skipped: 0 });
    assert.equal(await svc.tick(), 'analysed');
    assert.equal(classifier.batches, 2);
  });

  it('identifies a profile from an older classifier version as stale', async () => {
    const settings = makeSettings(db);
    const { svc } = build(db, settings, stub(fullProfile()));
    svc.queue([1]);
    await svc.tick();

    db.prepare("UPDATE track_characteristic_runs SET version = 'song-characteristics-v0' WHERE track_id = 1").run();
    assert.equal(svc.isCurrent(1), false);
    assert.equal(svc.statusOf(1).current, false);
    assert.equal(svc.progress().stale, 1);
    assert.deepEqual(svc.queue([1]), { queued: 1, skipped: 0 });
  });

  it('replaces the AI profile on reanalysis rather than accumulating scores', async () => {
    const settings = makeSettings(db);
    let reply = fullProfile(0.2);
    const similarity = new Similarity(db);
    const svc = new SongCharacteristics(db, settings, async (inputs) => ({
      model: 'stub-model',
      tracks: inputs.map((i) => ({ trackId: i.trackId, scores: reply })),
    }), similarity);
    svc.syncTaxonomy();

    svc.queue([1]);
    await svc.tick();
    const first = rows(db, 1).length;
    assert.equal(rows(db, 1)[0]!.score, 0.2);

    reply = fullProfile(0.8);
    svc.queue([1], { force: true });
    await svc.tick();

    assert.equal(rows(db, 1).length, first, 'the same dimensions, not twice as many');
    assert.equal(rows(db, 1)[0]!.score, 0.8);
  });

  it('never destroys a hand-set score through reanalysis', async () => {
    const settings = makeSettings(db);
    let reply = fullProfile(0.2);
    const similarity = new Similarity(db);
    const svc = new SongCharacteristics(db, settings, async (inputs) => ({
      model: 'stub-model',
      tracks: inputs.map((i) => ({ trackId: i.trackId, scores: reply })),
    }), similarity);
    svc.syncTaxonomy();
    svc.queue([1]);
    await svc.tick();

    assert.equal(svc.setManual(1, 'energy', 0.95), true);

    reply = fullProfile(0.8);
    svc.queue([1], { force: true });
    await svc.tick();

    const byKey = new Map(svc.profileOf(1).map((c) => [c.key, c]));
    assert.equal(byKey.get('energy')!.score, 0.95, 'the hand-set value survives');
    assert.equal(byKey.get('energy')!.source, 'manual', 'and still outranks the fresh AI score');
    assert.equal(byKey.get('darkness')!.score, 0.8, 'while everything else was updated');
    // And the similarity engine sees the curated value, not the model's.
    assert.equal(similarity.vectorOf(1)!.get('energy'), 0.95);
  });

  it('rejects manual scores outside the taxonomy or the 0..1 range', () => {
    const settings = makeSettings(db);
    const { svc } = build(db, settings, stub(null));
    assert.equal(svc.setManual(1, 'vibeyness', 0.5), false);
    assert.equal(svc.setManual(1, 'energy', 1.5), false);
    assert.equal(svc.setManual(1, 'energy', -1), false);
    assert.equal(svc.setManual(1, 'energy', Number.NaN), false);
    assert.equal(svc.setManual(999, 'energy', 0.5), false);
    assert.deepEqual(rows(db, 1), []);
  });

  it('reveals the AI score again when a manual override is removed', async () => {
    const settings = makeSettings(db);
    const { svc } = build(db, settings, stub(fullProfile(0.3)));
    svc.queue([1]);
    await svc.tick();
    svc.setManual(1, 'energy', 0.9);
    assert.equal(svc.profileOf(1).find((c) => c.key === 'energy')!.score, 0.9);

    assert.equal(svc.removeManual(1, 'energy'), true);
    const back = svc.profileOf(1).find((c) => c.key === 'energy')!;
    assert.equal(back.score, 0.3);
    assert.equal(back.source, 'ai');
  });

  it('runs a library batch to completion, in one request, idempotently', async () => {
    const settings = makeSettings(db);
    const classifier = stub(fullProfile());
    const { svc } = build(db, settings, classifier);

    assert.deepEqual(svc.queueLibrary('lib-1'), { queued: 2, skipped: 0 });
    assert.deepEqual(svc.batchProgress('lib-1'), { total: 2, done: 0, failed: 0, open: 2 });

    assert.equal(await svc.tick(), 'analysed');
    assert.deepEqual(svc.batchProgress('lib-1'), { total: 2, done: 2, failed: 0, open: 0 });
    assert.equal(classifier.batches, 1, 'both tracks in a single call');
    assert.equal(await svc.tick(), 'idle');

    // Re-running analyses nothing, because everything is already current.
    assert.deepEqual(svc.queueLibrary('lib-2'), { queued: 0, skipped: 2 });
    assert.equal(await svc.tick(), 'idle');
    assert.equal(classifier.batches, 1);
  });

  it('batches several tracks per request rather than one each', async () => {
    const insert = db.prepare(
      `INSERT INTO tracks (path, size, mtime, artist_name, album_title, title,
                           norm_artist, norm_album, norm_title, genres, year, first_seen)
       VALUES (?,1,1,?,?,?,?,?,?,?,?,1)`,
    );
    for (let i = 0; i < 20; i++) {
      insert.run(`/music/x${i}.flac`, `Artist ${i}`, 'Album', `Song ${i}`,
        `artist ${i}`, 'album', `song ${i}`, 'rock', 2000);
    }
    const settings = makeSettings(db);
    const classifier = stub(fullProfile());
    const { svc } = build(db, settings, classifier);
    svc.queueLibrary('lib-1');

    // 22 tracks at five a batch: five requests, not twenty-two.
    for (let i = 0; i < 5; i++) assert.equal(await svc.tick(), 'analysed');
    assert.equal(classifier.batches, 5);
    assert.equal(classifier.calls.length, 22);
    assert.equal(await svc.tick(), 'idle');
    assert.equal(svc.progress().counts.analysed, 22);
  });

  it('keeps the good tracks when one profile in a batch is unusable', async () => {
    const settings = makeSettings(db);
    const bad = fullProfile();
    for (const k of REQUIRED.slice(0, 30)) delete bad[k];
    const similarity = new Similarity(db);
    const svc = new SongCharacteristics(db, settings, async (inputs) => ({
      model: 'stub-model',
      tracks: inputs.map((i) => ({ trackId: i.trackId, scores: i.trackId === 1 ? fullProfile() : bad })),
    }), similarity);
    svc.syncTaxonomy();
    svc.queue([1, 2]);

    assert.equal(await svc.tick(), 'analysed');
    assert.equal(svc.statusOf(1).state, 'analysed');
    assert.equal(svc.statusOf(2).state, 'failed');
  });

  it('marks a track the model silently dropped as failed, not left hanging', async () => {
    const settings = makeSettings(db);
    const similarity = new Similarity(db);
    const svc = new SongCharacteristics(db, settings, async (inputs) => ({
      model: 'stub-model',
      tracks: inputs.filter((i) => i.trackId === 1).map((i) => ({ trackId: i.trackId, scores: fullProfile() })),
    }), similarity);
    svc.syncTaxonomy();
    svc.queue([1, 2]);
    await svc.tick();

    assert.equal(svc.statusOf(1).state, 'analysed');
    assert.equal(svc.statusOf(2).state, 'failed');
    assert.match(svc.statusOf(2).detail, /did not return this track/);
  });

  it('runs several batches at once, but never more than the cap', async () => {
    /*
     * Two regressions in one test, because they are opposite failures of the same line.
     *
     * First: the worker ticks faster than the API answers, and with no limit at all it drifted to
     * eight concurrent requests that nobody had chosen. Then: a boolean guard fixed the honesty
     * and made it strictly serial, which at nine seconds a track meant seven hours for this
     * library. What has to hold is a CHOSEN number — several at once, and never more.
     */
    const insert = db.prepare(
      `INSERT INTO tracks (path, size, mtime, artist_name, album_title, title,
                           norm_artist, norm_album, norm_title, genres, year, first_seen)
       VALUES (?,1,1,?,?,?,?,?,?,?,?,1)`,
    );
    for (let i = 0; i < 60; i++) {
      insert.run(`/music/y${i}.flac`, `Artist ${i}`, 'Album', `Song ${i}`,
        `artist ${i}`, 'album', `song ${i}`, 'rock', 2000);
    }
    const settings = makeSettings(db);
    const releases: (() => void)[] = [];
    let started = 0;
    let peak = 0;
    let live = 0;
    const similarity = new Similarity(db);
    const svc = new SongCharacteristics(
      db,
      settings,
      async (inputs) => {
        started++;
        live++;
        peak = Math.max(peak, live);
        // Hold every call open, exactly as a slow API would.
        await new Promise<void>((resolve) => releases.push(resolve));
        live--;
        return { model: 'stub-model', tracks: inputs.map((i) => ({ trackId: i.trackId, scores: fullProfile() })) };
      },
      similarity,
    );
    svc.syncTaxonomy();
    svc.queueLibrary('lib');

    // Fire the timer ten times with nothing completing in between.
    const running = Array.from({ length: 10 }, () => svc.tick());
    await new Promise((r) => setImmediate(r));

    const observed = { started, peak };
    // Released before the assertions, not after: a failing expectation must not strand four
    // pending promises, or node:test reports "event loop drained" instead of the real reason.
    releases.forEach((r) => r());
    const outcomes = await Promise.all(running);

    assert.ok(observed.started > 1, 'more than one batch may be out at once');
    assert.equal(observed.started, MAX_CONCURRENT_EXPECTED, 'and no more than the cap');
    assert.equal(observed.peak, MAX_CONCURRENT_EXPECTED);
    assert.equal(outcomes.filter((o) => o === 'analysed').length, MAX_CONCURRENT_EXPECTED);
    assert.equal(
      outcomes.filter((o) => o === 'cooling').length,
      10 - MAX_CONCURRENT_EXPECTED,
      'the ticks turned away say so rather than pretending to have worked',
    );

    /*
     * Slots are returned, so the worker picks up again. Checked by STARTING another batch rather
     * than awaiting one: this stub only completes when the test releases it, so awaiting a tick
     * whose release never comes hangs forever — which is exactly how this test failed the first
     * time it was written.
     */
    const more = svc.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(started, MAX_CONCURRENT_EXPECTED + 1, 'a freed slot is used');
    releases.forEach((r) => r());
    await more;
  });

  it('auto-enrols only tracks first seen after the feature was switched on', async () => {
    db.prepare('UPDATE tracks SET first_seen = 500 WHERE id = 1').run();
    db.prepare('UPDATE tracks SET first_seen = 2000 WHERE id = 2').run();
    const settings = makeSettings(db, { songCharacteristicsSince: '1000' });
    const classifier = stub(fullProfile());
    const { svc } = build(db, settings, classifier);

    assert.equal(await svc.tick(), 'analysed');
    assert.equal(classifier.calls.length, 1);
    assert.equal(classifier.calls[0]!.trackId, 2, 'the pre-existing library is not enrolled');
    assert.equal(svc.statusOf(1).state, 'not-analysed');
  });

  it('keeps characteristics readable after the feature is switched off', async () => {
    const settings = makeSettings(db);
    const { svc } = build(db, settings, stub(fullProfile()));
    svc.queue([1]);
    await svc.tick();

    settings.set({ songCharacteristics: false });
    assert.equal(svc.enabled(), false);
    assert.ok(svc.profileOf(1).length > 40, 'disabling stops analysis, it does not hide data');
    assert.equal(svc.statusOf(1).state, 'analysed');
  });

  it('reports progress across every state', async () => {
    const settings = makeSettings(db);
    let reply: Record<string, number | null> | null = fullProfile();
    const similarity = new Similarity(db);
    const svc = new SongCharacteristics(
      db,
      settings,
      async (inputs) =>
        reply
          ? { model: 'stub-model', tracks: inputs.map((i) => ({ trackId: i.trackId, scores: reply! })) }
          : null,
      similarity,
    );
    svc.syncTaxonomy();

    assert.deepEqual(svc.progress().counts, {
      notAnalysed: 2, pending: 0, analysing: 0, analysed: 0, failed: 0,
    });

    svc.queue([1]);
    await svc.tick();
    reply = null;
    svc.queue([2]);
    await svc.tick();

    const p = svc.progress();
    assert.equal(p.enabled, true);
    assert.equal(p.ready, true);
    assert.equal(p.version, CLASSIFIER_VERSION);
    assert.equal(p.characteristics, CHARACTERISTICS.filter((c) => c.enabled).length);
    assert.equal(p.counts.analysed, 1);
    assert.equal(p.counts.failed, 1);
  });

  it('feeds the similarity engine, and invalidates it on every write', async () => {
    const settings = makeSettings(db);
    let reply = fullProfile(0.5);
    const similarity = new Similarity(db);
    const svc = new SongCharacteristics(db, settings, async (inputs) => ({
      model: 'stub-model',
      tracks: inputs.map((i) => ({ trackId: i.trackId, scores: reply })),
    }), similarity);
    svc.syncTaxonomy();

    svc.queue([1]);
    await svc.tick();
    reply = fullProfile(0.5);
    svc.queue([2]);
    await svc.tick();

    // Identical profiles, so identical tracks.
    assert.equal(similarity.compareTracks(1, 2).similarity, 1);

    // Move one of them and the cached vectors must not go stale.
    svc.setManual(1, 'energy', 0);
    svc.setManual(1, 'darkness', 1);
    const after = similarity.compareTracks(1, 2);
    assert.ok((after.similarity as number) < 1, 'the cache was invalidated by the manual write');
    assert.deepEqual(after.differences.map((d) => d.characteristic).sort(), ['darkness', 'energy']);
  });

  it('says so rather than guessing when a track has no profile', () => {
    const settings = makeSettings(db);
    const { similarity } = build(db, settings, stub(null));
    const r = similarity.compareTracks(1, 2);
    assert.equal(r.similarity, null);
    assert.match(r.reason ?? '', /analysed/);
  });

  it('finds similar tracks, excluding the seed and optionally its artist', async () => {
    const settings = makeSettings(db);
    const similarity = new Similarity(db);
    const svc = new SongCharacteristics(db, settings, async (inputs) => ({
      model: 'stub-model',
      // Track 2 is deliberately further away than track 3.
      tracks: inputs.map((i) => ({
        trackId: i.trackId,
        scores: fullProfile(i.trackId === 1 ? 0.5 : i.trackId === 2 ? 0.9 : 0.55),
      })),
    }), similarity);
    svc.syncTaxonomy();
    db.prepare(
      `INSERT INTO tracks (path,size,mtime,artist_name,album_title,title,norm_artist,norm_album,norm_title,genres,year,first_seen)
       VALUES ('/music/c.flac',1,1,'Radiohead','In Rainbows','Nude','radiohead','in rainbows','nude','alternative rock',2007,1)`,
    ).run();
    svc.queueLibrary('lib');
    await svc.tick();

    const all = similarity.findSimilar(1, { limit: 5 });
    assert.equal(all.results[0]!.trackId, 3, 'the nearest profile ranks first');
    assert.ok(!all.results.some((r) => r.trackId === 1), 'and the seed is never its own neighbour');

    const others = similarity.findSimilar(1, { limit: 5, sameArtist: false });
    assert.ok(!others.results.some((r) => r.artistName === 'Radiohead'));
  });

  it('ranks the library against an arbitrary target profile', async () => {
    const settings = makeSettings(db);
    const similarity = new Similarity(db);
    const svc = new SongCharacteristics(db, settings, async (inputs) => ({
      model: 'stub-model',
      tracks: inputs.map((i) => ({ trackId: i.trackId, scores: fullProfile(i.trackId === 1 ? 0.2 : 0.8) })),
    }), similarity);
    svc.syncTaxonomy();
    svc.queueLibrary('lib');
    await svc.tick();

    // "Something high on everything" should find track 2, not track 1.
    const target = Object.fromEntries(REQUIRED.map((k) => [k, 0.85]));
    const r = similarity.findSimilar(target, { limit: 5 });
    assert.equal(r.results[0]!.trackId, 2);
  });

  it('retires a characteristic without losing scores that used it', async () => {
    const settings = makeSettings(db);
    const { svc } = build(db, settings, stub(fullProfile()));
    svc.queue([1]);
    await svc.tick();

    // What a future taxonomy revision looks like from the database's point of view.
    db.prepare("UPDATE characteristics SET enabled = 0 WHERE key = 'cinematic'").run();
    const stored = svc.profileOf(1).find((c) => c.key === 'cinematic');
    assert.ok(stored, 'the score still reads');
    assert.equal(stored!.name, 'Cinematic', 'and still has a display name');
    assert.equal(svc.taxonomy().find((c) => c.key === 'cinematic')!.enabled, false);
  });
});
