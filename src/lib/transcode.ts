/**
 * On-the-fly transcoding for the Subsonic stream endpoint.
 *
 * Clients ask for a format and a ceiling — `format=mp3&maxBitRate=128` — because they
 * know things the server cannot: that they are on mobile data, that they cannot decode
 * FLAC, that the car head unit only speaks MP3. Sending the original regardless is what
 * makes a 900 kbps FLAC unplayable over a phone connection.
 *
 * WHAT IS DELIBERATELY NOT HERE. No cache of transcoded output, and nothing transcoded
 * before it is asked for. Both are tempting and both trade disk and complexity for a
 * problem this does not have: ffmpeg stays well ahead of real-time playback on modest
 * hardware, so the only cost of transcoding on demand is CPU while somebody is actually
 * listening. A cache would need invalidating, sweeping and sizing, and would earn its
 * keep only if the same track were re-encoded often — which is not how people listen.
 *
 * The decision is separated from the spawning so it can be tested without a subprocess:
 * plan() is pure, and spawnTranscode() does as it is told.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { extname } from 'node:path';

/** A format crate can transcode TO, and how to ask ffmpeg for it. */
interface Target {
  /** ffmpeg muxer (-f). */
  container: string;
  /** ffmpeg encoder (-c:a). */
  codec: string;
  mime: string;
  /** Lossless targets ignore maxBitRate — there is no such knob on them. */
  lossless?: boolean;
  /** Extra encoder arguments. */
  extra?: string[];
}

/**
 * The formats on offer, each paired with the encoder that produces it.
 *
 * Every encoder named here has to exist in the runtime image. A missing one fails at
 * spawn time, mid-stream, with a message the listener never sees — so this table and
 * the image's ffmpeg build are a matched pair, not an aspiration.
 */
export const TARGETS: Record<string, Target> = {
  mp3: { container: 'mp3', codec: 'libmp3lame', mime: 'audio/mpeg' },
  // ADTS rather than an MP4 container: MP4 needs a seekable output to write its index,
  // and a pipe is not seekable — the stream would fail right at the end, after the
  // listener had already heard the whole track.
  aac: { container: 'adts', codec: 'aac', mime: 'audio/aac' },
  opus: { container: 'ogg', codec: 'libopus', mime: 'audio/ogg' },
  ogg: { container: 'ogg', codec: 'libvorbis', mime: 'audio/ogg' },
  vorbis: { container: 'ogg', codec: 'libvorbis', mime: 'audio/ogg' },
  flac: { container: 'flac', codec: 'flac', mime: 'audio/flac', lossless: true },
  wav: { container: 'wav', codec: 'pcm_s16le', mime: 'audio/wav', lossless: true },
};

/** What the file on disk already is, judged by extension. */
const SOURCE_FORMAT: Record<string, string> = {
  '.mp3': 'mp3',
  '.m4a': 'aac',
  '.aac': 'aac',
  '.opus': 'opus',
  '.ogg': 'ogg',
  '.flac': 'flac',
  '.wav': 'wav',
  '.alac': 'alac',
  '.ape': 'ape',
};

export interface Plan {
  /** False means send the bytes on disk, untouched. */
  transcode: boolean;
  /** Content-Type to advertise. */
  mime: string;
  /** Target format name, for Subsonic's `transcodedSuffix` and for logging. */
  format: string;
  /** kbps actually being encoded at, or null for passthrough and lossless. */
  bitRate: number | null;
  /** Why, in one phrase. Logged, and returned in a header for debugging. */
  reason: string;
}

/** Source bitrate in kbps, estimated from size and duration. */
export function estimateBitrate(sizeBytes: number, durationS: number | null): number | null {
  if (!durationS || durationS <= 0 || !sizeBytes) return null;
  return Math.round((sizeBytes * 8) / durationS / 1000);
}

/**
 * Decide whether to transcode, and into what.
 *
 * The rule that matters: doing nothing is the default. A client that asks for nothing,
 * or asks for what the file already is, gets the original bytes — which keeps Range
 * requests, seeking and byte-exact delivery working for every client that was perfectly
 * happy before any of this existed. Transcoding is a fallback for clients that need it,
 * not a stage every stream now passes through.
 */
