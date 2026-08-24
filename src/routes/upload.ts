import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Library } from '../lib/library.js';
import type { Notifier } from '../lib/notify.js';
import type { Recommender } from '../lib/recommend.js';
import type { UserLibrary } from '../lib/userlib.js';
import type { AcoustCandidate, AcoustId } from '../lib/acoustid.js';
import { optionsFor, verdictFor } from '../lib/uploadsuggest.js';
import type { OpenAi } from '../lib/openai.js';
import { matchTracks, type MatchFile, type MatchTrack } from '../lib/trackmatch.js';
import type { StagedFile, Uploads } from '../lib/upload.js';
import { join } from 'node:path';
import { norm } from '../lib/release.js';
import { MAX_BATCH_FILES } from '../lib/upload.js';

interface UploadDeps {
  uploads: Uploads;
  acoustid: AcoustId;
  openai: OpenAi;
  library: Library;
  userlib: UserLibrary;
  recommender: Recommender;
  notifier: Notifier;
  need: (req: FastifyRequest, reply: FastifyReply) => { id: number | null; user: string } | null;
}

/**
 * Bring your own album.
 *
 * Two steps by design: stage-and-read, then confirm-and-finalize. The staging
 * step is the only multipart surface in the app, and the finalize step is
 * plain JSON — identity is a decision, and decisions travel better as JSON
 * than as form fields glued to a gigabyte of audio.
 */
/**
 * The artist a filename claims, for files with no tags at all.
 *
 * "30. Lady Gaga - Bad Romance.mp3" is the shape uploads actually arrive in, and the part
 * before the dash is the only artist such a file states. Wrong often enough that it is a
 * hint and never a decision.
 */
function artistFromName(name: string): string | undefined {
  const stem = name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/^\s*\d+[\s.\-_]+/, '');
  const parts = stem.split(/\s+-\s+/);
  return parts.length > 1 ? parts[0]!.trim() || undefined : undefined;
}

