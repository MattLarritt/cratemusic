/**
 * The request pipeline crate owns: search, grab, watch, import.
 *
 * Lidarr used to do all of this, and it was the wrong tool for the job by design
 * rather than by accident. Lidarr curates a library: it chooses a canonical
 * MusicBrainz release and refuses anything that does not match it track for track,
 * which is correct for a collection you intend to keep pristine and upgrade. A
 * request service wants the opposite bias — take the album, accept a rip that is a
 * track short, and if a grab does not work out, try the next candidate instead of
 * stopping with the request still saying 'queued'.
 *
 * That difference is the whole reason this file exists. Three separate incidents
 * came out of fighting it, and the last one — an eleven-track ABBA rip refused
 * against a twenty-five-track release — could not be fixed from crate's side at
 * all while Lidarr owned the import. Lidarr is gone entirely now; MusicBrainz
 * answers the metadata questions it used to.
 */

import type { FastifyBaseLogger } from 'fastify';
import { importAlbum } from './importer.js';
import type { Library } from './library.js';
import type { MusicBrainz } from './musicbrainz.js';
import type { Prowlarr } from './prowlarr.js';
import { score, type Scored } from './release.js';
import type { Sab } from './sab.js';
import type { Qbit, TorrentJob } from './qbit.js';
import type { Lyrics } from './lyrics.js';
import type { Notifier } from './notify.js';
import type { Recommender } from './recommend.js';
import type { UserLibrary } from './userlib.js';
import type { Settings } from './settings.js';
import type { RequestRow, Store } from './store.js';

/**
 * SABnzbd states in which showing no progress is legitimate.
 *
 * A job waiting its turn behind a large queue can sit unchanged for hours. Every
 * other non-terminal state is subject to the stall timeout, because SAB reported
 * 'Grabbing' indefinitely for an unreachable NZB URL and never failed the job — and
 * anything that maps to "still working" without a timeout leaves the request queued
 * forever, the exact silence this pipeline exists to remove.
 *
 * How many releases to try and how long to wait are both operator settings now; see
 * lib/settings.ts.
 */
const PATIENT_STATES = new Set(['queued', 'paused']);

/**
 * qBittorrent states where showing no progress is legitimate.
 *
 * metaDL is a magnet still fetching its torrent file, and a queued torrent is
 * waiting its turn exactly as a queued NZB does. stalledDL is deliberately NOT
 * here: a swarm that has gone quiet is the case the timeout exists for.
 */
const TORRENT_PATIENT = new Set([
  'metaDL',
  'forcedMetaDL',
  'queuedDL',
  'checkingResumeData',
  'allocating',
  'pausedDL',
  'stoppedDL',
]);

/**
 * Consecutive advance() failures before a request is settled as failed.
 *
 * tick() deliberately swallows a step failure so one stuck request cannot
 * stall the rest — but swallowing forever meant a poisoned download (a .tar
 * the importer could not walk) retried every fifteen seconds until a restart.
 * In-memory on purpose: a restart resets the count, which errs toward another
 * honest try rather than a premature failure.
 */
const MAX_STEP_FAILURES = 12;

export class Pipeline {
  constructor(
    private deps: {
      store: Store;
      library: Library;
      prowlarr: Prowlarr;
      sab: Sab;
      qbit: Qbit;
      mb: MusicBrainz;
      musicRoot: string;
      log: FastifyBaseLogger;
      notifier: Notifier;
      lyrics: Lyrics;
      userlib: UserLibrary;
      recommender: Recommender;
      /** Read fresh on every use, so an admin change applies without a restart. */
      settings: Settings;
    },
  ) {}