export function plan(opts: {
  path: string;
  sizeBytes: number;
  durationS: number | null;
  /** The client's `format` parameter; 'raw' disables transcoding outright. */
  format?: string | undefined;
  /** The client's `maxBitRate` in kbps; 0 or absent means no ceiling. */
  maxBitRate?: number | undefined;
  /** Content-Type for the file as it sits on disk. */
  sourceMime: string;
}): Plan {
  const ext = extname(opts.path).toLowerCase();
  const sourceFormat = SOURCE_FORMAT[ext] ?? ext.replace('.', '');
  const passthrough = (reason: string): Plan => ({
    transcode: false,
    mime: opts.sourceMime,
    format: sourceFormat,
    bitRate: null,
    reason,
  });

  const requested = (opts.format ?? '').trim().toLowerCase();
  const ceiling =
    Number.isFinite(opts.maxBitRate) && (opts.maxBitRate ?? 0) > 0
      ? Math.floor(opts.maxBitRate as number)
      : 0;

  // 'raw' is the client saying "do not touch this", and it wins over everything,
  // including a maxBitRate sent in the same request.
  if (requested === 'raw') return passthrough('client asked for raw');
  if (!requested && !ceiling) return passthrough('nothing requested');

  const targetName = requested || sourceFormat;
  const target = TARGETS[targetName];
  if (!target) {
    // An unknown format is not an error. Subsonic has no code for "cannot do that
    // format", and a client asking for something exotic is better served the original
    // than a failure it has no way to interpret.
    return passthrough(`unsupported format '${targetName}'`);
  }

  const sourceRate = estimateBitrate(opts.sizeBytes, opts.durationS);
  const sameFormat = targetName === sourceFormat;

  if (target.lossless) {
    // Lossless to the same lossless format would only rewrite the container, and a
    // bitrate ceiling has no meaning for a lossless encoder in any case.
    if (sameFormat) return passthrough('already that lossless format');
    return {
      transcode: true,
      mime: target.mime,
      format: targetName,
      bitRate: null,
      reason: `container change to ${targetName}`,
    };
  }

  if (sameFormat && ceiling && sourceRate !== null && sourceRate <= ceiling) {
    // Already under the ceiling. Re-encoding here would lose quality and gain nothing.
    return passthrough(`source ${sourceRate}kbps already within ${ceiling}kbps`);
  }
  if (sameFormat && !ceiling) return passthrough('already that format, no ceiling');

  // 320 is the default when a format is asked for with no ceiling: high enough to be
  // transparent for these lossy targets, and bounded so a missing parameter cannot turn
  // into a request for something absurd.
  const bitRate = ceiling || Math.min(320, sourceRate ?? 320);
  return {
    transcode: true,
    mime: target.mime,
    format: targetName,
    bitRate,
    reason: sameFormat
      ? `downsample ${sourceRate ?? '?'}kbps to ${bitRate}kbps`
      : `${sourceFormat} to ${targetName} at ${bitRate}kbps`,
  };
}

/**
 * Which ffmpeg to run.
 *
 * `CRATE_FFMPEG` overrides the one on PATH — useful for pinning a particular build, and
 * what lets the streaming path be exercised against a stub with no real encoder present.
 */
export const FFMPEG = process.env.CRATE_FFMPEG || 'ffmpeg';

/**
 * Start ffmpeg, writing the encoded stream to stdout.
 *
 * `-ss` goes before `-i` so the seek is done by demuxing to that point rather than by
 * decoding everything before it and throwing it away — the difference between instant
 * and several seconds on a long file.
 *
 * stderr is discarded. ffmpeg narrates continuously at info level, and the only thing
 * worth knowing from here is the exit code.
 */
export function spawnTranscode(
  path: string,
  p: Plan,
  opts: { timeOffsetS?: number; ffmpeg?: string } = {},
): ChildProcessByStdio<null, Readable, null> {
  const target = TARGETS[p.format];
  if (!target) throw new Error(`no transcode target for '${p.format}'`);

  const args = ['-hide_banner', '-loglevel', 'error'];
  if (opts.timeOffsetS && opts.timeOffsetS > 0) args.push('-ss', String(opts.timeOffsetS));
  args.push('-i', path);
  // Take the first audio stream and drop everything else. Without -vn, embedded cover
  // art is treated as a video stream and the encode fails on containers that will not
  // carry one.
  args.push('-map', '0:a:0', '-vn');
  args.push('-c:a', target.codec);
  if (p.bitRate) args.push('-b:a', `${p.bitRate}k`);
  if (target.extra) args.push(...target.extra);
  args.push('-f', target.container, '-');

  // stdio is ['ignore','pipe','ignore'], so stdin and stderr are typed null. Only stdout
  // is ever touched, and the narrower type says exactly that.
  return spawn(opts.ffmpeg ?? FFMPEG, args, { stdio: ['ignore', 'pipe', 'ignore'] });
}
