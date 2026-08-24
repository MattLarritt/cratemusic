import type Database from 'better-sqlite3';
import type { Settings } from './settings.js';
import type { Similarity } from './similarity.js';
import {
  CHARACTERISTICS,
  CHARACTERISTIC_BY_KEY,
  CLASSIFIER_VERSION,
  validateScores,
  mergeScores,
  type AnalysisInput,
  type AnalysisResult,
  type AnalysisState,
  type CharacteristicSource,
  type TrackCharacteristic,
} from './characteristics.js';

/**
 * Song characteristics: the service around the characteristic classifier.
 *
 * SHAPE, AND WHY. crate runs background work one way — a setInterval that asks the database for
 * the next rows needing attention (the ffmpeg analyzer in main.ts, the import processor's
 * tick()). This follows that, and gets three properties for free:
 *
 *  - IDEMPOTENT. The work list is derived from state, not from messages. Two ticks cannot
 *    analyse the same track twice.
 *  - RESUMABLE. A restart mid-batch loses nothing; a row stranded in 'analysing' is reclaimed
 *    after STALE_RUN_S, because the only thing that could have been analysing it is a process
 *    that no longer exists.
 *  - AUTOMATIC FOR NEW TRACKS. Ingestion needs no hook — which matters, because the scanner is
 *    an UPSERT on path and has no "this row is new" moment to hook.
 *
 * COST DISCIPLINE. Enabling the feature does NOT enrol the existing library: auto-enrolment is
 * bounded to tracks first seen after the switch was thrown (songCharacteristicsSince), so
 * turning it on cannot silently spend money on ten thousand tracks. Backfilling is a deliberate,
 * visible batch action. A track already analysed at the current CLASSIFIER_VERSION is never
 * re-analysed automatically.
 *
 * FRAGILITY. Nothing here can fail an import. Analysis happens strictly after a track exists, in
 * a different tick, and every failure path ends in a row marked 'failed' with a short
 * diagnostic — never a thrown error reaching the scanner.
 */

/** How analysis is produced. Injected so tests drive the whole state machine without a network. */
export type CharacteristicClassifier = (inputs: AnalysisInput[]) => Promise<AnalysisResult | null>;

/** The subset of Fastify's logger this needs. Keeps the service testable with a stub. */
export interface AnalysisLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Failures before a track is left alone. Three covers a rate limit or a bad minute at the
 * provider; beyond that the track is probably the problem and retrying forever would block the
 * queue behind it. An explicit reanalyse resets the count.
 */
const MAX_ATTEMPTS = 3;

/**
 * How long a row may sit in 'analysing' before another tick may take it.
 *
 * Generous on purpose: it has to exceed the slowest legitimate batch by a wide margin, or a slow
 * call would have its rows stolen out from under it and analysed twice. A batch of five measures
 * ~46s and the request itself gives up at 90, so five minutes is a crash-recovery window rather
 * than a contention one — which is all it is for, even now that batches overlap.
 */
const STALE_RUN_S = 300;

/** Tracks adopted into the queue per tick by auto-enrolment. */
const ENROL_PER_TICK = 60;

/**
 * Tracks judged in one request.
 *
 * MEASURED, not guessed. Timing real calls: batch 3 took 25s, batch 5 took 46s — about nine
 * seconds per track either way. So batching does NOT make the work faster; it only amortises the
 * ~1,800-token taxonomy preamble against more tracks, which is a COST saving and nothing else.
 * The output is the bottleneck: fifty-five numbers is roughly nine seconds of generation and no
 * arrangement of them changes that.
 *
 * Which makes ten actively harmful — it took 90–120s and routinely blew the request timeout,
 * burning two minutes to produce nothing. Five lands near 46s, comfortably inside the budget,
 * and still spreads the preamble across five tracks. Throughput comes from MAX_CONCURRENT below,
 * which is the only lever that actually moves it.
 */
const BATCH_SIZE = 5;

/**
 * Batches allowed out at once.
 *
 * At ~9s per track and one batch at a time, a 3,300-track library takes seven hours — which is
 * what "excruciatingly slow" looked like from the outside, and it was a fair description. Four
 * concurrent batches of five is twenty tracks in flight, about 26 a minute, so the same library
 * takes under two hours.
 *
 * Four is a deliberate number rather than the accident this replaced. An earlier version had no
 * limit at all and drifted to eight concurrent purely because the timer outpaced the API; the
 * problem then was not the concurrency but that nothing had chosen it. Four is well inside any
 * provider's allowance, keeps the failure blast radius small, and leaves the box responsive —
 * this shares a machine with playback.
 */
