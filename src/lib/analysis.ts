import { spawn } from 'node:child_process';

/**
 * Audio analysis: an energy rating per track, computed locally with ffmpeg.
 *
 * WHAT DID NOT WORK, because the failure is the interesting part:
 *
 *  - LOUDNESS is not energy. Measured across real files, RMS tracks the MASTERING ERA and
 *    almost nothing else: Metallica's thrash came out the quietest thing tested (-15.6 dB,
 *    1991 master) while a laid-back Post Malone track was the loudest (-6.4 dB, 2019). An
 *    energy score built on loudness would rank the loudness war, not the music.
 *  - ESTIMATED BPM is not trustworthy here. Autocorrelation over a decoded window reported
 *    171 for an 85 BPM Eminem track (double time) and 157 for a 140 BPM one — it got even
 *    the ORDERING wrong, so no amount of half/double folding rescues it. crate therefore
 *    records BPM only when the FILE says so (a TBPM tag the producer wrote), and leaves it
 *    unknown otherwise rather than publishing a confident wrong number.
 *
 * WHAT DOES WORK is a blend of two mastering-independent signals:
 *
 *  - ONSET RATE: how often the frame energy jumps. Rhythmic density — a ballad sits near
 *    2/s, a thrash or dance track near 3–4/s.
 *  - BRIGHTNESS (zero-crossing rate): cymbals and overdriven guitar are busy up high; a
 *    fingerpicked acoustic is not.
 *
 * Measured ordering on real material: Johnny Cash ballad 0.12, soft folk 0.16, midtempo
 * rap 0.36, 90s rock 0.53, thrash 0.60, eurodance 0.60, a dance remix 0.69.
 */

/** Middle window, mono, downsampled — plenty for these features, cheap to decode. */
const WINDOW_S = 45;
const SAMPLE_RATE = 22050;
/** ~46ms frames: short enough to see individual hits, long enough to be stable. */
const FRAME = 1024;

export interface Analysis {
  /** From the file's own tag, or null — never an estimate. See the note above. */
  bpm: number | null;
  /** 0..1: 0 a whispered ballad, 1 a wall of fast noise. */
  energy: number;
}

export class Analyzer {
  constructor(private ffmpeg = 'ffmpeg') {}

  /**
   * Analyse one file. `durationS` positions the window; `tagBpm` is the file's own TBPM.
   * Throws on undecodable files — the caller records the failure so it is not retried.
   */
  async analyze(path: string, durationS: number | null, tagBpm: number | null): Promise<Analysis> {
    // The middle of the song, never the start: intros are quiet and sparse, and judging a
    // rock track by its first 45 seconds reported it as a ballad. An unknown duration
    // assumes a typical three-minute song rather than falling back to zero.
    const start = Math.max(0, ((durationS ?? 180) - WINDOW_S) / 2);
    const pcm = await this.decode(path, start);
    if (pcm.length < SAMPLE_RATE * 5) {
      throw new Error('decoded under five seconds of audio');
    }

    const { onsets, brightness } = features(pcm);
    // 60% rhythmic density, 40% brightness. The normalisation ranges come from the spread
    // measured over the material listed in the header.
    const energy = clamp01(0.6 * clamp01((onsets - 1.8) / 2.4) + 0.4 * clamp01((brightness - 800) / 3200));

    return {
      bpm: tagBpm && tagBpm >= 40 && tagBpm <= 250 ? Math.round(tagBpm * 10) / 10 : null,
      energy: Math.round(energy * 100) / 100,
    };
  }

  /** ffmpeg → raw float PCM. stderr is discarded: ffmpeg narrates constantly. */
  private decode(path: string, startS: number): Promise<Float32Array> {
    return new Promise((resolve, reject) => {
      const args = [
        '-hide_banner', '-loglevel', 'error',
        '-ss', String(startS),
        '-t', String(WINDOW_S),
        '-i', path,
        '-ac', '1',
        '-ar', String(SAMPLE_RATE),
        '-f', 'f32le',
        '-',
      ];
      const proc = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks: Buffer[] = [];
      proc.stdout.on('data', (c: Buffer) => chunks.push(c));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) return reject(new Error(`ffmpeg exited ${code}`));
        const buf = Buffer.concat(chunks);
        resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
      });
    });
  }
}

/** Onsets per second and zero-crossings per second. Both mastering-independent. */
function features(pcm: Float32Array): { onsets: number; brightness: number } {
  const frames: number[] = [];
  for (let i = 0; i + FRAME < pcm.length; i += FRAME) {
    let sum = 0;
    for (let j = 0; j < FRAME; j++) sum += pcm[i + j]! * pcm[i + j]!;
    frames.push(Math.sqrt(sum / FRAME));
  }
  const mean = frames.reduce((a, b) => a + b, 0) / Math.max(1, frames.length);

  // An onset is a frame markedly louder than the one before it, above a floor that keeps
  // room tone and fade-ins from counting.
  let rises = 0;
  for (let i = 1; i < frames.length; i++) {
    if (frames[i]! > frames[i - 1]! * 1.35 && frames[i]! > mean * 0.6) rises++;
  }
  const seconds = (frames.length * FRAME) / SAMPLE_RATE;
  const onsets = rises / Math.max(1, seconds);

  let crossings = 0;
  for (let i = 1; i < pcm.length; i++) {
    if (pcm[i - 1]! < 0 !== pcm[i]! < 0) crossings++;
  }
  const brightness = crossings / (pcm.length / SAMPLE_RATE);

  return { onsets, brightness };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