  /**
   * Search for a request's album and send the best candidate to SAB.
   *
   * The candidate list is stored on the request so a later failure can move to the
   * next one without searching again — indexers are rate limited and a re-search
   * would also risk returning a different list than the one that was scored.
   */
  async start(req: RequestRow): Promise<void> {
    const { store, prowlarr, mb, log } = this.deps;

    const meta = await mb.albumInfo(req.mbid);
    if (!meta) throw new Error(`no metadata for album ${req.mbid}`);

    // Track count comes from MusicBrainz rather than Lidarr, and is advisory: it
    // only sharpens the size sanity check. A failure to get it must not stop a
    // request, so it degrades to 0 = unknown.
    let trackCount = 0;
    let mbTracks: { title: string; lengthMs: number | null }[] = [];
    try {
      mbTracks = (await mb.tracks(req.mbid)).map((t) => ({
        title: t.title,
        lengthMs: t.lengthMs ?? null,
      }));
      trackCount = mbTracks.length;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), mbid: req.mbid },
        'no musicbrainz tracklist; size checks relaxed',
      );
    }

    const cfg = this.deps.settings.all();
    const found = await prowlarr.search(meta.artistName, meta.title);
    const ranked = score(
      found,
      {
        artist: meta.artistName,
        album: meta.title,
        trackCount,
        year: (meta.releaseDate ?? '').slice(0, 4),
      },
      cfg,
    );

    log.info(
      { mbid: req.mbid, found: found.length, viable: ranked.length },
      `search for ${meta.artistName} — ${meta.title}`,
    );

    if (!ranked.length) {
      const why = found.length
        ? `${found.length} results, none of them this album`
        : 'no results from any indexer';
      store.settleRequest(req.id, 'failed', why);
      this.deps.notifier.emit('request.failed', {
        title: 'crate request failed',
        message: `${meta.artistName} — ${meta.title}: ${why}`,
        data: { requestId: req.id, mbid: req.mbid, reason: why, found: found.length },
      });
      return;
    }

    store.setCandidates(req.id, ranked, { artistName: meta.artistName, albumTitle: meta.title });
    await this.grab(req.id, ranked, 0);

    // Warm the lyrics cache while Usenet does its work.
    //
    // Deliberately not awaited: it is a minute of polite one-per-second lookups against
    // LRCLIB, and the download is going to take at least that long anyway. By the time
    // the files land the words are usually already in SQLite. Anything it misses is
    // looked up at import from the tags that actually arrived.
    if (mbTracks.length) {
      void this.deps.lyrics
        .prefetch(meta.artistName, meta.title, mbTracks)
        .catch((err: unknown) =>
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'lyrics prefetch failed; import will look them up instead',
          ),
        );
    }
  }

  /** Send one candidate to SAB and record the job against the request. */
  private async grab(requestId: number, ranked: Scored[], attempt: number): Promise<void> {
    const { store, sab, qbit, log } = this.deps;
    const pick = ranked[attempt];
    if (!pick) {
      store.settleRequest(requestId, 'failed', `all ${ranked.length} candidate releases failed`);
      return;
    }

    // The candidate decides the client, so a ranked list can mix protocols and
    // a retry can move from a dead Usenet post to a healthy torrent.
    const via = pick.protocol === 'torrent' ? 'torrent' : 'usenet';
    if (via === 'torrent' && !qbit.configured) {
      // Nothing to hand it to. Skip rather than fail the request: the next
      // candidate may well be an NZB.
      log.warn({ requestId, attempt }, 'skipping a torrent candidate: qBittorrent is not configured');
      await this.grab(requestId, ranked, attempt + 1);
      return;
    }

    const nzoId =
      via === 'torrent'
        ? await qbit.add(pick.downloadUrl, pick.title)
        : await sab.add(pick.downloadUrl, pick.title);
    store.setDownload(requestId, { nzoId, attempt, note: `queued: ${pick.title}`, via });
    log.info(
      { requestId, nzoId, attempt, via, score: pick.score, reasons: pick.reasons },
      `grabbed ${pick.title}`,
    );
    this.deps.notifier.emit('download.grabbed', {
      title: 'crate started a download',
      message: `${pick.title} (${Math.round(pick.size / 1024 / 1024)} MB) from ${pick.indexer}`,
      data: {
        requestId,
        release: pick.title,
        sizeMb: Math.round(pick.size / 1024 / 1024),
        indexer: pick.indexer,
        score: pick.score,
        attempt,
      },
    });
  }

  /**
   * Advance every in-flight request one step.
   *
   * Called on a short timer rather than driven by a webhook: SAB can notify, but a
   * poll cannot be missed, arrives in the right order, and still works after crate
   * restarts mid-download. The interval is short because the whole point is that a
   * requester sees a percentage instead of silence.
   */
  private stepFailures = new Map<number, number>();

  async tick(): Promise<void> {
    for (const req of this.deps.store.downloadingRequests()) {
      try {
        await this.advance(req);
        this.stepFailures.delete(req.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const n = (this.stepFailures.get(req.id) ?? 0) + 1;
        this.stepFailures.set(req.id, n);
        // One stuck request must not stall the others behind it — but after
        // enough identical failures it is not stuck, it is dead.
        if (n >= MAX_STEP_FAILURES) {
          this.stepFailures.delete(req.id);
          this.deps.store.settleRequest(req.id, 'failed', `import kept failing: ${msg.slice(0, 200)}`);
          this.deps.log.error({ requestId: req.id, err: msg }, 'request abandoned after repeated failures');
        } else {
          this.deps.log.warn({ err: msg, requestId: req.id, failure: n }, 'pipeline step failed');
        }
      }
    }
  }

  private async advance(req: RequestRow): Promise<void> {
    const { store, sab, qbit, library, log, musicRoot } = this.deps;
    if (!req.nzo_id) return;

    const viaTorrent = req.download_via === 'torrent';
    const torrent: TorrentJob | null = viaTorrent ? await qbit.status(req.nzo_id) : null;
    const job = viaTorrent ? torrent : await sab.status(req.nzo_id);
    if (!job) {
      // Gone from both the queue and history: someone removed it by hand, or the
      // client was reset. Treat as a failed attempt rather than waiting forever.
      await this.nextAttempt(
        req,
        viaTorrent ? 'torrent disappeared from qBittorrent' : 'download disappeared from SABnzbd',
      );
      return;
    }

    if (job.state === 'queued' || job.state === 'downloading' || job.state === 'postprocessing') {
      store.setProgress(req.id, job.percent, job.message ?? job.raw ?? job.state);

      const since = req.progress_at ?? 0;
      const stalledFor = Math.floor(Date.now() / 1000) - since;
      const stallLimit = this.deps.settings.all().stallMinutes * 60;
      // A torrent queued behind others, or waiting on metadata, is being
      // patient legitimately — same idea as SAB's queue, different words.
      const patient = viaTorrent
        ? TORRENT_PATIENT.has(job.raw)
        : PATIENT_STATES.has(job.raw);
      if (since > 0 && !patient && stalledFor > stallLimit) {
        const swarm = torrent ? `, ${torrent.seeders} seeder(s)` : '';
        await this.nextAttempt(
          req,
          `stuck in ${viaTorrent ? 'qBittorrent' : 'SABnzbd'} state "${job.raw}"${swarm} ` +
            `with no progress for ${Math.floor(stalledFor / 60)} min`,
        );
      }
      return;
    }

    if (job.state === 'failed') {
      await this.nextAttempt(req, job.message ?? 'download failed');
      return;
    }

    // Done. Import it.
    if (!job.path) {
      await this.nextAttempt(
        req,
        `${viaTorrent ? 'qBittorrent' : 'SABnzbd'} reported success with no output path`,
      );
      return;
    }

    const names = store.requestNames(req.id);
    const result = await importAlbum({
      sourceDir: job.path,
      musicRoot,
      artist: names.artistName || 'Unknown Artist',
      album: names.albumTitle || req.title,
      // Torrents keep their files so the swarm keeps its seed.
      keepSource: viaTorrent,
    });

    if (!result.moved.length) {
      // Everything was skipped. If it was skipped because the files are already
      // there, the request is satisfied; otherwise it is a real failure.
      const alreadyThere = result.skipped.every((s) => s.why === 'already in the library');
      if (alreadyThere && result.skipped.length) {
        library.record({
          mbid: req.mbid,
          artistName: names.artistName,
          albumTitle: names.albumTitle,
          path: result.destDir,
          trackFiles: result.skipped.length,
        });
        store.settleRequest(req.id, 'fulfilled');
        await this.release(req).catch(() => {});
        return;
      }
      await this.nextAttempt(req, `nothing imported: ${result.skipped[0]?.why ?? 'unknown'}`);
      return;
    }

    const audio = result.moved.filter((f) => /\.(flac|mp3|m4a|ogg|opus|wav|aac|alac|ape)$/i.test(f));

    // Lyrics go in now, while we know exactly which files arrived. Failures here are
    // reported and ignored: an album with no lyrics is still an album, and refusing to
    // fulfil a request over a missing verse would be the wrong trade.
    try {
      const lyr = await this.deps.lyrics.embedInto(
        audio.map((f) => `${result.destDir}/${f}`),
      );
      log.info({ requestId: req.id, ...lyr }, 'lyrics embedded at import');
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), requestId: req.id },
        'lyrics embedding failed',
      );
    }

    library.record({
      mbid: req.mbid,
      artistName: names.artistName,
      albumTitle: names.albumTitle,
      path: result.destDir,
      trackFiles: audio.length,
    });

    // Index the arrivals into the pool, then give the requester exactly what they asked
    // for.
    //
    // This is the point of the whole per-user arrangement: the album had to come down
    // because Usenet sells albums, but somebody who searched for one song gets one song.
    // The rest stay in the pool costing only disk, and the next person who wants one gets
    // it with no download at all.
    try {
      const indexed = await library.indexDir(result.destDir);
      if (req.requester_id) {
        if (req.wanted_title) {
          const match = this.deps.userlib.matchInAlbum(
            names.artistName,
            names.albumTitle,
            req.wanted_title,
          );
          if (match) {
            this.deps.userlib.add(req.requester_id, match.trackId, 'request');
            // Somebody asked for this from a playlist, so that is where it belongs. The
            // ownership check inside addToPlaylist still applies.
            if (req.wanted_playlist) {
              const pl = this.deps.userlib.playlist(req.requester_id, req.wanted_playlist);
              if (pl) this.deps.userlib.addToPlaylist(pl.id, match.trackId);
            }
            log.info(
              { requestId: req.id, track: match.title, pooled: indexed.length },
              'track request satisfied; rest of the album kept in the pool',
            );
          } else {
            // The rip's titles did not contain what was asked for. Better to hand over the
            // whole album than to leave somebody with nothing after a successful download,
            // and the note says why so it is not a silent substitution.
            for (const t of indexed) this.deps.userlib.add(req.requester_id, t.id, 'request');
            store.setProgress(req.id, 100, `could not find "${req.wanted_title}"; added the album`);
            log.warn(
              { requestId: req.id, wanted: req.wanted_title },
              'wanted track not found in the download; added the whole album instead',
            );
          }
        } else {
          for (const t of indexed) this.deps.userlib.add(req.requester_id, t.id, 'request');
        }
      }
      // New music in the library invalidates the cached recommendation set.
      if (req.requester_id) this.deps.recommender.invalidate(req.requester_id);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), requestId: req.id },
        'could not update the requester library',
      );
    }

    store.setProgress(req.id, 100, null);
    store.settleRequest(req.id, 'fulfilled');
    await sab.forget(req.nzo_id).catch(() => {});

    this.deps.notifier.emit('request.fulfilled', {
      title: 'crate download complete',
      message: `${names.artistName} — ${names.albumTitle}: ${audio.length} track${
        audio.length === 1 ? '' : 's'
      } imported`,
      data: {
        requestId: req.id,
        mbid: req.mbid,
        artist: names.artistName,
        album: names.albumTitle,
        tracks: audio.length,
        path: result.destDir,
      },
    });

    log.info(
      { requestId: req.id, dest: result.destDir, tracks: audio.length, skipped: result.skipped.length },
      `imported ${names.artistName} — ${names.albumTitle}`,
    );
  }

  /**
   * A candidate did not work out. Move to the next one, or give up honestly.
   *
   * The reason is kept on the request either way, because a request that failed
   * silently is the thing this whole rewrite exists to stop.
   */
  /**
   * Let go of a finished download.
   *
   * A completed torrent is only forgotten by crate — its files stay, and it
   * keeps seeding. A Usenet job is forgotten from history, as before.
   */
  private async release(req: RequestRow): Promise<void> {
    if (!req.nzo_id) return;
    if (req.download_via === 'torrent') await this.deps.qbit.forget(req.nzo_id);
    else await this.deps.sab.forget(req.nzo_id);
  }

  private async nextAttempt(req: RequestRow, why: string): Promise<void> {
    const { store, sab, qbit, log } = this.deps;
    // A failed attempt's data is worth nothing, so a torrent goes with it —
    // unlike a successful one, which stays to seed.
    if (req.nzo_id) {
      if (req.download_via === 'torrent') await qbit.discard(req.nzo_id).catch(() => {});
      else await sab.forget(req.nzo_id).catch(() => {});
    }

    const ranked = store.candidates(req.id);
    const next = (req.attempt ?? 0) + 1;
    const maxAttempts = this.deps.settings.all().maxAttempts;

    if (!ranked.length || next >= Math.min(ranked.length, maxAttempts)) {
      store.settleRequest(req.id, 'failed', why);
      log.warn({ requestId: req.id }, `request failed after ${next} attempt(s): ${why}`);
      this.deps.notifier.emit('request.failed', {
        title: 'crate request failed',
        message: `${req.asked_for || req.title}: ${why}`,
        data: { requestId: req.id, mbid: req.mbid, reason: why, attempts: next },
      });
      return;
    }

    log.warn({ requestId: req.id, why }, `attempt ${next} of ${maxAttempts}: trying next release`);
    store.setProgress(req.id, 0, `retrying: ${why}`);
    this.deps.notifier.emit('download.retrying', {
      title: 'crate is trying another release',
      message: `${req.asked_for || req.title}: ${why}`,
      data: { requestId: req.id, reason: why, attempt: next, of: maxAttempts },
    });
    await this.grab(req.id, ranked, next);
  }
}