const MAX_CONCURRENT = 4;

/**
 * How much of the profile must come back before it is worth storing.
 *
 * A characteristic vector missing half its dimensions is not a profile — every similarity
 * computation that later touched it would be comparing on whatever happened to survive. But
 * demanding all fifty-five would throw away otherwise good answers over one dropped field, and
 * the similarity engine genuinely handles gaps. Eighty per cent is the line: complete enough to
 * compare with, forgiving of a model that fumbles a couple.
 */
const MIN_COMPLETENESS = 0.8;

/** Backoff after the provider says "too many requests", so a 429 does not become a hot loop. */
const RATE_LIMIT_COOLDOWN_S = 60;

export interface AnalysisProgress {
  enabled: boolean;
  /** Enabled but unusable — no OpenAI key — which is worth saying out loud in the UI. */
  ready: boolean;
  version: string;
  characteristics: number;
  counts: { notAnalysed: number; pending: number; analysing: number; analysed: number; failed: number };
  /** Analysed at a version other than the current one: candidates for a reanalyse sweep. */
  stale: number;
  tracks: number;
}

export interface TrackAnalysisStatus {
  trackId: number;
  characteristics: TrackCharacteristic[];
  state: AnalysisState | 'not-analysed';
  version: string;
  model: string;
  detail: string;
  attempts: number;
  analysedAt: number | null;
  /** True when this profile is at the current classifier version. */
  current: boolean;
}

interface RunRow {
  track_id: number;
  state: AnalysisState;
  version: string;
  model: string;
  detail: string;
  attempts: number;
  analysed_at: number;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

export class SongCharacteristics {
  /** Set when the provider rate-limited us; no work is attempted until it passes. */
  private cooldownUntil = 0;
  /**
   * How many batches are out right now, capped at MAX_CONCURRENT.
   *
   * A counter rather than a boolean, and rather than nothing at all. Nothing at all was the
   * original bug: the timer outpaced the API and drifted to eight concurrent requests, which
   * happened to work but was chosen by no one. A boolean fixed the honesty and created a new
   * problem — strictly serial at nine seconds a track is seven hours for this library. A counter
   * is the version where the concurrency is a decision.
   */
  private inFlight = 0;

  constructor(
    private db: Database.Database,
    private settings: Settings,
    private classify: CharacteristicClassifier,
    private similarity: Similarity,
    private log: AnalysisLog = { info: () => {}, warn: () => {} },
  ) {}

  // ---- taxonomy ------------------------------------------------------------

  /**
   * Push the code-owned taxonomy into the database.
   *
   * Upsert rather than replace, and characteristics absent from the code list are DISABLED
   * rather than deleted: a retired dimension has scores against it that still need a name to
   * render, and a similarity weight so historic comparisons stay explicable. Reintroducing it
   * later simply flips enabled back on.
   *
   * This is what makes the taxonomy evolvable without a schema change — adding, renaming or
   * reweighting a characteristic is an edit to characteristics.ts and a restart.
   */
  syncTaxonomy(): void {
    const put = this.db.prepare(
      `INSERT INTO characteristics
         (key, name, grp, description, definition, similarity_weight, sort, enabled)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET
         name = excluded.name, grp = excluded.grp, description = excluded.description,
         definition = excluded.definition, similarity_weight = excluded.similarity_weight,
         sort = excluded.sort, enabled = excluded.enabled`,
    );
    const tx = this.db.transaction(() => {
      CHARACTERISTICS.forEach((c, i) =>
        put.run(
          c.key,
          c.name,
          c.group,
          c.description,
          c.definition,
          c.similarityWeight,
          i,
          c.enabled ? 1 : 0,
        ),
      );
      const keys = CHARACTERISTICS.map((c) => c.key);
      const marks = keys.map(() => '?').join(',');
      this.db.prepare(`UPDATE characteristics SET enabled = 0 WHERE key NOT IN (${marks})`).run(...keys);
    });
    tx();
  }