export function uploadRoutes(app: FastifyInstance, deps: UploadDeps): void {
  const { uploads, acoustid, openai, library, userlib, recommender, notifier, need } = deps;

  app.post('/api/upload', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no library' });

    const batchId = uploads.newBatchId(c.id);
    const dir = uploads.batchDir(c.id, batchId)!;
    const files: StagedFile[] = [];
    /** Kept per file so the batch verdict can look across all of them at the end. */
    const perFile: {
      name: string;
      candidates: AcoustCandidate[];
      tags?: { album?: string } | null;
    }[] = [];
    const rejected: { name: string; why: string }[] = [];

    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      if (files.length >= MAX_BATCH_FILES) {
        // Draining without saving, so the request can finish and the error can
        // actually reach the client — destroying the stream mid-multipart
        // surfaces as a network failure, not a message.
        part.file.resume();
        rejected.push({ name: part.filename, why: `over the ${MAX_BATCH_FILES}-file limit` });
        continue;
      }
      try {
        const staged = await uploads.stage(dir, part.filename, part.file);
        // Identify by sound when the key is set. Sequential with the upload
        // stream on purpose: fpcalc reads the file that just finished writing,
        // and AcoustID's rate limit would gate a parallel burst anyway.
        let candidates: AcoustCandidate[] = [];
        if (staged.kind === 'audio' && acoustid.enabled()) {
          // The tags go in as a hint. The fingerprint still decides WHICH recording, but a
          // fingerprint cannot tell an original from a cover and the tag usually can — see
          // the ranking note in lib/acoustid.ts.
          candidates = await acoustid.identifyAll(join(dir, staged.name), {
            artist: staged.tags?.artist ?? artistFromName(staged.name),
            title: staged.tags?.title,
          });
          staged.match = candidates[0] ?? null;
        }
        if (staged.kind === 'audio') {
          /*
           * Is this song already on disk?
           *
           * Asked HERE, at upload, rather than discovered at finalize where it used to
           * surface as a refusal. Somebody uploading a track crate already holds should be
           * told so while they can still act on it, and offered the copy instead.
           */
          const lookFor = candidates[0] ?? {
            artist: staged.tags?.artist ?? '',
            title: staged.tags?.title ?? '',
          };
          const pooled =
            lookFor.artist && lookFor.title
              ? deps.userlib.poolMatch(lookFor.artist, lookFor.title)
              : null;
          staged.options = optionsFor(
            staged,
            candidates,
            pooled
              ? {
                  trackId: pooled.trackId,
                  artistName: pooled.artistName,
                  albumTitle: pooled.albumTitle,
                  title: pooled.title,
                  mine: c.id ? deps.userlib.has(c.id, pooled.trackId) : false,
                }
              : null,
          );
        }
        // Tags travel with the candidates: the verdict needs them to tell a compilation rip
        // from two unrelated singles that happen to share a hits album.
        perFile.push({ name: staged.name, candidates, tags: staged.tags });
        files.push(staged);
      } catch (err) {
        rejected.push({
          name: part.filename,
          why: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!files.some((f) => f.kind === 'audio')) {
      await uploads.discard(dir);
      return reply.code(400).send({ error: 'no audio files made it through', rejected });
    }
    // What the batch is as a whole — one album, one compilation, or unrelated songs. Only
    // answerable once every file has been seen, which is why it is computed here.
    return { batchId, files, rejected, verdict: verdictFor(perFile) };
  });

  /**
   * Allocate files to a tracklist: rules first, AI only for the doubtful.
   *
   * The rules engine handles the bulk deterministically — see trackmatch.ts,
   * which took the Starboy-shaped fixture from 1/6 to 6/6 on its own. When an
   * OpenAI key is configured, files the rules scored below 0.6 go to the
   * model for a second opinion, with the whole tracklist for context and the
   * already-confident positions marked taken. The model advises; anything it
   * says about positions that clash with a confident assignment is ignored.
   */
  app.post('/api/upload/match', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const b = (req.body ?? {}) as { files?: MatchFile[]; tracks?: MatchTrack[] };
    const files = (b.files ?? []).slice(0, 100);
    const tracks = (b.tracks ?? []).slice(0, 100);
    if (!files.length || !tracks.length) {
      return reply.code(400).send({ error: 'files[] and tracks[] are required' });
    }

    const assignments = matchTracks(files, tracks);
    let via: 'rules' | 'rules+ai' = 'rules';

    const doubtful = assignments.filter((a) => a.confidence < 0.6);
    if (doubtful.length && openai.enabled()) {
      const confident = new Set(
        assignments.filter((a) => a.confidence >= 0.6 && a.position !== null).map((a) => a.position!),
      );
      const byName = new Map(files.map((f) => [f.name, f]));
      const verdicts = await openai.arbitrateTracks(
        doubtful.map((a) => byName.get(a.name)!).filter(Boolean),
        tracks,
        confident,
      );
      if (verdicts.size) {
        via = 'rules+ai';
        const used = new Set(confident);
        for (const a of assignments) {
          if (a.confidence >= 0.6) continue;
          const v = verdicts.get(a.name);
          if (v === undefined) continue;
          if (v !== null && used.has(v)) continue;
          a.position = v;
          a.confidence = 0.7;
          if (v !== null) used.add(v);
        }
      }
    }
    return { assignments, via };
  });

  app.post('/api/upload/finalize', async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (!c.id) return reply.code(400).send({ error: 'a token caller has no library' });

    const b = (req.body ?? {}) as {
      batchId?: string;
      artistName?: string;
      albumTitle?: string;
      mbid?: string;
      cover?: string;
      files?: { name?: string; title?: string; trackNo?: number }[];
    };
    const dir = uploads.batchDir(c.id, String(b.batchId ?? ''));
    if (!dir) return reply.code(400).send({ error: 'no such upload batch' });

    const artistName = String(b.artistName ?? '').trim();
    const albumTitle = String(b.albumTitle ?? '').trim();
    if (!artistName || !albumTitle) {
      return reply.code(400).send({ error: 'artist and album are required' });
    }
    const mbid = /^[0-9a-f-]{36}$/i.test(String(b.mbid ?? '')) ? String(b.mbid) : null;
    /*
     * Dedupe BEFORE anything moves, against two sources of doubles.
     *
     * The album may already be in the pool under different filenames — imports
     * keep release-style names, this flow writes "NN. Title" — so a merge by
     * filename collides with nothing and the same song lands twice. Starboy
     * arrived exactly that way: an imported copy plus an adopted copy, every
     * track doubled under two names. Identity here is the confirmed TITLE,
     * compared normalised against the destination album's indexed tracks.
     *
     * And the batch itself can carry doubles — a folder holding two rips of
     * one album assigns two files to the same track; the first keeps it.
     *
     * Skipped files simply stay in the batch, which already does the right
     * thing for both kinds: finalize's cleanup restores an adopted batch's
     * leftovers to their origin and deletes an upload's, because the upload
     * is a copy.
     */
    const pool = deps.userlib.poolForAlbum(artistName, albumTitle);
    const existing = new Map(pool.map((t) => [norm(t.title), t.trackId]));
    const seenTitles = new Set<string>();
    const skipped: { name: string; why: string }[] = [];
    /*
     * Tracks the batch duplicated that this person does NOT yet own.
     *
     * Refusing the upload used to be the whole answer, which got the accounting right and
     * the INTENT wrong: uploading This Love means "I want this song", and the album already
     * held a copy that was simply not in this user's library. So the upload was rejected and
     * they ended up with nothing, having asked for something crate could give away for free.
     *
     * Adopting the existing copy instead is the same rule the pool exists for — a second
     * person wanting a track already on disk gets it with no download — applied to the same
     * person arriving by a different door.
     */
    const adoptable: number[] = [];
    const files = (b.files ?? [])
      .map((f, i) => ({
        name: String(f.name ?? ''),
        title: String(f.title ?? '').trim(),
        trackNo: Number.isFinite(Number(f.trackNo)) && Number(f.trackNo) > 0 ? Number(f.trackNo) : i + 1,
      }))
      .filter((f) => f.name && f.title)
      .filter((f) => {
        const key = norm(f.title);
        const already = existing.get(key);
        if (already !== undefined) {
          if (!deps.userlib.has(c.id as number, already)) adoptable.push(already);
          skipped.push({
            name: f.name,
            why: deps.userlib.has(c.id as number, already)
              ? `“${f.title}” is already in this album and in your library`
              : `“${f.title}” was already on disk — added to your library instead of uploading it`,
          });
          return false;
        }
        if (seenTitles.has(key)) {
          skipped.push({ name: f.name, why: `duplicate of another file in this batch (${f.title})` });
          return false;
        }
        seenTitles.add(key);
        return true;
      });
    if (!files.length) {
      // Nothing to move, but there may still be something to GIVE — see the note above.
      for (const id of adoptable) userlib.add(c.id!, id, 'add');
      if (adoptable.length) {
        recommender.invalidateAll();
        await uploads.discard(dir);
        app.log.warn(
          { user: c.user, album: `${artistName} — ${albumTitle}`, adopted: adoptable.length },
          'upload matched files already on disk; existing copies added to the library',
        );
        return { ok: true, albumDir: null, tracks: adoptable.length, adopted: adoptable.length, skipped };
      }
      return reply.code(400).send({
        error: 'every assigned song is already in this album, and already in your library',
        skipped,
      });
    }

    const { albumDir, moved } = await uploads.finalize({
      dir,
      artistName,
      albumTitle,
      files,
      cover: b.cover ? String(b.cover) : undefined,
    });

    /*
     * Index ONLY the moved files — never the whole folder. Indexing the folder
     * re-reads existing files' embedded tags and clobbers metadata somebody
     * already confirmed, which is how merging a second Starboy scrambled the
     * first. The confirmed identity then overwrites the new rows; the scanner
     * skips unchanged files by size+mtime, so it all holds across rescans.
     */
    const indexed = await library.indexFiles(moved.map((m) => m.path));
    for (const m of moved) {
      library.overrideTrack(m.path, {
        artistName,
        albumTitle,
        title: m.title,
        trackNo: m.trackNo,
        albumMbid: mbid,
      });
    }
    library.record({
      mbid: mbid ?? '',
      artistName,
      albumTitle,
      path: albumDir,
      // The album's real size after the merge — the overrides above have
      // landed, so the pool already includes this batch's files.
      trackFiles: deps.userlib.poolForAlbum(artistName, albumTitle).length,
    });
    for (const t of indexed) userlib.add(c.id!, t.id, 'add');
    // Same for a partial batch: the files that were skipped as duplicates still represent
    // songs this person asked for and does not have.
    for (const id of adoptable) userlib.add(c.id!, id, 'add');
    recommender.invalidateAll();

    app.log.warn(
      { user: c.user, album: `${artistName} — ${albumTitle}`, files: moved.length, mbid },
      'album uploaded',
    );
    notifier.emit('library.uploaded', {
      title: 'crate received an upload',
      message: `${c.user} uploaded ${artistName} — ${albumTitle} (${moved.length} tracks)`,
      data: { user: c.user, artist: artistName, album: albumTitle, files: moved.length },
    });
    return {
      ok: true,
      albumDir,
      tracks: indexed.length + adoptable.length,
      adopted: adoptable.length,
      skipped,
    };
  });

  /** Walking away from a half-done upload should cost nothing. */
  app.delete('/api/upload/:batchId', async (req, reply) => {
    const c = need(req, reply);
    if (!c || !c.id) return;
    const dir = uploads.batchDir(c.id, String((req.params as { batchId: string }).batchId));
    if (!dir) return reply.code(400).send({ error: 'no such upload batch' });
    await uploads.discard(dir);
    return { ok: true };
  });
}