  /** The taxonomy as the API exposes it, grouped for a UI that must not show fifty raw rows. */
  taxonomy(): {
    key: string;
    name: string;
    group: string;
    groupLabel: string;
    description: string;
    similarityWeight: number;
    enabled: boolean;
  }[] {
    return (
      this.db
        .prepare(
          `SELECT key, name, grp, description, similarity_weight, enabled
             FROM characteristics ORDER BY sort, key`,
        )
        .all() as {
        key: string;
        name: string;
        grp: string;
        description: string;
        similarity_weight: number;
        enabled: number;
      }[]
    ).map((r) => ({
      key: r.key,
      name: r.name,
      group: r.grp,
      groupLabel: CHARACTERISTIC_BY_KEY.get(r.key)?.group ?? r.grp,
      description: r.description,
      similarityWeight: r.similarity_weight,
      enabled: r.enabled === 1,
    }));
  }

  // ---- configuration -------------------------------------------------------

  /** The feature switch. When false, nothing here ever calls a model. */
  enabled(): boolean {
    return this.settings.all().songCharacteristics;
  }

  /** Enabled AND able to run: the setting alone cannot analyse without a key. */
  ready(): boolean {
    return this.enabled() && Boolean(this.settings.all().openaiKey);
  }

  // ---- reading -------------------------------------------------------------

  /**
   * A track's profile, AI and manual resolved into one list. Readable whether or not the feature
   * is switched on: disabling stops new analysis, it does not hide what is already known.
   */
  profileOf(trackId: number): TrackCharacteristic[] {
    return mergeScores(this.rowsFor([trackId]).get(trackId) ?? []);
  }

  /** The same for many tracks in one query, so a list can carry profiles cheaply. */
  profilesFor(trackIds: number[]): Map<number, TrackCharacteristic[]> {
    const out = new Map<number, TrackCharacteristic[]>();
    for (const [id, rows] of this.rowsFor(trackIds)) out.set(id, mergeScores(rows));
    return out;
  }

  private rowsFor(trackIds: number[]): Map<number, TrackCharacteristic[]> {
    const out = new Map<number, TrackCharacteristic[]>();
    if (!trackIds.length) return out;
    const marks = trackIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT tc.track_id, tc.characteristic_key, tc.score, tc.source, c.name, c.grp
           FROM track_characteristics tc JOIN characteristics c ON c.key = tc.characteristic_key
          WHERE tc.track_id IN (${marks})`,
      )
      .all(...trackIds) as {
      track_id: number;
      characteristic_key: string;
      score: number;
      source: CharacteristicSource;
      name: string;
      grp: string;
    }[];
    for (const r of rows) {
      const list = out.get(r.track_id) ?? [];
      list.push({
        key: r.characteristic_key,
        name: r.name,
        group: r.grp as TrackCharacteristic['group'],
        score: r.score,
        source: r.source,
      });
      out.set(r.track_id, list);
    }
    return out;
  }

  /** Everything a UI needs about one track: its profile and where its analysis stands. */
  statusOf(trackId: number): TrackAnalysisStatus {
    const run = this.db
      .prepare(
        `SELECT track_id, state, version, model, detail, attempts, analysed_at
           FROM track_characteristic_runs WHERE track_id = ?`,
      )
      .get(trackId) as RunRow | undefined;
    return {
      trackId,
      characteristics: this.profileOf(trackId),
      state: run?.state ?? 'not-analysed',
      version: run?.version ?? '',
      model: run?.model ?? '',
      detail: run?.detail ?? '',
      attempts: run?.attempts ?? 0,
      analysedAt: run?.analysed_at || null,
      current: run?.state === 'analysed' && run.version === CLASSIFIER_VERSION,
    };
  }

  /** True when this track already has a profile from the current classifier. Skip it. */
  isCurrent(trackId: number): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM track_characteristic_runs
            WHERE track_id = ? AND state = 'analysed' AND version = ?`,
        )
        .get(trackId, CLASSIFIER_VERSION) !== undefined
    );
  }

  progress(): AnalysisProgress {
    const byState = new Map(
      (
        this.db
          .prepare('SELECT state, COUNT(*) AS n FROM track_characteristic_runs GROUP BY state')
          .all() as { state: AnalysisState; n: number }[]
      ).map((r) => [r.state, r.n]),
    );
    const tracks = (this.db.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n;
    const enrolled = [...byState.values()].reduce((a, b) => a + b, 0);
    const stale = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM track_characteristic_runs
            WHERE state = 'analysed' AND version != ?`,
        )
        .get(CLASSIFIER_VERSION) as { n: number }
    ).n;
    return {
      enabled: this.enabled(),
      ready: this.ready(),
      version: CLASSIFIER_VERSION,
      characteristics: CHARACTERISTICS.filter((c) => c.enabled).length,
      counts: {
        notAnalysed: Math.max(0, tracks - enrolled),
        pending: byState.get('pending') ?? 0,
        analysing: byState.get('analysing') ?? 0,
        analysed: byState.get('analysed') ?? 0,
        failed: byState.get('failed') ?? 0,
      },
      stale,
      tracks,
    };
  }

  // ---- queueing ------------------------------------------------------------

  /**
   * Put tracks in line. `force` re-queues even a current profile — the difference between
   * "analyse what needs it" and a person pressing Reanalyse.
   *
   * Returns what actually happened, because "queued 0 of 40" is the honest answer when the other
   * 40 were already current, and a UI that says "queued 40" then is lying.
   */
  queue(trackIds: number[], opts: { force?: boolean; batchId?: string } = {}): { queued: number; skipped: number } {
    if (!trackIds.length) return { queued: 0, skipped: 0 };
    const t = nowSec();
    const batchId = opts.batchId ?? '';
    // Attempts reset: an explicit request is also a request to stop giving up.
    const put = this.db.prepare(
      `INSERT INTO track_characteristic_runs (track_id, state, batch_id, queued_at, updated_at, attempts)
       VALUES (?, 'pending', ?, ?, ?, 0)
       ON CONFLICT(track_id) DO UPDATE SET
         state = 'pending', batch_id = excluded.batch_id, queued_at = excluded.queued_at,
         updated_at = excluded.updated_at, attempts = 0, detail = ''`,
    );
    let queued = 0;
    let skipped = 0;
    const tx = this.db.transaction(() => {
      for (const id of trackIds) {
        if (!opts.force && this.isCurrent(id)) {
          skipped++;
          continue;
        }
        put.run(id, batchId, t, t);
        queued++;
      }
    });
    tx();
    this.log.info(
      { queued, skipped, batchId: batchId || null, force: Boolean(opts.force) },
      'song characteristics: analysis queued',
    );
    return { queued, skipped };
  }

  /**
   * The library sweep. Deliberately explicit — the one operation that can cost real money, so it
   * never happens as a side effect of enabling the feature. Safe to run twice: the second run
   * queues only what the first has not finished.
   */
  queueLibrary(batchId: string, opts: { force?: boolean } = {}): { queued: number; skipped: number } {
    const ids = (this.db.prepare('SELECT id FROM tracks ORDER BY id').all() as { id: number }[]).map(
      (r) => r.id,
    );
    const result = this.queue(ids, { ...opts, batchId });
    this.log.info({ batchId, ...result, tracks: ids.length }, 'song characteristics: library batch queued');
    return result;
  }

  /** How a named batch is getting on, for a progress display. */
  batchProgress(batchId: string): { total: number; done: number; failed: number; open: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN state = 'analysed' THEN 1 ELSE 0 END) AS done,
                SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN state IN ('pending','analysing') THEN 1 ELSE 0 END) AS open
           FROM track_characteristic_runs WHERE batch_id = ?`,
      )
      .get(batchId) as { total: number; done: number | null; failed: number | null; open: number | null };
    return { total: row.total, done: row.done ?? 0, failed: row.failed ?? 0, open: row.open ?? 0 };
  }

  /**
   * Adopt recently-ingested tracks. Bounded to tracks first seen since the feature was switched
   * on, which is what makes "enabled" mean "analyse new music" rather than "spend the afternoon
   * billing me for the back catalogue". 0 = never enabled through the UI, so nothing is enrolled.
   */
  private autoEnrol(): number {
    const since = this.settings.all().songCharacteristicsSince;
    if (!since) return 0;
    const rows = this.db
      .prepare(
        `SELECT t.id FROM tracks t
           LEFT JOIN track_characteristic_runs r ON r.track_id = t.id
          WHERE t.first_seen >= ? AND r.track_id IS NULL
          ORDER BY t.id LIMIT ?`,
      )
      .all(since, ENROL_PER_TICK) as { id: number }[];
    if (!rows.length) return 0;
    return this.queue(rows.map((r) => r.id), { batchId: 'ingest' }).queued;
  }

  // ---- the worker ----------------------------------------------------------

  /**
   * One unit of work. Called on a timer; safe to call at any time and from anywhere.
   *
   * Returns what it did, which is what the tests assert on: 'disabled' proves the feature switch
   * is honoured without a model ever being consulted.
   */
  async tick(): Promise<'disabled' | 'cooling' | 'idle' | 'analysed' | 'failed'> {
    if (!this.ready()) return 'disabled';
    if (nowSec() < this.cooldownUntil) return 'cooling';
    // Every slot is busy. This, not the timer interval, is the rate limit — see MAX_CONCURRENT.
    if (this.inFlight >= MAX_CONCURRENT) return 'cooling';

    this.autoEnrol();
    const trackIds = this.claim(BATCH_SIZE);
    if (!trackIds.length) return 'idle';
    this.inFlight++;
    try {
      return (await this.run(trackIds)) ? 'analysed' : 'failed';
    } finally {
      // finally, not after the await: run() is written not to throw, but if it ever did, a leaked
      // slot would permanently shrink the pool and eventually stop the worker altogether.
      this.inFlight--;
    }
  }

  /**
   * Take the next waiting tracks and mark them in progress, in one transaction so two ticks can
   * never pick the same rows.
   */
  private claim(limit: number): number[] {
    const t = nowSec();
    let claimed: number[] = [];
    const tx = this.db.transaction(() => {
      /*
       * Ordered by a cheap hash of the id rather than by id, so a batch spans the library rather
       * than being ten consecutive tracks off one album. A model handed a whole album leans on
       * it as context and starts ranking within it, which is exactly the relative grading the
       * prompt argues against. Deterministic, so it stays resumable.
       */
      const rows = this.db
        .prepare(
          `SELECT track_id FROM track_characteristic_runs
            WHERE (state = 'pending' AND attempts < ?)
               OR (state = 'analysing' AND started_at < ?)
            ORDER BY queued_at, (track_id * 2654435761) % 1000003, track_id
            LIMIT ?`,
        )
        .all(MAX_ATTEMPTS, t - STALE_RUN_S, limit) as { track_id: number }[];
      if (!rows.length) return;
      const mark = this.db.prepare(
        `UPDATE track_characteristic_runs SET state = 'analysing', started_at = ?, updated_at = ?
          WHERE track_id = ?`,
      );
      for (const r of rows) mark.run(t, t, r.track_id);
      claimed = rows.map((r) => r.track_id);
    });
    tx();
    return claimed;
  }

  /**
   * Analyse a batch. Never throws: every outcome is a row state, because the caller is a timer.
   *
   * Each track's fate is decided SEPARATELY — one malformed profile in a reply of ten must not
   * cost the other nine a paid call, and a track the model silently dropped must be visible as a
   * failure rather than quietly staying 'analysing' forever.
   */
  async run(trackIds: number[]): Promise<boolean> {
    const inputs: AnalysisInput[] = [];
    for (const id of trackIds) {
      const input = this.inputFor(id);
      if (input) inputs.push(input);
      else this.fail(id, 'track no longer exists');
    }
    if (!inputs.length) return false;
    this.log.info({ tracks: inputs.length }, 'song characteristics: analysis started');

    let result: AnalysisResult | null;
    try {
      result = await this.classify(inputs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/\b429\b|rate limit/i.test(msg)) {
        // The whole batch goes back without spending anyone's retry budget: nothing about this
        // was the tracks' fault.
        this.cooldownUntil = nowSec() + RATE_LIMIT_COOLDOWN_S;
        for (const t of inputs) this.requeueWithoutPenalty(t.trackId);
        this.log.warn(
          { tracks: inputs.length, cooldownS: RATE_LIMIT_COOLDOWN_S },
          'song characteristics: rate limited, backing off',
        );
        return false;
      }
      for (const t of inputs) this.fail(t.trackId, msg.slice(0, 200));
      return false;
    }

    if (!result) {
      for (const t of inputs) this.fail(t.trackId, 'classifier returned no usable answer');
      return false;
    }

    const byTrack = new Map(result.tracks.map((r) => [r.trackId, r.scores]));
    const required = CHARACTERISTICS.filter((c) => c.enabled && !c.conditional).length;
    let analysed = 0;
    let failed = 0;
    const rejections: string[] = [];

    for (const t of inputs) {
      const raw = byTrack.get(t.trackId);
      if (raw === undefined) {
        // Asked about, not answered. Counts as an attempt, so a track the model keeps skipping
        // retries a couple of times in later batches and is then left alone.
        this.fail(t.trackId, 'classifier did not return this track');
        failed++;
        continue;
      }
      const { scores, rejected, missing } = validateScores(raw);
      if (rejected.length) rejections.push(...rejected);

      /*
       * Completeness, not just validity. A half-empty vector would silently degrade every
       * similarity computation that later touched it, and unlike a bad tag it would not look
       * wrong — it would just quietly make the wrong recommendations.
       */
      const completeness = required ? (required - missing.length) / required : 1;
      if (completeness < MIN_COMPLETENESS) {
        this.fail(
          t.trackId,
          `incomplete profile: ${missing.length} of ${required} characteristics missing` +
            (rejected.length ? ` (${rejected.slice(0, 2).join('; ')})` : ''),
        );
        failed++;
        continue;
      }

      this.persist(t.trackId, scores, result.model);
      analysed++;
    }

    if (rejections.length) {
      this.log.warn(
        { rejected: [...new Set(rejections)].slice(0, 5), count: rejections.length },
        'song characteristics: some scores rejected',
      );
    }
    this.log.info(
      { analysed, failed, model: result.model, version: CLASSIFIER_VERSION },
      'song characteristics: analysis completed',
    );
    return analysed > 0;
  }

  /**
   * Write an AI profile, replacing the previous one.
   *
   * The delete is scoped to source='ai', which is the single line that makes hand curation safe
   * from reanalysis. Wrapped in a transaction so a track is never briefly half-profiled — a
   * reader mid-write would otherwise compute a similarity against nonsense.
   */
  private persist(trackId: number, scores: Map<string, number>, model: string): void {
    const t = nowSec();
    const tx = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM track_characteristics WHERE track_id = ? AND source = 'ai'")
        .run(trackId);
      const put = this.db.prepare(
        `INSERT INTO track_characteristics (track_id, characteristic_key, score, source, analysed_at)
         VALUES (?,?,?,'ai',?)
         ON CONFLICT(track_id, characteristic_key, source)
           DO UPDATE SET score = excluded.score, analysed_at = excluded.analysed_at`,
      );
      for (const [key, score] of scores) put.run(trackId, key, score, t);
      this.db
        .prepare(
          `UPDATE track_characteristic_runs
              SET state = 'analysed', version = ?, model = ?, detail = '',
                  analysed_at = ?, updated_at = ?
            WHERE track_id = ?`,
        )
        .run(CLASSIFIER_VERSION, model, t, t, trackId);
    });
    tx();
    // A cached vector that no longer matches the database is a wrong answer, not a slow one.
    this.similarity.invalidate();
  }

  private fail(trackId: number, detail: string): void {
    const t = nowSec();
    this.db
      .prepare(
        `UPDATE track_characteristic_runs
            SET state = 'failed', attempts = attempts + 1, detail = ?, updated_at = ?
          WHERE track_id = ?`,
      )
      .run(detail, t, trackId);
    this.log.warn({ trackId, detail }, 'song characteristics: analysis failed');
  }

  /** A provider-side problem is not the track's fault: back to pending, attempts untouched. */
  private requeueWithoutPenalty(trackId: number): void {
    this.db
      .prepare("UPDATE track_characteristic_runs SET state = 'pending', updated_at = ? WHERE track_id = ?")
      .run(nowSec(), trackId);
  }

  /**
   * What the classifier gets to see: only what crate actually holds.
   *
   * Genres merge the file's own tags with Last.fm's view of the artist, the same combination the
   * DJ and dynamic playlists use. Energy and BPM ride along when the local analyzer has been
   * past — cheap, already computed, and real evidence about feel. Lyrics are flagged rather than
   * sent: crate's lyric cache is filled on demand rather than at ingestion, so requiring them
   * would mean a fetch per analysis; telling the model they exist costs nothing and leaves the
   * door open. Nothing is fabricated — an absent field goes up as null.
   */
  inputFor(trackId: number): AnalysisInput | null {
    const t = this.db
      .prepare(
        `SELECT id, title, artist_name, album_artist_name, album_title, norm_artist,
                norm_title, genres, year, album_mbid, duration_s, bpm, energy
           FROM tracks WHERE id = ?`,
      )
      .get(trackId) as
      | {
          id: number;
          title: string;
          artist_name: string;
          album_artist_name: string | null;
          album_title: string;
          norm_artist: string;
          norm_title: string;
          genres: string | null;
          year: number | null;
          album_mbid: string | null;
          duration_s: number | null;
          bpm: number | null;
          energy: number | null;
        }
      | undefined;
    if (!t) return null;

    const normTitle = t.norm_title;
    const own = t.genres ? t.genres.split(', ') : [];
    const artist = (
      this.db.prepare('SELECT genre FROM artist_genres WHERE norm_artist = ?').all(t.norm_artist) as {
        genre: string;
      }[]
    ).map((r) => r.genre);
    const genres: string[] = [];
    for (const g of [...own, ...artist]) {
      const n = g.trim();
      if (n && !genres.some((x) => x.toLowerCase() === n.toLowerCase())) genres.push(n);
    }

    /*
     * The lyric cache is keyed by normalised artist|title rather than by track id (lib/lyrics.ts
     * predates any of this and serves tracks crate does not own). norm_artist and norm_title are
     * built the same way, so the key reconstructs exactly.
     */
    const hasLyrics =
      this.db
        .prepare("SELECT 1 FROM lyrics WHERE key = ? AND text != '' LIMIT 1")
        .get(`${t.norm_artist}|${normTitle}`) !== undefined;

    return {
      trackId: t.id,
      title: t.title,
      artistName: t.artist_name,
      albumArtist:
        t.album_artist_name && t.album_artist_name !== t.artist_name ? t.album_artist_name : null,
      albumTitle: t.album_title,
      genres: genres.slice(0, 8),
      year: t.year && t.year >= 1900 ? t.year : null,
      albumMbid: t.album_mbid,
      // -1 is the analyzer's "tried and failed" sentinel, not a measurement.
      energy: t.energy != null && t.energy >= 0 ? t.energy : null,
      bpm: t.bpm != null && t.bpm > 0 ? t.bpm : null,
      durationS: t.duration_s,
      hasLyrics,
    };
  }

  // ---- manual curation -----------------------------------------------------

  /**
   * Set one characteristic by hand. Stored as source='manual', which both outranks the AI score
   * for the same key when read and is invisible to reanalysis when written.
   *
   * Returns false for an unknown key or a score outside 0..1 — the same gate the model faces,
   * because a typo in a client is not more trustworthy than a hallucination.
   */
  setManual(trackId: number, key: string, score: number): boolean {
    if (!CHARACTERISTIC_BY_KEY.has(key)) return false;
    if (!Number.isFinite(score) || score < 0 || score > 1) return false;
    if (!this.db.prepare('SELECT 1 FROM tracks WHERE id = ?').get(trackId)) return false;
    this.db
      .prepare(
        `INSERT INTO track_characteristics (track_id, characteristic_key, score, source, analysed_at)
         VALUES (?,?,?,'manual',?)
         ON CONFLICT(track_id, characteristic_key, source)
           DO UPDATE SET score = excluded.score, analysed_at = excluded.analysed_at`,
      )
      .run(trackId, key, Math.round(score * 1000) / 1000, nowSec());
    this.similarity.invalidate();
    this.log.info({ trackId, key, score }, 'song characteristics: manual score set');
    return true;
  }

  /** Undo a hand-set score. Any AI value for the same key reappears, which is correct. */
  removeManual(trackId: number, key: string): boolean {
    const info = this.db
      .prepare("DELETE FROM track_characteristics WHERE track_id = ? AND characteristic_key = ? AND source = 'manual'")
      .run(trackId, key);
    if (info.changes) {
      this.similarity.invalidate();
      this.log.info({ trackId, key }, 'song characteristics: manual score removed');
    }
    return info.changes > 0;
  }
}
